// models.js — GGUF model manager: import (copy or reference), Hugging Face
// listing/download with resume + cancellation, GGUF metadata inspection, and
// the persistent model registry under metadata/models.json.
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util
  const security = LLAMA.security

  // Header-window ladder for GGUF scans (big tokenizer vocabularies need more).
  const HEAD_LADDER = [1024 * 1024, 8 * 1024 * 1024, 32 * 1024 * 1024]

  // Multimodal projectors ship beside the model as mmproj-*.gguf (llama.cpp,
  // Unsloth, LM Studio) or *-mmproj-*.gguf. Anything with "mmproj" in the name
  // is a projector, never a main model.
  const MMPROJ_RE = /mmproj/i

  // Multi-token-prediction heads ship as a separate GGUF beside the model, the
  // same way a vision projector does — "mtp-<model>.gguf", sometimes under an
  // MTP/ subfolder (see unsloth/gemma-4-26B-A4B-it-qat-GGUF). llama.cpp takes
  // one as the draft model for speculative decoding.
  //
  // Anchored on word boundaries so a model that merely has the letters in its
  // name is not mistaken for a head file.
  const MTP_RE = /(?:^|[^a-z0-9])mtp(?:[^a-z0-9]|$)/i

  // Where a repository keeps its MTP heads when they are not beside the model.
  const MTP_SUBDIRS = ['MTP', 'mtp']

  // "unsloth/Qwen3-VL-8B-GGUF" -> "unsloth__Qwen3-VL-8B-GGUF"
  function repoFolder(repo) {
    return String(repo).replace(/[\\/]+/g, '__').replace(/[^A-Za-z0-9._-]/g, '-')
  }

  // "Qwen3.6-35B-A3B-Q4_K_M.gguf"      -> "qwen3.6-35b-a3b"
  // "mmproj-Qwen3.6-35B-A3B-BF16.gguf" -> "qwen3.6-35b-a3b"
  // Reducing both sides to the same shape is what lets a projector be matched
  // to its model by name rather than by whatever the directory listing
  // happened to return first.
  function normalizeStem(name, stripProjectorPrefix) {
    let stem = util.stripExt(String(name || '')).toLowerCase()
    if (stripProjectorPrefix) stem = stem.replace(/^mmproj[-_.]*/, '')
    return stem.replace(/[-_.]?(q\d[^-_.]*|iq\d[^-_.]*|f32|f16|bf16)$/i, '')
  }

  // Length of the shared leading run — how much of the two names agree.
  function stemAffinity(a, b) {
    const len = Math.min(a.length, b.length)
    let n = 0
    while (n < len && a[n] === b[n]) n += 1
    return n
  }

  // Below this, two names have nothing meaningful in common and pairing them
  // would be a guess. A single model in the folder is unambiguous regardless.
  const MIN_AFFINITY = 4

  function ModelManager(deps) {
    this.deps = deps
    this.exec = deps.exec
    this.config = deps.config
    this.log = deps.log || function () {}
    this.progress = deps.progress || function () {}
    this.metaFile = util.joinPath(deps.config.get('paths').metadataDirectory, 'models.json')
    this.downloads = deps.downloads || {} // shared download task registry
  }

  // Whether this host can answer "is that file there?" at all.
  ModelManager.prototype._canStat = function () {
    return this.deps.fs !== undefined && typeof this.deps.fs.stat === 'function'
  }

  ModelManager.prototype._fileExists = async function (file) {
    if (typeof file !== 'string' || file === '') return false
    try {
      const target = await this.deps.fs.resolve(file)
      return (await this.deps.fs.stat(target)) !== undefined
    } catch (_err) {
      return false
    }
  }

  /**
   * A managed model lives at <modelsDirectory>/{imported,downloaded}/<file>, so
   * when the managed directory moves the file has moved with it and only the
   * recorded path is stale. Rebase onto the current directory when the recorded
   * file is gone and the corresponding one under it is present. Returns
   * undefined when there is nothing to repair.
   */
  ModelManager.prototype._rebaseFile = async function (file) {
    if (typeof file !== 'string' || file === '') return undefined
    const stored = util.norm(file)
    const candidate = util.joinPath(
      this.config.get('paths').modelsDirectory,
      util.basename(util.dirname(stored)),
      util.basename(stored))
    if (util.samePath(candidate, stored)) return undefined
    if (await this._fileExists(stored)) return undefined
    if (!(await this._fileExists(candidate))) return undefined
    return candidate
  }

  /**
   * Only managed models are repairable: a model imported by reference points at
   * wherever the user keeps it, which this app never moved and must not guess
   * at. Those simply read as missing on a machine that does not have the file.
   */
  ModelManager.prototype._rebase = async function (m) {
    if (!util.isPlainObject(m) || m.managed !== true) return m
    const path = await this._rebaseFile(m.path)
    const mmproj = await this._rebaseFile(m.mmprojPath)
    const mtp = await this._rebaseFile(m.mtpPath)
    if (path === undefined && mmproj === undefined && mtp === undefined) return m
    const out = util.deepClone(m)
    if (path !== undefined) out.path = path
    if (mmproj !== undefined) out.mmprojPath = mmproj
    if (mtp !== undefined) out.mtpPath = mtp
    return out
  }

  /**
   * A registration is the user's intent and is never dropped silently — a
   * missing file may just be an unplugged drive. It is stamped `missing`
   * instead, and every caller that would launch or copy it checks that first.
   * This is what keeps a data directory carried from another machine from
   * advertising models that were never copied with it.
   */
  ModelManager.prototype._stampPresence = async function (m) {
    if (!util.isPlainObject(m) || !this._canStat()) return m
    const present = await this._fileExists(m.path)
    if (present && m.missing === undefined) return m
    const out = util.deepClone(m)
    out.missing = !present
    return out
  }

  ModelManager.prototype._readMeta = async function () {
    const parsed = await util.readJsonFile(this.deps.fs, this.metaFile)
    if (!parsed || !Array.isArray(parsed.models)) return { models: [] }
    const models = []
    for (const m of parsed.models) models.push(await this._stampPresence(await this._rebase(m)))
    return Object.assign({}, parsed, { models })
  }

  ModelManager.prototype._writeMeta = async function (meta) {
    await this.exec.ensureDir(this.config.get('paths').metadataDirectory)
    return util.writeJsonFile(this.deps.fs, this.metaFile, meta)
  }

  /**
   * Companion files carry no weights you can serve on their own: a projector
   * (mmproj-*.gguf) goes to llama-server through --mmproj, and a multi-token
   * prediction head (mtp-*.gguf) through --spec-draft-model. Both ride along
   * with a real model.
   *
   * Registrations made before this distinction existed are classified here too,
   * by name, so a library that already collected companion files tidies itself
   * up on the next read rather than needing manual cleanup.
   *
   * Returns the kind, or undefined for an ordinary model.
   */
  function companionKind(entry) {
    if (entry.kind === 'mmproj' || entry.kind === 'mtp') return entry.kind
    if (entry.kind === 'model') return undefined
    const name = String(entry.name || util.basename(entry.path || ''))
    if (MMPROJ_RE.test(name)) return 'mmproj'
    if (MTP_RE.test(name)) return 'mtp'
    return undefined
  }

  function isProjector(entry) {
    return companionKind(entry) !== undefined
  }

  /**
   * The registration behind a model's projector, when the projector was itself
   * downloaded or imported rather than merely found on disk. Deleting the model
   * needs it, since projectors have no row of their own to delete from.
   */
  function companionOf(models, model) {
    if (!model || typeof model.mmprojPath !== 'string' || model.mmprojPath === '') return undefined
    return models.find(function (m) {
      return m.id !== model.id && util.samePath(String(m.path || ''), model.mmprojPath)
    })
  }

  ModelManager.prototype.list = async function () {
    const meta = await this._readMeta()
    const models = []
    const projectors = []
    for (const raw of meta.models) {
      const m = util.deepClone(raw)
      delete m.scanError
      m.profiles = m.profiles || []
      const companion = companionKind(m)
      if (companion !== undefined) {
        m.kind = companion
        projectors.push(m)
      } else {
        models.push(m)
      }
    }
    for (const m of models) {
      const mate = companionOf(projectors, m)
      if (mate !== undefined) {
        m.companion = { id: mate.id, name: mate.name, sizeBytes: mate.sizeBytes, managed: mate.managed === true }
      }
    }
    return { ok: true, models, projectors }
  }

  ModelManager.prototype.get = async function (id) {
    const meta = await this._readMeta()
    const m = meta.models.find((x) => x.id === id)
    if (!m) return { ok: false, code: 'MODEL_NOT_FOUND', message: 'Model "' + id + '" is not registered.' }
    return { ok: true, model: util.deepClone(m) }
  }

  ModelManager.prototype.byPath = async function (p) {
    const meta = await this._readMeta()
    const m = meta.models.find((x) => x.path === p)
    return m
  }

  /**
   * Inspect a GGUF file's header. Works on any readable local path.
   * Returns { ok, metadata, headerBytes }.
   */
  ModelManager.prototype.inspectFile = async function (path) {
    if (!/\.gguf$/i.test(path)) {
      return { ok: false, code: 'NOT_GGUF', message: 'The file must end in .gguf.' }
    }
    let last = undefined
    for (const window of HEAD_LADDER) {
      const read = await this.exec.headBytes(path, window)
      if (!read.ok) return { ok: false, code: 'READ_FAILED', message: 'Could not read the file: ' + read.error }
      const parsed = LLAMA.gguf.parseHeader(read.bytes)
      last = parsed
      if (parsed.ok) {
        const hints = LLAMA.gguf.filenameHints(path)
        const meta = LLAMA.gguf.summarize(parsed, hints)
        return { ok: true, metadata: meta, headerBytes: parsed.bytesRead, parsed }
      }
      if (parsed.reason !== 'truncated') break
    }
    // The metadata region can exceed even the largest window (large BPE merge
    // tables, long chat templates). Fall back to the streaming PowerShell
    // scanner, which walks the whole header region incrementally.
    const scan = await this.exec.ggufScan(path)
    if (scan.ok) {
      const hints = LLAMA.gguf.filenameHints(path)
      const meta = LLAMA.gguf.summarizeScan(scan, hints)
      return { ok: true, metadata: meta, headerBytes: scan.headerBytes, scanned: true, parsed: scan }
    }
    const reason = last ? last.reason : 'unknown'
    const scanNote = scan && !scan.ok ? '; streamed scan failed: ' + util.truncate(scan.error || 'unknown', 120) : ''
    return {
      ok: false, code: 'BAD_GGUF', reason,
      message: 'The file is not a valid GGUF file (' + reason + ')' + scanNote + '.',
      remediation: ['Re-download or re-copy the model — it may be corrupt or not a GGUF.'],
    }
  }

  /**
   * Look for a multimodal projector sitting next to a model file.
   * Returns { ok, mmproj?, candidates[] } — mmproj is the best match:
   * a projector whose name shares the model's stem wins over a generic one.
   */
  /**
   * The multi-token-prediction head that belongs to this model, if one is
   * sitting beside it — or in the MTP/ subfolder some repositories use.
   *
   * Same shape and the same stem-affinity ranking as detectMmproj: a repository
   * often ships several quantizations of the head, and the one whose name
   * corresponds to the model is the one to take.
   */
  ModelManager.prototype.detectMtp = async function (modelPath) {
    const dir = util.dirname(modelPath)
    const self = util.basename(modelPath).toLowerCase()
    const candidates = []

    // Windows treats MTP/ and mtp/ as one directory, so the same file would
    // otherwise be listed once per spelling.
    const seen = new Set()
    const scan = async (where) => {
      const items = await this.exec.listDir(where)
      if (items === undefined) return
      for (const it of items) {
        if (it.isDir === true) continue
        if (!/\.gguf$/i.test(it.name)) continue
        if (it.name.toLowerCase() === self) continue
        if (!MTP_RE.test(it.name)) continue
        const full = util.joinPath(where, it.name)
        const key = full.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        candidates.push({ name: it.name, path: full, size: it.size })
      }
    }

    await scan(dir)
    for (const sub of MTP_SUBDIRS) await scan(util.joinPath(dir, sub))

    if (candidates.length === 0) return { ok: true, mtp: undefined, candidates: [] }

    const stem = normalizeStem(self, false)
    const scored = candidates.map(function (c) {
      let score = stemAffinity(stem, normalizeStem(c.name, true))
      // The head has to run alongside the model on the same card; the smaller
      // quantizations are the sane default when a repository ships several.
      if (/q4|q8/i.test(c.name)) score += 0.5
      return { c, score }
    }).sort(function (a, b) { return b.score - a.score })

    return { ok: true, mtp: scored[0].c.path, candidates: candidates.map(function (c) { return c.path }) }
  }

  ModelManager.prototype.detectMmproj = async function (modelPath) {
    const dir = util.dirname(modelPath)
    const items = await this.exec.listDir(dir)
    if (items === undefined) return { ok: true, mmproj: undefined, candidates: [] }
    const self = util.basename(modelPath).toLowerCase()
    const candidates = items
      .filter((it) => it.isDir !== true
        && /\.gguf$/i.test(it.name)
        && it.name.toLowerCase() !== self
        && MMPROJ_RE.test(it.name))
      .map((it) => ({ name: it.name, path: util.joinPath(dir, it.name), size: it.size }))
    if (candidates.length === 0) return { ok: true, mmproj: undefined, candidates: [] }
    // Prefer the projector whose name corresponds to this model's, comparing
    // the normalized stems so the shared "mmproj-" prefix does not flatten
    // every score to zero and leave directory order deciding.
    const stem = normalizeStem(self, false)
    const scored = candidates.map((c) => {
      let score = stemAffinity(stem, normalizeStem(c.name, true))
      if (/f32|f16|bf16/i.test(c.name)) score += 0.5 // full-precision projectors are the usual pick
      return { c, score }
    }).sort((a, b) => b.score - a.score)
    return { ok: true, mmproj: scored[0].c.path, candidates: candidates.map((c) => c.path) }
  }

  /**
   * Point any model sitting in the same directory at a newly arrived projector,
   * so downloading the pair in either order ends up wired together. Models that
   * already have one are left alone — an explicit choice outranks a guess.
   * Returns the model's name when one was linked.
   */
  ModelManager.prototype._attachProjector = function (meta, projector) {
    const dir = util.dirname(projector.path).toLowerCase()
    const projStem = normalizeStem(projector.name, true)

    const siblings = meta.models.filter(function (m) {
      if (m.id === projector.id || m.kind === 'mmproj') return false
      if (MMPROJ_RE.test(String(m.name || ''))) return false
      return util.dirname(m.path).toLowerCase() === dir
    })

    // Always offer it as an alternative, whatever it ends up attached to.
    for (const m of siblings) {
      const candidates = Array.isArray(m.mmprojCandidates) ? m.mmprojCandidates.slice() : []
      if (!candidates.includes(projector.path)) candidates.push(projector.path)
      m.mmprojCandidates = candidates
    }

    const free = siblings.filter(function (m) { return m.mmprojPath === undefined })
    if (free.length === 0) return undefined

    const ranked = free.map(function (m) {
      return { m: m, score: stemAffinity(projStem, normalizeStem(m.name, false)) }
    }).sort(function (a, b) { return b.score - a.score })

    const best = ranked[0]
    // With one candidate the pairing is unambiguous; with several, only attach
    // when the names actually correspond — a wrong projector produces silently
    // broken vision output, which is worse than none at all.
    if (free.length > 1 && best.score < MIN_AFFINITY) return undefined
    best.m.mmprojPath = projector.path
    return best.m.name
  }

  /**
   * The same wiring for a multi-token-prediction head: point a model in the same
   * directory at a head that has just arrived, so downloading the pair in either
   * order ends up connected. A head under an MTP/ subfolder belongs to the model
   * in the directory above it.
   */
  ModelManager.prototype._attachMtp = function (meta, head) {
    const headDir = util.dirname(head.path).toLowerCase()
    const parentDir = util.dirname(util.dirname(head.path)).toLowerCase()
    const headStem = normalizeStem(head.name, true)

    const siblings = meta.models.filter(function (m) {
      if (m.id === head.id) return false
      if (companionKind(m) !== undefined) return false
      const dir = util.dirname(m.path).toLowerCase()
      return dir === headDir || dir === parentDir
    })

    for (const m of siblings) {
      const candidates = Array.isArray(m.mtpCandidates) ? m.mtpCandidates.slice() : []
      if (!candidates.includes(head.path)) candidates.push(head.path)
      m.mtpCandidates = candidates
    }

    const free = siblings.filter(function (m) { return m.mtpPath === undefined })
    if (free.length === 0) return undefined

    const ranked = free.map(function (m) {
      return { m: m, score: stemAffinity(headStem, normalizeStem(m.name, false)) }
    }).sort(function (a, b) { return b.score - a.score })

    const best = ranked[0]
    // A head from the wrong model produces wrong drafts, so several candidates
    // need the names to actually correspond before one is chosen.
    if (free.length > 1 && best.score < MIN_AFFINITY) return undefined
    best.m.mtpPath = head.path
    return best.m.name
  }

  ModelManager.prototype._withMmproj = async function (entry) {
    const found = await this.detectMmproj(entry.path)
    entry.mmprojPath = found.mmproj
    entry.mmprojCandidates = found.candidates
    const mtp = await this.detectMtp(entry.path)
    entry.mtpPath = mtp.mtp
    entry.mtpCandidates = mtp.candidates
    return entry
  }

  /**
   * Import an existing .gguf file.
   * opts: { path, mode: 'copy'|'reference', name? }
   */
  ModelManager.prototype.importModel = async function (opts) {
    const o = opts || {}
    const path = String(o.path || '')
    if (!util.isAbsolute(path)) {
      return { ok: false, code: 'RELATIVE_PATH', message: 'Import path must be absolute.' }
    }
    const ext = util.extname(path)
    if (ext !== '.gguf') {
      return { ok: false, code: 'NOT_GGUF', message: 'Only *.gguf files can be imported (got "' + ext + '").' }
    }
    const stat = await this.exec.stat(path)
    if (stat.exists !== true || stat.isDir === true) {
      return { ok: false, code: 'MISSING_FILE', message: 'The file does not exist: ' + path }
    }

    const inspect = await this.inspectFile(path)
    if (!inspect.ok) return inspect

    const meta = await this._readMeta()
    const dup = meta.models.find((m) => m.path === path)
    if (dup) {
      return { ok: false, code: 'DUPLICATE_MODEL', message: 'This file is already registered as "' + dup.name + '".' }
    }

    const mode = o.mode || this.config.get('models').importMode || 'copy'
    let finalPath = path
    let location = 'external'
    if (mode === 'copy') {
      const dir = util.joinPath(this.config.get('paths').modelsDirectory, 'imported')
      await this.exec.ensureDir(dir)
      let name = o.name || util.basename(path)
      const nameCheck = security.validateFileName(name)
      if (!nameCheck.ok) name = 'model.gguf'
      finalPath = util.joinPath(dir, name)
      if (await this.exec.pathExists(finalPath)) {
        // Avoid clobbering: uniquify the copy name.
        const stem = util.stripExt(name)
        let i = 2
        while (await this.exec.pathExists(finalPath)) {
          finalPath = util.joinPath(dir, stem + '-' + i + '.gguf')
          i += 1
        }
      }
      const copied = await this.exec.copy(path, finalPath)
      if (!copied.ok) {
        return { ok: false, code: 'COPY_FAILED', message: 'Could not copy the model into the managed directory: ' + (copied.error || '') }
      }
      location = 'imported'
    }

    const sizeBytes = mode === 'copy' ? await this.exec.fileSize(finalPath) : stat.size
    const entry = {
      id: util.uid('model'),
      name: util.basename(finalPath),
      path: finalPath,
      originalPath: mode === 'copy' ? path : undefined,
      managed: mode === 'copy',
      location,
      sizeBytes: sizeBytes !== undefined ? sizeBytes : stat.size,
      importedAt: util.nowIso(),
      metadata: inspect.metadata,
      profiles: [],
    }
    const importedKind = companionKind({ name: entry.name })
    if (importedKind === 'mtp') {
      entry.kind = 'mtp'
      meta.models.push(entry)
      const linked = this._attachMtp(meta, entry)
      await this._writeMeta(meta)
      this.log('imported MTP head ' + entry.name + (linked ? '; attached to ' + linked : ''))
      return { ok: true, model: entry, mtp: true, attachedTo: linked }
    }
    if (importedKind === 'mmproj') {
      entry.kind = 'mmproj'
      meta.models.push(entry)
      const linked = this._attachProjector(meta, entry)
      await this._writeMeta(meta)
      this.log('imported vision projector ' + entry.name + (linked ? '; attached to ' + linked : ''))
      return { ok: true, model: entry, projector: true, attachedTo: linked }
    }
    entry.kind = 'model'
    await this._withMmproj(entry)
    if (entry.mmprojPath === undefined && mode === 'copy') {
      // The projector usually stays next to the original file when only the
      // model itself was copied into the managed directory.
      const alt = await this.detectMmproj(path)
      entry.mmprojPath = alt.mmproj
      entry.mmprojCandidates = alt.candidates
    }
    if (entry.mtpPath === undefined && mode === 'copy') {
      // Same for the MTP head: it stays where the original model was.
      const alt = await this.detectMtp(path)
      entry.mtpPath = alt.mtp
      entry.mtpCandidates = alt.candidates
    }
    meta.models.push(entry)
    await this._writeMeta(meta)
    this.log('imported model ' + entry.name + (mode === 'copy' ? ' (copied)' : ' (referenced)')
      + (entry.mmprojPath ? '; vision projector detected: ' + util.basename(entry.mmprojPath) : '')
      + (entry.mtpPath ? '; MTP head detected: ' + util.basename(entry.mtpPath) : ''))
    return { ok: true, model: entry, copied: mode === 'copy' }
  }

  /**
   * List .gguf files in a Hugging Face repository.
   */
  ModelManager.prototype.hfListFiles = async function (repoRaw) {
    const repoCheck = security.validateRepository(repoRaw)
    if (!repoCheck.ok) return repoCheck
    const base = (this.config.get('llamaCpp') || {}).huggingfaceBase || 'https://huggingface.co'
    const url = base + '/api/models/' + repoCheck.repo + '/tree/main?recursive=true&expand=false'
    const r = await this.exec.httpGetJson(url, { timeoutMs: 45000 })
    if (!r.ok) {
      return {
        ok: false, code: 'HF_API_FAILED', message: 'Hugging Face API request failed: ' + r.message,
        remediation: ['Check the repository name.', 'Check your internet connection.'],
      }
    }
    const files = (Array.isArray(r.data) ? r.data : [])
      .filter((f) => f && typeof f.path === 'string' && /\.gguf$/i.test(f.path))
      // Flagged so the picker can say which rows are companion projectors
      // rather than models you can run on their own.
      .map((f) => ({
        path: String(f.path),
        size: Number(f.size) || 0,
        mmproj: MMPROJ_RE.test(String(f.path)),
        mtp: MTP_RE.test(String(f.path)),
        lfs: f.lfs !== undefined ? !!f.lfs : undefined,
      }))
      .sort((a, b) => a.path.localeCompare(b.path))
    if (files.length === 0) {
      return {
        ok: false, code: 'HF_NO_GGUF',
        message: 'No .gguf files found in "' + repoCheck.repo + '".',
        remediation: ['Pick a repository that publishes GGUF quantizations (e.g. "...-GGUF").'],
      }
    }
    return { ok: true, repo: repoCheck.repo, files }
  }

  /**
   * Download one GGUF file from Hugging Face (resumable, cancellable).
   */
  ModelManager.prototype.downloadModel = async function (opts) {
    const o = opts || {}
    const repoCheck = security.validateRepository(o.repo)
    if (!repoCheck.ok) return repoCheck
    const filename = String(o.filename || '').trim()
    if (filename === '' || filename.startsWith('/') || filename.startsWith('\\')) {
      return { ok: false, code: 'BAD_FILENAME', message: 'A valid file path inside the repository is required.' }
    }
    if (filename.split('/').some((seg) => seg === '..' || seg === '')) {
      return { ok: false, code: 'BAD_FILENAME', message: 'The file path contains invalid segments.' }
    }
    if (/[\u0000-\u001f]/.test(filename)) {
      return { ok: false, code: 'BAD_FILENAME', message: 'The file path contains control characters.' }
    }

    // Find the exact file + expected size through the tree API.
    const listing = await this.hfListFiles(o.repo)
    if (!listing.ok) return listing
    const match = listing.files.find((f) => f.path === filename)
    if (!match) {
      return { ok: false, code: 'HF_FILE_NOT_FOUND', message: 'File "' + filename + '" is not in the repository.' }
    }

    const base = (this.config.get('llamaCpp') || {}).huggingfaceBase || 'https://huggingface.co'
    const url = base + '/' + repoCheck.repo + '/resolve/main/' + filename + '?download=true'
    // One folder per repository. Flat storage meant a second repo's
   // "mmproj-BF16.gguf" collided with the first's and was refused as already
   // registered; it also left projectors from unrelated models sitting in the
   // same directory, which is exactly where the auto-detection looks.
    const dir = util.joinPath(this.config.get('paths').modelsDirectory, 'downloaded', repoFolder(repoCheck.repo))
    await this.exec.ensureDir(dir)
    const localName = util.basename(filename)
    const nameCheck = security.validateFileName(localName)
    const dest = util.joinPath(dir, nameCheck.ok ? nameCheck.name : 'model.gguf')

    // Duplicate guard for managed files.
    const meta = await this._readMeta()
    if (meta.models.some((m) => m.path === dest)) {
      return { ok: false, code: 'ALREADY_REGISTERED', message: localName + ' is already registered.' }
    }

    const taskId = util.uid('dl')
    const task = {
      id: taskId, kind: 'model-download', repo: repoCheck.repo, filename,
      state: 'downloading', bytes: 0, total: match.size, percent: 0,
      startedAt: util.nowIso(), dest, resumable: true,
    }
    this.downloads[taskId] = task
    this.progress('model-download', { id: taskId, stage: 'download', bytes: 0, total: match.size, message: 'Downloading ' + localName })

    const dl = this.exec.startDownload(url, dest, match.size, {
      maxTimeSec: Math.floor((this.config.get('llamaCpp') || {}).downloadTimeoutMs / 1000) || 7200,
    })
    if (!dl.ok) {
      delete this.downloads[taskId]
      return { ok: false, code: 'DOWNLOAD_SPAWN', message: 'Could not start the download: ' + dl.message }
    }
    task.cancel = function () { dl.cancel() }

    let prevBytes
    let prevAt
    const stopPoll = this.deps.timers.interval(async () => {
      const size = await this.exec.fileSize(dest)
      if (size === undefined) return
      const now = Date.now()
      const rate = util.transferRate(prevBytes, prevAt, size, now, match.size)
      prevBytes = size
      prevAt = now
      task.bytes = size
      task.percent = match.size > 0 ? Math.min(99.9, Math.round((size / match.size) * 1000) / 10) : undefined
      if (rate !== undefined) {
        task.bytesPerSecond = rate.bytesPerSecond
        task.etaSeconds = rate.etaSeconds
      }
      this.progress('model-download', Object.assign({
        id: taskId, stage: 'download', bytes: size, total: match.size, percent: task.percent,
      }, rate))
    }, 1000)

    const result = await dl.done
    if (typeof stopPoll === 'function') stopPoll()
    delete this.downloads[taskId]

    if (result.cancelled) {
      return { ok: false, code: 'DOWNLOAD_CANCELLED', message: 'Download cancelled; the partial file is kept for resume.' }
    }
    if (result.spawnFailed || (result.exitCode !== 0 && result.exitCode !== null)) {
      return {
        ok: false, code: 'DOWNLOAD_FAILED',
        message: 'Download failed (exit ' + result.exitCode + '). The partial file is kept; re-issuing the download resumes it.',
      }
    }
    const sizeOnDisk = await this.exec.fileSize(dest)
    if (match.size > 0 && sizeOnDisk !== undefined && Math.abs(sizeOnDisk - match.size) > 1024) {
      return {
        ok: false, code: 'SIZE_MISMATCH',
        message: 'Downloaded size does not match the repository metadata.',
        remediation: ['Delete the partial file and retry.'],
      }
    }

    const inspect = await this.inspectFile(dest)
    if (!inspect.ok) {
      return { ok: false, code: 'DOWNLOADED_INVALID', message: 'The downloaded file is not a valid GGUF: ' + inspect.message }
    }
    // A projector or an MTP head is a companion file, not something to serve.
    const kind = companionKind({ name: localName }) || 'model'
    const projector = kind === 'mmproj'
    const entry = {
      id: util.uid(kind === 'model' ? 'model' : kind),
      name: localName,
      path: dest,
      kind,
      managed: true,
      location: 'downloaded',
      source: { kind: 'huggingface', repo: repoCheck.repo, filename },
      sizeBytes: sizeOnDisk,
      importedAt: util.nowIso(),
      metadata: inspect.metadata,
      profiles: [],
    }
    if (kind === 'model') await this._withMmproj(entry)

    // Re-read rather than reusing the copy taken before the transfer: several
    // downloads can be in flight at once, and each finishing one must not write
    // back a snapshot that predates the others.
    const fresh = await this._readMeta()
    if (fresh.models.some((m) => m.path === dest)) {
      return { ok: false, code: 'ALREADY_REGISTERED', message: localName + ' is already registered.' }
    }
    fresh.models.push(entry)
    let attached
    if (projector) attached = this._attachProjector(fresh, entry)
    // The pair can arrive in either order, so a head that lands after its model
    // is wired up now rather than waiting for a rescan.
    if (kind === 'mtp') attached = this._attachMtp(fresh, entry)
    await this._writeMeta(fresh)

    const what = kind === 'mmproj' ? 'vision projector ' : (kind === 'mtp' ? 'MTP head ' : 'model ')
    this.log('downloaded ' + what + localName
      + ' from ' + repoCheck.repo + (attached ? '; attached to ' + attached : ''))
    return { ok: true, model: entry, projector, mtp: kind === 'mtp', attachedTo: attached }
  }

  ModelManager.prototype.cancelDownload = async function (id) {
    const task = this.downloads[id]
    if (!task) return { ok: false, code: 'TASK_NOT_FOUND', message: 'No active download with id ' + id + '.' }
    if (typeof task.cancel === 'function') task.cancel()
    return { ok: true, cancelled: true }
  }

  /**
   * Remove a projector registration (and its file when we own it). Split out so
   * deleteModel can reuse the same rules it applies to the model itself.
   */
  ModelManager.prototype._removeCompanion = async function (meta, mate) {
    if (mate === undefined) return undefined
    if (mate.managed === true) {
      const rm = await this.exec.removeTree(mate.path)
      if (rm && rm.ok === false) {
        this.log('could not delete the projector ' + mate.path + (rm.error ? ': ' + rm.error : ''))
        return undefined
      }
    }
    const at = meta.models.indexOf(mate)
    if (at !== -1) meta.models.splice(at, 1)
    // Any model still pointing at it must forget it, or it reads as missing.
    for (const m of meta.models) {
      if (util.samePath(String(m.mmprojPath || ''), mate.path)) m.mmprojPath = undefined
      if (Array.isArray(m.mmprojCandidates)) {
        m.mmprojCandidates = m.mmprojCandidates.filter(function (p) { return !util.samePath(p, mate.path) })
      }
    }
    return mate.name
  }

  ModelManager.prototype.activeDownloads = function () {
    return Object.keys(this.downloads).map((k) => {
      const t = this.downloads[k]
      return {
        id: t.id, kind: t.kind, repo: t.repo, filename: t.filename, state: t.state,
        bytes: t.bytes, total: t.total, percent: t.percent,
        bytesPerSecond: t.bytesPerSecond, etaSeconds: t.etaSeconds,
      }
    })
  }

  ModelManager.prototype.deleteModel = async function (id, opts) {
    const o = opts || {}
    const meta = await this._readMeta()
    const entry = meta.models.find((m) => m.id === id)
    if (!entry) return { ok: false, code: 'MODEL_NOT_FOUND', message: 'Model "' + id + '" is not registered.' }

    // Resolved before the model entry is removed, while mmprojPath still reads.
    const mate = o.deleteCompanion === true ? companionOf(meta.models, entry) : undefined
    let companionRemoved
    if (entry.managed === true) {
      const rm = await this.exec.removeTree(entry.path)
      if (!rm.ok) return { ok: false, code: 'REMOVE_FAILED', message: 'Could not delete the managed model file: ' + (rm.error || '') }
    }
    meta.models = meta.models.filter((m) => m.id !== id)
    companionRemoved = await this._removeCompanion(meta, mate)
    await this._writeMeta(meta)
    if (companionRemoved !== undefined) this.log(`removed vision projector ${companionRemoved} with ${entry.name}`)
    return { ok: true, removed: id, deletedFile: entry.managed === true, companionRemoved: companionRemoved }
  }

  ModelManager.prototype.rescan = async function (id) {
    const meta = await this._readMeta()
    const entry = meta.models.find((m) => m.id === id)
    if (!entry) return { ok: false, code: 'MODEL_NOT_FOUND', message: 'Model "' + id + '" is not registered.' }
    const stat = await this.exec.stat(entry.path)
    if (stat.exists !== true) {
      return { ok: false, code: 'MODEL_FILE_MISSING', message: 'The model file is missing: ' + entry.path }
    }
    entry.sizeBytes = stat.size
    const inspect = await this.inspectFile(entry.path)
    if (!inspect.ok) return inspect
    entry.metadata = inspect.metadata
    await this._withMmproj(entry)
    await this._writeMeta(meta)
    return { ok: true, model: entry }
  }

  /**
   * Per-model launch settings. One settings record per model — the flags the
   * Model Settings dialog edits and llama-server is started with.
   */
  ModelManager.prototype.getSettings = async function (id) {
    const r = await this.get(id)
    if (!r.ok) return r
    const model = r.model
    const defaults = LLAMA.profiles.defaultProfile({ metadata: model.metadata || {} })
    return {
      ok: true,
      id,
      settings: model.settings || {},
      effective: util.deepMerge(defaults, model.settings || {}),
      defaults,
      mmprojPath: model.mmprojPath,
      mmprojCandidates: model.mmprojCandidates || [],
    }
  }

  ModelManager.prototype.saveSettings = async function (id, settings) {
    if (!util.isPlainObject(settings)) {
      return { ok: false, code: 'BAD_SETTINGS', message: 'Settings must be an object.' }
    }
    const check = LLAMA.profiles.validateProfile(settings)
    if (!check.ok) {
      return { ok: false, code: 'BAD_SETTINGS', message: check.errors.join('; '), errors: check.errors }
    }
    const meta = await this._readMeta()
    const entry = meta.models.find((m) => m.id === id)
    if (!entry) return { ok: false, code: 'MODEL_NOT_FOUND', message: 'Model "' + id + '" is not registered.' }
    // Undefined/null values mean "unset" — never persist them as overrides.
    const clean = {}
    for (const key of Object.keys(settings)) {
      const v = settings[key]
      if (v === undefined || v === null || v === '') continue
      clean[key] = util.isPlainObject(v) || Array.isArray(v) ? util.deepClone(v) : v
    }
    entry.settings = clean
    entry.settingsUpdatedAt = util.nowIso()
    await this._writeMeta(meta)
    this.log('saved launch settings for ' + entry.name)
    return { ok: true, model: entry, warnings: check.warnings }
  }

  /**
   * Append a flag from the reference to a model's extra arguments.
   * Extra arguments are validated against the installed build before launch, so
   * this stays honest about what the engine will accept without needing a typed
   * field for every one of the couple of hundred options it exposes.
   */
  ModelManager.prototype.addFlag = async function (id, flag, value) {
    const name = String(flag || '').trim()
    if (!/^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) {
      return { ok: false, code: 'BAD_FLAG', message: 'That does not look like a command line flag: ' + name }
    }
    const meta = await this._readMeta()
    const entry = meta.models.find((m) => m.id === id)
    if (!entry) return { ok: false, code: 'MODEL_NOT_FOUND', message: 'Model "' + id + '" is not registered.' }

    const settings = util.isPlainObject(entry.settings) ? util.deepClone(entry.settings) : {}
    const args = Array.isArray(settings.extraArgs) ? settings.extraArgs.slice() : []

    const at = args.indexOf(name)
    const text = value === undefined || value === null ? '' : String(value).trim()
    if (at !== -1) {
      // Already there: replace whatever it was set to rather than adding the
      // flag twice, which llama.cpp resolves by last-one-wins and nobody reads.
      const hadValue = at + 1 < args.length && String(args[at + 1]).charAt(0) !== '-'
      if (text === '') {
        if (hadValue) args.splice(at + 1, 1)
      } else if (hadValue) {
        args[at + 1] = text
      } else {
        args.splice(at + 1, 0, text)
      }
      settings.extraArgs = args
      entry.settings = settings
      entry.settingsUpdatedAt = util.nowIso()
      await this._writeMeta(meta)
      return { ok: true, model: entry, flag: name, value: text || undefined, replaced: true }
    }

    args.push(name)
    if (text !== '') args.push(text)
    settings.extraArgs = args
    entry.settings = settings
    entry.settingsUpdatedAt = util.nowIso()
    await this._writeMeta(meta)
    this.log('added ' + name + (text ? ' ' + text : '') + ' to ' + entry.name)
    return { ok: true, model: entry, flag: name, value: text || undefined, replaced: false }
  }

  ModelManager.prototype.resetSettings = async function (id) {
    const meta = await this._readMeta()
    const entry = meta.models.find((m) => m.id === id)
    if (!entry) return { ok: false, code: 'MODEL_NOT_FOUND', message: 'Model "' + id + '" is not registered.' }
    delete entry.settings
    delete entry.settingsUpdatedAt
    await this._writeMeta(meta)
    return { ok: true, model: entry }
  }

  LLAMA.modules.push('models')
  LLAMA.models = { ModelManager, HEAD_LADDER, repoFolder, MMPROJ_RE, MTP_RE, companionKind }
})(globalThis.LLAMA)
