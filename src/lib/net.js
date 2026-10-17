// lib/net.js — bind addresses: which ones mean "every interface", and how to
// turn one into an address something can actually connect to.
//
// A server bound to 0.0.0.0 or :: listens everywhere, but neither is a place to
// connect *to*: `http://0.0.0.0:8770/` is what the banner printed, the browser
// was pointed at and the desktop shell was handed, and current browsers refuse
// it. And an IPv6 literal needs brackets before it can sit in a URL at all —
// `http://::1:8770/` is not one.
'use strict'

const os = require('node:os')

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', ''])

/** Whether `host` binds every interface rather than naming one. */
function isWildcardHost(host) {
  return host === undefined || host === null || WILDCARD_HOSTS.has(String(host))
}

/** Where to connect to reach a server bound to `host`. */
function dialHost(host) {
  return isWildcardHost(host) ? '127.0.0.1' : String(host)
}

/** `host` as it is written in a URL or a Host header: IPv6 in brackets. */
function urlHost(host) {
  const h = dialHost(host)
  return h.indexOf(':') !== -1 && !h.startsWith('[') ? '[' + h + ']' : h
}

/** The URL this machine opens to reach a server bound to `host`. */
function localUrl(host, port) {
  return 'http://' + urlHost(host) + ':' + port + '/'
}

/**
 * The URLs other devices on the network can use, for a wildcard bind — the
 * addresses a phone on the same Wi-Fi would type. IPv4 only: that is what
 * people read off a screen and type, and every LAN has it.
 *
 * `interfaces` defaults to the machine's own; the tests pass a fixed table.
 */
function networkUrls(host, port, interfaces) {
  if (!isWildcardHost(host)) return []
  const table = interfaces || os.networkInterfaces()
  const out = []
  for (const name of Object.keys(table)) {
    for (const addr of table[name] || []) {
      const family = addr.family === 4 ? 'IPv4' : addr.family
      if (family !== 'IPv4' || addr.internal) continue
      // 169.254/16 is what Windows assigns an adapter that found no network.
      if (String(addr.address).startsWith('169.254.')) continue
      out.push('http://' + addr.address + ':' + port + '/')
    }
  }
  return out
}

module.exports = { WILDCARD_HOSTS, isWildcardHost, dialHost, urlHost, localUrl, networkUrls }
