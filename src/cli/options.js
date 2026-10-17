// cli/options.js — the command line of `llama-studio`.
//
// The option table and the help text sit next to each other so an option can no
// longer be added to one and forgotten in the other.
'use strict'

const { parseArgs, AS_NUMBER, AS_STRING, AS_PATH } = require('../lib/args.js')
const { DEFAULT_DATA_DIR } = require('../lib/layout.js')

const DEFAULT_PORT = 8770
const DEFAULT_HOST = '127.0.0.1'

const SPEC = {
  defaults: {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    data: DEFAULT_DATA_DIR,
    open: true,
    status: false,
    autostart: true,
  },
  flags: {
    '--help': { key: 'help' },
    '-h': { key: 'help' },
    '--version': { key: 'version' },
    '-v': { key: 'version' },
    '--no-open': { key: 'open', value: false },
    '--autostart': { key: 'autostart', value: true },
    '--no-autostart': { key: 'autostart', value: false },
    // Printing status is a read-only errand: it neither opens a window nor
    // starts a server on the way.
    '--status': { set: { status: true, open: false, autostart: false } },
  },
  values: {
    '--port': { key: 'port', coerce: AS_NUMBER },
    '--host': { key: 'host', coerce: AS_STRING },
    '--data': { key: 'data', coerce: AS_PATH },
    '--endpoint-file': { key: 'endpointFile', coerce: AS_PATH },
    '--idle-unload': { key: 'idleUnload', coerce: AS_NUMBER },
  },
}

function helpText(version) {
  return [
    'llama.cpp Studio ' + version + ' — local GGUF runtime manager',
    '',
    'Usage: llama-studio [options]',
    '',
    'Options:',
    '  --port <n>        UI port (default ' + DEFAULT_PORT + ', 0 picks a free one)',
    '  --host <addr>     UI bind address (default ' + DEFAULT_HOST + ')',
    '  --data <dir>      managed data directory (models, builds, logs, config)',
    '                    default: ' + DEFAULT_DATA_DIR,
    '  --no-open         do not launch a browser',
    '  --no-autostart    do not start router mode automatically on boot',
    '  --endpoint-file <path>',
    '                    write {url, port, pid} there once listening, and delete it',
    '                    on shutdown. How the desktop shell finds the server it',
    '                    just started, without parsing this output.',
    '  --idle-unload <m> release a loaded model after m minutes with no request',
    '                    (0 turns it off; the saved setting is used when omitted)',
    '  --status          print status as JSON and exit',
    '  --version         print the version and exit',
    '  --help            show this help',
    '',
    'The data directory holds installed llama.cpp builds, imported models,',
    'per-model launch settings, logs and config.json — the same layout the',
    'DeepSeek Harness plugin uses, so both can share one directory.',
  ].join('\n')
}

function parse(argv) {
  return parseArgs(argv, SPEC)
}

/**
 * What is wrong with a parsed command line, one sentence per problem; empty
 * when it can be run. Checked before anything boots, so a typo costs a line
 * of text rather than a manager start-up and a stack trace from listen().
 */
function validate(args) {
  const errors = []
  for (const flag of args.unknown || []) errors.push('unknown option: ' + flag)
  for (const flag of args.missing || []) errors.push(flag + ' needs a value')
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    errors.push('--port takes a whole number from 0 to 65535 (0 picks a free one)')
  }
  if (typeof args.host !== 'string' || args.host.trim() === '') {
    errors.push('--host takes an address, such as 127.0.0.1 or 0.0.0.0')
  }
  if (args.idleUnload !== undefined && !(Number.isFinite(args.idleUnload) && args.idleUnload >= 0)) {
    errors.push('--idle-unload takes a number of minutes, 0 or more (0 turns it off)')
  }
  return errors
}

module.exports = { parse, validate, helpText, SPEC, DEFAULT_PORT, DEFAULT_HOST }
