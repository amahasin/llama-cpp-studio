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
  ['smoke.js', 'boots the real app and drives it over RPC'],
  ['paths.test.js', 'the folder stays self-contained when it moves'],
  ['vision.test.js', 'the per-model vision toggle, end to end'],
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
