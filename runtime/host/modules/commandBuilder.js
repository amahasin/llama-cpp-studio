// commandBuilder.js — builds the llama-server argv from a model profile.
//
// Version-aware: every option is emitted only when the installed binary's
// capability set (parsed from `llama-server --help`) contains it, so a newer
// profile option can never crash an older binary. Output is a structured argv
// array — never a shell string. Pure module.
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util
  const security = LLAMA.security

  /**
   * One option definition. `form` controls emission:
   *  - 'flag'        -> [--name] when value truthy
   *  - 'value'       -> [--name, value] when value != null
   *  - 'bool-value'  -> [--name, on|off] when value boolean (flash-attn style)
   *  - 'alias'       -> [-short] single token
   *  - 'pair'        -> [--name, a, b] when both parts are present
   * `caps` names every capability token (without leading dashes) whose
   * presence is required; if any is missing the option is skipped with a note.
   */
  const OPTION_DEFS = [
    { name: 'model', form: 'value', caps: ['m', 'model'], required: true },
    { name: 'host', form: 'value', caps: ['host'] },
    { name: 'port', form: 'value', caps: ['port'] },
    { name: 'alias', form: 'value', caps: ['alias'] },
    { name: 'ctx-size', form: 'value', caps: ['c', 'ctx-size'] },
    { name: 'n-gpu-layers', form: 'value', caps: ['ngl', 'n-gpu-layers'] },
    { name: 'threads', form: 'value', caps: ['t', 'threads'] },
    { name: 'threads-batch', form: 'value', caps: ['tb', 'threads-batch'] },
    { name: 'batch-size', form: 'value', caps: ['b', 'batch-size'] },
    { name: 'ubatch-size', form: 'value', caps: ['ub', 'ubatch-size'] },
    { name: 'parallel', form: 'value', caps: ['np', 'parallel'] },
    { name: 'cont-batching', form: 'flag', caps: ['cb', 'cont-batching'] },
    { name: 'no-cont-batching', form: 'flag', caps: ['nocb', 'no-cont-batching'] },
    { name: 'cache-reuse', form: 'value', caps: ['cache-reuse'] },
    { name: 'threads-http', form: 'value', caps: ['threads-http'] },
    { name: 'temp', form: 'value', caps: ['temp'] },
    { name: 'top-p', form: 'value', caps: ['top-p'] },
    { name: 'top-k', form: 'value', caps: ['top-k'] },
    { name: 'min-p', form: 'value', caps: ['min-p'] },
    { name: 'repeat-penalty', form: 'value', caps: ['repeat-penalty'] },
    { name: 'repeat-last-n', form: 'value', caps: ['repeat-last-n'] },
    { name: 'presence-penalty', form: 'value', caps: ['presence-penalty'] },
    { name: 'frequency-penalty', form: 'value', caps: ['frequency-penalty'] },
    { name: 'seed', form: 'value', caps: ['seed', 's'] },
    { name: 'flash-attn', form: 'bool-value', caps: ['fa', 'flash-attn'] },
    { name: 'no-mmap', form: 'flag', caps: ['no-mmap'] },
    { name: 'mlock', form: 'flag', caps: ['mlock'] },
    // b10400+ replaced --mlock/--no-mmap with a single --load-mode.
    { name: 'load-mode', form: 'value', caps: ['lm', 'load-mode'] },
    { name: 'cache-type-k', form: 'value', caps: ['ctk', 'cache-type-k'] },
    { name: 'cache-type-v', form: 'value', caps: ['ctv', 'cache-type-v'] },
    { name: 'mmproj', form: 'value', caps: ['mmproj'] },
    { name: 'metrics', form: 'flag', caps: ['metrics'] },
    { name: 'jinja', form: 'flag', caps: ['jinja'] },
    { name: 'no-webui', form: 'flag', caps: ['no-webui'] },
    { name: 'n-cpu-moe', form: 'value', caps: ['n-cpu-moe'] },
    { name: 'threads-draft', form: 'value', caps: ['td', 'threads-draft'] },
    { name: 'rope-scaling', form: 'value', caps: ['rope-scaling'] },
    { name: 'rope-scale', form: 'value', caps: ['rope-scale'] },
    { name: 'rope-freq-base', form: 'value', caps: ['rope-freq-base'] },

    // ---- core & hardware ----
    { name: 'tensor-split', form: 'value', caps: ['ts', 'tensor-split'] },
    { name: 'main-gpu', form: 'value', caps: ['mg', 'main-gpu'] },
    { name: 'no-kv-offload', form: 'flag', caps: ['nkvo', 'no-kv-offload'] },
    { name: 'numa', form: 'value', caps: ['numa'] },
    // The GPU/CPU "destination" controls: llama.cpp spells these --device and
    // --cpu-mask rather than --gpu-destination / --cpu-destination.
    { name: 'device', form: 'value', caps: ['dev', 'device'] },
    { name: 'cpu-mask', form: 'value', caps: ['cpu-mask'] },

    // ---- context & performance ----
    { name: 'keep', form: 'value', caps: ['keep'] },
    { name: 'predict', form: 'value', caps: ['n', 'predict'] },

    // ---- generation & sampling ----
    { name: 'typical', form: 'value', caps: ['typical', 'typical-p'] },
    { name: 'mirostat', form: 'value', caps: ['mirostat'] },
    { name: 'mirostat-lr', form: 'value', caps: ['mirostat-lr'] },
    { name: 'mirostat-ent', form: 'value', caps: ['mirostat-ent'] },

    // ---- chat & template ----
    { name: 'chat-template', form: 'value', caps: ['chat-template'] },
    { name: 'chat-template-file', form: 'value', caps: ['chat-template-file'] },
    { name: 'reverse-prompt', form: 'value', caps: ['r', 'reverse-prompt'] },

    // ---- advanced & debugging ----
    { name: 'grammar', form: 'value', caps: ['grammar'] },
    { name: 'grammar-file', form: 'value', caps: ['grammar-file'] },
    { name: 'log-disable', form: 'flag', caps: ['log-disable'] },
    { name: 'lora', form: 'value', caps: ['lora'] },
    { name: 'lora-scaled', form: 'pair', caps: ['lora-scaled'] },

    // ---- server scoped ----
    { name: 'api-key', form: 'value', caps: ['api-key'] },
    { name: 'api-key-file', form: 'value', caps: ['api-key-file'] },
    // A multi-token-prediction head is handed to llama.cpp as the draft
    // model for speculative decoding. The flag was renamed along the way,
    // so the older spellings are accepted as capabilities too.
    { name: 'spec-draft-model', form: 'value', caps: ['spec-draft-model', 'model-draft', 'md'] },
    // Speculative decoding is off unless this says otherwise — --spec-type
    // defaults to "none", so a draft model on its own does nothing. It is also
    // how a model whose MTP head is built in (Qwen3.6 and friends carry nextn
    // layers inside the file) turns the head on, with no separate file at all.
    { name: 'spec-type', form: 'value', caps: ['spec-type'] },
    { name: 'slots', form: 'flag', caps: ['slots'] },
    { name: 'no-slots', form: 'flag', caps: ['no-slots'] },
    { name: 'path', form: 'value', caps: ['path'] },
    { name: 'ssl-key-file', form: 'value', caps: ['ssl-key-file'] },
    { name: 'ssl-cert-file', form: 'value', caps: ['ssl-cert-file'] },
  ]

  function capsHave(caps, tokens) {
    if (!caps || Object.keys(caps).length === 0) return true // no capability map: emit and let the binary complain loudly
    for (const t of tokens) {
      if (caps[t] === true) return true
    }
    return false
  }

  /**
   * Build the argv for llama-server.
   * inputs:
   *  - model: { path, metadata?, profile, name }
   *  - version: { capabilities: {flagName:true}, build?, backend }
   *  - settings: { host, port, startupTimeoutMs }
   *  - overrides: optional profile field overrides (incl. gpuLayers resolved)
   * returns { ok, argv, warnings[], profileUsed }
   */
  function build(model, version, settings, overrides) {
    const caps = (version && version.capabilities) || {}
    const profile = util.deepMerge(model.profile || {}, overrides || {})
    const warnings = []
    const argv = []
    const skipped = []

    function push(optName, value) {
      const def = OPTION_DEFS.find((d) => d.name === optName)
      const tokens = def.caps
      if (!capsHave(caps, tokens)) {
        skipped.push(optName)
        return
      }
      if (def.form === 'flag') {
        if (value === true) argv.push('--' + optName)
      } else if (def.form === 'value') {
        if (value !== undefined && value !== null && value !== '') argv.push('--' + optName, String(value))
      } else if (def.form === 'bool-value') {
        if (typeof value === 'boolean') argv.push('--' + optName, value ? 'on' : 'off')
      } else if (def.form === 'pair') {
        // Both halves or neither: a lone --lora-scaled path is a parse error.
        if (Array.isArray(value) && value.length === 2
          && value.every(function (x) { return x !== undefined && x !== null && x !== '' })) {
          argv.push('--' + optName, String(value[0]), String(value[1]))
        }
      }
    }

    // Model path is always required.
    if (!model.path || model.path === '') {
      return { ok: false, code: 'NO_MODEL_PATH', message: 'The profile has no model path.' }
    }
    const requiredDef = OPTION_DEFS.find((d) => d.name === 'model')
    if (capsHave(caps, requiredDef.caps)) {
      argv.push('--model', model.path)
    } else {
      return { ok: false, code: 'NO_MODEL_FLAG', message: 'The installed llama.cpp build does not support --model.' }
    }

    const host = settings.host || '127.0.0.1'
    const port = settings.port || 8080
    push('host', host)
    push('port', port)

    const alias = profile.alias
    if (alias) {
      const v = security.validateModelId(alias)
      if (v.ok) push('alias', v.name)
      else warnings.push('model alias "' + alias + '" ignored: ' + v.message)
    }

    push('ctx-size', profile.contextSize)
    push('n-gpu-layers', profile.gpuLayers !== undefined ? profile.gpuLayers : undefined)
    push('threads', profile.threads)
    push('threads-batch', profile.threadsBatch)
    push('batch-size', profile.batchSize)
    push('ubatch-size', profile.ubatchSize)
    push('parallel', profile.parallel)
    // Continuous batching is on by default in llama-server; only the explicit
    // opt-out needs a flag.
    if (profile.contBatching === false) push('no-cont-batching', true)
    push('cache-reuse', profile.cacheReuse)
    push('threads-http', profile.threadsHttp)
    push('temp', profile.temperature)
    push('top-p', profile.topP)
    push('top-k', profile.topK)
    push('min-p', profile.minP)
    push('repeat-penalty', profile.repeatPenalty)
    push('repeat-last-n', profile.repeatLastN)
    push('presence-penalty', profile.presencePenalty)
    push('frequency-penalty', profile.frequencyPenalty)
    push('seed', profile.seed)
    if (typeof profile.flashAttn === 'boolean') push('flash-attn', profile.flashAttn)
    // Memory-mapping / locking: newer builds fold both into one --load-mode
    // value and print a deprecation warning for the old pair.
    // Modes: auto | none | mmap | mlock | mmap+mlock | dio.
    if (capsHave(caps, ['lm', 'load-mode'])) {
      if (profile.mlock === true) push('load-mode', profile.noMmap === true ? 'mlock' : 'mmap+mlock')
      else if (profile.noMmap === true) push('load-mode', 'none')
    } else {
      push('no-mmap', profile.noMmap === true)
      push('mlock', profile.mlock === true)
    }
    push('cache-type-k', profile.cacheTypeK)
    push('cache-type-v', profile.cacheTypeV)
    push('mmproj', profile.mmproj)
    push('metrics', profile.metrics !== false)
    // Tool calling needs the Jinja chat-template engine; `jinja` stays
    // supported for profiles written before the toggle existed.
    push('jinja', profile.toolCalling === true || profile.jinja === true)
    push('no-webui', profile.noWebui === true)
    push('n-cpu-moe', profile.nCpuMoe)
    push('threads-draft', profile.threadsDraft)
    push('rope-scaling', profile.ropeScaling)
    push('rope-scale', profile.ropeScale)
    push('rope-freq-base', profile.ropeFreqBase)

    // ---- core & hardware ----
    push('tensor-split', profile.tensorSplit)
    push('main-gpu', profile.mainGpu)
    push('no-kv-offload', profile.noKvOffload === true)
    push('numa', profile.numa)
    push('device', profile.device)
    push('cpu-mask', profile.cpuMask)

    // ---- context & performance ----
    push('keep', profile.keep)
    push('predict', profile.predict)

    // ---- generation & sampling ----
    push('typical', profile.typical)
    push('mirostat', profile.mirostat)
    push('mirostat-lr', profile.mirostatLr)
    push('mirostat-ent', profile.mirostatEnt)

    // ---- chat & template ----
    push('chat-template', profile.chatTemplate)
    push('chat-template-file', profile.chatTemplateFile)
    push('reverse-prompt', profile.reversePrompt)

    // ---- advanced & debugging ----
    push('grammar', profile.grammar)
    push('grammar-file', profile.grammarFile)
    push('log-disable', profile.logDisable === true)
    push('lora', profile.lora)
    push('lora-scaled', [profile.loraScaled, profile.loraScale])

    // The MTP head, when one was found and not turned off for this model:
    // a separate file, a head built into the model, or both.
    push('spec-draft-model', profile.draftModel)
    push('spec-type', profile.specType)

    // ---- server scoped ----
    // A command line is readable by any local process for as long as the server
    // runs, so the key goes in through a file wherever the build can read one.
    // `apiKeyFile` is only set when that flag is supported (see _apiKeyFile).
    if (profile.apiKeyFile !== undefined && capsHave(caps, ['api-key-file'])) {
      push('api-key-file', profile.apiKeyFile)
    } else {
      push('api-key', profile.apiKey)
    }
    // /slots is exposed by default; only the opt-out needs a flag.
    if (profile.slots === false) push('no-slots', true)
    push('path', profile.webPath)
    push('ssl-key-file', profile.sslKeyFile)
    push('ssl-cert-file', profile.sslCertFile)

    // Advanced free-form options: validated, structured argv items.
    const extra = security.validateExtraArgs(profile.extraArgs, caps)
    if (!extra.ok) {
      return { ok: false, code: extra.code, message: extra.message }
    }

    // An extra argument is the more explicit instruction, so where it names a
    // flag one of the fields above already emitted, the field's copy goes. Both
    // would work — llama.cpp keeps the last — but a command line that lists the
    // same option twice with different values cannot be read with confidence.
    const overridden = extra.args.filter(function (t) { return String(t).charAt(0) === '-' })
    for (const flag of overridden) {
      const at = argv.indexOf(flag)
      if (at === -1) continue
      const hasValue = at + 1 < argv.length && String(argv[at + 1]).charAt(0) !== '-'
      argv.splice(at, hasValue ? 2 : 1)
      warnings.push('--' + String(flag).replace(/^-+/, '') + ' from Model settings was replaced by the extra argument')
    }

    for (const t of extra.args) argv.push(t)

    const argCheck = security.validateArgv(argv)
    if (!argCheck.ok) {
      return { ok: false, code: argCheck.code, message: argCheck.message }
    }

    for (const s of skipped) warnings.push('option --' + s + ' skipped (not supported by installed version)')

    // Speculative decoding needs something to draft with. `--spec-type
    // draft-mtp` on its own is not an error llama.cpp will refuse — it just
    // generates at the ordinary speed — so a model asking for it with neither
    // a draft model nor a head built into its own file is asking for nothing.
    // This is easy to arrive at by hand: turning MTP off in Model settings
    // withholds --spec-draft-model, while an extra argument can still put
    // --spec-type back.
    const specAt = argv.indexOf('--spec-type')
    if (specAt !== -1 && String(argv[specAt + 1]) === 'draft-mtp'
      && argv.indexOf('--spec-draft-model') === -1
      && (model.metadata || {}).hasMtp !== true) {
      warnings.push('--spec-type draft-mtp is set but there is no head to draft with:'
        + ' this model has none built in and no --spec-draft-model was passed.'
        + ' Turn on Multi-token prediction in Model settings to use the mtp-*.gguf'
        + ' beside it, or drop the flag.')
    }

    return { ok: true, argv, warnings, profileUsed: profile }
  }

  LLAMA.modules.push('commandBuilder')
  // ---------- router presets ----------
  //
  // In router mode llama-server is handed the whole library at once and spawns
  // a child server per model on demand. The models come from an INI preset
  // file: one `[section]` per model, whose key/value pairs become that child's
  // command line. Building those sections from the same build() every single
  // launch uses is the point — a model serves through the router with exactly
  // the flags it would have been started with on its own.

  // The router binds the socket and names each child itself, passing
  // --host/--port/--alias to every one it spawns. A preset that repeats them
  // fights with it.
  const ROUTER_SUPPLIED = ['host', 'port', 'alias']

  // Whether the token after a flag is its value rather than the next flag.
  // `--seed -1` is a value; `--jinja --metrics` is not. Digits decide, because
  // negative numbers are the only values that start like a flag.
  function isValueToken(token) {
    if (token === undefined) return false
    const s = String(token)
    if (s.charAt(0) !== '-') return true
    return /^-\d/.test(s)
  }

  /**
   * One argv rendered as preset lines. llama.cpp's preset parser reads
   * `key = value` as `--key value` and `key = true` as a bare `--key`, so a
   * flag with no value has to be written as `true` rather than left bare
   * (verified against b10632).
   */
  function argvToIni(argv) {
    const lines = []
    for (let i = 0; i < argv.length; i += 1) {
      const token = String(argv[i])
      if (token.slice(0, 2) !== '--') continue
      const key = token.slice(2)
      const next = i + 1 < argv.length ? argv[i + 1] : undefined
      const hasValue = isValueToken(next)
      if (hasValue) i += 1
      if (ROUTER_SUPPLIED.includes(key)) continue
      lines.push(key + ' = ' + (hasValue ? String(next) : 'true'))
    }
    return lines
  }

  /**
   * Build the router's preset file.
   *
   * entries: [{ id, modelId, model: { path, name, profile } }] — `id` is the
   * name clients ask for and becomes the section header.
   *
   * A model whose flags cannot be built is left out with a warning rather than
   * failing the whole router: one unusable model must not cost you the others.
   */
  function buildPreset(entries, version) {
    const sections = []
    const warnings = []
    const lines = [
      '# llama.cpp Studio — generated router presets.',
      '# Rewritten from the model library every time the router starts;',
      '# edit launch flags in Model settings, not here.',
      '',
    ]
    for (const entry of entries || []) {
      const built = build(entry.model, version, { host: '127.0.0.1', port: 8080 })
      if (!built.ok) {
        warnings.push('"' + entry.id + '" is not in the router: ' + built.message)
        continue
      }
      for (const w of built.warnings || []) warnings.push(entry.id + ': ' + w)
      const flags = argvToIni(built.argv)
      lines.push('[' + entry.id + ']')
      for (const line of flags) lines.push(line)
      lines.push('')
      sections.push({
        id: entry.id,
        modelId: entry.modelId,
        name: entry.model.name,
        path: entry.model.path,
        flags,
      })
    }
    if (sections.length === 0) {
      return {
        ok: false, code: 'NO_ROUTER_MODELS',
        message: 'No model in the library can be served by the router.',
        warnings,
      }
    }
    return { ok: true, ini: lines.join('\n'), sections, warnings }
  }

  LLAMA.commandBuilder = { build, buildPreset, argvToIni, OPTION_DEFS, capsHave }
})(globalThis.LLAMA)
