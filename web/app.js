// app.js — the standalone shell.
//
// It provides exactly what the plugin's client half expects from the harness —
// a `styles` service, a `host.call` RPC channel and a Cordis-ish `ctx` with
// timer + slots — then mounts the plugin's own UI. The plugin bundle is used
// unmodified, so the app and the harness plugin always look and behave alike.
(function () {
  'use strict'

  // Carried on <body> rather than in an inline <script>, so the page's
  // Content-Security-Policy does not have to allow inline script at all.
  const TOKEN = document.body.dataset.llamaToken
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

  // ---------- mobile navigation drawer ----------
  //
  // Below 860px the sidebar is taken out of the flow and slid off-canvas (see
  // mobile.css). Something has to bring it back, and the sidebar itself is
  // rendered by the plugin bundle — so the button and the scrim are added
  // here, around it, rather than inside it.

  const MENU_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
    + ' stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/>'
    + '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>'

  function installNavDrawer() {
    if (document.querySelector('.llama-navbtn')) return true
    if (!document.querySelector('.llama-app')) return false

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'llama-navbtn'
    button.setAttribute('aria-label', 'Menu')
    button.setAttribute('aria-expanded', 'false')
    button.innerHTML = MENU_SVG

    const scrim = document.createElement('button')
    scrim.type = 'button'
    scrim.className = 'llama-scrim'
    scrim.setAttribute('aria-label', 'Close menu')
    scrim.tabIndex = -1

    // The open/closed flag lives on <html>, and the two controls hang off
    // <body> — never inside .llama-app. React owns that subtree and rebuilds it
    // on every status poll, which quietly dropped both the attribute and the
    // elements a few seconds after they were added.
    function setOpen(open) {
      document.documentElement.setAttribute('data-llama-nav', open ? 'open' : 'closed')
      button.setAttribute('aria-expanded', open ? 'true' : 'false')
    }
    function isOpen() {
      return document.documentElement.getAttribute('data-llama-nav') === 'open'
    }
    setOpen(false)

    button.addEventListener('click', function () { setOpen(!isOpen()) })
    scrim.addEventListener('click', function () { setOpen(false) })
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false)
    })
    // Choosing a page is the end of using the menu. Delegated from the
    // document, so it keeps working across re-renders of the sidebar.
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.llama-sidebar-item')) setOpen(false)
    })
    // Rotating to landscape can cross the breakpoint with the drawer open,
    // which would otherwise leave a scrim over a sidebar that is back in flow.
    window.matchMedia('(max-width: 860px)').addEventListener('change', function (m) {
      if (!m.matches) setOpen(false)
    })

    document.body.appendChild(scrim)
    document.body.appendChild(button)
    return true
  }

  // .llama-app appears only once React has rendered.
  function watchForApp() {
    if (installNavDrawer()) return
    const observer = new MutationObserver(function () {
      if (installNavDrawer()) observer.disconnect()
    })
    observer.observe(rootEl, { childList: true, subtree: true })
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
    // After the plugin's own stylesheet, so these overrides win: the base CSS
    // uses !important throughout and load order alone would not settle it.
    const mobile = document.createElement('link')
    mobile.rel = 'stylesheet'
    mobile.href = '/assets/mobile.css'
    document.head.appendChild(mobile)

    const root = window.ReactDOM.createRoot(rootEl)
    root.render(window.React.createElement(Section, {}))
    watchForApp()
  }

  boot()
})()
