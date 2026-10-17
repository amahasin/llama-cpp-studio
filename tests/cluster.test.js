// tests/cluster.test.js — verifies cluster configuration, security validation,
// commandBuilder flags, and server launch planning.
'use strict'

const { loadHostModules } = require('../src/host.js')
const { createChecker } = require('./helpers.js')

const LLAMA = loadHostModules()
const { check, finish } = createChecker()

async function main() {
  console.log('llama.cpp Studio GPU cluster support')
  const { security, profiles, commandBuilder, config, server } = LLAMA

  // 1. security.validateRpcServers
  {
    const single = security.validateRpcServers('192.168.1.101:50052')
    check('validateRpcServers accepts single host:port', single.ok === true && single.servers === '192.168.1.101:50052')

    const multi = security.validateRpcServers('192.168.1.101:50052,192.168.1.102:50052')
    check('validateRpcServers accepts comma-separated host:port list', multi.ok === true && multi.servers === '192.168.1.101:50052,192.168.1.102:50052')

    const empty = security.validateRpcServers('')
    check('validateRpcServers accepts empty string', empty.ok === true && empty.servers === undefined)

    const noPort = security.validateRpcServers('192.168.1.101')
    check('validateRpcServers rejects host without port', noPort.ok === false)

    const badPort = security.validateRpcServers('192.168.1.101:99999')
    check('validateRpcServers rejects out-of-range port', badPort.ok === false)
  }

  // 2. profiles.validateProfile
  {
    const valid = profiles.validateProfile({
      name: 'ClusterProfile',
      rpc: '192.168.1.50:50052,192.168.1.51:50052',
      splitMode: 'layer',
      tensorSplit: '1,1,1',
    })
    check('validateProfile accepts valid rpc, splitMode, and tensorSplit', valid.ok === true)

    const badSplit = profiles.validateProfile({
      name: 'BadSplit',
      splitMode: 'invalid_mode',
    })
    check('validateProfile rejects invalid splitMode', badSplit.ok === false)

    const badRpc = profiles.validateProfile({
      name: 'BadRpc',
      rpc: 'invalid-host-no-port',
    })
    check('validateProfile rejects invalid rpc server', badRpc.ok === false)
  }

  // 3. commandBuilder.build
  {
    const model = {
      path: 'G:/models/test-70b.gguf',
      name: 'test-70b.gguf',
      profile: {
        rpc: '192.168.1.101:50052,192.168.1.102:50052',
        splitMode: 'layer',
        tensorSplit: '1,1,1',
      },
    }
    const version = {
      capabilities: { model: true, rpc: true, sm: true, ts: true },
    }
    const r = commandBuilder.build(model, version, { host: '127.0.0.1', port: 8080 })
    check('commandBuilder build succeeds with rpc', r.ok === true)
    check('commandBuilder emits --rpc', r.argv.includes('--rpc'))
    const rpcIdx = r.argv.indexOf('--rpc')
    check('commandBuilder attaches rpc value', rpcIdx !== -1 && r.argv[rpcIdx + 1] === '192.168.1.101:50052,192.168.1.102:50052')
    check('commandBuilder emits --split-mode', r.argv.includes('--split-mode'))
    const smIdx = r.argv.indexOf('--split-mode')
    check('commandBuilder attaches split-mode value', smIdx !== -1 && r.argv[smIdx + 1] === 'layer')
    check('commandBuilder emits --tensor-split', r.argv.includes('--tensor-split'))
    const tsIdx = r.argv.indexOf('--tensor-split')
    check('commandBuilder attaches tensor-split value', tsIdx !== -1 && r.argv[tsIdx + 1] === '1,1,1')
  }

  // 4. router presets
  {
    const entries = [
      {
        id: 'model-cluster',
        modelId: 'm1',
        model: {
          path: 'G:/models/test.gguf',
          name: 'test.gguf',
          profile: {
            rpc: '192.168.1.101:50052',
            splitMode: 'layer',
          },
        },
      },
    ]
    const version = {
      capabilities: { model: true, rpc: true, sm: true },
    }
    const preset = commandBuilder.buildPreset(entries, version)
    check('router preset build succeeds', preset.ok === true)
    check('router preset contains rpc line', preset.ini.includes('rpc = 192.168.1.101:50052'))
    check('router preset contains split-mode line', preset.ini.includes('split-mode = layer'))
  }

  // 5. config normalization
  {
    const base = config.defaults('G:/dummy')
    base.server.cluster = {
      enabled: true,
      nodes: [
        { id: 'node1', host: '192.168.1.101', port: 50052, label: 'PC 1' },
        { id: '', host: '192.168.1.102', port: 'bad-port' },
      ],
      splitMode: 'wrong_mode',
      tensorSplit: '1,1',
    }
    const norm = config.normalize(base, 'G:/dummy')
    check('cluster enabled is preserved', norm.server.cluster.enabled === true)
    check('cluster nodes are preserved and sanitized', norm.server.cluster.nodes.length === 2)
    check('node 1 port is correct', norm.server.cluster.nodes[0].port === 50052)
    check('node 2 invalid port is defaulted to 50052', norm.server.cluster.nodes[1].port === 50052)
    check('invalid splitMode defaults to layer', norm.server.cluster.splitMode === 'layer')
    check('tensorSplit is preserved', norm.server.cluster.tensorSplit === '1,1')
  }

  // 6. server _autoGpuLayers VRAM scaling
  {
    const s = Object.create(server.ServerManager.prototype)
    s.deps = {
      hardware: {
        estimateKvBytesPerLayer() { return 1024 * 1024 },
        estimateAutoGpuLayers(sizeBytes, layerCount, freeVram) {
          // If freeVram is enough for sizeBytes, return layerCount
          if (freeVram && freeVram >= sizeBytes) return layerCount
          return Math.floor(layerCount / 2)
        },
      },
    }
    const model = { sizeBytes: 24 * 1024 * 1024 * 1024, metadata: { blockCount: 60 } }
    const profile = { contextSize: 4096 }
    const hwSingle = { cuda: { vramFreeMiB: 12000 } } // ~12 GB

    const singleRes = s._autoGpuLayers(model, profile, 'cuda', hwSingle, 1)
    check('single node offloads partial layers', singleRes.gpuLayers === 30)

    const clusterRes = s._autoGpuLayers(model, profile, 'cuda', hwSingle, 3) // 3x 12GB = 36GB
    check('3-node cluster offloads full 60 layers', clusterRes.gpuLayers === 60)
  }

  // 7. cluster API management and selective worker toggle
  {
    const fs = require('node:fs')
    const os = require('node:os')
    const path = require('node:path')
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-cluster-test-'))
    const mockFs = {
      resolve: (p) => Promise.resolve(p),
      stat: () => Promise.resolve({ isDirectory: () => true }),
      readFile: () => Promise.resolve(Buffer.from('{}')),
      writeFile: () => Promise.resolve(),
      readText: () => Promise.resolve('{}'),
      writeText: () => Promise.resolve(),
      mkdir: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve(),
    }
    const mockTimer = {
      timeout: (fn, ms) => {
        if (typeof fn === 'function') setTimeout(fn, 1)
        return () => {}
      },
      interval: () => () => {},
    }
    const mgr = new LLAMA.api.Manager({
      fs: mockFs,
      subprocess: {},
      timer: mockTimer,
      home: scratch,
      log: () => {},
    })
    await mgr.init()

    // Save initial cluster with 2 worker nodes
    await mgr.cmd('cluster.save', {
      cluster: {
        enabled: true,
        nodes: [
          { id: '192.168.0.130:50052', host: '192.168.0.130', port: 50052, label: 'REMOTE-02', enabled: true, vramMiB: 12288 },
          { id: '192.168.0.131:50052', host: '192.168.0.131', port: 50052, label: 'REMOTE-03', enabled: true, vramMiB: 12288 },
        ],
        splitMode: 'layer',
      },
    })

    const status1 = await mgr.cmd('cluster.status', {})
    check('cluster status reports activeCount of 2', status1.activeCount === 2)
    check('cluster status reports pooledVramMiB of 36864 (3x 12GB)', status1.pooledVramMiB === 36864)

    // Selectively disable REMOTE-03
    const toggleRes = await mgr.cmd('cluster.toggleNode', { id: '192.168.0.131:50052', enabled: false })
    check('toggleNode succeeds', toggleRes.ok === true)
    check('activeCount drops to 1 after unselecting REMOTE-03', toggleRes.cluster.activeCount === 1)
    check('pooledVramMiB drops to 24576 (2x 12GB)', toggleRes.cluster.pooledVramMiB === 24576)

    // Add a 3rd worker node
    const addRes = await mgr.cmd('cluster.addNode', {
      node: { host: '192.168.0.132', port: 50052, label: 'REMOTE-04', enabled: true, vramMiB: 12288 },
    })
    check('addNode succeeds', addRes.ok === true)
    check('totalNodes is now 3', addRes.cluster.totalNodes === 3)
    check('activeCount is 2 (master + 2 active workers)', addRes.cluster.activeCount === 2)

    // Remove the disabled node
    const remRes = await mgr.cmd('cluster.removeNode', { id: '192.168.0.131:50052' })
    check('removeNode succeeds', remRes.ok === true)
    check('totalNodes is 2 after removal', remRes.cluster.totalNodes === 2)

    // Server planning selective launch test: only enabled nodes are sent to --rpc
    mgr.models.get = async () => ({
      ok: true,
      model: { id: 'm1', name: 'test.gguf', path: 'G:/models/test.gguf', metadata: { blockCount: 32 } },
    })
    mgr.exec.stat = async () => ({ exists: true, isDir: false, size: 1000 })
    mgr.server._resolveVersion = async () => ({
      ok: true,
      versionEntry: { version: 'b11200', backend: 'cuda', capabilities: { model: true, rpc: true, sm: true } },
    })
    mgr.server._resolveBind = async () => ({ ok: true, host: '127.0.0.1', port: 8080 })

    const planResult = await mgr.server._plan({ modelId: 'm1', profile: { contextSize: 4096 } })
    check('plan succeeds with cluster config', planResult.ok === true)
    const rpcArgIdx = planResult.argv.indexOf('--rpc')
    check('plan emits --rpc flag', rpcArgIdx !== -1)
    const rpcVal = planResult.argv[rpcArgIdx + 1]
    check('plan only includes enabled workers in --rpc', rpcVal.includes('192.168.0.130:50052') && rpcVal.includes('192.168.0.132:50052') && !rpcVal.includes('192.168.0.131:50052'))

    await mgr.dispose()
    try { fs.rmSync(scratch, { recursive: true, force: true }) } catch (_e) {}
  }

  process.exitCode = finish('cluster.test.js')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
