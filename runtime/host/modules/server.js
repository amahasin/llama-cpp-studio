// server.js — llama-server lifecycle manager.
//
// State machine: STOPPED -> STARTING -> RUNNING -> STOPPING -> STOPPED,
// with FAILED for startup errors and crashes. A server is marked RUNNING only
// after its /health endpoint answers 200. "Auto GPU layers" retries the
// launch with a descending layer ladder (bounded) when a GPU build dies with
// a memory/device error during startup.
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util

  const STATES = ['STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'FAILED', 'UNKNOWN']

  const MEMORY_ERROR_RE = /(out of memory|failed to allocate|allocating[\s\S]{0,80}?failed|cu(da)? error|no (cuda|vulkan|hip) device|no device available|invalid device|device not found|no such device|insufficient (device )?memory|vram|memory error)/i
  const GPU_BACKENDS = ['cuda', 'vulkan', 'hip', 'sycl']

  function ServerManager(deps) {
    this.deps = deps
    this.state = 'STOPPED'
    this.reason = undefined
    this.process = undefined
    this._busy = false
    this._detachLogs = undefined
    this._metricsDispose = undefined
    this.lastError = undefined
    this._generation = 0
  }

  ServerManager.prototype.isRunning = function () { return this.state === 'RUNNING' }

  ServerManager.prototype._setState = function (state, reason) {
    this.state = state
    this.reason = reason
    if (state === 'FAILED' || state === 'STOPPED') this.lastError = reason
    this.deps.progress('server', { state, reason })
  }

  /**
   * The llama.cpp build a launch will use: the one asked for, else the active
   * one, else the first installed. Shared by the single-model and router plans.
   */
  ServerManager.prototype._resolveVersion = async function (opts) {
    const o = opts || {}
    const versions = await this.deps.versions.listInstalled()
    if (versions.versions.length === 0) {
      return {
        ok: false, code: 'NO_LLAMA_CPP', message: 'llama.cpp is not installed yet.',
        remediation: ['Open the llama.cpp page and click "Download Latest".'],
      }
    }
    const want = o.version || versions.activeVersion || versions.versions[0].version
    const versionEntry = versions.versions.find((v) => v.version === want) || versions.versions[0]
    const exeStat = await this.deps.exec.stat(versionEntry.exePath)
    if (exeStat.exists !== true) {
      return {
        ok: false, code: 'EXE_MISSING',
        message: 'llama-server.exe is missing for version ' + versionEntry.version + ': ' + versionEntry.exePath,
        remediation: ['Reinstall version ' + versionEntry.version + ' or remove it and install again.'],
      }
    }
    return { ok: true, versionEntry }
  }

  /**
   * The address to bind, validated and confirmed free. Shared by both plans.
   */
  ServerManager.prototype._resolveBind = async function (opts) {
    const o = opts || {}
    const cfg = this.deps.config.get('server')
    const hostCheck = LLAMA.security.validateHost(o.host || cfg.host)
    if (!hostCheck.ok) return { ok: false, code: hostCheck.code, message: hostCheck.message }
    const portCheck = LLAMA.security.validatePort(o.port !== undefined ? o.port : cfg.port)
    if (!portCheck.ok) return { ok: false, code: portCheck.code, message: portCheck.message }
    const portStatus = o.previewOnly === true ? { ok: false } : await this.deps.exec.portStatus(portCheck.port)
    if (portStatus.ok && portStatus.open === true) {
      return {
        ok: false, code: 'PORT_IN_USE',
        message: 'Port ' + portCheck.port + ' is already in use (PID: ' + (portStatus.pids.join(', ') || 'unknown') + ').',
        remediation: ['Choose a different port in Server Settings.', 'Stop the application using that port.'],
      }
    }
    return { ok: true, host: hostCheck.host, port: portCheck.port }
  }

  /**
   * Multimodal projector for one model: an explicit path wins, otherwise the
   * one detected next to the model file (vision models ship mmproj-*.gguf).
   *
   * Vision off is checked first and drops the projector however it was found,
   * including a path saved earlier. It has to outrank detection: detection is
   * the whole reason there was no way to run a vision model as text only —
   * clearing the path just handed it straight back.
   *
   * Mutates and returns `profile`.
   */
  ServerManager.prototype._resolveVision = async function (profile, model) {
    if (profile.vision === false) {
      delete profile.mmproj
      return profile
    }
    let mmproj = profile.mmproj
    if (mmproj === undefined || mmproj === '') {
      mmproj = model.mmprojPath
      if (mmproj === undefined && typeof this.deps.models.detectMmproj === 'function') {
        const found = await this.deps.models.detectMmproj(model.path)
        mmproj = found.mmproj
      }
    }
    if (mmproj !== undefined && mmproj !== '') {
      const mmStat = await this.deps.exec.stat(mmproj)
      if (mmStat.exists === true && mmStat.isDir !== true) profile.mmproj = mmproj
      else delete profile.mmproj
    }
    return profile
  }

  /**
   * The multi-token-prediction head for one model: an explicit path wins,
   * otherwise the one recorded when the model was imported or downloaded, and
   * finally a scan of the directory beside the model.
   *
   * llama.cpp consumes it as the draft model for speculative decoding, so it is
   * put on `draftModel` rather than passed as a flag of its own. Turning MTP off
   * is checked first and drops the head however it was found, exactly as vision
   * does — otherwise detection would keep handing it straight back.
   *
   * Mutates and returns `profile`.
   */
  ServerManager.prototype._resolveMtp = async function (profile, model) {
    if (profile.mtp === false) {
      delete profile.draftModel
      return profile
    }
    let head = profile.mtpPath
    if (head === undefined || head === '') {
      head = model.mtpPath
      if (head === undefined && typeof this.deps.models.detectMtp === 'function') {
        const found = await this.deps.models.detectMtp(model.path)
        head = found.mtp
      }
    }
    if (head !== undefined && head !== '') {
      const stat = await this.deps.exec.stat(head)
      if (stat.exists === true && stat.isDir !== true) profile.draftModel = head
      else delete profile.draftModel
    }
    return profile
  }

  /**
   * How many layers to offload when the profile says "auto", plus the two
   * numbers the offload report is built from. Shared so a model served through
   * the router is planned the same way as one served on its own.
   */
  ServerManager.prototype._autoGpuLayers = function (model, profile, backend, hw) {
    const meta = model.metadata || {}
    // block_count is the authoritative transformer layer count; layerCount can
    // still hold a pre-fix tensor tally on models registered earlier.
    const layerCount = util.toInt(meta.blockCount || meta.layerCount, 0)
    const kvPerLayer = this.deps.hardware.estimateKvBytesPerLayer(
      meta, profile.contextSize, profile.cacheTypeK, profile.cacheTypeV)
    if (!GPU_BACKENDS.includes(backend)) return { gpuLayers: 0, layerCount, kvPerLayer }
    const freeVram = (hw && hw.cuda && hw.cuda.vramFreeMiB) ? hw.cuda.vramFreeMiB * 1024 * 1024 : undefined
    const est = this.deps.hardware.estimateAutoGpuLayers(model.sizeBytes, layerCount, freeVram, kvPerLayer)
    const gpuLayers = est !== undefined && est > 0 ? est : (est === 0 ? 0 : 999)
    return { gpuLayers, layerCount, kvPerLayer }
  }

  /**
   * Resolve everything the launch needs and return a launch plan or an error.
   */
  ServerManager.prototype._plan = async function (opts) {
    const o = opts || {}
    const deps = this.deps
    const config = deps.config

    // 1. Model.
    let model
    if (o.modelId) {
      const r = await deps.models.get(o.modelId)
      if (!r.ok) return { ok: false, code: r.code, message: r.message }
      model = r.model
    } else if (o.modelPath) {
      const registered = await deps.models.byPath(o.modelPath)
      if (registered) {
        model = registered
      } else {
        // Unregistered file: inspect on the fly, do not persist.
        const stat = await deps.exec.stat(o.modelPath)
        if (stat.exists !== true || stat.isDir === true) {
          return { ok: false, code: 'MODEL_MISSING', message: 'Model file not found: ' + o.modelPath }
        }
        const inspect = await deps.models.inspectFile(o.modelPath)
        model = {
          id: undefined,
          name: util.basename(o.modelPath),
          path: o.modelPath,
          managed: false,
          sizeBytes: stat.size,
          metadata: inspect.ok ? inspect.metadata : {},
        }
      }
    } else {
      return { ok: false, code: 'NO_MODEL', message: 'Select a model to start (modelId or modelPath).' }
    }
    const stat = await deps.exec.stat(model.path)
    if (stat.exists !== true || stat.isDir === true) {
      return {
        ok: false, code: 'MODEL_MISSING', message: 'Model file not found: ' + model.path,
        remediation: ['Re-import or re-download the model.', 'Check that the file was not moved.'],
      }
    }

    // 2. llama.cpp version.
    const version = await this._resolveVersion(o)
    if (!version.ok) return version
    const versionEntry = version.versionEntry

    // 3. Launch settings. Precedence: explicit profile object > named profile >
    //    the model's own saved settings > defaults derived from the GGUF.
    const hwForDefaults = await deps.hardware.detect()
    const baseProfile = LLAMA.profiles.defaultProfile({ metadata: model.metadata || {}, hardware: hwForDefaults })
    let profile
    if (o.profile && util.isPlainObject(o.profile)) {
      profile = util.deepMerge(baseProfile, o.profile)
    } else if (o.profileId) {
      const r = await deps.profiles.get(o.profileId)
      if (!r.ok) return { ok: false, code: r.code, message: r.message }
      profile = util.deepMerge(baseProfile, r.profile)
    } else if (model.settings && util.isPlainObject(model.settings)) {
      profile = util.deepMerge(baseProfile, model.settings)
    } else {
      profile = baseProfile
    }

    // Server-scoped flags always come from Server Config, never from a model.
    const srvCfg = config.get('server') || {}
    profile = util.deepMerge(profile, {
      parallel: srvCfg.parallel !== undefined ? srvCfg.parallel : profile.parallel,
      contBatching: srvCfg.contBatching !== false,
      cacheReuse: srvCfg.cacheReuse,
      threadsHttp: srvCfg.threadsHttp,
      metrics: srvCfg.metrics !== false,
      noWebui: srvCfg.webui === false,
      apiKey: srvCfg.apiKey,
      slots: srvCfg.slots !== false,
      webPath: srvCfg.webPath,
      sslKeyFile: srvCfg.sslKeyFile,
      sslCertFile: srvCfg.sslCertFile,
    })
    profile.apiKeyFile = await this._apiKeyFile(srvCfg.apiKey, versionEntry.capabilities || {})

    await this._resolveVision(profile, model)
    await this._resolveMtp(profile, model)

    // 4. Backend validation against the installed build.
    const requestedBackend = o.backend || config.get('hardware').backend || 'auto'
    const buildBackend = versionEntry.backend || 'cpu'
    if (requestedBackend !== 'auto' && requestedBackend !== buildBackend) {
      return {
        ok: false, code: 'BACKEND_MISMATCH',
        message: 'The requested backend "' + requestedBackend + '" does not match the active build ('
          + buildBackend + ').',
        remediation: [
          'Set the backend to Auto or "' + buildBackend + '".',
          'Install a "' + requestedBackend + '" build and activate it.',
        ],
      }
    }

    // 5. GPU layers. The KV cache of every offloaded layer lives in VRAM too,
    //    so the context size and cache types are part of this decision.
    const hw = hwForDefaults
    const auto = this._autoGpuLayers(model, profile, buildBackend, hw)
    const layerCount = auto.layerCount
    const kvPerLayer = auto.kvPerLayer
    const kvTotal = kvPerLayer !== undefined && layerCount > 0 ? kvPerLayer * layerCount : undefined
    let gpuLayers = o.gpuLayers !== undefined ? o.gpuLayers : profile.gpuLayers
    const gpuLayersAuto = gpuLayers === undefined || gpuLayers === 'auto'
    if (gpuLayersAuto) gpuLayers = auto.gpuLayers
    gpuLayers = util.toInt(gpuLayers, 0)

    // 6. Host/port.
    const bind = await this._resolveBind(o)
    if (!bind.ok) return bind
    const hostCheck = { host: bind.host }
    const portCheck = { port: bind.port }

    // 7. Threads.
    let threads = o.threads !== undefined ? o.threads : profile.threads
    if (threads === 'auto' || threads === undefined) threads = hw.cpu.physicalCores || hw.cpu.logicalCores || 8

    const profileUsed = util.deepMerge(profile, { gpuLayers, threads })
    const argv = LLAMA.commandBuilder.build(
      { path: model.path, name: model.name, profile: profileUsed },
      versionEntry,
      { host: hostCheck.host, port: portCheck.port },
    )
    if (!argv.ok) return argv

    // Surface the offload picture so the UI never has to guess why weights
    // ended up in system RAM.
    const offload = {
      layerCount: layerCount > 0 ? layerCount : undefined,
      gpuLayers,
      auto: gpuLayersAuto,
      kvBytesPerLayer: kvPerLayer,
      kvBytesTotal: kvTotal,
      kvBytesOnGpu: kvPerLayer !== undefined ? kvPerLayer * Math.min(gpuLayers, layerCount || gpuLayers) : undefined,
      vramFreeBytes: (hw.cuda && hw.cuda.vramFreeMiB) ? hw.cuda.vramFreeMiB * 1024 * 1024 : undefined,
      cpuMoeLayers: util.toInt(profileUsed.nCpuMoe, 0) || undefined,
      backend: buildBackend,
    }
    if (GPU_BACKENDS.includes(buildBackend) && layerCount > 0 && gpuLayers < layerCount) {
      offload.note = 'Only ' + gpuLayers + ' of ' + layerCount
        + ' layers fit in VRAM at this context size — the rest run on the CPU.'
    }
    if (offload.cpuMoeLayers) {
      offload.moeNote = 'Expert weights of the first ' + offload.cpuMoeLayers
        + ' layers are pinned to system RAM by --n-cpu-moe.'
    }
    // A CUDA build whose runtime companion is missing sees no devices and
    // quietly runs on the CPU — say so before the model loads.
    if (GPU_BACKENDS.includes(buildBackend) && gpuLayers > 0 && versionEntry.gpuRuntimeOk === false) {
      offload.runtimeBroken = true
      offload.runtimeNote = 'The installed ' + buildBackend.toUpperCase() + ' build reports no GPU devices, so'
        + ' llama-server will run on the CPU. Open the llama.cpp page and use "Fix GPU runtime".'
    }

    return {
      ok: true,
      model, versionEntry, profileUsed, argv: argv.argv, warnings: argv.warnings,
      host: hostCheck.host, port: portCheck.port, backend: buildBackend,
      gpuLayers, threads, offload,
    }
  }

  // A model id clients ask for: the file name without .gguf, reduced to what
  // llama.cpp and an HTTP client will both carry without argument.
  function routerIdFor(model, taken) {
    const base = util.stripExt(util.basename(String(model.name || model.path || 'model')))
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
    let id = base === '' ? 'model' : base
    // Two files can share a name in different folders; the id has to be unique
    // because it is what a request selects.
    if (taken.has(id.toLowerCase())) {
      let n = 2
      while (taken.has((id + '-' + n).toLowerCase())) n += 1
      id = id + '-' + n
    }
    taken.add(id.toLowerCase())
    return id
  }

  /**
   * Resolve a router launch.
   *
   * Router mode hands llama-server the whole library at once: it binds the
   * port, and spawns a child server per model on demand from an INI preset
   * file. So the plan is not "one model plus its flags" but "every model plus
   * its flags", written to disk — and each section comes from the same
   * commandBuilder the single-model path uses, so a model serves through the
   * router exactly as it would have served on its own.
   *
   * A model that cannot be planned is left out with a warning rather than
   * failing the launch: one bad entry must not cost you the rest of the
   * library.
   */
  ServerManager.prototype._planRouter = async function (opts) {
    const o = opts || {}
    const deps = this.deps
    const config = deps.config
    const serverCfg = config.get('server') || {}

    const version = await this._resolveVersion(o)
    if (!version.ok) return version
    const versionEntry = version.versionEntry
    const caps = versionEntry.capabilities || {}
    const capsHave = LLAMA.commandBuilder.capsHave

    if (!capsHave(caps, ['models-preset'])) {
      return {
        ok: false, code: 'NO_ROUTER_SUPPORT',
        message: 'llama.cpp build ' + versionEntry.version + ' has no router mode'
          + ' — it does not support --models-preset.',
        remediation: [
          'Install a newer llama.cpp build from the llama.cpp page.',
          'Or set Server mode back to "Single model" in Server Config.',
        ],
      }
    }

    const bind = await this._resolveBind(o)
    if (!bind.ok) return bind

    const listed = await deps.models.list()
    const hw = await deps.hardware.detect()
    const buildBackend = versionEntry.backend || 'cpu'
    const requestedBackend = o.backend || config.get('hardware').backend || 'auto'
    if (requestedBackend !== 'auto' && requestedBackend !== buildBackend) {
      return {
        ok: false, code: 'BACKEND_MISMATCH',
        message: 'The requested backend "' + requestedBackend + '" does not match the active build ('
          + buildBackend + ').',
        remediation: [
          'Set the backend to Auto or "' + buildBackend + '".',
          'Install a "' + requestedBackend + '" build and activate it.',
        ],
      }
    }

    const warnings = []
    const entries = []
    const taken = new Set()
    for (const model of listed.models || []) {
      if (model.missing === true) {
        warnings.push('"' + model.name + '" is not in the router: its file is missing.')
        continue
      }
      const base = LLAMA.profiles.defaultProfile({ metadata: model.metadata || {}, hardware: hw })
      const profile = util.deepMerge(base, model.settings || {})
      await this._resolveVision(profile, model)
      await this._resolveMtp(profile, model)
      if (profile.gpuLayers === undefined || profile.gpuLayers === 'auto') {
        profile.gpuLayers = this._autoGpuLayers(model, profile, buildBackend, hw).gpuLayers
      }
      if (profile.threads === 'auto' || profile.threads === undefined) {
        profile.threads = hw.cpu.physicalCores || hw.cpu.logicalCores || 8
      }
      // Server-scoped flags belong to the router process, not to the children
      // it spawns; leaving them in a preset would bind a second listener.
      for (const key of ['apiKey', 'apiKeyFile', 'webPath', 'sslKeyFile', 'sslCertFile', 'noWebui', 'slots']) {
        delete profile[key]
      }
      entries.push({
        id: routerIdFor(model, taken),
        modelId: model.id,
        model: { path: model.path, name: model.name, profile },
      })
    }

    const preset = LLAMA.commandBuilder.buildPreset(entries, versionEntry)
    if (!preset.ok) {
      return {
        ok: false, code: preset.code, message: preset.message,
        remediation: ['Import a model on the Models page.'],
        warnings: warnings.concat(preset.warnings || []),
      }
    }
    for (const w of preset.warnings || []) warnings.push(w)

    const presetPath = util.joinPath(config.get('paths').configsDirectory, 'router-presets.ini')
    if (o.previewOnly !== true) {
      try {
        const target = await deps.fs.resolve(presetPath)
        await deps.fs.writeText(target, preset.ini)
      } catch (err) {
        return {
          ok: false, code: 'PRESET_WRITE_FAILED',
          message: 'Could not write the router preset file ' + presetPath + ': ' + String(err && err.message),
        }
      }
    }

    const argv = ['--models-preset', presetPath, '--host', bind.host, '--port', String(bind.port)]
    const max = util.toInt(serverCfg.routerModelsMax, 1)
    if (capsHave(caps, ['models-max'])) argv.push('--models-max', String(max))
    if (serverCfg.routerAutoload === false && capsHave(caps, ['no-models-autoload'])) {
      argv.push('--no-models-autoload')
    }
    // Server-scoped flags apply to the router itself: it is the HTTP server.
    // Prefer the file: the router process is long-lived, and its command line
    // is readable by anything on the machine for as long as it runs.
    const keyFile = await this._apiKeyFile(serverCfg.apiKey, caps)
    if (keyFile !== undefined) argv.push('--api-key-file', keyFile)
    else if (serverCfg.apiKey && capsHave(caps, ['api-key'])) argv.push('--api-key', serverCfg.apiKey)
    if (serverCfg.webui === false && capsHave(caps, ['no-webui'])) argv.push('--no-webui')
    if (serverCfg.metrics !== false && capsHave(caps, ['metrics'])) argv.push('--metrics')
    if (serverCfg.webPath && capsHave(caps, ['path'])) argv.push('--path', serverCfg.webPath)
    if (serverCfg.sslKeyFile && serverCfg.sslCertFile && capsHave(caps, ['ssl-key-file'])) {
      argv.push('--ssl-key-file', serverCfg.sslKeyFile, '--ssl-cert-file', serverCfg.sslCertFile)
    }
    const argCheck = LLAMA.security.validateArgv(argv)
    if (!argCheck.ok) return { ok: false, code: argCheck.code, message: argCheck.message }

    return {
      ok: true,
      router: true,
      versionEntry,
      argv,
      warnings,
      host: bind.host,
      port: bind.port,
      backend: buildBackend,
      presetPath,
      presetIni: preset.ini,
      sections: preset.sections,
      modelsMax: max,
      autoload: serverCfg.routerAutoload !== false,
    }
  }

  /**
   * The router plan without starting anything: the argv, the preset file it
   * would be given and what is in it. Nothing is written to disk.
   */
  ServerManager.prototype.previewRouter = async function (opts) {
    const plan = await this._planRouter(Object.assign({}, opts || {}, { previewOnly: true }))
    if (!plan.ok) return plan
    return {
      ok: true,
      exePath: plan.versionEntry.exePath,
      argv: plan.argv,
      commandLine: [plan.versionEntry.exePath].concat(plan.argv)
        .map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' '),
      presetPath: plan.presetPath,
      preset: plan.presetIni,
      models: plan.sections.map(function (s) {
        return { id: s.id, modelId: s.modelId, name: s.name, path: s.path }
      }),
      version: plan.versionEntry.version,
      backend: plan.backend,
      modelsMax: plan.modelsMax,
      autoload: plan.autoload,
      warnings: plan.warnings,
    }
  }

  /**
   * Resolve a launch without starting anything: the exact argv llama-server
   * would be given, plus the effective settings. Used by the Model Settings
   * dialog to show the real command line before saving.
   */
  ServerManager.prototype.preview = async function (opts) {
    const plan = await this._plan(Object.assign({}, opts || {}, { previewOnly: true }))
    if (!plan.ok) return plan
    return {
      ok: true,
      exePath: plan.versionEntry.exePath,
      argv: plan.argv,
      commandLine: [plan.versionEntry.exePath].concat(plan.argv)
        .map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' '),
      warnings: plan.warnings,
      profileUsed: plan.profileUsed,
      gpuLayers: plan.gpuLayers,
      threads: plan.threads,
      backend: plan.backend,
      version: plan.versionEntry.version,
      offload: plan.offload,
    }
  }

  ServerManager.prototype._retryLadder = function (initialNgl) {
    if (initialNgl <= 0) return [0]
    if (initialNgl >= 999) return [999, 99, 60, 32, 16, 8, 0]
    const ladder = [initialNgl]
    const steps = [Math.ceil(initialNgl * 0.66), Math.ceil(initialNgl * 0.33), 0]
    for (const s of steps) {
      if (s !== ladder[ladder.length - 1]) ladder.push(s)
    }
    return ladder
  }

  /**
   * Start the server. opts: { modelId|modelPath, profileId|profile, gpuLayers,
   * backend, port, host, version, retryMax }
   */
  ServerManager.prototype.start = async function (opts) {
    if (this._busy) return { ok: false, code: 'SERVER_BUSY', message: 'A server operation is already in progress.' }
    if (this.state === 'RUNNING' || this.state === 'STARTING') {
      return { ok: false, code: 'ALREADY_RUNNING', message: 'A server is already running. Stop it first or use Restart.' }
    }
    this._busy = true
    const generation = ++this._generation
    try {
      const o = opts || {}
      const mode = o.mode || (this.deps.config.get('server') || {}).mode || 'single'
      if (mode === 'router') {
        const plan = await this._planRouter(o)
        if (!plan.ok) return plan
        this._lastOpts = util.deepClone(o)
        // No retry ladder: there is no single --n-gpu-layers to walk down. Each
        // model carries its own offload in the preset, and the router loads
        // them one at a time long after this launch has succeeded.
        return await this._launchOnce(plan, plan.argv, generation)
      }
      const plan = await this._plan(o)
      if (!plan.ok) return plan
      this._lastOpts = util.deepClone(o)
      return await this._startWithRetries(plan, o, generation)
    } finally {
      this._busy = false
    }
  }

  // ---------- router runtime ----------

  ServerManager.prototype._routerBase = function () {
    const proc = this.process
    if (!proc || proc.router !== true) return undefined
    return 'http://' + proc.host + ':' + proc.port
  }

  ServerManager.prototype._routerHeaders = function () {
    const key = (this.deps.config.get('server') || {}).apiKey
    return key ? { Authorization: 'Bearer ' + key } : {}
  }

  /**
   * The API key written where llama-server can read it, or undefined when that
   * is not possible. `--api-key KEY` puts the key on a command line that any
   * local process can read for the whole life of the server; `--api-key-file`
   * does not. Builds that predate the flag keep the old behaviour rather than
   * silently starting with no authentication at all.
   */
  ServerManager.prototype._apiKeyFile = async function (key, caps) {
    const capsHave = LLAMA.commandBuilder.capsHave
    if (!key || !capsHave(caps, ['api-key-file'])) return undefined
    const dir = (this.deps.config.get('paths') || {}).configsDirectory
    if (!dir) return undefined
    const file = util.joinPath(dir, 'api-key.txt')
    try {
      await this.deps.exec.ensureDir(dir)
      const target = await this.deps.fs.resolve(file)
      // llama-server reads one key per line; comments start with '#'.
      await this.deps.fs.writeText(target, key + '\n')
    } catch (_e) {
      return undefined
    }
    return file
  }

  /**
   * What the router is serving, with each model's load state. The registered
   * model behind each id is matched back on, so the UI can show a library
   * entry rather than a bare name — and models the router found on its own
   * (llama.cpp keeps its own download cache) are marked as not ours.
   */
  ServerManager.prototype.routerModels = async function () {
    const base = this._routerBase()
    if (base === undefined) {
      return { ok: false, code: 'NOT_ROUTER', message: 'The server is not running in router mode.' }
    }
    const r = await this.deps.exec.httpGetJson(base + '/v1/models', {
      timeoutMs: 5000, secretHeaders: this._routerHeaders(),
    })
    if (!r.ok || r.status !== 200) {
      return { ok: false, code: 'ROUTER_UNREACHABLE', message: r.message || ('HTTP ' + r.status) }
    }
    const known = new Map()
    for (const s of this.process.sections || []) known.set(s.id, s)

    // llama.cpp reports a model as loading or loaded and nothing in between —
    // there is no progress figure to pass on, at any log verbosity. Timing how
    // long the load has been going is the honest substitute: on a 20GB model
    // that is the difference between "working" and "stuck".
    const since = this._loadingSince || (this._loadingSince = {})
    const now = Date.now()

    const models = ((r.data && r.data.data) || [])
      .filter(function (m) { return known.has(m.id) })
      .map(function (m) {
        const mine = known.get(m.id)
        const state = (m.status && m.status.value) || 'unknown'
        const working = state === 'loading' || state === 'unloading'
        if (working) {
          if (since[m.id] === undefined) since[m.id] = now
        } else {
          delete since[m.id]
        }
        const row = {
          id: m.id,
          state,
          modelId: mine ? mine.modelId : undefined,
          name: mine ? mine.name : m.id,
          path: mine ? mine.path : undefined,
          managed: true,
        }
        // Only present while it is actually working. Set to undefined instead,
        // it would cross the command boundary as null — jsonSafe() rewrites
        // undefined that way — and read as a number that is not one.
        if (working) row.workingSeconds = Math.max(0, Math.round((now - since[m.id]) / 1000))
        return row
      })
    return { ok: true, models }
  }

  ServerManager.prototype._routerCommand = async function (path, id) {
    const base = this._routerBase()
    if (base === undefined) {
      return { ok: false, code: 'NOT_ROUTER', message: 'The server is not running in router mode.' }
    }
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, code: 'NO_MODEL', message: 'Name the model to act on.' }
    }
    const r = await this.deps.exec.httpPostJson(base + path, { model: id.trim() }, {
      timeoutMs: 15000, secretHeaders: this._routerHeaders(),
    })
    if (!r.ok) return { ok: false, code: 'ROUTER_UNREACHABLE', message: r.message }
    if (r.status !== 200 || !(r.data && r.data.success === true)) {
      const detail = (r.data && r.data.error && r.data.error.message) || r.body || ('HTTP ' + r.status)
      return { ok: false, code: 'ROUTER_REFUSED', message: String(detail) }
    }
    return { ok: true, model: id.trim() }
  }

  /**
   * Ask the router to load a model now. Loading is asynchronous: this returns
   * as soon as the router accepts, and the model moves through `loading` to
   * `loaded` in routerModels().
   */
  ServerManager.prototype.loadModel = function (id) {
    return this._routerCommand('/models/load', id)
  }

  ServerManager.prototype.unloadModel = function (id) {
    return this._routerCommand('/models/unload', id)
  }

  ServerManager.prototype._startWithRetries = async function (plan, opts, generation) {
    const deps = this.deps
    const config = deps.config
    const serverCfg = config.get('server')
    const retryMax = util.clamp(util.toInt(opts.retryMax, serverCfg.autoRetryMax || 4), 1, 6)
    const ladder = this._retryLadder(plan.gpuLayers).slice(0, retryMax)
    const retriable = GPU_BACKENDS.includes(plan.backend) && ladder.length > 1
    let attempt = 0
    let lastFailure = undefined

    for (const ngl of ladder) {
      attempt += 1
      if (attempt > 1) {
        deps.log('retry ' + attempt + '/' + ladder.length + ' with --n-gpu-layers ' + ngl)
        deps.progress('server', { state: 'STARTING', attempt, ngl, message: 'Retrying with GPU layers ' + ngl })
      }
      const overrides = { gpuLayers: ngl }
      const argv = LLAMA.commandBuilder.build(
        { path: plan.model.path, name: plan.model.name, profile: plan.profileUsed },
        plan.versionEntry,
        { host: plan.host, port: plan.port },
        overrides,
      )
      if (!argv.ok) return argv

      const outcome = await this._launchOnce(plan, argv.argv, generation, ngl)
      if (outcome.ok) {
        if (ngl !== plan.gpuLayers) {
          // The requested offload did not fit; say so instead of quietly
          // running a slower configuration.
          const message = 'Started with --n-gpu-layers ' + ngl + ' instead of ' + plan.gpuLayers
            + ' — the requested offload did not fit in VRAM.'
          deps.log(message)
          deps.progress('server', { state: 'RUNNING', message, ngl })
          outcome.degraded = { requestedGpuLayers: plan.gpuLayers, gpuLayers: ngl, message }
        }
        return outcome
      }
      lastFailure = outcome
      const memoryLike = MEMORY_ERROR_RE.test(String(outcome.logTail || ''))
      if (!retriable || !memoryLike) break
      // The crash was memory/device related: try fewer layers.
    }

    this._setState('FAILED', lastFailure ? lastFailure.message : 'startup failed')
    return lastFailure || { ok: false, code: 'START_FAILED', message: 'Server failed to start.' }
  }

  ServerManager.prototype._launchOnce = async function (plan, argv, generation, gpuLayersUsed) {
    const deps = this.deps
    const config = deps.config
    const serverCfg = config.get('server')

    this._setState('STARTING')
    deps.log('launching llama-server ' + plan.versionEntry.version + ' (' + plan.backend + ') '
      + (plan.router
        ? 'router with ' + plan.sections.length + ' model' + (plan.sections.length === 1 ? '' : 's')
        : 'model=' + plan.model.name))
    deps.progress('server', { state: 'STARTING', message: 'Launching llama-server...', argv })

    let handle
    try {
      handle = deps.subprocess.spawn({
        argv: [plan.versionEntry.exePath].concat(argv),
        cwd: plan.versionEntry.path,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 2 * 1024 * 1024, spill: { maxBytes: 64 * 1024 * 1024 } },
          stderr: { maxBytes: 2 * 1024 * 1024, spill: { maxBytes: 64 * 1024 * 1024 } },
        },
        graceMs: 15000,
      })
    } catch (err) {
      const message = 'Could not spawn llama-server.exe: ' + String(err && err.message)
      deps.log(message)
      this._setState('FAILED', message)
      return {
        ok: false, code: 'SPAWN_FAILED', message,
        remediation: ['Check that the file exists and is executable: ' + plan.versionEntry.exePath],
      }
    }

    // The retry ladder can lower the offload, so the process carries the value
    // actually passed to llama-server — never the requested one.
    const effectiveNgl = gpuLayersUsed === undefined ? plan.gpuLayers : gpuLayersUsed
    const proc = {
      handle,
      pid: handle.pid,
      version: plan.versionEntry.version,
      backend: plan.backend,
      // A router serves the whole library, so there is no one model, no one
      // profile and no one offload figure — those belong to the child servers
      // it spawns per model. `sections` is what it was given instead.
      router: plan.router === true,
      sections: plan.sections,
      presetPath: plan.presetPath,
      modelsMax: plan.modelsMax,
      autoload: plan.autoload,
      model: plan.model,
      profile: plan.router ? {} : util.deepMerge(plan.profileUsed, { gpuLayers: effectiveNgl }),
      requestedGpuLayers: plan.gpuLayers,
      offload: plan.router ? {} : util.deepMerge(plan.offload || {}, { gpuLayers: effectiveNgl }),
      argv,
      host: plan.host,
      port: plan.port,
      endpoint: 'http://' + plan.host + ':' + plan.port + '/v1',
      startedAt: Date.now(),
      generation,
    }
    this.process = proc
    const detach = deps.logs.attachServer(plan.versionEntry.version + '-' + proc.pid, handle.collected, deps.timers)
    this._detachLogs = detach

    // Crash watch: the handle.done promise settles when the tree exits.
    let exited = false
    let exitOutcome = undefined
    handle.done.then((outcome) => {
      exited = true
      exitOutcome = outcome
      if (generation === this._generation && this.process === proc) {
        const message = 'llama-server exited during ' + this.state + ' (code ' + outcome.exitCode
          + (outcome.signal ? ', signal ' + outcome.signal : '') + ').'
        deps.log(message)
        if (this.state === 'STARTING' || this.state === 'RUNNING') {
          this.process = undefined
          this._setState('FAILED', message)
          if (typeof detach === 'function') detach()
          this._detachLogs = undefined
        }
      }
    }).catch(function () { /* spawn-level failure already handled */ })

    // Readiness poll against /health.
    const timeoutMs = serverCfg.startupTimeoutMs || 180000
    const intervalMs = serverCfg.healthIntervalMs || 500
    const started = Date.now()
    let ready = false
    let healthStatus = undefined
    while (!exited && Date.now() - started < timeoutMs) {
      const h = await deps.exec.httpGetJson('http://' + plan.host + ':' + plan.port + '/health', { timeoutMs: 4000 })
      if (h.ok && h.status === 200) {
        ready = true
        healthStatus = h.data
        break
      }
      healthStatus = h.ok ? h.data : undefined
      await deps.timers.sleep(intervalMs)
    }

    if (!ready) {
      if (exited) {
        const tail = this._stderrTail()
        const message = 'llama-server exited before becoming ready (exit ' + (exitOutcome && exitOutcome.exitCode) + ').'
        return { ok: false, code: 'EXIT_BEFORE_READY', message, logTail: tail, exited: true }
      }
      // Timeout: terminate and fail.
      try { handle.terminate() } catch (_e) { /* noop */ }
      const tail = this._stderrTail()
      const message = 'Timed out after ' + Math.round(timeoutMs / 1000) + 's waiting for the server to become ready.'
      if (typeof detach === 'function') detach()
      this._detachLogs = undefined
      this.process = undefined
      this._setState('FAILED', message)
      return {
        ok: false, code: 'START_TIMEOUT', message, logTail: tail,
        remediation: [
          'The model may be too large for the available RAM/VRAM — try fewer GPU layers or a smaller quantization.',
          'Increase the startup timeout in Server Settings.',
          'Check the Logs page for the last errors printed by llama-server.',
        ],
      }
    }

    // RUNNING — verified by health check.
    this._setState('RUNNING')
    proc.readyAt = Date.now()
    proc.health = healthStatus
    deps.log('server RUNNING: ' + proc.endpoint + ' (pid ' + proc.pid + ', backend ' + proc.backend
      + (proc.router
        ? ', router over ' + proc.sections.length + ' model' + (proc.sections.length === 1 ? '' : 's')
          + ', up to ' + (proc.modelsMax === 0 ? 'unlimited' : proc.modelsMax) + ' loaded at once'
        : ', ngl ' + effectiveNgl + (proc.offload.layerCount ? '/' + proc.offload.layerCount : '')
          + (proc.offload.cpuMoeLayers ? ', --n-cpu-moe ' + proc.offload.cpuMoeLayers : ''))
      + ')')
    deps.progress('server', { state: 'RUNNING', pid: proc.pid, endpoint: proc.endpoint })

    // Periodic metrics while running.
    const stopMetrics = deps.timers.interval(function () {
      deps.monitoring.poll(proc).catch(function () { /* noop */ })
    }, serverCfg.metricsIntervalMs || 2000)
    this._metricsDispose = stopMetrics

    return { ok: true, server: this.status() }
  }

  ServerManager.prototype._stderrTail = function () {
    const lines = this.deps.logs.lines({ stream: 'stderr', limit: 40 }).lines
    const last = lines.slice(-12)
    return last.map((l) => l.text).join('\n')
  }

  ServerManager.prototype.stop = async function () {
    const proc = this.process
    if (this.state === 'STOPPED' || this.state === 'FAILED' || this.state === 'UNKNOWN') {
      if (!proc) { this._setState('STOPPED'); return { ok: true, wasRunning: false } }
    }
    if (this._busy) return { ok: false, code: 'SERVER_BUSY', message: 'A server operation is already in progress.' }
    this._busy = true
    try {
      if (this._metricsDispose) { this._metricsDispose(); this._metricsDispose = undefined }
      this._setState('STOPPING')
      const deps = this.deps
      deps.log('stopping llama-server (pid ' + (proc ? proc.pid : '?') + ')')
      if (proc) {
        // Graceful path: terminate() escalates through the process tree.
        // On Windows this is a tree-scoped taskkill; llama-server exits
        // cleanly under it.
        try { proc.handle.terminate() } catch (_e) { /* noop */ }
        let outcome
        try {
          outcome = await Promise.race([
            proc.handle.done,
            this.deps.timers.sleep(10000).then(function () { return { timedOut: true } }),
          ])
        } catch (_e) {
          outcome = { spawnFailed: true }
        }
        if (outcome && outcome.timedOut) {
          try { proc.handle.terminate() } catch (_e) { /* noop */ }
          deps.log('llama-server did not exit within the grace window; force-terminated')
        } else {
          deps.log('llama-server exited (code ' + (outcome ? outcome.exitCode : '?') + ')')
        }
      }
      if (typeof this._detachLogs === 'function') { this._detachLogs(); this._detachLogs = undefined }
      this.process = undefined
      this._setState('STOPPED')
      return { ok: true, wasRunning: true }
    } finally {
      this._busy = false
    }
  }

  ServerManager.prototype.restart = async function (opts) {
    const stopped = await this.stop()
    if (!stopped.ok) return stopped
    return this.start(opts || this._lastOpts || {})
  }

  ServerManager.prototype.healthCheck = async function () {
    const proc = this.process
    if (!proc) return { ok: false, code: 'NOT_RUNNING', message: 'Server is not running.' }
    const started = Date.now()
    const h = await this.deps.exec.httpGetJson('http://' + proc.host + ':' + proc.port + '/health', { timeoutMs: 4000 })
    const models = await this.deps.exec.httpGetJson(proc.endpoint + '/models', { timeoutMs: 4000 })
    return {
      ok: true,
      health: { status: h.status, body: h.ok ? h.data : undefined, latencyMs: Date.now() - started },
      models: models.ok && models.status === 200 ? models.data : { error: models.message },
    }
  }

  ServerManager.prototype.status = function () {
    const proc = this.process
    const base = {
      state: this.state,
      reason: this.reason,
      // What the *configured* mode is when nothing is running, and what the
      // running process actually is once something is: restarting after a mode
      // change must not make the dashboard describe the old server wrongly.
      mode: proc ? (proc.router ? 'router' : 'single') : ((this.deps.config.get('server') || {}).mode || 'single'),
      router: proc && proc.router ? {
        presetPath: proc.presetPath,
        modelsMax: proc.modelsMax,
        autoload: proc.autoload,
        models: (proc.sections || []).map(function (s) {
          return { id: s.id, modelId: s.modelId, name: s.name, path: s.path }
        }),
      } : undefined,
      endpoint: proc ? proc.endpoint : undefined,
      pid: proc ? proc.pid : undefined,
      model: proc && proc.model ? { id: proc.model.id, name: proc.model.name, path: proc.model.path } : undefined,
      version: proc ? proc.version : undefined,
      backend: proc ? proc.backend : undefined,
      gpuLayers: proc ? proc.profile.gpuLayers : undefined,
      requestedGpuLayers: proc ? proc.requestedGpuLayers : undefined,
      offload: proc ? proc.offload : undefined,
      contextSize: proc && proc.profile ? proc.profile.contextSize : undefined,
      host: proc ? proc.host : undefined,
      port: proc ? proc.port : undefined,
      startedAt: proc ? new Date(proc.startedAt).toISOString() : undefined,
      uptimeMs: proc && this.state === 'RUNNING' ? Date.now() - proc.startedAt : undefined,
    }
    return base
  }

  LLAMA.modules.push('server')
  LLAMA.server = { ServerManager, STATES, MEMORY_ERROR_RE, GPU_BACKENDS }
})(globalThis.LLAMA)
