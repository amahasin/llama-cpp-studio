// tests/paths.test.js — the folder stays self-contained when it moves.
//
// Every managed directory is stored in config.json as an absolute path, so a
// folder that is renamed, copied to another drive or carried to another PC
// arrives full of the previous machine's layout. What must happen then:
//
//   • the directories the user never chose are put back under this folder;
//   • the ones they did choose are left exactly where they point;
//   • nothing is written outside either way, even when a stale path survives.
//
// Usage: node tests/paths.test.js
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { createManager, loadHostModules, resolveWriteRoots } = require('../src/host.js')

const APP_ROOT = path.resolve(__dirname, '..')
const TMP = path.join(APP_ROOT, '.tmp', 'paths-' + process.pid)

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

function makeHome(name, config) {
  const dir = path.join(TMP, name)
  fs.mkdirSync(dir, { recursive: true })
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n')
  }
  return dir
}

// The fs service the ConfigStore talks to, minus the write fence: these tests
// are about what the store decides, not about what the fence then allows.
const PLAIN_FS = {
  async resolve(p) { return { nativePath: path.resolve(String(p)) } },
  async readText(t) { return fs.readFileSync(t.nativePath, 'utf8') },
  async writeText(t, text) {
    fs.mkdirSync(path.dirname(t.nativePath), { recursive: true })
    fs.writeFileSync(t.nativePath, text)
  },
  async stat(t) {
    try {
      const st = fs.statSync(t.nativePath)
      return { size: st.size, isDirectory: st.isDirectory(), mtimeMs: st.mtimeMs }
    } catch (_e) {
      return undefined
    }
  },
}

const DEAD = 'C:/Users/somebody-else/Desktop/standalone/data'

async function loadConfig(home) {
  const LLAMA = loadHostModules()
  const store = new LLAMA.config.ConfigStore({ fs: PLAIN_FS, home: slash(home) })
  await store.load()
  return store
}

async function main() {
  console.log('llama.cpp Studio path containment')
  console.log('  scratch: ' + TMP)
  const LLAMA = loadHostModules()
  const leaves = LLAMA.config.PATH_LEAVES
  const keys = Object.keys(leaves)

  // ---- 1. a folder carried from another machine ------------------------------
  {
    const stored = { version: 1, paths: {} }
    for (const key of keys) stored.paths[key] = DEAD + '/' + leaves[key]
    const home = makeHome('moved', stored)
    const store = await loadConfig(home)
    const paths = store.get('paths')
    check('every managed directory is put back under this folder',
      keys.every(function (k) { return paths[k] === slash(home) + '/' + leaves[k] }),
      JSON.stringify(paths))
    check('the repair is reported, not silent', store.relocations.length === keys.length,
      store.relocations.length + ' of ' + keys.length)
  }

  // ---- 2. the half-repaired folder that started all this ---------------------
  // Only four of the seven are settable from the UI, so a folder whose paths
  // were fixed by hand keeps naming the old machine for the other three — and
  // the old test, which judged the seven as one set, could never repair it.
  {
    const home = makeHome('half')
    const stored = { version: 1, paths: {} }
    for (const key of keys) {
      const ui = ['installDirectory', 'modelsDirectory', 'logsDirectory', 'cacheDirectory']
      stored.paths[key] = (ui.includes(key) ? slash(home) : DEAD) + '/' + leaves[key]
    }
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(stored, null, 2) + '\n')
    const paths = (await loadConfig(home)).get('paths')
    check('a half-repaired config repairs the rest',
      keys.every(function (k) { return paths[k] === slash(home) + '/' + leaves[k] }),
      JSON.stringify(paths))
  }

  // ---- 3. the leftovers the app recreated itself -----------------------------
  // Writing a helper script or a metadata file recreates the very directories a
  // "is the old home still there?" test was supposed to notice were gone. The
  // leftover must not be mistaken for a live home.
  {
    const ghostHome = path.join(TMP, 'ghost', 'data')
    fs.mkdirSync(path.join(ghostHome, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(ghostHome, 'scripts', 'port.ps1'), 'param()\n')
    const stored = { version: 1, paths: {} }
    for (const key of keys) stored.paths[key] = slash(ghostHome) + '/' + leaves[key]
    const home = makeHome('after-ghost', stored)
    const paths = (await loadConfig(home)).get('paths')
    check('a directory the app recreated elsewhere is still reclaimed',
      keys.every(function (k) { return paths[k] === slash(home) + '/' + leaves[k] }),
      JSON.stringify(paths))
  }

  // ---- 4. a directory the user chose is never touched ------------------------
  {
    const elsewhere = path.join(TMP, 'big-drive', 'gguf')
    const home = makeHome('custom')
    const first = await loadConfig(home)
    const saved = await first.update({ paths: { modelsDirectory: slash(elsewhere) } })
    check('a directory outside the folder can be set', saved.ok === true, JSON.stringify(saved))
    check('setting it records the intent',
      JSON.stringify(first.get('customPaths')) === JSON.stringify(['modelsDirectory']),
      JSON.stringify(first.get('customPaths')))

    // Now move that folder: same config.json, different home.
    const moved = makeHome('custom-moved')
    fs.copyFileSync(path.join(home, 'config.json'), path.join(moved, 'config.json'))
    const paths = (await loadConfig(moved)).get('paths')
    check('the chosen directory survives the move', paths.modelsDirectory === slash(elsewhere),
      paths.modelsDirectory)
    check('the others still follow the folder',
      keys.filter(function (k) { return k !== 'modelsDirectory' })
        .every(function (k) { return paths[k] === slash(moved) + '/' + leaves[k] }),
      JSON.stringify(paths))
  }

  // ---- 5. saving the Settings page does not pin the defaults -----------------
  // It always submits all four editable directories, changed or not.
  {
    const home = makeHome('settings-save')
    const store = await loadConfig(home)
    const current = store.get('paths')
    await store.update({
      server: { port: 9099 },
      paths: {
        installDirectory: current.installDirectory,
        modelsDirectory: current.modelsDirectory,
        logsDirectory: current.logsDirectory,
        cacheDirectory: current.cacheDirectory,
      },
    })
    check('resubmitting unchanged directories records no intent',
      store.get('customPaths').length === 0, JSON.stringify(store.get('customPaths')))
  }

  // ---- 6. the write fence ----------------------------------------------------
  {
    const stored = { version: 1, paths: {}, customPaths: ['cacheDirectory'] }
    for (const key of keys) stored.paths[key] = DEAD + '/' + leaves[key]
    stored.paths.cacheDirectory = slash(path.join(TMP, 'chosen-cache'))
    const home = makeHome('fence', stored)
    const roots = resolveWriteRoots(home, LLAMA).map(slash)
    check('the data directory is a write root', roots.includes(slash(home)), roots.join(', '))
    check('a chosen directory outside it is a write root',
      roots.includes(slash(path.join(TMP, 'chosen-cache'))), roots.join(', '))
    check('a stale directory from the old machine is not',
      !roots.some(function (r) { return r.toLowerCase().startsWith(DEAD.toLowerCase()) }),
      roots.join(', '))
  }

  // ---- 7. end to end: boot the real manager on a moved folder ----------------
  {
    const stored = { version: 1, paths: {} }
    for (const key of keys) stored.paths[key] = DEAD + '/' + leaves[key]
    const home = makeHome('boot', stored)
    const booted = await createManager({ dataDir: home, log: function () {} })
    try {
      const status = await booted.manager.cmd('status', {})
      const paths = status.settings.paths
      check('the booted manager reports directories inside the folder',
        keys.every(function (k) { return paths[k] === slash(home) + '/' + leaves[k] }),
        JSON.stringify(paths))

      // Anything that touches the machine writes a helper script first.
      await booted.manager.cmd('hardware', {})
      check('helper scripts land inside the folder',
        fs.existsSync(path.join(home, 'scripts', 'sys-info.ps1')))

      const outside = booted.services.fs
      let refused
      try {
        await outside.writeText(await outside.resolve(path.join(TMP, 'escaped.txt')), 'no')
        refused = false
      } catch (_e) {
        refused = true
      }
      check('a write outside the folder is refused', refused === true)
      check('reads outside the folder still work',
        (await outside.stat(await outside.resolve(APP_ROOT))) !== undefined)

      // Choosing a directory from the Settings page has to take effect now, not
      // on the next start: the fence was built from config.json as it stood at
      // boot, and the user is entitled to point logs at another drive.
      const chosen = path.join(TMP, 'chosen-logs')
      const widened = await booted.manager.cmd('settings.update', {
        patch: { paths: { logsDirectory: slash(chosen) } },
      })
      check('a directory outside the folder can be chosen while running',
        widened.ok === true, JSON.stringify(widened))
      let allowed = true
      try {
        await outside.writeText(await outside.resolve(path.join(chosen, 'probe.txt')), 'ok')
      } catch (_e) {
        allowed = false
      }
      check('and becomes writable without a restart', allowed === true)
    } finally {
      await booted.manager.shutdown()
    }
  }

  const ghostRoot = DEAD.split('/').slice(0, 4).join('/')
  check('nothing was created on the imaginary old machine', !fs.existsSync(ghostRoot), ghostRoot)

  console.log('')
  console.log(failures === 0 ? '  all checks passed' : '  ' + failures + ' check(s) failed')
  return failures === 0 ? 0 : 1
}

function cleanup() {
  // A PowerShell helper can still have the scripts directory open for a moment
  // after shutdown, and a failed cleanup must not turn a passing run into a
  // crash — the next run reuses the same place anyway.
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch (_e) { /* noop */ }
  // Leave .tmp behind only if a concurrent run still has something in it.
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
