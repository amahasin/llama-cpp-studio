// lib/layout.js — where everything is, and which of the two layouts we are in.
//
// Four entry points (src/main.js, build.js, pack.js, repair-paths.js) each used
// to work this out for themselves, and drifted: the detection rule below is
// load-bearing — see the comment on SELF_CONTAINED — so it lives in one place.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const APP_ROOT = path.resolve(__dirname, '..', '..')
const PLUGIN_ROOT = path.resolve(APP_ROOT, '..')

const RUNTIME_DIR = path.join(APP_ROOT, 'runtime')
const WEB_DIR = path.join(APP_ROOT, 'web')
const VENDOR_DIR = path.join(WEB_DIR, 'vendor')

const BUNDLED_HOST_DIR = path.join(RUNTIME_DIR, 'host')
const PLUGIN_HOST_DIR = path.join(PLUGIN_ROOT, 'src', 'host')

// Two layouts are supported:
//   • packed    — `pack.js` copied the modules to ./runtime/host, so the folder
//                 is self-contained and can be moved anywhere on its own
//   • in-place  — the app sits inside the plugin and reads ../src/host
//
// A packed folder never consults its surroundings. Auto-detecting the plugin
// even when runtime/host is present is what let a moved app pick up whatever
// happened to sit next to it — including its data directory, which then landed
// one level above the folder instead of inside it.
const SELF_CONTAINED = fs.existsSync(path.join(BUNDLED_HOST_DIR, 'boot.js'))
const INSIDE_PLUGIN = !SELF_CONTAINED && fs.existsSync(path.join(PLUGIN_HOST_DIR, 'boot.js'))
const HOST_DIR = SELF_CONTAINED ? BUNDLED_HOST_DIR : PLUGIN_HOST_DIR

// Where a fresh installation keeps its data: its own data/ folder, which is
// what a self-contained folder always uses. Only an unpacked checkout sitting
// inside the plugin shares the plugin's directory, so both halves see the same
// builds and models.
const DEFAULT_DATA_DIR = INSIDE_PLUGIN ? PLUGIN_ROOT : path.join(APP_ROOT, 'data')

// The UI bundle comes from the packed copy. Only an unpacked checkout sitting
// inside the plugin falls back to the plugin's own dist/, so the two stay in
// sync while you develop; a self-contained folder never reads outside itself.
const BUNDLED_UI = path.join(RUNTIME_DIR, 'client.bundle.js')
const PLUGIN_UI = path.join(PLUGIN_ROOT, 'dist', 'client.bundle.js')

function clientBundlePath() {
  if (SELF_CONTAINED || fs.existsSync(BUNDLED_UI)) return BUNDLED_UI
  return PLUGIN_UI
}

// Whether the plugin repository this app is built from sits next to us. Both
// pack.js and build.js read these before reaching outside the folder — and they
// want different halves of it: pack.js copies the host modules, build.js runs
// the plugin's own bundler.
const PLUGIN_BUILD_SCRIPT = path.join(PLUGIN_ROOT, 'src', 'build.js')

function hasPluginSources() {
  return fs.existsSync(path.join(PLUGIN_HOST_DIR, 'boot.js'))
}

function hasPluginBuildScript() {
  return fs.existsSync(PLUGIN_BUILD_SCRIPT)
}

// Load order for the host modules; every one attaches to globalThis.LLAMA.
// Mirrors the list in runtime/host/loader.js, which is vendored from the plugin
// repository and must not be edited here — `pack.js` overwrites it wholesale.
const HOST_MODULES = [
  'boot.js',
  'modules/util.js',
  'modules/security.js',
  'modules/gguf.js',
  'modules/assetSelector.js',
  'modules/commandBuilder.js',
  'modules/config.js',
  'modules/exec.js',
  'modules/github.js',
  'modules/versions.js',
  'modules/hardware.js',
  'modules/logs.js',
  'modules/models.js',
  'modules/profiles.js',
  'modules/server.js',
  'modules/monitoring.js',
  'modules/diagnostics.js',
  'modules/api.js',
]

const REACT_UMD = [
  { name: 'react.production.min.js', parts: ['react', 'umd', 'react.production.min.js'] },
  { name: 'react-dom.production.min.js', parts: ['react-dom', 'umd', 'react-dom.production.min.js'] },
]

module.exports = {
  APP_ROOT, PLUGIN_ROOT, RUNTIME_DIR, WEB_DIR, VENDOR_DIR,
  BUNDLED_HOST_DIR, PLUGIN_HOST_DIR, HOST_DIR,
  BUNDLED_UI, PLUGIN_UI, clientBundlePath,
  SELF_CONTAINED, INSIDE_PLUGIN,
  PLUGIN_BUILD_SCRIPT, hasPluginSources, hasPluginBuildScript,
  DEFAULT_DATA_DIR, HOST_MODULES, REACT_UMD,
}
