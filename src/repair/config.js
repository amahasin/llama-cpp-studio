// repair/config.js — the seven managed directories in config.json.
//
// The same rule the app applies on every load: a directory the user chose stays
// where it points unless `--all` says otherwise; everything else belongs under
// `home`.
'use strict'

const path = require('node:path')

const { readJson } = require('../lib/fsx.js')

/**
 * options: { home, metaDir, all, LLAMA }
 * Returns { changes, unresolved, writes, moved, kept, note }, where `moved`
 * records the old and new location of each rebased directory so the metadata
 * repairs below can re-point their own paths by prefix rather than by guesswork.
 */
function repairConfig(options) {
  const { home, all, LLAMA } = options
  const cfg = LLAMA.config
  const file = path.join(home, 'config.json')
  const config = readJson(file)

  const result = { changes: [], unresolved: [], writes: [], moved: {}, kept: [], note: undefined }

  if (config === undefined) {
    result.note = '  config.json: absent or unreadable — the app will write a fresh one'
    return result
  }

  const stored = config.paths && typeof config.paths === 'object' ? config.paths : {}
  const custom = all
    ? []
    : (Array.isArray(config.customPaths) ? config.customPaths : cfg.inferCustomPaths(stored))
  const homed = cfg.applyHome(stored, custom, home)

  for (const entry of homed.rebased) {
    result.changes.push('  ' + entry.key + ':\n      ' + entry.from + '\n   -> ' + entry.to)
    result.moved[entry.key] = entry
  }

  if (homed.rebased.length > 0) {
    config.paths = homed.paths
    config.customPaths = cfg.customPathsOf(homed.paths, home)
    result.writes.push([file, config])
  }

  result.kept = homed.custom.filter(function (key) { return cfg.PATH_LEAVES[key] !== undefined })
  return result
}

module.exports = { repairConfig }
