// build.js — prepares the standalone app for running:
//   1. rebuilds the plugin bundles (the UI is served straight from dist/)
//   2. vendors React + ReactDOM UMD into web/vendor/
//
// Both steps read the plugin repository this app is built from, so both are
// skipped once the folder is self-contained: pack.js has already copied the
// host modules, the UI bundle and React into it, and a packed folder that was
// then moved elsewhere must never go looking for a plugin beside it. start.cmd
// runs this on first launch, so it has to be a no-op there rather than a crash
// on a path that belongs to another machine.
//
// Usage: node build.js [--react <dir containing react/react-dom>] [--force]
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const {
  PLUGIN_ROOT, VENDOR_DIR, PLUGIN_BUILD_SCRIPT, REACT_UMD,
  SELF_CONTAINED, hasPluginBuildScript,
} = require('./src/lib/layout.js')
const { copyFile } = require('./src/lib/fsx.js')

const VENDOR_README = [
  '# Vendored third-party files',
  '',
  '`react.production.min.js` and `react-dom.production.min.js` are the React 18 UMD',
  'builds (MIT licence, Copyright (c) Meta Platforms, Inc. and affiliates), copied',
  'here by `standalone/build.js` so the app runs without a package install.',
  '',
].join('\n')

/** Where React UMD builds may live, newest layout first. */
function reactCandidates(explicit) {
  const roots = []
  if (explicit) roots.push(explicit)
  // The plugin lives inside the harness repo, which already ships React.
  const repo = path.resolve(PLUGIN_ROOT, '..', '..')
  roots.push(path.join(repo, 'node_modules'))
  roots.push(path.join(repo, 'node_modules', '.pnpm'))
  roots.push(path.join(PLUGIN_ROOT, 'node_modules'))
  return roots
}

function findFile(root, relParts) {
  const direct = path.join(root, ...relParts)
  if (fs.existsSync(direct)) return direct
  // pnpm store: node_modules/.pnpm/react@18.3.1/node_modules/react/umd/...
  if (!fs.existsSync(root)) return undefined
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (_e) {
    return undefined
  }
  const prefix = relParts[0].split('/')[0] + '@'
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    const nested = path.join(root, entry.name, 'node_modules', ...relParts)
    if (fs.existsSync(nested)) return nested
  }
  return undefined
}

function missingVendorFiles() {
  return REACT_UMD
    .map(function (item) { return item.name })
    .filter(function (name) { return !fs.existsSync(path.join(VENDOR_DIR, name)) })
}

function vendorReact(explicit, force) {
  fs.mkdirSync(VENDOR_DIR, { recursive: true })
  const missing = []

  for (const item of REACT_UMD) {
    const target = path.join(VENDOR_DIR, item.name)
    if (fs.existsSync(target) && !force) {
      console.log('vendor: ' + item.name + ' (already present)')
      continue
    }
    let found
    for (const root of reactCandidates(explicit)) {
      found = findFile(root, item.parts)
      if (found) break
    }
    if (!found) { missing.push(item.name); continue }
    copyFile(found, target)
    console.log('vendor: ' + item.name + ' <- ' + found)
  }

  if (missing.length > 0) {
    console.error('\nCould not find: ' + missing.join(', '))
    console.error('Pass --react <dir> pointing at a node_modules folder that has react and react-dom (v18 UMD builds).')
    process.exitCode = 1
  }
  fs.writeFileSync(path.join(VENDOR_DIR, 'README.md'), VENDOR_README)
}

function buildPluginBundles() {
  console.log('plugin: node src/build.js')
  const out = execFileSync(process.execPath, [PLUGIN_BUILD_SCRIPT], { cwd: PLUGIN_ROOT, encoding: 'utf8' })
  process.stdout.write(out.split('\n').map(function (l) { return l ? '  ' + l : l }).join('\n'))
}

/** A packed folder that was moved away from its plugin: nothing left to build. */
function reportPacked() {
  const missing = missingVendorFiles()
  if (missing.length === 0) {
    console.log('this folder is already self-contained — nothing to build')
    console.log('start it with:  start.cmd')
    return
  }
  console.error('this folder is self-contained but web/vendor is missing: ' + missing.join(', '))
  console.error('re-run `node pack.js` where the plugin sources are, or pass --react <dir>')
  console.error('pointing at a node_modules folder that has the React 18 UMD builds.')
  process.exitCode = 1
}

function main() {
  const idx = process.argv.indexOf('--react')
  const explicit = idx !== -1 ? path.resolve(process.argv[idx + 1]) : undefined
  const hasPlugin = hasPluginBuildScript()

  if (SELF_CONTAINED && !hasPlugin) {
    reportPacked()
    return
  }

  if (hasPlugin) buildPluginBundles()
  else console.log('no plugin sources at ' + PLUGIN_ROOT + ' — skipping the bundle build')

  vendorReact(explicit, process.argv.includes('--force'))
  console.log('\nready — start with:  node src/main.js')
}

main()
