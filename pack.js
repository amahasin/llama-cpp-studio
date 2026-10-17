// pack.js — make llama.cpp Studio self-contained.
//
//   node pack.js                 vendor everything into ./runtime (in place)
//   node pack.js --out <dir>     also copy the whole app to <dir>
//   node pack.js --no-node       skip the Node runtime (needs Node on PATH)
//
// After packing, the standalone folder carries the plugin's host modules, the
// UI bundle, React and the Node runtime — move it anywhere and run start.cmd.
// A moved-out copy keeps its data in .\data; while it still lives inside the
// plugin it shares the plugin's directory.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const {
  APP_ROOT: STANDALONE, PLUGIN_ROOT, RUNTIME_DIR: RUNTIME,
  PLUGIN_HOST_DIR, hasPluginSources,
} = require('./src/lib/layout.js')
const { copyFile, copyDir, dirSize } = require('./src/lib/fsx.js')

function arg(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

// What travels into an `--out` copy. The setup program and the launcher are
// built from installer/ by `node installer/build.js`, not by this script; a
// launcher left over from such a build travels along if one is here.
const COPIED_DIRS = ['src', 'web', 'tests', 'runtime']
const COPIED_DIR_EXCLUDES = []
const COPIED_FILES = ['package.json', 'README.md', 'PORTABLE.md', 'build.js', 'pack.js',
  'repair-paths.js', 'start.cmd', 'llama-studio.exe']

// The launcher written into a packed folder. It must stay in step with the
// start.cmd in the repository: this template used to be the console-only
// version, so packing silently replaced the tray launcher with one that no
// longer had a `--console` switch, let alone a tray.
const LAUNCHER = [
  '@echo off',
  'REM llama.cpp Studio — launcher.',
  'setlocal',
  'cd /d "%~dp0"',
  'set "NODE_EXE=%~dp0runtime\\node.exe"',
  'if not exist "%NODE_EXE%" set "NODE_EXE=node"',
  '',
  'if not exist "web\\vendor\\react.production.min.js" (',
  '  echo First run: preparing the UI...',
  '  "%NODE_EXE%" build.js || (echo Build failed. & pause & exit /b 1)',
  ')',
  '',
  'if "%1"=="--console" goto console',
  'if "%1"=="--foreground" goto console',
  'if "%1"=="-c" goto console',
  '',
  'REM Start in background with Windows system tray icon',
  'echo Starting llama.cpp Studio in system tray (Router mode auto-start)...',
  'start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0src\\tray.ps1"',
  'echo.',
  'echo llama.cpp Studio is now running in the Windows System Tray.',
  'echo The Web UI has been opened in your browser; the tray icon reopens it.',
  'echo.',
  'echo You may safely close this terminal window.',
  'timeout /t 3 /nobreak >nul',
  'goto end',
  '',
  ':console',
  'shift',
  '"%NODE_EXE%" src\\main.js %*',
  'if errorlevel 1 pause',
  '',
  ':end',
  'endlocal',
  '',
].join('\r\n')

function selfContain(withNode) {
  // Everything below is copied *from* the plugin repository, so this only runs
  // where that repository is. A folder that has already been packed and moved
  // has nothing to pack from, and saying so beats an ENOENT on a path that
  // belongs to whatever now happens to sit next to it.
  if (!hasPluginSources()) {
    console.error('no plugin sources at ' + PLUGIN_ROOT)
    console.error('pack.js builds this folder from the DeepSeek Harness llama.cpp plugin;')
    console.error('run it there. This folder is already self-contained — just start.cmd it.')
    process.exit(1)
  }
  console.log('making the app self-contained')

  // 1. Fresh plugin bundles + vendored React.
  execFileSync(process.execPath, [path.join(STANDALONE, 'build.js')], { cwd: STANDALONE, stdio: 'inherit' })

  // 2. The plugin's host modules and UI bundle travel with the app.
  fs.rmSync(path.join(RUNTIME, 'host'), { recursive: true, force: true })
  copyDir(PLUGIN_HOST_DIR, path.join(RUNTIME, 'host'),
    function (f) { return f.endsWith('.js') })
  copyFile(path.join(PLUGIN_ROOT, 'dist', 'client.bundle.js'), path.join(RUNTIME, 'client.bundle.js'))
  const hostCount = fs.readdirSync(path.join(RUNTIME, 'host', 'modules')).length
  console.log('  bundled: ' + hostCount + ' host modules + the UI bundle')

  // 3. The Node runtime, so nothing has to be installed on the target machine.
  const nodeTarget = path.join(RUNTIME, path.basename(process.execPath))
  if (withNode) {
    copyFile(process.execPath, nodeTarget)
    console.log('  bundled: ' + path.basename(process.execPath) + ' ('
      + Math.round(fs.statSync(nodeTarget).size / 1048576) + ' MB, ' + process.version + ')')
  } else {
    fs.rmSync(nodeTarget, { force: true })
    console.log('  skipped the Node runtime (--no-node): the target machine needs Node 18+ on PATH')
  }

  // 4. Launcher + a note for whoever finds the folder later.
  fs.writeFileSync(path.join(STANDALONE, 'start.cmd'), LAUNCHER)
  fs.writeFileSync(path.join(STANDALONE, 'PORTABLE.md'), [
    '# llama.cpp Studio — portable',
    '',
    'This folder is self-contained: it carries the llama.cpp manager, its web UI,',
    'React and' + (withNode ? ' the Node runtime' : ' (no Node runtime — install Node 18+)') + '.',
    'Move it anywhere and run `start.cmd`.',
    '',
    'That starts the app behind a tray icon and opens it in your browser;',
    '`start.cmd --console` runs it in a console window instead — useful for a',
    'headless box. For a Start menu entry, starting with Windows, updates and an',
    'uninstaller, use the setup program from the releases page; the portable',
    'folder keeps working either way.',
    '',
    '- Models, llama.cpp builds, logs and config all live in `.\\data`, and the',
    '  app never reads or writes outside this folder on its own.',
    '- Renaming, moving or copying the folder is fine: the managed directories',
    '  are worked out from wherever the folder is on every start.',
    '- A directory *you* point somewhere else — Settings › Directories — stays',
    '  there across every move, and is the only thing the app writes outside.',
    '- `--data <dir>` keeps the data somewhere else entirely.',
    '- `--port <n>` changes the UI port (default 8770).',
    '',
    'Installed builds and imported models are recorded with absolute paths too.',
    'The app re-points them as it reads them; `node repair-paths.js` writes the',
    'repair back and reports anything it cannot fix — models imported by',
    'reference point at files outside this folder, which only you can restore.',
    '',
    'Packed ' + new Date().toISOString() + ' with Node ' + process.version + '.',
    '',
  ].join('\n'))
}

function copyTo(out) {
  const target = path.resolve(out)
  console.log('copying the app to ' + target)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  for (const name of COPIED_DIRS) {
    const from = path.join(STANDALONE, name)
    if (!fs.existsSync(from)) continue
    copyDir(from, path.join(target, name), function (file) {
      const rel = path.relative(from, file).split(path.sep).join('/')
      return !COPIED_DIR_EXCLUDES.some(function (skip) { return rel.startsWith(skip) })
    })
  }
  for (const name of COPIED_FILES) {
    const from = path.join(STANDALONE, name)
    if (fs.existsSync(from)) copyFile(from, path.join(target, name))
  }
  return target
}

function main() {
  const withNode = !process.argv.includes('--no-node')
  selfContain(withNode)

  const out = arg('--out')
  const finalDir = out ? copyTo(out) : STANDALONE
  const size = dirSize(finalDir)
  console.log('')
  console.log('  self-contained: ' + (size / 1048576).toFixed(1) + ' MB in ' + finalDir)
  console.log('  run it with:    ' + path.join(finalDir, 'start.cmd'))
}

main()
