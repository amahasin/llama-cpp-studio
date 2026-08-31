// app.js — the standalone shell.
//
// It provides exactly what the plugin's client half expects from the harness —
// a `styles` service, a `host.call` RPC channel and a Cordis-ish `ctx` with
// timer + slots — then mounts the plugin's own UI. The plugin bundle is used
// unmodified, so the app and the harness plugin always look and behave alike.
(function () {
  'use strict'

  const TOKEN = window.__LLAMA_TOKEN
  const rootEl = document.getElementById('root')
  const offlineEl = document.getElementById('app-offline')

  // ---------- theme ----------
  const THEME_KEY = 'llama-studio-theme'
  function applyTheme(mode) {
    const dark = mode === 'dark'
      || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    if (dark) document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
    window.__LLAMA_THEME = mode
    window.dispatchEvent(new CustomEvent('llama-theme-change', { detail: mode }))
  }
  let theme = localStorage.getItem(THEME_KEY) || 'system'
  applyTheme(theme)

  window.__getTheme = function () { return theme }
  window.__setTheme = function (next) {
    theme = next
    localStorage.setItem(THEME_KEY, theme)
    applyTheme(theme)
  }
  window.__cycleTheme = function () {
    const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'
    window.__setTheme(next)
    return next
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (theme === 'system') applyTheme(theme)
  })

  // ---------- connectivity banner ----------
  let failures = 0
  function markOnline() {
    failures = 0
    offlineEl.hidden = true
  }
  function markOffline(message) {
    failures += 1
    if (failures < 3) return
    offlineEl.hidden = false
    offlineEl.textContent = 'Lost contact with llama.cpp Studio (' + message
      + '). Is the app still running?'
  }

  // ---------- host RPC ----------
  const host = {
    async call(channel, payload) {
      try {
        const res = await fetch('/api/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Llama-Token': TOKEN },
          body: JSON.stringify({ channel: channel, payload: payload || {} }),
        })
        if (!res.ok) {
          markOffline('HTTP ' + res.status)
          return { ok: false, code: 'HTTP_' + res.status, message: 'Request failed with HTTP ' + res.status }
        }
        markOnline()
        return await res.json()
      } catch (e) {
        markOffline(String(e && e.message ? e.message : e))
        return { ok: false, code: 'OFFLINE', message: String(e && e.message ? e.message : e) }
      }
    },
  }

  const styles = {
    insert(css) {
      const el = document.createElement('style')
      el.setAttribute('data-llama-plugin', '')
      el.textContent = css
      document.head.appendChild(el)
    },
  }

  // Minimal stand-ins for the Cordis services the client half injects.
  const ctx = {
    timer: {
      interval(cb, ms) {
        const id = setInterval(cb, ms)
        return function dispose() { clearInterval(id) }
      },
      timeout(cb, ms) {
        if (typeof cb === 'number') return new Promise(function (r) { setTimeout(r, cb) })
        const id = setTimeout(cb, ms)
        return function dispose() { clearTimeout(id) }
      },
    },
    slots: {
      inject(_name, register) { register() },
      register(_meta, component) {
        ctx.slots.component = component
        return function dispose() { ctx.slots.component = undefined }
      },
    },
  }

  function fail(message, detail) {
    rootEl.innerHTML = ''
    const box = document.createElement('div')
    box.className = 'app-offline'
    box.textContent = message + (detail ? '\n\n' + detail : '')
    box.style.whiteSpace = 'pre-wrap'
    rootEl.appendChild(box)
  }

  async function boot() {
    let source
    try {
      const res = await fetch('/assets/client.bundle.js', { cache: 'no-store' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      source = await res.text()
    } catch (e) {
      fail('Could not load the UI bundle.', 'Run `node src/build.js` in the plugin root, then reload. (' + e.message + ')')
      return
    }

    let plugin
    try {
      plugin = new Function('React', 'styles', 'host', source)(window.React, styles, host)
      plugin.apply(ctx)
    } catch (e) {
      fail('The UI bundle failed to initialise.', String(e && e.stack ? e.stack : e))
      return
    }

    const Section = ctx.slots.component
    if (!Section) {
      fail('The UI bundle did not register a settings section.')
      return
    }
    const root = window.ReactDOM.createRoot(rootEl)
    root.render(window.React.createElement(Section, {}))
  }

  boot()
})()
