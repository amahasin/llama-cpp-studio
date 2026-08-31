// repair/versions.js — installed_versions.json.
//
// A build travels inside <home>/bin/<version>, so its recorded paths are always
// derivable from the version tag; anything else means the build is simply not
// installed here any more.
'use strict'

const path = require('node:path')

const { norm, exists, readJson } = require('../lib/fsx.js')

function repairVersions(options) {
  const { home, metaDir } = options
  const file = path.join(metaDir, 'installed_versions.json')
  const versions = readJson(file)

  const result = { changes: [], unresolved: [], writes: [] }
  if (versions === undefined || !Array.isArray(versions.versions)) return result

  let touched = false
  for (const entry of versions.versions) {
    if (!entry || typeof entry.version !== 'string') continue
    const dir = home + '/bin/' + entry.version
    const exe = dir + '/llama-server.exe'
    if (norm(entry.exePath).toLowerCase() === exe.toLowerCase()) continue
    if (exists(entry.exePath)) continue

    if (!exists(exe)) {
      result.unresolved.push('  build ' + entry.version + ' is registered at ' + norm(entry.path)
        + ' but nothing is installed at ' + dir + ' — reinstall it from the Versions tab')
      continue
    }

    result.changes.push('  build ' + entry.version + ':\n      ' + norm(entry.path) + '\n   -> ' + dir)
    entry.path = dir
    entry.exePath = exe
    entry.cliPath = dir + '/llama-cli.exe'
    touched = true
  }

  if (touched) result.writes.push([file, versions])
  return result
}

module.exports = { repairVersions }
