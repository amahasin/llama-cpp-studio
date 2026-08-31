// services/subprocess.js — the harness `subprocess` service, backed by
// node:child_process.
//
// Contract used by the plugin (see src/host/modules/exec.js):
//   spawn({ argv, cwd, env, graceMs, signal, stdio: { stdin, stdout, stderr } })
//     -> { pid, done: Promise<{exitCode, signal}>, collected: { stdout, stderr },
//          terminate() }
//   collected.<stream>.readFrom(offset) -> { text, nextOffset }
//
// Termination is tree-scoped: llama-server spawns worker processes and a plain
// kill() on the parent would leave them holding the port and the GPU.
'use strict'

const { spawn } = require('node:child_process')

const IS_WINDOWS = process.platform === 'win32'

function createCollector(maxBytes) {
  const cap = maxBytes === undefined ? 1024 * 1024 : maxBytes
  let text = ''
  let dropped = 0
  return {
    push(buf) {
      text += buf.toString('utf8')
      if (text.length > cap) {
        dropped += text.length - cap
        text = text.slice(-cap)
      }
    },
    readFrom(offset) {
      const from = Math.max(0, Math.min(Number(offset) || 0, text.length))
      return { text: text.slice(from), nextOffset: text.length }
    },
    get droppedBytes() { return dropped },
  }
}

function createSubprocessService(options) {
  const opts = options || {}
  const log = opts.log || function () {}
  const live = new Set()

  function terminateTree(child) {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (IS_WINDOWS) {
      try {
        spawn('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore',
        })
        return
      } catch (_e) { /* fall through to kill() */ }
    }
    try { child.kill('SIGTERM') } catch (_e) { /* already gone */ }
  }

  const service = {
    spawn(spec) {
      const argv = spec.argv
      if (!Array.isArray(argv) || argv.length === 0) throw new Error('argv must be a non-empty array')
      const stdio = spec.stdio || {}
      const child = spawn(argv[0], argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env ? Object.assign({}, process.env, spec.env) : process.env,
        windowsHide: true,
      })
      const stdout = createCollector(stdio.stdout && stdio.stdout.maxBytes)
      const stderr = createCollector(stdio.stderr && stdio.stderr.maxBytes)
      child.stdout.on('data', function (b) { stdout.push(b) })
      child.stderr.on('data', function (b) { stderr.push(b) })
      if (stdio.stdin && stdio.stdin.data !== undefined) {
        try { child.stdin.write(stdio.stdin.data) } catch (_e) { /* closed early */ }
      }
      try { child.stdin.end() } catch (_e) { /* noop */ }

      const done = new Promise(function (resolve) {
        child.on('close', function (code, signal) {
          live.delete(handle)
          resolve({ exitCode: code, signal: signal || null })
        })
        child.on('error', function (err) {
          live.delete(handle)
          log('subprocess error: ' + String(err && err.message))
          resolve({ exitCode: null, signal: null, error: String(err && err.message) })
        })
      })

      const handle = {
        pid: child.pid,
        done,
        collected: { stdout, stderr },
        terminate() { terminateTree(child) },
      }
      live.add(handle)

      if (spec.signal && typeof spec.signal.addEventListener === 'function') {
        spec.signal.addEventListener('abort', function () { terminateTree(child) }, { once: true })
      }
      return handle
    },

    // Used on shutdown so no llama-server survives the app.
    terminateAll() {
      for (const handle of Array.from(live)) {
        try { handle.terminate() } catch (_e) { /* noop */ }
      }
    },
  }
  return service
}

module.exports = { createSubprocessService }
