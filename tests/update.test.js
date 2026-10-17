// tests/update.test.js — updating from GitHub releases, and starting with Windows.
//
// The functions live in src/update.ps1, which the tray dot-sources, so they are
// driven here through PowerShell. Nothing touches the network: downloads come
// from file:// URLs, which WebClient handles exactly like https, so the size
// and checksum checks are exercised for real. The startup entry is written to
// a throwaway key under HKCU\Software, never to the real Run key.
//
// The setup program (installer/Setup.cs) has to agree with the tray on two
// things it cannot ask it about at runtime: the instance key that names the
// tray's mutex and events — how setup asks a running copy to close — and the
// registry names of the startup entry. Both are checked against the C# source.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const { scratchDir, cleanScratch, createChecker, APP_ROOT } = require('./helpers.js')

const { check, finish } = createChecker()

const UPDATE_PS1 = path.join(APP_ROOT, 'src', 'update.ps1')
const SETUP_CS = path.join(APP_ROOT, 'installer', 'Setup.cs')

function psString(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

/** Run `body` with update.ps1 loaded; it must leave one JSON document on stdout. */
function runPs(dir, body) {
  const file = path.join(dir, 'case.ps1')
  // With a BOM: Windows PowerShell reads a .ps1 without one as ANSI.
  fs.writeFileSync(file, '﻿' + [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '. ' + psString(UPDATE_PS1),
    body,
  ].join('\r\n'))
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    { encoding: 'utf8', timeout: 120000 })
  if (run.status !== 0) throw new Error('PowerShell failed: ' + (run.stderr || run.stdout))
  return JSON.parse(run.stdout.trim())
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function versionsAndFeed(dir) {
  const r = runPs(dir, [
    '$out = [ordered]@{}',
    "$out.v12 = [string](ConvertTo-StudioVersion 'v1.2')",
    "$out.vPre = $null -eq (ConvertTo-StudioVersion 'v1.3.0-beta.1')",
    "$out.vJunk = $null -eq (ConvertTo-StudioVersion 'latest')",
    "$out.newerMinor = Test-UpdateAvailable '1.9.0' 'v1.10.0'",
    "$out.sameShort = Test-UpdateAvailable '1.0.0' 'v1.0'",
    "$out.older = Test-UpdateAvailable '1.2.0' 'v1.1.9'",
    "$out.patch = Test-UpdateAvailable '1.0.0' '1.0.1'",
    "$out.junk = Test-UpdateAvailable '1.0.0' 'nightly'",
    "$out.repoObj = Get-UpdateRepository ([pscustomobject]@{ repository = [pscustomobject]@{ url = 'https://github.com/someone/llama-cpp-studio.git' } })",
    "$out.repoStr = Get-UpdateRepository ([pscustomobject]@{ repository = 'git+https://github.com/someone/studio' })",
    "$out.repoSsh = Get-UpdateRepository ([pscustomobject]@{ repository = 'git@github.com:someone/studio.git' })",
    "$out.repoOther = $null -eq (Get-UpdateRepository ([pscustomobject]@{ repository = 'https://gitlab.com/someone/studio' }))",
    "$out.repoNone = $null -eq (Get-UpdateRepository ([pscustomobject]@{ name = 'x' }))",
    '$good = "https://github.com/o/r/releases/download/v1.1.0/"',
    '$release = [pscustomobject]@{ assets = @(',
    "  [pscustomobject]@{ name = 'SHA256SUMS.txt'; browser_download_url = $good + 'SHA256SUMS.txt' },",
    "  [pscustomobject]@{ name = 'llama-cpp-studio-1.1.0-win-x64.zip'; browser_download_url = $good + 'llama-cpp-studio-1.1.0-win-x64.zip' },",
    "  [pscustomobject]@{ name = 'llama-cpp-studio-1.1.0-setup.exe'; browser_download_url = $good + 'llama-cpp-studio-1.1.0-setup.exe' }",
    ') }',
    "$out.picked = (Select-SetupAsset $release 'o/r').name",
    "$foreign = [pscustomobject]@{ assets = @([pscustomobject]@{ name = 'x-setup.exe'; browser_download_url = 'https://evil.example/x-setup.exe' }) }",
    "$out.foreign = $null -eq (Select-SetupAsset $foreign 'o/r')",
    "$otherRepo = [pscustomobject]@{ assets = @([pscustomobject]@{ name = 'x-setup.exe'; browser_download_url = 'https://github.com/other/r/releases/download/v1/x-setup.exe' }) }",
    "$out.otherRepo = $null -eq (Select-SetupAsset $otherRepo 'o/r')",
    "$traversal = [pscustomobject]@{ assets = @([pscustomobject]@{ name = '..\\x-setup.exe'; browser_download_url = $good + 'x-setup.exe' }) }",
    "$out.traversal = $null -eq (Select-SetupAsset $traversal 'o/r')",
    "$out.digest = Get-DigestSha256 ('sha256:' + ('AB' * 32))",
    "$out.digestOther = $null -eq (Get-DigestSha256 ('sha512:' + ('ab' * 64)))",
    "$out.digestShort = $null -eq (Get-DigestSha256 'sha256:abc')",
    "$sums = ('cd' * 32) + '  a-setup.exe' + \"`n\" + ('EF' * 32) + ' *b-setup.exe' + \"`n\"",
    "$out.sumsA = Find-Sha256InSums $sums 'a-setup.exe'",
    "$out.sumsB = Find-Sha256InSums $sums 'b-setup.exe'",
    "$out.sumsMissing = $null -eq (Find-Sha256InSums $sums 'c-setup.exe')",
    '$out | ConvertTo-Json -Compress',
  ].join('\r\n'))

  check('"v1.2" reads as 1.2.0', r.v12 === '1.2.0.0', r.v12)
  check('a pre-release tag is not a version on offer', r.vPre === true)
  check('a tag that is not a version is ignored', r.vJunk === true)
  check('1.10.0 is newer than 1.9.0 (numbers, not text)', r.newerMinor === true)
  check('v1.0 is the same release as 1.0.0, not an update', r.sameShort === false)
  check('an older release is never offered', r.older === false)
  check('a patch release is offered', r.patch === true)
  check('an unparseable tag is never offered', r.junk === false)
  check('the repository comes from package.json', r.repoObj === 'someone/llama-cpp-studio', r.repoObj)
  check('  in its string form too', r.repoStr === 'someone/studio', r.repoStr)
  check('  and as an SSH remote', r.repoSsh === 'someone/studio', r.repoSsh)
  check('  but only on GitHub', r.repoOther === true)
  check('  and not at all when there is none', r.repoNone === true)
  check('the setup program is picked from the assets', r.picked === 'llama-cpp-studio-1.1.0-setup.exe', r.picked)
  check('an asset hosted anywhere else is refused', r.foreign === true)
  check('an asset of another repository is refused', r.otherRepo === true)
  check('an asset name with a path in it is refused', r.traversal === true)
  check('GitHub\'s digest gives the SHA-256, lower-cased', r.digest === 'ab'.repeat(32), r.digest)
  check('  and nothing for another algorithm', r.digestOther === true)
  check('  or for a truncated one', r.digestShort === true)
  check('SHA256SUMS lines are read in both sha256sum forms',
    r.sumsA === 'cd'.repeat(32) && r.sumsB === 'ef'.repeat(32), r.sumsA + ' / ' + r.sumsB)
  check('  and a file it does not list has no hash', r.sumsMissing === true)
}

function downloads(dir) {
  const payload = Buffer.from('MZ pretend setup program ' + 'x'.repeat(5000))
  const source = path.join(dir, 'served', 'llama-cpp-studio-9.9.9-setup.exe')
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, payload)
  const sums = path.join(dir, 'served', 'SHA256SUMS.txt')
  fs.writeFileSync(sums, sha256(payload) + '  llama-cpp-studio-9.9.9-setup.exe\n')
  const url = pathToFileURL(source).href
  const sumsUrl = pathToFileURL(sums).href
  const into = path.join(dir, 'downloads')

  function save(overrides) {
    const a = Object.assign({
      Url: url, Name: 'llama-cpp-studio-9.9.9-setup.exe', Size: payload.length,
      Sha256: sha256(payload), SumsUrl: '', UserAgent: 'test', Directory: into,
    }, overrides)
    return runPs(dir, [
      '$args2 = @{ Url = ' + psString(a.Url) + '; Name = ' + psString(a.Name) + '; Size = ' + a.Size
        + '; Sha256 = ' + psString(a.Sha256) + '; SumsUrl = ' + psString(a.SumsUrl)
        + '; UserAgent = ' + psString(a.UserAgent) + '; Directory = ' + psString(a.Directory) + ' }',
      'try { $path = Save-ReleaseAsset @args2; @{ ok = $true; path = $path } | ConvertTo-Json -Compress }',
      'catch { @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress }',
    ].join('\r\n'))
  }

  function leftovers() {
    return fs.existsSync(into) ? fs.readdirSync(into) : []
  }

  const good = save({})
  check('a download that matches its checksum is kept', good.ok === true && fs.existsSync(good.path), good.error)
  check('  byte for byte', good.ok && fs.readFileSync(good.path).equals(payload))
  fs.rmSync(into, { recursive: true, force: true })

  const tampered = save({ Sha256: 'ab'.repeat(32) })
  check('a download that does not match is refused', tampered.ok === false, tampered.error)
  check('  and deleted, never left where it could be run', leftovers().length === 0, leftovers().join(', '))

  const short = save({ Size: payload.length + 10 })
  check('a download of the wrong size is refused', short.ok === false && /stopped short/.test(short.error), short.error)
  check('  and deleted', leftovers().length === 0, leftovers().join(', '))

  const unverifiable = save({ Sha256: '' })
  check('without a published checksum nothing is installed', unverifiable.ok === false && /checksum/.test(unverifiable.error),
    unverifiable.error)

  const viaSums = save({ Sha256: '', SumsUrl: sumsUrl })
  check('SHA256SUMS.txt stands in for a missing digest', viaSums.ok === true, viaSums.error)
  fs.rmSync(into, { recursive: true, force: true })

  const badName = save({ Name: '..\\..\\evil-setup.exe' })
  check('an asset name with a path in it is never written', badName.ok === false, badName.error)
}

function autostart(dir) {
  const appRoot = path.join(dir, 'Studio Copy')
  fs.mkdirSync(path.join(appRoot, 'src'), { recursive: true })
  const key = 'HKCU:\\Software\\llama-cpp-studio-test-' + process.pid

  const r = runPs(dir, [
    '$root = ' + psString(appRoot),
    '$run = ' + psString(key + '\\Run'),
    '$approved = ' + psString(key + '\\Approved'),
    'New-Item -Path $approved -Force | Out-Null',
    '$out = [ordered]@{}',
    'try {',
    '  $out.fallback = Get-AutostartCommand $root',
    "  New-Item -ItemType File -Path (Join-Path $root 'llama-studio.exe') | Out-Null",
    '  $out.command = Get-AutostartCommand $root',
    '  $out.initially = Get-AutostartState -AppRoot $root -RunKey $run -ApprovedKey $approved',
    '  Set-Autostart -AppRoot $root -Enabled $true -RunKey $run -ApprovedKey $approved',
    '  $out.afterOn = Get-AutostartState -AppRoot $root -RunKey $run -ApprovedKey $approved',
    '  $out.written = (Get-ItemProperty -LiteralPath $run).$StudioRunValue',
    '  Set-ItemProperty -LiteralPath $approved -Name $StudioRunValue -Value ([byte[]](3,0,0,0,0,0,0,0,0,0,0,0)) -Type Binary',
    '  $out.switchedOff = Get-AutostartState -AppRoot $root -RunKey $run -ApprovedKey $approved',
    '  Set-Autostart -AppRoot $root -Enabled $true -RunKey $run -ApprovedKey $approved',
    '  $out.backOn = Get-AutostartState -AppRoot $root -RunKey $run -ApprovedKey $approved',
    "  Set-ItemProperty -LiteralPath $run -Name $StudioRunValue -Value '\"C:\\Elsewhere\\llama-studio.exe\" --background'",
    '  $out.other = Get-AutostartState -AppRoot $root -RunKey $run -ApprovedKey $approved',
    '  Set-Autostart -AppRoot $root -Enabled $false -RunKey $run -ApprovedKey $approved',
    '  $out.afterOff = Get-AutostartState -AppRoot $root -RunKey $run -ApprovedKey $approved',
    '} finally {',
    '  Remove-Item -LiteralPath ' + psString(key) + ' -Recurse -Force -ErrorAction SilentlyContinue',
    '}',
    '$out.cleaned = -not (Test-Path -LiteralPath ' + psString(key) + ')',
    '$out | ConvertTo-Json -Compress',
  ].join('\r\n'))

  check('a source checkout starts through PowerShell, without a browser',
    /powershell\.exe" .*-File ".*\\src\\tray\.ps1" -NoBrowser$/.test(r.fallback), r.fallback)
  const expected = '"' + path.join(appRoot, 'llama-studio.exe') + '" --background'
  check('an installed copy starts through llama-studio.exe --background', r.command === expected, r.command)
  check('nothing starts with Windows until asked', r.initially === 'off', r.initially)
  check('turning it on writes the entry', r.afterOn === 'on' && r.written === expected, r.afterOn + ' / ' + r.written)
  check('switched off under Settings > Apps > Startup reads as blocked, not on', r.switchedOff === 'blocked', r.switchedOff)
  check('turning it on again clears that', r.backOn === 'on', r.backOn)
  check('an entry for another copy is told apart from ours', r.other === 'other', r.other)
  check('turning it off removes the entry', r.afterOff === 'off', r.afterOff)
  check('the test key is gone again', r.cleaned === true)
}

function agreesWithSetup(dir) {
  const cs = fs.readFileSync(SETUP_CS, 'utf8')
  const ps = fs.readFileSync(UPDATE_PS1, 'utf8')

  const csConst = function (name) { const m = new RegExp(name + ' = @?"([^"]+)"').exec(cs); return m && m[1] }
  const psVar = function (name) { const m = new RegExp('\\$' + name + " = '([^']+)'").exec(ps); return m && m[1] }
  check('setup and tray name the startup entry alike', csConst('RunValue') === psVar('StudioRunValue'),
    csConst('RunValue') + ' / ' + psVar('StudioRunValue'))
  check('  under the same Run key', 'HKCU:\\' + csConst('RunKey') === psVar('StudioRunKey'),
    csConst('RunKey') + ' / ' + psVar('StudioRunKey'))
  check('  and the same StartupApproved key', 'HKCU:\\' + csConst('ApprovedKey') === psVar('StudioApprovedKey'),
    csConst('ApprovedKey') + ' / ' + psVar('StudioApprovedKey'))

  const method = /public static string InstanceKey\(string dir\)\s*\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/.exec(cs)
  check('Setup.cs still has InstanceKey', method !== null)
  if (method === null) return
  const dirs = [
    'C:\\Users\\Someone\\AppData\\Local\\Programs\\llama.cpp Studio',
    'C:\\Users\\Someone\\AppData\\Local\\Programs\\llama.cpp Studio\\',
    'D:\\Apps\\LLAMA Studio',
    'E:\\Ünïcode\\Студия',
  ]
  const r = runPs(dir, [
    "Add-Type -TypeDefinition ('using System; using System.IO; using System.Text; using System.Security.Cryptography; "
      + "public static class SetupKey { ' + " + psString(method[0]) + " + ' }')",
    '$dirs = @(' + dirs.map(psString).join(', ') + ')',
    '@($dirs | ForEach-Object { @{ ps = (Get-InstanceKey $_); cs = [SetupKey]::InstanceKey($_) } }) | ConvertTo-Json -Compress',
  ].join('\r\n'))
  check('setup and tray derive the same instance key for every folder',
    r.every(function (k) { return k.ps === k.cs && /^[0-9a-f]{16}$/.test(k.ps) }), JSON.stringify(r))
  check('  ignoring a trailing backslash', r[0].ps === r[1].ps)
  check('  and different folders get different keys', new Set(r.map(function (k) { return k.ps })).size === 3)
}

function main() {
  console.log('llama.cpp Studio updates and start with Windows')
  if (process.platform !== 'win32') {
    console.log('  skipped: Windows only')
    return 0
  }
  const dir = scratchDir('update')
  try {
    versionsAndFeed(dir)
    downloads(dir)
    autostart(dir)
    agreesWithSetup(dir)
  } finally {
    cleanScratch(dir)
  }
  return finish('update.test.js')
}

process.exit(main())
