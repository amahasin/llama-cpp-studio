// tests/proxy.test.js — llama-server reached through this app's own origin.
//
// The chat frame used to point straight at llama-server's address. On any
// device other than the one it runs on that address is meaningless, and a
// cross-origin frame is denied the clipboard, so llama.cpp's copy buttons did
// nothing. Both are fixed by proxying it here — which is only a fix if the
// proxy is faithful, keeps the session gate, and does not swallow streams.
//
// A stub stands in for llama-server: this is about the proxy, and starting a
// real model would make it a test of the GPU.
'use strict'

const http = require('node:http')

const { startServer } = require('../src/server.js')
const { createChecker } = require('./helpers.js')

const { check, finish } = createChecker()

/** A minimal stand-in for llama-server: enough surface to prove forwarding. */
function startUpstream() {
  return new Promise(function (resolve) {
    const seen = []
    const server = http.createServer(function (req, res) {
      seen.push({ method: req.method, url: req.url, headers: req.headers })

      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY' })
        res.end('<!doctype html><title>llama.cpp</title><body>chat ui</body>')
        return
      }
      if (req.url === '/props') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, saw: req.headers.authorization || null }))
        return
      }
      if (req.url === '/stream') {
        // Server-sent events: the shape token generation arrives in.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: one\n\n')
        setTimeout(function () {
          res.write('data: two\n\n')
          res.end()
        }, 60)
        return
      }
      if (req.method === 'POST' && req.url === '/echo') {
        let body = ''
        req.on('data', function (c) { body += c })
        req.on('end', function () {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ got: body }))
        })
        return
      }
      res.writeHead(404)
      res.end('nope')
    })
    server.listen(0, '127.0.0.1', function () {
      resolve({ server, port: server.address().port, seen })
    })
  })
}

/** A manager with just the surface the proxy and the router read. */
function stubManager(options) {
  const o = options || {}
  return {
    config: {
      get(section) {
        if (section !== 'server') return {}
        return { host: '127.0.0.1', port: o.port, apiKey: o.apiKey, allowedOrigins: '' }
      },
    },
    server: {
      status() {
        return o.running === false
          ? { state: 'STOPPED' }
          : { state: 'RUNNING', host: '127.0.0.1', port: o.port }
      },
    },
    async cmd() { return { ok: true } },
  }
}

async function main() {
  console.log('llama.cpp Studio llama-server proxy')
  const upstream = await startUpstream()
  console.log('  stub llama-server on 127.0.0.1:' + upstream.port)

  const studio = await startServer({
    manager: stubManager({ port: upstream.port, apiKey: 'test-key' }),
    host: '127.0.0.1',
    port: 0,
    version: 'test',
    log() {},
  })
  const base = studio.url.replace(/\/$/, '')
  const auth = { 'x-llama-token': studio.token }

  try {
    // ---- the session gate still applies ----
    const noAuth = await fetch(base + '/llama/')
    check('the proxy refuses a caller with no session', noAuth.status === 403, String(noAuth.status))

    // ---- the frame document ----
    const frame = await fetch(base + '/llama/', { headers: auth })
    const html = await frame.text()
    check('/llama/ returns llama-server\'s page', frame.status === 200 && /chat ui/.test(html), String(frame.status))
    check('and it maps to the upstream root, prefix stripped',
      upstream.seen.some(function (r) { return r.url === '/' }))
    check('the frame-blocking header is stripped, or the iframe would stay empty',
      frame.headers.get('x-frame-options') === null)

    // ---- llama.cpp calls its API on absolute paths ----
    const props = await fetch(base + '/props', { headers: auth })
    const propsBody = await props.json()
    check('an absolute API path falls through to the proxy', props.status === 200, String(props.status))
    check('the API key is added server-side, so the frame never holds it',
      propsBody.saw === 'Bearer test-key', String(propsBody.saw))

    // ---- this app keeps its own routes ----
    const health = await fetch(base + '/api/health')
    check('/api/health is still this app, not proxied', (await health.json()).app === 'llama.cpp Studio')
    const page = await fetch(base + '/')
    check('/ is still this app\'s shell', /data-llama-token/.test(await page.text()))

    // ---- bodies and streams ----
    const echo = await fetch(base + '/echo', {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
      body: '{"hello":"world"}',
    })
    check('a POST body is forwarded intact', (await echo.json()).got === '{"hello":"world"}')

    const stream = await fetch(base + '/stream', { headers: auth })
    check('an event stream is passed through as one', stream.headers.get('content-type') === 'text/event-stream')
    check('and both events arrive', (await stream.text()) === 'data: one\n\ndata: two\n\n')

    // ---- the cookie is what an iframe actually sends ----
    const cookie = page.headers.get('set-cookie') || ''
    check('the shell sets a session cookie for the frame to use', /llama_session=/.test(cookie), cookie)
    check('the cookie is HttpOnly', /HttpOnly/i.test(cookie), cookie)
    check('the cookie is SameSite=Strict', /SameSite=Strict/i.test(cookie), cookie)
    const viaCookie = await fetch(base + '/llama/', {
      headers: { cookie: 'llama_session=' + studio.token },
    })
    check('and it is accepted in place of the header', viaCookie.status === 200, String(viaCookie.status))
    const wrongCookie = await fetch(base + '/llama/', { headers: { cookie: 'llama_session=nope' } })
    check('a wrong cookie is refused', wrongCookie.status === 403, String(wrongCookie.status))

    // ---- reading about a model must not load it ----
    //
    // In router mode llama.cpp loads a model just to answer a question about
    // it: GET /props?model=X loads X. With one model allowed at a time, simply
    // opening the Chat tab could evict whatever was loaded — the "it loaded the
    // model again" nobody asked for. A GET is told not to; a POST still loads.
    {
      await fetch(base + '/props?model=gemma', { headers: auth })
      const seen = upstream.seen[upstream.seen.length - 1]
      check('a GET naming a model is marked no-autoload',
        /autoload=false/.test(seen.url), seen.url)
      check('and keeps the model it asked about', /model=gemma/.test(seen.url), seen.url)
    }
    {
      await fetch(base + '/props', { headers: auth })
      const seen = upstream.seen[upstream.seen.length - 1]
      check('a GET naming no model is left alone', !/autoload/.test(seen.url), seen.url)
    }
    {
      await fetch(base + '/props?model=gemma&autoload=true', { headers: auth })
      const seen = upstream.seen[upstream.seen.length - 1]
      check('an explicit autoload choice is respected', /autoload=true/.test(seen.url), seen.url)
    }
    {
      await fetch(base + '/echo?model=gemma', {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth), body: '{}',
      })
      const seen = upstream.seen[upstream.seen.length - 1]
      check('a POST is never touched — that is a real request, and it should load',
        !/autoload/.test(seen.url), seen.url)
    }
    {
      await fetch(base + '/llama/props?model=gemma', { headers: auth })
      const seen = upstream.seen[upstream.seen.length - 1]
      check('the prefix is still stripped when the query is rewritten',
        seen.url.startsWith('/props?'), seen.url)
    }

    // ---- the upstream never sees our session ----
    const withCookie = upstream.seen.filter(function (r) { return r.headers.cookie !== undefined })
    check('the session cookie is never forwarded upstream', withCookie.length === 0,
      String(withCookie.length) + ' request(s) carried it')
  } finally {
    await studio.close()
    upstream.server.close()
  }

  // ---- a stopped server says so rather than hanging ----
  const stopped = await startServer({
    manager: stubManager({ port: upstream.port, running: false }),
    host: '127.0.0.1', port: 0, version: 'test', log() {},
  })
  try {
    const res = await fetch(stopped.url + 'llama/', { headers: { 'x-llama-token': stopped.token } })
    check('with no server running the proxy answers 503', res.status === 503, String(res.status))
    check('and says why', (await res.json()).code === 'SERVER_NOT_RUNNING')
  } finally {
    await stopped.close()
  }

  return finish('proxy.test.js')
}

main()
  .then(function (code) { process.exit(code) })
  .catch(function (err) {
    console.error(err && err.stack ? err.stack : err)
    process.exit(1)
  })
