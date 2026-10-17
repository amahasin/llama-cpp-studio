// profiles.js — model profiles: multiple named launch profiles per GGUF file,
// stored under configs/models/<id>.json. Profiles never modify the model.
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util
  const security = LLAMA.security

  // A model's advertised context can be 128K-1M tokens; allocating that much
  // KV cache by default exhausts VRAM long before the weights do, so the
  // default stops here and the Model Settings dialog raises it deliberately.
  const DEFAULT_CONTEXT_CAP = 8192

  function defaultProfile(model) {
    const meta = model.metadata || {}
    const threads = (model.hardware && model.hardware.cpu && model.hardware.cpu.physicalCores) || 8
    return {
      name: 'Default',
      contextSize: Math.min(meta.contextLength || 4096, DEFAULT_CONTEXT_CAP),
      gpuLayers: 'auto',
      threads: 'auto',
      batchSize: 512,
      ubatchSize: 512,
      parallel: 1,
      // No sampling defaults. llama.cpp has its own, and a modern GGUF ships
      // the values its authors recommend; forcing temperature/top-p/top-k onto
      // every launch overrode both with numbers nobody chose. They appear on
      // the command line only when set in Model settings.
      flashAttn: true,
      toolCalling: true,
      // A vision model is served with its projector unless you say otherwise:
      // the projector is what the model was published to be used with, and
      // silently dropping it looks like a broken model rather than a choice.
      // Turning this off is the choice — see the mmproj resolution in
      // server.js, which it deliberately outranks.
      vision: true,
      metrics: true,
    }
  }

  const PROFILE_FIELDS = {
    name: 'string', contextSize: 'int', gpuLayers: 'intOrAuto', threads: 'intOrAuto',
    threadsBatch: 'int', batchSize: 'int', ubatchSize: 'int', parallel: 'int',
    temperature: 'float', topP: 'float', topK: 'int', minP: 'float',
    repeatPenalty: 'float', repeatLastN: 'int', presencePenalty: 'float', frequencyPenalty: 'float',
    seed: 'int', flashAttn: 'bool', noMmap: 'bool', mlock: 'bool',
    cacheTypeK: 'string', cacheTypeV: 'string', mmproj: 'path', vision: 'bool', jinja: 'bool',
    // Multi-token prediction: the head file, and whether to use it.
    mtpPath: 'path', mtp: 'bool',
    toolCalling: 'bool', contBatching: 'bool', cacheReuse: 'int', threadsHttp: 'int',
    noWebui: 'bool', nCpuMoe: 'int', threadsDraft: 'int',
    ropeScaling: 'string', ropeScale: 'float', ropeFreqBase: 'float',
    alias: 'string', extraArgs: 'array', metrics: 'bool',

    // ---- core & hardware ----
    rpc: 'string', splitMode: 'string',
    tensorSplit: 'string', mainGpu: 'int', noKvOffload: 'bool', numa: 'string',
    device: 'string', cpuMask: 'string',
    // ---- context & performance ----
    keep: 'int', predict: 'int',
    // ---- generation & sampling ----
    typical: 'float', mirostat: 'int', mirostatLr: 'float', mirostatEnt: 'float',
    // ---- chat & template ----
    chatTemplate: 'string', chatTemplateFile: 'path', reversePrompt: 'string',
    // ---- advanced & debugging ----
    grammar: 'string', grammarFile: 'path', logDisable: 'bool',
    lora: 'path', loraScaled: 'path', loraScale: 'float',
    // ---- server scoped (also settable per model) ----
    apiKey: 'string', slots: 'bool', webPath: 'string',
    sslKeyFile: 'path', sslCertFile: 'path',
  }

  function validateProfile(profile) {
    const errors = []
    const warnings = []
    if (!util.isPlainObject(profile)) return { ok: false, errors: ['profile must be an object'] }
    for (const key of Object.keys(profile)) {
      if (profile[key] === undefined || profile[key] === null) continue
      const kind = PROFILE_FIELDS[key]
      if (kind === undefined) {
        warnings.push('unknown profile field "' + key + '" is kept but unused by the UI')
        continue
      }
      const v = profile[key]
      if (kind === 'int') {
        if (!Number.isInteger(Number(v))) errors.push(key + ' must be an integer')
      } else if (kind === 'float') {
        if (Number.isNaN(Number(v))) errors.push(key + ' must be a number')
      } else if (kind === 'bool') {
        if (typeof v !== 'boolean') errors.push(key + ' must be true or false')
      } else if (kind === 'string') {
        if (typeof v !== 'string') errors.push(key + ' must be a string')
      } else if (kind === 'array') {
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) errors.push(key + ' must be an array of strings')
      } else if (kind === 'intOrAuto') {
        if (v !== 'auto' && !Number.isInteger(Number(v))) errors.push(key + ' must be an integer or "auto"')
      } else if (kind === 'path') {
        if (typeof v !== 'string' || v.trim() === '') errors.push(key + ' must be a path string')
      }
    }
    if (profile.contextSize !== undefined && Number(profile.contextSize) < 128) {
      errors.push('contextSize must be at least 128')
    }
    if (profile.parallel !== undefined && (Number(profile.parallel) < 1 || Number(profile.parallel) > 16)) {
      errors.push('parallel must be between 1 and 16')
    }
    if (profile.temperature !== undefined) {
      const t = Number(profile.temperature)
      if (t < 0 || t > 5) errors.push('temperature must be between 0 and 5')
    }
    if (profile.topP !== undefined) {
      const t = Number(profile.topP)
      if (t < 0 || t > 1) errors.push('topP must be between 0 and 1')
    }
    if (profile.minP !== undefined) {
      const t = Number(profile.minP)
      if (t < 0 || t > 1) errors.push('minP must be between 0 and 1')
    }
    if (profile.typical !== undefined) {
      const t = Number(profile.typical)
      if (t < 0 || t > 1) errors.push('typical must be between 0 and 1')
    }
    if (profile.mirostat !== undefined && ![0, 1, 2].includes(Number(profile.mirostat))) {
      errors.push('mirostat must be 0 (off), 1 or 2')
    }
    if (profile.numa !== undefined && !['distribute', 'isolate', 'numactl'].includes(String(profile.numa))) {
      errors.push('numa must be distribute, isolate or numactl')
    }
    if (profile.splitMode !== undefined && !['none', 'layer', 'row', 'tensor'].includes(String(profile.splitMode))) {
      errors.push('splitMode must be none, layer, row or tensor')
    }
    if (profile.rpc !== undefined && profile.rpc !== null && profile.rpc !== '') {
      const vRpc = security.validateRpcServers(profile.rpc)
      if (!vRpc.ok) errors.push(vRpc.message)
    }
    // --lora-scaled takes a file *and* a scale; one without the other is a
    // command line llama-server will reject.
    if (profile.loraScaled !== undefined && profile.loraScale === undefined) {
      errors.push('loraScale is required when loraScaled is set')
    }
    return { ok: errors.length === 0, errors, warnings }
  }

  function ProfileStore(deps) {
    this.deps = deps
    this.dir = util.joinPath(deps.config.get('paths').configsDirectory, 'models')
  }

  ProfileStore.prototype._file = function (id) {
    return util.joinPath(this.dir, id + '.json')
  }

  ProfileStore.prototype._readAll = async function () {
    const out = []
    try {
      await this.deps.exec.ensureDir(this.dir)
      const items = await this.deps.exec.listDir(this.dir)
      if (items === undefined) return out
      for (const it of items) {
        if (it.isDir || !it.name.toLowerCase().endsWith('.json')) continue
        const parsed = await util.readJsonFile(this.deps.fs, util.joinPath(this.dir, it.name))
        if (parsed && util.isPlainObject(parsed)) {
          parsed.id = parsed.id || util.stripExt(it.name)
          out.push(parsed)
        }
      }
    } catch (_e) { /* noop */ }
    out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    return out
  }

  ProfileStore.prototype.list = async function () {
    const list = await this._readAll()
    return { ok: true, profiles: list }
  }

  ProfileStore.prototype.get = async function (id) {
    const list = await this._readAll()
    const found = list.find((p) => p.id === id)
    return found ? { ok: true, profile: found } : { ok: false, code: 'NOT_FOUND', message: 'Profile "' + id + '" does not exist.' }
  }

  ProfileStore.prototype.create = async function (modelId, input) {
    const name = String((input && input.name) || 'Default').trim()
    if (name === '') return { ok: false, code: 'BAD_NAME', message: 'Profile name must not be empty.' }
    const id = util.uid('prof')
    const base = defaultProfile({
      metadata: (input && input.metadata) || {},
      hardware: (input && input.hardware) || {},
    })
    const profile = util.deepMerge(base, input || {})
    delete profile.metadata
    delete profile.hardware
    delete profile.model
    profile.id = id
    profile.modelId = modelId
    profile.name = name
    profile.createdAt = util.nowIso()
    profile.updatedAt = util.nowIso()
    const check = validateProfile(profile)
    if (!check.ok) return { ok: false, code: 'BAD_PROFILE', message: check.errors.join('; '), errors: check.errors }
    const saved = await this._save(profile)
    if (!saved) return { ok: false, code: 'SAVE_FAILED', message: 'Could not write the profile file.' }
    return { ok: true, profile }
  }

  ProfileStore.prototype.save = async function (id, patch) {
    if (!util.isPlainObject(patch)) return { ok: false, code: 'BAD_PATCH', message: 'Patch must be an object.' }
    const found = await this.get(id)
    if (!found.ok) return found
    const next = util.deepMerge(found.profile, patch)
    next.id = id
    next.updatedAt = util.nowIso()
    const check = validateProfile(next)
    if (!check.ok) return { ok: false, code: 'BAD_PROFILE', message: check.errors.join('; '), errors: check.errors }
    const saved = await this._save(next)
    if (!saved) return { ok: false, code: 'SAVE_FAILED', message: 'Could not write the profile file.' }
    return { ok: true, profile: next }
  }

  ProfileStore.prototype.remove = async function (id) {
    const found = await this.get(id)
    if (!found.ok) return found
    const rm = await this.deps.exec.removeTree(this._file(id))
    if (!rm.ok) return { ok: false, code: 'REMOVE_FAILED', message: 'Could not delete the profile file.' }
    return { ok: true, removed: id }
  }

  ProfileStore.prototype._save = async function (profile) {
    await this.deps.exec.ensureDir(this.dir)
    return util.writeJsonFile(this.deps.fs, this._file(profile.id), profile)
  }

  LLAMA.modules.push('profiles')
  LLAMA.profiles = { ProfileStore, defaultProfile, validateProfile, PROFILE_FIELDS, DEFAULT_CONTEXT_CAP }
})(globalThis.LLAMA)
