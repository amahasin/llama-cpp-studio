// versions.js — llama.cpp version manager: discovery, verified download,
// extraction, atomic install, capability scanning, activation, removal.
// deps: { exec, config, github, hardware, log, progress(name, fields) }
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util
  const security = LLAMA.security

  function VersionManager(deps) {
    this.deps = deps
    this.exec = deps.exec
    this.config = deps.config
    this.hardware = deps.hardware
    this.progress = deps.progress || function () {}
    this.log = deps.log || function () {}
    this.metaFile = util.joinPath(this.config.get('paths').metadataDirectory, 'installed_versions.json')
    this._busy = false
    this._busyTask = undefined
    // Versions already reported as absent, so the message is logged once.
    this._hiddenLogged = new Set()
  }

  /**
   * Official Windows CUDA builds ship the ggml CUDA backend but NOT the CUDA
   * runtime it links against (cudart/cublas). Those live in a companion
   * `cudart-llama-bin-win-cuda-<ver>-<arch>.zip` asset in the same release.
   * Without them ggml-cuda.dll cannot load, `--list-devices` reports none, and
   * llama-server silently runs everything on the CPU — the model looks like it
   * loaded into system RAM no matter what --n-gpu-layers says.
   */
  function findCudaRuntimeAsset(assets, cudaVersion, arch) {
    const list = assets || []
    const a = arch === 'arm64' ? 'arm64' : 'x64'
    const exact = list.find((x) => new RegExp('^cudart-llama-bin-win-cuda-'
      + String(cudaVersion).replace('.', '\\.') + '-' + a + '\\.zip$', 'i').test(x.name))
    if (exact) return exact
    // Fall back to the same major CUDA line, then to any Windows cudart build.
    const major = String(cudaVersion || '').split('.')[0]
    const sameMajor = list.filter((x) => new RegExp('^cudart-llama-bin-win-cuda-' + major + '\\.', 'i').test(x.name)
      && x.name.endsWith(a + '.zip'))
    if (sameMajor.length > 0) return sameMajor[0]
    return list.find((x) => /^cudart-llama-bin-win-cuda-/i.test(x.name) && x.name.endsWith(a + '.zip'))
  }

  // "Available devices:\n  CUDA0: NVIDIA GeForce RTX 3060 (12288 MiB, ...)"
  function parseDevices(text) {
    const lines = util.splitLines(text)
    const out = []
    let inList = false
    for (const raw of lines) {
      const line = raw.trim()
      if (/^available devices:/i.test(line)) { inList = true; continue }
      if (!inList) continue
      if (line === '' || /^\(none\)$/i.test(line)) continue
      const m = line.match(/^([A-Za-z0-9_]+):\s*(.+?)\s*$/)
      if (m) out.push({ id: m[1], description: m[2] })
    }
    return out
  }

  // Whether this host can answer "is that file there?" at all.
  VersionManager.prototype._canStat = function () {
    return this.deps.fs !== undefined && typeof this.deps.fs.stat === 'function'
  }

  VersionManager.prototype._fileExists = async function (file) {
    if (typeof file !== 'string' || file === '') return false
    try {
      const target = await this.deps.fs.resolve(file)
      return (await this.deps.fs.stat(target)) !== undefined
    } catch (_err) {
      return false
    }
  }

  /**
   * An installed build records absolute paths. When the managed directory moves
   * those paths are dead, yet the build itself is still sitting in
   * <installDirectory>/<version> — the whole folder travelled together. Repair
   * the entry whenever the recorded executable is gone and the one under the
   * current install directory is present; never the other way round, so a build
   * placed elsewhere by `install --targetDir` keeps its own location. The
   * repair rides along on the next _writeMeta(), so a read never writes.
   */
  VersionManager.prototype._rebase = async function (entry) {
    if (!util.isPlainObject(entry) || typeof entry.version !== 'string') return entry
    const dir = util.joinPath(this.config.get('paths').installDirectory, entry.version)
    const exePath = util.joinPath(dir, 'llama-server.exe')
    if (util.samePath(entry.exePath || '', exePath)) return entry
    if (await this._fileExists(entry.exePath)) return entry
    if (!(await this._fileExists(exePath))) return entry
    const out = util.deepClone(entry)
    out.path = dir
    out.exePath = exePath
    out.cliPath = util.joinPath(dir, 'llama-cli.exe')
    return out
  }

  /**
   * installed_versions.json is a record of what this manager installed, not a
   * wish list: a data directory copied from another machine names builds whose
   * executables were never copied with it. Anything whose llama-server.exe is
   * absent after the rebase above is dropped from the listing, so the UI never
   * offers a build that cannot run. The file itself is left alone until the
   * next install or removal rewrites it — a read must not race a write.
   */
  /**
   * Remove a cached archive after it has been successfully installed. Only
   * ever called on the success path: on failure the partial or suspect file is
   * deliberately kept, both because curl resumes from it and because several
   * error messages tell the user to delete it by hand.
   */
  VersionManager.prototype._discardArchive = async function (archivePath, label) {
    if (typeof archivePath !== 'string' || archivePath === '') return
    const size = await this.exec.fileSize(archivePath)
    const removed = await this.exec.removeTree(archivePath)
    if (removed && removed.ok === false) {
      this.log('could not delete the cached archive ' + archivePath
        + (removed.error ? ': ' + removed.error : ''))
      return
    }
    this.log('deleted the cached ' + label + ' archive ' + util.basename(archivePath)
      + (size ? ' (' + util.bytesHuman(size) + ' freed)' : ''))
  }

  // llama.cpp lays its help out in fixed columns: the flags occupy the first
  // 40 characters and the description everything after, wrapping onto lines
  // indented to the same column. A flag list longer than that column pushes the
  // description onto the following line entirely.
  const HELP_DESC_COLUMN = 40

  /**
   * Turn --help text into { sections: [{ title, options: [...] }] }.
   * Each option carries every alias it answers to, the argument placeholder,
   * the prose description, and the default and environment variable that
   * llama.cpp prints inside that prose.
   */
  function parseHelp(text) {
    const sections = []
    let section
    let current

    const flush = function () {
      if (current === undefined) return
      current.description = current.description.replace(/\s+/g, ' ').trim()
      const def = current.description.match(/\(default:\s*([^)]*)\)/i)
      if (def) current.defaultValue = def[1].trim()
      const env = current.description.match(/\(env:\s*([A-Z0-9_]+)\)/)
      if (env) current.env = env[1]
      // The parenthetical metadata reads as noise once it has its own field.
      current.summary = current.description
        .replace(/\(env:\s*[A-Z0-9_]+\)/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      section.options.push(current)
      current = undefined
    }

    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '')
      if (line === '') continue

      const header = line.match(/^-{3,}\s*(.+?)\s*-{3,}$/)
      if (header) {
        flush()
        section = { title: header[1], options: [] }
        sections.push(section)
        continue
      }
      if (section === undefined) {
        section = { title: 'general', options: [] }
        sections.push(section)
      }

      // A continuation line is indented past the description column.
      if (/^\s/.test(line)) {
        if (current !== undefined) current.description += ' ' + line.trim()
        continue
      }

      flush()
      // When the flag list runs past the column, the description starts on the
      // next line and this one is entirely flags.
      const head = line.slice(0, HELP_DESC_COLUMN).replace(/\s+$/, '').length < HELP_DESC_COLUMN
        ? line.slice(0, HELP_DESC_COLUMN).trim()
        : line.trim()
      const description = head === line.trim() ? '' : line.slice(HELP_DESC_COLUMN).trim()

      const flags = []
      let rest = head
      while (true) {
        const m = rest.match(/^(-{1,2}[^\s,]+)\s*,?\s*/)
        if (m === null) break
        flags.push(m[1])
        rest = rest.slice(m[0].length)
      }
      const arg = rest.trim() === '' ? undefined : rest.trim()
      if (flags.length === 0 || flags[0].charAt(0) !== '-') {
        current = undefined
        continue
      }

      current = {
        flags: flags,
        // The long form is what anyone should be typing into a config.
        name: flags.filter(function (x) { return x.indexOf('--') === 0 })[0] || flags[0],
        arg: arg,
        takesValue: arg !== undefined,
        description: description,
        section: section.title,
      }
    }
    flush()
    return { sections: sections.filter(function (x) { return x.options.length > 0 }) }
  }

  /**
   * The flag catalogue for an installed build, read from the binary itself.
   * Cached per version: --help costs a process start and the answer only
   * changes when the build does.
   */
  VersionManager.prototype.flagCatalog = async function (version) {
    const list = await this.listInstalled()
    const entry = version
      ? list.versions.find((v) => v.version === version)
      : (list.versions.find((v) => v.version === list.activeVersion) || list.versions[0])
    if (!entry) {
      return {
        ok: false, code: 'NOT_INSTALLED',
        message: 'No llama.cpp build is installed, so there is nothing to read flags from.',
        remediation: ['Download an engine on this page first.'],
      }
    }
    if (this._flagCache === undefined) this._flagCache = {}
    if (this._flagCache[entry.version] !== undefined) {
      return Object.assign({ ok: true, cached: true }, this._flagCache[entry.version])
    }
    const r = await this.exec.run([entry.exePath, '--help'], {
      cwd: entry.path, stdoutBytes: 2 * 1024 * 1024, stderrBytes: 512 * 1024, timeoutMs: 60000,
    })
    if (r.spawnFailed) {
      return { ok: false, code: 'HELP_FAILED', message: 'Could not run the engine: ' + r.error }
    }
    const parsed = parseHelp((r.stdout || '') + '\n' + (r.stderr || ''))
    const total = parsed.sections.reduce(function (n, sec) { return n + sec.options.length }, 0)
    if (total === 0) {
      return { ok: false, code: 'HELP_EMPTY', message: 'The engine printed no recognisable options.' }
    }
    const payload = {
      version: entry.version,
      backend: entry.backend,
      sections: parsed.sections,
      total: total,
    }
    this._flagCache[entry.version] = payload
    this.log('read ' + total + ' flags from ' + entry.version + ' --help')
    return Object.assign({ ok: true, cached: false }, payload)
  }

  VersionManager.prototype._readMeta = async function () {
    const parsed = await util.readJsonFile(this.deps.fs, this.metaFile)
    if (!parsed || !Array.isArray(parsed.versions)) return { versions: [] }
    const versions = []
    const canStat = this._canStat()
    for (const raw of parsed.versions) {
      const entry = await this._rebase(raw)
      if (!canStat || await this._fileExists(entry.exePath)) versions.push(entry)
      else if (!this._hiddenLogged.has(entry.version)) {
        // _readMeta runs on every status poll; without this the log fills with
        // the same line several times a second on a machine that has no engine.
        this._hiddenLogged.add(entry.version)
        this.log('build ' + entry.version + ' is registered but not installed here ('
          + entry.exePath + ') — hidden until it is reinstalled')
      }
    }
    return Object.assign({}, parsed, { versions })
  }

  VersionManager.prototype._writeMeta = async function (meta) {
    await this.exec.ensureDir(this.config.get('paths').metadataDirectory)
    return util.writeJsonFile(this.deps.fs, this.metaFile, meta)
  }

  VersionManager.prototype.listInstalled = async function () {
    const meta = await this._readMeta()
    const cfg = this.config.get('llamaCpp')
    return {
      ok: true,
      versions: meta.versions,
      activeVersion: cfg.activeVersion || undefined,
    }
  }

  VersionManager.prototype.getInstalled = async function (version) {
    const list = await this.listInstalled()
    const v = list.versions.find((x) => x.version === version || String(x.build) === String(version))
    return v
  }

  /**
   * Query the latest release and, when hardware is known, the best asset for
   * a requested backend. Returns rich selection info for the UI.
   */
  VersionManager.prototype.latestVersion = async function (requestedBackend) {
    const rel = await this.deps.github.latestRelease()
    if (!rel.ok) return rel
    const hw = await this.deps.hardware.context()
    const backend = requestedBackend || (this.config.get('hardware') || {}).backend || 'auto'
    const sel = LLAMA.assetSelector.selectBestAsset(rel.data.assets, {
      os: hw.os,
      arch: hw.cpu.arch,
      backend,
      cuda: hw.cuda,
      vulkan: hw.vulkan,
      hip: hw.hip,
      sycl: hw.sycl,
      cpu: hw.cpu.features,
    })
    const installed = await this.listInstalled()
    const currentBuild = installed.activeVersion
      ? installed.versions.find((v) => v.version === installed.activeVersion)
      : undefined
    return {
      ok: true,
      latest: {
        tagName: rel.data.tagName,
        publishedAt: rel.data.publishedAt,
        htmlUrl: rel.data.htmlUrl,
        assetCount: rel.data.assets.length,
      },
      selection: {
        backend,
        ok: sel.ok,
        asset: sel.ok ? sel.asset : undefined,
        parsed: sel.ok ? sel.parsed : undefined,
        score: sel.ok ? sel.score : undefined,
        reasons: sel.reasons || [],
        alternatives: sel.alternatives || [],
        candidates: sel.candidates || [],
      },
      installed: installed.versions,
      activeVersion: installed.activeVersion,
      updateAvailable: currentBuild !== undefined
        && LLAMA.assetSelector.compareVersions(rel.data.tagName, currentBuild.version) > 0,
    }
  }

  VersionManager.prototype.busy = function () { return this._busyTask }

  /**
   * Download + verify + extract + install the latest release (or a specific
   * release object). This is the only code path that installs binaries.
   * Progress events: {stage, bytes?, total?, percent?, message}
   */
  VersionManager.prototype.install = async function (opts) {
    if (this._busy) return { ok: false, code: 'INSTALL_BUSY', message: 'An install is already running.' }
    const o = opts || {}
    this._busy = true
    const task = { id: util.uid('install'), kind: 'install', startedAt: util.nowIso() }
    this._busyTask = task
    try {
      const result = await this._install(o, task)
      return result
    } finally {
      this._busy = false
      this._busyTask = undefined
    }
  }

  /**
   * Abort the install in flight. The archive is a few hundred megabytes and the
   * only way out used to be closing the app, so this terminates curl and lets
   * _install() unwind at its next checkpoint. The partial file stays on disk:
   * curl resumes from it if the download is started again.
   */
  VersionManager.prototype.cancelInstall = function () {
    const task = this._busyTask
    if (!task) return { ok: false, code: 'NOT_INSTALLING', message: 'No install is running.' }
    task.cancelled = true
    if (typeof task.cancel === 'function') {
      try { task.cancel() } catch (_e) { /* already gone */ }
    }
    this.progress('install', { stage: 'cancelled', message: 'Cancelling…' })
    this.log('install cancelled by the user')
    return { ok: true, cancelled: true, id: task.id }
  }

  VersionManager.prototype.installStatus = function () {
    const task = this._busyTask
    return {
      ok: true,
      running: this._busy === true,
      task: task ? { id: task.id, kind: task.kind, startedAt: task.startedAt, cancelled: task.cancelled === true } : undefined,
    }
  }

  VersionManager.prototype._install = async function (o, task) {
    const exec = this.exec
    const paths = this.config.get('paths')
    const backend = o.backend || (this.config.get('hardware') || {}).backend || 'auto'
    const log = this.log

    // 1. Release metadata
    this.progress('install', { stage: 'release', message: 'Checking the latest llama.cpp release...' })
    const rel = await this.deps.github.latestRelease()
    if (!rel.ok) return rel

    // 2. Hardware context + asset selection
    const hw = await this.deps.hardware.context()
    const sel = LLAMA.assetSelector.selectBestAsset(rel.data.assets, {
      os: hw.os, arch: hw.cpu.arch, backend,
      cuda: hw.cuda, vulkan: hw.vulkan, hip: hw.hip, sycl: hw.sycl, cpu: hw.cpu.features,
    })
    if (!sel.ok) {
      return {
        ok: false, code: 'NO_ASSET', message: 'No llama.cpp release asset matches this machine.',
        reasons: sel.reasons, candidates: sel.candidates,
        remediation: [
          'Try another backend: ' + JSON.stringify(['auto', 'cpu', 'cuda', 'vulkan']),
          'Install llama.cpp manually and register it with the "Register existing installation" flow.',
        ],
      }
    }
    const asset = sel.asset
    const version = rel.data.tagName // e.g. b8000

    // 3. Do not clobber an existing installation of the same version.
    const installed = await this._readMeta()
    if (installed.versions.some((v) => v.version === version)) {
      return { ok: false, code: 'ALREADY_INSTALLED', message: 'Version ' + version + ' is already installed.' }
    }

    // 4. Download (resumable) into cache.
    await exec.ensureDir(paths.cacheDirectory)
    const downloadsDir = util.joinPath(paths.cacheDirectory, 'downloads')
    await exec.ensureDir(downloadsDir)
    const archivePath = util.joinPath(downloadsDir, asset.name)
    log('downloading ' + asset.name + ' (' + util.bytesHuman(asset.size) + ')')
    this.progress('install', { stage: 'download', bytes: 0, total: asset.size, message: 'Downloading ' + asset.name })

    const urlCheck = security.validateHttpUrl(asset.downloadUrl)
    if (!urlCheck.ok) {
      return { ok: false, code: 'BAD_ASSET_URL', message: 'Release asset URL failed validation: ' + urlCheck.message }
    }

    const dl = exec.startDownload(urlCheck.url, archivePath, asset.size, {
      maxTimeSec: Math.floor((this.config.get('llamaCpp') || {}).downloadTimeoutMs / 1000) || 7200,
    })
    if (!dl.ok) {
      return { ok: false, code: 'DOWNLOAD_SPAWN', message: 'Could not start download: ' + dl.message }
    }
    if (task) task.cancel = function () { dl.cancel() }
    let lastTick = 0
    let prevBytes
    let prevAt
    const stopPoll = this.deps.timers.interval(async () => {
      const size = await exec.fileSize(archivePath)
      if (size === undefined) return
      const now = Date.now()
      if (now - lastTick > 800) {
        const rate = util.transferRate(prevBytes, prevAt, size, now, asset.size)
        prevBytes = size
        prevAt = now
        lastTick = now
        this.progress('install', Object.assign({
          stage: 'download', bytes: size, total: asset.size,
          percent: asset.size > 0 ? Math.min(99.9, Math.round((size / asset.size) * 1000) / 10) : undefined,
          message: 'Downloading ' + asset.name,
        }, rate))
      }
    }, 1000)
    const dlResult = await dl.done
    if (typeof stopPoll === 'function') stopPoll()

    if (dlResult.cancelled) {
      return { ok: false, code: 'DOWNLOAD_CANCELLED', message: 'Download cancelled. The partial file is kept for resume.' }
    }
    if (dlResult.spawnFailed || (dlResult.exitCode !== 0 && dlResult.exitCode !== null)) {
      return {
        ok: false, code: 'DOWNLOAD_FAILED',
        message: 'Download failed (exit ' + dlResult.exitCode + '). Partial file kept for resume.',
        remediation: ['Check your internet connection and retry — the download resumes where it stopped.'],
      }
    }

    // 5. Verify: size against the release metadata + archive integrity via tar.
    const sizeOnDisk = await exec.fileSize(archivePath)
    if (sizeOnDisk === undefined || (asset.size > 0 && Math.abs(sizeOnDisk - asset.size) > 1024)) {
      return {
        ok: false, code: 'SIZE_MISMATCH',
        message: 'Downloaded size (' + util.bytesHuman(sizeOnDisk) + ') does not match the release metadata (' + util.bytesHuman(asset.size) + ').',
        remediation: ['Delete the cache file and retry the download.'],
      }
    }
    this.progress('install', { stage: 'verify', message: 'Verifying archive integrity...' })
    const tarList = await exec.run([
      LLAMA.exec.TOOLS.tar,
      '-tf', archivePath,
    ], { stdoutBytes: 8 * 1024 * 1024, timeoutMs: 5 * 60 * 1000 })
    if (tarList.spawnFailed || tarList.exitCode !== 0) {
      return {
        ok: false, code: 'CORRUPT_ARCHIVE',
        message: 'The downloaded archive is corrupt or unreadable: tar -tf failed with exit ' + tarList.exitCode + '.',
        remediation: ['Delete the cache file and retry the download.', 'Checksum information is not published for llama.cpp release assets, so archive listing is the verification used here.'],
      }
    }
    if (!/llama-server(\.exe)?/i.test(tarList.stdout + tarList.stderr)) {
      return {
        ok: false, code: 'NO_SERVER_IN_ARCHIVE',
        message: 'The archive does not contain llama-server. It may not be a llama.cpp server bundle.',
        remediation: ['Report this to the plugin author with the asset name: ' + asset.name],
      }
    }

    // 6. Extract into a staging directory.
    const staging = util.joinPath(paths.cacheDirectory, 'extract', version + '-' + util.uid('stg').slice(-6))
    await exec.ensureDir(staging)
    this.progress('install', { stage: 'extract', message: 'Extracting ' + asset.name + '...' })
    const tarX = await exec.run([
      LLAMA.exec.TOOLS.tar, '-xf', archivePath, '-C', staging,
    ], { timeoutMs: 15 * 60 * 1000, graceMs: 15000 })
    if (tarX.spawnFailed || tarX.exitCode !== 0) {
      await exec.removeTree(staging)
      return { ok: false, code: 'EXTRACT_FAILED', message: 'Extraction failed: ' + util.truncate(tarX.stderr || 'exit ' + tarX.exitCode, 300) }
    }

    // 7. Locate the executables inside the staging tree.
    const findExe = async (dir, name) => {
      const items = await exec.listDir(dir)
      if (items === undefined) return undefined
      for (const it of items) {
        const p = util.joinPath(dir, it.name)
        if (!it.isDir && it.name.toLowerCase() === name.toLowerCase()) return p
        if (it.isDir) {
          const found = await findExe(p, name)
          if (found) return found
        }
      }
      return undefined
    }
    const serverExe = await findExe(staging, 'llama-server.exe')
    if (!serverExe) {
      await exec.removeTree(staging)
      return {
        ok: false, code: 'NO_SERVER_EXE',
        message: 'llama-server.exe was not found after extraction.',
        remediation: ['The asset layout may have changed upstream — try another backend or an older release.'],
      }
    }

    // 8. Atomic move into <installDirectory>/<version> (never overwrites an
    //    existing dir). A per-install target directory overrides the setting.
    const installRoot = o.targetDir !== undefined && String(o.targetDir).trim() !== ''
      ? util.norm(String(o.targetDir).trim()).replace(/\/+$/, '')
      : paths.installDirectory
    if (!util.isAbsolute(installRoot)) {
      return { ok: false, code: 'BAD_INSTALL_DIR', message: 'The install directory must be an absolute path.' }
    }
    const finalDir = util.joinPath(installRoot, version)
    await exec.ensureDir(installRoot)
    if (await exec.pathExists(finalDir)) {
      await exec.removeTree(staging)
      return { ok: false, code: 'VERSION_DIR_EXISTS', message: 'bin/' + version + ' already exists; not overwriting.' }
    }
    const moved = await exec.move(staging, finalDir)
    if (!moved.ok) {
      await exec.removeTree(staging)
      return { ok: false, code: 'MOVE_FAILED', message: 'Could not move the extracted build into place: ' + (moved.error || '') }
    }

    // 9. Capability scan: --version + --help of the installed binary.
    this.progress('install', { stage: 'scan', message: 'Scanning binary capabilities...' })
    const finalExe = util.joinPath(finalDir, 'llama-server.exe')
    const versionOut = await exec.run([finalExe, '--version'], {
      cwd: finalDir, stdoutBytes: 64 * 1024, timeoutMs: 30000,
    })
    const helpOut = await exec.run([finalExe, '--help'], {
      cwd: finalDir, stdoutBytes: 4 * 1024 * 1024, stderrBytes: 4 * 1024 * 1024, timeoutMs: 60000,
    })
    const combined = (helpOut.stdout || '') + '\n' + (helpOut.stderr || '')
    const capabilities = {}
    const flagRe = /(?:^|[\s"'])(--?[a-z][a-z0-9-]*)/g
    let m
    while ((m = flagRe.exec(combined)) !== null) {
      const flag = m[1]
      capabilities[flag.replace(/^-{1,2}/, '')] = true
    }
    const buildMatch = (versionOut.stdout || '').match(/(?:version|build)\s*:?\s*(\d+)/i)
    const build = buildMatch ? Number(buildMatch[1]) : undefined
    const exeSha = await exec.sha256(finalExe)

    const entry = {
      version,
      releaseTag: rel.data.tagName,
      build,
      cudaRuntime: undefined,
      devices: undefined,
      gpuRuntimeOk: undefined,
      installedAt: util.nowIso(),
      platform: hw.os,
      architecture: hw.cpu.arch,
      backend: sel.parsed.backend,
      cudaVersion: sel.parsed.cudaVersion,
      cpuVariant: sel.parsed.cpuVariant,
      path: finalDir,
      exePath: finalExe,
      cliPath: (await findExe(finalDir, 'llama-cli.exe')) || undefined,
      ggufToolPath: (await findExe(finalDir, 'llama-gguf.exe')) || undefined,
      archive: { name: asset.name, size: asset.size },
      sha256: exeSha,
      capabilities,
      capabilityFlags: Object.keys(capabilities),
    }

    // 9b. CUDA builds are useless without their runtime companion: install it
    //     before the version is registered, then confirm the binary can see a
    //     GPU. Skipping this is what makes a "CUDA" build run on the CPU — the
    //     UI offers it as a separate download for exactly that reason.
    if (sel.parsed.backend === 'cuda' && o.skipCudaRuntime !== true) {
      const runtime = await this._installCudaRuntime(rel.data.assets, entry, sel.parsed.cudaVersion, hw.cpu.arch)
      if (runtime.ok) {
        entry.cudaRuntime = runtime.asset
      } else {
        log('CUDA runtime not installed: ' + runtime.message)
        entry.cudaRuntimeError = runtime.message
      }
    }
    this.progress('install', { stage: 'scan', message: 'Checking compute devices…' })
    const deviceList = await this.listDevices(entry)
    entry.devices = deviceList.devices
    if (sel.parsed.backend === 'cuda') {
      entry.gpuRuntimeOk = deviceList.devices.some((d) => /^CUDA/i.test(d.id))
      if (!entry.gpuRuntimeOk) {
        log('WARNING: the installed CUDA build reports no GPU devices — it will run on the CPU'
          + ' until the CUDA runtime is installed.')
      }
    }

    // 10. Record metadata, activate if nothing active yet.
    installed.versions.push(entry)
    await this._writeMeta(installed)
    const cfg = this.config.get('llamaCpp')
    if (!cfg.activeVersion) {
      cfg.activeVersion = version
      await this.config.save()
    }
    await this._discardArchive(archivePath, 'engine')
    this.progress('install', { stage: 'done', message: 'Installed llama.cpp ' + version, version })
    log('installed llama.cpp ' + version + ' (' + sel.parsed.backend + ') into ' + finalDir
      + ' — devices: ' + (entry.devices.map((d) => d.id).join(', ') || 'none'))
    return {
      ok: true,
      installed: entry,
      activated: cfg.activeVersion === version,
      gpuRuntimeOk: entry.gpuRuntimeOk,
      warning: entry.gpuRuntimeOk === false
        ? 'The CUDA build reports no GPU devices, so llama-server would run on the CPU. Use "Fix GPU runtime" on the llama.cpp page.'
        : undefined,
    }
  }

  /**
   * Download the release's CUDA runtime companion and drop its DLLs next to
   * llama-server.exe. Safe to re-run: tar overwrites in place.
   * Returns { ok, asset, skipped?, message? }.
   */
  VersionManager.prototype._installCudaRuntime = async function (assets, entry, cudaVersion, arch) {
    const exec = this.exec
    const paths = this.config.get('paths')
    const asset = findCudaRuntimeAsset(assets, cudaVersion, arch)
    if (!asset) {
      return { ok: false, code: 'NO_CUDART_ASSET', message: 'This release has no CUDA runtime archive for CUDA ' + cudaVersion + '.' }
    }
    const urlCheck = security.validateHttpUrl(asset.downloadUrl)
    if (!urlCheck.ok) return { ok: false, code: 'BAD_ASSET_URL', message: urlCheck.message }

    const downloadsDir = util.joinPath(paths.cacheDirectory, 'downloads')
    await exec.ensureDir(downloadsDir)
    const archivePath = util.joinPath(downloadsDir, asset.name)
    this.log('downloading CUDA runtime ' + asset.name + ' (' + util.bytesHuman(asset.size) + ')')
    this.progress('install', {
      stage: 'cuda-runtime', bytes: 0, total: asset.size,
      message: 'Downloading the CUDA runtime (' + util.bytesHuman(asset.size) + ')',
    })

    const dl = exec.startDownload(urlCheck.url, archivePath, asset.size, {
      maxTimeSec: Math.floor((this.config.get('llamaCpp') || {}).downloadTimeoutMs / 1000) || 7200,
    })
    if (!dl.ok) return { ok: false, code: 'DOWNLOAD_SPAWN', message: dl.message }
    if (this._busyTask) this._busyTask.cancel = function () { dl.cancel() }
    let lastTick = 0
    let prevBytes
    let prevAt
    const stopPoll = this.deps.timers.interval(async () => {
      const size = await exec.fileSize(archivePath)
      if (size === undefined) return
      const now = Date.now()
      if (now - lastTick > 800) {
        const rate = util.transferRate(prevBytes, prevAt, size, now, asset.size)
        prevBytes = size
        prevAt = now
        lastTick = now
        this.progress('install', Object.assign({
          stage: 'cuda-runtime', bytes: size, total: asset.size,
          percent: asset.size > 0 ? Math.min(99.9, Math.round((size / asset.size) * 1000) / 10) : undefined,
          message: 'Downloading the CUDA runtime',
        }, rate))
      }
    }, 1000)
    const result = await dl.done
    if (typeof stopPoll === 'function') stopPoll()
    if (result.cancelled) return { ok: false, code: 'DOWNLOAD_CANCELLED', message: 'CUDA runtime download cancelled.' }
    if (result.spawnFailed || (result.exitCode !== 0 && result.exitCode !== null)) {
      return { ok: false, code: 'DOWNLOAD_FAILED', message: 'CUDA runtime download failed (exit ' + result.exitCode + ').' }
    }
    const sizeOnDisk = await exec.fileSize(archivePath)
    if (sizeOnDisk === undefined || (asset.size > 0 && Math.abs(sizeOnDisk - asset.size) > 1024)) {
      return { ok: false, code: 'SIZE_MISMATCH', message: 'The CUDA runtime archive is incomplete; retry the download.' }
    }

    this.progress('install', { stage: 'cuda-runtime', message: 'Installing the CUDA runtime…' })
    const listing = await exec.run([LLAMA.exec.TOOLS.tar, '-tf', archivePath], {
      stdoutBytes: 4 * 1024 * 1024, timeoutMs: 5 * 60 * 1000,
    })
    if (listing.spawnFailed || listing.exitCode !== 0) {
      return { ok: false, code: 'CORRUPT_ARCHIVE', message: 'The CUDA runtime archive is unreadable; delete it from cache/downloads and retry.' }
    }
    if (!/cudart64|cublas64/i.test(listing.stdout + listing.stderr)) {
      return { ok: false, code: 'NOT_CUDART', message: 'The archive does not contain the CUDA runtime DLLs.' }
    }
    // Extracted straight into the build directory: the DLLs must sit next to
    // llama-server.exe for the loader to find them.
    const extract = await exec.run([LLAMA.exec.TOOLS.tar, '-xf', archivePath, '-C', entry.path], {
      timeoutMs: 15 * 60 * 1000, graceMs: 15000,
    })
    if (extract.spawnFailed || extract.exitCode !== 0) {
      return { ok: false, code: 'EXTRACT_FAILED', message: 'Could not extract the CUDA runtime: ' + util.truncate(extract.stderr || ('exit ' + extract.exitCode), 200) }
    }
    await this._discardArchive(archivePath, 'CUDA runtime')
    this.log('installed CUDA runtime ' + asset.name + ' into ' + entry.path)
    return { ok: true, asset: { name: asset.name, size: asset.size } }
  }

  /**
   * Ask the installed binary which compute devices it can actually use.
   * A CUDA build with an empty list is missing its runtime.
   */
  VersionManager.prototype.listDevices = async function (entry) {
    const r = await this.exec.run([entry.exePath, '--list-devices'], {
      cwd: entry.path, stdoutBytes: 256 * 1024, stderrBytes: 256 * 1024, timeoutMs: 60000,
    })
    if (r.spawnFailed) return { ok: false, message: r.error, devices: [] }
    const devices = parseDevices((r.stdout || '') + '\n' + (r.stderr || ''))
    return { ok: true, devices }
  }

  /**
   * Install (or re-install) the CUDA runtime for a build that does not have it
   * — either because it was installed before the companion download existed,
   * or because the engine was downloaded on its own. Re-checks the devices.
   */
  VersionManager.prototype.installRuntime = async function (version) {
    if (this._busy) return { ok: false, code: 'INSTALL_BUSY', message: 'An install is already running.' }
    const meta = await this._readMeta()
    const entry = meta.versions.find((v) => v.version === version)
    if (!entry) return { ok: false, code: 'NOT_INSTALLED', message: 'Version ' + version + ' is not installed.' }
    if (entry.backend !== 'cuda') {
      return { ok: false, code: 'NOT_CUDA_BUILD', message: 'Only CUDA builds need the CUDA runtime companion.' }
    }
    this._busy = true
    this._busyTask = { id: util.uid('repair'), kind: 'repair', startedAt: util.nowIso() }
    try {
      const rel = await this.deps.github.releaseByTag(entry.releaseTag || entry.version)
      if (!rel.ok) return rel
      const installed = await this._installCudaRuntime(rel.data.assets, entry, entry.cudaVersion, entry.architecture)
      if (!installed.ok) return installed
      const devices = await this.listDevices(entry)
      entry.cudaRuntime = installed.asset
      entry.devices = devices.devices
      entry.gpuRuntimeOk = devices.devices.some((d) => /^CUDA/i.test(d.id))
      await this._writeMeta(meta)
      this.progress('install', { stage: 'done', message: 'CUDA runtime installed for ' + version })
      return { ok: true, version, devices: entry.devices, gpuRuntimeOk: entry.gpuRuntimeOk }
    } finally {
      this._busy = false
      this._busyTask = undefined
    }
  }

  VersionManager.prototype.activate = async function (version) {
    const list = await this.listInstalled()
    if (!list.versions.some((v) => v.version === version)) {
      return { ok: false, code: 'NOT_INSTALLED', message: 'Version ' + version + ' is not installed.' }
    }
    const cfg = this.config.get('llamaCpp')
    cfg.activeVersion = version
    await this.config.save()
    return { ok: true, activeVersion: version }
  }

  VersionManager.prototype.remove = async function (version) {
    const list = await this.listInstalled()
    const entry = list.versions.find((v) => v.version === version)
    if (!entry) return { ok: false, code: 'NOT_INSTALLED', message: 'Version ' + version + ' is not installed.' }
    const active = (this.config.get('llamaCpp') || {}).activeVersion
    if (active === version) {
      const others = list.versions.filter((v) => v.version !== version)
      if (others.length === 0) {
        return {
          ok: false, code: 'ACTIVE_REMOVAL',
          message: 'Version ' + version + ' is the active version. Install or activate another version first.',
          remediation: ['Activate another installed version, then remove this one.'],
        }
      }
    }
    const removed = await this.exec.removeTree(entry.path)
    if (!removed.ok) return { ok: false, code: 'REMOVE_FAILED', message: 'Could not delete ' + entry.path + ': ' + (removed.error || '') }
    const meta = await this._readMeta()
    meta.versions = meta.versions.filter((v) => v.version !== version)
    await this._writeMeta(meta)
    if (active === version) {
      const cfg = this.config.get('llamaCpp')
      cfg.activeVersion = meta.versions[0].version
      await this.config.save()
    }
    return { ok: true, removed: version }
  }

  // Kept under the old name for callers written before the engine and the
  // runtime became separate downloads.
  VersionManager.prototype.repairRuntime = function (version) {
    return this.installRuntime(version)
  }

  VersionManager.prototype.checkForUpdate = async function () {
    return this.latestVersion()
  }

  LLAMA.modules.push('versions')
  LLAMA.versions = { VersionManager, parseHelp }
})(globalThis.LLAMA)
