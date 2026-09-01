// tests/bundle.test.js — the vendored UI still carries this app's fixes.
//
// runtime/client.bundle.js is built elsewhere and copied in by pack.js, which
// overwrites it wholesale. Three fixes live inside it (see
// tools/patch-client-bundle.js and runtime/host/VENDORED.md), and a re-pack
// silently reverts all three. This suite is what makes that loud.
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { APP_ROOT, createChecker } = require('./helpers.js')

const { check, finish } = createChecker()

// The last bundle in this repo's history that carries none of these patches.
// pack.js restores something like it, so this is what the patcher has to be
// able to start from.
const PRISTINE_REV = '91db310'
const PRISTINE_PATH = 'runtime/client.bundle.js'

/**
 * The patcher can rebuild the shipped bundle from a pristine one.
 *
 * This is the workflow the file exists for — pack.js overwrites the bundle,
 * `npm run patch-ui` puts the fixes back — and it had quietly stopped working:
 * three patches had been written against an already-patched bundle, so their
 * `find` could never match what pack.js actually restores. Everything looked
 * fine, because re-running the patcher on a tree that already carried them
 * reported them present and did nothing.
 *
 * Byte-equality is the assertion: applying every patch to the pristine bundle
 * has to produce exactly the bundle that ships.
 */
function rebuildSection() {
  const shown = spawnSync('git', ['show', PRISTINE_REV + ':' + PRISTINE_PATH],
    { encoding: 'utf8', cwd: APP_ROOT, maxBuffer: 64 * 1024 * 1024 })
  if (shown.status !== 0 || !shown.stdout) {
    console.log('  — skipped the pristine rebuild: git could not read '
      + PRISTINE_REV + ':' + PRISTINE_PATH)
    return
  }

  const shipped = fs.readFileSync(path.join(APP_ROOT, PRISTINE_PATH), 'utf8')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-bundle-'))
  const target = path.join(APP_ROOT, PRISTINE_PATH)
  const keep = path.join(scratch, 'shipped.js')
  fs.writeFileSync(keep, shipped)

  try {
    fs.writeFileSync(target, shown.stdout)
    const rebuild = spawnSync(process.execPath,
      [path.join(APP_ROOT, 'tools', 'patch-client-bundle.js')],
      { encoding: 'utf8', cwd: APP_ROOT })
    const out = (rebuild.stdout || '') + (rebuild.stderr || '')
    check('every patch applies to a pristine bundle', rebuild.status === 0 && !/FAILED/.test(out),
      '\n' + out.trim().split('\n').filter(function (l) { return /FAILED|refusing/.test(l) })
        .map(function (l) { return '      ' + l }).join('\n'))
    const rebuilt = fs.readFileSync(target, 'utf8')
    check('and rebuilds the shipped bundle exactly', rebuilt === shipped,
      'rebuilt ' + rebuilt.length + ' bytes, shipped ' + shipped.length)
  } finally {
    // Whatever happened, the working tree gets its bundle back.
    fs.writeFileSync(target, shipped)
    try { fs.rmSync(scratch, { recursive: true, force: true }) } catch (_e) { /* best effort */ }
  }
}

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
  check('and generated',
    /present: api-key-generate-fn/.test(output) && /present: api-key-generate-button/.test(output))
  check('copying works on a non-secure origin too',
    /present: copy-fallback/.test(output))
  check('network and server flags are in a single card',
    /present: server-flags-single-card/.test(output))
  check('the behaviour settings are one card in two columns',
    /present: behaviour-single-card/.test(output))
  check('the llama.cpp build card is regrouped',
    /present: runtime-card-reorganized/.test(output))
  check('the chat frame opens on the model that is loaded',
    /present: chat-frame-follows-loaded-model/.test(output))
  check('a warning on a successful command is shown',
    /present: toast-warnings/.test(output)
    && /present: act-reports-warnings/.test(output)
    && /present: start-reports-warnings/.test(output))

  rebuildSection()
  return finish('bundle.test.js')
}

process.exit(main())
