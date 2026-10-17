// tests/run-all.js — run every suite, and say which ones failed.
//
// `npm test` chained the suites with && , which stopped at the first failure
// and reported nothing about the rest. Six suites is enough that seeing all of
// them is worth one extra file.
'use strict'

const path = require('node:path')
const { spawnSync } = require('node:child_process')

// Cheapest and most specific first: a unit failure explains an integration
// failure far more often than the other way round.
const SUITES = [
  ['units.test.js', 'the pure modules: gguf, validators, asset scoring, argv'],
  ['bundle.test.js', 'the vendored UI still carries this app’s fixes'],
  ['secrets.test.js', 'API key and GitHub token redaction, and the save round-trip'],
  ['proxy.test.js', 'llama-server reached through this origin, with the session gate'],
  ['gate.test.js', 'the API key is the front door when Studio is not reached locally'],
  ['http.test.js', 'CORS on a wildcard bind, asset caching, CLI validation, URLs'],
  ['tray.test.js', 'the system tray reports the real server state, not a fixed one'],
  ['update.test.js', 'tray updates are verified before they run; start with Windows'],
  ['release.test.js', 'a release ships the app and nothing else, and the installer compiles'],
  ['idle.test.js', 'an unused model gives its memory back, a busy one never does'],
  ['mtp.test.js', 'multi-token-prediction heads: detection, tagging and the argv'],
  ['progress.test.js', 'the load fraction the router streams, weighted across stages'],
  ['preset.test.js', 'changed launch flags reach a router that is already running'],
  ['staleness.test.js', 'a change reaches everything that had cached the old answer'],
  ['smoke.js', 'boots the real app and drives it over RPC'],
  ['paths.test.js', 'the folder stays self-contained when it moves'],
  ['vision.test.js', 'the per-model vision toggle, end to end'],
  ['cluster.test.js', 'GPU cluster nodes, RPC flags, security and VRAM scaling'],
  ['router.test.js', 'router mode: presets, model ids, load/unload'],
]

function main() {
  const results = []
  for (const [file, description] of SUITES) {
    console.log('\n' + '─'.repeat(70))
    console.log('▶ ' + file + ' — ' + description)
    console.log('─'.repeat(70))
    const run = spawnSync(process.execPath, [path.join(__dirname, file)], {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
    })
    results.push({ file, code: run.status === null ? 1 : run.status })
  }

  const failed = results.filter(function (r) { return r.code !== 0 })
  console.log('\n' + '═'.repeat(70))
  for (const r of results) {
    console.log((r.code === 0 ? '  PASS  ' : '  FAIL  ') + r.file)
  }
  console.log('═'.repeat(70))
  if (failed.length === 0) {
    console.log(results.length + ' suites passed.')
    return 0
  }
  console.log(failed.length + ' of ' + results.length + ' suites failed: '
    + failed.map(function (r) { return r.file }).join(', '))
  return 1
}

process.exit(main())
