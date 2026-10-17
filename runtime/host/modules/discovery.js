// discovery.js — network discovery and status probing for remote cluster workers.
// Combines fast parallel subnet TCP port probing with UDP broadcast beacons.
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util

  const DEFAULT_RPC_PORT = 50052
  const DEFAULT_UDP_PORT = 50055
  const SCAN_TIMEOUT_MS = 1200

  function getRequire() {
    try {
      if (typeof require === 'function') return require
    } catch (_e) {}
    if (typeof globalThis !== 'undefined' && typeof globalThis.require === 'function') {
      return globalThis.require
    }
    return null
  }

  function DiscoveryService(deps) {
    this.deps = deps || {}
    this.log = this.deps.log || function () {}
    this._discovered = new Map()
    this._udpSocket = null
  }

  /**
   * Detect candidate local IPv4 /24 subnets.
   */
  DiscoveryService.prototype.getLocalSubnets = function () {
    const req = getRequire()
    if (!req) return []
    let os
    try {
      os = req('node:os')
    } catch (_e) {
      return []
    }
    const ifaces = os.networkInterfaces()
    const subnets = []
    for (const [name, list] of Object.entries(ifaces)) {
      for (const iface of list) {
        if (iface.family === 'IPv4' && !iface.internal) {
          // Skip /32 point-to-point, loopback and Hyper-V virtual switches
          if (iface.netmask === '255.255.255.255') continue
          if (name.toLowerCase().includes('vethernet')) continue
          const parts = iface.address.split('.')
          if (parts.length === 4) {
            subnets.push({
              name,
              localIp: iface.address,
              base: parts.slice(0, 3).join('.') + '.',
              broadcast: parts.slice(0, 3).join('.') + '.255',
            })
          }
        }
      }
    }
    return subnets
  }

  /**
   * Read ARP cache for currently active LAN neighbors.
   */
  DiscoveryService.prototype.getArpNeighbors = function () {
    const req = getRequire()
    if (!req) return []
    let cp
    try {
      cp = req('node:child_process')
    } catch (_e) {
      return []
    }
    try {
      const out = cp.execSync('arp -a', { encoding: 'utf8', timeout: 1000 })
      const ips = []
      const regex = /^\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+/gm
      let m
      while ((m = regex.exec(out)) !== null) {
        const ip = m[1]
        if (!ip.startsWith('224.') && !ip.startsWith('239.') && !ip.endsWith('.255') && !ip.startsWith('127.')) {
          ips.push(ip)
        }
      }
      return ips
    } catch (_e) {
      return []
    }
  }

  /**
   * Fast parallel TCP probe for a given IP and port.
   */
  DiscoveryService.prototype.probeTcp = function (host, port, timeoutMs) {
    const req = getRequire()
    if (!req) return Promise.resolve({ ok: false, online: false })
    let net
    try {
      net = req('node:net')
    } catch (_e) {
      return Promise.resolve({ ok: false, online: false })
    }
    const tMs = timeoutMs || SCAN_TIMEOUT_MS
    return new Promise((resolve) => {
      let settled = false
      const socket = new net.Socket()
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { socket.destroy() } catch (_e) {}
        resolve({ ok: false, host, port, online: false, error: 'timed out' })
      }, tMs)

      const start = Date.now()
      socket.on('connect', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const rtt = Date.now() - start
        try { socket.destroy() } catch (_e) {}
        resolve({ ok: true, host, port, online: true, rttMs: rtt })
      })
      socket.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { socket.destroy() } catch (_e) {}
        resolve({ ok: false, host, port, online: false, error: err.message })
      })
      try {
        socket.connect(port, host)
      } catch (err) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, host, port, online: false, error: err.message })
      }
    })
  }

  /**
   * Resolve hostname via NetBIOS nbtstat command on Windows.
   */
  DiscoveryService.prototype.resolveHostname = async function (ip) {
    const req = getRequire()
    if (!req) return undefined
    let cp
    try {
      cp = req('node:child_process')
    } catch (_e) {
      return undefined
    }
    return new Promise((resolve) => {
      cp.execFile('nbtstat', ['-A', ip], { timeout: 1500 }, (err, stdout) => {
        if (err || !stdout) return resolve(undefined)
        const m = stdout.match(/^\s*([A-Za-z0-9_-]+)\s+<20>\s+UNIQUE/m)
          || stdout.match(/^\s*([A-Za-z0-9_-]+)\s+<00>\s+UNIQUE/m)
        resolve(m ? m[1].trim() : undefined)
      })
    })
  }

  /**
   * Scan all local subnets in parallel for the RPC port (50052).
   */
  DiscoveryService.prototype.scanSubnets = async function (port, timeoutMs) {
    const targetPort = port || DEFAULT_RPC_PORT
    const subnets = this.getLocalSubnets()
    const active = []
    const scannedIps = new Set()

    for (const sub of subnets) {
      const probes = []
      for (let i = 1; i <= 254; i++) {
        const ip = sub.base + i
        if (ip === sub.localIp) continue
        scannedIps.add(ip)
        probes.push(this.probeTcp(ip, targetPort, timeoutMs))
      }
      const results = await Promise.all(probes)
      for (const r of results) {
        if (r && r.online) {
          active.push(r)
        }
      }
    }

    // Also probe any ARP cache neighbors not already covered
    const neighborIps = this.getArpNeighbors()
    const extraProbes = []
    for (const ip of neighborIps) {
      if (!scannedIps.has(ip)) {
        scannedIps.add(ip)
        extraProbes.push(this.probeTcp(ip, targetPort, timeoutMs))
      }
    }
    if (extraProbes.length > 0) {
      const extraResults = await Promise.all(extraProbes)
      for (const r of extraResults) {
        if (r && r.online) {
          active.push(r)
        }
      }
    }

    // Resolve hostnames for newly discovered IPs
    for (const item of active) {
      const key = item.host + ':' + item.port
      const existing = this._discovered.get(key) || {}
      let hostname = existing.hostname
      if (!hostname) {
        hostname = await this.resolveHostname(item.host)
      }
      const node = {
        id: key,
        host: item.host,
        port: item.port,
        hostname: hostname || existing.hostname || ('Worker-' + item.host.split('.').pop()),
        label: existing.label || hostname || ('Worker at ' + item.host),
        gpu: existing.gpu || 'NVIDIA GPU (RTX 3060)',
        vramMiB: existing.vramMiB || 12288,
        online: true,
        rttMs: item.rttMs,
        lastSeen: new Date().toISOString(),
      }
      this._discovered.set(key, node)
    }

    return active
  }

  /**
   * Query workers via UDP broadcast on port 50055.
   */
  DiscoveryService.prototype.queryUdpBeacons = function (udpPort, timeoutMs) {
    const req = getRequire()
    if (!req) return Promise.resolve([])
    let dgram
    try {
      dgram = req('node:dgram')
    } catch (_e) {
      return Promise.resolve([])
    }
    const port = udpPort || DEFAULT_UDP_PORT
    const waitMs = timeoutMs || 1000
    const subnets = this.getLocalSubnets()

    return new Promise((resolve) => {
      let client
      try {
        client = dgram.createSocket('udp4')
      } catch (_e) {
        return resolve([])
      }

      const found = []
      client.on('message', (msg, rinfo) => {
        try {
          const payload = JSON.parse(msg.toString('utf8'))
          if (payload && (payload.type === 'llama-worker-beacon' || payload.type === 'llama-worker-pong')) {
            const host = payload.host || rinfo.address
            const rpcPort = payload.rpcPort || DEFAULT_RPC_PORT
            const key = host + ':' + rpcPort
            const node = {
              id: key,
              host,
              port: rpcPort,
              hostname: payload.hostname || ('Worker-' + host.split('.').pop()),
              label: payload.hostname || ('Worker at ' + host),
              gpu: payload.gpu || 'NVIDIA GPU (RTX 3060)',
              vramMiB: payload.vramMiB || 12288,
              online: true,
              rttMs: payload.rttMs || 1,
              lastSeen: new Date().toISOString(),
            }
            this._discovered.set(key, node)
            found.push(node)
          }
        } catch (_err) {
          // ignore malformed packets
        }
      })

      client.bind(0, () => {
        try {
          client.setBroadcast(true)
          const queryMsg = Buffer.from(JSON.stringify({ type: 'llama-discover' }))
          client.send(queryMsg, port, '255.255.255.255')
          for (const s of subnets) {
            client.send(queryMsg, port, s.broadcast)
          }
        } catch (_e) {
          // broadcast error
        }
      })

      setTimeout(() => {
        try { client.close() } catch (_e) {}
        resolve(found)
      }, waitMs)
    })
  }

  /**
   * Run full discovery: combine UDP broadcast queries and TCP subnet scan.
   */
  DiscoveryService.prototype.discover = async function (options) {
    const opts = options || {}
    const port = opts.port || DEFAULT_RPC_PORT
    await Promise.all([
      this.queryUdpBeacons(DEFAULT_UDP_PORT, 800),
      this.scanSubnets(port, opts.timeoutMs || SCAN_TIMEOUT_MS),
    ])
    return this.list()
  }

  /**
   * Get list of all discovered workers.
   */
  DiscoveryService.prototype.list = function () {
    return Array.from(this._discovered.values())
  }

  LLAMA.modules.push('discovery')
  LLAMA.discovery = { DiscoveryService }
})(globalThis.LLAMA)
