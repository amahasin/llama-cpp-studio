// config.js — persistent plugin configuration (config.json inside the managed
// directory). All writes go through the harness `fs` service, which is
// sandbox-fenced to the session workspace.
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util

  const CONFIG_VERSION = 1
  const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f]')

  // Every managed directory defaults to <home>/<leaf>. Kept as one table so
  // defaults() and the relocation repair below can never disagree about what
  // the default layout looks like.
  const PATH_LEAVES = {
    installDirectory: 'bin',
    modelsDirectory: 'models',
    logsDirectory: 'logs',
    cacheDirectory: 'cache',
    configsDirectory: 'configs',
    metadataDirectory: 'metadata',
    scriptsDirectory: 'scripts',
  }

  function defaultPaths(home) {
    const out = {}
    for (const key of Object.keys(PATH_LEAVES)) out[key] = util.joinPath(home, PATH_LEAVES[key])
    return out
  }

  function defaults(home) {
    return {
      version: CONFIG_VERSION,
      paths: defaultPaths(home),
      // The managed directories the user pointed somewhere else on purpose;
      // everything not named here is re-derived from `home` on every load, so
      // the folder stays portable. See applyHome() below.
      customPaths: [],
      llamaCpp: {
        activeVersion: undefined,
        autoUpdateCheck: true,
        githubApiBase: 'https://api.github.com',
        huggingfaceBase: 'https://huggingface.co',
        downloadTimeoutMs: 2 * 60 * 60 * 1000,
      },
      models: { importMode: 'copy' },
      server: {
        host: '127.0.0.1',
        port: 8080,
        // 'single' serves one model, chosen here. 'router' hands llama-server
        // the whole library and lets it load models on demand, which is what a
        // client that switches models by name (an agent picking a tool model,
        // say) needs — see ServerManager._planRouter.
        mode: 'router',
        // Automatically start the server (in router mode) when the application launches.
        autostart: true,
        // How many models the router may hold at once. llama.cpp defaults to
        // four; one is the right default on a desktop GPU, where a second
        // 20GB model does not fit beside the first and the useful behaviour is
        // to swap. 0 means unlimited.
        routerModelsMax: 1,
        // Load a model on the first request for it, rather than only when
        // something asks for it explicitly.
        routerAutoload: true,
        startupTimeoutMs: 180000,
        healthIntervalMs: 500,
        metricsIntervalMs: 2000,
        autoRetryMax: 4,
        // Server-scoped llama-server flags (per-model flags live on the model).
        parallel: 1,
        contBatching: true,
        cacheReuse: 0,
        threadsHttp: undefined,
        webui: true,
        metrics: true,
        // ---- server-scoped llama-server flags ----
        apiKey: undefined,
        allowedOrigins: undefined,
        publicUrl: undefined,
        slots: true,
        webPath: undefined,
        sslKeyFile: undefined,
        sslCertFile: undefined,
      },
      hardware: { backend: 'auto', gpuLayers: 'auto', threads: 'auto' },
    }
  }

  function normalize(cfg, home) {
    const out = util.deepClone(cfg)
    // Validation lives in the security module (LLAMA.security), not on util.
    const sec = LLAMA.security
    const hostCheck = sec.validateHost(out.server && out.server.host)
    out.server.host = hostCheck.ok ? hostCheck.host : '127.0.0.1'
    const portCheck = sec.validatePort(out.server && out.server.port)
    out.server.port = portCheck.ok ? portCheck.port : 8080
    const startup = Number(out.server.startupTimeoutMs)
    out.server.startupTimeoutMs = Number.isNaN(startup) ? 180000 : util.clamp(startup, 5000, 3600000)
    const health = Number(out.server.healthIntervalMs)
    out.server.healthIntervalMs = Number.isNaN(health) ? 500 : util.clamp(health, 100, 10000)
    const retry = Number(out.server.autoRetryMax)
    out.server.autoRetryMax = Number.isNaN(retry) ? 4 : util.clamp(retry, 1, 6)
    const parallel = Number(out.server.parallel)
    out.server.parallel = Number.isNaN(parallel) ? 1 : util.clamp(Math.round(parallel), 1, 16)
    out.server.contBatching = out.server.contBatching !== false
    const reuse = Number(out.server.cacheReuse)
    out.server.cacheReuse = Number.isNaN(reuse) ? 0 : util.clamp(Math.round(reuse), 0, 65536)
    if (out.server.threadsHttp === undefined || out.server.threadsHttp === null || out.server.threadsHttp === '') {
      out.server.threadsHttp = undefined
    } else {
      const httpThreads = Number(out.server.threadsHttp)
      out.server.threadsHttp = Number.isNaN(httpThreads) ? undefined : util.clamp(Math.round(httpThreads), 1, 64)
    }
    out.server.mode = ['single', 'router'].includes(out.server.mode) ? out.server.mode : 'single'
    const routerMax = Number(out.server.routerModelsMax)
    out.server.routerModelsMax = Number.isNaN(routerMax) ? 1 : util.clamp(Math.round(routerMax), 0, 16)
    out.server.routerAutoload = out.server.routerAutoload !== false
    out.server.webui = out.server.webui !== false
    out.server.metrics = out.server.metrics !== false
    out.server.slots = out.server.slots !== false
    // Empty strings mean "not set"; keeping them would emit a bare flag with a
    // blank argument, which llama-server rejects.
    for (const key of ['apiKey', 'webPath', 'sslKeyFile', 'sslCertFile', 'allowedOrigins', 'publicUrl']) {
      const value = out.server[key]
      if (typeof value !== 'string' || value.trim() === '') out.server[key] = undefined
      else out.server[key] = value.trim()
    }
    // TLS needs both halves or neither.
    if ((out.server.sslKeyFile === undefined) !== (out.server.sslCertFile === undefined)) {
      out.server.sslKeyFile = undefined
      out.server.sslCertFile = undefined
    }
    // Managed directories are user-settable (install/models/logs/…). Keep them
    // absolute, slash-normalized and free of control characters; anything
    // unusable falls back to the default under `home` when one is known.
    if (util.isPlainObject(out.paths)) {
      const fallback = home === undefined ? undefined : defaults(home).paths
      for (const key of Object.keys(out.paths)) {
        const value = out.paths[key]
        const usable = typeof value === 'string' && value.trim() !== ''
          && util.isAbsolute(value.trim()) && !CONTROL_CHARS.test(value)
        if (usable) out.paths[key] = util.norm(value.trim()).replace(/\/+$/, '')
        else if (fallback && fallback[key] !== undefined) out.paths[key] = fallback[key]
      }
    }
    out.customPaths = sanitizeCustomPaths(out.customPaths)
    if (!['copy', 'reference'].includes(out.models.importMode)) out.models.importMode = 'copy'
    if (!['auto', 'cpu', 'cuda', 'vulkan', 'hip', 'sycl', 'metal'].includes(out.hardware.backend)) {
      out.hardware.backend = 'auto'
    }
    return out
  }

  /**
   * A managed directory is either *default* — <home>/<leaf>, wherever this
   * folder happens to be right now — or *custom*, somewhere the user pointed it
   * on purpose. Only the custom ones are recorded as an intent (`customPaths`);
   * the default ones are re-derived from `home` on every load.
   *
   * That is what makes the folder portable. These paths are stored absolute, so
   * a folder that is renamed, copied to another drive or carried to another PC
   * otherwise keeps naming the machine that wrote them, and the first install
   * or import tries to mkdir under a home that is gone. Under another user's
   * profile that fails outright (creating C:/Users/<someone-else> needs admin);
   * when the old path happens to be creatable it silently rebuilds the tree
   * there instead, which is worse — two data directories and no error.
   *
   * Deciding it by inspection instead ("is the old home still on disk?") cannot
   * work, and this is why: the moment anything writes a helper script or a
   * metadata file, the app recreates the very directories it was supposed to
   * notice were gone, and the leftover then looks alive enough that no test can
   * tell it from a real one. Recorded intent has no such cycle.
   *
   * Custom directories are never touched: point models at a bigger drive and it
   * stays there across every move. Sharing one folder's data with another copy
   * is `--data <dir>`, which says so out loud.
   */
  function homeOf(value, leaf) {
    const s = util.norm(value).replace(/\/+$/, '')
    const suffix = '/' + leaf
    if (s.length <= suffix.length) return undefined
    if (s.slice(-suffix.length).toLowerCase() !== suffix.toLowerCase()) return undefined
    return s.slice(0, -suffix.length)
  }

  function sanitizeCustomPaths(list) {
    const out = []
    if (!Array.isArray(list)) return out
    for (const key of list) {
      if (typeof key === 'string' && PATH_LEAVES[key] !== undefined && !out.includes(key)) out.push(key)
    }
    return out
  }

  /**
   * What a config.json written before `customPaths` existed must have meant: a
   * directory that no longer sits at its default leaf under *any* home was
   * unambiguously chosen by hand and is kept. One that does still sit at its
   * default leaf is indistinguishable from a leftover of wherever this folder
   * used to live, so it is re-derived — once, after which update() records the
   * intent properly.
   */
  function inferCustomPaths(paths) {
    const out = []
    if (!util.isPlainObject(paths)) return out
    for (const key of Object.keys(PATH_LEAVES)) {
      const value = paths[key]
      if (typeof value !== 'string' || !util.isAbsolute(value)) continue
      if (homeOf(value, PATH_LEAVES[key]) === undefined) out.push(key)
    }
    return out
  }

  /**
   * Put every non-custom directory back under `home`. Returns the repaired
   * paths, the sanitized custom list, and the directories that actually moved
   * so the manager can log them — a relocation is never a silent repair.
   */
  function applyHome(paths, customPaths, home) {
    const out = util.isPlainObject(paths) ? util.deepClone(paths) : {}
    const custom = sanitizeCustomPaths(customPaths)
    const rebased = []
    for (const key of Object.keys(PATH_LEAVES)) {
      if (custom.includes(key)) continue
      const want = util.joinPath(home, PATH_LEAVES[key])
      const have = out[key]
      if (typeof have === 'string' && util.samePath(have, want)) continue
      if (typeof have === 'string' && have.trim() !== '') {
        rebased.push({ key, from: util.norm(have).replace(/\/+$/, ''), to: want })
      }
      out[key] = want
    }
    return { paths: out, custom, rebased }
  }

  /**
   * Which of these directories point somewhere other than <home>/<leaf>.
   * Derived from the values themselves rather than from "the user submitted
   * this key", because the Settings page always sends all four editable
   * directories whether they were touched or not — deriving means an unchanged
   * default is never mistaken for a deliberate choice and pinned by accident.
   */
  function customPathsOf(paths, home) {
    const out = []
    if (!util.isPlainObject(paths)) return out
    for (const key of Object.keys(PATH_LEAVES)) {
      const value = paths[key]
      if (typeof value !== 'string' || value.trim() === '') continue
      if (!util.samePath(value, util.joinPath(home, PATH_LEAVES[key]))) out.push(key)
    }
    return out
  }

  /**
   * ConfigStore — async load/save through the fs service.
   * deps: { fs } (harness filesystem service), { home } (managed dir)
   */
  function ConfigStore(deps) {
    this.deps = deps
    this.home = deps.home
    this.file = util.joinPath(this.home, 'config.json')
    this.data = defaults(this.home)
    this.loaded = false
    // Set by load() to the managed directories that had to be put back under
    // this home ({ key, from, to } each). The manager logs every one of them,
    // so a relocated folder is never a silent repair.
    this.relocations = []
  }

  ConfigStore.prototype.configPath = function () { return this.file }

  ConfigStore.prototype.load = async function () {
    if (this.loaded) return this.data
    let parsed
    try {
      const target = await this.deps.fs.resolve(this.file)
      const text = await this.deps.fs.readText(target)
      const candidate = util.tryParseJson(text)
      if (candidate && util.isPlainObject(candidate)) parsed = candidate
    } catch (_err) {
      // First run: keep defaults, persist them below.
    }
    if (parsed !== undefined) {
      const merged = util.deepMerge(defaults(this.home), parsed)
      // A moved folder carries a config.json full of the old machine's paths.
      // Put the non-custom ones back under this home before normalize(), which
      // only rejects malformed paths and would happily keep a well-formed one
      // pointing at wherever this folder used to live.
      const custom = Array.isArray(parsed.customPaths)
        ? sanitizeCustomPaths(parsed.customPaths)
        : inferCustomPaths(merged.paths)
      const homed = applyHome(merged.paths, custom, this.home)
      merged.paths = homed.paths
      merged.customPaths = homed.custom
      this.relocations = homed.rebased
      // load() always rewrites the file, so a normalization failure must never
      // silently replace the stored settings with defaults: keep the merged
      // values and let the next validated update fix them up.
      try {
        this.data = normalize(merged, this.home)
      } catch (_err) {
        this.data = merged
      }
    }
    this.loaded = true
    await this.save()
    return this.data
  }

  ConfigStore.prototype.save = async function () {
    try {
      const target = await this.deps.fs.resolve(this.file)
      await this.deps.fs.writeText(target, JSON.stringify(this.data, null, 2) + '\n')
      return true
    } catch (err) {
      return false
    }
  }

  ConfigStore.prototype.get = function (section) {
    return section === undefined ? this.data : this.data[section]
  }

  /**
   * Apply a validated patch. Accepts { server: {...}, hardware: {...}, models: {...}, llamaCpp: {...} }.
   * Unknown sections are rejected.
   */
  ConfigStore.prototype.update = async function (patch) {
    if (!util.isPlainObject(patch)) return { ok: false, code: 'BAD_PATCH', message: 'Patch must be an object.' }
    const allowed = ['server', 'hardware', 'models', 'llamaCpp', 'paths']
    for (const key of Object.keys(patch)) {
      if (!allowed.includes(key)) {
        return { ok: false, code: 'BAD_PATCH_SECTION', message: 'Unknown settings section "' + key + '".' }
      }
    }
    if (patch.paths !== undefined) {
      if (!util.isPlainObject(patch.paths)) {
        return { ok: false, code: 'BAD_PATHS', message: 'paths must be an object.' }
      }
      for (const key of Object.keys(patch.paths)) {
        if (this.data.paths[key] === undefined) {
          return { ok: false, code: 'BAD_PATH_KEY', message: 'Unknown directory "' + key + '".' }
        }
        const value = patch.paths[key]
        if (typeof value !== 'string' || !util.isAbsolute(value.trim()) || CONTROL_CHARS.test(value)) {
          return {
            ok: false, code: 'BAD_PATH',
            message: 'The ' + key + ' must be an absolute path without control characters.',
          }
        }
      }
    }
    const next = util.deepMerge(this.data, patch)
    const normalized = normalize(next, this.home)
    // A directory that is not <home>/<leaf> is one the user pointed elsewhere,
    // and stays put across every future move; one that is back at its default
    // becomes portable again.
    normalized.customPaths = customPathsOf(normalized.paths, this.home)
    this.data = normalized
    const saved = await this.save()
    if (!saved) return { ok: false, code: 'SAVE_FAILED', message: 'Could not write config.json.' }
    return { ok: true, config: this.data }
  }

  LLAMA.modules.push('config')
  LLAMA.config = {
    defaults, defaultPaths, normalize, applyHome, customPathsOf, inferCustomPaths,
    ConfigStore, PATH_LEAVES,
  }
})(globalThis.LLAMA)
