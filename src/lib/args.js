// lib/args.js — a very small table-driven command-line parser.
//
// The two CLIs (src/main.js and repair-paths.js) each hand-rolled this. One of
// them had grown into a single 900-character if/else chain on one line, where
// the only way to see which options existed was to scroll sideways; the tables
// below are the same options, readable, and the `=` form now works for every
// value option instead of the three it happened to be spelled out for.
'use strict'

const path = require('node:path')

/** Coercions a value option can ask for. */
const AS_NUMBER = function (v) { return Number(v) }
const AS_STRING = function (v) { return String(v) }
const AS_PATH = function (v) { return path.resolve(String(v)) }

/**
 * spec: {
 *   defaults: { … }                       starting values
 *   flags:  { '--x': { key, value } | { set: { … } }, … }   aliases share a table entry
 *   values: { '--y': { key, coerce } , … }                  take the next argv item
 * }
 * Returns the defaults with every recognised option applied, plus `unknown`:
 * the arguments that matched nothing, in the order they were given, and
 * `missing`: value options that came last with nothing after them. Those used
 * to be coerced from `undefined`, so `--port` alone became port NaN and failed
 * somewhere deep in listen() instead of at the command line.
 */
function parseArgs(argv, spec) {
  const flags = spec.flags || {}
  const values = spec.values || {}
  const out = Object.assign({}, spec.defaults)
  const unknown = []
  const missing = []

  function applyFlag(def) {
    if (def.set !== undefined) Object.assign(out, def.set)
    else out[def.key] = def.value === undefined ? true : def.value
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (flags[arg] !== undefined) {
      applyFlag(flags[arg])
      continue
    }
    if (values[arg] !== undefined) {
      if (i + 1 >= argv.length) {
        missing.push(arg)
        continue
      }
      const def = values[arg]
      out[def.key] = (def.coerce || AS_STRING)(argv[++i])
      continue
    }

    const eq = arg.indexOf('=')
    if (eq > 0 && values[arg.slice(0, eq)] !== undefined) {
      const def = values[arg.slice(0, eq)]
      out[def.key] = (def.coerce || AS_STRING)(arg.slice(eq + 1))
      continue
    }

    unknown.push(arg)
  }

  out.unknown = unknown
  out.missing = missing
  return out
}

module.exports = { parseArgs, AS_NUMBER, AS_STRING, AS_PATH }
