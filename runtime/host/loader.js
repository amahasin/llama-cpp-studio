// loader.js — the HOST package body inlined into the dynamic Cordis plugin.
// It is intentionally thin and stable: it resolves the plugin's source
// directory inside the workspace, loads the plain-JavaScript modules from
// disk (they attach to the LLAMA namespace), builds the Manager and registers
// the llama_* model tools plus the Client RPC handlers. All business logic
// lives in the module files next to this one, so fixes iterate without
// re-defining this package.
'use strict'

const HOST_MODULES = [
  'boot.js',
  'modules/util.js',
  'modules/security.js',
  'modules/gguf.js',
  'modules/assetSelector.js',
  'modules/commandBuilder.js',
  'modules/config.js',
  'modules/exec.js',
  'modules/github.js',
  'modules/versions.js',
  'modules/hardware.js',
  'modules/logs.js',
  'modules/models.js',
  'modules/profiles.js',
  'modules/server.js',
  'modules/monitoring.js',
  'modules/diagnostics.js',
  'modules/discovery.js',
  'modules/api.js',
]

function joinP(a, b) {
  const sep = '/'
  const na = String(a).replace(/\\/g, sep).replace(/\/+$/, '')
  const nb = String(b).replace(/\\/g, sep).replace(/^\/+/, '')
  return na + sep + nb
}

const HOST_TOOL_DEFS = [
  { name: 'llama_status', description: 'Get the complete llama.cpp manager status: server state, endpoint, installed versions, registered models, hardware, downloads and progress.', parameters: {} },
  { name: 'llama_diagnostics', description: 'Run the llama.cpp environment diagnostics checklist (OS, CPU, RAM, GPU, driver, installed builds, model files, port, server API) with remediation steps for every failure.', parameters: {} },
  { name: 'llama_list_versions', description: 'List installed llama.cpp versions and the active one.', parameters: {} },
  { name: 'llama_latest_version', description: 'Check the latest llama.cpp GitHub release and which release asset fits this machine for a backend ("auto", "cpu", "cuda", "vulkan").', parameters: { backend: { type: 'string', description: 'Requested backend; defaults to auto.' } } },
  { name: 'llama_install_latest', description: 'Download, verify, extract and install the latest llama.cpp release for the detected hardware. Long-running; returns when done.', parameters: { backend: { type: 'string', description: 'Backend to install: auto, cpu, cuda, vulkan, hip, sycl, metal.' } } },
  { name: 'llama_activate_version', description: 'Make one installed llama.cpp version the active one.', parameters: { version: { type: 'string', description: 'Version tag like b8000.' } } },
  { name: 'llama_remove_version', description: 'Remove an installed llama.cpp version (never the active one unless another exists).', parameters: { version: { type: 'string', description: 'Version tag like b8000.' } } },
  { name: 'llama_repair_gpu_runtime', description: 'Install the CUDA runtime companion (cudart/cublas) for an installed CUDA build and re-check the compute devices. Use when a CUDA build reports no GPU devices and llama-server runs on the CPU.', parameters: { version: { type: 'string', description: 'Installed version tag, e.g. b10472.' } } },
  { name: 'llama_list_models', description: 'List registered GGUF models with metadata (architecture, quantization, size, location).', parameters: {} },
  { name: 'llama_import_model', description: 'Register an existing local .gguf file: copy it into the managed directory or reference it in place.', parameters: { path: { type: 'string', description: 'Absolute path to the .gguf file.' }, mode: { type: 'string', description: 'copy (default) or reference.' }, name: { type: 'string', description: 'Optional file name for the managed copy.' } } },
  { name: 'llama_list_hf_files', description: 'List .gguf files (with sizes) in a Hugging Face repository like "owner/repo".', parameters: { repo: { type: 'string', description: 'Hugging Face repository id, e.g. Qwen/Qwen2.5-0.5B-Instruct-GGUF.' } } },
  { name: 'llama_download_model', description: 'Download one .gguf file from Hugging Face (resumable, cancellable) and register it.', parameters: { repo: { type: 'string', description: 'Hugging Face repository id.' }, filename: { type: 'string', description: 'Exact file path inside the repository, e.g. qwen2.5-0.5b-instruct-q4_k_m.gguf.' } } },
  { name: 'llama_cancel_download', description: 'Cancel an active model download by task id (partial file is kept for resume).', parameters: { id: { type: 'string', description: 'Download task id.' } } },
  { name: 'llama_inspect_model', description: 'Inspect GGUF metadata: architecture, parameters, quantization, context length, chat template, tokenizer, layer count.', parameters: { id: { type: 'string', description: 'Registered model id.' }, path: { type: 'string', description: 'Or an absolute path to any .gguf file.' } } },
  { name: 'llama_delete_model', description: 'Unregister a model and delete its managed copy when applicable.', parameters: { id: { type: 'string', description: 'Registered model id.' } } },
  { name: 'llama_model_settings', description: 'Read or write a model\'s launch settings (context size, GPU layers, threads, temperature, repeat penalty, flash attention, no-mmap, mlock, n-cpu-moe, KV cache types, batch/ubatch, tool calling, extra CLI args). Omit "settings" to read; pass it to save. These are the flags llama-server is started with for that model.', parameters: { id: { type: 'string', description: 'Registered model id.' }, settings: { type: 'json', description: 'Settings to save, e.g. {"contextSize":8192,"gpuLayers":"auto","cacheTypeK":"q8_0","toolCalling":true,"extraArgs":["--no-perf"]}.' } } },
  { name: 'llama_list_profiles', description: 'List saved model profiles.', parameters: {} },
  { name: 'llama_create_profile', description: 'Create a launch profile for a model (context size, GPU layers, threads, sampling, etc.).', parameters: { model_id: { type: 'string', description: 'Registered model id.' }, profile: { type: 'json', description: 'Profile fields, e.g. {"name":"Fast","contextSize":8192,"gpuLayers":"auto","temperature":0.7}.' } } },
  { name: 'llama_update_profile', description: 'Patch an existing profile.', parameters: { id: { type: 'string', description: 'Profile id.' }, patch: { type: 'json', description: 'Fields to change.' } } },
  { name: 'llama_start', description: 'Launch llama-server for a model with a profile (or inline overrides), wait for the /health readiness check, and apply the Auto GPU-layers retry ladder on GPU memory failures.', parameters: { model_id: { type: 'string', description: 'Registered model id.' }, profile_id: { type: 'string', description: 'Optional profile id.' }, model_path: { type: 'string', description: 'Alternative: absolute path to a .gguf file.' }, gpu_layers: { type: 'string', description: 'Override GPU layers: integer or "auto".' }, backend: { type: 'string', description: 'Override backend (must match the active build).' }, port: { type: 'integer', description: 'Override port.' }, host: { type: 'string', description: 'Override bind host (defaults to localhost).' } } },
  { name: 'llama_stop', description: 'Stop the running llama-server cleanly (tree-scoped termination).', parameters: {} },
  { name: 'llama_restart', description: 'Stop and start the server again with the same configuration.', parameters: {} },
  { name: 'llama_server_status', description: 'Get the server lifecycle state (STOPPED/STARTING/RUNNING/STOPPING/FAILED), pid, port and endpoint.', parameters: {} },
  { name: 'llama_logs', description: 'Read recent llama-server and plugin logs (stdout/stderr/plugin streams, searchable).', parameters: { limit: { type: 'integer', description: 'Number of lines (default 100).' }, stream: { type: 'string', description: 'stdout, stderr, plugin or all.' }, query: { type: 'string', description: 'Optional search substring.' } } },
  { name: 'llama_metrics', description: 'Get the latest server metrics snapshot: tokens/sec, prompt/generation speeds, KV cache usage, GPU utilization/VRAM, process RAM.', parameters: {} },
  { name: 'llama_endpoint', description: 'Get the OpenAI-compatible API endpoint details and ready-to-use configuration for other agents.', parameters: {} },
  { name: 'llama_test_chat', description: 'Send a one-shot chat completion to the running server to verify the OpenAI-compatible API end to end.', parameters: { message: { type: 'string', description: 'Optional test message.' } } },
  { name: 'llama_settings', description: 'Read or update plugin settings (server host/port/timeouts, import mode, auto-update check).', parameters: { patch: { type: 'json', description: 'Optional patch, e.g. {"server":{"port":8081}}; omit to read.' } } },
]

function registerHostTools(ctx, getManager) {
  const disposers = []
  for (const def of HOST_TOOL_DEFS) {
    const tool = harness.defineTool({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: {
        schema: { type: 'json' },
        render: function (_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args) {
        const m = await getManager()
        const map = {
          llama_status: ['status', {}],
          llama_diagnostics: ['diagnostics', {}],
          llama_list_versions: ['versions.list', {}],
          llama_latest_version: ['versions.latest', { backend: args.backend }],
          llama_install_latest: ['versions.install', { backend: args.backend }],
          llama_activate_version: ['versions.activate', { version: args.version }],
          llama_remove_version: ['versions.remove', { version: args.version }],
          llama_repair_gpu_runtime: ['versions.repairRuntime', { version: args.version }],
          llama_list_models: ['models.list', {}],
          llama_import_model: ['models.import', { path: args.path, mode: args.mode, name: args.name }],
          llama_list_hf_files: ['models.hfFiles', { repo: args.repo }],
          llama_download_model: ['models.download', { repo: args.repo, filename: args.filename }],
          llama_cancel_download: ['models.cancelDownload', { id: args.id }],
          llama_inspect_model: ['models.inspect', { id: args.id, path: args.path }],
          llama_delete_model: ['models.delete', { id: args.id }],
          llama_model_settings: args.settings !== undefined
            ? ['models.saveSettings', { id: args.id, settings: args.settings }]
            : ['models.settings', { id: args.id }],
          llama_list_profiles: ['profiles.list', {}],
          llama_create_profile: ['profiles.create', { modelId: args.model_id, profile: args.profile }],
          llama_update_profile: ['profiles.save', { id: args.id, patch: args.patch }],
          llama_start: ['server.start', { modelId: args.model_id, modelPath: args.model_path, profileId: args.profile_id, gpuLayers: args.gpu_layers, backend: args.backend, port: args.port, host: args.host }],
          llama_stop: ['server.stop', {}],
          llama_restart: ['server.restart', {}],
          llama_server_status: ['server.status', {}],
          llama_logs: ['server.logs', { limit: args.limit, stream: args.stream, query: args.query }],
          llama_metrics: ['server.metrics', {}],
          llama_endpoint: ['server.endpoint', {}],
          llama_test_chat: ['server.testChat', { message: args.message }],
          llama_settings: args.patch !== undefined
            ? ['settings.update', { patch: args.patch }]
            : ['settings.get', {}],
        }
        const route = map[def.name]
        const result = await m.cmd(route[0], route[1])
        return result
      },
    })
    disposers.push(harness.registerTool(ctx, tool))
  }
  return function unregister() {
    for (const d of disposers) { try { d() } catch (_e) { /* noop */ } }
  }
}

return {
  name: 'llama-cpp-manager',
  inject: ['fs', 'subprocess', 'timer'],
  apply(ctx) {
    const fs = ctx.fs
    const subprocess = ctx.subprocess
    const timer = ctx.timer
    let sandboxPolicy
    try { sandboxPolicy = ctx.get('sandboxPolicy') } catch (_e) { sandboxPolicy = undefined }
    const policyRoot = sandboxPolicy && sandboxPolicy.workspaceRoot ? sandboxPolicy.workspaceRoot : undefined

    // ---- workspace-root resolution ------------------------------------
    // The session workspace is NOT always the sandbox policy's fallback root,
    // so the plugin resolves its mount point by probing candidates in order:
    //   1. the current initiator agent's session cwd
    //   2. every registered workspace path
    //   3. the sandbox policy fallback root
    // The first candidate containing plugins/llama_cpp/ wins. The result is
    // cached for the run's lifetime; module loading retries the resolution on
    // failure so a later workspace registration still works.
    let rootPromise
    function pluginRootCandidates() {
      const cands = []
      try {
        const agents = ctx.get('agents')
        if (agents && typeof agents.currentInitiator === 'function') {
          const a = agents.currentInitiator()
          if (a && a.session && a.session.meta && typeof a.session.meta.cwd === 'string') {
            cands.push(a.session.meta.cwd)
          }
        }
      } catch (_e) { /* noop */ }
      try {
        const reg = ctx.get('workspaceRegistry')
        if (reg && typeof reg.list === 'function') {
          const list = reg.list()
          if (Array.isArray(list)) {
            for (const w of list) {
              if (w && typeof w.path === 'string') cands.push(w.path)
            }
          }
        }
      } catch (_e) { /* noop */ }
      if (policyRoot !== undefined) cands.push(policyRoot)
      return cands
    }
    async function resolvePluginRoot() {
      if (rootPromise) return rootPromise
      rootPromise = (async () => {
        const probe = async (root) => {
          if (!root) return undefined
          try {
            const target = await fs.resolve(joinP(root, 'plugins/llama_cpp/src/host/boot.js'))
            const stat = await fs.stat(target)
            return stat !== undefined ? root : undefined
          } catch (_e) {
            return undefined
          }
        }
        const seen = new Set()
        for (const cand of pluginRootCandidates()) {
          if (cand === undefined || seen.has(cand)) continue
          seen.add(cand)
          const hit = await probe(cand)
          if (hit !== undefined) {
            console.log('[llama] resolved workspace root: ' + hit)
            return hit
          }
        }
        return undefined
      })()
      return rootPromise
    }
    async function resolveSourceDir() {
      const root = await resolvePluginRoot()
      return root === undefined ? undefined : joinP(root, 'plugins/llama_cpp/src')
    }

    let loadPromise
    let managerPromise
    let managerInstance

    async function loadModules() {
      if (loadPromise) return loadPromise
      loadPromise = (async () => {
        const sourceDir = await resolveSourceDir()
        if (sourceDir === undefined) {
          throw new Error('could not locate the llama_cpp plugin directory under any registered workspace')
        }
        for (const name of HOST_MODULES) {
          const filePath = joinP(sourceDir, 'host/' + name)
          const target = await fs.resolve(filePath)
          const text = await fs.readText(target)
          ;(0, eval)(text)
        }
        if (typeof globalThis.LLAMA === 'undefined' || !globalThis.LLAMA.api) {
          throw new Error('host module load produced no LLAMA.api namespace')
        }
        console.log('[llama] loaded ' + HOST_MODULES.length + ' host modules from ' + sourceDir)
      })()
      return loadPromise
    }

    async function getManager() {
      if (managerInstance) return managerInstance
      if (managerPromise) return managerPromise
      managerPromise = (async () => {
        try {
          await loadModules()
        } catch (err) {
          managerPromise = undefined // allow retry after a transient failure
          throw err
        }
        const root = await resolvePluginRoot()
        const Manager = globalThis.LLAMA.api.Manager
        const m = new Manager({
          fs, subprocess, timer,
          workspaceRoot: root,
          sourceDir: root === undefined ? undefined : joinP(root, 'plugins/llama_cpp/src'),
          log: (msg) => console.log(msg),
        })
        await m.init()
        managerInstance = m
        return m
      })()
      return managerPromise
    }

    async function safeCmd(method, args) {
      try {
        const m = await getManager()
        return m.cmd(String(method || 'ping'), args)
      } catch (err) {
        console.error('[llama] command failed: ' + String(err && err.message ? err.message : err))
        return { ok: false, code: 'BOOT_FAILED', message: String(err && err.message ? err.message : err) }
      }
    }

    // Client RPC surface.
    harness.handle('llama.call', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      return safeCmd(a.method, a.args)
    })

    harness.handle('llama.state', async () => safeCmd('status', {}))

    harness.handle('llama.getClientModule', async (args) => {
      const name = String((args && args.name) || '')
      if (!/^[A-Za-z0-9-]+\.js$/.test(name)) {
        return { ok: false, code: 'BAD_MODULE', message: 'invalid module name' }
      }
      try {
        const sourceDir = await resolveSourceDir()
        if (sourceDir === undefined) {
          return { ok: false, code: 'NO_SOURCE', message: 'could not locate the plugin source directory' }
        }
        const target = await fs.resolve(joinP(sourceDir, 'client/modules/' + name))
        const text = await fs.readText(target)
        return { ok: true, code: text }
      } catch (err) {
        return { ok: false, code: 'MODULE_READ', message: String(err && err.message) }
      }
    })

    harness.handle('llama.ping', async () => ({ ok: true, pong: true }))

    // Agent-facing tools.
    const unregisterTools = registerHostTools(ctx, getManager)

    // Cleanup on stop/update/undefine: terminate the server and downloads.
    ctx.effect(function () {
      return function () {
        try { unregisterTools() } catch (_e) { /* noop */ }
        const m = managerPromise
        if (m) {
          m.then(function (inst) { inst.dispose() }).catch(function () { /* noop */ })
        }
      }
    }, 'llama-cpp: teardown')

    console.log('[llama] host half ready; policy root: ' + (policyRoot || '(missing)'))
  },
}
