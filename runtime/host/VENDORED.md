# Vendored code — read this before editing anything in `runtime/`

Everything in `runtime/host/` and `runtime/client.bundle.js` is **copied in from
another repository**. It is not maintained here.

| Path | Source | Copied by |
|---|---|---|
| `runtime/host/**` | the DeepSeek Harness `llama_cpp` plugin, `src/host/**` | `pack.js` → `selfContain()` |
| `runtime/client.bundle.js` | the same plugin, `dist/client.bundle.js` | `pack.js`, built by `build.js` |
| `web/vendor/react*.js` | React 18 UMD builds (MIT, © Meta Platforms) | `build.js` → `vendorReact()` |

`pack.js` does `fs.rmSync(runtime/host)` and re-copies the whole directory. **Any
change made here is destroyed the next time somebody packs the app where the
plugin sources live.**

## Provenance

> **Unrecorded.** The plugin repository was not present on the machine where
> this file was written (`pack.js` expects it one level up, at `../src/host/`),
> so the upstream URL and revision of the current copy are unknown.
>
> Whoever next packs from the plugin sources should fill in the URL and commit
> hash below, and keep them current. Without it there is no way to tell what
> this copy is, whether it is behind, or what an update would change.

```
upstream:  <repository URL>
revision:  <commit hash>
copied:    <date>
```

## Local modifications

The following changes were made **here**, not upstream, and will be lost on the
next pack unless they are upstreamed first. They exist because the plugin
repository was unavailable.

| File | Change | Why |
|---|---|---|
| `modules/api.js` | `_safeSettings()` redacts `server.apiKey` and `llamaCpp.githubToken`, `_stripRedactedSecrets()` restores an unchanged one, `settings.update`'s echoed config is redacted | the raw config rode on every `status` poll to the browser and to the `llama_status` tool |
| `modules/api.js` | `_latest()` caches failures and keys the cache by backend | a rate-limited GitHub was re-asked on every poll, spending an allowance that was already gone |
| `modules/api.js` | `_status()` only reads `latestVersion` from a **successful** cache | a cached failure has no `.latest` to read |
| `modules/api.js` | `_testChat` sends the API key through `pushSecretHeaders` | it was on curl's command line, readable by any local process |
| `modules/exec.js` | new `pushSecretHeaders()` / `_secretHeaderArgs()`; `secretHeaders` option on `_curlGet` and `httpPostJson` | as above — a curl config file instead of `-H` on the argv |
| `modules/server.js` | new `_apiKeyFile()`; router and single-model launches prefer `--api-key-file`; `apiKeyFile` stripped from router child profiles | `--api-key` put the key on a long-lived command line |
| `modules/server.js` | router health/model calls pass `secretHeaders` | as above |
| `modules/commandBuilder.js` | `api-key-file` option def, preferred over `api-key` when the build advertises it | as above |
| `modules/security.js` | `validateHttpUrl` actually validates the host | the branch that was meant to had an **empty body**, so every host shape passed |
| `modules/config.js` | new `llamaCpp.githubToken`, normalized like the other optional strings | 60 unauthenticated GitHub requests/hour is a recurring failure |
| `modules/github.js` | sends `Authorization` when a token is set; remediation text distinguishes the two cases | as above |
| `modules/config.js` | new `server.idleUnloadMinutes` (default 30, clamped 0-1440) | a loaded model held VRAM indefinitely; the supervisor that acts on it is `src/idle.js`, which is this app's own code |
| `modules/models.js` | `MTP_RE`, `MTP_SUBDIRS`, `detectMtp()`, `_attachMtp()`, `companionKind()`; `mtpPath` detected on import/download/rescan and rebased with the folder; `mtp` flag on the Hugging Face listing | multi-token-prediction heads ship beside the model and had no support at all |
| `modules/server.js` | `_resolveMtp()` on both launch paths, setting `profile.draftModel` and `profile.specType` | so the head reaches llama.cpp — `--spec-type` defaults to `none`, so a draft model alone does nothing |
| `modules/gguf.js` | keeps `*.nextn_predict_layers`, counts `*.nextn.*` tensors, reports `nextnPredictLayers` and `hasMtp` from both summarizers | Qwen3.6 carries its MTP head inside the model file, so there is no companion to detect |
| `modules/exec.js` | the streaming GGUF scanner keeps the same key and counts the same tensors | the header-window parser is not used for every model |
| `modules/commandBuilder.js` | `spec-type` option def, emitted from `profile.specType` | the flag that actually enables speculative decoding |
| `modules/server.js` | `_followProgress()` / `_applyProgress()` / `_progressFor()` / `_stopProgress()`, subscribing to the router's `/models/sse`; `routerModels()` reports `loadPercent`, `loadStage` and `workingSeconds` | llama.cpp streams a real 0-1 load fraction, but only over SSE — polling `/models` never sees it. Elapsed seconds remain the fallback for single-model mode and older builds |
| `modules/commandBuilder.js` | `spec-draft-model` option def, emitted from `profile.draftModel` | the flag llama.cpp takes an MTP head through |
| `modules/profiles.js` | `mtpPath` and `mtp` profile fields | the per-model switch has to persist |
| `modules/api.js` | `models.detectMtp` command | mirrors `models.detectMmproj` |
| `modules/api.js` | `settings.reveal` command, returning one named secret in the clear | the UI cannot show or copy a key it only ever receives redacted; deliberately narrow, and not wired to any agent tool |
| `modules/api.js` | `_afterLibraryChange()` wraps saveSettings / resetSettings / addFlag / import / delete | a running router never re-read its preset, so changed launch flags did nothing until a restart |
| `modules/server.js` | `refreshRouterPreset()`, and `_planRouter` accepts `forceWritePreset` so it can write without claiming the port | rewrites the preset and calls `GET /models?reload=1` |
| `modules/logs.js` | `ROUTINE_ROUTER_NOISE`; `_append()` drops the router's per-request trace and counts it, `_push()` carries the old body, one summary line every 250 | in router mode llama.cpp logs "proxying request to model X on port N" for every forwarded request, and this app polls two model-scoped endpoints every two seconds — one line a second, 80% of the log, and the 6000-line ring lost every real error inside two hours |
| `modules/api.js` | `CHANGES_LIBRARY` / `CHANGES_BUILDS` tables and `_afterChange()`, applied once in `cmd()`; the per-case `_afterLibraryChange(...)` calls removed | the calls were sprinkled through the dispatcher and three commands had been missed: a downloaded model never reached the running router's preset, nor did a rescan that attached an MTP head |
| `modules/api.js` | `_afterBuildChange()` clears the cached update check, and warns when a build is activated while a server runs on a different one | installing an update left "update available" up for the rest of the 5-minute cache window, and activating a build silently did nothing to the running server |
| `modules/api.js` | `_progress()` throttles `[install]` lines the way it already throttled `[download]` | the install emitter ticks once a second, so one engine install wrote hundreds of identical "Downloading the CUDA runtime" lines |
| `modules/models.js` | `kindFromMetadata()` separates a head from a model by layer count (`blockCount === nextnPredictLayers` is a head, anything with a body is a model); `MTP_RE` anchored to the `mtp-` prefix with `looksLikeMtpFile()` also honouring an `MTP/` folder; `companionKind()` reads the inspected GGUF before the filename; `rescan()` clears a companion label the file contradicts | classification was by name alone, so `Ornith-1.5-35B-A3B-APEX-MTP-I-Compact.gguf` — a 17GB model — was filed as an MTP head and vanished from the library. The first fix asked whether the file carried a tokenizer, which gemma-4's head disproves: it ships a full `gemma4` tokenizer, so it was filed as a model, listed in the library, and stopped drafting for the model it belongs to |
| `modules/commandBuilder.js` | `build()` warns when the argv carries `--spec-type draft-mtp` with no `--spec-draft-model` and no head built into the model | llama.cpp accepts that combination and simply generates at the ordinary speed, so a model configured for MTP that was not using it looked identical to one that was |

Nothing in `runtime/host/**` was changed for the mobile layout, the app icon or
the chat fixes — those live in `web/`, `src/http/` and the bundle patches below.

### The UI bundle

`runtime/client.bundle.js` is a build artifact, so it is not hand-edited. The
changes below live as data in `tools/patch-client-bundle.js` and are re-applied
with:

```
npm run patch-ui
```

| Patch | Change | Why |
|---|---|---|
| `chat-iframe-same-origin` | the chat `<iframe>` loads `/llama/` instead of llama-server's own address, and carries `allow="clipboard-write; clipboard-read"` | `127.0.0.1:8080` in a phone's browser is the *phone*, so the chat was blank on every remote device; and a cross-origin frame gets no clipboard, so llama.cpp's copy buttons silently did nothing |
| `chat-open-in-new-tab` | "Open in new tab" opens `/llama/` too | same unreachable address |
| `chat-frame-follows-loaded-model` / `chat-reload-repins-model` | the frame opens at `/llama/?model=<the loaded model>`, pinned at mount and re-pinned by the reload button | llama.cpp's chat picks its own model — the one that answered last in the conversation, else the first in the list — and its selector shortens the name, so with one model resident at a time the model you loaded was quietly evicted by one that looked identical |
| `app-mark` | the sidebar glyph is the llama mark, not a generic layers icon | it had nothing to do with llama.cpp |
| `idle-unload-stamp` / `-form` / `-save` / `-field` | Server Config gains an "Unload an idle model after" control | without it the timeout is only reachable by editing config.json |
| `download-rate-units` / `install-rate-units` | download speed is formatted with `fmtBytes(...) + '/s'` | it used `fmtRate`, the tokens/second formatter, so a 6 MB/s download read "6465214.8 tok/s" |
| `mtp-pill` / `mtp-pill-render` | model cards carry an `mtp` tag | the library gave no sign which models ship a head |
| `mtp-form` / `mtp-save` / `mtp-switch` | Model settings gains a Speculative decoding switch | otherwise MTP cannot be turned off for a model |
| `loading-elapsed` | a loading model shows a percentage, falling back to elapsed time | a bare "loading" pill on a 20GB model is minutes with no sign of life |
| `copy-fallback` | `copyText` falls back to a hidden textarea | `navigator.clipboard` does not exist on a non-secure origin, so every Copy button was dead when the app was reached over plain http on a LAN address |
| `eye-icons` | `eye` / `eye-off` added to the icon set | a secret field needs a show/hide control |
| `access-single-column` / `tls-single-column` | Access & Remote Access is one field per row | four fields across a row left each about 190px, too narrow for URLs and origin lists |
| `api-key-controls` / `api-key-state` | the API key field gains show/hide and copy, fetching the real key through `settings.reveal` | the field only ever held the redacted placeholder |
| `behaviour-single-card` | Startup & recovery and Manager defaults become one card in two columns | two cards of different heights side by side left the shorter one trailing empty card, and the border between them implied a separation that is not there — they are read together when a server will not start |
| `runtime-card-reorganized` | the llama.cpp build card is regrouped: status and Check for updates on top, then Backend and Install location as labelled columns, then the download button with its switch, then the per-build CUDA runtime | the backend select sat unlabelled in the header beside Check for updates, so nothing said what it chose or that the download button acted on it; a field labelled "Downloads" held a button and a switch; and a bare "CUDA runtime:" label trailed loose buttons |
| `toast-warnings` / `act-reports-warnings` / `start-reports-warnings` (+ their dependency-list patches) | a successful result's `warnings` are shown as warn toasts | `act` and `start` read only `ok`, so a save that succeeded while the running server ignored it showed a plain green success |
| `act-reports-warnings` | a second action while one is running says so instead of returning silently | actions are serialised, but nothing told you — every other button in the app looked live and did nothing until the first finished |
| `toast-warn-tone` (shell) | `.llama-toast[data-tone='warn']` | the new tone had no style, so a warning read as an ordinary message |
| `api-key-generate-fn` / `api-key-generate-button` | a Generate button beside show and copy, filling the field with 32 bytes of `crypto.getRandomValues` as base64url | the card could show and copy a key but not produce one, so it had to be invented by hand — and a hand-invented key is a short one. The toast says a running server keeps the key it launched with, because `--api-key-file` is read once at startup |

The first two depend on the reverse proxy in `src/http/proxy.js`, and the last
four are the front end for `src/idle.js` — both this app's own code, unaffected
by a re-pack. Losing the UI patches costs the control, not the behaviour: the
timeout still applies, it just cannot be changed from the settings page.

### The safety net

`tests/units.test.js`, `tests/secrets.test.js` and `tests/proxy.test.js` cover
the host-module and proxy changes; `tests/bundle.test.js` runs
`tools/patch-client-bundle.js --check` and fails when the shipped bundle has
lost a patch. So a re-pack that silently reverts any of this fails the suite
rather than passing quietly. That is the safety net; it is not a substitute for
upstreaming.

## Updating this copy

1. Record the upstream URL and revision above.
2. Re-apply (or upstream) every row in the host-module table.
3. `npm run patch-ui` for the UI bundle. Each patch's `find` must match the bundle a
   re-pack restores, not the patched one in your tree — `bundle.test.js` rebuilds from
   the pristine copy and requires a byte-identical result, which is what catches this.
4. `npm test` — `bundle.test.js` is the one that notices a missing UI patch.
