// tests/staleness.test.js — a change reaches everything that cached the old
// answer.
//
// Three things in this app hold a view of state that something else can
// change: the running router holds the launch flags it read at startup, the
// update check holds a comparison against the build that was active when it
// ran, and a running llama-server holds the binary it launched with. Each was
// refreshed at some call sites and not others, and the symptom was always the
// same — the app confidently acting on something it already knew was stale:
//
//   • a model you had just downloaded was not routable until a restart
//   • a rescan that attached an MTP head did not change how the model launched
//   • "update available" stayed up after you installed the update
//
// The call sites are a table now (CHANGES_LIBRARY / CHANGES_BUILDS in api.js).
// What is tested here is that the table is wired to both effects, and that a
// command which changes nothing pays for nothing.
'use strict'

const { loadHostModules } = require('../src/host.js')
const { createChecker } = require('./helpers.js')

const LLAMA = loadHostModules()
const { check, finish } = createChecker()

/** A Manager with just the surface _afterChange touches. */
function managerWith(options) {
  const o = options || {}
  const calls = { refreshes: 0, logs: [] }
  const m = Object.create(LLAMA.api.Manager.prototype)
  m.server = {
    async refreshRouterPreset() {
      calls.refreshes += 1
      return o.refresh || { ok: true, refreshed: true }
    },
    status() {
      return o.running === undefined
        ? { state: 'STOPPED' }
        : { state: 'RUNNING', version: o.running }
    },
  }
  m.progressRing = []
  m.log = function (line) { calls.logs.push(line) }
  m._latestCache = { ok: true, updateAvailable: true }
  m._latestKey = 'auto'
  m._latestUntil = Date.now() + 300000
  return { m, calls }
}

async function librarySection() {
  // Everything that changes what a model is launched with has to reach the
  // router, which reads its preset once and never again.
  for (const method of ['models.import', 'models.download', 'models.delete', 'models.rescan',
    'models.saveSettings', 'models.resetSettings', 'models.addFlag']) {
    const { m, calls } = managerWith()
    const r = await m._afterChange(method, { ok: true })
    check(method + ' refreshes the running router', calls.refreshes === 1 && r.routerRefreshed === true,
      JSON.stringify({ refreshes: calls.refreshes, r }))
  }

  // Reading about the library changes nothing, and must not cost a refresh.
  for (const method of ['models.list', 'models.inspect', 'models.settings', 'status', 'server.logs']) {
    const { m, calls } = managerWith()
    await m._afterChange(method, { ok: true })
    check(method + ' leaves the router alone', calls.refreshes === 0)
  }

  // A command that failed changed nothing either.
  const { m, calls } = managerWith()
  const failed = await m._afterChange('models.download', { ok: false, code: 'HF_FILE_NOT_FOUND' })
  check('a failed command triggers nothing', calls.refreshes === 0 && failed.ok === false)
}

async function buildSection() {
  for (const method of ['versions.install', 'versions.activate', 'versions.remove']) {
    const { m } = managerWith()
    await m._afterChange(method, { ok: true, activeVersion: 'b2' })
    check(method + ' drops the cached update check',
      m._latestCache === undefined && m._latestUntil === 0, String(m._latestCache))
  }
  {
    // …and does not go asking the router about it: builds are not the library.
    const { m, calls } = managerWith()
    await m._afterChange('versions.activate', { ok: true, activeVersion: 'b2' })
    check('activating a build does not rewrite the router preset', calls.refreshes === 0)
  }

  // Activating a build does not move a server that is already running.
  {
    const { m } = managerWith({ running: 'b10714' })
    const r = await m._afterChange('versions.activate', { ok: true, activeVersion: 'b10729' })
    check('a running server on the old build is called out',
      (r.warnings || []).some(function (w) { return /b10714/.test(w) && /b10729/.test(w) }),
      JSON.stringify(r.warnings))
    check('  and the activation still succeeded', r.ok === true)
  }
  {
    const { m } = managerWith({ running: 'b10729' })
    const r = await m._afterChange('versions.activate', { ok: true, activeVersion: 'b10729' })
    check('a server already on that build says nothing', r.warnings === undefined, JSON.stringify(r.warnings))
  }
  {
    const { m } = managerWith()
    const r = await m._afterChange('versions.activate', { ok: true, activeVersion: 'b10729' })
    check('nor does a stopped one', r.warnings === undefined, JSON.stringify(r.warnings))
  }
}

function progressSection() {
  // The install emitter ticks about once a second for the whole transfer. Left
  // alone it wrote hundreds of identical lines and pushed the log's real
  // history out of the ring.
  const { m, calls } = managerWith()
  for (let i = 0; i < 40; i += 1) {
    m._progress('install', { stage: 'cuda-runtime', message: 'Downloading the CUDA runtime', percent: i })
  }
  const installLines = calls.logs.filter(function (l) { return l.indexOf('[install]') === 0 })
  check('a long install logs a line per 10%, not per tick',
    installLines.length === 4, installLines.length + ' lines: ' + JSON.stringify(installLines))

  // A new stage is news, and says so immediately.
  m._progress('install', { stage: 'extract', message: 'Extracting' })
  check('a change of stage is logged at once',
    calls.logs[calls.logs.length - 1] === '[install] Extracting', calls.logs[calls.logs.length - 1])

  // Every tick still reaches the progress ring the UI reads; only the log is
  // thinned, because only the log has to be read by a person.
  check('the progress ring keeps every tick', m.progressRing.length === 41, String(m.progressRing.length))
}

async function main() {
  console.log('llama.cpp Studio staleness after a change')
  await librarySection()
  await buildSection()
  progressSection()
  return finish('staleness.test.js')
}

main()
  .then(function (code) { process.exit(code) })
  .catch(function (err) {
    console.error(err && err.stack ? err.stack : err)
    process.exit(1)
  })
