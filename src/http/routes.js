// http/routes.js — what the local front end answers, one function per route.
//
// Previously a single 100-line handler with the CORS decision, the token check,
// static serving and the RPC dispatch interleaved inside it; the routes are
// independent of each other and read better that way.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { WEB_DIR, clientBundlePath } = require('../lib/layout.js')
const { MIME, sendJson, sendText, sendFile, notFound, readBody } = require('./respond.js')

const BODY_LIMIT = 4 * 1024 * 1024
const CLIENT_BUNDLE = 'client.bundle.js'

const PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'x-llama-token, authorization, content-type, cache-control',
}

/**
 * The RPC channels the browser half calls. Everything else it needs goes
 * through `llama.call`, which is the manager's own command router.
 */
const CHANNELS = {
  'llama.state': function (manager) { return manager.cmd('status', {}) },
  'llama.ping': function () { return { ok: true, pong: true } },
  'llama.call': function (manager, args) {
    return manager.cmd(String(args.method || 'ping'), args.args || {})
  },
}

/**
 * deps: { manager, token, version, indexTemplate, originPolicy, log }
 * Returns an http request listener.
 */
function createRouter(deps) {
  const { manager, token, indexTemplate, originPolicy } = deps
  const version = deps.version || 'dev'
  const log = deps.log || function () {}

  function serveIndex(req, res) {
    const page = indexTemplate
      .replace('__LLAMA_TOKEN__', token)
      .replace('__LLAMA_VERSION__', version)
    sendText(res, 200, page, MIME['.html'])
  }

  function serveAsset(req, res, url) {
    const rel = url.pathname.slice('/assets/'.length)

    // The UI itself is the plugin's own client bundle, which lives outside
    // web/ — served by name rather than by path so the fence below still
    // covers everything a URL can reach.
    if (rel === CLIENT_BUNDLE) {
      const bundle = clientBundlePath()
      if (!fs.existsSync(bundle)) {
        sendText(res, 500, 'client bundle missing — run: node build.js')
        return
      }
      sendFile(res, bundle, MIME['.js'])
      return
    }

    const file = path.join(WEB_DIR, rel)
    if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file)) {
      notFound(res)
      return
    }
    sendFile(res, file)
  }

  async function serveRpc(req, res, url, originAllowed) {
    if (req.headers['x-llama-token'] !== token || !originAllowed) {
      sendJson(res, 403, {
        ok: false,
        code: 'FORBIDDEN',
        message: originAllowed
          ? 'Invalid session token.'
          : 'Origin not allowed for remote access. Add your domain to Server Settings > Allowed Remote Access Sites.',
      })
      return
    }

    let payload
    try {
      payload = JSON.parse(await readBody(req, BODY_LIMIT))
    } catch (_e) {
      sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: 'Body was not JSON.' })
      return
    }

    const channel = String(payload.channel || '')
    const handler = CHANNELS[channel]
    if (handler === undefined) {
      sendJson(res, 200, { ok: false, code: 'UNKNOWN_CHANNEL', message: 'Unknown channel ' + channel })
      return
    }
    const args = payload.payload && typeof payload.payload === 'object' ? payload.payload : {}
    sendJson(res, 200, await handler(manager, args))
  }

  function serveHealth(req, res) {
    sendJson(res, 200, { ok: true, app: 'llama.cpp Studio', version })
  }

  // Matched in order; `prefix` routes claim everything beneath them.
  const ROUTES = [
    { method: 'GET', paths: ['/', '/index.html'], handler: serveIndex },
    { method: 'GET', prefix: '/assets/', handler: serveAsset },
    { method: 'POST', paths: ['/api/rpc'], handler: serveRpc },
    { method: 'GET', paths: ['/api/health'], handler: serveHealth },
  ]

  function match(method, pathname) {
    return ROUTES.find(function (route) {
      if (route.method !== method) return false
      if (route.prefix !== undefined) return pathname.startsWith(route.prefix)
      return route.paths.indexOf(pathname) !== -1
    })
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://' + deps.host)
    const origin = req.headers.origin
    const originAllowed = originPolicy.isAllowed(req)

    if (origin && originAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    }

    if (req.method === 'OPTIONS') {
      for (const [name, value] of Object.entries(PREFLIGHT_HEADERS)) res.setHeader(name, value)
      res.writeHead(204)
      res.end()
      return
    }

    try {
      const route = match(req.method, url.pathname)
      if (route === undefined) {
        notFound(res)
        return
      }
      await route.handler(req, res, url, originAllowed)
    } catch (err) {
      log('request failed: ' + String(err && err.message))
      sendJson(res, 500, { ok: false, code: 'INTERNAL', message: String(err && err.message) })
    }
  }
}

module.exports = { createRouter, CHANNELS }
