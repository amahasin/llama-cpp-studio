// tests/smoke.js — boots the real app (manager + HTTP server) on an ephemeral
// port, drives it over the same RPC the browser uses, and shuts down.
// Usage: node standalone/tests/smoke.js [--data <dir>]
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { createManager } = require('../src/host.js')
const { startServer } = require('../src/server.js')

const APP_ROOT = path.resolve(__dirname, '..')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log('  ✓ ' + label)
  } else {
    failures += 1
    console.log('  ✗ ' + label + (detail === undefined ? '' : ' — ' + detail))
  }
}

async function rpc(url, token, channel, payload) {
  const res = await fetch(url + 'api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Llama-Token': token },
    body: JSON.stringify({ channel, payload }),
  })
  return { status: res.status, body: await res.json() }
}

async function main() {
  const idx = process.argv.indexOf('--data')
  // Scratch space stays inside the app folder rather than in the system temp
  // directory: this is the suite that proves the folder is self-contained, so
  // it has no business writing outside it either. Removed again below.
  const ephemeral = idx === -1
  if (ephemeral) fs.mkdirSync(path.join(APP_ROOT, '.tmp'), { recursive: true })
  const dataDir = ephemeral
    ? fs.mkdtempSync(path.join(APP_ROOT, '.tmp', 'smoke-'))
    : path.resolve(process.argv[idx + 1])
  console.log('llama.cpp Studio smoke test')
  console.log('  data: ' + dataDir + (ephemeral ? ' (temporary)' : ''))

  const booted = await createManager({ dataDir, log: function () {} })
  const http = await startServer({ manager: booted.manager, port: 0, version: 'smoke' })

  try {
    check('server listens on 127.0.0.1', http.port > 0, 'port ' + http.port)

    const health = await fetch(http.url + 'api/health')
    check('GET /api/health', health.status === 200 && (await health.json()).ok === true)

    const page = await fetch(http.url)
    const html = await page.text()
    check('index page serves the app shell', page.status === 200 && html.includes('llama.cpp Studio'))
    check('session token is injected into the page', !html.includes('__LLAMA_TOKEN__') && html.includes(http.token))

    const bundle = await fetch(http.url + 'assets/client.bundle.js')
    const bundleText = await bundle.text()
    check('client bundle is served', bundle.status === 200 && bundleText.includes('llama-cpp-manager-client'))

    const noToken = await fetch(http.url + 'api/rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'llama.ping', payload: {} }),
    })
    check('RPC without the token is rejected', noToken.status === 403)

    const ping = await rpc(http.url, http.token, 'llama.ping', {})
    check('llama.ping answers', ping.body.pong === true)

    const state = await rpc(http.url, http.token, 'llama.state', {})
    check('llama.state returns a full status', state.body.ok === true
      && state.body.settings !== undefined
      && state.body.versions !== undefined
      && state.body.models !== undefined, state.body.message)

    const settings = await rpc(http.url, http.token, 'llama.call', { method: 'settings.get', args: {} })
    check('settings.get works over RPC', settings.body.ok === true && settings.body.settings.server.port > 0)

    const update = await rpc(http.url, http.token, 'llama.call', { method: 'settings.update', args: { patch: { server: { port: 8123 } } } })
    const reread = await rpc(http.url, http.token, 'llama.call', { method: 'settings.get', args: {} })
    check('settings.update persists', update.body.ok === true && reread.body.settings.server.port === 8123)

    const diag = await rpc(http.url, http.token, 'llama.call', { method: 'diagnostics', args: {} })
    check('diagnostics runs against the real machine', diag.body.ok === true && diag.body.report.items.length > 0,
      diag.body.message)

    const hardware = await rpc(http.url, http.token, 'llama.call', { method: 'hardware', args: {} })
    check('hardware detection works', hardware.body.ok === true && hardware.body.hardware.cpu.name !== undefined)

    const unknown = await rpc(http.url, http.token, 'llama.call', { method: 'nope.nope', args: {} })
    check('unknown commands fail cleanly', unknown.body.ok === false && unknown.body.code === 'UNKNOWN_METHOD')

    const paths = await rpc(http.url, http.token, 'llama.call', { method: 'shell.paths', args: {} })
    check('shell.paths reports the managed directories', paths.body.ok === true
      && typeof paths.body.paths.installDirectory === 'string')

    // reveal on a path with no parent returns a structured error and opens nothing
    const reveal = await rpc(http.url, http.token, 'llama.call', { method: 'shell.reveal', args: { path: 'Q:/nope/none' } })
    check('shell.reveal reports a missing path instead of throwing',
      reveal.body.ok === false && reveal.body.error === 'PATH_NOT_FOUND')

    const configFile = path.join(dataDir, 'config.json')
    check('config.json is written into the data directory', fs.existsSync(configFile))
  } finally {
    await http.close()
    await booted.manager.shutdown()
    if (ephemeral) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch (_e) { /* a helper process can still hold the scripts directory */ }
      try { fs.rmdirSync(path.join(APP_ROOT, '.tmp')) } catch (_e) { /* another run is using it */ }
    }
  }

  console.log('')
  if (failures === 0) {
    console.log('all checks passed')
  } else {
    console.log(failures + ' check(s) failed')
    process.exitCode = 1
  }
  setTimeout(function () { process.exit(process.exitCode || 0) }, 200)
}

main().catch(function (err) {
  console.error('smoke test crashed:', err && err.stack ? err.stack : err)
  process.exit(1)
})
