// repair/models.js — models.json.
//
// A managed file moved with the folder, so it is found under the current models
// directory. A referenced one lives wherever the user keeps it and is never
// guessed at — with one exception: if it used to sit inside this folder's *old*
// models directory, the file travelled too, and the repair is the same prefix
// swap the config just made.
'use strict'

const path = require('node:path')

const { norm, exists, readJson, reparent } = require('../lib/fsx.js')

/** Where a model's file would be if it travelled with the folder. */
function managedCandidate(home, stored) {
  return home + '/models/' + path.basename(path.dirname(stored)) + '/' + path.basename(stored)
}

/**
 * options: { home, metaDir, moved } — `moved` is repairConfig's record of which
 * managed directories were rebased, and where from.
 */
function repairModels(options) {
  const { home, metaDir, moved } = options
  const file = path.join(metaDir, 'models.json')
  const models = readJson(file)

  const result = { changes: [], unresolved: [], writes: [] }
  if (models === undefined || !Array.isArray(models.models)) return result

  let touched = false
  for (const model of models.models) {
    if (!model || typeof model.path !== 'string') continue
    const stored = norm(model.path)
    if (exists(stored)) continue

    const here = managedCandidate(home, stored)
    let candidate
    if (model.managed === true) {
      candidate = here
    } else if (moved.modelsDirectory !== undefined) {
      candidate = reparent(stored, moved.modelsDirectory.from, moved.modelsDirectory.to)
    } else if (exists(here)) {
      // The app repairs config.json on every boot, so by the time anyone runs
      // this the old models directory is usually no longer recorded anywhere.
      // Same file name in the same subfolder, present here and gone there, is
      // the file that travelled with the folder.
      candidate = here
    }

    if (candidate === undefined || !exists(candidate)) {
      result.unresolved.push('  model "' + model.name + '" is '
        + (model.managed === true ? 'missing at' : 'referenced at')
        + ' ' + stored + ' — restore the file there, or delete and re-import the model')
      continue
    }
    if (stored.toLowerCase() === norm(candidate).toLowerCase()) continue

    result.changes.push('  model "' + model.name + '":\n      ' + stored + '\n   -> ' + candidate)
    model.path = candidate
    touched = true
  }

  if (touched) result.writes.push([file, models])
  return result
}

module.exports = { repairModels }
