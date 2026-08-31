// api.js — the plugin's internal API facade. Assembles every manager module
// and routes the dotted `llama.*` command surface used by the model-facing
// tools, the Client RPC and future harness agents. Every command returns
// structured JSON ({ ok, ... }) and never throws across the boundary.
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util

  // Settings values that must not leave the host in the clear, as
  // [section, key] pairs. They ride on every `status` poll and on
  // `settings.get`, both of which reach the browser and — through
  // llama_status / llama_settings — any model driving the tools.
  const SECRET_SETTINGS = [
    ['server', 'apiKey'],
    ['llamaCpp', 'githubToken'],
  ]

  // What a redacted secret is replaced with, and the token that identifies an
  // unchanged one coming back. The settings form is populated from `status`, so
  // simply omitting the key would leave the field blank and make an untouched
  // Save wipe it; a placeholder that round-trips keeps the value safe.
  const REDACTED = '••••••••'

  /**
   * Whether a value coming back in is the placeholder rather than a new secret.
   *
   * Not just an equality check: the bullets are multi-byte, and a client or a
   * console that mangles the encoding turns them into '?' or U+FFFD. Storing
   * that mojibake as somebody's API key would be a worse failure than the
   * exposure the redaction exists to prevent, and no real key is made entirely
   * of bullets and replacement characters.
   */
  function isRedacted(value) {
    return typeof value === 'string' && value !== '' && /^[•?�]+$/.test(value)
  }

  // How long a latest-release lookup stays cached, by outcome.
  const LATEST_TTL_MS = 5 * 60 * 1000
  const LATEST_FAIL_TTL_MS = 60 * 1000
  const LATEST_RATE_LIMIT_TTL_MS = 15 * 60 * 1000

  function Manager(deps) {
    this.deps = deps // { fs, subprocess, timer, workspaceRoot, sourceDir, log }
    this.initialized = false
    this.progressRing = []
    this.downloads = {}
    this._latestCache = undefined
    this._latestKey = undefined
    this._latestUntil = 0
    // `home` is the managed runtime directory. The harness mount derives it
    // from the workspace; the standalone app passes it directly.
    this.home = deps.home || util.joinPath(deps.workspaceRoot || '.', 'plugins', 'llama_cpp')
    this.sourceDir = deps.sourceDir || util.joinPath(this.home, 'src')
  }

  Manager.prototype._progress = function (event, fields) {
    const entry = { at: util.nowIso(), event, fields }
    this.progressRing.push(entry)
    if (this.progressRing.length > 60) this.progressRing.splice(0, this.progressRing.length - 60)
    if (event === 'install' && fields && fields.stage) {
      this.log('[install] ' + (fields.message || fields.stage))
    } else if (event === 'model-download' && fields && fields.stage === 'download' && fields.percent !== undefined) {
      // throttle: only log whole tens
      const p = Math.floor(fields.percent / 10) * 10
      if (this._lastDlLog !== fields.id + ':' + p) {
        this._lastDlLog = fields.id + ':' + p
        this.log('[download] ' + (fields.message || '') + ' ' + p + '%')
      }
    } else if (event === 'server') {
      this.log('[server] ' + fields.state + (fields.message ? ' — ' + fields.message : ''))
    }
  }

  Manager.prototype.log = function (message) {
    if (this.logsStore) this.logsStore.plugin(message)
    if (typeof this.deps.log === 'function') this.deps.log('[llama] ' + message)
  }

  Manager.prototype.init = async function () {
    if (this.initialized) return this
    const deps = this.deps
    const rawTimer = deps.timer
    const timers = {
      sleep: function (ms) { return rawTimer.timeout(ms) },
      timeout: function (cb, ms) { return rawTimer.timeout(cb, ms) },
      interval: function (cb, ms) { return rawTimer.interval(cb, ms) },
    }
    this.timers = timers

    this.config = new LLAMA.config.ConfigStore({ fs: deps.fs, home: this.home })
    await this.config.load()

    const paths = this.config.get('paths')
    this.exec = new LLAMA.exec.Exec({
      subprocess: deps.subprocess, fs: deps.fs, timers,
      scriptsDir: paths.scriptsDirectory, cwd: this.home,
      log: (m) => this.log(m),
    })
    this.logsStore = new LLAMA.logs.LogStore({
      exec: this.exec, config: this.config, fs: deps.fs, timers,
    })
    // config.load() ran before the log store existed, so report the rebases
    // now: a relocated data directory must never be a silent repair.
    for (const moved of this.config.relocations || []) {
      this.log('rebased ' + moved.key + ' onto this folder: ' + moved.from
        + ' -> ' + moved.to + ' — the recorded location no longer exists')
    }
    this.hardware = new LLAMA.hardware.Hardware({ exec: this.exec })
    this.github = new LLAMA.github.Github({ exec: this.exec, config: this.config, log: (m) => this.log(m) })
    this.models = new LLAMA.models.ModelManager({
      exec: this.exec, config: this.config, fs: deps.fs, timers,
      log: (m) => this.log(m), progress: (e, f) => this._progress(e, f), downloads: this.downloads,
    })
    this.profiles = new LLAMA.profiles.ProfileStore({ exec: this.exec, config: this.config, fs: deps.fs })
    this.versions = new LLAMA.versions.VersionManager({
      exec: this.exec, config: this.config, fs: deps.fs, github: this.github,
      hardware: this.hardware, timers,
      log: (m) => this.log(m), progress: (e, f) => this._progress(e, f),
    })
    this.monitoring = new LLAMA.monitoring.Monitor({ exec: this.exec, hardware: this.hardware, config: this.config })
    const serverDeps = {
      exec: this.exec, config: this.config, fs: deps.fs, subprocess: deps.subprocess,
      models: this.models, profiles: this.profiles, versions: this.versions,
      hardware: this.hardware, logs: this.logsStore, monitoring: this.monitoring,
      timers, progress: (e, f) => this._progress(e, f), log: (m) => this.log(m),
    }
    this.server = new LLAMA.server.ServerManager(serverDeps)
    // Diagnostics inspects the live server (isRunning/healthCheck), so it needs
    // the manager itself in its deps — not just the shared service bundle.
    serverDeps.server = this.server
    this.diagnostics = new LLAMA.diagnostics.Diagnostics(serverDeps)
    this.logsStore.start()
    this.startTelemetry()
    this.initialized = true
    this.log('llama.cpp manager initialized (home: ' + this.home + ')')
    return this
  }

  /**
   * The always-on telemetry tick. The server lifecycle drives its own faster
   * sampling while llama-server is up (it has the pid and the endpoints), so
   * this one only fires when nothing is running — the dashboard still shows
   * live CPU, RAM, GPU and VRAM on an idle machine.
   */
  Manager.prototype.startTelemetry = function () {
    if (this._telemetryStop !== undefined) return
    const everyMs = 3000
    this._telemetryStop = this.timers.interval(() => {
      const state = this.server ? this.server.status().state : undefined
      if (state === 'RUNNING') return
      this.monitoring.pollSystem().catch(function () { /* a busy machine can miss a tick */ })
    }, everyMs)
    // One immediate sample so the first render is not empty.
    this.monitoring.pollSystem().catch(function () { /* noop */ })
  }

  Manager.prototype.stopTelemetry = function () {
    if (this._telemetryStop === undefined) return
    try { this._telemetryStop() } catch (_e) { /* noop */ }
    this._telemetryStop = undefined
  }

  Manager.prototype.dispose = async function () {
    this.stopTelemetry()
    if (this.server) {
      try { await this.server.stop() } catch (_e) { /* noop */ }
    }
    if (this.logsStore) await this.logsStore.stop()
    this.initialized = false
  }

  /**
   * settings.update, plus the one thing that has to happen outside the store:
   * a managed directory the user just pointed outside the data directory has to
   * be opened up in the host's write fence, which was built from the config as
   * it stood at boot. Without this the new directory only becomes writable on
   * the next start. Hosts that do not fence writes simply have no allowWrite.
   */
  Manager.prototype._updateSettings = async function (patch) {
    const result = await this.config.update(this._stripRedactedSecrets(patch))
    // config.update echoes the stored config, secrets and all. Every other way
    // out of here is redacted; this one has to be too.
    if (result.ok === true && result.config !== undefined) result.config = this._safeSettings()
    if (result.ok === true && typeof this.deps.fs.allowWrite === 'function') {
      const paths = this.config.get('paths') || {}
      for (const key of Object.keys(paths)) this.deps.fs.allowWrite(paths[key])
    }
    return result
  }

  /**
   * Hand back one secret in the clear, on request.
   *
   * _safeSettings redacts these so they do not ride on every status poll, which
   * is what protects them; showing or copying one in the UI is a deliberate act
   * and needs the real value. Only the settings named in SECRET_SETTINGS can be
   * asked for — this is not a general "read any config value" hole — and it is
   * behind the same session gate as every other command. It is deliberately not
   * wired to any agent-facing tool.
   */
  Manager.prototype._revealSecret = function (section, key) {
    const wanted = SECRET_SETTINGS.find(function (pair) {
      return pair[0] === String(section) && pair[1] === String(key)
    })
    if (wanted === undefined) {
      return {
        ok: false, code: 'NOT_A_SECRET',
        message: 'There is no secret setting called ' + String(section) + '.' + String(key) + '.',
      }
    }
    const bag = this.config.get(wanted[0]) || {}
    const value = bag[wanted[1]]
    return { ok: true, section: wanted[0], key: wanted[1], value: typeof value === 'string' ? value : '' }
  }

  // ---------- command router ----------

  Manager.prototype.cmd = async function (method, args) {
    if (!this.initialized) await this.init()
    const a = util.isPlainObject(args) ? args : {}
    let result
    try {
      result = await this._dispatch(method, a)
    } catch (err) {
      const message = String(err && err.message ? err.message : err)
      this.log('command ' + method + ' failed: ' + message)
      result = { ok: false, code: 'INTERNAL', message, method }
    }
    // Every command result crosses the dynamic-plugin tool/RPC boundary, where
    // the harness requires lossless JSON: undefined values (fresh configs keep
    // e.g. activeVersion/driverVersion as undefined) are rejected there.
    return util.jsonSafe(result)
  }

  /**
   * The dotted command router behind cmd(). Split out so cmd() can sanitize
   * the result at the single boundary; never call directly.
   */
  Manager.prototype._dispatch = async function (method, a) {
    switch (method) {
        case 'status': return this._status()
        case 'hardware': return { ok: true, hardware: await this.hardware.detect(false) }
        case 'diagnostics': return { ok: true, report: await this.diagnostics.run() }

        case 'versions.list': return this.versions.listInstalled()
        case 'versions.latest': return this._latest(a.backend)
        case 'versions.install': return this.versions.install({
          backend: a.backend,
          skipCudaRuntime: a.skipCudaRuntime === true,
          targetDir: a.targetDir,
        })
        case 'versions.installRuntime': return this.versions.installRuntime(String(a.version || ''))
        case 'versions.activate': return this.versions.activate(String(a.version || ''))
        case 'versions.remove': return this.versions.remove(String(a.version || ''))
        case 'versions.check': return this._latest(a.backend)
        case 'versions.repairRuntime': return this.versions.repairRuntime(String(a.version || ''))
        case 'versions.cancelInstall': return this.versions.cancelInstall()
        case 'versions.flags': return this.versions.flagCatalog(a.version)
        case 'versions.installStatus': return this.versions.installStatus()
        case 'versions.devices': {
          const list = await this.versions.listInstalled()
          const entry = list.versions.find((v) => v.version === (a.version || list.activeVersion)) || list.versions[0]
          if (!entry) return { ok: false, code: 'NOT_INSTALLED', message: 'No llama.cpp build is installed.' }
          const r = await this.versions.listDevices(entry)
          return { ok: true, version: entry.version, backend: entry.backend, devices: r.devices }
        }

        case 'models.list': return this.models.list()
        case 'models.import': return this.models.importModel(a)
        case 'models.download': return this.models.downloadModel(a)
        case 'models.cancelDownload': return this.models.cancelDownload(String(a.id || ''))
        case 'models.delete': return this.models.deleteModel(String(a.id || ''), { deleteCompanion: a.deleteCompanion === true })
        case 'models.rescan': return this.models.rescan(String(a.id || ''))
        case 'models.inspect':
          if (a.id) {
            const m = await this.models.get(String(a.id))
            if (!m.ok) return m
            return this.models.inspectFile(m.model.path)
          }
          return this.models.inspectFile(String(a.path || ''))
        case 'models.hfFiles': return this.models.hfListFiles(a.repo)
        case 'models.settings': return this.models.getSettings(String(a.id || ''))
        case 'models.saveSettings': return this.models.saveSettings(String(a.id || ''), a.settings)
        case 'models.resetSettings': return this.models.resetSettings(String(a.id || ''))
        case 'models.addFlag': return this.models.addFlag(String(a.id || ''), a.flag, a.value)
        case 'models.detectMtp': {
          if (a.id) {
            const m = await this.models.get(String(a.id))
            if (!m.ok) return m
            return this.models.detectMtp(m.model.path)
          }
          return this.models.detectMtp(String(a.path || ''))
        }
        case 'models.detectMmproj': {
          if (a.id) {
            const m = await this.models.get(String(a.id))
            if (!m.ok) return m
            return this.models.detectMmproj(m.model.path)
          }
          return this.models.detectMmproj(String(a.path || ''))
        }
        case 'models.openFolder': {
          const dir = util.joinPath(this.config.get('paths').modelsDirectory)
          return { ok: true, dir }
        }

        case 'profiles.list': return this.profiles.list()
        case 'profiles.get': return this.profiles.get(String(a.id || ''))
        case 'profiles.create': return this.profiles.create(a.modelId, a.profile)
        case 'profiles.save': return this.profiles.save(String(a.id || ''), a.patch)
        case 'profiles.delete': return this.profiles.remove(String(a.id || ''))

        case 'server.start': return this.server.start(a)
        case 'server.preview': return this.server.preview(a)
        case 'server.stop': return this.server.stop()
        case 'server.restart': return this.server.restart(a)
        case 'server.status': return { ok: true, server: this.server.status() }
        case 'server.routerPreview': return this.server.previewRouter(a)
        case 'server.models': return this.server.routerModels()
        case 'server.loadModel': return this.server.loadModel(String(a.model || ''))
        case 'server.unloadModel': return this.server.unloadModel(String(a.model || ''))
        case 'server.health': return this.server.healthCheck()
        // lines() returns { seq, lines } — the tool/RPC boundary contract is
        // { ok, ... } for every command, and the Logs page checks `ok`.
        case 'server.logs': return Object.assign({ ok: true }, this.logsStore.lines(a))
        case 'server.clearLogs': return this.logsStore.clear()
        case 'server.metrics': return { ok: true, metrics: this.monitoring.current() }
        case 'server.endpoint': return this._endpoint()
        case 'server.apiConfig': return this._apiConfig()
        case 'server.testChat': return this._testChat(a.message, { maxTokens: a.maxTokens, model: a.model })

        case 'settings.get': return { ok: true, settings: this._safeSettings() }
        case 'settings.update': return this._updateSettings(a.patch)
        case 'settings.reveal': return this._revealSecret(a.section, a.key)

        case 'shell.pick': return this.exec.pickPath({
          mode: a.mode, title: a.title, startDir: a.startDir, filter: a.filter, fileName: a.fileName,
        })
        case 'shell.reveal': return this.exec.reveal(String(a.path || ''))
        case 'shell.roots': return this._browseRoots()
        case 'shell.browse': return this._browse(a)
        case 'shell.paths': return { ok: true, paths: this.config.get('paths'), home: this.home }

        case 'downloads.list': return { ok: true, downloads: this.models.activeDownloads() }
        case 'progress': return { ok: true, events: this.progressRing.slice(-40) }
        case 'ping': return { ok: true, pong: true, home: this.home }
        default: return { ok: false, code: 'UNKNOWN_METHOD', message: 'Unknown llama command: ' + method }
      }
  }

  /**
   * The latest release, cached per outcome.
   *
   * Only successes used to be cached, so once GitHub started refusing — 60
   * unauthenticated requests an hour, shared per IP — every subsequent poll
   * spent another request against an allowance that was already gone, and the
   * window never got the chance to look idle. A refusal is now remembered too,
   * and a rate-limit for long enough to matter.
   *
   * The cache is keyed by backend: a selection worked out for CUDA is not the
   * answer for a CPU-only install.
   */
  Manager.prototype._latest = async function (backend) {
    const key = String(backend || 'auto')
    if (this._latestCache !== undefined && this._latestKey === key && Date.now() < this._latestUntil) {
      return this._latestCache
    }
    const r = await this.versions.latestVersion(backend)
    let ttl = LATEST_TTL_MS
    if (!r.ok) ttl = r.code === 'GITHUB_RATE_LIMIT' ? LATEST_RATE_LIMIT_TTL_MS : LATEST_FAIL_TTL_MS
    this._latestCache = r
    this._latestKey = key
    this._latestUntil = Date.now() + ttl
    return r
  }

  /**
   * The endpoint a client should use: the live one while the server runs,
   * otherwise the one the current settings would produce. Never a hard-coded
   * default — the configured host/port is the single source of truth.
   */
  Manager.prototype._configuredEndpoint = function () {
    const cfg = this.config.get('server') || {}
    const host = cfg.host || '127.0.0.1'
    const port = cfg.port || 8080
    return 'http://' + host + ':' + port + '/v1'
  }

  Manager.prototype._endpoint = function () {
    const s = this.server.status()
    const cfg = this.config.get('server') || {}
    return {
      ok: true,
      status: s.state,
      pid: s.pid,
      model: s.model ? s.model.name : undefined,
      version: s.version,
      backend: s.backend,
      host: s.host || cfg.host,
      port: s.port || cfg.port,
      endpoint: s.endpoint || this._configuredEndpoint(),
      baseUrl: s.endpoint || this._configuredEndpoint(),
      live: s.state === 'RUNNING',
    }
  }

  Manager.prototype._apiConfig = function () {
    const s = this.server.status()
    const alias = s.model ? util.stripExt(s.model.name) : 'local-model'
    const baseUrl = s.endpoint || this._configuredEndpoint()
    return {
      ok: true,
      live: s.state === 'RUNNING',
      config: {
        provider: 'openai-compatible',
        base_url: baseUrl,
        api_key: 'local',
        model: alias,
      },
      curlExample: 'curl ' + baseUrl
        + '/chat/completions -H "Content-Type: application/json" -d \'{"model":"' + alias
        + '","messages":[{"role":"user","content":"Hello"}]}\'',
    }
  }

  Manager.prototype._testChat = async function (message, options) {
    const s = this.server.status()
    if (s.state !== 'RUNNING' || !s.endpoint) {
      return { ok: false, code: 'NOT_RUNNING', message: 'Start the server before running a chat test.' }
    }
    const o = options || {}
    // Which model to ask for. In router mode there is no single model: the
    // request itself selects one, so use the caller's choice, else whatever is
    // already loaded (asking for anything else would trigger a load and time
    // the disk instead of the model), else the first one offered.
    let alias = o.model ? String(o.model) : undefined
    if (alias === undefined && s.mode === 'router') {
      const live = await this.server.routerModels().catch(function () { return { ok: false } })
      const rows = (live.ok && live.models) || []
      const loaded = rows.find(function (m) { return m.state === 'loaded' })
      alias = (loaded || rows[0] || {}).id
    }
    if (alias === undefined) alias = s.model ? util.stripExt(s.model.name) : 'local-model'
    const prompt = String(message || 'Reply with one short sentence confirming you are running.')
    // A reasoning model spends its first few hundred tokens inside the thinking
    // block, so a small budget returns an empty content field and an answer that
    // never arrived. Give it room, and report the reasoning when that is
    // genuinely all the model produced.
    const maxTokens = Math.max(16, Math.min(4096, Number(o.maxTokens) || 512))
    const payload = JSON.stringify({
      model: alias,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.7,
      stream: false,
    })
    const started = Date.now()
    const argv = [
      LLAMA.exec.TOOLS.curl, '-sS', '--max-time', '300',
      '-H', 'Content-Type: application/json',
    ]
    // An API key locks the endpoint against everything, this test included.
    // It goes in through a curl config file rather than -H: a command line is
    // readable by any local process, and this one would carry the key in clear.
    const apiKey = (this.config.get('server') || {}).apiKey
    if (apiKey) await this.exec.pushSecretHeaders(argv, { Authorization: 'Bearer ' + apiKey })
    argv.push('-d', payload, s.endpoint + '/chat/completions')
    const r = await this.exec.run(argv, { stdoutBytes: 4 * 1024 * 1024, timeoutMs: 305000 })
    if (r.spawnFailed) return { ok: false, code: 'CURL_SPAWN', message: r.error }

    const latencyMs = Date.now() - started
    const body = util.tryParseJson(r.stdout)
    if (r.exitCode !== 0 || body === undefined) {
      return {
        ok: false, code: 'REQUEST_FAILED', latencyMs,
        message: 'The request did not return JSON (curl exit ' + r.exitCode + ').',
        raw: util.truncate(r.stdout || r.stderr, 800),
      }
    }
    if (body.error) {
      return {
        ok: false, code: 'SERVER_ERROR', latencyMs,
        message: String((body.error && body.error.message) || 'The server returned an error.'),
        response: body,
      }
    }

    const choice = (body.choices || [])[0] || {}
    const msg = choice.message || {}
    const content = typeof msg.content === 'string' ? msg.content.trim() : ''
    const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content.trim() : ''
    const usage = body.usage || {}
    const generated = Number(usage.completion_tokens) || 0
    return {
      ok: true,
      latencyMs,
      prompt,
      model: body.model || alias,
      text: content !== '' ? content : reasoning,
      // Lets the UI label the bubble honestly when the model never left its
      // thinking block rather than presenting reasoning as the answer.
      reasoningOnly: content === '' && reasoning !== '',
      truncated: choice.finish_reason === 'length',
      finishReason: choice.finish_reason,
      usage: usage,
      tokensPerSecond: generated > 0 && latencyMs > 0 ? generated / (latencyMs / 1000) : undefined,
    }
  }

  /**
   * Drives and home folders, so the in-app file browser has somewhere to start.
   */
  Manager.prototype._browseRoots = async function () {
    const r = await this.exec.psJson('file-ops.ps1', ['roots', '', ''])
    if (r.ok !== true) return { ok: false, code: 'ROOTS_FAILED', message: r.error || 'Could not list the drives.' }
    // shell.browse reports slash-normalised paths, so these must match or the
    // sidebar can never tell which shortcut you are currently inside.
    const roots = ((r.data && r.data.roots) || []).map(function (x) {
      return Object.assign({}, x, { path: util.norm(x.path) })
    })
    const drives = roots.filter(function (x) { return x.kind === 'drive' })

    // The manager's own directories belong in the sidebar: importing a model or
    // pointing at a build almost always starts in one of them.
    const paths = this.config.get('paths') || {}
    const quickAccess = roots.filter(function (x) { return x.kind !== 'drive' })
    if (paths.installDirectory) {
      quickAccess.push({ name: 'Default Bin Folder', path: util.norm(paths.installDirectory), kind: 'managed' })
    }
    if (paths.modelsDirectory) {
      quickAccess.push({ name: 'Default Models Folder', path: util.norm(paths.modelsDirectory), kind: 'managed' })
    }
    return { ok: true, roots: drives, drives: drives, quickAccess: quickAccess }
  }

  /**
   * One directory listing for the in-app file browser. Read-only: it reports
   * names, sizes and modification times so a file can be picked, and offers no
   * way to read, write or delete anything. `filter` is a list of extensions
   * ('.gguf') — directories are always returned so you can keep navigating.
   */
  Manager.prototype._browse = async function (a) {
    const target = String(a.path || '').trim()
    if (target === '') return this._browseRoots()
    if (!util.isAbsolute(target)) {
      return { ok: false, code: 'RELATIVE_PATH', message: 'Browse needs an absolute path.' }
    }
    const stat = await this.exec.stat(target)
    if (stat.exists !== true) {
      return { ok: false, code: 'NOT_FOUND', message: 'No such folder: ' + target }
    }
    if (stat.isDir !== true) {
      return { ok: false, code: 'NOT_A_DIRECTORY', message: 'Not a folder: ' + target }
    }
    const items = await this.exec.listDir(target)
    if (items === undefined) {
      return {
        ok: false, code: 'READ_FAILED',
        message: 'Could not read ' + target + '. It may need permissions this app does not have.',
      }
    }
    const exts = Array.isArray(a.filter)
      ? a.filter.map(function (x) { return String(x).toLowerCase() }).filter(Boolean)
      : []
    const entries = []
    for (const it of items) {
      const isDir = it.isDir === true
      if (!isDir && exts.length > 0 && !exts.includes(util.extname(it.name))) continue
      entries.push({
        name: it.name,
        path: util.joinPath(target, it.name),
        isDir: isDir,
        sizeBytes: isDir ? undefined : it.size,
        modifiedAt: it.lastWriteUtc,
      })
    }
    // Folders first, then files, each alphabetically — the order every file
    // manager uses, so nobody has to think about it.
    entries.sort(function (x, y) {
      if (x.isDir !== y.isDir) return x.isDir ? -1 : 1
      return x.name.toLowerCase().localeCompare(y.name.toLowerCase())
    })
    const parent = util.dirname(target)
    return {
      ok: true,
      path: util.norm(target),
      parent: parent === target || parent === '.' ? undefined : parent,
      entries: entries,
      truncated: false,
    }
  }

  /**
   * The settings as they may cross the boundary: everything, with the secrets
   * replaced by a placeholder and a `<key>Set` boolean so the UI can still say
   * whether one is configured. Nothing inside the manager reads a secret back
   * through here — llama-server and the router take theirs from the config
   * store directly — so there is no reveal option to get it wrong with.
   */
  Manager.prototype._safeSettings = function () {
    const cfg = util.deepClone(this.config.data)
    for (const [section, key] of SECRET_SETTINGS) {
      const bag = cfg[section]
      if (!util.isPlainObject(bag)) continue
      const isSet = typeof bag[key] === 'string' && bag[key] !== ''
      bag[key + 'Set'] = isSet
      if (isSet) bag[key] = REDACTED
    }
    return cfg
  }

  /**
   * Drop any secret that came back as the placeholder: the caller is echoing
   * what _safeSettings sent it, not setting a new value, and removing it from
   * the patch leaves config.update's merge to keep what is already stored. An
   * empty string is left alone — that is a deliberate "clear it".
   */
  Manager.prototype._stripRedactedSecrets = function (patch) {
    if (!util.isPlainObject(patch)) return patch
    const copy = util.deepClone(patch)
    for (const [section, key] of SECRET_SETTINGS) {
      const bag = copy[section]
      if (!util.isPlainObject(bag)) continue
      if (isRedacted(bag[key])) delete bag[key]
      // The read-only companion flag is not a setting; never persist it.
      delete bag[key + 'Set']
    }
    return copy
  }

  Manager.prototype._status = async function () {
    const parts = await Promise.all([
      this.versions.listInstalled(),
      this.models.list(),
      this.profiles.list(),
      this.hardware.detect(false).catch(function () { return undefined }),
    ])
    const server = this.server.status()
    // In router mode the live model list is part of the server's state — which
    // model is loaded is the thing you look at — so it rides along on the poll
    // the dashboard already makes rather than needing one of its own. A router
    // that does not answer leaves the last-known section list in place.
    if (server.mode === 'router' && server.state === 'RUNNING') {
      const live = await this.server.routerModels().catch(function () { return { ok: false } })
      if (live.ok === true) server.router = util.deepMerge(server.router || {}, { live: live.models })
    }
    const status = {
      ok: true,
      at: util.nowIso(),
      home: this.home,
      settings: this._safeSettings(),
      server,
      health: this.monitoring.current(),
      versions: parts[0],
      models: parts[1],
      profiles: parts[2],
      hardware: parts[3],
      downloads: this.models.activeDownloads(),
      progress: this.progressRing.slice(-30),
      // Only a successful lookup describes a release. Failures are cached too
      // now (see _latest), and one of those has no `latest` to read.
      latestVersion: this._latestCache && this._latestCache.ok ? {
        tagName: this._latestCache.latest.tagName,
        publishedAt: this._latestCache.latest.publishedAt,
        backend: this._latestCache.selection.backend,
        selectionOk: this._latestCache.selection.ok,
        updateAvailable: this._latestCache.updateAvailable,
      } : undefined,
    }
    return status
  }

  LLAMA.modules.push('api')
  LLAMA.api = { Manager }
})(globalThis.LLAMA)
