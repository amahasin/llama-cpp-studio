// tests/mtp.test.js — multi-token-prediction heads.
//
// A repository that supports MTP ships a second GGUF beside the model —
// "mtp-<model>.gguf", sometimes under an MTP/ subfolder, as
// unsloth/gemma-4-26B-A4B-it-qat-GGUF does. llama.cpp takes one as the draft
// model for speculative decoding, so finding the right file and putting it on
// the command line is the whole feature.
//
// The directory listing is stubbed: this is about which file gets chosen, not
// about the filesystem.
'use strict'

const { loadHostModules } = require('../src/host.js')
const { createChecker } = require('./helpers.js')

const LLAMA = loadHostModules()
const { check, finish } = createChecker()

/** A ModelManager whose directory listings the test supplies. */
function managerWith(tree) {
  const exec = {
    async listDir(dir) {
      const key = String(dir).replace(/\\/g, '/').toLowerCase()
      const names = tree[key]
      if (names === undefined) return undefined
      return names.map(function (n) { return { name: n, isDir: false, size: 1024 } })
    },
    async stat() { return { exists: true, isDir: false } },
  }
  return new LLAMA.models.ModelManager({
    exec,
    config: { get() { return { metadataDirectory: 'C:/data/metadata', modelsDirectory: 'C:/data/models' } } },
    fs: undefined,
    log() {},
    progress() {},
  })
}

/** Every capability the builder knows, i.e. a current llama.cpp build. */
function allCaps() {
  const caps = {}
  for (const def of LLAMA.commandBuilder.OPTION_DEFS) {
    for (const cap of def.caps) caps[cap] = true
  }
  return caps
}

async function main() {
  console.log('llama.cpp Studio multi-token prediction')

  // ---- finding the head ----
  {
    const m = managerWith({
      'c:/models/gemma': [
        'gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf',
        'mtp-gemma-4-26B-A4B-it.gguf',
        'mmproj-BF16.gguf',
      ],
    })
    const found = await m.detectMtp('C:/models/gemma/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf')
    check('a head beside the model is found',
      /mtp-gemma-4-26B-A4B-it\.gguf$/.test(String(found.mtp)), String(found.mtp))
    check('and the vision projector is not mistaken for one',
      !/mmproj/i.test(String(found.mtp)), String(found.mtp))
  }

  // ---- the MTP/ subfolder that repository actually uses ----
  {
    const m = managerWith({
      'c:/models/gemma': ['gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf', 'mmproj-F16.gguf'],
      'c:/models/gemma/mtp': [
        'mtp-gemma-4-26B-A4B-it-BF16.gguf',
        'mtp-gemma-4-26B-A4B-it-Q4_0.gguf',
        'mtp-gemma-4-26B-A4B-it-Q8_0.gguf',
      ],
    })
    const found = await m.detectMtp('C:/models/gemma/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf')
    check('a head in the MTP/ subfolder is found', found.mtp !== undefined, String(found.mtp))
    check('all three quantizations are offered as candidates',
      found.candidates.length === 3, String(found.candidates.length))
    check('and a quantized head is preferred over the full-precision one',
      /q4|q8/i.test(String(found.mtp)), String(found.mtp))
  }

  // ---- MTP/ and mtp/ are one directory on Windows ----
  {
    const m = managerWith({
      'c:/models/x': ['x.gguf'],
      'c:/models/x/mtp': ['mtp-x.gguf'],
    })
    const found = await m.detectMtp('C:/models/x/x.gguf')
    check('the same head is not listed once per spelling of the subfolder',
      found.candidates.length === 1, String(found.candidates.length))
  }

  // ---- nothing to find ----
  {
    const m = managerWith({ 'c:/models/plain': ['plain.gguf', 'mmproj-plain.gguf'] })
    const found = await m.detectMtp('C:/models/plain/plain.gguf')
    check('a model with no head reports none', found.mtp === undefined, String(found.mtp))
    check('and offers no candidates', found.candidates.length === 0)
  }
  {
    const m = managerWith({ 'c:/models/odd': ['odd.gguf', 'temptation-7b.gguf', 'mtpx-notahead.gguf'] })
    const found = await m.detectMtp('C:/models/odd/odd.gguf')
    check('a name that merely contains the letters is not a head',
      found.mtp === undefined, String(found.mtp))
  }

  // ---- classification: a head is a companion, not a model to serve ----
  {
    const kind = LLAMA.models.companionKind
    check('an mtp file classifies as a head', kind({ name: 'mtp-gemma-4-26B.gguf' }) === 'mtp')
    check('an mmproj file still classifies as a projector', kind({ name: 'mmproj-F16.gguf' }) === 'mmproj')
    check('an ordinary model classifies as neither',
      kind({ name: 'gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf' }) === undefined)
    check('an explicit kind is respected over the name',
      kind({ name: 'mtp-thing.gguf', kind: 'model' }) === undefined)
  }

  // ---- the command line ----
  {
    const cb = LLAMA.commandBuilder
    const model = { path: 'C:/m/gemma.gguf', name: 'gemma.gguf', metadata: {}, profile: {} }
    const settings = { host: '127.0.0.1', port: 8080 }

    const withHead = cb.build(model, { capabilities: allCaps(), backend: 'cuda' }, settings,
      { draftModel: 'C:/m/MTP/mtp-gemma.gguf' })
    check('the head is passed as the draft model',
      withHead.argv[withHead.argv.indexOf('--spec-draft-model') + 1] === 'C:/m/MTP/mtp-gemma.gguf',
      withHead.argv.join(' '))

    const none = cb.build(model, { capabilities: allCaps(), backend: 'cuda' }, settings, {})
    check('a model without a head passes no draft model',
      !none.argv.includes('--spec-draft-model'))

    // A build that predates the flag must not be handed it.
    const oldCaps = allCaps()
    delete oldCaps['spec-draft-model']
    delete oldCaps['model-draft']
    delete oldCaps.md
    const oldBuild = cb.build(model, { capabilities: oldCaps, backend: 'cpu' }, settings,
      { draftModel: 'C:/m/MTP/mtp-gemma.gguf' })
    check('a build without the flag omits it rather than failing to start',
      !oldBuild.argv.includes('--spec-draft-model'), oldBuild.argv.join(' '))

    // Router mode serves models from a preset file, so it has to arrive there.
    const preset = cb.buildPreset(
      [{ id: 'gemma', modelId: 'm1', model: { path: 'C:/m/gemma.gguf', name: 'gemma.gguf', profile: { draftModel: 'C:/m/MTP/mtp-gemma.gguf' } } }],
      { capabilities: allCaps(), backend: 'cuda' })
    check('the router preset carries the head too',
      preset.ok && /spec-draft-model = C:\/m\/MTP\/mtp-gemma\.gguf/.test(preset.ini), String(preset.ini))
  }

  // ---- the per-model switch ----
  {
    const server = Object.create(LLAMA.server.ServerManager.prototype)
    server.deps = {
      models: { async detectMtp() { return { ok: true, mtp: 'C:/m/mtp-gemma.gguf', candidates: [] } } },
      exec: { async stat() { return { exists: true, isDir: false } } },
    }
    const model = { path: 'C:/m/gemma.gguf', name: 'gemma.gguf' }

    const on = await server._resolveMtp({}, model)
    check('detection supplies the head when nothing was saved',
      on.draftModel === 'C:/m/mtp-gemma.gguf', String(on.draftModel))

    const off = await server._resolveMtp({ mtp: false }, model)
    check('turning MTP off drops it', off.draftModel === undefined, String(off.draftModel))

    const offWithSaved = await server._resolveMtp({ mtp: false, mtpPath: 'C:/m/mtp-gemma.gguf' }, model)
    check('and outranks a head saved earlier, rather than handing it back',
      offWithSaved.draftModel === undefined, String(offWithSaved.draftModel))

    const explicit = await server._resolveMtp({ mtpPath: 'C:/m/chosen.gguf' }, model)
    check('an explicitly chosen head wins over detection',
      explicit.draftModel === 'C:/m/chosen.gguf', String(explicit.draftModel))

    const recorded = await server._resolveMtp({}, { path: 'C:/m/gemma.gguf', mtpPath: 'C:/m/recorded.gguf' })
    check('the head recorded at import time is used before a fresh scan',
      recorded.draftModel === 'C:/m/recorded.gguf', String(recorded.draftModel))

    // A head that has since been deleted must not reach the command line.
    server.deps.exec.stat = async function () { return { exists: false } }
    const gone = await server._resolveMtp({ mtpPath: 'C:/m/deleted.gguf' }, model)
    check('a head whose file is gone is dropped', gone.draftModel === undefined, String(gone.draftModel))
  }

  return finish('mtp.test.js')
}

main()
  .then(function (code) { process.exit(code) })
  .catch(function (err) {
    console.error(err && err.stack ? err.stack : err)
    process.exit(1)
  })
