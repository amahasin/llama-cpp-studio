// http/gate.js — the API key as the front door to Studio itself.
//
// Studio used to hand a session to anyone who could open its port: `GET /`
// answered unauthenticated and set the cookie every other route checks. On a
// loopback bind that is fine — the operating system is the boundary — but the
// moment the app is published through a tunnel or a reverse proxy, the URL is
// the only secret, and the API key protecting llama-server does nothing for
// the browser half.
//
// So the key that serves the models also opens the UI. Nothing new to
// remember, nothing new to configure: set an API key and the front door locks
// for everyone who is not sitting at the machine.
//
// # What counts as "sitting at the machine"
//
// Both halves have to agree, because either one alone is wrong:
//
//   • the socket must come from loopback — otherwise anyone on the LAN could
//     send `Host: localhost` and walk straight in;
//   • the Host must be a loopback name — otherwise a tunnel running on this
//     same machine (cloudflared and friends usually do) looks local, which is
//     exactly the case the lock exists for.
//
// A forwarding header settles it on its own: nothing adds one except a proxy.
'use strict'

const crypto = require('node:crypto')

const { sendJson, readBody } = require('./respond.js')

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

// Set by a proxy, never by a browser talking to us directly.
const FORWARDED_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']

const LOGIN_PATH = '/api/login'
const BODY_LIMIT = 8 * 1024

/** The hostname the request was addressed to, brackets and port removed. */
function hostnameOf(req) {
  const header = req.headers.host
  if (typeof header !== 'string' || header === '') return undefined
  let name
  try {
    name = new URL('http://' + header).hostname
  } catch (_e) {
    return undefined
  }
  return name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name
}

/**
 * Whether this request came from the machine the app runs on.
 *
 * Fails closed: an address we cannot read is treated as remote, because the
 * cost of being wrong runs one way.
 */
function isLocalRequest(req) {
  if (FORWARDED_HEADERS.some(function (h) { return req.headers[h] !== undefined })) return false
  const address = req.socket ? req.socket.remoteAddress : undefined
  if (typeof address !== 'string' || !LOOPBACK_ADDRESSES.has(address)) return false
  const host = hostnameOf(req)
  return host !== undefined && LOOPBACK_HOSTS.has(host)
}

/** Compare without leaking where two strings start to differ. */
function matchesKey(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  // timingSafeEqual throws on a length mismatch, which would leak the length
  // through the exception. Hash both first: same size whatever went in.
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  })
}

/**
 * The unlock page. Everything is inline: it is served before the caller has a
 * session, and the assets are behind the same gate.
 */
function loginPage(options) {
  const o = options || {}
  const error = o.error ? '<p class="err">' + escapeHtml(o.error) + '</p>' : ''
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>llama.cpp Studio</title><style>'
    + ':root{color-scheme:light dark;--bg:#f6f7f9;--fg:#12151a;--mute:#5b6472;'
    + '--line:#d9dee6;--card:#fff;--accent:#2f6df6;--err:#c02626}'
    + '@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--fg:#e6e9ee;--mute:#98a2b3;'
    + '--line:#242a33;--card:#161a20;--err:#ff6b6b}}'
    + '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;'
    + 'justify-content:center;background:var(--bg);color:var(--fg);'
    + 'font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}'
    + 'form{background:var(--card);border:1px solid var(--line);border-radius:12px;'
    + 'padding:28px;width:100%;max-width:380px}'
    + 'h1{margin:0 0 4px;font-size:16px;font-weight:650}'
    + 'p.sub{margin:0 0 20px;color:var(--mute);font-size:12.5px}'
    + 'label{display:block;font-size:12px;font-weight:600;margin-bottom:6px}'
    + 'input{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:7px;'
    + 'background:var(--bg);color:var(--fg);font:inherit;font-family:ui-monospace,monospace}'
    + 'input:focus{outline:2px solid var(--accent);outline-offset:-1px}'
    + 'button{margin-top:14px;width:100%;padding:9px;border:0;border-radius:7px;'
    + 'background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}'
    + 'p.err{margin:0 0 14px;color:var(--err);font-size:12.5px}'
    + 'p.hint{margin:16px 0 0;color:var(--mute);font-size:11.5px}'
    + '</style></head><body><form method="POST" action="' + LOGIN_PATH + '">'
    + '<h1>llama.cpp Studio</h1>'
    + '<p class="sub">This Studio is reachable from outside this machine, so it asks for'
    + ' the API key before letting you in.</p>'
    + error
    + '<label for="key">API key</label>'
    + '<input id="key" name="key" type="password" autocomplete="current-password"'
    + ' autofocus spellcheck="false">'
    + '<button type="submit">Unlock</button>'
    + '<p class="hint">The same key set in Server Config &rsaquo; Access &amp; Remote Access.'
    + ' Opened at 127.0.0.1 on the machine itself, Studio does not ask.</p>'
    + '</form></body></html>'
}

const LOGIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self';"
  + " base-uri 'none'; frame-ancestors 'none'"

/**
 * deps: { manager, token, sessionCookie, log }
 *  - sessionCookie(token, req) builds the Set-Cookie value, so the gate and the
 *    shell hand out exactly the same session.
 */
function createGate(deps) {
  const manager = deps.manager
  const log = deps.log || function () {}
  // A 256-bit key is not worth guessing, but a wrong one should still cost
  // something — and a burst of them should be visible in the log.
  let failures = 0

  /** The key that opens the door, or undefined when none is set. */
  function requiredKey() {
    try {
      const cfg = manager && manager.config ? manager.config.get('server') : undefined
      const key = cfg && cfg.apiKey
      return typeof key === 'string' && key !== '' ? key : undefined
    } catch (_e) {
      return undefined
    }
  }

  /**
   * Whether this request has to be turned away with the unlock page.
   *
   * `authorized` is the session check the rest of the app already uses: a
   * caller who has been through here once carries the cookie and is let by.
   */
  function locked(req, authorized) {
    if (requiredKey() === undefined) return false
    if (authorized) return false
    return !isLocalRequest(req)
  }

  function sendLoginPage(res, status, error) {
    const body = loginPage({ error })
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': LOGIN_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  /** What an unauthenticated caller gets: a page to a browser, JSON to code. */
  function refuse(req, res) {
    const accept = String(req.headers.accept || '')
    if (req.method === 'GET' && accept.indexOf('text/html') !== -1) {
      sendLoginPage(res, 401, undefined)
      return
    }
    sendJson(res, 401, {
      ok: false,
      code: 'LOCKED',
      message: 'This Studio requires its API key. Open it in a browser to unlock,'
        + ' or send the key as a bearer token.',
    })
  }

  /** POST /api/login — trade the key for the session every other route wants. */
  async function submit(req, res) {
    const expected = requiredKey()
    if (expected === undefined) {
      // Nothing to check against: sending people to a lock with no key would
      // strand them.
      res.writeHead(302, { Location: '/' })
      res.end()
      return
    }

    let given
    try {
      const raw = await readBody(req, BODY_LIMIT)
      const type = String(req.headers['content-type'] || '')
      if (type.indexOf('application/json') !== -1) {
        const parsed = JSON.parse(raw)
        given = parsed && typeof parsed.key === 'string' ? parsed.key : undefined
      } else {
        given = new URLSearchParams(raw).get('key') || undefined
      }
    } catch (_e) {
      given = undefined
    }

    if (!matchesKey(given, expected)) {
      failures += 1
      log('a sign-in to Studio was refused (' + failures + ' so far this run)')
      // Enough to make a guessing loop pointless, not enough to be felt by
      // someone who mistyped.
      await new Promise(function (resolve) { setTimeout(resolve, 400) })
      sendLoginPage(res, 401, 'That key does not match. Check Server Config › Access.')
      return
    }

    failures = 0
    log('a remote browser signed in to Studio with the API key')
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': deps.sessionCookie(deps.token, req),
      'Cache-Control': 'no-store',
    })
    res.end()
  }

  /** A caller may also present the key directly, which is what a script does. */
  function bearerMatches(req) {
    const expected = requiredKey()
    if (expected === undefined) return false
    const header = String(req.headers.authorization || '')
    if (!header.startsWith('Bearer ')) return false
    return matchesKey(header.slice(7).trim(), expected)
  }

  return { locked, refuse, submit, bearerMatches, LOGIN_PATH }
}

module.exports = {
  createGate,
  isLocalRequest,
  hostnameOf,
  matchesKey,
  loginPage,
  LOGIN_PATH,
  LOOPBACK_ADDRESSES,
  LOOPBACK_HOSTS,
}
