#!/usr/bin/env node
// main.js — llama.cpp Studio, the standalone application.
//
// Boots the plugin's manager against local Node services, serves the plugin UI
// on localhost and opens it in the browser. No harness, no npm dependencies.
//
// The command line lives in ./cli/options.js, the startup block in
// ./cli/banner.js; what is left here is the order things happen in.
'use strict'

const { createManager } = require('./host.js')
const { startServer } = require('./server.js')
const options = require('./cli/options.js')
const { requireSupportedPlatform } = require('./lib/platform.js')
const endpoint = require('./cli/endpoint.js')
const { statusBanner } = require('./cli/banner.js')
const { openBrowser } = require('./cli/browser.js')

const VERSION = require('../package.json').version

/**
 * Why the socket could not be opened, said in a sentence. A busy port is the
 * ordinary way this fails — someone already has the app running — and a stack
 * trace is a poor way to be told so.
 */
function bindFailure(err, args) {
  const where = args.host + ':' + args.port
  if (err && err.code === 'EADDRINUSE') {
    return [
      'Port ' + args.port + ' is already in use on ' + args.host + '.',
      '',
      'If llama.cpp Studio is already running, open it instead of starting a second copy.',
      'Otherwise pick another port:  llama-studio --port ' + (Number(args.port) + 1),
      'Or let the OS choose a free one:  llama-studio --port 0',
    ].join('\n')
  }
  if (err && err.code === 'EACCES') {
    return 'Not allowed to bind ' + where + '. Ports below 1024 need elevation — pick a higher one with --port.'
  }
  if (err && err.code === 'EADDRNOTAVAIL') {
    return 'No interface on this machine has the address ' + args.host + '. Check --host.'
  }
  return 'Could not listen on ' + where + ': ' + String(err && err.message ? err.message : err)
}

/**
 * Router mode is the useful default: an OpenAI-compatible endpoint that is up
 * before anyone opens the UI. A failure here is reported in the banner rather
 * than thrown — the app itself is fine, and the UI can start it by hand.
 */
async function autostartRouter(manager, wanted) {
  const configured = manager.config ? manager.config.get('server') : {}
  if (wanted === false || (configured && configured.autostart === false)) return undefined
  try {
    const res = await manager.cmd('server.start', { mode: 'router' })
    return res.ok ? undefined : (res.message || res.code)
  } catch (err) {
    return String(err && err.message ? err.message : err)
  }
}

/**
 * Stop cleanly on Ctrl+C, on SIGTERM, and — when a desktop shell started us and
 * is holding our stdin open — when that shell closes it. A GUI parent has no
 * console to send Ctrl+C through, and killing the process outright would leave
 * llama-server holding VRAM until the OS got round to the job object.
 */
function installShutdown(deps) {
  let stopping = false

  async function shutdown(signal) {
    if (stopping) return
    stopping = true
    console.log('\n  shutting down (' + signal + ')…')
    if (deps.endpointFile !== undefined) endpoint.remove(deps.endpointFile)
    try { await deps.http.close() } catch (_e) { /* noop */ }
    try { await deps.manager.shutdown() } catch (_e) { /* noop */ }
    console.log('  stopped.')
    process.exit(0)
  }

  process.on('SIGINT', function () { shutdown('SIGINT') })
  process.on('SIGTERM', function () { shutdown('SIGTERM') })

  if (deps.endpointFile !== undefined) {
    try {
      process.stdin.resume()
      process.stdin.on('end', function () { shutdown('parent closed stdin') })
      process.stdin.on('error', function () { /* the parent left without one */ })
    } catch (_e) { /* no stdin to watch */ }
  }
}

async function main() {
  const args = options.parse(process.argv.slice(2))

  // --help and --version are pure text and answer anywhere; everything below
  // needs the Windows exec layer.
  if (args.help) { console.log(options.helpText(VERSION)); return }
  if (args.version) { console.log(VERSION); return }
  if (!requireSupportedPlatform()) { process.exitCode = 1; return }
  if (args.unknown.length > 0) {
    console.error('unknown option: ' + args.unknown[0] + '\n')
    console.error(options.helpText(VERSION))
    process.exitCode = 1
    return
  }

  const quiet = args.status
  const log = quiet ? function () {} : function (message) { console.log('  ' + message) }

  const booted = await createManager({ dataDir: args.data, log })
  const manager = booted.manager

  if (args.status) {
    console.log(JSON.stringify(await manager.cmd('status', {}), null, 2))
    await manager.shutdown()
    return
  }

  let http
  try {
    http = await startServer({
      manager, host: args.host, port: args.port, version: VERSION, log,
    })
  } catch (err) {
    await manager.shutdown()
    console.error(bindFailure(err, args))
    process.exitCode = 1
    return
  }

  const routerStartError = await autostartRouter(manager, args.autostart)

  if (args.endpointFile !== undefined) {
    endpoint.write(args.endpointFile, {
      url: http.url, host: args.host, port: http.port, pid: process.pid, version: VERSION,
    })
  }

  console.log(statusBanner({
    version: VERSION,
    url: http.url,
    dataDir: booted.dataDir,
    status: await manager.cmd('status', {}),
    routerStartError,
  }))

  if (args.open) openBrowser(http.url)

  installShutdown({ http, manager, endpointFile: args.endpointFile })
}

main().catch(function (err) {
  console.error('llama.cpp Studio failed to start:')
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
