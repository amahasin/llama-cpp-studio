// lib/settings.js — the llama-server settings, read the one way every caller
// wants them.
//
// Seven places read `manager.config.get('server')`: the CSP, the gate, the
// proxy (twice), the origin policy and the boot sequence (twice). Each wrapped
// it in its own guard, and they did not agree on what an unreadable config
// gives back — undefined in some, {} in others, a throw in one. They all want
// the same thing: whatever is saved right now, or nothing.
'use strict'

/**
 * The `server` section of config.json, or {} when there is no manager, no
 * config store, or reading it throws.
 *
 * Read on every call and never cached: that is what lets a change saved in
 * Server Config reach the gate, the proxy and the idle supervisor without a
 * restart.
 */
function serverSettings(manager) {
  try {
    const cfg = manager && manager.config ? manager.config.get('server') : undefined
    return cfg !== null && typeof cfg === 'object' ? cfg : {}
  } catch (_e) {
    return {}
  }
}

/** The API key, or undefined when none is set. */
function apiKeyOf(manager) {
  const key = serverSettings(manager).apiKey
  return typeof key === 'string' && key !== '' ? key : undefined
}

module.exports = { serverSettings, apiKeyOf }
