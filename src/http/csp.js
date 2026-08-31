// http/csp.js — the Content-Security-Policy for the app shell.
//
// The page had none. Everything it loads is local, so this is hardening rather
// than a hole being closed — but `allowedOrigins` exists so people can expose
// this past loopback, and the session token lives in the DOM. A policy costs
// nothing and stops an injected string from becoming a script.
'use strict'

// The UI evaluates the plugin's client bundle with `new Function`, which is the
// whole architecture: the bundle is fetched from this origin and run against
// injected services. That needs 'unsafe-eval'. It does NOT need
// 'unsafe-inline' — the session token moved to a body attribute so no inline
// <script> has to be allowed, which is the directive that actually matters.
const BASE = {
  'default-src': ["'none'"],
  'script-src': ["'self'", "'unsafe-eval'"],
  // The plugin injects its stylesheet through a <style> element at runtime.
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
}

// The Chat tab embeds llama-server's own web UI, which is a different origin:
// same host, different port, or a public tunnel URL the user configured. Local
// addresses on any port are allowed outright, and the configured endpoint is
// added explicitly so a LAN bind or a tunnel keeps working.
// No IPv6 literal here: CSP's host-source grammar does not accept a bracketed
// address with a port wildcard, and browsers drop the whole directive value
// with a console warning when one appears. An IPv6 llama-server still works —
// its configured origin is added explicitly below.
const LOCAL_FRAMES = ['http://127.0.0.1:*', 'http://localhost:*']

function originOf(url) {
  try {
    return new URL(url).origin
  } catch (_e) {
    return undefined
  }
}

/** Frame sources beyond the local ones, from the llama-server settings. */
function configuredFrames(manager) {
  const out = []
  let cfg
  try {
    cfg = manager && manager.config ? manager.config.get('server') : undefined
  } catch (_e) {
    return out
  }
  if (!cfg) return out
  if (cfg.host && cfg.port) {
    const scheme = cfg.sslCertFile ? 'https' : 'http'
    const origin = originOf(scheme + '://' + cfg.host + ':' + cfg.port)
    if (origin !== undefined) out.push(origin)
  }
  const publicOrigin = cfg.publicUrl ? originOf(cfg.publicUrl) : undefined
  if (publicOrigin !== undefined) out.push(publicOrigin)
  return out
}

/** The policy string for one response. */
function contentSecurityPolicy(manager) {
  const frames = ["'self'"].concat(LOCAL_FRAMES, configuredFrames(manager))
  const directives = Object.assign({}, BASE, { 'frame-src': frames })
  return Object.keys(directives)
    .map(function (name) { return name + ' ' + directives[name].join(' ') })
    .join('; ')
}

module.exports = { contentSecurityPolicy, LOCAL_FRAMES }
