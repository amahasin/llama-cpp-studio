// tests/units.test.js — the pure host modules, tested directly.
//
// The other suites boot the whole app, which is the right way to check that it
// works but a poor way to pin down the functions where the awkward cases live:
// a GGUF header parsed out of a downloaded file, an input validator, the asset
// scoring that decides which build gets installed, and the argv that decides
// whether llama-server starts at all. None of those had a test of their own.
'use strict'

const { loadHostModules } = require('../src/host.js')
const { createChecker } = require('./helpers.js')

const LLAMA = loadHostModules()
const { check, finish } = createChecker()

// ---------- GGUF fixtures ----------

function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}

function u64(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n), 0)
  return b
}

function gstr(s) {
  const bytes = Buffer.from(s, 'utf8')
  return Buffer.concat([u64(bytes.length), bytes])
}

/** A KV pair: key, type id, then the encoded value. */
function kvU32(key, value) {
  return Buffer.concat([gstr(key), u32(4), u32(value)])
}

function kvStr(key, value) {
  return Buffer.concat([gstr(key), u32(8), gstr(value)])
}

/** One tensor-info record: name, n_dims, dims, type, offset. */
function tensor(name, dims) {
  const parts = [gstr(name), u32(dims.length)]
  for (const d of dims) parts.push(u64(d))
  parts.push(u32(0), u64(0))
  return Buffer.concat(parts)
}

/** A small but structurally valid GGUF header. */
function buildGguf(options) {
  const o = options || {}
  const kvs = o.kvs || [
    kvStr('general.architecture', 'llama'),
    kvU32('general.file_type', 15),
    kvU32('llama.block_count', 3),
    kvU32('llama.context_length', 8192),
  ]
  const tensors = o.tensors || [
    tensor('token_embd.weight', [4096, 32000]),
    tensor('blk.0.attn_q.weight', [4096, 4096]),
    tensor('blk.1.attn_q.weight', [4096, 4096]),
    tensor('blk.2.attn_q.weight', [4096, 4096]),
  ]
  return Buffer.concat([
    Buffer.from(o.magic === undefined ? 'GGUF' : o.magic, 'ascii'),
    u32(o.version === undefined ? 3 : o.version),
    u64(tensors.length),
    u64(kvs.length),
    Buffer.concat(kvs),
    Buffer.concat(tensors),
  ])
}

function ggufSection() {
  console.log('\ngguf — header parsing')
  const gguf = LLAMA.gguf

  const parsed = gguf.parseHeader(buildGguf())
  check('a well-formed header parses', parsed.ok === true, parsed.reason)
  check('the version is read', parsed.version === 3, String(parsed.version))
  check('the kv count is read', parsed.kvCount === 4, String(parsed.kvCount))
  check('architecture comes through',
    parsed.kv['general.architecture'] && parsed.kv['general.architecture'].value === 'llama')
  check('block_count comes through',
    parsed.kv['llama.block_count'] && parsed.kv['llama.block_count'].value === 3)
  check('layers are counted from the blk.* tensors', parsed.layerCount === 3, String(parsed.layerCount))
  check('the first tensor name is kept', parsed.firstTensor === 'token_embd.weight', parsed.firstTensor)

  // Untrusted input: these are the shapes a corrupt or hostile file takes.
  check('a file that is not GGUF is refused',
    gguf.parseHeader(buildGguf({ magic: 'GGUB' })).reason === 'bad-magic')
  check('a header shorter than the fixed part is refused',
    gguf.parseHeader(Buffer.alloc(8)).reason === 'too-short')
  check('an empty buffer is refused', gguf.parseHeader(Buffer.alloc(0)).reason === 'too-short')

  const whole = buildGguf()
  const cut = gguf.parseHeader(whole.subarray(0, 40))
  check('a truncated header says so rather than throwing',
    cut.ok === false && (cut.reason === 'truncated' || cut.reason === 'bad-type'), cut.reason)

  // An unknown value type must stop the parse, not be skipped blindly.
  const badType = Buffer.concat([gstr('general.architecture'), u32(99), u32(1)])
  check('an unknown value type is refused',
    gguf.parseHeader(buildGguf({ kvs: [badType], tensors: [] })).reason === 'bad-type')

  // A KV count far larger than the data behind it must not spin or over-read.
  const lying = Buffer.concat([
    Buffer.from('GGUF', 'ascii'), u32(3), u64(0), u64(1000), kvU32('llama.block_count', 1),
  ])
  const lied = gguf.parseHeader(lying)
  check('a kv count larger than the data is refused', lied.ok === false, lied.reason)

  check('the quantization name is looked up', gguf.fileTypeName(15) === 'Q4_K_M', gguf.fileTypeName(15))
  check('an unknown quantization id falls back to the number', gguf.fileTypeName(9999) === '9999')

  const hints = gguf.filenameHints('Qwen2.5-7B-Instruct-Q4_K_M.gguf')
  check('the filename yields a quantization hint', hints.quantization === 'Q4_K_M', JSON.stringify(hints))
  check('and a size label', hints.sizeLabel === '7B', JSON.stringify(hints))
}

function securitySection() {
  console.log('\nsecurity — input validation')
  const sec = LLAMA.security

  check('an https URL is accepted', sec.validateHttpUrl('https://github.com/a/b.zip').ok === true)
  check('a non-http scheme is refused', sec.validateHttpUrl('file:///etc/passwd').code === 'BAD_URL_SCHEME')
  check('embedded credentials are refused',
    sec.validateHttpUrl('https://user:pw@evil.example/x.zip').code === 'URL_USERINFO')
  check('whitespace in a URL is refused', sec.validateHttpUrl('https://a.example/ b').code === 'BAD_URL_CHARS')
  check('an empty URL is refused', sec.validateHttpUrl('').code === 'EMPTY_URL')
  check('a URL with a port is accepted', sec.validateHttpUrl('http://localhost:8080/x').ok === true)
  // This is the branch whose body used to be empty, so every host shape passed.
  check('a malformed host is refused', sec.validateHttpUrl('https://ho st/x').ok === false)
  check('an IPv6 literal is refused rather than half-parsed',
    sec.validateHttpUrl('http://[::1]:8080/x').code === 'BAD_URL_HOST')

  check('a plain file name is accepted', sec.validateFileName('model-q4.gguf').ok === true)
  check('a path separator is refused', sec.validateFileName('a/b.gguf').code === 'BAD_NAME_SEP')
  check('a backslash is refused', sec.validateFileName('a\\b.gguf').code === 'BAD_NAME_SEP')
  check('".." is refused', sec.validateFileName('..').code === 'BAD_NAME_DOT')
  check('a reserved device name is refused', sec.validateFileName('CON.gguf').code === 'RESERVED_NAME')
  check('a trailing dot is refused', sec.validateFileName('model.').code === 'BAD_NAME_END')
  check('a control character is refused', sec.validateFileName('a\u0000b').code === 'BAD_NAME_CHARS')

  check('owner/repo is accepted', sec.validateRepository('Qwen/Qwen2.5-0.5B-GGUF').ok === true)
  check('a bare name is refused', sec.validateRepository('Qwen').code === 'BAD_REPO')
  check('a traversal segment is refused', sec.validateRepository('../etc').code === 'BAD_REPO')
  check('three segments are refused', sec.validateRepository('a/b/c').code === 'BAD_REPO')

  check('a simple model id is accepted', sec.validateModelId('qwen2.5-0.5b').ok === true)
  check('a slash in a model id is refused', sec.validateModelId('a/b').code === 'BAD_MODEL_ID')
  check('an empty model id is refused', sec.validateModelId('').code === 'BAD_MODEL_ID')

  check('an empty host defaults to loopback', sec.validateHost('').host === '127.0.0.1')
  check('a host with a space is refused', sec.validateHost('a b').code === 'BAD_HOST')

  check('a normal port is accepted', sec.validatePort(8080).port === 8080)
  check('a privileged port is refused', sec.validatePort(80).code === 'BAD_PORT')
  check('port 0 is refused', sec.validatePort(0).code === 'BAD_PORT')
  check('a non-numeric port is refused', sec.validatePort('abc').code === 'BAD_PORT')

  check('a clean argv is accepted', sec.validateArgv(['a.exe', '--flag', 'v']).ok === true)
  check('a non-array argv is refused', sec.validateArgv('a.exe').code === 'BAD_ARGV')
  check('an empty argv item is refused', sec.validateArgv(['a', '']).code === 'BAD_ARGV_EMPTY')
  check('a control character in argv is refused', sec.validateArgv(['a', 'b\u0001']).code === 'BAD_ARGV_CTRL')

  const caps = { 'no-perf': true }
  check('a supported extra flag is accepted', sec.validateExtraArgs(['--no-perf'], caps).ok === true)
  check('an unsupported extra flag is refused',
    sec.validateExtraArgs(['--not-a-flag'], caps).code === 'UNSUPPORTED_FLAG')
  check('a value token is not checked against capabilities',
    sec.validateExtraArgs(['--no-perf', '7'], caps).ok === true)
  check('no list means no args', sec.validateExtraArgs(undefined, caps).args.length === 0)

  check('a build tag is accepted', sec.validateVersionDirName('b10632').ok === true)
  check('a traversal version dir is refused', sec.validateVersionDirName('../evil').code === 'BAD_VERSION_DIR')
}

function assetSection() {
  console.log('\nassetSelector — which build gets installed')
  const sel = LLAMA.assetSelector

  const assets = [
    { name: 'llama-b10632-bin-win-cpu-x64.zip', size: 1 },
    { name: 'llama-b10632-bin-win-cuda-12.4-x64.zip', size: 2 },
    { name: 'llama-b10632-bin-win-vulkan-x64.zip', size: 3 },
    { name: 'llama-b10632-bin-ubuntu-x64.zip', size: 4 },
    { name: 'llama-b10632-bin-macos-arm64.zip', size: 5 },
    { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', size: 6 },
    { name: 'source.tar.gz', size: 7 },
  ]
  const windows = { os: 'windows', arch: 'x64', cpu: { flags: ['avx2'] } }

  const cuda = sel.selectBestAsset(assets, Object.assign({ backend: 'cuda' }, windows))
  check('an explicit cuda request picks the cuda build',
    cuda.ok === true && /cuda/.test(cuda.asset.name), cuda.ok ? cuda.asset.name : cuda.reasons[0])

  const cpu = sel.selectBestAsset(assets, Object.assign({ backend: 'cpu' }, windows))
  check('an explicit cpu request picks the cpu build',
    cpu.ok === true && /-cpu-/.test(cpu.asset.name), cpu.ok ? cpu.asset.name : cpu.reasons[0])

  const vulkan = sel.selectBestAsset(assets, Object.assign({ backend: 'vulkan' }, windows))
  check('an explicit vulkan request picks the vulkan build',
    vulkan.ok === true && /vulkan/.test(vulkan.asset.name), vulkan.ok ? vulkan.asset.name : vulkan.reasons[0])

  check('the CUDA runtime companion is never chosen as the build',
    cuda.ok === true && !/^cudart/.test(cuda.asset.name), cuda.ok ? cuda.asset.name : '')
  check('a source tarball is never chosen',
    cpu.ok === true && !/^source/.test(cpu.asset.name))

  const noMatch = sel.selectBestAsset(assets, { os: 'windows', arch: 'riscv', backend: 'cpu', cpu: {} })
  check('an unsupported architecture reports no match rather than guessing', noMatch.ok === false)
  check('and says what it was looking for', /riscv/.test(noMatch.reasons.join(' ')))

  check('a non-llama asset name parses as null', sel.parseAssetName('source.tar.gz') === null)
  const win = sel.parseAssetName('llama-b10632-bin-win-cuda-12.4-x64.zip')
  check('an asset name yields os/arch/backend',
    win && win.os === 'windows' && win.arch === 'x64' && win.backend === 'cuda', JSON.stringify(win))

  check('build numbers order numerically, not as text',
    sel.compareVersions('b9999', 'b10000') === -1)
  check('equal tags compare equal', sel.compareVersions('b8000', 'b8000') === 0)
  check('a newer tag is greater', sel.compareVersions('b10632', 'b10545') === 1)
  check('the build number is extracted', sel.parseBuildNumber('b10632') === 10632)
  check('a tagless string has no build number', sel.parseBuildNumber('latest') === undefined)
}

function commandSection() {
  console.log('\ncommandBuilder — the llama-server argv')
  const cb = LLAMA.commandBuilder

  const model = { path: 'C:/models/m.gguf', name: 'm.gguf', metadata: {}, profile: {} }
  // Stand in for a current build that supports everything the builder knows
  // about. capsHave treats an EMPTY map as "emit every flag", so testing
  // against {} would hide exactly the gating this checks.
  const caps = {}
  for (const def of cb.OPTION_DEFS) {
    for (const cap of def.caps) caps[cap] = true
  }
  const version = { capabilities: caps, backend: 'cuda' }
  const settings = { host: '127.0.0.1', port: 8080 }

  const basic = cb.build(model, version, settings, { contextSize: 4096, gpuLayers: 33 })
  check('a launch can be built', basic.ok === true, basic.message)
  const argv = basic.argv || []
  check('the model path is passed', argv.includes('C:/models/m.gguf'))
  check('the context size is passed', argv[argv.indexOf('--ctx-size') + 1] === '4096')
  check('the gpu layer count is passed', argv[argv.indexOf('--n-gpu-layers') + 1] === '33')
  check('the bind address is passed', argv[argv.indexOf('--port') + 1] === '8080')

  // The point of the api-key-file work: the key must not reach the argv when
  // the build can read it from a file instead.
  const withKey = cb.build(model, version, settings, { apiKey: 'secret-key' })
  check('without a key file the key is on the command line',
    (withKey.argv || []).includes('secret-key'))
  const withFile = cb.build(model, version, settings,
    { apiKey: 'secret-key', apiKeyFile: 'C:/data/configs/api-key.txt' })
  check('with a key file the key is NOT on the command line',
    !(withFile.argv || []).includes('secret-key'), (withFile.argv || []).join(' '))
  check('and the file is passed instead',
    (withFile.argv || []).includes('--api-key-file'))

  // A build that predates the flag has to keep working, key and all.
  const oldCaps = Object.assign({}, caps)
  delete oldCaps['api-key-file']
  // (the rest of the build is unchanged; only the newer flag is missing)
  const oldBuild = cb.build(model, { capabilities: oldCaps, backend: 'cpu' }, settings,
    { apiKey: 'secret-key', apiKeyFile: 'C:/data/configs/api-key.txt' })
  check('a build without --api-key-file falls back to --api-key',
    (oldBuild.argv || []).includes('--api-key') && (oldBuild.argv || []).includes('secret-key'))

  // Flags the installed binary does not advertise must never be emitted:
  // llama-server exits on an unknown option.
  const narrowCaps = { m: true, model: true, 'ctx-size': true, host: true, port: true }
  const narrow = cb.build(model, { capabilities: narrowCaps, backend: 'cpu' },
    settings, { contextSize: 2048, flashAttention: true })
  check('an unsupported flag is left out rather than killing the launch',
    !(narrow.argv || []).includes('--flash-attn'), (narrow.argv || []).join(' '))

  const ini = cb.argvToIni(['--ctx-size', '4096', '--flash-attn', '--temp', '-1.5'])
  check('a value becomes key = value', /ctx-size = 4096/.test(ini), ini)
  check('a bare flag becomes key = true', /flash-attn = true/.test(ini), ini)
  check('a negative number is a value, not the next flag', /temp = -1\.5/.test(ini), ini)

  check('an empty capability map emits the flag', cb.capsHave({}, ['anything']) === true)
  check('a known flag is reported present', cb.capsHave({ 'ctx-size': true }, ['ctx-size']) === true)
  check('an unknown flag is reported absent', cb.capsHave({ 'ctx-size': true }, ['nope']) === false)
}

// ---------- log ring ----------

/**
 * The router traces every request it forwards to a model instance, and this
 * app polls two model-scoped endpoints every couple of seconds — so that trace
 * arrived once a second, forever. It was 80% of the log and pushed real errors
 * out of the 6000-line ring within a couple of hours. It is dropped now, and
 * counted, because a log that quietly loses lines is worse than a noisy one.
 */
function logSection() {
  const store = new LLAMA.logs.LogStore({
    config: { get() { return { logsDirectory: '.tmp' } } },
    exec: { async ensureDir() {} },
    fs: {},
    timers: { interval() { return function () {} } },
  })

  const noise = '5.52.461.749 I srv  proxy_reques: proxying request to model Qwen-UD on port 57777'
  const real = '0.39.810.077 I srv          load: spawning server instance with name=gemma'

  const NL = String.fromCharCode(10)
  store.server('stderr', noise + NL + real + NL)
  const after = store.lines({ limit: 50 }).lines
  check('the router’s per-request trace is dropped',
    after.every(function (l) { return l.text.indexOf('proxying request') === -1 }),
    JSON.stringify(after.map(function (l) { return l.text })))
  check('everything else the server says is kept',
    after.length === 1 && after[0].text === real, JSON.stringify(after))
  check('and the dropped ones are counted, not forgotten', store.suppressed === 1,
    String(store.suppressed))

  for (let i = 0; i < 249; i += 1) store.server('stderr', noise + NL)
  const summarised = store.lines({ limit: 50 }).lines
  check('after enough of them the log says how many it dropped',
    summarised.some(function (l) { return /suppressed 250 routine/.test(l.text) }),
    JSON.stringify(summarised.map(function (l) { return l.text })))

  // The filter reads the server's output. This app writing about the thing is
  // not the thing, or the summary line would delete itself.
  store.plugin('the router logs "proxying request to model" on every poll')
  check('an app line mentioning the trace is not itself dropped',
    store.lines({ limit: 5 }).lines.some(function (l) {
      return l.stream === 'plugin' && /on every poll/.test(l.text)
    }))
}

function main() {
  console.log('llama.cpp Studio unit checks')
  ggufSection()
  securitySection()
  assetSection()
  commandSection()
  logSection()
  return finish('units.test.js')
}

process.exit(main())
