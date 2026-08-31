// logs.js — live log ring buffer + rotated persistent logs under logs/.
// deps: { exec, config, fs, timers }
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util

  const MAX_RING_LINES = 6000

  /**
   * Router chatter this app causes and nobody needs to read.
   *
   * In router mode llama.cpp traces every request it forwards to a model
   * instance ("proxying request to model X on port N") at info level. The
   * dashboard polls /metrics and /slots for the loaded model every two seconds,
   * so that is one line per second — 60 a minute, forever, saying nothing the
   * UI does not already show. Left in, it was 80% of the log and evicted the
   * whole ring, and with it every real error, inside two hours.
   *
   * Suppressed rather than silenced: the count is reported periodically, so
   * they are known to exist rather than quietly missing.
   */
  const ROUTINE_ROUTER_NOISE = /proxy_reques\w*:\s*proxying request to model/

  // How many may be dropped before the log says so.
  const NOISE_SUMMARY_EVERY = 250
  const PERSIST_BYTES = 5 * 1024 * 1024 // rotate at 5MB
  const MAX_ROTATIONS = 2

  function LogStore(deps) {
    this.deps = deps
    this.ring = []
    this.seq = 0
    this.file = undefined
    this.pluginFile = util.joinPath(deps.config.get('paths').logsDirectory, 'plugin.log')
    this._flushTimer = undefined
    this._flushPending = false
    this._persistTimer = undefined
    this._dirty = false
    // Sequence numbers of the first ring line not yet written to the server
    // log / plugin log. Without them every flush re-appended the whole ring
    // (see _flush) and every persist dropped the plugin lines from the live
    // view (see _persist).
    this._flushedSeq = 0
    this._persistedSeq = 0
    // Router lines dropped as routine noise (see ROUTINE_ROUTER_NOISE).
    this.suppressed = 0
  }

  LogStore.prototype.start = function () {
    const self = this
    // Periodic persist of the plugin log (ring lines tagged 'plugin').
    this._persistTimer = this.deps.timers.interval(function () {
      self._persist().catch(function () { /* noop */ })
    }, 5000)
  }

  LogStore.prototype.stop = function () {
    if (typeof this._persistTimer === 'function') this._persistTimer()
    this._persistTimer = undefined
    // One last write, awaited by the caller. A run shorter than a single tick
    // — `--status`, a boot that fails, a quick start/stop — otherwise loses
    // every line it produced, and the lines written during init include the
    // relocation notice, which is exactly the thing that must never be silent.
    return this._persist().catch(function () { /* noop */ })
  }

  LogStore.prototype._append = function (stream, text) {
    const lines = util.splitLines(text)
    let kept = 0
    for (const raw of lines) {
      if (raw === '') continue
      if (stream !== 'plugin' && ROUTINE_ROUTER_NOISE.test(raw)) {
        this.suppressed = (this.suppressed || 0) + 1
        if (this.suppressed % NOISE_SUMMARY_EVERY === 0) {
          this._push('plugin', 'suppressed ' + this.suppressed + ' routine "proxying request'
            + ' to model" lines from the router — the dashboard polls it every couple of'
            + ' seconds and each poll writes one')
          kept += 1
        }
        continue
      }
      this._push(stream, raw)
      kept += 1
    }
    if (kept > 0) this._dirty = true
  }

  LogStore.prototype._push = function (stream, raw) {
    this.ring.push({ seq: this.seq, ts: util.nowIso(), stream, text: raw })
    this.seq += 1
    if (this.ring.length > MAX_RING_LINES) this.ring.splice(0, this.ring.length - MAX_RING_LINES)
  }

  LogStore.prototype.plugin = function (message) {
    this._append('plugin', message)
  }

  LogStore.prototype.server = function (stream, text) {
    this._append(stream, text)
  }

  LogStore.prototype.lines = function (opts) {
    const o = opts || {}
    const limit = Math.min(util.toInt(o.limit, 200), 2000)
    const since = o.sinceSeq === undefined ? 0 : Number(o.sinceSeq)
    let out = this.ring.filter((l) => l.seq >= since)
    if (o.stream && o.stream !== 'all') out = out.filter((l) => l.stream === o.stream)
    const query = o.q !== undefined ? o.q : o.query
    if (query) {
      const q = String(query).toLowerCase()
      out = out.filter((l) => l.text.toLowerCase().includes(q))
    }
    return { seq: this.seq, lines: out.slice(-limit) }
  }

  LogStore.prototype.clear = async function () {
    this.ring = []
    this._flushedSeq = this.seq
    this._persistedSeq = this.seq
    if (this.file !== undefined) {
      try {
        const target = await this.deps.fs.resolve(this.file)
        await this.deps.fs.writeText(target, '')
      } catch (_e) { /* noop */ }
    }
    return { ok: true }
  }

  LogStore.prototype.logFilePath = function () {
    return this.file
  }

  // Attach a running server's collected output readers. The poller keeps the
  // ring live and persists to logs/server-<date>.log with rotation.
  LogStore.prototype.attachServer = function (label, collected, timers) {
    const self = this
    let outOffset = 0
    let errOffset = 0
    this.file = util.joinPath(this.deps.config.get('paths').logsDirectory, 'server-' + label + '.log')
    this.deps.exec.ensureDir(this.deps.config.get('paths').logsDirectory).catch(function () { /* noop */ })

    const poll = function () {
      if (collected.stdout) {
        const r = collected.stdout.readFrom(outOffset)
        outOffset = r.nextOffset
        if (r.text) self.server('stdout', r.text)
      }
      if (collected.stderr) {
        const r = collected.stderr.readFrom(errOffset)
        errOffset = r.nextOffset
        if (r.text) self.server('stderr', r.text)
      }
      if (self._flushTimer === undefined) {
        self._flushTimer = timers.interval(function () {
          self._flush().catch(function () { /* noop */ })
        }, 2000)
      }
    }
    const stopPoll = timers.interval(poll, 500)
    return function detach() {
      if (typeof stopPoll === 'function') stopPoll()
      if (typeof self._flushTimer === 'function') self._flushTimer()
      self._flushTimer = undefined
      poll()
      self._flush().catch(function () { /* noop */ })
    }
  }

  LogStore.prototype._flush = async function () {
    if (!this._dirty || this.file === undefined) return
    this._dirty = false
    // Append only what the file does not have yet; the ring is a live view and
    // re-writing all of it every 2s duplicated every line and blew through the
    // rotation cap within minutes.
    const pending = this.ring.filter((l) => l.seq >= this._flushedSeq)
    if (pending.length === 0) return
    try {
      const text = pending.map((l) => l.ts + ' [' + l.stream + '] ' + l.text).join('\n') + '\n'
      const target = await this.deps.fs.resolve(this.file)
      let existing = ''
      let existingBytes = 0
      try {
        existing = await this.deps.fs.readText(target)
        existingBytes = existing.length
      } catch (_e) { /* first write */ }
      if (existingBytes > PERSIST_BYTES) {
        // Rotate: shift the current file to .1 and start fresh.
        try {
          const rot = await this.deps.fs.resolve(this.file + '.1')
          const rotText = existing.slice(-PERSIST_BYTES)
          await this.deps.fs.writeText(rot, rotText)
        } catch (_e) { /* noop */ }
        await this.deps.fs.writeText(target, text)
      } else {
        await this.deps.fs.writeText(target, existing + text)
      }
      this._flushedSeq = pending[pending.length - 1].seq + 1
    } catch (_e) { /* the unwritten lines stay pending for the next flush */ }
  }

  LogStore.prototype._persist = async function () {
    // Append only the plugin lines this file has not seen yet. The lines stay
    // in the ring: it is the live view the Logs page reads, and dropping them
    // here left that page empty whenever no server was running.
    const pending = this.ring.filter((l) => l.stream === 'plugin' && l.seq >= this._persistedSeq)
    if (pending.length === 0) return
    try {
      await this.deps.exec.ensureDir(this.deps.config.get('paths').logsDirectory)
      const target = await this.deps.fs.resolve(this.pluginFile)
      let existing = ''
      try { existing = await this.deps.fs.readText(target) } catch (_e) { /* first write */ }
      if (existing.length > PERSIST_BYTES) {
        const rot = await this.deps.fs.resolve(this.pluginFile + '.1')
        try {
          await this.deps.fs.writeText(rot, existing.slice(-PERSIST_BYTES))
        } catch (_e) { /* noop */ }
        existing = ''
      }
      const text = pending.map((l) => l.ts + ' [plugin] ' + l.text).join('\n') + '\n'
      await this.deps.fs.writeText(target, existing + text)
      this._persistedSeq = pending[pending.length - 1].seq + 1
    } catch (_e) { /* the unwritten lines stay pending for the next tick */ }
  }

  LLAMA.modules.push('logs')
  LLAMA.logs = { LogStore, MAX_RING_LINES, PERSIST_BYTES, MAX_ROTATIONS, ROUTINE_ROUTER_NOISE }
})(globalThis.LLAMA)
