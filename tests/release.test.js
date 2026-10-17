// tests/release.test.js — what a release ships, and that the installer builds.
//
// A release is public. What goes into it is decided by installer/build.js's
// stage plan, so the plan is checked here without building anything: the app
// is all there, and nothing that is not the app — tests, the data folder with
// its models and API keys, scratch space, a previous build — rides along.
//
// The launcher, the setup program and the uninstaller are C# 5, compiled by the
// csc.exe in .NET Framework. Compiling them here, with warnings as errors, is
// what catches a newer language feature before a release build does.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { scratchDir, cleanScratch, createChecker, APP_ROOT } = require('./helpers.js')
const release = require('../installer/build.js')

const { check, finish } = createChecker()

function planChecks() {
  const plan = release.stagePlan(APP_ROOT).map(function (rel) { return rel.split(path.sep).join('/') })
  const has = function (rel) { return plan.indexOf(rel) !== -1 }

  for (const rel of ['src/main.js', 'src/tray.ps1', 'src/update.ps1', 'runtime/host/boot.js',
    'runtime/client.bundle.js', 'web/index.html', 'web/fluent.css', 'package.json', 'start.cmd']) {
    check('ships ' + rel, has(rel))
  }
  for (const vendored of ['web/vendor/react.production.min.js', 'web/vendor/react-dom.production.min.js']) {
    if (fs.existsSync(path.join(APP_ROOT, vendored))) check('ships ' + vendored, has(vendored))
  }

  const forbidden = [/^data\//, /^tests\//, /^\.tmp\//, /^dist\//, /^installer\//, /^\.git\//,
    /node_modules\//, /^tools\/worker\/dist\//, /^tools\/patch-client-bundle\.js$/, /^runtime\/node\.exe$/]
  const leaks = plan.filter(function (rel) { return forbidden.some(function (re) { return re.test(rel) }) })
  check('ships nothing that is not the app (no data, tests, scratch, builds)', leaks.length === 0, leaks.join(', '))

  const tops = release.payloadTops(release.stagePlan(APP_ROOT))
  check('the uninstaller knows the launcher and itself',
    tops.indexOf('llama-studio.exe') !== -1 && tops.indexOf('uninstall.exe') !== -1, tops.join(', '))
  check('  and never counts the data folder as its own', tops.indexOf('data') === -1, tops.join(', '))
}

function metadataChecks() {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'))
  check('package.json has a MAJOR.MINOR.PATCH version', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version)
  check('package.json names the GitHub repository updates come from', release.repositoryUrl(pkg) !== undefined,
    JSON.stringify(pkg.repository))
  check('a repository URL is normalised',
    release.repositoryUrl({ repository: { url: 'git+https://github.com/a/b.git' } }) === 'https://github.com/a/b')
  check('  and a non-GitHub one is not a release feed',
    release.repositoryUrl({ repository: 'https://gitlab.com/a/b' }) === undefined)

  const info = release.buildInfo('T', '1.2.3', 'https://github.com/a/b', ['src', 'it"s'])
  check('build info carries a four-part file version', info.indexOf('AssemblyFileVersion("1.2.3.0")') !== -1)
  check('  with strings escaped for C#', info.indexOf('"it\\"s"') !== -1)
}

function compileChecks() {
  let csc
  try {
    csc = release.findCsc()
  } catch (err) {
    console.log('  skipped compiling: ' + err.message)
    return
  }
  const dir = scratchDir('release')
  try {
    const info = path.join(dir, 'info.cs')
    fs.writeFileSync(info, release.buildInfo('Test', '0.0.1', 'https://github.com/a/b', ['src', 'web']))
    const builds = [
      { out: 'launcher.exe', sources: [info, path.join(APP_ROOT, 'installer', 'Launcher.cs')] },
      { out: 'setup.exe', sources: [info, path.join(APP_ROOT, 'installer', 'Setup.cs')] },
      { out: 'uninstall.exe', define: 'UNINSTALLER', sources: [info, path.join(APP_ROOT, 'installer', 'Setup.cs')] },
    ]
    for (const b of builds) {
      let error
      try {
        release.compile(csc, { out: path.join(dir, b.out), define: b.define, sources: b.sources })
      } catch (err) {
        error = err.message
      }
      check(b.out.replace('.exe', '') + ' compiles as C# 5 with warnings as errors', error === undefined, error)
    }
  } finally {
    cleanScratch(dir)
  }
}

function main() {
  console.log('llama.cpp Studio release contents')
  planChecks()
  metadataChecks()
  if (process.platform === 'win32') compileChecks()
  return finish('release.test.js')
}

process.exit(main())
