// tests/helpers.js — the bits every suite needs.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const APP_ROOT = path.resolve(__dirname, '..')
const SCRATCH_ROOT = path.join(APP_ROOT, '.tmp')

/**
 * Remove a directory tree, waiting out the handles Windows has not closed yet.
 *
 * The suites used to do this inside a silent try/catch and move on, which is
 * why .tmp filled up with orphaned scratch directories: a lock that clears a
 * moment later left one behind for good. Returns whether the tree is gone, so
 * a caller can say so instead of pretending.
 */
function removeTree(dir, attempts) {
  const tries = attempts === undefined ? 20 : attempts
  for (let i = 0; i < tries; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      if (!fs.existsSync(dir)) return true
    } catch (_e) {
      // Still locked — spin below and try again.
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  return !fs.existsSync(dir)
}

/** A fresh scratch directory inside the app folder, as .tmp/<prefix>-<pid>. */
function scratchDir(prefix) {
  const dir = path.join(SCRATCH_ROOT, prefix + '-' + process.pid)
  removeTree(dir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Drop a scratch directory, and .tmp itself once the last suite is done. */
function cleanScratch(dir) {
  const gone = removeTree(dir)
  if (!gone) console.log('  note: could not remove ' + dir + ' (still locked)')
  try { fs.rmdirSync(SCRATCH_ROOT) } catch (_e) { /* another suite still has one */ }
  return gone
}

/** Minimal assertion counter shared by the suites that want one. */
function createChecker() {
  const state = { failures: 0 }
  return {
    state,
    check(label, condition, detail) {
      if (condition) {
        console.log('  ✓ ' + label)
      } else {
        state.failures += 1
        console.log('  ✗ ' + label + (detail === undefined ? '' : ' — ' + detail))
      }
    },
    finish(name) {
      if (state.failures === 0) {
        console.log('\n  all checks passed')
        return 0
      }
      console.log('\n  ' + state.failures + ' check(s) failed in ' + name)
      return 1
    },
  }
}

module.exports = { APP_ROOT, SCRATCH_ROOT, removeTree, scratchDir, cleanScratch, createChecker }
