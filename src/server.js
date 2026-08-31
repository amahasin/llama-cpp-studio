// server.js — the local HTTP front end: static UI assets plus one RPC route
// that forwards to the manager's command router.
//
// It binds 127.0.0.1 and requires a per-run token (embedded in the page it
// serves) on every RPC call, so another page in your browser cannot drive the
// app behind your back. The routes themselves live in ./http/routes.js and the
// remote-access allow-list in ./http/origin.js; this file only assembles them
// and owns the socket.
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const { WEB_DIR } = require('./lib/layout.js')
const { createOriginPolicy } = require('./http/origin.js')
const { createRouter } = require('./http/routes.js')

const TOKEN_BYTES = 24

// Addresses that keep the server on this machine only.
const LOOPBACK = ['127.0.0.1', 'localhost', '::1']

/** The remote-access allow-list, read from config on every request. */
function allowedOriginsOf(manager) {
  return function () {
    try {
      if (manager && manager.config) {
        const server = manager.config.get('server')
        return (server && server.allowedOrigins) || ''
      }
    } catch (_e) { /* settings unreadable: no remote origin is allowed */ }
    return ''
  }
}

/**
 * options: { manager, host, port, log, version }
 * Returns { server, port, token, url, close() }.
 */
async function startServer(options) {
  const opts = options || {}
  const manager = opts.manager
  const host = opts.host || '127.0.0.1'
  const log = opts.log || function () {}
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex')

  const server = http.createServer(createRouter({
    manager, token, host, log,
    version: opts.version,
    indexTemplate: fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8'),
    originPolicy: createOriginPolicy({
      host, allowedOrigins: allowedOriginsOf(manager), warn: log,
    }),
  }))

  // Binding anything but loopback puts the UI — and the token-gated RPC behind
  // it — on the network. That can be exactly what was wanted; it should still
  // never be a surprise.
  if (!LOOPBACK.includes(host)) {
    log('WARNING: listening on ' + host + ', not just this machine. The UI is reachable'
      + ' from the network by anyone who can read the session token.')
  }

  const port = await new Promise(function (resolve, reject) {
    server.once('error', reject)
    server.listen(opts.port === undefined ? 0 : opts.port, host, function () {
      resolve(server.address().port)
    })
  })

  return {
    server,
    port,
    token,
    url: 'http://' + host + ':' + port + '/',
    close() {
      return new Promise(function (resolve) { server.close(function () { resolve() }) })
    },
  }
}

module.exports = { startServer, WEB_DIR }
