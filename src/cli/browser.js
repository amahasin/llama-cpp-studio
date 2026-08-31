// cli/browser.js — hand the UI to whatever the desktop uses for http URLs.
'use strict'

const { spawn } = require('node:child_process')

const OPENERS = {
  win32: function (url) { return ['cmd.exe', ['/c', 'start', '""', url]] },
  darwin: function (url) { return ['open', [url]] },
}

function defaultOpener(url) {
  return ['xdg-open', [url]]
}

function openBrowser(url) {
  const build = OPENERS[process.platform] || defaultOpener
  const [command, args] = build(url)
  try {
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch (_e) { /* the URL is printed anyway */ }
}

module.exports = { openBrowser }
