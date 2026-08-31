// gguf.js — pure GGUF metadata parsing (header KV pairs + tensor info scan) and
// filename heuristics. Reference: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
//
// The harness `fs` service cannot read a prefix of a multi-GB file, so at runtime
// the plugin extracts the first ~1MB of a model with a small PowerShell reader
// (exec.js -> file-head.ps1) and feeds those bytes here. Tests feed generated
// fixtures.
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util

  const MAGIC = 0x46554747 // 'GGUF' little-endian

  const VALUE_TYPES = {
    0: 'uint8', 1: 'int8', 2: 'uint16', 3: 'int16', 4: 'uint32', 5: 'int32',
    6: 'float32', 7: 'bool', 8: 'string', 9: 'array', 10: 'uint64', 11: 'int64', 12: 'float64',
  }

  const FILETYPES = {
    0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1',
    10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M',
    16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S',
    22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M',
    28: 'IQ2_S', 29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ8_0', 32: 'IQ1_M', 33: 'BF16',
    34: 'Q4_0_4_4', 35: 'Q4_0_4_8', 36: 'Q4_0_8_8', 37: 'TQ1_0', 38: 'TQ2_0',
  }

  function fileTypeName(ft) {
    const n = Number(ft)
    if (ft === undefined || ft === null || Number.isNaN(n)) return undefined
    return FILETYPES[n] !== undefined ? FILETYPES[n] : String(ft)
  }

  // Quantization tokens in llama.cpp naming always join variants with
  // underscores (Q4_K_M, IQ4_XS, Q4_0_4_4); a dot almost always starts a file
  // extension, so continuations are underscore-only.
  const QUANT_RE = /(?:^|[^A-Za-z0-9])((?:IQ\d|Q\d|TQ\d)(?:_[A-Z0-9]{1,4})*|F16|BF16|F32)(?![A-Za-z0-9_])/i
  const SIZE_RE = /(?:^|[^A-Za-z0-9])(\d+(?:\.\d+)?)\s*([BM])(?:[^A-Za-z0-9]|$)/i

  /**
   * Guess metadata pieces from a GGUF file name. Never authoritative — the
   * GGUF header always wins when readable.
   */
  function filenameHints(name) {
    const base = util.basename(name)
    const hints = {}
    const q = base.match(QUANT_RE)
    if (q) hints.quantization = q[1].toUpperCase().replace(/_/g, '_')
    const s = base.match(SIZE_RE)
    if (s) {
      const n = parseFloat(s[1])
      const rounded = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10
      hints.sizeLabel = s[2].toUpperCase() === 'B' ? String(rounded) + 'B' : rounded + s[2].toUpperCase()
    }
    if (/instruct/i.test(base)) hints.kind = 'instruct'
    else if (/chat/i.test(base)) hints.kind = 'chat'
    else hints.kind = 'base'
    return hints
  }

  // Minimal sequential reader over a Uint8Array window.
  function Reader(bytes, start) {
    this.bytes = bytes
    this.pos = start || 0
  }
  Reader.prototype.remaining = function () { return this.bytes.length - this.pos }
  Reader.prototype.need = function (n) {
    if (this.remaining() < n) throw new Error('truncated')
    return n
  }
  Reader.prototype.u8 = function () { this.need(1); const v = this.bytes[this.pos]; this.pos += 1; return v }
  Reader.prototype.u16 = function () { this.need(2); const v = util.leU16(this.bytes, this.pos); this.pos += 2; return v }
  Reader.prototype.u32 = function () { this.need(4); const v = util.leU32(this.bytes, this.pos); this.pos += 4; return v }
  Reader.prototype.i32 = function () { this.need(4); const v = util.leI32(this.bytes, this.pos); this.pos += 4; return v }
  Reader.prototype.u64 = function () { this.need(8); const v = util.leU64(this.bytes, this.pos); this.pos += 8; return v }
  Reader.prototype.i64 = function () {
    this.need(8)
    const v = util.leU64(this.bytes, this.pos)
    this.pos += 8
    return v > 9007199254740991 ? v - 18446744073709551616 : v
  }
  Reader.prototype.f32 = function () { this.need(4); const v = util.leF32(this.bytes, this.pos); this.pos += 4; return v }
  Reader.prototype.f64 = function () { this.need(8); const v = util.leF64(this.bytes, this.pos); this.pos += 8; return v }
  Reader.prototype.str = function () {
    const len = this.u64()
    this.need(len)
    const out = util.bytesToStr(this.bytes.subarray(this.pos, this.pos + len))
    this.pos += len
    return out
  }

  // Scalar/array value reader; for arrays we only need the LENGTH for big
  // vocab lists, so `captureStrings` controls whether contents are retained.
  function readValue(r, type, captureStrings, maxStrings) {
    switch (type) {
      case 'uint8': case 'bool': case 'int8': return { v: r.u8() }
      case 'uint16': case 'int16': return { v: r.u16() }
      case 'uint32': case 'int32': return { v: r.u32() }
      case 'float32': return { v: r.f32() }
      case 'uint64': case 'int64': return { v: r.u64() }
      case 'float64': return { v: r.f64() }
      case 'string': return { v: r.str() }
      case 'array': {
        const itemType = VALUE_TYPES[r.u32()]
        const len = r.u64()
        const arr = { len, type: itemType, items: [] }
        if (captureStrings && itemType === 'string') {
          const n = Math.min(len, maxStrings || 0)
          for (let i = 0; i < n; i += 1) arr.items.push(r.str())
          for (let i = n; i < len; i += 1) r.str() // skip the rest
        } else {
          const size = valueSize(itemType)
          if (size > 0) {
            // Fixed-size items: skip in bulk.
            const total = len * size
            if (total > r.remaining()) throw new Error('truncated')
            r.pos += total
          } else {
            for (let i = 0; i < len; i += 1) readValue(r, itemType, false, 0)
          }
        }
        return { v: arr }
      }
      default: throw new Error('unknown value type ' + type)
    }
  }

  function valueSize(type) {
    switch (type) {
      case 'uint8': case 'int8': case 'bool': return 1
      case 'uint16': case 'int16': return 2
      case 'uint32': case 'int32': case 'float32': return 4
      case 'uint64': case 'int64': case 'float64': return 8
      default: return 0 // string/array — variable size
    }
  }

  const KEY_INTEREST = new Set([
    'general.architecture', 'general.name', 'general.basename', 'general.quantization_version',
    'general.file_type', 'general.parameters', 'general.alignment', 'general.type',
    'tokenizer.ggml.model', 'tokenizer.ggml.tokens', 'tokenizer.ggml.bos_token_id',
    'tokenizer.ggml.eos_token_id', 'tokenizer.chat_template', 'tokenizer.ggml.padding_token_id',
    'general.base_model.count', 'general.base_model.0.name', 'general.base_model.0.organization',
    'general.base_model.0.repo_url',
  ])

  const SUFFIX_INTEREST = [
    '.context_length', '.embedding_length', '.block_count', '.rope.dimension_count',
    // Attention shape drives the KV-cache size estimate (GQA aware).
    '.attention.head_count', '.attention.head_count_kv',
    '.attention.key_length', '.attention.value_length',
  ]

  function isInterestingKey(key) {
    if (KEY_INTEREST.has(key)) return true
    for (const s of SUFFIX_INTEREST) if (key.endsWith(s)) return true
    return false
  }

  /**
   * Parse a GGUF header window (first bytes of the file).
   * Returns { ok, magic, version, tensorCount, kvCount, kv: {key: {type, value}}, truncated, bytesRead }.
   * Truncated windows return ok:false with a reason — callers read more bytes.
   */
  function parseHeader(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    if (b.length < 24) return { ok: false, reason: 'too-short', bytesRead: b.length }
    const r = new Reader(b, 0)
    const magic = r.u32()
    if (magic !== MAGIC) return { ok: false, reason: 'bad-magic', bytesRead: r.pos }
    const version = r.u32()
    const tensorCount = r.u64()
    const kvCount = r.u64()
    const kv = {}
    try {
      for (let i = 0; i < kvCount; i += 1) {
        const key = r.str()
        const typeId = r.u32()
        const type = VALUE_TYPES[typeId]
        if (type === undefined) return { ok: false, reason: 'bad-type', bytesRead: r.pos }
        if (isInterestingKey(key)) {
          const capture = key === 'tokenizer.ggml.tokens' || key === 'tokenizer.chat_template'
          const read = readValue(r, type, capture, key === 'tokenizer.ggml.tokens' ? 0 : 1)
          const v = read.v
          if (key === 'tokenizer.ggml.tokens' && v && v.len !== undefined) {
            kv[key] = { type, value: { arrayLength: v.len, items: v.items || [] } }
          } else if (key === 'tokenizer.chat_template') {
            const tpl = v && v.items && v.items.length ? v.items[0] : v
            kv[key] = { type, value: { present: tpl !== undefined && tpl !== '', length: tpl ? tpl.length : 0 } }
          } else {
            kv[key] = { type, value: v }
          }
        } else {
          // Skip without retaining.
          readValue(r, type, false, 0)
        }
      }
      // Tensor-info scan: count transformer-block weight tensors to estimate
      // layer count and catch the architecture prefix from the first tensor.
      let blkWeights = 0
      let weightTensors = 0
      let firstTensor = ''
      let tensorsScanned = 0
      try {
        for (let i = 0; i < tensorCount; i += 1) {
          const name = r.str()
          if (i === 0) firstTensor = name
          if (/\.weight$/.test(name)) weightTensors += 1
          if (/^blk\.\d+\..*\.weight$/.test(name)) blkWeights += 1
          const nDims = r.u32()
          const dimBytes = nDims * 8
          r.need(dimBytes)
          r.pos += dimBytes
          r.u32() // tensor type
          r.u64() // offset
          tensorsScanned += 1
        }
      } catch (_e) {
        // Tensor table can exceed the header window for huge vocab embeddings;
        // we keep what we scanned.
      }
      return {
        ok: true, magic: 'GGUF', version, tensorCount, kvCount, kv,
        layerCount: blkWeights > 0 ? blkWeights : (weightTensors > 0 ? weightTensors : undefined),
        firstTensor, tensorsScanned, truncated: false, bytesRead: r.pos,
      }
    } catch (err) {
      if (err && err.message === 'truncated') {
        return { ok: false, reason: 'truncated', bytesRead: r.pos }
      }
      return { ok: false, reason: 'parse-error', error: String(err && err.message), bytesRead: r.pos }
    }
  }

  /**
   * Turn parsed GGUF KV data into a friendly, UI/JSON-ready metadata summary.
   */
  function summarize(parsed, fallback) {
    const fb = fallback || {}
    const kv = parsed && parsed.kv ? parsed.kv : {}
    const pick = (key) => (kv[key] !== undefined ? kv[key].value : undefined)
    const pickArrayLen = (key) => {
      const v = pick(key)
      return v && v.arrayLength !== undefined ? v.arrayLength : undefined
    }
    const sum = {
      architecture: pick('general.architecture'),
      name: pick('general.name') || pick('general.basename') || fb.name,
      fileType: pick('general.file_type'),
      quantization: fileTypeName(pick('general.file_type') === undefined ? null : pick('general.file_type'))
        || (pick('general.quantization_version') !== undefined ? 'v' + pick('general.quantization_version') : undefined)
        || fb.quantization,
      parameters: pick('general.parameters') !== undefined ? Number(pick('general.parameters')) / 1e6 : undefined,
      contextLength: firstDefined(pickEnding(kv, '.context_length'), fb.contextLength),
      embeddingLength: firstDefined(pickEnding(kv, '.embedding_length'), fb.embeddingLength),
      blockCount: firstDefined(pickEnding(kv, '.block_count'), undefined),
      headCount: firstDefined(pickEnding(kv, '.attention.head_count'), undefined),
      headCountKv: firstDefined(pickEnding(kv, '.attention.head_count_kv'), undefined),
      keyLength: firstDefined(pickEnding(kv, '.attention.key_length'), undefined),
      valueLength: firstDefined(pickEnding(kv, '.attention.value_length'), undefined),
      tokenizerModel: pick('tokenizer.ggml.model'),
      vocabSize: firstDefined(pickArrayLen('tokenizer.ggml.tokens'), undefined),
      bosToken: pick('tokenizer.ggml.bos_token_id'),
      eosToken: pick('tokenizer.ggml.eos_token_id'),
      hasChatTemplate: (pick('tokenizer.chat_template') || {}).present === true,
      chatTemplateLength: (pick('tokenizer.chat_template') || {}).length,
      tensorCount: parsed ? parsed.tensorCount : undefined,
      // layerCount means transformer layers (what --n-gpu-layers counts).
      // The tensor tally is a fallback only: a 40-layer MoE has hundreds of
      // blk.*.weight tensors, and using that number made the auto GPU-layer
      // estimate meaningless.
      layerCount: firstDefined(pickEnding(kv, '.block_count'), parsed ? parsed.layerCount : undefined),
      blockWeightTensors: parsed ? parsed.layerCount : undefined,
      kind: fb.kind,
      sizeLabel: fb.sizeLabel,
    }
    return sum
  }

  function pickEnding(kv, suffix) {
    for (const key of Object.keys(kv)) {
      if (key.endsWith(suffix)) return kv[key].value
    }
    return undefined
  }

  /**
   * Turn the streaming PowerShell scanner's output into the same metadata
   * summary parseHeader produces, for headers whose KV region exceeds every
   * head window. Scan kv entries are `{ value }` for scalars,
   * `{ arrayLength }` for arrays, and `{ chatTemplateLength }` for the chat
   * template.
   */
  function summarizeScan(scan, fallback) {
    const fb = fallback || {}
    const kv = scan && scan.kv ? scan.kv : {}
    const pickV = (key) => {
      const e = kv[key]
      return e !== undefined && e !== null && e.value !== undefined ? e.value : undefined
    }
    const pickArrayLen = (key) => {
      const e = kv[key]
      return e !== undefined && e !== null && e.arrayLength !== undefined ? Number(e.arrayLength) : undefined
    }
    const pickEndingV = (suffix) => {
      for (const key of Object.keys(kv)) {
        if (key.endsWith(suffix)) {
          const e = kv[key]
          if (e !== undefined && e !== null && e.value !== undefined) return e.value
        }
      }
      return undefined
    }
    const chat = kv['tokenizer.chat_template']
    const chatLen = chat && chat.chatTemplateLength !== undefined ? Number(chat.chatTemplateLength) : 0
    return {
      architecture: pickV('general.architecture'),
      name: pickV('general.name') || pickV('general.basename') || fb.name,
      fileType: pickV('general.file_type'),
      quantization: fileTypeName(pickV('general.file_type') === undefined ? null : pickV('general.file_type'))
        || (pickV('general.quantization_version') !== undefined ? 'v' + pickV('general.quantization_version') : undefined)
        || fb.quantization,
      parameters: pickV('general.parameters') !== undefined ? Number(pickV('general.parameters')) / 1e6 : undefined,
      contextLength: firstDefined(pickEndingV('.context_length'), fb.contextLength),
      embeddingLength: firstDefined(pickEndingV('.embedding_length'), fb.embeddingLength),
      blockCount: firstDefined(pickEndingV('.block_count'), undefined),
      headCount: firstDefined(pickEndingV('.attention.head_count'), undefined),
      headCountKv: firstDefined(pickEndingV('.attention.head_count_kv'), undefined),
      keyLength: firstDefined(pickEndingV('.attention.key_length'), undefined),
      valueLength: firstDefined(pickEndingV('.attention.value_length'), undefined),
      tokenizerModel: pickV('tokenizer.ggml.model'),
      vocabSize: pickArrayLen('tokenizer.ggml.tokens'),
      bosToken: pickV('tokenizer.ggml.bos_token_id'),
      eosToken: pickV('tokenizer.ggml.eos_token_id'),
      hasChatTemplate: chatLen > 0 || undefined,
      chatTemplateLength: chatLen > 0 ? chatLen : undefined,
      tensorCount: scan ? scan.tensorCount : undefined,
      layerCount: firstDefined(pickEndingV('.block_count'), scan && scan.weightTensors ? Number(scan.weightTensors) : undefined),
      blockWeightTensors: scan && scan.weightTensors ? Number(scan.weightTensors) : undefined,
      kind: fb.kind,
      sizeLabel: fb.sizeLabel,
      scanned: true,
    }
  }

  function firstDefined() {
    for (let i = 0; i < arguments.length; i += 1) {
      if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i]
    }
    return undefined
  }

  LLAMA.modules.push('gguf')
  LLAMA.gguf = {
    MAGIC, VALUE_TYPES, FILETYPES, fileTypeName, filenameHints, parseHeader, summarize, summarizeScan, Reader,
  }
})(globalThis.LLAMA)
