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
const { contentSecurityPolicy } = require('./csp.js')
const { createProxy } = require('./proxy.js')
const { createGate, LOGIN_PATH } = require('./gate.js')

const BODY_LIMIT = 4 * 1024 * 1024
const CLIENT_BUNDLE = 'client.bundle.js'

// The session token, also delivered as a cookie. The RPC route reads it from a
// header, which an <iframe> cannot set — so the proxied llama-server keeps the
// same gate through a cookie the browser attaches on its own. HttpOnly: no
// script needs to read it, and the page already has the token it was served.
const SESSION_COOKIE = 'llama_session'

function cookieValue(req, name) {
  const header = req.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

function sessionCookie(token, req) {
  const attrs = [
    SESSION_COOKIE + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ]
  // Only over TLS — set unconditionally it would be dropped on the plain-http
  // loopback the app normally runs on.
  if (req.headers['x-forwarded-proto'] === 'https') attrs.push('Secure')
  return attrs.join('; ')
}

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
  const proxy = createProxy({ manager, log: deps.log })
  const version = deps.version || 'dev'
  const log = deps.log || function () {}
  // The API key, when one is set, is also what opens Studio to anyone who is
  // not sitting at this machine. See gate.js for what "sitting at" means.
  const gate = createGate({ manager, token, sessionCookie, log })

  function serveIndex(req, res) {
    const page = indexTemplate
      .replace('__LLAMA_TOKEN__', token)
      .replace('__LLAMA_VERSION__', version)
    res.setHeader('Content-Security-Policy', contentSecurityPolicy(manager))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Set-Cookie', sessionCookie(token, req))
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

  /**
   * The session token, or the API key as a bearer.
   *
   * Deliberately not the cookie, which `authorized()` does accept: a cookie
   * rides along on a cross-site request whether the user meant it or not, and
   * a header does not without the CORS preflight this route already gates.
   * Both of these are headers, so both are safe here.
   */
  function rpcAuthorized(req) {
    return req.headers['x-llama-token'] === token || gate.bearerMatches(req)
  }

  async function serveRpc(req, res, url, originAllowed) {
    if (!rpcAuthorized(req) || !originAllowed) {
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
  //
  // `open` marks the two a locked-out caller must still reach: the door itself,
  // and the health probe a tunnel or a watchdog pings without a session.
  const ROUTES = [
    { method: 'GET', paths: ['/', '/index.html'], handler: serveIndex },
    { method: 'GET', prefix: '/assets/', handler: serveAsset },
    { method: 'POST', paths: ['/api/rpc'], handler: serveRpc },
    { method: 'GET', paths: ['/api/health'], handler: serveHealth, open: true },
    { method: 'POST', paths: [LOGIN_PATH], handler: gate.submit, open: true },
  ]

  function match(method, pathname) {
    return ROUTES.find(function (route) {
      if (route.method !== method) return false
      if (route.prefix !== undefined) return pathname.startsWith(route.prefix)
      return route.paths.indexOf(pathname) !== -1
    })
  }

  /**
   * The proxied llama-server is behind the same session gate as the RPC route.
   * The iframe cannot send a header, so the cookie counts here too.
   */
  function authorized(req) {
    if (req.headers['x-llama-token'] === token) return true
    if (cookieValue(req, SESSION_COOKIE) === token) return true
    // A script has no browser to unlock in; the key it already sends to
    // llama-server is accepted here too.
    return gate.bearerMatches(req)
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

      // The front door. Checked before the route runs, so nothing — not the
      // shell that carries the session token, not the assets, not the proxied
      // llama-server — answers a caller who has not been let in.
      if ((route === undefined || route.open !== true) && gate.locked(req, authorized(req))) {
        gate.refuse(req, res)
        return
      }

      if (route !== undefined) {
        await route.handler(req, res, url, originAllowed)
        return
      }
      // Not ours: llama-server's, if one is running and the caller is allowed.
      if (proxy.claims(url.pathname)) {
        if (!authorized(req) || !originAllowed) {
          sendJson(res, 403, {
            ok: false, code: 'FORBIDDEN',
            message: 'This llama-server is reached through the app session.',
          })
          return
        }
        proxy.handle(req, res, url)
        return
      }
      notFound(res)
    } catch (err) {
      log('request failed: ' + String(err && err.message))
      sendJson(res, 500, { ok: false, code: 'INTERNAL', message: String(err && err.message) })
    }
  }
}

module.exports = { createRouter, CHANNELS }
