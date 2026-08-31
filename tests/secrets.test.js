// tests/secrets.test.js — the API key and the GitHub token must not leave the
// host in the clear, and must survive a settings save that does not touch them.
//
// Both halves matter. Redacting is easy; redacting in a way that makes an
// untouched Save wipe the user's key is a worse bug than the one being fixed,
// because the settings form is populated from `status` — the same payload the
// redaction applies to.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { createManager } = require('../src/host.js')
const { scratchDir, cleanScratch, createChecker } = require('./helpers.js')

const REDACTED = '•'.repeat(8)
const REAL_KEY = 'super-secret-key-12345'

const { check, finish } = createChecker()

function storedConfig(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'))
}

async function main() {
  const dataDir = scratchDir('secrets')
  console.log('llama.cpp Studio secret handling')
  console.log('  scratch: ' + dataDir)

  const booted = await createManager({ dataDir, log() {} })
  const manager = booted.manager

  try {
    await manager.cmd('settings.update', { patch: { server: { apiKey: REAL_KEY } } })
    check('the key is stored in the clear on disk', storedConfig(dataDir).server.apiKey === REAL_KEY)

    const status = await manager.cmd('status', {})
    check('status redacts it', status.settings.server.apiKey === REDACTED,
      JSON.stringify(status.settings.server.apiKey))
    check('status still reports that one is set', status.settings.server.apiKeySet === true)

    const got = await manager.cmd('settings.get', {})
    check('settings.get redacts it too', got.settings.server.apiKey === REDACTED)

    const updated = await manager.cmd('settings.update', { patch: { server: { port: 8080 } } })
    check('the update response redacts it', updated.config.server.apiKey === REDACTED,
      JSON.stringify(updated.config.server.apiKey))

    // Exactly what the settings form sends when nobody touched the key field.
    await manager.cmd('settings.update', {
      patch: { server: { apiKey: REDACTED, apiKeySet: true, port: 8080 } },
    })
    check('an untouched save keeps the key', storedConfig(dataDir).server.apiKey === REAL_KEY,
      String(storedConfig(dataDir).server.apiKey))
    check('the read-only "is it set" flag is never persisted',
      storedConfig(dataDir).server.apiKeySet === undefined)

    // The placeholder is multi-byte. A client or a console with the wrong code
    // page turns it into '?' or U+FFFD, and storing that as somebody's API key
    // would be worse than the exposure the redaction exists to prevent.
    for (const mangled of ['????????', '����']) {
      await manager.cmd('settings.update', { patch: { server: { apiKey: mangled } } })
      check('a placeholder mangled to ' + JSON.stringify(mangled) + ' still keeps the key',
        storedConfig(dataDir).server.apiKey === REAL_KEY, String(storedConfig(dataDir).server.apiKey))
    }

    await manager.cmd('settings.update', { patch: { server: { apiKey: 'a-genuinely-new-key' } } })
    check('a real new key is stored', storedConfig(dataDir).server.apiKey === 'a-genuinely-new-key')

    await manager.cmd('settings.update', { patch: { server: { apiKey: '' } } })
    check('an empty value clears it', storedConfig(dataDir).server.apiKey === undefined)
    const cleared = await manager.cmd('status', {})
    check('and status says no key is set', cleared.settings.server.apiKeySet === false)

    // The optional GitHub token gets the same treatment.
    await manager.cmd('settings.update', { patch: { llamaCpp: { githubToken: 'ghp_exampletoken' } } })
    const withToken = await manager.cmd('status', {})
    check('the github token is redacted in status',
      withToken.settings.llamaCpp.githubToken === REDACTED)
    check('the github token is stored in the clear',
      storedConfig(dataDir).llamaCpp.githubToken === 'ghp_exampletoken')
    await manager.cmd('settings.update', { patch: { llamaCpp: { githubToken: REDACTED } } })
    check('an untouched save keeps the github token',
      storedConfig(dataDir).llamaCpp.githubToken === 'ghp_exampletoken')

    // Nothing else in the status payload should carry the key either.
    await manager.cmd('settings.update', { patch: { server: { apiKey: REAL_KEY } } })
    const full = await manager.cmd('status', {})
    check('the key appears nowhere in the whole status payload',
      JSON.stringify(full).indexOf(REAL_KEY) === -1)
  } finally {
    await manager.shutdown()
  }

  const code = finish('secrets.test.js')
  cleanScratch(dataDir)
  return code
}

main()
  .then(function (code) { process.exit(code) })
  .catch(function (err) {
    console.error(err && err.stack ? err.stack : err)
    process.exit(1)
  })
