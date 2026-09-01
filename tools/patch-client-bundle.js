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

/**
 * A patch target that is not one of the inlined modules.
 *
 * The bundle is a module map wrapped in loader code, and the stylesheet lives
 * in that wrapper — so a fix to the CSS had nowhere to go and had to be made
 * by hand after every re-pack, which is exactly what this file exists to stop.
 */
const SHELL = '(bundle shell)'

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
    name: 'chat-frame-follows-loaded-model',
    why: 'the embedded chat picks its own model — the one that answered last in '
      + 'the conversation, else the first in the list — so the model loaded here '
      + 'was not the one that answered, and with one resident at a time it was '
      + 'evicted. The UI takes ?model= on its own URL, which settles it.',
    present: 'frameSrc',
    find: '    const [nonce, setNonce] = React.useState(0)',
    replace: [
      '    const [nonce, setNonce] = React.useState(0)',
      '',
      '    // Which model the frame should open on.',
      '    //',
      "    // llama.cpp's web UI chooses for itself: the model that answered last",
      '    // in the conversation it opens, else the first one in the list. Neither',
      '    // is necessarily the one loaded here, and its selector shortens the',
      '    // name, so two quantizations of one model are indistinguishable there.',
      '    // With "Models loaded at once" set to 1 the wrong pick is an eviction.',
      '    // ?model= is that UI\'s own supported way of being told.',
      '    const loadedNow = ((server.router || {}).live || [])',
      "      .filter(function (m) { return m.state === 'loaded' })",
      '      .map(function (m) { return m.id })[0]',
      '    // Latched, not tracked. Recomputing it would rewrite the iframe src —',
      '    // reloading the frame and losing the conversation — every time the chat',
      '    // changed model on its own, which it is allowed to do.',
      '    const pinned = React.useRef(undefined)',
      '    if (pinned.current === undefined && loadedNow !== undefined) pinned.current = loadedNow',
      '    const frameSrc = pinned.current',
      "      ? '/llama/?model=' + encodeURIComponent(pinned.current)",
      "      : '/llama/'",
    ].join('\n'),
  },
  {
    module: 'chat.js',
    name: 'chat-reload-repins-model',
    why: 'reloading the frame should reopen it on whatever is loaded now, not on '
      + 'what happened to be loaded when the tab was first opened',
    present: 'pinned.current = undefined',
    find: [
      "          title: 'Reload chat frame (↻)',",
      '          onClick: function () { setNonce(function (n) { return n + 1 }) },',
    ].join('\n'),
    replace: [
      "          title: 'Reload chat frame (↻)',",
      '          onClick: function () {',
      '            // Drop the latch, so the reloaded frame opens on the model that',
      '            // is loaded now — which is the reason to press this.',
      '            pinned.current = undefined',
      '            setNonce(function (n) { return n + 1 })',
      '          },',
    ].join('\n'),
  },
  {
    module: 'chat.js',
    name: 'chat-iframe-same-origin',
    why: 'the chat frame pointed at llama-server\'s own address, which is nothing '
      + 'on any other device, and cross-origin frames get no clipboard',
    present: 'src: frameSrc',
    find: [
      "      h('iframe', {",
      '        key: root + \':\' + nonce,',
      "        // Same-origin, through this app's own reverse proxy — see",
      '        // src/http/proxy.js. Pointing the frame straight at llama-server',
      '        // broke it on every device that is not the one it runs on:',
      "        // 127.0.0.1 in a phone's browser is the phone. And a cross-origin",
      '        // frame is not granted clipboard-write, which is why the copy',
      "        // buttons in llama.cpp's UI silently did nothing.",
      "        src: '/llama/',",
      "        className: 'llama-chat-iframe',",
      "        title: 'llama.cpp chat',",
      "        referrerPolicy: 'no-referrer',",
      "        allow: 'clipboard-write; clipboard-read',",
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
      '        src: frameSrc,',
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
    present: "window.open(frameSrc, '_blank')",
    find: "onClick: function () { window.open('/llama/', '_blank') },",
    replace: "onClick: function () { window.open(frameSrc, '_blank') },",
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
    module: 'ui-core.js',
    name: 'copy-fallback',
    why: 'navigator.clipboard does not exist on a non-secure origin, so every '
      + 'Copy button silently failed when this app was reached over plain http '
      + 'on a LAN address — which is exactly the remote-access case',
    present: 'execCommand',
    find: [
      '    } catch (_e) { /* fall through */ }',
      '    return false',
      '  }',
    ].join('\n'),
    replace: [
      '    } catch (_e) { /* fall through */ }',
      '    // The async Clipboard API is unavailable on a non-secure origin and',
      '    // refused by an unfocused document. A hidden textarea still works in',
      '    // both cases, and is the only route when the app is reached over',
      '    // plain http on a LAN address.',
      '    try {',
      "      const ta = document.createElement('textarea')",
      '      ta.value = text',
      "      ta.setAttribute('readonly', '')",
      "      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0'",
      '      document.body.appendChild(ta)',
      '      ta.select()',
      '      ta.setSelectionRange(0, ta.value.length)',
      "      const ok = document.execCommand('copy')",
      '      document.body.removeChild(ta)',
      '      return ok === true',
      '    } catch (_e) {',
      '      return false',
      '    }',
      '  }',
    ].join('\n'),
  },
  {
    module: 'ui-core.js',
    name: 'eye-icons',
    why: 'a secret field needs a show/hide control and the icon set had none',
    present: "case 'eye':",
    find: "      case 'copy':",
    replace: [
      "      case 'eye':",
      "        return h('svg', { viewBox: '0 0 24 24', style },",
      "          h('path', { d: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z' }),",
      "          h('circle', { cx: 12, cy: 12, r: 3 }))",
      "      case 'eye-off':",
      "        return h('svg', { viewBox: '0 0 24 24', style },",
      "          h('path', { d: 'M9.9 5.2A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.9' }),",
      "          h('path', { d: 'M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4.3-1' }),",
      "          h('path', { d: 'M10 10a3 3 0 0 0 4 4' }),",
      "          h('line', { x1: 3, y1: 3, x2: 21, y2: 21 }))",
      "      case 'copy':",
    ].join('\n'),
  },
  {
    module: 'server-config.js',
    name: 'access-single-column',
    why: 'four text fields across one row left each about 190px wide — long URLs '
      + 'and origin lists were unreadable in the space they had',
    present: '// One field per row: these carry URLs and comma-separated lists',
    find: [
      '      h(comp.Fields, null,',
      '        h(comp.Field, {',
      "          label: 'API key', flag: '--api-key',",
    ].join('\n'),
    replace: [
      '      // One field per row: these carry URLs and comma-separated lists that',
      '      // do not fit in a quarter of the card.',
      "      h(comp.Fields, { style: { gridTemplateColumns: '1fr' } },",
      '        h(comp.Field, {',
      "          label: 'API key', flag: '--api-key',",
    ].join('\n'),
  },
  {
    module: 'server-config.js',
    name: 'api-key-controls',
    why: 'the key is redacted on the way out, so the field showed a placeholder '
      + 'with no way to see or copy the real one',
    present: "h(props.SvgIcon, { name: keyShown ? 'eye-off' : 'eye'",
    find: [
      '        h(comp.TextInput, {',
      "          value: form.apiKey, placeholder: 'leave empty for no authentication',",
      "          onChange: function (v) { set('apiKey', v) },",
      '        })),',
    ].join('\n'),
    replace: [
      "        h('div', { className: 'llama-path' },",
      "          h('input', {",
      "            className: 'llama-input',",
      "            type: keyShown ? 'text' : 'password',",
      "            value: form.apiKey === undefined || form.apiKey === null ? '' : String(form.apiKey),",
      "            placeholder: 'leave empty for no authentication',",
      '            spellCheck: false,',
      "            autoComplete: 'off',",
      "            onChange: function (e) { set('apiKey', e.target.value) },",
      '          }),',
      '          h(comp.Button, {',
      "            size: 'icon', variant: 'ghost',",
      "            title: keyShown ? 'Hide the API key' : 'Show the API key',",
      '            onClick: async function () {',
      '              if (keyShown) { setKeyShown(false); return }',
      '              const real = await resolveApiKey()',
      "              if (real !== undefined) { set('apiKey', real); setKeyShown(true) }",
      '            },',
      "          }, h(props.SvgIcon, { name: keyShown ? 'eye-off' : 'eye', size: 15 })),",
      '          h(comp.Button, {',
      "            size: 'icon', variant: 'ghost',",
      '            disabled: !form.apiKey,',
      "            title: 'Copy the API key',",
      '            onClick: async function () {',
      '              const real = await resolveApiKey()',
      "              if (real === undefined || real === '') return",
      '              const done = await props.copyText(real)',
      "              if (done) props.toastOk('API key copied')",
      "              else props.toastErr('Could not copy the API key')",
      '            },',
      "          }, h(props.SvgIcon, { name: 'copy', size: 15 })))),",
    ].join('\n'),
  },
  {
    module: 'server-config.js',
    name: 'api-key-state',
    why: 'the show/hide toggle and the deliberate reveal need somewhere to live',
    present: 'const [keyShown, setKeyShown]',
    find: '    const [dirty, setDirty] = React.useState(false)',
    replace: [
      '    const [dirty, setDirty] = React.useState(false)',
      '    const [keyShown, setKeyShown] = React.useState(false)',
      '',
      '    // Whether a value is the placeholder the host sends instead of a',
      '    // secret. Checked by shape rather than by equality: the bullets are',
      '    // multi-byte and a layer that mangles the encoding turns them into',
      '    // question marks or replacement characters.',
      '    function looksRedacted(v) {',
      "      if (typeof v !== 'string' || v === '') return false",
      "      return v.split('').every(function (c) {",
      "        return c.charCodeAt(0) > 127 || c === '?'",
      '      })',
      '    }',
      '',
      '    // The real key, fetched only when the user asks to see or copy it.',
      '    // Everything else keeps working with the placeholder, which is what',
      '    // keeps the key off the routine status poll.',
      '    async function resolveApiKey() {',
      '      const current = form && form.apiKey',
      '      if (!looksRedacted(current)) return current === undefined ? \'\' : String(current)',
      "      const r = await props.call('settings.reveal', { section: 'server', key: 'apiKey' })",
      "      if (r && r.ok) return r.value || ''",
      "      props.toastErr((r && r.message) || 'Could not read the API key')",
      '      return undefined',
      '    }',
    ].join('\n'),
  },
  {
    module: 'server-config.js',
    name: 'tls-single-column',
    why: 'the two TLS paths were side by side and equally cramped',
    present: '// The TLS paths are long; give them the width too.',
    find: [
      "      h('div', { className: 'llama-hint', style: { marginBottom: 10 } },",
      "        'Serve HTTPS instead of HTTP. Both files are needed — set one without the other and neither is used.'),",
      '      h(comp.Fields, null,',
    ].join('\n'),
    replace: [
      "      h('div', { className: 'llama-hint', style: { marginBottom: 10 } },",
      "        'Serve HTTPS instead of HTTP. Both files are needed — set one without the other and neither is used.'),",
      '      // The TLS paths are long; give them the width too.',
      "      h(comp.Fields, { style: { gridTemplateColumns: '1fr' } },",
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
    present: 'row.loadPercent',
    find: "                  props.running ? h2(comp.Pill, { tone: tone(row.state) }, row.state || 'unknown') : null,",
    replace: [
      '                  props.running',
      '                    ? h2(comp.Pill, {',
      '                      tone: tone(row.state),',
      '                      title: row.loadStage',
      "                        ? ('loading ' + String(row.loadStage).replace(/_/g, ' '))",
      "                        : (typeof row.workingSeconds === 'number'",
      "                          ? 'llama.cpp only streams a load fraction in router mode; this build reports elapsed time'",
      '                          : undefined),',
      "                    }, typeof row.loadPercent === 'number'",
      "                      ? (row.state + ' · ' + row.loadPercent + '%')",
      "                      : (typeof row.workingSeconds === 'number'",
      "                        ? (row.state + ' · ' + row.workingSeconds + 's')",
      "                        : (row.state || 'unknown')))",
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
    why: 'reorganize the Mode card fields into two columns including idle unload and autoload',
    present: "        form.mode === 'router'\n          ? h(comp.SwitchRow, {\n            label: 'Load on demand'",
    find: [
      '      h(comp.Fields, null,',
      '        h(comp.Field, {',
      "          label: 'Server mode',",
      "          hint: form.mode === 'router'",
      "            ? 'llama-server holds your whole library and loads whichever model a request names.'",
      "            : 'One model at a time, chosen on the Dashboard.',",
      '        },',
      '        h(comp.Select, {',
      "          value: form.mode, onChange: function (v) { set('mode', v) },",
      '          options: [',
      "            { value: 'single', label: 'Single model — pick one and start it' },",
      "            { value: 'router', label: 'Router — serve every model, load on demand' },",
      '          ],',
      '        })),',
      "        form.mode === 'router'",
      '          ? h(comp.Field, {',
      "            label: 'Models loaded at once', flag: '--models-max',",
      "            hint: 'Each loaded model keeps its weights in memory. 0 = no limit.',",
      '          },',
      '          h(comp.NumberInput, {',
      '            value: form.routerModelsMax, min: 0, max: 16,',
      "            onChange: function (v) { set('routerModelsMax', v) },",
      '          }))',
      '          : null),',
      "      form.mode === 'router'",
      "        ? h('div', { style: { marginTop: 4 } },",
      '          h(comp.SwitchRow, {',
      "            label: 'Load on demand', flag: '--models-autoload', value: form.routerAutoload,",
      "            hint: 'Load a model the first time a request asks for it. Off means it only'",
      "              + ' loads when you load it from the Dashboard.',",
      "            onChange: function (v) { set('routerAutoload', v) },",
      '          }))',
      '        : null,',
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
    ].join('\n'),
    replace: [
      "      h('div', { className: 'llama-cols-2' },",
      '        h(comp.Field, {',
      "          label: 'Server mode',",
      "          hint: form.mode === 'router'",
      "            ? 'llama-server holds your whole library and loads whichever model a request names.'",
      "            : 'One model at a time, chosen on the Dashboard.',",
      '        },',
      '        h(comp.Select, {',
      "          value: form.mode, onChange: function (v) { set('mode', v) },",
      '          options: [',
      "            { value: 'single', label: 'Single model — pick one and start it' },",
      "            { value: 'router', label: 'Router — serve every model, load on demand' },",
      '          ],',
      '        })),',
      "        form.mode === 'router'",
      '          ? h(comp.Field, {',
      "            label: 'Models loaded at once', flag: '--models-max',",
      "            hint: 'Each loaded model keeps its weights in memory. 0 = no limit.',",
      '          },',
      '          h(comp.NumberInput, {',
      '            value: form.routerModelsMax, min: 0, max: 16,',
      "            onChange: function (v) { set('routerModelsMax', v) },",
      '          }))',
      '          : null,',
      "        form.mode === 'router'",
      '          ? h(comp.SwitchRow, {',
      "            label: 'Load on demand', flag: '--models-autoload', value: form.routerAutoload,",
      "            hint: 'Load a model the first time a request asks for it. Off means it only'",
      "              + ' loads when you load it from the Dashboard.',",
      "            onChange: function (v) { set('routerAutoload', v) },",
      '          })',
      '          : null,',
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
    ].join('\n'),
  },
  {
    module: 'server-config.js',
    name: 'server-flags-single-card',
    why: 'combine Network and Server flags into a single card in two columns',
    present: "title: 'Network & server flags'",
    find: [
      "      h('div', { className: 'llama-cols-2' },",
      "        h(comp.Card, { title: 'Network', subtitle: 'where llama-server listens' },",
      '          h(comp.Fields, null,',
      "            h(comp.Field, { label: 'Bind host', flag: '--host' },",
      '              h(comp.Select, {',
      "                value: form.host, onChange: function (v) { set('host', v) },",
      '                options: [',
      "                  { value: '127.0.0.1', label: '127.0.0.1 — localhost only (recommended)' },",
      "                  { value: 'localhost', label: 'localhost' },",
      "                  { value: '0.0.0.0', label: '0.0.0.0 — all interfaces (LAN)' },",
      '                ],',
      '              })),',
      "            h(comp.Field, { label: 'Port', flag: '--port' },",
      "              h(comp.NumberInput, { value: form.port, min: 1024, max: 65535, onChange: function (v) { set('port', v) } }))),",
      '          exposed',
      "            ? h(comp.Notice, { tone: 'warn', style: { marginTop: 12 } },",
      "              'Binding 0.0.0.0 exposes the API — and every loaded model — to your whole network. '",
      "              + 'Set an API key below, or keep it on localhost and reach it through a tunnel.')",
      '            : null),',
      '',
      "        h(comp.Card, { title: 'Server flags', subtitle: 'apply to every model' },",
      '          h(comp.Fields, null,',
      "            h(comp.Field, { label: 'Parallel slots', flag: '-np', hint: 'Concurrent requests the server can hold.' },",
      "              h(comp.NumberInput, { value: form.parallel, min: 1, max: 16, onChange: function (v) { set('parallel', v) } })),",
      "            h(comp.Field, { label: 'Prompt cache reuse', flag: '--cache-reuse', hint: 'Token chunk size reused across requests. 0 disables.' },",
      "              h(comp.NumberInput, { value: form.cacheReuse, min: 0, step: 32, onChange: function (v) { set('cacheReuse', v) } })),",
      "            h(comp.Field, { label: 'HTTP threads', flag: '--threads-http', hint: 'Empty = llama-server default.' },",
      "              h(comp.NumberInput, { value: form.threadsHttp, min: 1, max: 64, placeholder: 'auto', onChange: function (v) { set('threadsHttp', v) } }))),",
      "          h('div', { style: { marginTop: 4 } },",
      '            h(comp.SwitchRow, {',
      "              label: 'Continuous batching', flag: '--cont-batching', value: form.contBatching,",
      "              hint: 'Interleaves concurrent requests instead of serialising them.',",
      "              onChange: function (v) { set('contBatching', v) },",
      '            }),',
      '            h(comp.SwitchRow, {',
      "              label: 'Prometheus metrics', flag: '--metrics', value: form.metrics,",
      "              hint: 'Feeds the throughput and KV-cache tiles on the Dashboard.',",
      "              onChange: function (v) { set('metrics', v) },",
      '            }),',
      '            h(comp.SwitchRow, {',
      "              label: 'Built-in web UI', flag: '--no-webui', value: form.webui,",
      "              hint: 'llama.cpp’s own chat page at the endpoint root. Turn off for an API-only server.',",
      "              onChange: function (v) { set('webui', v) },",
      '            }))))',
    ].join('\n'),
    replace: [
      '      h(comp.Card, {',
      "        title: 'Network & server flags',",
      "        subtitle: 'where llama-server listens, and flags that apply to every model',",
      '      },',
      "      h('div', { className: 'llama-cols-2' },",
      "        h(comp.Field, { label: 'Bind host', flag: '--host' },",
      '          h(comp.Select, {',
      "            value: form.host, onChange: function (v) { set('host', v) },",
      '            options: [',
      "              { value: '127.0.0.1', label: '127.0.0.1 — localhost only (recommended)' },",
      "              { value: 'localhost', label: 'localhost' },",
      "              { value: '0.0.0.0', label: '0.0.0.0 — all interfaces (LAN)' },",
      '            ],',
      '          })),',
      "        h(comp.Field, { label: 'Port', flag: '--port' },",
      "          h(comp.NumberInput, { value: form.port, min: 1024, max: 65535, onChange: function (v) { set('port', v) } })),",
      "        h(comp.Field, { label: 'Parallel slots', flag: '-np', hint: 'Concurrent requests the server can hold.' },",
      "          h(comp.NumberInput, { value: form.parallel, min: 1, max: 16, onChange: function (v) { set('parallel', v) } })),",
      "        h(comp.Field, { label: 'Prompt cache reuse', flag: '--cache-reuse', hint: 'Token chunk size reused across requests. 0 disables.' },",
      "          h(comp.NumberInput, { value: form.cacheReuse, min: 0, step: 32, onChange: function (v) { set('cacheReuse', v) } })),",
      "        h(comp.Field, { label: 'HTTP threads', flag: '--threads-http', hint: 'Empty = llama-server default.' },",
      "          h(comp.NumberInput, { value: form.threadsHttp, min: 1, max: 64, placeholder: 'auto', onChange: function (v) { set('threadsHttp', v) } })),",
      '        h(comp.SwitchRow, {',
      "          label: 'Continuous batching', flag: '--cont-batching', value: form.contBatching,",
      "          hint: 'Interleaves concurrent requests instead of serialising them.',",
      "          onChange: function (v) { set('contBatching', v) },",
      '        }),',
      '        h(comp.SwitchRow, {',
      "          label: 'Prometheus metrics', flag: '--metrics', value: form.metrics,",
      "          hint: 'Feeds the throughput and KV-cache tiles on the Dashboard.',",
      "          onChange: function (v) { set('metrics', v) },",
      '        }),',
      '        h(comp.SwitchRow, {',
      "          label: 'Built-in web UI', flag: '--no-webui', value: form.webui,",
      "          hint: 'llama.cpp’s own chat page at the endpoint root. Turn off for an API-only server.',",
      "          onChange: function (v) { set('webui', v) },",
      '        })),',
      '      exposed',
      "        ? h(comp.Notice, { tone: 'warn', style: { marginTop: 12 } },",
      "          'Binding 0.0.0.0 exposes the API — and every loaded model — to your whole network. '",
      "          + 'Set an API key below, or keep it on localhost and reach it through a tunnel.')",
      '        : null)',
    ].join('\n'),
  },
  {
    module: 'server-config.js',
    name: 'behaviour-single-card',
    why: 'Startup & recovery and Manager defaults were two cards of different '
      + 'heights sitting side by side, so the shorter one trailed empty card; '
      + 'one card in two columns says the same thing without the hole',
    present: "title: 'Startup, recovery & manager defaults'",
    find: [
      "      h('div', { className: 'llama-cfg-band' }, 'Behaviour'),",
      "      h('div', { className: 'llama-cols-2' },",
      "        h(comp.Card, { title: 'Startup & recovery' },",
      '          h(comp.Fields, null,',
      "            h(comp.Field, { label: 'Startup timeout', hint: 'Seconds to wait for /health. Large models need more.' },",
      "              h(comp.NumberInput, { value: form.startupTimeoutSec, min: 5, max: 3600, step: 15, onChange: function (v) { set('startupTimeoutSec', v) } })),",
      "            h(comp.Field, { label: 'Health poll interval', hint: 'Milliseconds between readiness checks.' },",
      "              h(comp.NumberInput, { value: form.healthIntervalMs, min: 100, max: 10000, step: 100, onChange: function (v) { set('healthIntervalMs', v) } })),",
      "            h(comp.Field, { label: 'Metrics poll interval', hint: 'Milliseconds between metric snapshots.' },",
      "              h(comp.NumberInput, { value: form.metricsIntervalMs, min: 500, max: 60000, step: 500, onChange: function (v) { set('metricsIntervalMs', v) } })),",
      "            h(comp.Field, { label: 'Auto GPU-layer attempts', hint: 'Retries with fewer layers after a VRAM failure.' },",
      "              h(comp.NumberInput, { value: form.autoRetryMax, min: 1, max: 6, onChange: function (v) { set('autoRetryMax', v) } })))),",
      '',
      "        h(comp.Card, { title: 'Manager defaults' },",
      '          h(comp.Fields, null,',
      "            h(comp.Field, { label: 'Backend', hint: 'Must match the active build; Auto follows it.' },",
      '              h(comp.Select, {',
      "                value: form.backend, onChange: function (v) { set('backend', v) },",
      "                options: ['auto', 'cpu', 'cuda', 'vulkan', 'hip', 'sycl', 'metal'].map(function (b) {",
      "                  return { value: b, label: b === 'auto' ? 'Auto' : b.toUpperCase() }",
      '                }),',
      '              })),',
      "            h(comp.Field, { label: 'Model import mode' },",
      '              h(comp.Select, {',
      "                value: form.importMode, onChange: function (v) { set('importMode', v) },",
      '                options: [',
      "                  { value: 'copy', label: 'Copy into managed directory' },",
      "                  { value: 'reference', label: 'Reference in place' },",
      '                ],',
      '              }))),',
      "          h('div', { style: { marginTop: 4 } },",
      '            h(comp.SwitchRow, {',
      "              label: 'Check for llama.cpp updates', value: form.autoUpdateCheck,",
      "              hint: 'Queries the GitHub releases API when the manager opens.',",
      "              onChange: function (v) { set('autoUpdateCheck', v) },",
      '            })))),',
    ].join('\n'),
    replace: [
      "      h('div', { className: 'llama-cfg-band' }, 'Behaviour'),",
      '      // One card, two columns, rather than two cards side by side. The two',
      '      // were different heights, so the shorter one left a block of empty',
      '      // card, and the border between them implied a separation that is not',
      '      // there — these are all read together when a server will not start.',
      '      h(comp.Card, {',
      "        title: 'Startup, recovery & manager defaults',",
      "        subtitle: 'how long to wait for a server, and what the manager assumes',",
      '      },',
      "      h('div', { className: 'llama-cols-2' },",
      "        h(comp.Field, { label: 'Startup timeout', hint: 'Seconds to wait for /health. Large models need more.' },",
      "          h(comp.NumberInput, { value: form.startupTimeoutSec, min: 5, max: 3600, step: 15, onChange: function (v) { set('startupTimeoutSec', v) } })),",
      "        h(comp.Field, { label: 'Health poll interval', hint: 'Milliseconds between readiness checks.' },",
      "          h(comp.NumberInput, { value: form.healthIntervalMs, min: 100, max: 10000, step: 100, onChange: function (v) { set('healthIntervalMs', v) } })),",
      "        h(comp.Field, { label: 'Metrics poll interval', hint: 'Milliseconds between metric snapshots.' },",
      "          h(comp.NumberInput, { value: form.metricsIntervalMs, min: 500, max: 60000, step: 500, onChange: function (v) { set('metricsIntervalMs', v) } })),",
      "        h(comp.Field, { label: 'Auto GPU-layer attempts', hint: 'Retries with fewer layers after a VRAM failure.' },",
      "          h(comp.NumberInput, { value: form.autoRetryMax, min: 1, max: 6, onChange: function (v) { set('autoRetryMax', v) } })),",
      "        h(comp.Field, { label: 'Backend', hint: 'Must match the active build; Auto follows it.' },",
      '          h(comp.Select, {',
      "            value: form.backend, onChange: function (v) { set('backend', v) },",
      "            options: ['auto', 'cpu', 'cuda', 'vulkan', 'hip', 'sycl', 'metal'].map(function (b) {",
      "              return { value: b, label: b === 'auto' ? 'Auto' : b.toUpperCase() }",
      '            }),',
      '          })),',
      "        h(comp.Field, { label: 'Model import mode', hint: 'Copy takes the file into the managed folder; Reference leaves it where it is.' },",
      '          h(comp.Select, {',
      "            value: form.importMode, onChange: function (v) { set('importMode', v) },",
      '            options: [',
      "              { value: 'copy', label: 'Copy into managed directory' },",
      "              { value: 'reference', label: 'Reference in place' },",
      '            ],',
      '          })),',
      '        h(comp.SwitchRow, {',
      "          label: 'Check for llama.cpp updates', value: form.autoUpdateCheck,",
      "          hint: 'Queries the GitHub releases API when the manager opens.',",
      "          onChange: function (v) { set('autoUpdateCheck', v) },",
      '        }))),',
    ].join('\n'),
  },
  {
    module: 'versions.js',
    name: 'runtime-card-reorganized',
    why: 'the llama.cpp card had an unlabelled backend select in the header next '
      + 'to Check for updates, a "Downloads" field holding a button and a switch, '
      + 'and a bare "CUDA runtime:" label with loose buttons under it. Regrouped: '
      + 'status on top, then what to fetch and where, then the action, then the '
      + 'per-build runtime',
    present: "label: 'CUDA runtime, per installed build'",
    find: [
      "        h('div', { className: 'llama-row', style: { justifyContent: 'space-between' } },",
      "          h('div', null,",
      "            h('div', { className: 'llama-row' },",
      '              active',
      "                ? h(comp.Pill, { tone: 'ok' }, 'active ' + active.version)",
      "                : h(comp.Pill, { tone: 'warn' }, 'not installed'),",
      "              active ? h(comp.Tag, null, String(active.backend || 'cpu').toUpperCase() + (active.cudaVersion ? ' ' + active.cudaVersion : '')) : null,",
      "              hw.recommendedBackend ? h(comp.Tag, { title: 'Detected hardware preference' }, 'hardware: ' + hw.recommendedBackend) : null,",
      "              latestSummary && latestSummary.updateAvailable ? h(comp.Pill, { tone: 'accent' }, 'update available') : null),",
      '            active',
      "              ? h('div', { style: { marginTop: 6 } },",
      '                h(comp.PathDisplay, { path: active.path, reveal: props.reveal }))',
      "              : h('div', { className: 'llama-hint', style: { marginTop: 6 } },",
      "                'Install an official build — the plugin picks the asset that matches this machine.')),",
      '',
      "          h('div', { className: 'llama-row', style: { flexWrap: 'nowrap' } },",
      '            h(comp.Select, {',
      '              value: backend, onChange: setBackend, options: BACKENDS, style: { width: 150 },',
      '            }),',
      '            h(comp.Button, {',
      "              variant: 'ghost', busy: props.busy === 'versions.latest',",
      '              onClick: async function () {',
      "                const r = await props.call('versions.latest', { backend: backend })",
      '                setCheck(r)',
      '                props.refresh()',
      '              },',
      "            }, 'Check for updates'))),",
      '',
      '        // ---------- downloads ----------',
      "        h('div', { className: 'llama-fields', style: { marginTop: 14 } },",
      '          h(comp.Field, {',
      "            label: 'Install location',",
      "            hint: 'Each build lands in <folder>/<build>. Defaults to the managed bin folder.',",
      '          },',
      '          h(comp.PathInput, {',
      "            kind: 'folder', value: installDir, onChange: setInstallDir,",
      "            title: 'Select llama.cpp Install Folder',",
      '            pick: props.pick, reveal: props.reveal,',
      '          })),',
      '          h(comp.Field, {',
      "            label: 'Downloads',",
      '            hint: withRuntime',
      "              ? 'The CUDA runtime (~370 MB) is fetched with the engine — a CUDA build cannot use the GPU without it.'",
      "              : 'Engine only. Install the CUDA runtime separately below.',",
      '          },',
      "          h('div', { className: 'llama-row' },",
      '            h(comp.Button, {',
      "              variant: 'primary', busy: installing,",
      '              onClick: function () {',
      "                props.start('versions.install', {",
      '                  backend: backend,',
      '                  skipCudaRuntime: !withRuntime,',
      '                  targetDir: installDir || undefined,',
      "                }, 'llama.cpp installed')",
      '              },',
      "            }, 'Download engine'),",
      '            h(comp.Switch, {',
      "              value: withRuntime, onChange: setWithRuntime, label: '+ CUDA runtime',",
      '            })))),',
      '',
      '        versions.length > 0',
      "          ? h('div', { className: 'llama-row', style: { marginTop: 10 } },",
      "            h('span', { className: 'llama-hint' }, 'CUDA runtime:'),",
      '            versions.map(function (v) {',
      '              const has = v.gpuRuntimeOk === true',
      '              return h(comp.Button, {',
      "                key: 'rt-' + v.version, size: 'sm',",
      "                variant: has ? 'ghost' : 'primary',",
      '                busy: repairing && runtimeFor === v.version,',
      "                disabled: v.backend !== 'cuda' || repairing,",
      "                title: v.backend !== 'cuda'",
      "                  ? 'Only CUDA builds need the CUDA runtime'",
      "                  : (has ? 'Already installed — click to re-download' : 'Download and install the CUDA runtime for this build'),",
      '                onClick: function () {',
      '                  setRuntimeFor(v.version)',
      "                  props.start('versions.installRuntime', { version: v.version }, 'CUDA runtime installed for ' + v.version)",
      '                },',
      "              }, (has ? '↻ ' : '↓ ') + v.version)",
      '            }))',
      '          : null,',
    ].join('\n'),
    replace: [
      "        h('div', { className: 'llama-row', style: { justifyContent: 'space-between' } },",
      "          h('div', null,",
      "            h('div', { className: 'llama-row' },",
      '              active',
      "                ? h(comp.Pill, { tone: 'ok' }, 'active ' + active.version)",
      "                : h(comp.Pill, { tone: 'warn' }, 'not installed'),",
      "              active ? h(comp.Tag, null, String(active.backend || 'cpu').toUpperCase() + (active.cudaVersion ? ' ' + active.cudaVersion : '')) : null,",
      "              hw.recommendedBackend ? h(comp.Tag, { title: 'Detected hardware preference' }, 'hardware: ' + hw.recommendedBackend) : null,",
      "              latestSummary && latestSummary.updateAvailable ? h(comp.Pill, { tone: 'accent' }, 'update available') : null),",
      '            active',
      "              ? h('div', { style: { marginTop: 6 } },",
      '                h(comp.PathDisplay, { path: active.path, reveal: props.reveal }))',
      "              : h('div', { className: 'llama-hint', style: { marginTop: 6 } },",
      "                'Install an official build — the plugin picks the asset that matches this machine.')),",
      '',
      '          h(comp.Button, {',
      "            variant: 'ghost', busy: props.busy === 'versions.latest',",
      '            onClick: async function () {',
      "              const r = await props.call('versions.latest', { backend: backend })",
      '              setCheck(r)',
      '              props.refresh()',
      '            },',
      "          }, 'Check for updates')),",
      '',
      '        // ---------- install a build ----------',
      '        //',
      '        // What to fetch, then where it goes, then the button that does it.',
      '        // The backend select used to sit unlabelled in the header next to',
      '        // "Check for updates", where nothing said what it chose — and it is',
      '        // what the download button acts on, so it belongs here.',
      "        h('div', { className: 'llama-cols-2', style: { marginTop: 16 } },",
      '          h(comp.Field, {',
      "            label: 'Backend',",
      '            hint: hw.recommendedBackend',
      "              ? 'Which build to download. Auto follows the detected hardware (' + hw.recommendedBackend + ').'",
      "              : 'Which build to download. Auto follows the detected hardware.',",
      '          },',
      '          h(comp.Select, { value: backend, onChange: setBackend, options: BACKENDS })),',
      '          h(comp.Field, {',
      "            label: 'Install location',",
      "            hint: 'Each build lands in <folder>/<build>. Defaults to the managed bin folder.',",
      '          },',
      '          h(comp.PathInput, {',
      "            kind: 'folder', value: installDir, onChange: setInstallDir,",
      "            title: 'Select llama.cpp Install Folder',",
      '            pick: props.pick, reveal: props.reveal,',
      '          }))),',
      '',
      "        h('div', { className: 'llama-row', style: { marginTop: 12 } },",
      '          h(comp.Button, {',
      "            variant: 'primary', busy: installing,",
      '            onClick: function () {',
      "              props.start('versions.install', {",
      '                backend: backend,',
      '                skipCudaRuntime: !withRuntime,',
      '                targetDir: installDir || undefined,',
      "              }, 'llama.cpp installed')",
      '            },',
      "          }, 'Download engine'),",
      '          h(comp.Switch, {',
      "            value: withRuntime, onChange: setWithRuntime, label: 'Include the CUDA runtime',",
      '          })),',
      "        h('div', { className: 'llama-hint', style: { marginTop: 6 } },",
      '          withRuntime',
      "            ? 'The CUDA runtime (~370 MB) is fetched with the engine — a CUDA build cannot use the GPU without it.'",
      "            : 'Engine only. A CUDA build needs the runtime added below before it can use the GPU.'),",
      '',
      '        versions.length > 0',
      '          ? h(comp.Field, {',
      "            label: 'CUDA runtime, per installed build',",
      "            hint: '↓ is missing and will be fetched; ↻ is already there and will be replaced.',",
      '            style: { marginTop: 16 },',
      '          },',
      "          h('div', { className: 'llama-row' },",
      '            versions.map(function (v) {',
      '              const has = v.gpuRuntimeOk === true',
      '              return h(comp.Button, {',
      "                key: 'rt-' + v.version, size: 'sm',",
      "                variant: has ? 'ghost' : 'primary',",
      '                busy: repairing && runtimeFor === v.version,',
      "                disabled: v.backend !== 'cuda' || repairing,",
      "                title: v.backend !== 'cuda'",
      "                  ? 'Only CUDA builds need the CUDA runtime'",
      "                  : (has ? 'Already installed — click to re-download' : 'Download and install the CUDA runtime for this build'),",
      '                onClick: function () {',
      '                  setRuntimeFor(v.version)',
      "                  props.start('versions.installRuntime', { version: v.version }, 'CUDA runtime installed for ' + v.version)",
      '                },',
      "              }, (has ? '↻ ' : '↓ ') + v.version)",
      '            })))',
      '          : null,',
    ].join('\n'),
  },
  {
    module: 'ui-core.js',
    name: 'toast-warnings',
    why: 'a command could succeed with a warning — most often that the change was saved but the running server did not pick it up — and act/start read only `ok`, so the user saw a plain success for a change that had not taken effect',
    present: 'toastWarnings',
    find: [
      "    const toastOk = React.useCallback(function (text) { pushToast('ok', text) }, [pushToast])",
      "    const toastErr = React.useCallback(function (text) { pushToast('err', text) }, [pushToast])",
    ].join('\n'),
    replace: [
      "    const toastOk = React.useCallback(function (text) { pushToast('ok', text) }, [pushToast])",
      "    const toastErr = React.useCallback(function (text) { pushToast('err', text) }, [pushToast])",
      "    const toastWarn = React.useCallback(function (text) { pushToast('warn', text) }, [pushToast])",
      '',
      '    // A command can succeed and still have something to say — most often that',
      '    // the change was saved but the running server did not pick it up. Both act',
      '    // and start used to read only `ok`, so those went nowhere and the user saw',
      '    // a plain green success for a change that had not taken effect.',
      '    const toastWarnings = React.useCallback(function (r) {',
      '      const list = (r && r.warnings) || []',
      '      for (let i = 0; i < list.length; i += 1) toastWarn(String(list[i]))',
      '    }, [toastWarn])',
    ].join('\n'),
  },
  {
    module: 'ui-core.js',
    name: 'act-reports-warnings',
    why: 'as above, on the foreground path; and a second action while one is running returned silently, so every other button looked live and did nothing',
    present: 'Still running ',
    find: [
      '    const act = React.useCallback(async function (name, args, okText) {',
      '      if (busy !== undefined) return undefined',
      '      setBusy(name)',
      '      try {',
      '        const r = await C.call(name, args)',
      '        if (r && r.ok) {',
      '          if (okText) toastOk(okText)',
      '          await refresh()',
      '        } else if (r) {',
    ].join('\n'),
    replace: [
      '    const act = React.useCallback(async function (name, args, okText) {',
      '      if (busy !== undefined) {',
      '        // One at a time: two of these can race on the same config file. It',
      '        // used to return silently, so every other button in the app looked',
      '        // live and did nothing for as long as anything was running.',
      "        toastWarn('Still running ' + busy + '. Wait for it to finish.')",
      '        return undefined',
      '      }',
      '      setBusy(name)',
      '      try {',
      '        const r = await C.call(name, args)',
      '        if (r && r.ok) {',
      '          if (okText) toastOk(okText)',
      '          toastWarnings(r)',
      '          await refresh()',
      '        } else if (r) {',
    ].join('\n'),
  },
  {
    module: 'ui-core.js',
    name: 'act-warning-deps',
    why: 'the new callbacks belong in the dependency list',
    present: 'toastWarn, toastWarnings]',
    find: [
      '      } finally {',
      '        setBusy(undefined)',
      '      }',
      '    }, [busy, toastOk, toastErr])',
    ].join('\n'),
    replace: [
      '      } finally {',
      '        setBusy(undefined)',
      '      }',
      '    }, [busy, toastOk, toastErr, toastWarn, toastWarnings])',
    ].join('\n'),
  },
  {
    module: 'ui-core.js',
    name: 'start-reports-warnings',
    why: 'as above, on the background path',
    present: 'toastWarnings(res)',
    find: [
      '      C.call(name, args).then(function (res) {',
      '        if (res && res.ok) {',
      '          if (okText) toastOk(okText)',
      '        } else if (res) {',
    ].join('\n'),
    replace: [
      '      C.call(name, args).then(function (res) {',
      '        if (res && res.ok) {',
      '          if (okText) toastOk(okText)',
      '          toastWarnings(res)',
      '        } else if (res) {',
    ].join('\n'),
  },
  {
    module: 'ui-core.js',
    name: 'start-warning-deps',
    why: 'the new callback belongs in the dependency list',
    present: 'toastErr, toastWarnings]',
    find: [
      '          return next',
      '        })',
      '        refresh()',
      '      })',
      '    }, [toastOk, toastErr])',
    ].join('\n'),
    replace: [
      '          return next',
      '        })',
      '        refresh()',
      '      })',
      '    }, [toastOk, toastErr, toastWarnings])',
    ].join('\n'),
  },
  {
    module: SHELL,
    name: 'toast-warn-tone',
    why: 'the warn toast had no style of its own, so it read as an ordinary message',
    present: "llama-toast[data-tone='warn']",
    find: [
      ".llama-toast[data-tone='err'] { border-left: 3px solid var(--lc-err); }",
    ].join('\n'),
    replace: [
      ".llama-toast[data-tone='err'] { border-left: 3px solid var(--lc-err); }",
      ".llama-toast[data-tone='warn'] { border-left: 3px solid var(--lc-warn); }",
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

  // The wrapper is two pieces, one either side of the module map; a shell
  // patch is looked for in both rather than having to say which.
  const shell = { before, after }

  for (const patch of PATCHES) {
    const where = patch.module === SHELL
      ? ['before', 'after'].filter(function (k) { return shell[k].indexOf(patch.present) !== -1 })
      : undefined

    if (patch.module === SHELL) {
      if (where.length > 0) {
        already.push(patch.name)
        continue
      }
      const at = ['before', 'after'].find(function (k) { return shell[k].indexOf(patch.find) !== -1 })
      if (at === undefined) {
        failed.push(patch.name + ': the code it patches is not in the bundle shell'
          + ' (upstream changed it — re-check the patch)')
        continue
      }
      shell[at] = shell[at].replace(patch.find, patch.replace)
      applied.push(patch.name)
      continue
    }

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
  fs.writeFileSync(BUNDLED_UI, shell.before + JSON.stringify(modules) + shell.after)
  console.log('\nwrote ' + BUNDLED_UI)
  return 0
}

process.exit(main())
