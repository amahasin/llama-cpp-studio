// monitoring.js — server, system and GPU telemetry. llama-server's own
// Prometheus metrics (/metrics), slot details (/slots) and props (/props) cover
// the model side; one PowerShell helper covers CPU, RAM and the GPU.
//
// The system half samples whether or not a server is running, so the dashboard
// shows live machine utilization at all times.
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util

  // Names as llama-server actually exposes them. The gauges it publishes
  // (prompt_tokens_seconds / predicted_tokens_seconds) only carry the last
  // completed request and read 0 while one is in flight, so throughput is
  // derived from the counters below instead — see _throughput().
  const KNOWN_LLAMA_METRICS = [
    ['prompt_tokens_total', 'promptTokens'],
    ['prompt_tokens_cached_total', 'promptTokensCached'],
    ['prompt_seconds_total', 'promptSeconds'],
    ['tokens_predicted_total', 'generatedTokens'],
    ['tokens_predicted_seconds_total', 'generatedSeconds'],
    ['prompt_tokens_seconds', 'promptPerSecondGauge'],
    ['predicted_tokens_seconds', 'generatedPerSecondGauge'],
    ['n_decode_total', 'decodeCalls'],
    ['n_tokens_max', 'tokensMax'],
    ['n_busy_slots_per_decode', 'busySlotsPerDecode'],
    ['requests_processing', 'requestsProcessing'],
    ['requests_deferred', 'requestsDeferred'],
  ]

  function Monitor(deps) {
    this.deps = deps
    this.snapshot = undefined
    // Previous counter reading, so throughput can be differenced across ticks.
    this._prev = undefined
    this._lastRate = undefined
  }

  function parseMetricsText(text) {
    const map = {}
    for (const line of String(text || '').split(/\r?\n/)) {
      if (line === '' || line.charAt(0) === '#') continue
      const m = line.match(/^llamacpp:([a-zA-Z0-9_:]+)\s+(-?[\d.eE+-]+)\s*$/)
      if (m) {
        const value = parseFloat(m[2])
        if (!isNaN(value)) map[m[1]] = value
      }
    }
    return map
  }

  /**
   * Live generation/prompt speed. Dividing the token counters by the *seconds*
   * counters over the same window gives true throughput while the model is
   * working, rather than a wall-clock average that idle time drags towards
   * zero. When nothing moved in a window the previous rate is kept and the
   * sample is flagged idle, so the tile holds its last real reading instead of
   * flapping to nothing between requests.
   */
  Monitor.prototype._throughput = function (server) {
    const cur = {
      generatedTokens: Number(server.generatedTokens) || 0,
      generatedSeconds: Number(server.generatedSeconds) || 0,
      promptTokens: Number(server.promptTokens) || 0,
      promptSeconds: Number(server.promptSeconds) || 0,
    }
    const prev = this._prev
    this._prev = cur

    // Lifetime averages are available from the first sample onwards.
    if (cur.generatedSeconds > 0) server.generatedPerSecondAvg = cur.generatedTokens / cur.generatedSeconds
    if (cur.promptSeconds > 0) server.promptPerSecondAvg = cur.promptTokens / cur.promptSeconds

    if (prev === undefined) return

    const dGenTokens = cur.generatedTokens - prev.generatedTokens
    const dGenSeconds = cur.generatedSeconds - prev.generatedSeconds
    const dPromptTokens = cur.promptTokens - prev.promptTokens
    const dPromptSeconds = cur.promptSeconds - prev.promptSeconds

    const rate = {}
    if (dGenSeconds > 0 && dGenTokens > 0) rate.generatedPerSecond = dGenTokens / dGenSeconds
    if (dPromptSeconds > 0 && dPromptTokens > 0) rate.promptPerSecond = dPromptTokens / dPromptSeconds

    if (rate.generatedPerSecond !== undefined || rate.promptPerSecond !== undefined) {
      this._lastRate = Object.assign({}, this._lastRate, rate)
      server.idle = false
    } else {
      server.idle = true
    }
    if (this._lastRate !== undefined) {
      if (server.generatedPerSecond === undefined) server.generatedPerSecond = this._lastRate.generatedPerSecond
      if (server.promptPerSecond === undefined) server.promptPerSecond = this._lastRate.promptPerSecond
    }
  }

  /**
   * Throughput while a request is still running. llama-server only advances
   * tokens_predicted_total and its seconds counter when a request *finishes*,
   * so _throughput() has nothing to divide during a long generation and the
   * tile would sit on the previous request's number for minutes. Each slot
   * reports n_decoded as it goes, so differencing that against wall-clock gives
   * a genuinely live figure — which is what someone watching the dashboard
   * during generation is actually asking for.
   *
   * n_decoded restarts at zero for every task, so a drop simply means a new
   * request began and the window is skipped rather than reported as negative.
   */
  Monitor.prototype._slotRate = function (server) {
    const now = Date.now()
    const decoded = (server.slots || []).reduce(function (n, s) { return n + (s.decodedTokens || 0) }, 0)
    const processing = (server.slotsProcessing || 0) > 0
    const prev = this._prevSlots
    this._prevSlots = { at: now, decoded, processing }
    if (prev === undefined || !processing || !prev.processing) return
    const seconds = (now - prev.at) / 1000
    const tokens = decoded - prev.decoded
    if (seconds <= 0.2 || tokens <= 0) return
    server.generatedPerSecond = tokens / seconds
    server.idle = false
    this._lastRate = Object.assign({}, this._lastRate, { generatedPerSecond: server.generatedPerSecond })
  }

  /**
   * KV cache occupancy. llama-server no longer publishes kv_cache_usage_ratio /
   * kv_cache_tokens through /metrics, so the numbers come from /slots, where
   * each slot reports its context size, the prompt it is holding and how much
   * of that prompt came from cache.
   */
  function readSlots(list) {
    const slots = []
    let used = 0
    let ctxTotal = 0
    let cached = 0
    let processing = 0
    for (const s of list) {
      const next = Array.isArray(s.next_token) ? (s.next_token[0] || {}) : (s.next_token || {})
      const decoded = Number(next.n_decoded) || 0
      const prompt = Number(s.n_prompt_tokens) || 0
      const ctx = Number(s.n_ctx) || 0
      used += prompt + decoded
      ctxTotal += ctx
      cached += Number(s.n_prompt_tokens_cache) || 0
      if (s.is_processing === true) processing += 1
      slots.push({
        id: s.id,
        processing: s.is_processing === true,
        nCtx: ctx,
        promptTokens: prompt,
        cachedTokens: Number(s.n_prompt_tokens_cache) || 0,
        decodedTokens: decoded,
        remaining: Number(next.n_remain) || undefined,
      })
    }
    return {
      slots,
      slotsProcessing: processing,
      slotsIdle: slots.length - processing,
      kvCacheTokens: used,
      kvCacheContext: ctxTotal,
      kvCacheRatio: ctxTotal > 0 ? used / ctxTotal : undefined,
      cachedTokens: cached,
    }
  }

  /**
   * One telemetry tick. `proc` is the running llama-server, or undefined when
   * only the machine side should be sampled.
   */
  Monitor.prototype.sample = async function (proc) {
    const out = { at: util.nowIso(), server: {}, system: {}, gpu: { available: false } }

    // ---- machine: one PowerShell start for CPU, RAM, the process and the GPU.
    const sys = await this.deps.hardware.systemMetrics(proc ? proc.pid : 0)
    if (sys.ok) {
      const totalBytes = sys.totalVisibleKB !== undefined ? sys.totalVisibleKB * 1024 : undefined
      const freeBytes = sys.freePhysicalKB !== undefined ? sys.freePhysicalKB * 1024 : undefined
      const usedBytes = totalBytes !== undefined && freeBytes !== undefined ? totalBytes - freeBytes : undefined
      out.system = {
        cpuPercent: sys.cpuLoadPercent,
        logicalProcessors: sys.logicalProcessors,
        totalVisibleBytes: totalBytes,
        freePhysicalBytes: freeBytes,
        usedPhysicalBytes: usedBytes,
        ramPercent: totalBytes ? (usedBytes / totalBytes) * 100 : undefined,
      }
      const p = sys.process
      if (p !== undefined) {
        out.system.processAlive = p.found === true
        if (p.found === true) {
          out.system.processCpuSeconds = p.cpuSeconds
          out.system.processRssBytes = p.workingSetBytes
          out.system.processPrivateBytes = p.privateBytes
          out.system.threads = p.threads
        }
      }
      if (sys.gpu && sys.gpu.available && (sys.gpu.gpus || []).length > 0) {
        out.gpu = {
          available: true,
          gpus: sys.gpu.gpus.map(function (g) {
            const total = Number(g.vramTotalMiB) || 0
            const used = Number(g.vramUsedMiB) || 0
            return Object.assign({}, g, { vramPercent: total > 0 ? (used / total) * 100 : undefined })
          }),
        }
      }
    } else {
      out.system.error = sys.error
    }

    if (!proc) {
      this.snapshot = out
      return out
    }

    // ---- model: llama-server's own endpoints.
    const base = 'http://' + proc.host + ':' + proc.port
    const exec = this.deps.exec
    const serverCfg = (this.deps.config && this.deps.config.get('server')) || {}
    const apiKey = serverCfg.apiKey
    const headers = apiKey ? { Authorization: 'Bearer ' + apiKey } : {}

    let metricsUrl = base + '/metrics'
    let slotsUrl = base + '/slots'
    let isRouterEmpty = false

    if (proc.router === true) {
      const serverMgr = this.deps.server || (proc && proc._server)
      // In router mode, query /v1/models to see which model is currently loaded
      const modelsRes = await exec.httpGetJson(base + '/v1/models', { timeoutMs: 3000, headers })
      const modelList = (modelsRes.ok && modelsRes.data && Array.isArray(modelsRes.data.data)) ? modelsRes.data.data : []
      const loaded = modelList.find(function (m) {
        if (!m.status || m.status.value !== 'loaded') return false
        if (serverMgr && typeof serverMgr.isModelUnloaded === 'function' && serverMgr.isModelUnloaded(m.id)) {
          return false
        }
        return true
      })
      if (loaded && loaded.id) {
        out.server.activeModel = loaded.id
        metricsUrl = base + '/metrics?model=' + encodeURIComponent(loaded.id)
        slotsUrl = base + '/slots?model=' + encodeURIComponent(loaded.id)
      } else {
        // No model loaded in router yet -> metrics are idle, not unavailable
        isRouterEmpty = true
        metricsUrl = undefined
        slotsUrl = undefined
      }
    }

    const fetches = [
      metricsUrl ? exec.httpGetText(metricsUrl, { timeoutMs: 5000, headers }) : Promise.resolve({ ok: false }),
      slotsUrl ? exec.httpGetJson(slotsUrl, { timeoutMs: 5000, headers }) : Promise.resolve({ ok: false }),
      isRouterEmpty ? Promise.resolve({ ok: false }) : exec.httpGetJson(base + '/props', { timeoutMs: 5000, headers }),
    ]

    const [metrics, slots, props] = await Promise.all(fetches)

    if (metrics.ok && metrics.status === 200) {
      const map = parseMetricsText(metrics.text)
      for (const [rawName, nice] of KNOWN_LLAMA_METRICS) {
        if (map[rawName] !== undefined) out.server[nice] = map[rawName]
      }
      out.server.raw = map
      this._throughput(out.server)
    } else if (isRouterEmpty) {
      out.server.idle = true
      out.server.metricsUnavailable = false
    } else {
      // --metrics turned off, or the server is not answering yet.
      out.server.metricsUnavailable = true
    }

    if (slots.ok && slots.status === 200 && Array.isArray(slots.data)) {
      Object.assign(out.server, readSlots(slots.data))
      // Overrides the counter-derived rate while a request is mid-flight.
      this._slotRate(out.server)
    } else if (isRouterEmpty) {
      out.server.slots = []
      out.server.slotsProcessing = 0
      out.server.slotsIdle = 0
      out.server.kvCacheTokens = 0
      out.server.kvCacheRatio = 0
    }

    if (props.ok && props.status === 200 && props.data && typeof props.data === 'object') {
      out.server.props = props.data
      if (out.server.kvCacheContext === undefined && props.data.n_ctx) {
        out.server.kvCacheContext = props.data.n_ctx
      }
    }

    this.snapshot = out
    return out
  }

  // The name the server lifecycle already calls on its own interval.
  Monitor.prototype.poll = async function (proc) {
    if (!proc) return undefined
    return this.sample(proc)
  }

  // The always-on tick: machine telemetry with no server running.
  Monitor.prototype.pollSystem = async function () {
    return this.sample(undefined)
  }

  Monitor.prototype.current = function () {
    return this.snapshot
  }

  LLAMA.modules.push('monitoring')
  LLAMA.monitoring = { Monitor, KNOWN_LLAMA_METRICS, parseMetricsText, readSlots }
})(globalThis.LLAMA)
