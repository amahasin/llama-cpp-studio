// services/timer.js — the harness `timer` service.
//
// timeout(ms)        -> Promise resolved after ms      (used as sleep)
// timeout(cb, ms)    -> disposer
// interval(cb, ms)   -> disposer
// Timers are unref'd so a pending poll never keeps the process alive, and all
// of them are tracked so shutdown can clear the lot.
'use strict'

function createTimerService() {
  const handles = new Set()

  function track(handle) {
    handles.add(handle)
    if (typeof handle.unref === 'function') handle.unref()
    return handle
  }

  return {
    timeout(a, b) {
      if (typeof a === 'number') {
        return new Promise(function (resolve) {
          const t = track(setTimeout(function () { handles.delete(t); resolve() }, a))
        })
      }
      const t = track(setTimeout(function () { handles.delete(t); a() }, b))
      return function dispose() { handles.delete(t); clearTimeout(t) }
    },
    interval(cb, ms) {
      const t = track(setInterval(cb, ms))
      return function dispose() { handles.delete(t); clearInterval(t) }
    },
    disposeAll() {
      for (const t of handles) {
        clearTimeout(t)
        clearInterval(t)
      }
      handles.clear()
    },
  }
}

module.exports = { createTimerService }
