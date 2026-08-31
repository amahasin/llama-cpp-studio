// assetSelector.js — discovers and scores llama.cpp release assets against the
// detected platform, architecture, GPU backend and requested backend.
//
// llama.cpp asset naming changes over time (e.g. "win-avx2-x64" became
// "win-cpu-x64" in newer builds), so this module parses each asset name into
// structured fields and scores candidates instead of hard-coding one name.
// Pure module.
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util

  const BACKENDS = ['cpu', 'cuda', 'vulkan', 'hip', 'sycl', 'metal']

  // Backend detection tokens, in priority order. "rocm"/"hip" both mean HIP.
  const BACKEND_PATTERNS = [
    { backend: 'cuda', re: /cuda(?:\D|$)/i },
    { backend: 'hip', re: /(?:rocm|hip)(?:\D|$)/i },
    { backend: 'vulkan', re: /vulkan(?:\D|$)/i },
    { backend: 'sycl', re: /sycl(?:\D|$)/i },
    { backend: 'metal', re: /metal(?:\D|$)/i },
  ]

  const OS_PATTERNS = [
    { os: 'windows', re: /-win(?:dows)?-/i },
    { os: 'linux', re: /-linux-|-ubuntu-|-debian-/i },
    { os: 'macos', re: /-macos-/i },
  ]

  const ARCH_PATTERNS = [
    { arch: 'arm64', re: /-arm64|-aarch64/i },
    { arch: 'x64', re: /-x64|-amd64/i },
  ]

  const CPU_VARIANTS = ['amx-int8', 'avx512-vnni', 'avx512', 'avx2', 'avx', 'noavx', 'cpu']

  const CUDA_RE = /(?:cu|cuda-)(\d+)\.(\d+)/i

  /**
   * Parse one asset file name into structured fields.
   * Returns null when the name does not look like a llama.cpp binary bundle.
   */
  function parseAssetName(name) {
    const base = util.basename(name)
    if (!/^llama-/i.test(base) || !/-bin-/i.test(base)) return null
    if (!/\.(zip|tar\.gz|tgz|7z)$/i.test(base)) return null
    let os
    for (const p of OS_PATTERNS) {
      if (p.re.test(base)) { os = p.os; break }
    }
    if (!os) return null
    let arch
    for (const p of ARCH_PATTERNS) {
      if (p.re.test(base)) { arch = p.arch; break }
    }
    let backend = 'cpu'
    for (const p of BACKEND_PATTERNS) {
      if (p.re.test(base)) { backend = p.backend; break }
    }
    const cuda = base.match(CUDA_RE)
    let cpuVariant
    if (backend === 'cpu') {
      for (const v of CPU_VARIANTS) {
        if (new RegExp('-' + v + '-', 'i').test(base)) { cpuVariant = v; break }
      }
    }
    const version = base.match(/(?:^|-)b(\d{2,})(?:-|\.)/i)
    return {
      name: base,
      os, arch,
      backend,
      cudaVersion: cuda ? Number(cuda[1]) + '.' + Number(cuda[2]) : undefined,
      cpuVariant,
      build: version ? Number(version[1]) : undefined,
    }
  }

  /**
   * Score a parsed asset against the platform context.
   * context = {
   *   os: 'windows'|'linux'|'macos',
   *   arch: 'x64'|'arm64',
   *   backend: 'auto'|'cpu'|'cuda'|'vulkan'|'hip'|'sycl'|'metal',
   *   cuda: { available, toolkitVersion?, driverVersion?, supportedCu: ['12.4', ...] },
   *   cpu: { avx2?, avx512?, avx512Vnni?, amx? },
   * }
   * Returns { score, reasons[] } — score 0 = unusable.
   */
  function scoreAsset(parsed, context) {
    if (!parsed) return { score: 0, reasons: ['not a llama.cpp binary bundle'] }
    const reasons = []
    let score = 0
    if (parsed.os !== context.os) return { score: 0, reasons: ['built for ' + parsed.os + ', not ' + context.os] }
    if (parsed.arch !== context.arch) return { score: 0, reasons: ['built for ' + parsed.arch + ', not ' + context.arch] }
    score += 100
    reasons.push('matches ' + context.os + '/' + context.arch)

    const want = context.backend === 'auto' ? preferredBackend(context) : context.backend
    if (want !== parsed.backend) {
      return { score: 0, reasons: ['backend is ' + parsed.backend + ', wanted ' + want] }
    }

    if (parsed.backend === 'cuda') {
      score += 500
      if (parsed.cudaVersion && context.cuda) {
        if (Array.isArray(context.cuda.supportedCu) && context.cuda.supportedCu.includes(parsed.cudaVersion)) {
          score += 300
          reasons.push('CUDA ' + parsed.cudaVersion + ' matches this driver')
        } else {
          score -= 400
          reasons.push('CUDA ' + parsed.cudaVersion + ' may be too new for driver ' + (context.cuda.driverVersion || 'unknown'))
        }
      }
      if (context.cuda && context.cuda.available === true) {
        score += 100
        reasons.push('NVIDIA GPU + driver detected')
      } else {
        score -= 600
        reasons.push('no CUDA-capable setup detected')
      }
    } else if (parsed.backend === 'vulkan') {
      score += 400
      if (context.vulkan && context.vulkan.available === true) {
        score += 100
        reasons.push('Vulkan loader detected')
      } else {
        score -= 200
        reasons.push('Vulkan loader not detected')
      }
    } else if (parsed.backend === 'cpu') {
      score += 300
      if (parsed.cpuVariant && context.cpu) {
        const ok = cpuVariantSupported(parsed.cpuVariant, context.cpu)
        if (ok) {
          score += 60
          reasons.push('CPU variant ' + parsed.cpuVariant + ' supported')
        } else {
          score -= 300
          reasons.push('CPU variant ' + parsed.cpuVariant + ' not supported by this CPU')
        }
      } else {
        score += 40
        reasons.push('generic CPU build')
      }
    } else if (parsed.backend === 'hip') {
      score += 450
      reasons.push(context.hip && context.hip.available ? 'ROCm/HIP detected' : 'ROCm/HIP not detected')
    } else if (parsed.backend === 'sycl') {
      score += 400
      reasons.push(context.sycl && context.sycl.available ? 'oneAPI detected' : 'oneAPI not detected')
    } else if (parsed.backend === 'metal') {
      score += 400
    }

    if (parsed.build) score += Math.min(parsed.build, 999999) / 1000000 // tie-break: prefer newer
    return { score, reasons }
  }

  function preferredBackend(context) {
    // Default ranking per OS; the context may pin a backend explicitly.
    if (context.os === 'windows') {
      if (context.cuda && context.cuda.available) return 'cuda'
      if (context.vulkan && context.vulkan.available) return 'vulkan'
      return 'cpu'
    }
    if (context.os === 'linux') {
      if (context.cuda && context.cuda.available) return 'cuda'
      if (context.hip && context.hip.available) return 'hip'
      if (context.vulkan && context.vulkan.available) return 'vulkan'
      return 'cpu'
    }
    return 'metal'
  }

  function cpuVariantSupported(variant, cpu) {
    if (variant === 'cpu' || variant === 'avx') return true
    if (variant === 'noavx') return true
    if (variant === 'avx2') return cpu.avx2 !== false
    if (variant === 'avx512') return cpu.avx512 === true
    if (variant === 'avx512-vnni') return cpu.avx512Vnni === true
    if (variant === 'amx-int8') return cpu.amx === true
    return true
  }

  /**
   * Select the best asset from a release's asset list.
   * Returns { ok, asset?, parsed?, score?, reasons[], candidates[] }.
   */
  function selectBestAsset(assets, context) {
    const parsedList = []
    for (const a of assets || []) {
      const parsed = parseAssetName(a.name)
      const scored = scoreAsset(parsed, context)
      parsedList.push({ asset: a, parsed, score: scored.score, reasons: scored.reasons })
    }
    const usable = parsedList.filter((c) => c.score > 0).sort((x, y) => y.score - x.score)
    if (usable.length === 0) {
      return {
        ok: false,
        reasons: ['no release asset matches ' + context.os + '/' + context.arch + ' with backend '
          + (context.backend === 'auto' ? preferredBackend(context) + ' (auto)' : context.backend)],
        candidates: parsedList.map((c) => ({ name: c.asset.name, score: c.score, reasons: c.reasons })),
      }
    }
    const best = usable[0]
    return {
      ok: true,
      asset: best.asset,
      parsed: best.parsed,
      score: best.score,
      reasons: best.reasons,
      alternatives: usable.slice(1, 4).map((c) => ({ name: c.asset.name, score: c.score })),
    }
  }

  /**
   * Compare two llama.cpp version tags like "b8000" / "b7999-rc1".
   * Returns -1 | 0 | 1.
   */
  function compareVersions(a, b) {
    const na = String(a === undefined || a === null ? '' : a).match(/(\d+)/g)
    const nb = String(b === undefined || b === null ? '' : b).match(/(\d+)/g)
    const numsA = (na || []).map(Number)
    const numsB = (nb || []).map(Number)
    const len = Math.max(numsA.length, numsB.length)
    for (let i = 0; i < len; i += 1) {
      const va = numsA[i] === undefined ? 0 : numsA[i]
      const vb = numsB[i] === undefined ? 0 : numsB[i]
      if (va < vb) return -1
      if (va > vb) return 1
    }
    return 0
  }

  function parseBuildNumber(tag) {
    const m = String(tag === undefined ? '' : tag).match(/[bB](\d+)/)
    return m ? Number(m[1]) : undefined
  }

  LLAMA.modules.push('assetSelector')
  LLAMA.assetSelector = {
    BACKENDS, parseAssetName, scoreAsset, selectBestAsset, preferredBackend,
    compareVersions, parseBuildNumber,
  }
})(globalThis.LLAMA)
