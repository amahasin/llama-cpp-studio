// idle.js — give the memory back when nothing is using the model.
//
// A loaded model holds its weights in VRAM for as long as llama-server has it,
// whether or not anyone is talking to it. On a desktop GPU that is the whole
// card, held overnight because someone asked one question in the morning.
//
// What counts as activity is llama-server's *own* counters, read through the
// manager's metrics: the number of decode calls, prompt and generated tokens,
// and whether any slot is processing right now. That matters because the
// OpenAI-compatible endpoint is the point of this app — most requests come
// from other programs, not from the browser tab, and anything that watched the
// UI instead would unload a model out from under a script that was using it.
//
// It also means the opposite is true and deliberate: leaving the dashboard open
// does not keep a model resident. Watching a graph is not using a model.
//
// Unloading is not the same as stopping:
//   • router mode  — unload each loaded model and leave llama-server up. The
//                    endpoint keeps answering and the next request loads the
//                    model again on its own (that is `--models-autoload`).
//   • single mode  — the model *is* the process, so the server is stopped.
//                    Nothing reloads it automatically; this is the disruptive
//                    one, and it is why the timeout is a setting rather than
//                    something this app decides on its own.
'use strict'

const MS_PER_MINUTE = 60 * 1000

/** How often to look. Small enough to be responsive, large enough to be free. */
const DEFAULT_POLL_MS = 30 * 1000

/** The counters that only move when llama-server is actually working. */
function activityFingerprint(server) {
  return [
    server.decodeCalls,
    server.promptTokens,
    server.generatedTokens,
  ].map(function (v) { return v === undefined ? '-' : String(v) }).join(':')
}

function isBusy(server) {
  return Number(server.requestsProcessing) > 0
    || Number(server.requestsDeferred) > 0
    || Number(server.slotsProcessing) > 0
}

/** A timeout in minutes as a usable number: anything that is not positive is off. */
function toMinutes(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * options: {
 *   manager,                the booted manager
 *   minutes,                idle timeout; 0 or less disables the whole thing.
 *                           Either a number, fixed for the life of the
 *                           supervisor (--idle-unload), or a function read on
 *                           every tick (the saved setting), so a change made in
 *                           Server Config applies without a restart
 *   log(message),           optional
 *   now(),                  optional clock, for tests
 *   pollMs,                 optional
 * }
 * Returns { start(), stop(), tick(), idleMs(), enabled, minutes, armed }.
 *
 * tick() is separate from start() so the behaviour can be tested against a
 * clock that does not take half an hour to move.
 */
function createIdleUnloader(options) {
  const manager = options.manager
  const log = options.log || function () {}
  const now = options.now || function () { return Date.now() }
  const pollMs = options.pollMs || DEFAULT_POLL_MS
  const live = typeof options.minutes === 'function'
  const readMinutes = live
    ? function () {
      try { return toMinutes(options.minutes()) } catch (_e) { return 0 }
    }
    : (function (fixed) { return function () { return fixed } })(toMinutes(options.minutes))

  let lastActiveAt = now()
  let lastFingerprint
  let timer
  // What the last tick ran with, so a change is said once rather than polled.
  let lastMinutes = readMinutes()

  async function cmd(method, args) {
    try {
      return await manager.cmd(method, args || {})
    } catch (err) {
      log('idle check: ' + method + ' failed: ' + String(err && err.message ? err.message : err))
      return { ok: false }
    }
  }

  /** Free the model, by whichever route this mode allows. */
  async function unload(server, minutes) {
    if (server.mode === 'router') {
      const listed = await cmd('server.models')
      const loaded = ((listed && listed.models) || []).filter(function (m) {
        return m && m.state === 'loaded'
      })
      if (loaded.length === 0) return { action: 'nothing-loaded' }

      const unloaded = []
      for (const model of loaded) {
        const res = await cmd('server.unloadModel', { model: model.id })
        if (res && res.ok !== false) unloaded.push(model.id)
        else log('idle unload failed for ' + model.id + ': ' + ((res && res.message) || 'unknown'))
      }
      if (unloaded.length === 0) return { action: 'unload-failed' }
      log('idle for ' + minutes + ' min — unloaded ' + unloaded.join(', ')
        + '; the router stays up and will load again on the next request')
      return { action: 'unloaded', models: unloaded }
    }

    // Single-model mode: there is no unload, only stop.
    const res = await cmd('server.stop')
    if (res && res.ok === false) return { action: 'stop-failed' }
    log('idle for ' + minutes + ' min — stopped llama-server to free its memory')
    return { action: 'stopped' }
  }

  /**
   * One look at the world. Returns what it decided, which is what the tests
   * assert on and what the log line is built from.
   */
  async function tick() {
    const minutes = readMinutes()
    if (minutes !== lastMinutes) {
      log(minutes > 0
        ? 'idle unload: models are now released after ' + minutes + ' minutes without a request'
        : 'idle unload turned off')
      lastMinutes = minutes
      // Whatever idle time had built up was measured against the old limit.
      lastActiveAt = now()
    }
    if (minutes <= 0) {
      // Off: hold no idle clock, so turning it on later starts from zero rather
      // than unloading on the very next tick.
      lastActiveAt = now()
      lastFingerprint = undefined
      return { action: 'disabled' }
    }
    const idleLimitMs = minutes * MS_PER_MINUTE

    const status = await cmd('server.status')
    const server = (status && status.server) || undefined
    if (!server || server.state !== 'RUNNING') {
      // Nothing to unload, and no reason to hold a stale idle clock.
      lastActiveAt = now()
      lastFingerprint = undefined
      return { action: 'not-running' }
    }

    const snapshot = await cmd('server.metrics')
    const metrics = (snapshot && snapshot.metrics && snapshot.metrics.server) || {}

    if (isBusy(metrics)) {
      lastActiveAt = now()
      lastFingerprint = activityFingerprint(metrics)
      return { action: 'busy' }
    }

    const fingerprint = activityFingerprint(metrics)
    if (fingerprint !== lastFingerprint) {
      // Either the first look, or work happened since the last one.
      lastFingerprint = fingerprint
      lastActiveAt = now()
      return { action: 'active' }
    }

    const idleMs = now() - lastActiveAt
    if (idleMs < idleLimitMs) return { action: 'waiting', idleMs }

    const result = await unload(server, minutes)
    // Whatever happened, do not try again until something moves: a failed
    // unload retried every 30 seconds is a log full of the same line.
    lastActiveAt = now()
    return Object.assign({ idleMs }, result)
  }

  return {
    /**
     * Arm the poll. A fixed timeout of 0 arms nothing — it can never change.
     * A live one is always armed, because the setting can be switched on later
     * and a tick that finds it off costs no more than reading it.
     */
    start() {
      if (timer !== undefined) return
      const minutes = readMinutes()
      if (!live && minutes <= 0) return
      lastActiveAt = now()
      lastMinutes = minutes
      timer = setInterval(function () {
        tick().catch(function (err) {
          log('idle check failed: ' + String(err && err.message ? err.message : err))
        })
      }, pollMs)
      if (typeof timer.unref === 'function') timer.unref()
      if (minutes > 0) {
        log('idle unload armed: models are released after ' + minutes + ' minutes without a request')
      }
    },
    stop() {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
    tick,
    idleMs() { return now() - lastActiveAt },
    get enabled() { return readMinutes() > 0 },
    get minutes() { return readMinutes() },
    /** Whether start() left a poll running. */
    get armed() { return timer !== undefined },
  }
}

module.exports = {
  createIdleUnloader, activityFingerprint, isBusy, toMinutes, MS_PER_MINUTE, DEFAULT_POLL_MS,
}
