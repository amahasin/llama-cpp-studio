// cli/endpoint.js — the handshake with a desktop shell that started us.
//
// The shell starts this process and then has to find the server it just
// started. `--port 0` is the right thing there — the shell must not have to
// guess a free port — so the port is only known once we are listening. Writing
// it to a file the shell named is a contract; scraping it out of the startup
// banner is not.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

function write(file, info) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(info) + '\n')
  } catch (err) {
    console.error('could not write the endpoint file: ' + String(err && err.message))
  }
}

/**
 * Removed first on the way down: while this file exists it advertises a live
 * server, and a shell that reads a stale one waits for a window that will never
 * load.
 */
function remove(file) {
  try { fs.unlinkSync(file) } catch (_e) { /* already gone */ }
}

module.exports = { write, remove }
