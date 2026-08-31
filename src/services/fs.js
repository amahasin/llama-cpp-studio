// services/fs.js — the harness `fs` service, backed by node:fs.
//
// The plugin's host modules only use resolve/readText/writeText/stat, and they
// always hand back the object resolve() returned.
//
// Reads and stats go anywhere: a model imported by reference lives wherever the
// user keeps it, and the relocation repair has to ask whether a directory on
// another drive still exists. Writes are fenced to the data directory plus
// whatever the user pointed a managed directory at on purpose — everything this
// service writes (config.json, the metadata registries, per-model settings, the
// helper PowerShell scripts, log files) is the app's own bookkeeping and
// belongs inside the folder it runs from. Without the fence a single stale path
// in config.json silently rebuilds the whole tree wherever it points.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { norm, isInside } = require('../lib/fsx.js')

/** The path a target object names, whichever field it carries it in. */
function nativePathOf(target) {
  return target.nativePath || target.targetKey
}

/**
 * options: { writeRoots }  — absolute directories writes are confined to.
 * An empty list disables the fence (used by tooling that has no data dir yet).
 */
function createFsService(options) {
  const opts = options || {}
  const writeRoots = (opts.writeRoots || []).map(function (r) { return path.resolve(r) })

  function writable(target) {
    if (writeRoots.length === 0) return true
    return writeRoots.some(function (root) { return isInside(target, root) })
  }

  return {
    writeRoots,
    /**
     * Open the fence for a directory the user just chose. The roots are worked
     * out from config.json at boot, so a directory pointed outside the data
     * directory from the Settings page would otherwise stay unwritable until
     * the next start.
     */
    allowWrite(dir) {
      if (typeof dir !== 'string' || dir.trim() === '') return
      const target = dir.trim()
      if (writeRoots.some(function (root) { return isInside(target, root) })) return
      writeRoots.push(path.resolve(target))
    },
    async resolve(p) {
      const target = path.resolve(String(p))
      return { targetKey: norm(target), displayPath: target, nativePath: target }
    },
    async readText(target) {
      return fs.readFileSync(nativePathOf(target), 'utf8')
    },
    async writeText(target, text) {
      const file = nativePathOf(target)
      if (!writable(file)) {
        throw new Error('refusing to write outside the data directory: ' + file
          + ' (allowed: ' + writeRoots.join(', ') + ')')
      }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
    },
    async stat(target) {
      try {
        const s = fs.statSync(nativePathOf(target))
        return { size: s.size, isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs }
      } catch (_e) {
        return undefined
      }
    },
  }
}

module.exports = { createFsService }
