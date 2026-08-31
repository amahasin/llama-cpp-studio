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
| `app-mark` | the sidebar glyph is the llama mark, not a generic layers icon | it had nothing to do with llama.cpp |
| `idle-unload-stamp` / `-form` / `-save` / `-field` | Server Config gains an "Unload an idle model after" control | without it the timeout is only reachable by editing config.json |
| `download-rate-units` / `install-rate-units` | download speed is formatted with `fmtBytes(...) + '/s'` | it used `fmtRate`, the tokens/second formatter, so a 6 MB/s download read "6465214.8 tok/s" |
| `mtp-pill` / `mtp-pill-render` | model cards carry an `mtp` tag | the library gave no sign which models ship a head |
| `mtp-form` / `mtp-save` / `mtp-switch` | Model settings gains a Speculative decoding switch | otherwise MTP cannot be turned off for a model |
| `loading-elapsed` | a loading model shows a percentage, falling back to elapsed time | a bare "loading" pill on a 20GB model is minutes with no sign of life |

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
3. `npm run patch-ui` for the UI bundle.
4. `npm test` — `bundle.test.js` is the one that notices a missing UI patch.
