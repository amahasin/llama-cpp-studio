// tests/tray.test.js — the system tray reports the real server state.
//
// It used to assert "Router Running" in its tooltip and its menu from the
// moment it started and never revisit it: the only update looked at whether
// the Node backend had exited, which is a different question, and did not run
// at all when the tray had attached to an instance somebody else started. So
// the tray claimed a running router whether or not one existed.
//
// The status functions live in src/tray.ps1, so they are driven here through
// PowerShell against a real HTTP server with a stubbed manager — that way
// every lifecycle state can be asked for directly, including the ones that
// would otherwise need a GPU and a model.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const { startServer } = require('../src/server.js')
const { scratchDir, cleanScratch, createChecker } = require('./helpers.js')

const { check, finish } = createChecker()

const TRAY = path.join(__dirname, '..', 'src', 'tray.ps1')

/** A manager that reports exactly the server state a case asks for. */
function stubManager(serverStatus) {
  return {
    config: { get() { return { host: '127.0.0.1', port: 8080, allowedOrigins: '' } } },
    server: { status() { return serverStatus } },
    async cmd(method) {
      if (method === 'server.status') return { ok: true, server: serverStatus }
      return { ok: true }
    },
  }
}

/**
 * Run the tray's own status functions against `url` and resolve with what the
 * tray would show. The functions are lifted out of tray.ps1 by the same markers the
 * file documents, so a rename there fails this loudly rather than silently
 * testing nothing.
 */
function askTray(dir, url) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$src = Get-Content -Raw "' + TRAY.replace(/\\/g, '\\\\') + '"',
    '$start = $src.IndexOf(\'$script:Token = $null\')',
    '$end = $src.IndexOf(\'$notifyIcon = New-Object\')',
    'if ($start -lt 0 -or $end -le $start) { throw "could not find the status functions in tray.ps1" }',
    'Invoke-Expression $src.Substring($start, $end - $start)',
    '$WebUrl = "' + url + '"',
    '$server = Get-ServerState',
    '$status = Get-StatusText $server',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '@{ key = $status.key; label = $status.label; answered = ($null -ne $server) } | ConvertTo-Json -Compress',
  ].join('\n')

  const file = path.join(dir, 'ask-tray.ps1')
  fs.writeFileSync(file, script)

  // Deliberately NOT spawnSync: the HTTP server the script is about to call
  // lives in this very process, and spawnSync blocks the event loop — so the
  // server could never answer, every request timed out, and every state came
  // back looking "offline".
  return new Promise(function (resolve, reject) {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', function (c) { stdout += c })
    child.stderr.on('data', function (c) { stderr += c })
    child.on('error', reject)
    child.on('close', function (code) {
      if (code !== 0) {
        reject(new Error('tray status script failed: ' + (stderr || stdout || 'no output')))
        return
      }
      try {
        resolve(JSON.parse(stdout.trim()))
      } catch (e) {
        reject(new Error('tray status script printed no JSON: ' + JSON.stringify(stdout.slice(0, 200))))
      }
    })
  })
}

const CASES = [
  {
    name: 'a stopped server',
    status: { state: 'STOPPED', mode: 'single' },
    key: 'stopped',
  },
  {
    name: 'a running router',
    status: { state: 'RUNNING', mode: 'router', host: '127.0.0.1', port: 8080 },
    key: 'running',
    labelHas: 'Router running',
  },
  {
    name: 'a running single-model server',
    status: { state: 'RUNNING', mode: 'single', host: '127.0.0.1', port: 8080 },
    key: 'running',
    labelHas: 'Server running',
  },
  {
    name: 'a server still starting',
    status: { state: 'STARTING', mode: 'router' },
    key: 'starting',
  },
  {
    name: 'a server that failed to start',
    status: { state: 'FAILED', mode: 'router' },
    key: 'stopped',
    labelHas: 'failed',
  },
]

async function main() {
  console.log('llama.cpp Studio system tray status')

  if (process.platform !== 'win32') {
    console.log('  skipped: the tray is Windows-only')
    return 0
  }

  const dir = scratchDir('tray')

  for (const testCase of CASES) {
    const studio = await startServer({
      manager: stubManager(testCase.status), host: '127.0.0.1', port: 0, version: 'test', log() {},
    })
    try {
      const shown = await askTray(dir, studio.url)
      check(testCase.name + ' shows the ' + testCase.key + ' icon',
        shown.key === testCase.key, 'got ' + shown.key + ' — "' + shown.label + '"')
      if (testCase.labelHas !== undefined) {
        check('  and says "' + testCase.labelHas + '"',
          shown.label.indexOf(testCase.labelHas) !== -1, shown.label)
      }
      // The whole point: nothing may claim to be running unless it is.
      if (testCase.status.state !== 'RUNNING') {
        check('  and does not claim anything is running',
          !/running/i.test(shown.label), shown.label)
      }
      // NotifyIcon.Text throws above 63 characters.
      check('  and fits in a tray tooltip', shown.label.length <= 63, String(shown.label.length))
    } finally {
      await studio.close()
    }
  }

  // Nothing listening at all is a different thing from a stopped server.
  const offline = await askTray(dir, 'http://127.0.0.1:1/')
  check('an unreachable app reads as offline, not as running', offline.key === 'offline', offline.key)
  check('  and says so plainly', /not running/i.test(offline.label), offline.label)
  check('  without having reached a server', offline.answered === false)

  const code = finish('tray.test.js')
  cleanScratch(dir)
  return code
}

main()
  .then(function (code) { process.exit(code) })
  .catch(function (err) {
    console.error(err && err.stack ? err.stack : err)
    process.exit(1)
  })
