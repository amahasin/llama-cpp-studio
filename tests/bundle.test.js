// tests/bundle.test.js — the vendored UI still carries this app's fixes.
//
// runtime/client.bundle.js is built elsewhere and copied in by pack.js, which
// overwrites it wholesale. Three fixes live inside it (see
// tools/patch-client-bundle.js and runtime/host/VENDORED.md), and a re-pack
// silently reverts all three. This suite is what makes that loud.
'use strict'

const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { APP_ROOT, createChecker } = require('./helpers.js')

const { check, finish } = createChecker()

function main() {
  console.log('llama.cpp Studio client bundle patches')

  const run = spawnSync(process.execPath,
    [path.join(APP_ROOT, 'tools', 'patch-client-bundle.js'), '--check'],
    { encoding: 'utf8', cwd: APP_ROOT })
  const output = (run.stdout || '') + (run.stderr || '')

  check('the patcher runs', run.status !== null, String(run.error))
  check('every patch is present in the shipped bundle', run.status === 0,
    '\n' + output.trim().split('\n').map(function (l) { return '      ' + l }).join('\n')
    + '\n      → run: node tools/patch-client-bundle.js')

  // Named individually so a failure says which behaviour went missing.
  check('the chat frame is same-origin (remote devices, and the clipboard)',
    /present: chat-iframe-same-origin/.test(output))
  check('"open in new tab" points at this origin too',
    /present: chat-open-in-new-tab/.test(output))
  check('the sidebar carries the app mark',
    /present: app-mark/.test(output))
  check('Server Config can set the idle unload timeout',
    /present: idle-unload-field/.test(output))
  check('download speed is shown in bytes, not tokens',
    /present: download-rate-units/.test(output) && /present: install-rate-units/.test(output))
  check('models that ship an MTP head are tagged',
    /present: mtp-pill/.test(output) && /present: mtp-pill-render/.test(output))
  check('and MTP can be turned off per model',
    /present: mtp-switch/.test(output))
  check('a loading model shows its progress',
    /present: loading-elapsed/.test(output))
  check('the access settings are one field per row',
    /present: access-single-column/.test(output) && /present: tls-single-column/.test(output))
  check('the API key can be shown and copied',
    /present: api-key-controls/.test(output) && /present: api-key-state/.test(output))
  check('copying works on a non-secure origin too',
    /present: copy-fallback/.test(output))
  check('network and server flags are in a single card',
    /present: server-flags-single-card/.test(output))

  return finish('bundle.test.js')
}

process.exit(main())
