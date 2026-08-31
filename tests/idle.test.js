// tests/idle.test.js — a model nobody is using gets its memory back.
//
// The clock is injected, so half an hour of idleness costs nothing here. The
// manager is a stub that records the commands it was asked for: what matters
// is *which* command the unloader reaches for in each mode, and — more
// importantly — the cases where it must reach for none at all.
'use strict'

const { createIdleUnloader } = require('../src/idle.js')
const { createChecker } = require('./helpers.js')

const { check, finish } = createChecker()

const MINUTE = 60 * 1000

/**
 * A manager whose server state and counters the test drives directly.
 * `calls` records every command, so "did not touch the server" is assertable.
 */
function stubManager(initial) {
  const state = Object.assign({
    server: { state: 'RUNNING', mode: 'router' },
    metrics: { decodeCalls: 10, promptTokens: 100, generatedTokens: 50, requestsProcessing: 0 },
    routerModels: [{ id: 'qwen', state: 'loaded' }],
  }, initial)

  const calls = []
  return {
    state,
    calls,
    config: { get() { return { idleUnloadMinutes: 30 } } },
    async cmd(method, args) {
      calls.push({ method, args })
      switch (method) {
        case 'server.status': return { ok: true, server: state.server }
        case 'server.metrics': return { ok: true, metrics: { server: state.metrics } }
        case 'server.models': return { ok: true, models: state.routerModels }
        case 'server.unloadModel':
          state.routerModels = state.routerModels.map(function (m) {
            return m.id === args.model ? { id: m.id, state: 'unloaded' } : m
          })
          return { ok: true }
        case 'server.stop':
          state.server = { state: 'STOPPED' }
          return { ok: true }
        default: return { ok: true }
      }
    },
  }
}

/** A clock the test moves by hand. */
function fakeClock() {
  let t = 1000000
  return { now() { return t }, advance(ms) { t += ms } }
}

function build(manager, minutes, clock) {
  return createIdleUnloader({ manager, minutes, now: clock.now, log() {} })
}

async function main() {
  console.log('llama.cpp Studio idle unload')

  // ---- router mode: unload, keep the endpoint up ----
  {
    const clock = fakeClock()
    const manager = stubManager()
    const idle = build(manager, 30, clock)

    check('the first look just starts the clock', (await idle.tick()).action === 'active')

    clock.advance(29 * MINUTE)
    const early = await idle.tick()
    check('29 minutes in, it waits', early.action === 'waiting', early.action)
    check('and has not touched the model',
      !manager.calls.some(function (c) { return c.method === 'server.unloadModel' }))

    clock.advance(2 * MINUTE)
    const fired = await idle.tick()
    check('past the timeout it unloads', fired.action === 'unloaded', fired.action)
    check('naming the model it unloaded', (fired.models || []).join(',') === 'qwen')
    check('the router itself is left running',
      !manager.calls.some(function (c) { return c.method === 'server.stop' }))
    check('and the model is no longer loaded',
      manager.state.routerModels.every(function (m) { return m.state !== 'loaded' }))
  }

  // ---- work resets the clock ----
  {
    const clock = fakeClock()
    const manager = stubManager()
    const idle = build(manager, 30, clock)
    await idle.tick()

    clock.advance(29 * MINUTE)
    // Somebody asked a question: llama-server's own counters moved.
    manager.state.metrics = Object.assign({}, manager.state.metrics, { decodeCalls: 11 })
    check('a request resets the idle clock', (await idle.tick()).action === 'active')

    clock.advance(29 * MINUTE)
    check('so 29 more minutes is still not enough', (await idle.tick()).action === 'waiting')
    check('and nothing was unloaded',
      !manager.calls.some(function (c) { return c.method === 'server.unloadModel' }))

    clock.advance(2 * MINUTE)
    check('but the full timeout after the last request is', (await idle.tick()).action === 'unloaded')
  }

  // ---- never unload out from under a request in flight ----
  {
    const clock = fakeClock()
    const manager = stubManager()
    const idle = build(manager, 30, clock)
    await idle.tick()
    clock.advance(60 * MINUTE)
    manager.state.metrics = Object.assign({}, manager.state.metrics, { requestsProcessing: 1 })
    const busy = await idle.tick()
    check('a slot that is processing counts as busy', busy.action === 'busy', busy.action)
    check('even long past the timeout, nothing is unloaded',
      !manager.calls.some(function (c) { return c.method === 'server.unloadModel' }))

    // A queued request counts too.
    manager.state.metrics = Object.assign({}, manager.state.metrics,
      { requestsProcessing: 0, requestsDeferred: 2 })
    check('a deferred request counts as busy', (await idle.tick()).action === 'busy')
  }

  // ---- single-model mode: stop, because there is no unload ----
  {
    const clock = fakeClock()
    const manager = stubManager({ server: { state: 'RUNNING', mode: 'single' } })
    const idle = build(manager, 15, clock)
    await idle.tick()
    clock.advance(16 * MINUTE)
    const fired = await idle.tick()
    check('single mode stops the server instead', fired.action === 'stopped', fired.action)
    check('because there is nothing to unload it from',
      !manager.calls.some(function (c) { return c.method === 'server.unloadModel' }))
  }

  // ---- nothing to do ----
  {
    const clock = fakeClock()
    const manager = stubManager({ server: { state: 'STOPPED' } })
    const idle = build(manager, 30, clock)
    clock.advance(60 * MINUTE)
    check('a stopped server is left alone', (await idle.tick()).action === 'not-running')
    check('and is not asked for metrics it has none of',
      !manager.calls.some(function (c) { return c.method === 'server.metrics' }))
  }
  {
    const clock = fakeClock()
    const manager = stubManager({ routerModels: [{ id: 'qwen', state: 'unloaded' }] })
    const idle = build(manager, 30, clock)
    await idle.tick()
    clock.advance(31 * MINUTE)
    check('a router with nothing loaded has nothing to unload',
      (await idle.tick()).action === 'nothing-loaded')
  }

  // ---- turned off ----
  {
    const clock = fakeClock()
    const manager = stubManager()
    const idle = build(manager, 0, clock)
    clock.advance(24 * 60 * MINUTE)
    check('0 minutes disables it', (await idle.tick()).action === 'disabled')
    check('without asking the manager anything at all', manager.calls.length === 0)
    check('and start() arms no timer', idle.enabled === false)
  }

  // ---- a failure does not become a log flood ----
  {
    const clock = fakeClock()
    const manager = stubManager()
    manager.cmd = (function (inner) {
      return async function (method, args) {
        if (method === 'server.unloadModel') { inner.calls.push({ method, args }); return { ok: false, message: 'busy' } }
        return inner.cmd.call(inner, method, args)
      }
    })(Object.assign({}, manager, { cmd: manager.cmd }))
    // Rebuild against the wrapped manager.
    const wrapped = { calls: manager.calls, cmd: manager.cmd, config: manager.config }
    const idle = createIdleUnloader({ manager: wrapped, minutes: 30, now: clock.now, log() {} })
    await idle.tick()
    clock.advance(31 * MINUTE)
    check('a refused unload is reported', (await idle.tick()).action === 'unload-failed')
    const attempts = manager.calls.filter(function (c) { return c.method === 'server.unloadModel' }).length
    clock.advance(1 * MINUTE)
    check('and is not retried on the very next tick', (await idle.tick()).action === 'waiting')
    check('so the attempt count did not climb',
      manager.calls.filter(function (c) { return c.method === 'server.unloadModel' }).length === attempts)
  }

  return finish('idle.test.js')
}

main()
  .then(function (code) { process.exit(code) })
  .catch(function (err) {
    console.error(err && err.stack ? err.stack : err)
    process.exit(1)
  })
