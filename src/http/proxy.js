// http/proxy.js — llama-server, served through this origin.
//
// The Chat tab embeds llama-server's own web UI in an iframe. That iframe used
// to point straight at the address llama-server binds — `http://127.0.0.1:8080`
// by default — which breaks in two ways that were reported together:
//
//   • From any other device (a phone on the LAN, a tunnel, a published site)
//     `127.0.0.1` means *that device's* localhost. The frame loads nothing.
//   • A cross-origin frame is not granted clipboard-write, so the copy buttons
//     in llama.cpp's UI fail silently. Same-origin frames need no permission.
//
// Proxying it under this origin fixes both, and a third thing nobody had
// reported yet: when an API key is set, the embedded UI had no way to send it
// and every request came back 401. The key is added here, server-side.
//
// Two shapes of request arrive:
//   /llama/…    the iframe's document and anything relative to it
//   /props …    llama.cpp's UI calls its API on absolute paths, which resolve
//               against this origin. Anything this app does not claim itself
//               is forwarded, so new llama.cpp endpoints work without a change
//               here.
'use strict'

const http = require('node:http')

const { sendJson } = require('./respond.js')

const PREFIX = '/llama'

// Paths this app owns. Everything else is llama-server's when one is running.
const OWN_PREFIXES = ['/api/', '/assets/']
const OWN_PATHS = ['/', '/index.html', '/favicon.ico']

// Hop-by-hop headers must not be forwarded (RFC 7230 §6.1).
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/** Where to actually connect. A server bound to a wildcard is reached locally. */
function dialHost(host) {
  if (host === '0.0.0.0' || host === '::' || host === undefined || host === '') return '127.0.0.1'
  return host
}

function filterHeaders(headers) {
  const out = {}
  for (const name of Object.keys(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    out[name] = headers[name]
  }
  return out
}

/**
 * deps: { manager, log }
 * Returns { claims(pathname), handle(req, res, url) }.
 */
function createProxy(deps) {
  const manager = deps.manager
  const log = deps.log || function () {}

  /** The live server if there is one, else what the settings would produce. */
  function target() {
    let status
    try {
      status = manager && manager.server ? manager.server.status() : undefined
    } catch (_e) {
      status = undefined
    }
    let cfg
    try {
      cfg = manager && manager.config ? manager.config.get('server') : undefined
    } catch (_e) {
      cfg = undefined
    }
    if (status && status.state === 'RUNNING' && status.port) {
      return { host: dialHost(status.host), port: status.port, running: true }
    }
    if (cfg && cfg.port) {
      return { host: dialHost(cfg.host), port: cfg.port, running: false }
    }
    return undefined
  }

  function apiKey() {
    try {
      const cfg = manager && manager.config ? manager.config.get('server') : undefined
      return cfg && cfg.apiKey ? cfg.apiKey : undefined
    } catch (_e) {
      return undefined
    }
  }

  /** Whether this path should be forwarded rather than served by this app. */
  function claims(pathname) {
    if (pathname === PREFIX || pathname.startsWith(PREFIX + '/')) return true
    if (OWN_PATHS.indexOf(pathname) !== -1) return false
    if (OWN_PREFIXES.some(function (p) { return pathname.startsWith(p) })) return false
    // An unclaimed path is llama-server's, but only while one is there to ask.
    const t = target()
    return t !== undefined && t.running === true
  }

  /** The path as llama-server should see it: this app's prefix removed. */
  function upstreamPath(url) {
    let pathname = url.pathname
    if (pathname === PREFIX) pathname = '/'
    else if (pathname.startsWith(PREFIX + '/')) pathname = pathname.slice(PREFIX.length)
    return pathname + (url.search || '')
  }

  /**
   * Say so when a request is about to change which model is resident.
   *
   * llama.cpp's web UI picks its own model: the one that answered last in the
   * conversation you opened, else the first in the list. Neither is
   * necessarily the one you loaded from the Dashboard, and its selector button
   * shortens the name, so "Qwen3.6-35B-A3B-Q4_K_M" and
   * "Qwen3.6-35B-A3B-UD-Q4_K_M" both read as "Qwen3.6 35B-A3B" there. With
   * "Models loaded at once" set to 1 the difference is an eviction.
   *
   * The Chat tab now opens the frame on the loaded model (see the chat view in
   * runtime/client.bundle.js), so this is the exception rather than the rule —
   * but switching models from the chat is a real feature and nothing here
   * overrules it. It just stops being silent.
   */
  let lastNoted

  function noteModelSwitch(wanted) {
    if (typeof wanted !== 'string' || wanted === '') return

    let loaded = []
    try {
      const live = manager && manager.server && typeof manager.server.routerLoaded === 'function'
        ? manager.server.routerLoaded()
        : undefined
      if (Array.isArray(live)) loaded = live
    } catch (_e) {
      return
    }
    // Nothing resident yet is a first load, not a switch. Once the wanted
    // model is in, the next switch away from it is worth saying again.
    if (loaded.length === 0 || loaded.indexOf(wanted) !== -1) {
      lastNoted = undefined
      return
    }
    // The UI asks about its model on a timer; one line per switch, not per poll.
    if (wanted === lastNoted) return
    lastNoted = wanted

    log('the chat asked for "' + wanted + '" while "' + loaded.join('", "')
      + '" was loaded, so that model is being swapped out. the chat keeps'
      + ' its own model per conversation — the one that answered last — and its'
      + ' selector shortens the name, so two quantizations of one model look alike'
      + ' there. Raise "Models loaded at once" if you want both resident.')
  }

  /** The model a request names, whether in the query or in a JSON body. */
  function modelInBody(body) {
    try {
      const parsed = JSON.parse(body)
      return parsed && typeof parsed.model === 'string' ? parsed.model : undefined
    } catch (_e) {
      return undefined
    }
  }

  function handle(req, res, url) {
    const t = target()
    if (t === undefined) {
      sendJson(res, 503, {
        ok: false, code: 'NO_SERVER',
        message: 'llama-server is not configured yet.',
      })
      return
    }
    if (!t.running) {
      sendJson(res, 503, {
        ok: false, code: 'SERVER_NOT_RUNNING',
        message: 'llama-server is not running. Start it from the Dashboard.',
      })
      return
    }

    const headers = filterHeaders(req.headers)
    // The upstream sees its own address, not ours, and never our session cookie.
    headers.host = t.host + ':' + t.port
    delete headers.cookie
    delete headers.origin
    delete headers.referer
    // Added here so the embedded UI does not have to know the key — and cannot
    // be used to read it back out.
    const key = apiKey()
    if (key !== undefined) headers.authorization = 'Bearer ' + key
    // llama.cpp ships its web UI as a single pre-gzipped asset and has no
    // uncompressed copy to fall back on: ask it for `identity` and it answers
    // 415 "gzip is not supported by this browser". Browsers always send this
    // header; the default is for everything else that reaches us without one.
    if (headers['accept-encoding'] === undefined) headers['accept-encoding'] = 'gzip, deflate'

    const upstream = http.request({
      host: t.host,
      port: t.port,
      method: req.method,
      path: upstreamPath(url),
      headers,
    }, function (upRes) {
      const out = filterHeaders(upRes.headers)
      // llama.cpp sends its own frame headers; ours are what apply here, and
      // a denied frame is exactly the bug this proxy exists to fix.
      delete out['x-frame-options']
      delete out['content-security-policy']
      res.writeHead(upRes.statusCode || 502, out)
      // Piped, not buffered: token streaming is server-sent events.
      upRes.pipe(res)
    })

    upstream.on('error', function (err) {
      log('proxy to llama-server failed: ' + String(err && err.message))
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendJson(res, 502, {
        ok: false, code: 'PROXY_FAILED',
        message: 'Could not reach llama-server at ' + t.host + ':' + t.port
          + ' (' + String(err && err.message) + ').',
      })
    })

    // A client that goes away must not leave a request hanging upstream.
    res.on('close', function () { upstream.destroy() })

    // A request that names a model in the query loads it if it is not resident:
    // in router mode `GET /props?model=X` loads X. That is llama.cpp's design
    // and the frame relies on it, so it is forwarded as sent — and noted.
    if (url.searchParams.has('model')) noteModelSwitch(url.searchParams.get('model'))

    // One path is read on the way through rather than piped: an explicit load
    // names its model in the body, and the body is a few bytes.
    if (req.method === 'POST' && /\/models\/load$/.test(url.pathname)) {
      let body = ''
      req.on('data', function (c) {
        if (body.length < 4096) body += c
        upstream.write(c)
      })
      req.on('end', function () {
        noteModelSwitch(modelInBody(body))
        upstream.end()
      })
      return
    }
    req.pipe(upstream)
  }

  return { claims, handle, PREFIX }
}

module.exports = { createProxy, PREFIX, dialHost, HOP_BY_HOP }
