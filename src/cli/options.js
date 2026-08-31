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

module.exports = { parse, helpText, SPEC, DEFAULT_PORT, DEFAULT_HOST }
