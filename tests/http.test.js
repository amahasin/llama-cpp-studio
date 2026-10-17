// tests/http.test.js — the front end's own plumbing: who may call it, what it
// serves and how, and the command line that starts it.
//
// Each of these was wrong in a way that only showed up off the happy path:
//   • bound to 0.0.0.0, every origin counted as local, so any website could
//     read the session token through a visitor's browser and drive the app;
//   • the URL printed and opened for a wildcard bind was http://0.0.0.0:…/,
//     which browsers refuse, and an IPv6 bind produced no valid URL at all;
//   • every asset was no-store, so each visit re-fetched ~380 KB of scripts,
//     and asking for a directory under /assets/ answered 500;
//   • `--port` with no value, or `--port abc`, became NaN and failed in
//     listen() instead of at the command line;
//   • a multi-byte character split across two pipe chunks came out as two
//     replacement characters in llama-server's captured output.
'use strict'

const http = require('node:http')

const { startServer } = require('../src/server.js')
const { createOriginPolicy } = require('../src/http/origin.js')
const { serverSettings, apiKeyOf } = require('../src/lib/settings.js')
const { isWildcardHost, dialHost, urlHost, localUrl, networkUrls } = require('../src/lib/net.js')
const options = require('../src/cli/options.js')
const { statusBanner } = require('../src/cli/banner.js')
const { createCollector } = require('../src/services/subprocess.js')
const { createChecker } = require('./helpers.js')

const { check, finish } = createChecker()

/** A request carrying only the headers the origin policy reads. */
function fakeRequest(headers) {
  return { headers: headers || {} }
}

function policy(host, allowedOrigins) {
  return createOriginPolicy({
    host,
    allowedOrigins: function () { return allowedOrigins || '' },
    warn() {},
  })
}

function stubManager(settings) {
  return {
    config: { get(section) { return section === 'server' ? settings : {} } },
    server: { status() { return { state: 'STOPPED' } }, routerLoaded() { return [] } },
    async cmd() { return { ok: true } },
  }
}

/** GET with headers fetch() will not let us set (If-None-Match is fine, Host is not). */
function request(base, path, headers) {
  const target = new URL(path, base)
  return new Promise(function (resolve, reject) {
    const req = http.request({
      host: target.hostname, port: target.port, path: target.pathname, method: 'GET', headers: headers || {},
    }, function (res) {
      const chunks = []
      res.on('data', function (c) { chunks.push(c) })
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function settingsChecks() {
  console.log('\n— one way to read the server settings')
  check('no manager reads as empty', JSON.stringify(serverSettings(undefined)) === '{}')
  check('a manager without a config store reads as empty', JSON.stringify(serverSettings({})) === '{}')
  const throwing = { config: { get() { throw new Error('locked') } } }
  check('a config read that throws reads as empty', JSON.stringify(serverSettings(throwing)) === '{}')
  check('a null section reads as empty', JSON.stringify(serverSettings(stubManager(null))) === '{}')
  check('what is saved comes back as saved', serverSettings(stubManager({ port: 9 })).port === 9)
  check('an empty API key is no key', apiKeyOf(stubManager({ apiKey: '' })) === undefined)
  check('a non-string API key is no key', apiKeyOf(stubManager({ apiKey: 42 })) === undefined)
  check('a set API key is returned', apiKeyOf(stubManager({ apiKey: 'k' })) === 'k')
}

function originChecks() {
  console.log('\n— who may call the RPC route')
  const wildcard = policy('0.0.0.0')
  const lanHost = '192.168.1.20:8770'

  check('bound to 0.0.0.0, an unrelated website is NOT allowed',
    wildcard.isAllowed(fakeRequest({ origin: 'https://evil.example', host: lanHost })) === false)
  check('…not even when it calls the loopback address',
    wildcard.isAllowed(fakeRequest({ origin: 'https://evil.example', host: '127.0.0.1:8770' })) === false)
  check('the page it served, from a phone on the LAN, is allowed',
    wildcard.isAllowed(fakeRequest({ origin: 'http://' + lanHost, host: lanHost })) === true)
  check('the same page on another port is not the same origin',
    wildcard.isAllowed(fakeRequest({ origin: 'http://192.168.1.20:9999', host: lanHost })) === false)
  check('bound to ::, the LAN page is allowed too (it was refused before)',
    policy('::').isAllowed(fakeRequest({ origin: 'http://' + lanHost, host: lanHost })) === true)
  check('an IPv6 page calling back to itself is allowed',
    policy('::').isAllowed(fakeRequest({ origin: 'http://[fe80::1]:8770', host: '[fe80::1]:8770' })) === true)
  check('a tunnel that keeps the public Host is same-origin',
    policy('127.0.0.1').isAllowed(fakeRequest({ origin: 'https://studio.example.com', host: 'studio.example.com' })) === true)
  check('Host comparison ignores case',
    wildcard.isAllowed(fakeRequest({ origin: 'http://Studio.LAN:8770', host: 'studio.lan:8770' })) === true)
  check('a request with no Host is never same-origin',
    wildcard.isAllowed(fakeRequest({ origin: 'http://studio.lan:8770' })) === false)

  const loopback = policy('127.0.0.1')
  check('loopback pages are still allowed', loopback.isAllowed(fakeRequest({ origin: 'http://localhost:3000', host: '127.0.0.1:8770' })))
  check('a request without an Origin is allowed', loopback.isAllowed(fakeRequest({})))
  check('a garbage Origin is refused', loopback.isAllowed(fakeRequest({ origin: 'not a url', host: 'x' })) === false)
  check('the allow-list still admits a named site',
    policy('0.0.0.0', 'https://chat.example.com').isAllowed(fakeRequest({ origin: 'https://chat.example.com', host: lanHost })))
  check('and a wildcard pattern',
    policy('0.0.0.0', '*.example.com').isAllowed(fakeRequest({ origin: 'https://a.example.com', host: lanHost })))
  check('"*" still opens it to everyone, as configured',
    policy('0.0.0.0', '*').isAllowed(fakeRequest({ origin: 'https://evil.example', host: lanHost })))
}

function netChecks() {
  console.log('\n— addresses a browser can actually open')
  check('0.0.0.0 is a wildcard', isWildcardHost('0.0.0.0'))
  check(':: is a wildcard', isWildcardHost('::'))
  check('a named address is not', !isWildcardHost('192.168.1.20'))
  check('a wildcard is dialled on loopback', dialHost('0.0.0.0') === '127.0.0.1')
  check('a named address is dialled as named', dialHost('10.0.0.5') === '10.0.0.5')
  check('IPv6 goes in brackets', urlHost('::1') === '[::1]')
  check('already-bracketed IPv6 is left alone', urlHost('[::1]') === '[::1]')
  check('a 0.0.0.0 bind opens on 127.0.0.1', localUrl('0.0.0.0', 8770) === 'http://127.0.0.1:8770/', localUrl('0.0.0.0', 8770))
  check('an IPv6 bind gives a valid URL', localUrl('::1', 8770) === 'http://[::1]:8770/', localUrl('::1', 8770))
  check('a loopback bind is unchanged', localUrl('127.0.0.1', 8770) === 'http://127.0.0.1:8770/')

  const table = {
    'Ethernet': [
      { address: '192.168.1.20', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
    'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    'Wi-Fi': [{ address: '169.254.10.2', family: 'IPv4', internal: false }],
    'vEthernet': [{ address: '172.20.0.1', family: 4, internal: false }],
  }
  const urls = networkUrls('0.0.0.0', 8770, table)
  check('a wildcard bind lists its LAN addresses',
    urls.length === 2 && urls[0] === 'http://192.168.1.20:8770/' && urls[1] === 'http://172.20.0.1:8770/',
    JSON.stringify(urls))
  check('a loopback bind lists none', networkUrls('127.0.0.1', 8770, table).length === 0)

  const banner = statusBanner({ version: 't', url: 'http://127.0.0.1:8770/', networkUrls: urls, dataDir: 'D', status: {} })
  check('the banner shows where a phone finds it',
    banner.indexOf('On network') !== -1 && banner.indexOf('http://192.168.1.20:8770/') !== -1)
}

function optionChecks() {
  console.log('\n— the command line says what is wrong before anything starts')
  const ok = options.parse([])
  check('the defaults are valid', options.validate(ok).length === 0, options.validate(ok).join('; '))
  check('--port=0 is valid', options.validate(options.parse(['--port=0'])).length === 0)

  const bare = options.parse(['--no-open', '--port'])
  check('a trailing --port is reported as missing', bare.missing.length === 1 && bare.missing[0] === '--port')
  check('and leaves the port at its default, not NaN', bare.port === options.DEFAULT_PORT, String(bare.port))
  check('and fails validation', options.validate(bare).some(function (e) { return e.indexOf('--port needs a value') !== -1 }))

  const words = options.validate(options.parse(['--port', 'abc']))
  check('a non-numeric port fails', words.some(function (e) { return e.indexOf('--port takes') === 0 }), words.join('; '))
  check('a port above 65535 fails', options.validate(options.parse(['--port', '70000'])).length === 1)
  check('a fractional port fails', options.validate(options.parse(['--port', '80.5'])).length === 1)
  check('a negative idle timeout fails', options.validate(options.parse(['--idle-unload', '-1'])).length === 1)
  check('an idle timeout of 0 is valid', options.validate(options.parse(['--idle-unload', '0'])).length === 0)
  check('an empty host fails', options.validate(options.parse(['--host', ''])).length === 1)
  check('an unknown option is reported', options.validate(options.parse(['--prot', '1'])).some(function (e) {
    return e === 'unknown option: --prot'
  }))
}

function collectorChecks() {
  console.log('\n— captured output survives a character split across chunks')
  const collector = createCollector()
  const text = 'model: Qwen-日本語-é\n'
  const bytes = Buffer.from(text, 'utf8')
  // Split inside the three-byte 日 and inside the two-byte é.
  const cut1 = bytes.indexOf(Buffer.from('日', 'utf8')) + 1
  const cut2 = bytes.indexOf(Buffer.from('é', 'utf8')) + 1
  collector.push(bytes.subarray(0, cut1))
  collector.push(bytes.subarray(cut1, cut2))
  collector.push(bytes.subarray(cut2))
  const got = collector.readFrom(0).text
  check('the text comes out intact', got === text, JSON.stringify(got))
  check('with no replacement characters', got.indexOf('�') === -1)
}

async function assetChecks() {
  console.log('\n— static assets: revalidated, not re-downloaded, and files only')
  const studio = await startServer({ manager: stubManager({ host: '127.0.0.1', port: 1 }), host: '127.0.0.1', port: 0 })
  try {
    const first = await request(studio.url, '/assets/fluent.css')
    check('a stylesheet is served', first.status === 200, String(first.status))
    check('with a validator', typeof first.headers.etag === 'string' && first.headers.etag !== '')
    check('and no-cache rather than no-store', first.headers['cache-control'] === 'no-cache', first.headers['cache-control'])
    check('typed as CSS', String(first.headers['content-type']).indexOf('text/css') === 0)

    const again = await request(studio.url, '/assets/fluent.css', { 'if-none-match': first.headers.etag })
    check('a repeat with the validator is a 304', again.status === 304, String(again.status))
    check('with no body', again.body === '')

    const stale = await request(studio.url, '/assets/fluent.css', { 'if-none-match': 'W/"stale"' })
    check('a stale validator gets the file again', stale.status === 200)

    const dir = await request(studio.url, '/assets/vendor')
    check('a directory is a 404, not a 500', dir.status === 404, String(dir.status))
    const escape = await request(studio.url, '/assets/..%2fpackage.json')
    check('a path out of web/ is a 404', escape.status === 404, String(escape.status))

    const page = await request(studio.url, '/')
    check('the page, which holds the session token, stays no-store', page.headers['cache-control'] === 'no-store')

    const preflight = await new Promise(function (resolve, reject) {
      const target = new URL(studio.url)
      const req = http.request({
        host: target.hostname, port: target.port, path: '/api/rpc', method: 'OPTIONS',
        headers: { origin: 'https://evil.example', host: target.host },
      }, function (res) { res.resume(); res.on('end', function () { resolve(res) }) })
      req.on('error', reject)
      req.end()
    })
    check('a foreign site gets no CORS grant', preflight.headers['access-control-allow-origin'] === undefined)
  } finally {
    await studio.close()
  }
}

async function main() {
  console.log('llama.cpp Studio http front end')
  settingsChecks()
  originChecks()
  netChecks()
  optionChecks()
  collectorChecks()
  await assetChecks()
  return finish('http.test.js')
}

main()
  .then(function (code) { process.exit(code) })
  .catch(function (err) {
    console.error(err && err.stack ? err.stack : err)
    process.exit(1)
  })
