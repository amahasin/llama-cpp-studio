// tests/vision.test.js — vision can be turned off per model.
//
// A vision model ships a projector (mmproj-*.gguf) beside its weights, and the
// launch finds it three ways: a path saved in Model settings, the one recorded
// on the model, or a scan of the folder the model sits in. Turning vision off
// has to beat all three — clearing the path alone just hands the model straight
// back to detection — and the projector has to come back when it is turned on.
//
// Everything here is fabricated in a scratch directory: a stub llama-server so
// a launch can be planned, and empty .gguf files, since nothing is executed and
// no GGUF is parsed on the preview path.
//
// Usage: node tests/vision.test.js
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { createManager, loadHostModules } = require('../src/host.js')
const { cleanScratch } = require('./helpers.js')

const APP_ROOT = path.resolve(__dirname, '..')
const TMP = path.join(APP_ROOT, '.tmp', 'vision-' + process.pid)

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log('  ✓ ' + label)
  } else {
    failures += 1
    console.log('  ✗ ' + label + (detail === undefined ? '' : ' — ' + detail))
  }
}

function slash(p) {
  return String(p).replace(/\\/g, '/')
}

const MODEL_ID = 'model-vision-test'

// The flags the builder needs to emit a full command line for this profile.
const CAPABILITIES = {}
for (const flag of ['m', 'model', 'host', 'port', 'c', 'ctx-size', 'ngl', 'n-gpu-layers',
  't', 'threads', 'b', 'batch-size', 'ub', 'ubatch-size', 'np', 'parallel',
  'fa', 'flash-attn', 'mmproj', 'metrics', 'jinja']) {
  CAPABILITIES[flag] = true
}

function seed() {
  const bin = path.join(TMP, 'bin', 'b-test')
  const models = path.join(TMP, 'library')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(models, { recursive: true })
  fs.mkdirSync(path.join(TMP, 'metadata'), { recursive: true })

  fs.writeFileSync(path.join(bin, 'llama-server.exe'), '')
  fs.writeFileSync(path.join(models, 'demo.gguf'), '')
  fs.writeFileSync(path.join(models, 'mmproj-demo-f16.gguf'), '')

  fs.writeFileSync(path.join(TMP, 'metadata', 'installed_versions.json'), JSON.stringify({
    versions: [{
      version: 'b-test',
      backend: 'cpu',
      platform: 'windows',
      architecture: 'x64',
      installedAt: '2026-01-01T00:00:00',
      path: slash(bin),
      exePath: slash(path.join(bin, 'llama-server.exe')),
      cliPath: slash(path.join(bin, 'llama-cli.exe')),
      capabilities: CAPABILITIES,
    }],
  }, null, 2))

  // Registered by hand rather than through models.import, which parses the
  // GGUF header — this test is about the projector, not about the scanner.
  fs.writeFileSync(path.join(TMP, 'metadata', 'models.json'), JSON.stringify({
    models: [{
      id: MODEL_ID,
      name: 'demo.gguf',
      path: slash(path.join(models, 'demo.gguf')),
      managed: false,
      location: 'external',
      sizeBytes: 0,
      importedAt: '2026-01-01T00:00:00',
      metadata: {},
      profiles: [],
      kind: 'model',
    }],
  }, null, 2))

  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
    version: 1,
    llamaCpp: { activeVersion: 'b-test' },
    hardware: { backend: 'cpu' },
  }, null, 2))

  return {
    model: slash(path.join(models, 'demo.gguf')),
    projector: slash(path.join(models, 'mmproj-demo-f16.gguf')),
  }
}

// The value of --mmproj in a planned command line, or undefined when the flag
// is not there at all.
function mmprojArg(preview) {
  const argv = (preview && preview.argv) || []
  const at = argv.indexOf('--mmproj')
  return at === -1 ? undefined : argv[at + 1]
}

async function main() {
  console.log('llama.cpp Studio vision toggle')
  console.log('  scratch: ' + TMP)
  const files = seed()
  const LLAMA = loadHostModules()

  // ---- the profile field itself -------------------------------------------
  {
    const known = LLAMA.profiles.validateProfile({ vision: false })
    check('vision is a known profile field',
      known.ok === true && (known.warnings || []).length === 0,
      JSON.stringify(known))
    const wrong = LLAMA.profiles.validateProfile({ vision: 'no' })
    check('vision rejects a non-boolean', wrong.ok === false, JSON.stringify(wrong))
    check('vision defaults to on',
      LLAMA.profiles.defaultProfile({ metadata: {} }).vision === true)
  }

  const booted = await createManager({ dataDir: TMP, log: function () {} })
  const manager = booted.manager
  try {
    const plan = function (profile) {
      return manager.cmd('server.preview', { modelPath: files.model, profile })
    }

    // ---- detection, which is what "off" has to beat -------------------------
    {
      const on = await plan({})
      check('a projector beside the model is found and passed',
        on.ok === true && mmprojArg(on) === files.projector,
        on.ok ? String(mmprojArg(on)) : on.message)
    }

    // ---- off ----------------------------------------------------------------
    {
      const off = await plan({ vision: false })
      check('vision off drops the detected projector',
        off.ok === true && mmprojArg(off) === undefined,
        off.ok ? String(mmprojArg(off)) : off.message)
      check('and the rest of the command line is untouched',
        off.ok === true && off.argv.indexOf('--model') !== -1)

      const offWithPath = await plan({ vision: false, mmproj: files.projector })
      check('vision off outranks a projector chosen by hand',
        offWithPath.ok === true && mmprojArg(offWithPath) === undefined,
        offWithPath.ok ? String(mmprojArg(offWithPath)) : offWithPath.message)
    }

    // ---- back on ------------------------------------------------------------
    {
      const on = await plan({ vision: true, mmproj: files.projector })
      check('vision on uses the projector chosen by hand',
        on.ok === true && mmprojArg(on) === files.projector,
        on.ok ? String(mmprojArg(on)) : on.message)
    }

    // ---- it survives a round trip through the model's saved settings --------
    {
      const id = MODEL_ID
      const listed = await manager.cmd('models.list', {})
      check('the demo model is in the library',
        listed.ok === true && listed.models.some(function (m) { return m.id === id }),
        JSON.stringify((listed.models || []).map(function (m) { return m.id })))

      const saved = await manager.cmd('models.saveSettings', {
        id, settings: { vision: false },
      })
      check('vision off can be saved', saved.ok === true, saved.message)

      // `false` is not `undefined`: a store that drops falsy values would lose
      // this setting silently and quietly re-enable vision on the next launch.
      const read = await manager.cmd('models.settings', { id })
      check('vision off is persisted, not dropped as falsy',
        read.ok === true && read.settings.vision === false,
        JSON.stringify(read.settings))
      check('and reads back as off in the effective settings',
        read.ok === true && read.effective.vision === false,
        String(read.ok && read.effective.vision))

      const launched = await manager.cmd('server.preview', { modelId: id })
      check('a launch from the saved settings has no projector',
        launched.ok === true && mmprojArg(launched) === undefined,
        launched.ok ? String(mmprojArg(launched)) : launched.message)

      await manager.cmd('models.saveSettings', { id, settings: { vision: true } })
      const relaunched = await manager.cmd('server.preview', { modelId: id })
      check('turning it back on restores the projector',
        relaunched.ok === true && mmprojArg(relaunched) === files.projector,
        relaunched.ok ? String(mmprojArg(relaunched)) : relaunched.message)
    }
  } finally {
    await manager.shutdown()
  }

  console.log('')
  console.log(failures === 0 ? '  all checks passed' : '  ' + failures + ' check(s) failed')
  return failures === 0 ? 0 : 1
}

function cleanup() {
  // Was a silent try/catch that gave up after one attempt, which is how .tmp
  // came to hold a dozen orphaned scratch directories. cleanScratch waits the
  // lock out and says so when it genuinely cannot remove the tree.
  cleanScratch(TMP)
}

main()
  .then(function (code) {
    cleanup()
    process.exit(code)
  })
  .catch(function (err) {
    console.error(err && err.stack ? err.stack : err)
    cleanup()
    process.exit(1)
  })
