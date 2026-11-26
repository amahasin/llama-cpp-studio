// tests/startup.test.js — the tray hears where the app is, or why it is not.
//
// The tray starts main.js and waits for it to write an endpoint file. That
// handshake used to wait for llama-server as well: main.js wrote the file only
// after the router had started, and the first CUDA start after a reboot can take
// longer than the tray waited. The tray then announced that the whole app had
// failed, killed Node (leaving llama-server behind), and tried again into the
// same wait. And when the app really could not start, all the dialog could say
// was "could not start".
//
// So, against the real main.js:
//   • the endpoint is written as soon as the app listens, before the router;
//   • a port that is taken comes back as a reason, with its code, at once;
//   • closing stdin, which is how the tray asks for a clean stop, removes it.
// And against the tray's own Start-Backend, loaded out of tray.ps1 and pointed
// at stand-in backends:
//   • a reported reason is passed on, and only a busy port asks for a retry;
//   • a backend that dies says so with its exit code, without the full wait;
//   • a backend that never answers is killed *with what it started*.
'use strict'

const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')

const { scratchDir, cleanScratch, createChecker, APP_ROOT } = require('./helpers.js')

const { check, finish } = createChecker()

const MAIN = path.join(APP_ROOT, 'src', 'main.js')
const TRAY = path.join(APP_ROOT, 'src', 'tray.ps1')

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms) })
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_e) { return undefined }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (_e) {
    return false
  }
}

function startMain(dir, extra) {
  const child = spawn(process.execPath, [MAIN, '--no-open', '--no-autostart', '--host', '127.0.0.1',
    '--data', path.join(dir, 'data')].concat(extra), { stdio: ['pipe', 'pipe', 'pipe'] })
  child.output = ''
  child.stdout.on('data', function (c) { child.output += c })
  child.stderr.on('data', function (c) { child.output += c })
  child.exited = new Promise(function (resolve) { child.on('exit', function (code) { resolve(code) }) })
  return child
}

async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(100)
  }
  return undefined
}

async function realMain(dir) {
  // A port that is already taken.
  const blocker = net.createServer()
  await new Promise(function (resolve) { blocker.listen(0, '127.0.0.1', resolve) })
  const busy = blocker.address().port
  const busyFile = path.join(dir, 'busy.json')
  const refused = startMain(dir, ['--port', String(busy), '--endpoint-file', busyFile])
  const code = await Promise.race([refused.exited, sleep(60000).then(function () { return 'timeout' })])
  blocker.close()
  const reason = readJson(busyFile)
  check('a taken port ends the app with an error code', code === 1, String(code))
  check('  and the reason reaches the endpoint file', reason !== undefined && /already in use/.test(reason.error || ''),
    JSON.stringify(reason))
  check('  coded EADDRINUSE, so the tray knows another port would fix it',
    reason !== undefined && reason.code === 'EADDRINUSE', JSON.stringify(reason))

  // A normal start: the endpoint appears, and closing stdin removes it.
  const okFile = path.join(dir, 'ok.json')
  const started = startMain(dir, ['--port', '0', '--endpoint-file', okFile])
  const info = await waitFor(function () { const j = readJson(okFile); return j && j.url ? j : undefined }, 60000)
  check('a normal start writes the URL to the endpoint file', info !== undefined, started.output.slice(-400))
  if (info !== undefined) {
    const health = await fetch(info.url + 'api/health').then(function (r) { return r.json() }).catch(function () { return {} })
    check('  and the app at that URL answers', health.ok === true)
  }
  started.stdin.end()
  const stopped = await Promise.race([started.exited, sleep(30000).then(function () { return 'timeout' })])
  check('closing stdin stops the app cleanly', stopped === 0, String(stopped))
  check('  and removes the endpoint file', !fs.existsSync(okFile))
  if (stopped === 'timeout') started.kill()

  // The order that matters: say where we are before waiting on llama-server.
  const src = fs.readFileSync(MAIN, 'utf8')
  const written = src.indexOf('endpoint.write(args.endpointFile')
  const router = src.indexOf('await autostartRouter(')
  check('main.js publishes the endpoint before it waits for the router',
    written !== -1 && router !== -1 && written < router)
}

const FAKE_MAIN = [
  "'use strict'",
  "const fs = require('fs')",
  "const { spawn } = require('child_process')",
  "const file = process.argv[process.argv.indexOf('--endpoint-file') + 1]",
  'const mode = process.env.FAKE_MODE',
  "if (mode === 'error') {",
  "  fs.writeFileSync(file, JSON.stringify({ error: 'Port 8770 is already in use on 127.0.0.1.', code: 'EADDRINUSE' }))",
  '  process.exit(1)',
  '}',
  "if (mode === 'crash') process.exit(3)",
  "if (mode === 'slow') setTimeout(function () { fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:9/' })) }, 1500)",
  "if (mode === 'hang') {",
  '  // A stand-in for llama-server: started, and never finishing.',
  "  const child = spawn(process.execPath, ['-e', 'setTimeout(function () {}, 120000)'], { stdio: 'ignore' })",
  '  fs.writeFileSync(process.env.FAKE_CHILD_PID, String(child.pid))',
  '}',
  "process.stdin.resume(); process.stdin.on('end', function () { process.exit(0) })",
  'setTimeout(function () {}, 120000)',
  '',
].join('\n')

function psString(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

/** Run the tray's Start-Backend against the stand-in, in `mode`. */
function trayStart(dir, mode, timeoutSec) {
  const script = path.join(dir, 'start-backend.ps1')
  fs.writeFileSync(script, '﻿' + [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$ast = [System.Management.Automation.Language.Parser]::ParseFile(' + psString(TRAY) + ', [ref]$null, [ref]$null)',
    "foreach ($name in 'Stop-ProcessTree', 'Read-EndpointFile', 'Start-Backend') {",
    '  $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)',
    '  if (-not $fn) { throw "tray.ps1 no longer defines $name" }',
    '  . ([scriptblock]::Create($fn.Extent.Text))',
    '}',
    'function Get-NodeExe { ' + psString(process.execPath) + ' }',
    '$ScriptDir = ' + psString(dir),
    '$AppRoot = ' + psString(dir),
    "$HostAddr = '127.0.0.1'",
    '$EndpointFile = ' + psString(path.join(dir, 'tray-endpoint.json')),
    '$StartupTimeoutSec = ' + timeoutSec,
    '$sw = [System.Diagnostics.Stopwatch]::StartNew()',
    "$r = Start-Backend '8770'",
    '$out = @{ url = $r.url; error = $r.error; code = $r.code; seconds = $sw.Elapsed.TotalSeconds',
    '  alive = [bool]($r.proc -and -not $r.proc.HasExited); fileLeft = (Test-Path -LiteralPath $EndpointFile) }',
    'if ($r.proc) { try { $r.proc.StandardInput.Close() } catch {}; [void]$r.proc.WaitForExit(5000) }',
    '$out | ConvertTo-Json -Compress',
  ].join('\r\n'))

  return new Promise(function (resolve, reject) {
    const env = Object.assign({}, process.env, { FAKE_MODE: mode, FAKE_CHILD_PID: path.join(dir, 'child.pid') })
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { env })
    let stdout = ''
    let stderr = ''
    ps.stdout.on('data', function (c) { stdout += c })
    ps.stderr.on('data', function (c) { stderr += c })
    ps.on('error', reject)
    ps.on('close', function (code) {
      if (code !== 0) { reject(new Error('Start-Backend script failed: ' + (stderr || stdout))); return }
      try { resolve(JSON.parse(stdout.trim())) } catch (_e) { reject(new Error('no JSON: ' + stdout.slice(0, 300))) }
    })
  })
}

async function trayHandshake(dir) {
  const fakeDir = path.join(dir, 'fake')
  fs.mkdirSync(fakeDir, { recursive: true })
  fs.writeFileSync(path.join(fakeDir, 'main.js'), FAKE_MAIN)

  const error = await trayStart(fakeDir, 'error', 20)
  check('the tray passes on the reason the app gave', /already in use/.test(error.error || ''), JSON.stringify(error))
  check('  with its code, which is what decides a retry on another port', error.code === 'EADDRINUSE', error.code)
  check('  straight away, not after the timeout', error.seconds < 10, String(error.seconds))

  const crash = await trayStart(fakeDir, 'crash', 20)
  check('a backend that dies is reported with its exit code', /exit code 3/.test(crash.error || ''), JSON.stringify(crash))
  check('  straight away', crash.seconds < 10, String(crash.seconds))
  check('  and is not mistaken for a busy port', crash.code === null || crash.code === undefined || crash.code === '',
    String(crash.code))

  const slow = await trayStart(fakeDir, 'slow', 20)
  check('a backend that takes a moment is waited for', slow.url === 'http://127.0.0.1:9/' && slow.alive === true,
    JSON.stringify(slow))

  const pidFile = path.join(fakeDir, 'child.pid')
  fs.rmSync(pidFile, { force: true })
  const hang = await trayStart(fakeDir, 'hang', 4)
  check('a backend that never answers is given up on', /within 4 seconds/.test(hang.error || ''), JSON.stringify(hang))
  check('  and leaves no endpoint file behind', hang.fileLeft === false)
  const childPid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : NaN)
  const gone = await waitFor(function () { return !isAlive(childPid) }, 5000)
  check('  and what it started is stopped with it, not left holding the GPU', Number.isFinite(childPid) && gone === true,
    'child ' + childPid + (isAlive(childPid) ? ' still running' : ''))
  if (Number.isFinite(childPid) && isAlive(childPid)) process.kill(childPid)
}

async function main() {
  console.log('llama.cpp Studio startup handshake')
  if (process.platform !== 'win32') {
    console.log('  skipped: Windows only')
    return 0
  }
  const dir = scratchDir('startup')
  try {
    await realMain(dir)
    await trayHandshake(dir)
  } finally {
    cleanScratch(dir)
  }
  return finish('startup.test.js')
}

main()
  .then(function (code) { process.exit(code) })
  .catch(function (err) {
    console.error(err && err.stack ? err.stack : err)
    process.exit(1)
  })
