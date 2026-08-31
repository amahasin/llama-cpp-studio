// diagnostics.js — the environment validation checklist. Every item carries
// pass/fail/warn plus concrete remediation steps.
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util

  function Diagnostics(deps) {
    this.deps = deps
    this._cache = undefined
    this._cacheAt = 0
  }

  Diagnostics.prototype.run = async function (force) {
    const now = Date.now()
    if (!force && this._cache && now - this._cacheAt < 15000) return this._cache
    const deps = this.deps
    const items = []
    const ok = (id, label, detail) => items.push({ id, label, status: 'pass', detail })
    const fail = (id, label, detail, remediation) => items.push({ id, label, status: 'fail', detail, remediation })
    const warn = (id, label, detail, remediation) => items.push({ id, label, status: 'warn', detail, remediation })
    const skip = (id, label, detail) => items.push({ id, label, status: 'skip', detail })

    let hw = {}
    try {
      hw = await deps.hardware.detect(true)
      if (hw.rawErrors && hw.rawErrors.cimError) {
        warn('system', 'System information', 'CIM query failed: ' + util.truncate(hw.rawErrors.cimError, 120),
          ['Reboot and retry; WMI may be unhealthy.'])
      } else {
        ok('system', 'Operating system', (hw.osInfo.caption || 'Windows') + ' / ' + hw.arch)
      }
    } catch (err) {
      fail('system', 'Operating system', 'Detection failed: ' + String(err && err.message),
        ['Retry the diagnostics after a moment.'])
    }

    if (hw.cpu && hw.cpu.name) {
      ok('cpu', 'CPU', hw.cpu.name + ' (' + hw.cpu.physicalCores + 'C/' + hw.cpu.logicalCores + 'T)')
    } else {
      fail('cpu', 'CPU', 'CPU information unavailable', ['Retry the diagnostics.'])
    }

    if (hw.ramTotalBytes > 0) {
      const gb = hw.ramTotalBytes / (1024 * 1024 * 1024)
      if (gb < 6) warn('ram', 'RAM', util.bytesHuman(hw.ramTotalBytes) + ' — 7B-class models need 8GB+',
        ['Use a small model (1-3B) or quantization like Q4_K_M.'])
      else ok('ram', 'RAM', util.bytesHuman(hw.ramTotalBytes))
    } else {
      fail('ram', 'RAM', 'Total RAM could not be read', ['Retry the diagnostics.'])
    }

    // hw stays {} when detection threw above, so every read below is guarded.
    const gpus = Array.isArray(hw.gpus) ? hw.gpus : []
    const nvidia = gpus.filter((g) => g.vendor === 'nvidia')
    if (nvidia.length > 0) {
      ok('gpu', 'GPU', nvidia.map((g) => g.name + ' (' + util.bytesHuman(g.vramBytes) + ')').join('; '))
    } else if (gpus.length > 0) {
      const other = gpus[0]
      if (other.vendor === 'basic') {
        warn('gpu', 'GPU', 'No hardware GPU detected (Microsoft Basic Display Adapter).',
          ['llama.cpp will run CPU-only.', 'Install the GPU driver to unlock CUDA/Vulkan builds.'])
      } else {
        ok('gpu', 'GPU', other.name + ' (' + other.vendor + ')')
      }
    } else {
      skip('gpu', 'GPU', 'No GPU reported by the OS.')
    }

    if (hw.cuda && hw.cuda.available) {
      ok('driver', 'NVIDIA driver', 'Driver ' + hw.cuda.driverVersion + ' supports CUDA ' + (hw.cuda.supportedCu.join(', ') || '—'))
    } else if (nvidia.length > 0) {
      fail('driver', 'NVIDIA driver', 'nvidia-smi could not query the GPU.',
        ['Update or reinstall the NVIDIA driver.', 'nvidia-smi must be available on PATH.'])
    } else {
      skip('driver', 'NVIDIA driver', 'No NVIDIA GPU — CUDA does not apply.')
    }

    const versions = await deps.versions.listInstalled()
    // One resolution for the whole checklist. The configured active version can
    // name a build that is not installed here, so the lookup always falls back
    // to the first one that is — never to undefined.
    const active = versions.versions.length > 0
      ? ((versions.activeVersion
        ? versions.versions.find((v) => v.version === versions.activeVersion)
        : undefined) || versions.versions[0])
      : undefined
    const activeMissing = versions.activeVersion !== undefined
      && !versions.versions.some((v) => v.version === versions.activeVersion)

    if (active === undefined) {
      fail('llama', 'llama.cpp', versions.activeVersion
        ? 'llama.cpp is not installed on this machine (config still names build ' + versions.activeVersion + ').'
        : 'llama.cpp is not installed.',
      ['Open the llama.cpp page and click "Download engine".'])
    } else {
      ok('llama', 'llama.cpp', active.version + ' (' + active.backend + ') at ' + active.path)
      if (activeMissing) {
        warn('llama-active', 'Active build',
          'Settings name build ' + versions.activeVersion + ', which is not installed here — using '
          + active.version + ' instead.',
          ['Activate an installed build on the llama.cpp page to make this permanent.'])
      }
    }

    // A CUDA/Vulkan build that cannot see a device runs on the CPU silently —
    // the single most confusing failure mode, so it gets its own check.
    const activeEntry = active
    if (activeEntry && ['cuda', 'vulkan', 'hip', 'sycl'].includes(activeEntry.backend)) {
      let devices = activeEntry.devices
      if (devices === undefined && typeof deps.versions.listDevices === 'function') {
        const probe = await deps.versions.listDevices(activeEntry)
        devices = probe.devices
      }
      const gpuDevices = (devices || []).filter((d) => !/^CPU/i.test(d.id))
      if (gpuDevices.length > 0) {
        ok('gpu-runtime', 'GPU runtime', gpuDevices.map((d) => d.id + ' — ' + d.description).join('; '))
      } else {
        fail('gpu-runtime', 'GPU runtime',
          'The ' + String(activeEntry.backend).toUpperCase() + ' build reports no GPU devices, so models load into system RAM.',
          activeEntry.backend === 'cuda'
            ? [
              'Click "Fix GPU runtime" on the llama.cpp page — the CUDA runtime (cudart/cublas) ships as a separate release archive.',
              'Or reinstall the build: new installs download the runtime automatically.',
            ]
            : ['Reinstall the build, or install the vendor runtime/driver for this backend.'])
      }
    }

    const exe = active ? active.exePath : undefined
    if (exe) {
      const st = await deps.exec.stat(exe)
      if (st.exists === true) ok('exe', 'llama-server executable', exe)
      else fail('exe', 'llama-server executable', exe + ' is missing.',
        ['Reinstall that llama.cpp version.'])
    } else {
      skip('exe', 'llama-server executable', 'No installed version.')
    }

    const models = await deps.models.list()
    if (models.models.length === 0) {
      warn('model', 'GGUF model', 'No models registered.',
        ['Click "Import GGUF" or "Download from Hugging Face" on the Models page.'])
    } else {
      const missing = []
      for (const m of models.models) {
        const st = await deps.exec.stat(m.path)
        if (st.exists !== true) missing.push(m.name)
      }
      if (missing.length > 0) {
        fail('model', 'GGUF model', 'Missing files: ' + missing.join(', '),
          ['Re-import the model or restore the file to its original location.'])
      } else {
        ok('model', 'GGUF model', models.models.length + ' registered, all readable')
      }
    }

    const cfg = deps.config.get('server')
    const portCheck = await deps.exec.portStatus(cfg.port)
    if (portCheck.ok && portCheck.open === true && deps.server.isRunning() === false) {
      fail('port', 'Port ' + cfg.port, 'Port ' + cfg.port + ' is occupied by PID ' + (portCheck.pids.join(', ') || '?') + '.',
        ['Choose another port in Server Settings.'])
    } else if (portCheck.ok) {
      ok('port', 'Port ' + cfg.port, deps.server.isRunning() ? 'Serving on ' + cfg.port : 'Available')
    } else {
      warn('port', 'Port ' + cfg.port, 'Could not query port status: ' + util.truncate(portCheck.error || '', 100),
        ['Retry; if the problem persists, choose another port.'])
    }

    if (deps.server.isRunning()) {
      const hc = await deps.server.healthCheck()
      if (hc.ok && hc.health && hc.health.status === 200) {
        ok('api', 'Server API', deps.server.status().endpoint + ' answers /health')
      } else {
        fail('api', 'Server API', 'The server process is up but /health did not answer.',
          ['Check the Logs page for errors.', 'Restart the server.'])
      }
    } else if (versions.versions.length > 0 && models.models.length > 0) {
      skip('api', 'Server API', 'Start the server to verify the API.')
    } else {
      skip('api', 'Server API', 'Install llama.cpp and import a model first.')
    }

    const report = { at: util.nowIso(), items, passed: items.filter((i) => i.status === 'pass').length, failed: items.filter((i) => i.status === 'fail').length, warnings: items.filter((i) => i.status === 'warn').length }
    this._cache = report
    this._cacheAt = now
    return report
  }

  LLAMA.modules.push('diagnostics')
  LLAMA.diagnostics = { Diagnostics }
})(globalThis.LLAMA)
