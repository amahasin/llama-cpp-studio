#!/usr/bin/env node
// tools/patch-client-bundle.js — re-apply this app's changes to the vendored UI.
//
// runtime/client.bundle.js is built in the plugin repository and copied here by
// pack.js, which overwrites it wholesale. The fixes below cannot be made
// anywhere else in this tree — they are inside the UI — so they live here as
// data, and this script puts them back after any re-pack.
//
//   node tools/patch-client-bundle.js            apply (idempotent)
//   node tools/patch-client-bundle.js --check    report only, exit 1 if missing
//
// tests/bundle.test.js runs --check, so a re-pack that silently reverts these
// fails the suite instead of quietly shipping the old behaviour.
'use strict'

const fs = require('node:fs')

const { BUNDLED_UI } = require('../src/lib/layout.js')

const MARKER = 'const INLINED_CLIENT_MODULES = '

// The app mark, shared with web/icon.svg and the tray icon in src/tray.ps1.
const LLAMA_PATH = 'M23 57 C23 45 25 35 30 29 C32 25 32.5 22 33 19 '
  + 'L31.2 10 C30.6 5 35.2 4.4 36.2 9.4 L37.5 18 L42 17 L43 7.6 '
  + 'C43.6 2.6 48.2 3.2 48.2 8.2 L48 19.5 C52.5 21.5 57 24.5 58 28 '
  + 'C58.8 30.5 57 33 54 33 L45 33.5 C41 34 38.5 37 38 42 L37.5 57 Z'

/**
 * Each patch names the module, what it is for, an exact `find` and its
 * `replace`, and a `present` string that says the patch is already applied.
 */
const PATCHES = [
  {
    module: 'chat.js',
    name: 'chat-iframe-same-origin',
    why: 'the chat frame pointed at llama-server\'s own address, which is nothing '
      + 'on any other device, and cross-origin frames get no clipboard',
    present: "src: '/llama/'",
    find: [
      "      h('iframe', {",
      '        key: root + \':\' + nonce,',
      '        src: root,',
      "        className: 'llama-chat-iframe',",
      "        title: 'llama.cpp chat',",
      "        referrerPolicy: 'no-referrer',",
      '      }))',
    ].join('\n'),
    replace: [
      "      h('iframe', {",
      '        key: root + \':\' + nonce,',
      "        // Same-origin, through this app's own reverse proxy — see",
      '        // src/http/proxy.js. Pointing the frame straight at llama-server',
      '        // broke it on every device that is not the one it runs on:',
      "        // 127.0.0.1 in a phone's browser is the phone. And a cross-origin",
      '        // frame is not granted clipboard-write, which is why the copy',
      '        // buttons in llama.cpp\'s UI silently did nothing.',
      "        src: '/llama/',",
      "        className: 'llama-chat-iframe',",
      "        title: 'llama.cpp chat',",
      "        referrerPolicy: 'no-referrer',",
      "        allow: 'clipboard-write; clipboard-read',",
      '      }))',
    ].join('\n'),
  },
  {
    module: 'chat.js',
    name: 'chat-open-in-new-tab',
    why: '"Open in new tab" had the same unreachable address',
    present: "window.open('/llama/', '_blank')",
    find: "onClick: function () { window.open(root, '_blank') },",
    replace: "onClick: function () { window.open('/llama/', '_blank') },",
  },
  {
    module: 'ui-core.js',
    name: 'app-mark',
    why: 'the sidebar mark was a generic layers glyph with nothing to do with llama.cpp',
    present: 'llama.cpp Studio app mark',
    find: [
      "      case 'logo':",
      "        return h('svg', { viewBox: '0 0 24 24', style },",
      "          h('path', { d: 'M12 2L2 7l10 5 10-5-10-5z' }),",
      "          h('path', { d: 'M2 17l10 5 10-5' }),",
      "          h('path', { d: 'M2 12l10 5 10-5' }))",
    ].join('\n'),
    replace: [
      "      case 'logo':",
      '        // llama.cpp Studio app mark: a llama in profile, the same geometry',
      '        // as web/icon.svg and the tray icon. Filled rather than stroked',
      '        // like the navigation glyphs — a brand mark reads better solid at',
      '        // 19px, and the long neck is what keeps it legible small.',
      "        return h('svg', { viewBox: '20 0 42 60', style },",
      "          h('path', { fill: 'currentColor', stroke: 'none', d: '" + LLAMA_PATH + "' }))",
    ].join('\n'),
  },
  {
    module: 'models.js',
    name: 'download-rate-units',
    why: 'a download\'s bytes/second was printed with fmtRate, which is the '
      + 'tokens/second formatter — a 5 MB/s download read "5242880.0 tok/s"',
    present: "props.fmtBytes(d.bytesPerSecond) + '/s'",
    find: '                props.fmtRate(d.bytesPerSecond),',
    replace: [
      '                d.bytesPerSecond ? props.fmtBytes(d.bytesPerSecond) + \'/s\' : undefined,',
    ].join('\n'),
  },
  {
    module: 'versions.js',
    name: 'install-rate-units',
    why: 'the llama.cpp build download had the same tok/s mistake',
    present: "props.fmtBytes(fields.bytesPerSecond) + '/s'",
    find: '                  props.fmtRate(fields.bytesPerSecond),',
    replace: [
      '                  fields.bytesPerSecond ? props.fmtBytes(fields.bytesPerSecond) + \'/s\' : undefined,',
    ].join('\n'),
  },
  {
    module: 'models.js',
    name: 'mtp-pill',
    why: 'a model that ships a multi-token-prediction head is served with it, '
      + 'and the library should say so the way it says "vision"',
    // Specific to this version of the patch: a marker that merely said "some
    // mtpPill exists" would report an older revision of it as up to date.
    present: 'const builtIn = (m.metadata || {}).hasMtp === true',
    find: [
      '    function modelCard(m) {',
    ].join('\n'),
    replace: [
      '    // The same for a multi-token-prediction head: it is handed to',
      '    // llama.cpp as the draft model, so a card that has one is being',
      '    // started differently from one that is not.',
      '    function mtpPill(m) {',
      '      const settings = m.settings || {}',
      '      // Two ways a model can have a head: built into the file (Qwen3.6',
      '      // carries nextn layers) or shipped beside it (gemma-4 ships',
      '      // mtp-*.gguf). Either one gets the tag.',
      '      const builtIn = (m.metadata || {}).hasMtp === true',
      '      const head = m.mtpPath || settings.mtpPath',
      '      if (!builtIn && !head) return null',
      '      if (settings.mtp === false) {',
      '        return h(comp.Pill, {',
      "          tone: 'mute', plain: true,",
      "          title: 'This model supports multi-token prediction, but it is turned off in Model settings',",
      "        }, 'mtp off')",
      '      }',
      '      return h(comp.Pill, {',
      "        tone: 'accent', plain: true,",
      '        title: builtIn',
      "          ? 'Multi-token prediction is built into this model — served with --spec-type draft-mtp'",
      "          : 'Ships a multi-token-prediction head beside the model — served as the draft model',",
      "      }, 'mtp')",
      '    }',
      '',
      '    function modelCard(m) {',
    ].join('\n'),
  },
  {
    module: 'dashboard.js',
    name: 'loading-elapsed',
    why: 'a load showed a bare "loading" pill for however long it took — on a '
      + '20GB model that is minutes with no sign of progress. llama.cpp exposes '
      + 'no percentage at any verbosity, so elapsed time is the honest signal',
    present: 'row.workingSeconds',
    find: "                  props.running ? h2(comp.Pill, { tone: tone(row.state) }, row.state || 'unknown') : null,",
    replace: [
      '                  props.running',
      '                    ? h2(comp.Pill, {',
      '                      tone: tone(row.state),',
      "                      title: typeof row.workingSeconds === 'number'",
      "                        ? 'llama.cpp reports no progress figure while it loads, only how long it has been at it'",
      '                        : undefined,',
      "                    }, typeof row.workingSeconds === 'number'",
      "                      ? (row.state + ' · ' + row.workingSeconds + 's')",
      "                      : (row.state || 'unknown'))",
      '                    : null,',
    ].join('\n'),
  },
  {
    module: 'models.js',
    name: 'mtp-form',
    why: 'the settings form needs the switch\'s current value',
    present: 'mtp: eff.mtp !== false',
    find: '          vision: eff.vision !== false,',
    replace: [
      '          vision: eff.vision !== false,',
      '          // Same rule for the MTP head: present means used, unless it was',
      '          // deliberately turned off.',
      '          mtp: eff.mtp !== false,',
    ].join('\n'),
  },
  {
    module: 'models.js',
    name: 'mtp-save',
    why: 'and has to save it',
    present: 'mtp: form.mtp === true',
    find: '        vision: form.vision === true,',
    replace: [
      '        vision: form.vision === true,',
      '        mtp: form.mtp === true,',
    ].join('\n'),
  },
  {
    module: 'models.js',
    name: 'mtp-switch',
    why: 'without a control the head cannot be turned off for a model',
    present: 'multi-token-prediction head to draft tokens ahead',
    find: "        h('div', { className: 'llama-section-title' }, 'Advanced'),",
    replace: [
      "        h('div', { className: 'llama-section-title' }, 'Speculative decoding'),",
      '        h(comp.SwitchRow, {',
      "          label: 'Multi-token prediction (MTP)', flag: '--spec-draft-model', value: form.mtp,",
      '          // Never disabled: the launch also looks beside the model file, so',
      '          // a head dropped there later would otherwise be picked up with no',
      '          // way to have said no first.',
      "          hint: 'Use this model\u2019s multi-token-prediction head to draft tokens ahead"
        + ' of itself, which speeds up generation. Some models carry the head inside the'
        + " file; others ship it beside them as mtp-*.gguf.',",
      "          onChange: function (v) { set('mtp', v) },",
      '        }),',
      '',
      "        h('div', { className: 'llama-section-title' }, 'Advanced'),",
    ].join('\n'),
  },
  {
    module: 'models.js',
    name: 'mtp-pill-render',
    why: 'the pill has to appear on the card',
    present: 'mtpPill(m)),',
    find: '              visionPill(m)),',
    replace: [
      '              visionPill(m),',
      '              mtpPill(m)),',
    ].join('\n'),
  },
  {
    module: 'server-config.js',
    name: 'idle-unload-stamp',
    why: 'the settings form re-reads from status, so the field has to be in the '
      + 'stamp or an externally changed value never shows up',
    present: 'server.idleUnloadMinutes,',
    find: '      server.mode, server.routerModelsMax, server.routerAutoload,',
    replace: '      server.mode, server.routerModelsMax, server.routerAutoload, server.idleUnloadMinutes,',
  },
  {
    module: 'server-config.js',
    name: 'idle-unload-form',
    why: 'the form needs the current value in order to show it',
    present: 'idleUnloadMinutes: server.idleUnloadMinutes',
    find: '        routerAutoload: server.routerAutoload !== false,',
    replace: [
      '        routerAutoload: server.routerAutoload !== false,',
      '        idleUnloadMinutes: server.idleUnloadMinutes === undefined ? 30 : server.idleUnloadMinutes,',
    ].join('\n'),
  },
  {
    module: 'server-config.js',
    name: 'idle-unload-save',
    why: 'and has to send it back when Save is pressed',
    present: 'idleUnloadMinutes: Number(form.idleUnloadMinutes)',
    find: '          routerAutoload: form.routerAutoload === true,',
    replace: [
      '          routerAutoload: form.routerAutoload === true,',
      '          idleUnloadMinutes: Number(form.idleUnloadMinutes),',
    ].join('\n'),
  },
  {
    module: 'server-config.js',
    name: 'idle-unload-field',
    why: 'without a control the timeout is only reachable by editing config.json',
    present: 'Unload an idle model after',
    find: [
      "      form.mode === 'router'",
      "        ? h(comp.Notice, { tone: 'info', style: { marginTop: 12 } },",
    ].join('\n'),
    replace: [
      "      h('div', { style: { marginTop: 4 } },",
      '        h(comp.Field, {',
      "          label: 'Unload an idle model after', flag: 'minutes',",
      "          hint: form.mode === 'router'",
      "            ? 'A model nobody has sent a request to gives its memory back. The router'",
      "              + ' stays up and loads it again on the next request. 0 keeps models loaded.'",
      "            : 'A model nobody has sent a request to gives its memory back. In single-model'",
      "              + ' mode that means stopping the server, and nothing starts it again for you.'",
      "              + ' 0 keeps the model loaded.',",
      '        },',
      '        h(comp.NumberInput, {',
      '          value: form.idleUnloadMinutes, min: 0, max: 1440,',
      "          onChange: function (v) { set('idleUnloadMinutes', v) },",
      '        }))),',
      "      form.mode === 'router'",
      "        ? h(comp.Notice, { tone: 'info', style: { marginTop: 12 } },",
    ].join('\n'),
  },
]

function readBundle() {
  if (!fs.existsSync(BUNDLED_UI)) {
    console.error('no client bundle at ' + BUNDLED_UI)
    process.exit(1)
  }
  return fs.readFileSync(BUNDLED_UI, 'utf8')
}

/** Decode the inlined module map, returning { modules, before, after }. */
function splitBundle(source) {
  const at = source.indexOf(MARKER)
  if (at === -1) throw new Error('this bundle has no INLINED_CLIENT_MODULES map')
  const start = at + MARKER.length
  // The map is a JSON object literal; find its end by matching braces outside
  // of strings, which is enough for JSON and avoids pulling in a parser.
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = start; i < source.length; i += 1) {
    const c = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end === -1) throw new Error('could not find the end of the module map')
  return {
    modules: JSON.parse(source.slice(start, end)),
    before: source.slice(0, start),
    after: source.slice(end),
  }
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const source = readBundle()
  const { modules, before, after } = splitBundle(source)

  const applied = []
  const already = []
  const failed = []

  for (const patch of PATCHES) {
    const code = modules[patch.module]
    if (code === undefined) {
      failed.push(patch.name + ': no module ' + patch.module + ' in the bundle')
      continue
    }
    if (code.indexOf(patch.present) !== -1) {
      already.push(patch.name)
      continue
    }
    if (code.indexOf(patch.find) === -1) {
      failed.push(patch.name + ': the code it patches is not in ' + patch.module
        + ' (upstream changed it — re-check the patch)')
      continue
    }
    modules[patch.module] = code.replace(patch.find, patch.replace)
    applied.push(patch.name)
  }

  for (const name of already) console.log('  present: ' + name)
  for (const name of applied) console.log('  ' + (checkOnly ? 'MISSING: ' : 'applied: ') + name)
  for (const line of failed) console.error('  FAILED:  ' + line)

  if (checkOnly) {
    if (applied.length > 0) {
      console.error('\n' + applied.length + ' patch(es) are missing from the bundle.')
      console.error('Run: node tools/patch-client-bundle.js')
      return 1
    }
    if (failed.length > 0) return 1
    console.log('\nthe bundle carries every patch.')
    return 0
  }

  if (failed.length > 0) {
    console.error('\nrefusing to write a partially patched bundle.')
    return 1
  }
  if (applied.length === 0) {
    console.log('\nnothing to do.')
    return 0
  }
  fs.writeFileSync(BUNDLED_UI, before + JSON.stringify(modules) + after)
  console.log('\nwrote ' + BUNDLED_UI)
  return 0
}

process.exit(main())
