// tests/gate.test.js — the API key as the front door to Studio itself.
//
// Studio used to hand a session to anyone who could open its port: `GET /`
// answered unauthenticated and set the cookie every other route checks. On a
// loopback bind that is fine. Published through a tunnel it is not, and the
// API key protecting llama-server did nothing for the browser half — the URL
// was the whole secret.
//
// The awkward part is deciding who is "local", because the obvious answer is
// wrong in the one case that matters: a tunnel process usually runs on the
// same machine, so its connections arrive from loopback. Both the socket and
// the Host have to look local, and a forwarding header settles it alone.
'use strict'

const http = require('node:http')

const { startServer } = require('../src/server.js')
const { isLocalRequest, matchesKey, hostnameOf } = require('../src/http/gate.js')
const { createChecker } = require('./helpers.js')

const { check, finish } = createChecker()

const KEY = 'M3xkQ2sB-testing-key-Wv8pLr2NqYtA6ZcJf0hD'

/** A manager with just the surface the gate and the router read. */
function stubManager(options) {
  const o = options || {}
  return {
    config: {
      get(section) {
        if (section !== 'server') return {}
        return { host: '127.0.0.1', port: 1, apiKey: o.apiKey, allowedOrigins: '' }
      },
    },
    server: { status() { return { state: 'STOPPED' } }, routerLoaded() { return [] } },
    async cmd() { return { ok: true } },
  }
}

/**
 * A request with headers we choose — including Host, which fetch() refuses to
 * set and which is half of the decision under test.
 */
function request(base, options) {
  const o = options || {}
  const target = new URL(o.path || '/', base)
  return new Promise(function (resolve, reject) {
    const req = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: o.method || 'GET',
      headers: o.headers || {},
    }, function (res) {
      let body = ''
      res.on('data', function (c) { body += c })
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, body })
      })
    })
    req.on('error', reject)
    if (o.body !== undefined) req.write(o.body)
    req.end()
  })
}

/** A fake request object, for the cases a real socket cannot produce. */
function fakeReq(address, host, extra) {
  return {
    socket: { remoteAddress: address },
    headers: Object.assign(host === undefined ? {} : { host }, extra || {}),
  }
}

function unitSection() {
  check('a loopback socket addressed to localhost is local',
    isLocalRequest(fakeReq('127.0.0.1', 'localhost:8770')) === true)
  check('  as is 127.0.0.1, and IPv6 loopback',
    isLocalRequest(fakeReq('::1', '[::1]:8770')) === true
    && isLocalRequest(fakeReq('::ffff:127.0.0.1', '127.0.0.1:8770')) === true)

  // The case the whole thing exists for: cloudflared runs here, so the socket
  // is loopback, but the browser asked for the public name.
  check('a tunnel on this machine is not local — the Host gives it away',
    isLocalRequest(fakeReq('127.0.0.1', 'llama-cpp.example.com')) === false)

  // And the mirror: someone on the LAN cannot claim to be local.
  check('a LAN caller sending Host: localhost is not local either',
    isLocalRequest(fakeReq('192.168.1.40', 'localhost:8770')) === false)

  check('a forwarding header settles it on its own',
    isLocalRequest(fakeReq('127.0.0.1', 'localhost:8770', { 'x-forwarded-for': '9.9.9.9' })) === false)
  check('as does a forwarded host or proto',
    isLocalRequest(fakeReq('127.0.0.1', 'localhost:8770', { 'x-forwarded-host': 'x.com' })) === false
    && isLocalRequest(fakeReq('127.0.0.1', 'localhost:8770', { 'x-forwarded-proto': 'https' })) === false)

  check('an unreadable address is treated as remote, not as local',
    isLocalRequest(fakeReq(undefined, 'localhost:8770')) === false)
  check('and so is a request with no Host at all', isLocalRequest(fakeReq('127.0.0.1', undefined)) === false)

  check('a bracketed IPv6 host is unwrapped', hostnameOf(fakeReq('::1', '[::1]:8770')) === '::1')

  check('the key comparison accepts the right key', matchesKey(KEY, KEY) === true)
  check('  rejects a wrong one of the same length',
    matchesKey(KEY.slice(0, -1) + 'X', KEY) === false)
  check('  rejects a prefix, rather than throwing on the length', matchesKey('M3xk', KEY) === false)
  check('  and rejects nothing at all', matchesKey(undefined, KEY) === false)
}

async function lockedSection() {
  const studio = await startServer({
    manager: stubManager({ apiKey: KEY }),
    host: '127.0.0.1', port: 0, version: 'test', log() {},
  })
  const base = studio.url
  // Every request below arrives on a loopback socket, because that is the only
  // kind a test can make. The Host is what varies — which is the point.
  const REMOTE = { host: 'llama-cpp.example.com' }
  const LOCAL = { host: '127.0.0.1' }
  // What a browser navigating to the page actually sends; the unlock page is
  // for browsers, and anything else gets JSON.
  const BROWSER = Object.assign({ accept: 'text/html,application/xhtml+xml' }, REMOTE)

  try {
    // ---- the door is shut ----
    const shell = await request(base, { headers: BROWSER })
    check('a remote caller does not get the app shell', shell.status === 401, String(shell.status))
    check('  it gets a page asking for the key', /API key/.test(shell.body) && /Unlock/.test(shell.body))
    check('  and the session token is not in it — that was the whole hole',
      shell.body.indexOf(studio.token) === -1)
    check('  nor is a session cookie handed out',
      shell.headers['set-cookie'] === undefined, String(shell.headers['set-cookie']))

    const asset = await request(base, { path: '/assets/client.bundle.js', headers: REMOTE })
    check('the assets are behind the door too', asset.status === 401, String(asset.status))

    const rpc = await request(base, {
      path: '/api/rpc', method: 'POST', headers: REMOTE, body: '{"channel":"llama.ping"}',
    })
    check('so is the RPC channel', rpc.status === 401, String(rpc.status))
    check('  and a caller that is not a browser gets JSON, not a page',
      JSON.parse(rpc.body).code === 'LOCKED', rpc.body)

    // ---- what stays open ----
    const health = await request(base, { path: '/api/health', headers: REMOTE })
    check('the health probe stays open, for whatever is watching the tunnel',
      health.status === 200, String(health.status))

    // ---- sitting at the machine ----
    const local = await request(base, { headers: LOCAL })
    check('at 127.0.0.1 on this machine there is no prompt', local.status === 200, String(local.status))
    check('  and the shell carries the session as before',
      local.body.indexOf(studio.token) !== -1)

    // ---- unlocking ----
    const bad = await request(base, {
      path: '/api/login', method: 'POST', headers: Object.assign({
        'content-type': 'application/x-www-form-urlencoded',
      }, REMOTE),
      body: 'key=' + encodeURIComponent('not-the-key'),
    })
    check('a wrong key is refused', bad.status === 401, String(bad.status))
    check('  with no session attached', bad.headers['set-cookie'] === undefined)
    check('  and says so on the page', /does not match/.test(bad.body))

    const good = await request(base, {
      path: '/api/login', method: 'POST', headers: Object.assign({
        'content-type': 'application/x-www-form-urlencoded',
      }, REMOTE),
      body: 'key=' + encodeURIComponent(KEY),
    })
    check('the right key is accepted', good.status === 302, String(good.status))
    const cookie = String(good.headers['set-cookie'] || '')
    check('  and hands over the session', cookie.indexOf(studio.token) !== -1, cookie)
    check('  HttpOnly and SameSite=Strict, like the one the shell sets',
      /HttpOnly/i.test(cookie) && /SameSite=Strict/i.test(cookie), cookie)

    const after = await request(base, {
      headers: Object.assign({ cookie: 'llama_session=' + studio.token }, REMOTE),
    })
    check('and that session opens the app', after.status === 200, String(after.status))
    check('  which now carries the token', after.body.indexOf(studio.token) !== -1)

    // ---- a script has no browser to unlock in ----
    const bearer = await request(base, {
      path: '/api/rpc', method: 'POST',
      headers: Object.assign({ authorization: 'Bearer ' + KEY }, REMOTE),
      body: '{"channel":"llama.ping"}',
    })
    check('the key also works as a bearer token, for callers with no browser',
      bearer.status === 200, String(bearer.status))
    const wrongBearer = await request(base, {
      path: '/api/rpc', method: 'POST',
      headers: Object.assign({ authorization: 'Bearer nope' }, REMOTE),
      body: '{"channel":"llama.ping"}',
    })
    check('  but the wrong one does not', wrongBearer.status === 401, String(wrongBearer.status))
  } finally {
    await studio.close()
  }
}

async function unlockedSection() {
  // No key configured: nothing to authenticate with, so nothing changes. The
  // gate must not lock people out of an app they cannot unlock.
  const studio = await startServer({
    manager: stubManager({}),
    host: '127.0.0.1', port: 0, version: 'test', log() {},
  })
  try {
    const remote = await request(studio.url, { headers: { host: 'llama-cpp.example.com' } })
    check('with no API key set, a remote caller is let in as before',
      remote.status === 200, String(remote.status))
    check('  and gets the session, exactly as it did', remote.body.indexOf(studio.token) !== -1)
  } finally {
    await studio.close()
  }
}

async function main() {
  console.log('llama.cpp Studio front door')
  unitSection()
  await lockedSection()
  await unlockedSection()
  return finish('gate.test.js')
}

main()
  .then(function (code) { process.exit(code) })
  .catch(function (err) {
    console.error(err && err.stack ? err.stack : err)
    process.exit(1)
  })
