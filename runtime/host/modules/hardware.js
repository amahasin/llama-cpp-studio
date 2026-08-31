// hardware.js — platform, CPU, RAM, GPU and backend capability detection.
// The heavy lifting happens in the embedded sys-info.ps1 helper (spawned via
// the subprocess service), which has full OS access; this module normalizes
// the result into a stable context object used by asset selection, GPU-layer
// estimation and the diagnostics screen.
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util

  // Minimum NVIDIA driver versions (Windows) for each CUDA minor version of
  // the official llama.cpp release bundles.
  const CUDA_DRIVER_MIN = [
    { cu: '11.7', minDriver: '450.80.02' },
    { cu: '12.0', minDriver: '525.60.13' },
    { cu: '12.1', minDriver: '530.30.02' },
    { cu: '12.2', minDriver: '535.54.03' },
    { cu: '12.3', minDriver: '545.23.08' },
    { cu: '12.4', minDriver: '550.54.14' },
    { cu: '12.5', minDriver: '555.42.02' },
    { cu: '12.6', minDriver: '560.28.03' },
    { cu: '12.8', minDriver: '570.86.10' },
  ]

  // Bytes per KV element for llama.cpp cache types (quantized types carry
  // their block scales, hence the fractional sizes).
  const KV_ELEM_SIZES = {
    f32: 4, f16: 2, bf16: 2,
    q8_0: 1.0625, q5_1: 0.75, q5_0: 0.6875, q4_1: 0.625, q4_0: 0.5625, iq4_nl: 0.5625,
  }
  function KV_ELEM_BYTES(type) {
    const key = String(type === undefined || type === null || type === '' ? 'f16' : type).toLowerCase()
    return KV_ELEM_SIZES[key] !== undefined ? KV_ELEM_SIZES[key] : 2
  }

  function parseDriver(version) {
    const m = String(version || '').match(/(\d+)(?:\.(\d+))?/)
    if (!m) return undefined
    const major = Number(m[1])
    const minor = m[2] === undefined ? 0 : Number(m[2])
    return major * 100 + minor
  }

  function Hardware(deps) {
    this.deps = deps
    this.exec = deps.exec
    this._cache = undefined
    this._cacheAt = 0
  }

  /**
   * Run detection (cached for 30s). Returns the normalized hardware report:
   * {
   *   os, arch,
   *   cpu: { name, vendor, arch, logicalCores, physicalCores, maxClockMhz, features },
   *   ramTotalBytes,
   *   gpus: [{ name, vendor, vramBytes, driverVersion }],
   *   backends: { cpu, cuda, vulkan, hip, sycl },
   *   cuda: { available, driverVersion, toolkitVersions, supportedCu },
   *   recommendedBackend
   * }
   */
  Hardware.prototype.detect = async function (force) {
    const now = Date.now()
    if (!force && this._cache && now - this._cacheAt < 30000) return this._cache
    const r = await this.exec.psJson('sys-info.ps1', [], { timeoutMs: 60000 })
    const raw = r.ok ? r.data : { cimError: r.error }
    this._cache = this._normalize(raw)
    this._cacheAt = now
    return this._cache
  }

  Hardware.prototype._normalize = function (raw) {
    const out = {
      os: 'windows',
      osLabel: 'Windows',
      arch: (raw.cpu && raw.cpu.arch) || 'x64',
      cpu: {
        name: (raw.cpu && raw.cpu.name) || 'Unknown CPU',
        vendor: (raw.cpu && raw.cpu.vendor) || '',
        arch: (raw.cpu && raw.cpu.arch) || 'x64',
        logicalCores: (raw.cpu && raw.cpu.logicalCores) || 0,
        physicalCores: (raw.cpu && raw.cpu.physicalCores) || 0,
        maxClockMhz: (raw.cpu && raw.cpu.maxClockMhz) || 0,
        features: {
          // CPU-variant capability is detected conservatively: AVX2 is
          // assumed present on any modern x64 Windows 11 machine; AVX-512
          // is only enabled when the processor name advertises it.
          avx2: true,
          avx512: /(?:avx512|i[3579]-\d{4,}[A-Z]*[HMN]?)/i.test((raw.cpu && raw.cpu.name) || '') ? true : undefined,
          avx512Vnni: /avx512.*vnni|i[3579]-\d{4,}[A-Z]*H/i.test((raw.cpu && raw.cpu.name) || '') ? true : undefined,
        },
      },
      ramTotalBytes: (raw.system && raw.system.totalPhysicalBytes) || 0,
      osInfo: {
        caption: (raw.os && raw.os.caption) || '',
        version: (raw.os && raw.os.version) || '',
      },
      gpus: [],
      cuda: { available: false, driverVersion: undefined, toolkitVersions: raw.cudaToolkits || [], supportedCu: [] },
      vulkan: { available: raw.dlls ? raw.dlls.vulkan === true : false },
      hip: { available: raw.dlls ? raw.dlls.hip === true : false },
      sycl: { available: raw.dlls ? raw.dlls.sycl === true : false },
      rawErrors: {},
    }

    for (const g of raw.gpus || []) {
      const name = String(g.name || '')
      let vendor = 'unknown'
      if (/nvidia/i.test(name)) vendor = 'nvidia'
      else if (/amd|radeon/i.test(name)) vendor = 'amd'
      else if (/intel|arc/i.test(name)) vendor = 'intel'
      else if (/microsoft basic/i.test(name)) vendor = 'basic'
      out.gpus.push({
        name,
        vendor,
        vramBytes: Number(g.vramBytes) || 0,
        driverVersion: g.driverVersion !== undefined ? String(g.driverVersion) : undefined,
      })
    }

    // NVIDIA: nvidia-smi is the authoritative CUDA-capability check.
    const nv = (raw.nvidia || []).filter((g) => g.name && /nvidia/i.test(g.name))
    if (nv.length > 0) {
      const best = nv[0]
      out.cuda.available = true
      out.cuda.driverVersion = best.driverVersion
      out.cuda.gpuName = best.name
      out.cuda.vramTotalMiB = best.vramTotalMiB
      out.cuda.vramUsedMiB = best.vramUsedMiB
      out.cuda.vramFreeMiB = best.vramFreeMiB
      const driverNum = parseDriver(best.driverVersion)
      if (driverNum !== undefined) {
        for (const row of CUDA_DRIVER_MIN) {
          const minNum = parseDriver(row.minDriver)
          if (minNum !== undefined && driverNum >= minNum) out.cuda.supportedCu.push(row.cu)
        }
      }
    } else if (raw.nvidiaError) {
      out.rawErrors.nvidiaSmi = raw.nvidiaError
    }

    out.recommendedBackend = LLAMA.assetSelector.preferredBackend({
      os: out.os, cuda: out.cuda, vulkan: out.vulkan, hip: out.hip,
    })

    return out
  }

  /**
   * Compact context for asset selection.
   */
  Hardware.prototype.context = async function () {
    const hw = await this.detect()
    return {
      os: hw.os,
      arch: hw.arch,
      cpu: {
        arch: hw.cpu.arch,
        features: hw.cpu.features,
        physicalCores: hw.cpu.physicalCores,
        logicalCores: hw.cpu.logicalCores,
      },
      cuda: hw.cuda,
      vulkan: hw.vulkan,
      hip: hw.hip,
      sycl: hw.sycl,
      gpus: hw.gpus,
      ramTotalBytes: hw.ramTotalBytes,
    }
  }

  /**
   * Live GPU metrics (nvidia-smi) for the monitoring loop.
   */
  Hardware.prototype.gpuMetrics = async function () {
    const r = await this.exec.psJson('gpu.ps1', [], { timeoutMs: 15000 })
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, ...r.data }
  }

  /**
   * Everything the telemetry strip needs — CPU load, physical memory, the
   * server process and the GPU — from a single PowerShell start. Pass pid 0
   * (or omit it) to sample the machine with no server running.
   */
  Hardware.prototype.systemMetrics = async function (pid) {
    const r = await this.exec.psJson('sys-metrics.ps1', [String(Number(pid) || 0)], { timeoutMs: 20000 })
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, ...r.data }
  }

  /**
   * Process + system memory metrics.
   */
  Hardware.prototype.processMetrics = async function (pid) {
    const r = await this.exec.psJson('proc.ps1', [String(pid)], { timeoutMs: 15000 })
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, ...r.data }
  }

  /**
   * Estimate per-layer VRAM for a GGUF file so "Auto GPU layers" can pick a
   * sane starting point before any launch attempt.
   */
  Hardware.prototype.estimateLayerBytes = function (fileSize, layerCount) {
    const size = Number(fileSize) || 0
    const layers = Number(layerCount) || 0
    if (size <= 0 || layers <= 0) return undefined
    // Weights dominate the file; ~92% of the bytes live in layer tensors for
    // transformer models. Pad by 1.1x for activations/compute buffers — the
    // KV cache is accounted for separately (see estimateKvCacheBytes).
    return ((size * 0.92) / layers) * 1.1
  }

  /**
   * Bytes an offloaded layer's KV cache occupies at a given context size.
   * kvDim = kv_heads * head_dim, times K and V, times the element size of the
   * chosen cache type. Returns undefined when the GGUF did not expose the
   * attention shape.
   */
  Hardware.prototype.estimateKvBytesPerLayer = function (metadata, contextSize, cacheTypeK, cacheTypeV) {
    const meta = metadata || {}
    const ctx = Number(contextSize) || 0
    if (ctx <= 0) return undefined
    const embd = Number(meta.embeddingLength) || 0
    const heads = Number(meta.headCount) || 0
    const kvHeads = Number(meta.headCountKv) || heads
    let headDim = Number(meta.keyLength) || 0
    if (headDim <= 0 && heads > 0 && embd > 0) headDim = embd / heads
    if (headDim <= 0 || kvHeads <= 0) return undefined
    const kvDim = kvHeads * headDim
    return ctx * kvDim * (KV_ELEM_BYTES(cacheTypeK) + KV_ELEM_BYTES(cacheTypeV))
  }

  /**
   * Total KV cache for a model at a context size (all layers).
   */
  Hardware.prototype.estimateKvCacheBytes = function (metadata, contextSize, cacheTypeK, cacheTypeV) {
    const perLayer = this.estimateKvBytesPerLayer(metadata, contextSize, cacheTypeK, cacheTypeV)
    const layers = Number((metadata || {}).blockCount) || Number((metadata || {}).layerCount) || 0
    if (perLayer === undefined || layers <= 0) return undefined
    return perLayer * layers
  }

  /**
   * How many layers fit in VRAM. Each offloaded layer costs its weights *plus*
   * its KV cache at the configured context, which is what makes a large
   * context quietly push a model back into system RAM.
   */
  Hardware.prototype.estimateAutoGpuLayers = function (fileSize, layerCount, vramFreeBytes, kvBytesPerLayer) {
    const perLayerWeights = this.estimateLayerBytes(fileSize, layerCount)
    if (perLayerWeights === undefined || !vramFreeBytes || vramFreeBytes <= 0) return undefined
    const perLayer = perLayerWeights + (Number(kvBytesPerLayer) || 0)
    if (perLayer <= 0) return undefined
    // Leave 10% headroom for the compute buffer and fragmentation.
    const budget = vramFreeBytes * 0.9
    const layers = Math.max(0, Math.floor(budget / perLayer))
    return Math.min(layers, layerCount)
  }

  LLAMA.modules.push('hardware')
  LLAMA.hardware = { Hardware, CUDA_DRIVER_MIN, KV_ELEM_SIZES, kvElemBytes: KV_ELEM_BYTES }
})(globalThis.LLAMA)
