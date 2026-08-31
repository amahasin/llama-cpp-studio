// tests/preset.test.js — a model's launch flags reach a router that is already
// running.
//
// The router reads its preset file once, at startup, and never again. So a
// model's flags changed afterwards did not reach it: the model kept loading
// with whatever was saved when the router came up. From the outside that looks
// exactly like "it loaded with default settings", because usually it did —
// the defaults that were current before anything was configured.
//
// llama.cpp can re-read the source on demand (GET /models?reload=1), so the
// fix is to rewrite the preset and ask. What is tested here is that the app
// actually asks, and that it does not pretend to have when it could not.
'use strict'

const { loadHostModules } = require('../src/host.js')
const { createChecker } = require('./helpers.js')

const LLAMA = loadHostModules()
const { check, finish } = createChecker()

/** A ServerManager in a chosen state, recording what it was asked to do. */
function serverIn(state, options) {
  const o = options || {}
  const calls = { planned: 0, reloadUrls: [], writes: 0 }
  const s = Object.create(LLAMA.server.ServerManager.prototype)
  s.state = state
  s.process = state === 'RUNNING'
    ? { router: o.router !== false, host: '127.0.0.1', port: 8080 }
    : undefined
  s.deps = {
    log() {},
    config: { get() { return {} } },
    exec: {
      async httpGetJson(url) {
        calls.reloadUrls.push(url)
        return o.reloadFails === true
          ? { ok: false, status: 500, message: 'nope' }
          : { ok: true, status: 200, data: {} }
      },
    },
  }
  s._planRouter = async function (opts) {
    calls.planned += 1
    calls.lastOpts = opts
    if (o.planFails === true) return { ok: false, code: 'NO_ROUTER_SUPPORT', message: 'no router' }
    return { ok: true }
  }
  return { s, calls }
}

async function main() {
  console.log('llama.cpp Studio router preset refresh')

  // ---- the happy path ----
  {
    const { s, calls } = serverIn('RUNNING')
    const r = await s.refreshRouterPreset()
    check('a running router is refreshed', r.ok === true && r.refreshed === true, JSON.stringify(r))
    check('the preset is re-planned', calls.planned === 1)
    check('and written, even though the port is busy with our own router',
      calls.lastOpts.forceWritePreset === true && calls.lastOpts.previewOnly === true,
      JSON.stringify(calls.lastOpts))
    check('the router is told to re-read it',
      calls.reloadUrls.length === 1 && /\/models\?reload=1$/.test(calls.reloadUrls[0]),
      String(calls.reloadUrls[0]))
  }

  // ---- nothing to refresh ----
  for (const state of ['STOPPED', 'STARTING', 'FAILED']) {
    const { s, calls } = serverIn(state)
    const r = await s.refreshRouterPreset()
    check('a ' + state + ' server is left alone', r.ok === true && r.refreshed === false, JSON.stringify(r))
    check('  without planning or calling anything',
      calls.planned === 0 && calls.reloadUrls.length === 0)
  }
  {
    // Single-model mode builds its argv fresh on every launch; there is no
    // preset to go stale.
    const { s, calls } = serverIn('RUNNING', { router: false })
    const r = await s.refreshRouterPreset()
    check('a single-model server needs no refresh', r.refreshed === false)
    check('  and is not re-planned', calls.planned === 0)
  }

  // ---- failures are reported, not swallowed ----
  {
    const { s } = serverIn('RUNNING', { planFails: true })
    const r = await s.refreshRouterPreset()
    check('a preset that cannot be built is reported', r.ok === false && r.code === 'NO_ROUTER_SUPPORT')
  }
  {
    const { s } = serverIn('RUNNING', { reloadFails: true })
    const r = await s.refreshRouterPreset()
    check('a router that will not re-read is reported', r.ok === false && r.code === 'PRESET_RELOAD_FAILED')
    check('  and says what to do instead',
      (r.remediation || []).join(' ').indexOf('Restart') !== -1, JSON.stringify(r.remediation))
  }

  // ---- what saving a model's settings does with that ----
  {
    const manager = Object.create(LLAMA.api.Manager.prototype)
    manager.server = { async refreshRouterPreset() { return { ok: true, refreshed: true } } }
    const saved = await manager._afterLibraryChange({ ok: true })
    check('a successful save reports that the router picked it up', saved.routerRefreshed === true)

    manager.server = {
      async refreshRouterPreset() {
        return { ok: false, code: 'PRESET_RELOAD_FAILED', message: 'the router would not re-read it' }
      },
    }
    const warned = await manager._afterLibraryChange({ ok: true })
    check('a refusal becomes a warning, not a failed save', warned.ok === true)
    check('  and says so', (warned.warnings || []).join(' ').indexOf('re-read') !== -1,
      JSON.stringify(warned.warnings))

    manager.server = { async refreshRouterPreset() { throw new Error('boom') } }
    const threw = await manager._afterLibraryChange({ ok: true })
    check('a thrown refresh does not lose the save', threw.ok === true)
    check('  and is reported', (threw.warnings || []).join(' ').indexOf('boom') !== -1)

    const failed = await manager._afterLibraryChange({ ok: false, code: 'NOPE' })
    check('a failed save is passed through untouched',
      failed.ok === false && failed.routerRefreshed === undefined)
  }

  return finish('preset.test.js')
}

main()
  .then(function (code) { process.exit(code) })
  .catch(function (err) {
    console.error(err && err.stack ? err.stack : err)
    process.exit(1)
  })
