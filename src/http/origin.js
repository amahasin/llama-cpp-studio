// http/origin.js — who is allowed to talk to the RPC route.
//
// The app binds a loopback address and mints a per-run token, but a user who
// exposes it deliberately (Settings › Allowed Remote Access Sites) needs the
// browser's CORS preflight to pass too. This is that allow-list, pulled out of
// the request handler: it was three closures rebuilt on every single request,
// and only one of them ever needed anything from that scope.
'use strict'

const RE_SPECIALS = /[.*+?^${}()|[\]\\]/g

function escapeRegExp(s) {
  return String(s).replace(RE_SPECIALS, '\\$&')
}

/** Match `value` against a rule in which `*` stands for any run of characters. */
function matchWildcard(value, rule) {
  const pattern = String(rule).split('*').map(escapeRegExp).join('.*')
  return new RegExp('^' + pattern + '$').test(value)
}

function splitPatterns(setting) {
  return String(setting)
    .split(',')
    .map(function (s) { return s.trim() })
    .filter(Boolean)
}

/** Whether one configured pattern admits this origin. */
function patternAdmits(pattern, url, originLower, originHost) {
  const lower = pattern.toLowerCase()
  if (pattern === '*' || lower === originLower || lower === originHost) return true

  if (pattern.startsWith('http://') || pattern.startsWith('https://')) {
    try {
      const configured = new URL(pattern)
      return configured.protocol === url.protocol
        && matchWildcard(originHost, configured.hostname.toLowerCase())
    } catch (_e) {
      return false // an unparseable rule admits nothing
    }
  }
  return matchWildcard(originHost, lower)
}

/**
 * options: { host, allowedOrigins() } — the bind address, and a getter for the
 * comma-separated setting (read per request, so a change in Settings takes
 * effect without a restart).
 * Returns { isAllowed(req) }.
 */
function createOriginPolicy(options) {
  const host = options.host
  const allowedOrigins = options.allowedOrigins || function () { return '' }

  function isLocal(url) {
    return url.hostname === host
      || url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || host === '0.0.0.0'
  }

  return {
    isAllowed(req) {
      const origin = req.headers.origin
      if (origin === undefined) return true // same-origin fetch omits it in some browsers

      let url
      try {
        url = new URL(origin)
      } catch (_e) {
        return false
      }
      if (isLocal(url)) return true

      const setting = String(allowedOrigins() || '').trim()
      if (setting === '*') return true
      if (setting === '') return false

      const originLower = origin.toLowerCase()
      const originHost = url.hostname.toLowerCase()
      return splitPatterns(setting).some(function (pattern) {
        return patternAdmits(pattern, url, originLower, originHost)
      })
    },
  }
}

module.exports = { createOriginPolicy, matchWildcard, escapeRegExp }
