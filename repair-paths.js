#!/usr/bin/env node
// repair-paths.js — point a moved data directory back at itself.
//
// The managed directories, installed builds and managed models are all recorded
// as absolute paths. Rename this folder, copy it to another drive or carry it
// to another PC and every one of them still names the machine that wrote them.
//
// The app repairs the seven managed directories on startup, every time, so most
// of this is a report rather than a repair. What is left for this script:
//
//   • the metadata files — installed builds and registered models — which the
//     app repairs in memory as it reads them and only writes back on the next
//     install or import;
//   • a directory you deliberately pointed elsewhere and now want back inside
//     the folder (`--all`);
//   • listing what cannot be repaired at all: models imported by reference from
//     outside this folder, whose files this app never moved.
//
// The three repairs themselves live in ./src/repair; this file is the command
// line, the report and the one place that writes.
//
// Usage: node repair-paths.js [--data <dir>] [--dry-run] [--all]
'use strict'

const path = require('node:path')

const { loadHostModules } = require('./src/host.js')
const { DEFAULT_DATA_DIR } = require('./src/lib/layout.js')
const { parseArgs, AS_PATH } = require('./src/lib/args.js')
const { norm, exists, writeJson } = require('./src/lib/fsx.js')
const { repairConfig } = require('./src/repair/config.js')
const { repairVersions } = require('./src/repair/versions.js')
const { repairModels } = require('./src/repair/models.js')

const SPEC = {
  defaults: { data: DEFAULT_DATA_DIR, dryRun: false, all: false },
  flags: {
    '--dry-run': { key: 'dryRun' },
    '-n': { key: 'dryRun' },
    '--all': { key: 'all' },
    '--help': { key: 'help' },
    '-h': { key: 'help' },
  },
  values: {
    '--data': { key: 'data', coerce: AS_PATH },
  },
}

const HELP = [
  'Usage: node repair-paths.js [--data <dir>] [--dry-run] [--all]',
  '',
  '  --dry-run  show what would change and write nothing',
  '  --all      also pull back directories you pointed elsewhere on purpose',
].join('\n')

function printList(heading, lines) {
  if (lines.length === 0) return
  console.log('\n' + heading + '\n')
  for (const line of lines) console.log(line)
}

function main() {
  const args = parseArgs(process.argv.slice(2), SPEC)
  if (args.unknown.length > 0) {
    console.error('unknown option: ' + args.unknown[0])
    process.exit(2)
  }
  if (args.help) {
    console.log(HELP)
    return 0
  }

  const home = norm(path.resolve(args.data))
  if (!exists(home)) {
    console.error('no data directory at ' + home)
    return 1
  }

  console.log('repair-paths — data directory: ' + home)
  if (args.dryRun) console.log('  (dry run: nothing will be written)')

  const LLAMA = loadHostModules()
  const metaDir = path.join(home, 'metadata')

  const config = repairConfig({ home, all: args.all, LLAMA })
  if (config.note !== undefined) console.log(config.note)
  if (config.kept.length > 0) {
    console.log('  kept where you put them (--all overrides): ' + config.kept.join(', '))
  }

  const steps = [
    config,
    repairVersions({ home, metaDir }),
    repairModels({ home, metaDir, moved: config.moved }),
  ]
  const changes = steps.flatMap(function (step) { return step.changes })
  const unresolved = steps.flatMap(function (step) { return step.unresolved })
  const writes = steps.flatMap(function (step) { return step.writes })

  if (changes.length === 0) {
    console.log('\nnothing to repair — every recorded path already points inside this folder')
  } else {
    printList(changes.length + ' path(s) to rebase:', changes)
  }
  printList('cannot be repaired automatically:', unresolved)

  if (!args.dryRun) {
    for (const [file, data] of writes) {
      writeJson(file, data)
      console.log('\nwrote ' + file)
    }
  }
  return 0
}

process.exit(main())
