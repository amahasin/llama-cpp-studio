// tests/router.test.js — router mode.
//
// In router mode llama-server is handed the whole library at once and spawns a
// child server per model on demand, driven by an INI preset file. What has to
// hold: every registered model reaches that file, each section carries the same
// flags the model would have been launched with on its own (so Model settings
// keep meaning what they say), and the things that belong to the listening
// server — the API key, the port — stay on the router rather than being copied
// into every child.
//
// The planning checks run against a stub build. If a real llama.cpp with router
// support is installed in this folder, the last section starts it for real and
// drives the router's own API; otherwise it says it skipped.
//
// Usage: node tests/router.test.js
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { createManager, loadHostModules } = require('../src/host.js')

const APP_ROOT = path.resolve(__dirname, '..')
const TMP = path.join(APP_ROOT, '.tmp', 'router-' + process.pid)
const PORT = 8781

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log('  ✓ ' + label)
  } else {
    failures += 1
    console.log('  ✗ ' + label + (detail === undefined ? '' : ' — ' + detail))
  }
}
function skip(label, why) {
  console.log('  – ' + label + (why ? ' — ' + why : ''))
}

function slash(p) {
  return String(p).replace(/\\/g, '/')
}

const MODEL_FLAGS = ['m', 'model', 'host', 'port', 'alias', 'c', 'ctx-size', 'ngl', 'n-gpu-layers',
  't', 'threads', 'b', 'batch-size', 'ub', 'ubatch-size', 'np', 'parallel',
  'fa', 'flash-attn', 'mmproj', 'metrics', 'jinja', 'seed', 'api-key', 'no-webui']
const ROUTER_FLAGS = ['models-dir', 'models-preset', 'models-max', 'models-autoload', 'no-models-autoload']

function capabilities(flags) {
  const caps = {}
  for (const f of flags) caps[f] = true
  return caps
}

/**
 * A real installed build that can do router mode, or undefined. The app's own
 * data directory is the only place one could be — this test never installs.
 */
function installedRouterBuild() {
  try {
    const meta = JSON.parse(fs.readFileSync(
      path.join(APP_ROOT, 'data', 'metadata', 'installed_versions.json'), 'utf8'))
    for (const entry of meta.versions || []) {
      if (!entry.capabilities || entry.capabilities['models-preset'] !== true) continue
      if (!fs.existsSync(entry.exePath)) continue
      return entry
    }
  } catch (_e) { /* no installation here */ }
  return undefined
}

function seed(versionEntry) {
  const lib = path.join(TMP, 'library')
  fs.mkdirSync(lib, { recursive: true })
  fs.mkdirSync(path.join(TMP, 'metadata'), { recursive: true })

  for (const name of ['alpha.gguf', 'beta-vision.gguf', 'mmproj-beta-vision-f16.gguf']) {
    fs.writeFileSync(path.join(lib, name), '')
  }

  fs.writeFileSync(path.join(TMP, 'metadata', 'installed_versions.json'),
    JSON.stringify({ versions: [versionEntry] }, null, 2))

  function model(id, name, extra) {
    return Object.assign({
      id, name,
      path: slash(path.join(lib, name)),
      managed: false, location: 'external', sizeBytes: 0,
      importedAt: '2026-01-01T00:00:00',
      metadata: { contextLength: 32768, blockCount: 32 },
      profiles: [], kind: 'model',
    }, extra || {})
  }

  fs.writeFileSync(path.join(TMP, 'metadata', 'models.json'), JSON.stringify({
    models: [
      model('model-alpha', 'alpha.gguf', { settings: { contextSize: 4096, seed: -1 } }),
      model('model-beta', 'beta-vision.gguf', {
        mmprojPath: slash(path.join(lib, 'mmproj-beta-vision-f16.gguf')),
        settings: { vision: false },
      }),
      // Registered but not on disk: it must be reported and left out, not
      // written into the preset for the router to choke on.
      model('model-gone', 'vanished.gguf'),
    ],
  }, null, 2))

  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
    version: 1,
    llamaCpp: { activeVersion: versionEntry.version },
    hardware: { backend: 'cpu' },
    server: { mode: 'router', port: PORT, routerModelsMax: 1, routerAutoload: false, apiKey: 'test-key' },
  }, null, 2))

  return { lib }
}

// Parse the generated INI back into { section: { key: value } }.
function parseIni(text) {
  const out = {}
  let current
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (line === '' || line.charAt(0) === '#' || line.charAt(0) === ';') continue
    if (line.charAt(0) === '[') { current = line.slice(1, -1); out[current] = {}; continue }
    const at = line.indexOf('=')
    if (at === -1 || current === undefined) continue
    out[current][line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

async function main() {
  console.log('llama.cpp Studio router mode')
  console.log('  scratch: ' + TMP)
  const LLAMA = loadHostModules()

  // ---- argv -> INI, the one lossy step ---------------------------------------
  {
    const ini = LLAMA.commandBuilder.argvToIni(
      ['--model', 'C:/m.gguf', '--jinja', '--seed', '-1', '--host', '1.2.3.4', '--port', '99', '--alias', 'x'])
    check('a value becomes key = value', ini.includes('model = C:/m.gguf'), ini.join(' | '))
    check('a bare flag becomes key = true', ini.includes('jinja = true'), ini.join(' | '))
    // `--seed -1` looks exactly like a flag followed by another flag.
    check('a negative number is a value, not the next flag', ini.includes('seed = -1'), ini.join(' | '))
    check('the flags the router supplies itself are dropped',
      !ini.some(function (l) { return /^(host|port|alias) /.test(l) }), ini.join(' | '))
  }

  const stub = {
    version: 'b-stub', backend: 'cpu', platform: 'windows', architecture: 'x64',
    installedAt: '2026-01-01T00:00:00',
    path: slash(path.join(TMP, 'bin')),
    exePath: slash(path.join(TMP, 'bin', 'llama-server.exe')),
    capabilities: capabilities(MODEL_FLAGS.concat(ROUTER_FLAGS)),
  }
  seed(stub)
  fs.mkdirSync(path.join(TMP, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'bin', 'llama-server.exe'), '')

  const booted = await createManager({ dataDir: TMP, log: function () {} })
  const manager = booted.manager
  try {
    // ---- the plan -------------------------------------------------------------
    const preview = await manager.cmd('server.routerPreview', {})
    check('a router launch can be planned', preview.ok === true, preview.message)
    if (preview.ok) {
      const argv = preview.argv
      check('llama-server is pointed at a preset file',
        argv.indexOf('--models-preset') !== -1
        && argv[argv.indexOf('--models-preset') + 1] === preview.presetPath, argv.join(' '))
      check('the preset lives inside the data directory',
        slash(preview.presetPath).toLowerCase().startsWith(slash(TMP).toLowerCase()), preview.presetPath)
      check('the load ceiling is passed',
        argv[argv.indexOf('--models-max') + 1] === '1', argv.join(' '))
      check('autoload off is passed', argv.indexOf('--no-models-autoload') !== -1, argv.join(' '))
      check('the API key is the router\u2019s, and it is set',
        argv[argv.indexOf('--api-key') + 1] === 'test-key', argv.join(' '))

      const ini = parseIni(preview.preset)
      const ids = Object.keys(ini)
      check('every present model has a section',
        ids.length === 2 && ids.includes('alpha') && ids.includes('beta-vision'), ids.join(', '))
      check('a model whose file is gone is left out, with a reason',
        !ids.includes('vanished')
        && (preview.warnings || []).some(function (w) { return w.includes('vanished.gguf') }),
        JSON.stringify(preview.warnings))

      check('each section points at its own model file',
        ini.alpha.model === slash(path.join(TMP, 'library', 'alpha.gguf')), ini.alpha.model)
      check('per-model settings reach the section', ini.alpha['ctx-size'] === '4096', ini.alpha['ctx-size'])
      check('a negative setting survives the round trip', ini.alpha.seed === '-1', ini.alpha.seed)
      check('vision off keeps the projector out of that model’s section',
        ini['beta-vision'] !== undefined && ini['beta-vision'].mmproj === undefined,
        JSON.stringify(ini['beta-vision']))
      check('the router\u2019s own address is not repeated per model',
        ini.alpha.host === undefined && ini.alpha.port === undefined && ini.alpha.alias === undefined,
        JSON.stringify(ini.alpha))
      check('the API key is not copied into every child',
        ini.alpha['api-key'] === undefined, JSON.stringify(ini.alpha))
    }

    // The projector has to come back when vision is on — otherwise the check
    // above only proves the section is empty for the wrong reason.
    await manager.cmd('models.saveSettings', { id: 'model-beta', settings: { vision: true } })
    const withVision = await manager.cmd('server.routerPreview', {})
    check('vision on puts the projector in that model\u2019s section',
      withVision.ok === true
      && parseIni(withVision.preset)['beta-vision'].mmproj
        === slash(path.join(TMP, 'library', 'mmproj-beta-vision-f16.gguf')),
      withVision.ok ? JSON.stringify(parseIni(withVision.preset)['beta-vision']) : withVision.message)

    // ---- a build that cannot do it -------------------------------------------
    {
      const old = Object.assign({}, stub, {
        version: 'b-old', capabilities: capabilities(MODEL_FLAGS),
      })
      fs.writeFileSync(path.join(TMP, 'metadata', 'installed_versions.json'),
        JSON.stringify({ versions: [old] }, null, 2))
      const refused = await manager.cmd('server.routerPreview', { version: 'b-old' })
      check('a build without router support is refused, not launched blind',
        refused.ok === false && refused.code === 'NO_ROUTER_SUPPORT', JSON.stringify(refused))
      fs.writeFileSync(path.join(TMP, 'metadata', 'installed_versions.json'),
        JSON.stringify({ versions: [stub] }, null, 2))
    }
  } finally {
    await manager.shutdown()
  }

  // ---- the real thing --------------------------------------------------------
  const real = installedRouterBuild()
  if (real === undefined) {
    skip('live router', 'no installed llama.cpp build with --models-preset in .\\data')
  } else {
    fs.writeFileSync(path.join(TMP, 'metadata', 'installed_versions.json'),
      JSON.stringify({ versions: [real] }, null, 2))
    const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8'))
    cfg.llamaCpp.activeVersion = real.version
    cfg.hardware.backend = 'auto'
    fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify(cfg, null, 2))

    const live = await createManager({ dataDir: TMP, log: function () {} })
    try {
      const started = await live.manager.cmd('server.start', {})
      check('the real router starts and answers /health', started.ok === true, started.message)
      if (started.ok) {
        const status = await live.manager.cmd('server.status', {})
        check('status reports router mode', status.server.mode === 'router', status.server.mode)

        const models = await live.manager.cmd('server.models', {})
        const ids = ((models.models) || []).map(function (m) { return m.id })
        check('the router serves the library it was given',
          models.ok === true && ids.includes('alpha') && ids.includes('beta-vision'), ids.join(', '))
        check('models it found on its own are marked as not ours',
          (models.models || []).every(function (m) {
            return m.managed === (m.id === 'alpha' || m.id === 'beta-vision')
          }), JSON.stringify(models.models))
        check('nothing is loaded yet, autoload being off',
          (models.models || []).filter(function (m) { return m.managed })
            .every(function (m) { return m.state === 'unloaded' }),
          JSON.stringify((models.models || []).map(function (m) { return m.id + '=' + m.state })))

        // These files are empty, so the load will fail — what is under test is
        // that the router accepts the instruction and moves the model off
        // "unloaded", not that a 0-byte GGUF can be served.
        const load = await live.manager.cmd('server.loadModel', { model: 'alpha' })
        check('a load can be requested through the manager', load.ok === true, load.message)
        const unload = await live.manager.cmd('server.unloadModel', { model: 'alpha' })
        check('and an unload', unload.ok === true, unload.message)

        const missing = await live.manager.cmd('server.loadModel', { model: 'not-a-model' })
        check('a model the router does not have is refused', missing.ok === false, JSON.stringify(missing))
      }
    } finally {
      await live.manager.cmd('server.stop', {}).catch(function () { /* noop */ })
      await live.manager.shutdown()
    }
  }

  console.log('')
  console.log(failures === 0 ? '  all checks passed' : '  ' + failures + ' check(s) failed')
  return failures === 0 ? 0 : 1
}

function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch (_e) { /* noop */ }
  try { fs.rmdirSync(path.join(APP_ROOT, '.tmp')) } catch (_e) { /* not empty */ }
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
