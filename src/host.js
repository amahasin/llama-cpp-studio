// host.js — loads the plugin's host modules (the exact files the harness
// mounts) and builds a Manager wired to the standalone services.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const layout = require('./lib/layout.js')
const { isInside, norm } = require('./lib/fsx.js')
const { createFsService } = require('./services/fs.js')
const { createSubprocessService } = require('./services/subprocess.js')
const { createTimerService } = require('./services/timer.js')

const { HOST_MODULES, HOST_DIR } = layout

/**
 * Evaluate the host modules in order. They are plain scripts with no imports
 * that attach themselves to globalThis.LLAMA, which is also how the harness
 * loads them — the two halves stay identical by running the very same files.
 */
function loadHostModules() {
  if (globalThis.LLAMA && globalThis.LLAMA.api) return globalThis.LLAMA
  for (const name of HOST_MODULES) {
    const code = fs.readFileSync(path.join(HOST_DIR, name), 'utf8')
    ;(0, eval)(code)
  }
  if (!globalThis.LLAMA || !globalThis.LLAMA.api) {
    throw new Error('host modules loaded but LLAMA.api is missing')
  }
  return globalThis.LLAMA
}

/**
 * Where the app is allowed to write: the data directory, plus any managed
 * directory the user deliberately pointed somewhere else.
 *
 * Read from the config.json that is about to be loaded, through the same rule
 * the store itself applies — a directory left over from wherever this folder
 * used to live is about to be put back under `dataDir`, so it must not open a
 * hole in the fence on the way through. Only the ones recorded in
 * `customPaths`, which the store writes when the user saves a directory that is
 * not the default one, are allowed out.
 */
function resolveWriteRoots(dataDir, LLAMA) {
  const roots = [dataDir]
  let stored
  try {
    stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'))
  } catch (_e) {
    return roots // first run, or unreadable: the defaults all live under dataDir
  }
  if (!stored || typeof stored.paths !== 'object' || stored.paths === null) return roots

  const cfg = LLAMA.config
  const custom = Array.isArray(stored.customPaths)
    ? stored.customPaths
    : cfg.inferCustomPaths(stored.paths)
  const paths = cfg.applyHome(stored.paths, custom, norm(dataDir)).paths

  for (const key of Object.keys(cfg.PATH_LEAVES)) {
    const value = paths[key]
    if (typeof value !== 'string' || value.trim() === '') continue
    const dir = path.resolve(value.trim())
    if (roots.some(function (root) { return isInside(dir, root) })) continue
    roots.push(dir)
  }
  return roots
}

/**
 * Create (and initialize) the manager.
 * options: { dataDir, log(message) }
 */
async function createManager(options) {
  const opts = options || {}
  const dataDir = path.resolve(opts.dataDir)
  fs.mkdirSync(dataDir, { recursive: true })

  const LLAMA = loadHostModules()
  const log = opts.log || function () {}
  const home = norm(dataDir)

  const fsService = createFsService({
    // Reads go anywhere (models imported by reference live wherever the user
    // keeps them); writes stay inside the folder unless the user said otherwise.
    writeRoots: resolveWriteRoots(dataDir, LLAMA),
  })
  const subprocess = createSubprocessService({ log })
  const timer = createTimerService()

  const manager = new LLAMA.api.Manager({
    fs: fsService, subprocess, timer, log,
    home,
    workspaceRoot: home,
  })
  await manager.init()

  manager.shutdown = async function () {
    try { await manager.dispose() } catch (_e) { /* noop */ }
    subprocess.terminateAll()
    timer.disposeAll()
  }
  return { LLAMA, manager, dataDir, services: { fs: fsService, subprocess, timer } }
}

module.exports = {
  createManager, loadHostModules, resolveWriteRoots,
  HOST_MODULES,
  APP_ROOT: layout.APP_ROOT,
  PLUGIN_ROOT: layout.PLUGIN_ROOT,
  HOST_DIR: layout.HOST_DIR,
  DEFAULT_DATA_DIR: layout.DEFAULT_DATA_DIR,
  INSIDE_PLUGIN: layout.INSIDE_PLUGIN,
  SELF_CONTAINED: layout.SELF_CONTAINED,
}
