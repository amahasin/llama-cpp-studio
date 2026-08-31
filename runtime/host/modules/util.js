// util.js — dependency-free helpers shared by every plugin module.
// Pure module: no harness services, fully unit-testable.
'use strict'
;(function (LLAMA) {
  'use strict'

  function pad2(n) {
    return String(n).padStart(2, '0')
  }

  function nowIso() {
    const d = new Date()
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
  }

  let uidCounter = 0
  function uid(prefix) {
    uidCounter += 1
    const rand = Math.random().toString(36).slice(2, 8)
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + uidCounter.toString(36) + '-' + rand
  }

  function bytesHuman(bytes) {
    if (bytes === undefined || bytes === null || Number.isNaN(Number(bytes))) return '—'
    let b = Number(bytes)
    if (b < 0) return '—'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let i = 0
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i += 1 }
    const digits = i === 0 ? 0 : b >= 100 ? 0 : 1
    return b.toFixed(digits) + ' ' + units[i]
  }

  function msHuman(ms) {
    if (ms === undefined || ms === null || Number.isNaN(Number(ms))) return '—'
    const s = Math.floor(Number(ms) / 1000)
    const m = Math.floor(s / 60)
    const h = Math.floor(m / 60)
    if (h > 0) return h + 'h ' + (m % 60) + 'm'
    if (m > 0) return m + 'm ' + (s % 60) + 's'
    return s + 's'
  }

  function clamp(v, lo, hi) {
    const n = Number(v)
    if (Number.isNaN(n)) return lo
    return Math.min(hi, Math.max(lo, n))
  }

  function toInt(v, dflt) {
    const n = parseInt(v, 10)
    return Number.isNaN(n) ? dflt : n
  }

  function toFloat(v, dflt) {
    const n = parseFloat(v)
    return Number.isNaN(n) ? dflt : n
  }

  function toBool(v, dflt) {
    if (typeof v === 'boolean') return v
    if (v === 'true' || v === '1' || v === 1) return true
    if (v === 'false' || v === '0' || v === 0) return false
    return dflt
  }

  // djb2 hash — hex string. Used to fingerprint embedded helper-script content.
  function hashStr(s) {
    let h = 5381
    for (let i = 0; i < s.length; i += 1) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0
    }
    return (h >>> 0).toString(16)
  }

  function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  }

  // Deep merge `src` onto `dst` (plain objects/arrays only). Returns a NEW object.
  function deepMerge(dst, src) {
    const out = isPlainObject(dst) ? deepClone(dst) : {}
    if (!isPlainObject(src)) return out
    for (const key of Object.keys(src)) {
      const sv = src[key]
      if (isPlainObject(sv)) {
        out[key] = deepMerge(isPlainObject(out[key]) ? out[key] : {}, sv)
      } else if (Array.isArray(sv)) {
        out[key] = sv.slice()
      } else {
        out[key] = sv
      }
    }
    return out
  }

  function deepClone(v) {
    if (isPlainObject(v)) {
      const out = {}
      for (const k of Object.keys(v)) out[k] = deepClone(v[k])
      return out
    }
    if (Array.isArray(v)) return v.map(deepClone)
    return v
  }

  function truncate(s, n) {
    if (typeof s !== 'string') return s
    return s.length <= n ? s : s.slice(0, n - 3) + '...'
  }

  function splitLines(s) {
    return String(s === undefined || s === null ? '' : s).split(/\r?\n/)
  }

  // Find the first complete JSON object inside possibly-noisy output.
  function extractJson(text, probeKey) {
    const s = String(text === undefined || text === null ? '' : text)
    const start = s.indexOf('{')
    if (start === -1) return undefined
    const probe = probeKey === undefined ? -1 : s.indexOf(probeKey, start)
    if (probe !== -1) {
      // Find the LAST closing brace after the probe; JSON has no nested
      // strings beyond escaped quotes, so scanning brace depth works.
      let depth = 0
      let inStr = false
      let esc = false
      for (let i = start; i < s.length; i += 1) {
        const c = s[i]
        if (inStr) {
          if (esc) { esc = false } else if (c === '\\') { esc = true } else if (c === '"') { inStr = false }
        } else if (c === '"') { inStr = true }
        else if (c === '{') { depth += 1 }
        else if (c === '}') {
          depth -= 1
          if (depth === 0) return s.slice(start, i + 1)
        }
      }
    }
    const candidate = s.slice(start, s.lastIndexOf('}') + 1)
    if (candidate.length === 0) return undefined
    return candidate
  }

  function tryParseJson(text) {
    try {
      return JSON.parse(text)
    } catch (_e) {
      return undefined
    }
  }

  // Strip a value down to lossless JSON data for the tool/RPC boundary: the
  // harness rejects undefined and class instances in dynamic-tool results, and
  // fresh configs legitimately hold undefined leaves (activeVersion, driver
  // versions). Undefined becomes null (matching a JSON round-trip); plain
  // objects and arrays are rebuilt recursively.
  function jsonSafe(value) {
    if (value === undefined) return null
    if (Array.isArray(value)) return value.map(jsonSafe)
    if (isPlainObject(value)) {
      const out = {}
      for (const key of Object.keys(value)) out[key] = jsonSafe(value[key])
      return out
    }
    return value
  }

  // ---------- JSON file helpers (harness fs service passed in) ----------

  // Read and parse a JSON file. Returns undefined when it is missing,
  // unreadable or not valid JSON — callers treat that as "first run".
  async function readJsonFile(fs, path) {
    try {
      const target = await fs.resolve(path)
      const text = await fs.readText(target)
      return tryParseJson(text)
    } catch (_e) {
      return undefined
    }
  }

  // Write a pretty-printed JSON file. Returns true on success. The caller is
  // responsible for creating the directory (exec.ensureDir).
  async function writeJsonFile(fs, path, data) {
    try {
      const target = await fs.resolve(path)
      await fs.writeText(target, JSON.stringify(data, null, 2) + '\n')
      return true
    } catch (_e) {
      return false
    }
  }

  // ---------- binary helpers ----------

  // base64 (from a powershell/process payload) to Uint8Array.
  function b64ToBytes(b64) {
    const clean = String(b64).replace(/\s+/g, '')
    if (clean.length === 0) return new Uint8Array(0)
    const bin = atob(clean)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
    return out
  }

  // Proper UTF-8 decode (GGUF string fields are UTF-8; TextDecoder is a
  // provided Builtin in the dynamic host realm and exists in Node).
  function bytesToStr(bytes) {
    return new TextDecoder('utf-8').decode(bytes)
  }

  function strToBytes(s) {
    return new TextEncoder().encode(s)
  }

  // Little-endian readers over a Uint8Array with offset.
  function leU16(b, o) { return b[o] | (b[o + 1] << 8) }
  function leU32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 }
  function leI32(b, o) { return leU32(b, o) | 0 }
  function leU64(b, o) {
    // Number-safe up to 2^53; GGUF sizes never approach that.
    let lo = 0
    let hi = 0
    for (let i = 0; i < 4; i += 1) { lo += b[o + i] * Math.pow(2, 8 * i) }
    for (let i = 4; i < 8; i += 1) { hi += b[o + i] * Math.pow(2, 8 * (i - 4)) }
    return lo + hi * 4294967296
  }
  function leF32(b, o) {
    const view = new DataView(b.buffer, b.byteOffset + o, 4)
    return view.getFloat32(0, true)
  }
  function leF64(b, o) {
    const view = new DataView(b.buffer, b.byteOffset + o, 8)
    return view.getFloat64(0, true)
  }

  // ---------- path helpers (no Node `path`; Windows-first with POSIX support) ----------

  function norm(p) {
    return String(p === undefined || p === null ? '' : p).replace(/\\/g, '/')
  }

  function isAbsolute(p) {
    const raw = String(p === undefined || p === null ? '' : p)
    // Windows drive letter or UNC on the RAW string; POSIX absolute only for
    // forward-slash paths (a single backslash root is drive-relative).
    if (/^[A-Za-z]:[\\/]/.test(raw)) return true
    if (raw.startsWith('\\\\')) return true
    return raw.startsWith('/') && raw.indexOf('\\') === -1
  }

  function joinPath() {
    const parts = []
    for (let i = 0; i < arguments.length; i += 1) {
      const p = norm(arguments[i])
      if (p === '' || p === '.') continue
      parts.push(p)
    }
    let out = parts.join('/')
    // Collapse duplicate separators (but keep UNC `//` and drive roots).
    out = out.replace(/([^:])\/+/g, '$1/')
    if (/^[A-Za-z]:\//.test(out) === false && out.startsWith('//')) out = '//' + out.replace(/^\/+/, '')
    return out
  }

  function basename(p) {
    const s = norm(p).replace(/\/+$/, '')
    const i = s.lastIndexOf('/')
    return i === -1 ? s : s.slice(i + 1)
  }

  function dirname(p) {
    const s = norm(p).replace(/\/+$/, '')
    const i = s.lastIndexOf('/')
    if (i === -1) return '.'
    const out = s.slice(0, i)
    return out === '' ? '/' : out
  }

  function extname(p) {
    const b = basename(p)
    const i = b.lastIndexOf('.')
    if (i <= 0) return ''
    return b.slice(i).toLowerCase()
  }

  function stripExt(p) {
    const b = basename(p)
    const i = b.lastIndexOf('.')
    return i <= 0 ? b : b.slice(0, i)
  }

  // Make an absolute path relative to a parent when it lies inside it.
  function relativeTo(parent, child) {
    const p = norm(parent).replace(/\/+$/, '')
    const c = norm(child)
    if (c === p) return ''
    if (c.startsWith(p + '/')) return c.slice(p.length + 1)
    return c
  }

  // Compare two paths for identity. Windows is case-insensitive and mixes
  // separators, so a path recorded on one machine rarely matches character for
  // character the one derived on another; normalize and case-fold before
  // deciding that two locations are the same.
  function samePath(a, b) {
    const x = norm(a).replace(/\/+$/, '')
    const y = norm(b).replace(/\/+$/, '')
    if (x === y) return true
    if (!isWindowsPath(x) || !isWindowsPath(y)) return false
    return x.toLowerCase() === y.toLowerCase()
  }

  function isWindowsPath(p) {
    const s = norm(p)
    return /^[A-Za-z]:\//.test(s) || s.startsWith('\\\\')
  }

  /**
   * Transfer rate and ETA from two samples of a growing file. Returns undefined
   * until there is a window long enough to divide by — a rate computed over a
   * few milliseconds is noise, not information.
   */
  function transferRate(prevBytes, prevAt, bytes, at, totalBytes) {
    if (prevAt === undefined || prevBytes === undefined) return undefined
    const seconds = (at - prevAt) / 1000
    const delta = bytes - prevBytes
    if (seconds < 0.5 || delta < 0) return undefined
    const bytesPerSecond = delta / seconds
    const out = { bytesPerSecond }
    if (totalBytes > 0 && bytesPerSecond > 0) {
      out.etaSeconds = Math.max(0, Math.round((totalBytes - bytes) / bytesPerSecond))
    }
    return out
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  LLAMA.modules.push('util')
  LLAMA.util = {
    pad2, nowIso, uid, bytesHuman, msHuman, clamp, toInt, toFloat, toBool,
    hashStr, isPlainObject, deepMerge, deepClone, truncate, splitLines,
    extractJson, tryParseJson, jsonSafe, readJsonFile, writeJsonFile,
    b64ToBytes, bytesToStr, strToBytes, leU16, leU32, leI32, leU64, leF32, leF64,
    norm, isAbsolute, joinPath, basename, dirname, extname, stripExt, relativeTo,
    isWindowsPath, samePath, transferRate, escapeRegExp,
  }
})(globalThis.LLAMA)
