// cli/banner.js — the block printed once the app is up.
//
// Formatting-only: everything it says comes from the `status` command, so the
// banner can be read (and changed) without stepping through the boot sequence.
'use strict'

const { INSIDE_PLUGIN, SELF_CONTAINED } = require('../lib/layout.js')

const LABEL_WIDTH = 14

function line(label, value) {
  return '  ' + String(label).padEnd(LABEL_WIDTH) + value
}

function title(version) {
  return '  llama.cpp Studio ' + version
    + (INSIDE_PLUGIN ? '' : ' (standalone)')
    + (SELF_CONTAINED ? '' : '  [not self-contained — run: node pack.js]')
}

/** The API endpoint and mode, or why the router is not there. */
function serverLines(server, routerStartError) {
  const routerActive = server.state === 'RUNNING' && server.mode === 'router'
  if (routerActive && server.endpoint) {
    const loaded = (server.router && server.router.models) ? server.router.models.length : 0
    return [
      line('API Endpoint', server.endpoint + ' (OpenAI-compatible)'),
      line('Mode', 'Router (' + loaded + ' models active)'),
    ]
  }
  if (server.state === 'RUNNING') {
    const endpoint = server.endpoint || 'http://' + server.host + ':' + server.port + '/v1'
    return [
      line('API Endpoint', endpoint + ' (OpenAI-compatible)'),
      line('Mode', server.mode || 'single'),
    ]
  }
  if (routerStartError) return [line('Router', 'not started (' + routerStartError + ')')]
  return []
}

function runtimeLine(versions) {
  const list = (versions && versions.versions) || []
  const active = list.find(function (v) { return v.version === versions.activeVersion }) || list[0]
  if (active === undefined) {
    return line('Runtime', 'not installed — use "Download latest" in the app')
  }
  return line('Runtime', active.version + ' (' + String(active.backend || 'cpu').toUpperCase() + ')'
    + (active.gpuRuntimeOk === false
      ? '  ⚠ no GPU devices — use "Fix GPU runtime" in the app'
      : ''))
}

/** Where a phone on the same network finds the UI, for a wildcard bind. */
function networkLines(urls) {
  return (urls || []).map(function (url, i) { return line(i === 0 ? 'On network' : '', url) })
}

/**
 * fields: { version, url, networkUrls, dataDir, status, routerStartError }
 * `status` is the manager's own status payload.
 */
function statusBanner(fields) {
  const status = fields.status || {}
  const models = (status.models && status.models.models) || []

  return [''].concat(
    [title(fields.version)],
    [line('Web UI', fields.url)],
    networkLines(fields.networkUrls),
    serverLines(status.server || {}, fields.routerStartError),
    [line('Data', fields.dataDir)],
    [runtimeLine(status.versions || {})],
    [line('Models', models.length === 0 ? 'none registered' : models.length + ' registered')],
    ['', '  Press Ctrl+C to stop.', ''],
  ).join('\n')
}

module.exports = { statusBanner, line }
