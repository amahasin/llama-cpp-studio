// lib/fsx.js — the small filesystem and path helpers the entry points share.
//
// Each of build.js, pack.js, repair-paths.js and the fs service had its own
// copy of most of these, with subtly different answers on Windows: three
// different case-folding rules for "is this path inside that directory" is one
// bug waiting to happen, not three.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

// Windows paths differ in case without differing at all, and the same directory
// reaches us written both ways — as typed in Settings and as the OS reports it.
const CASELESS = process.platform === 'win32'

/** Forward slashes, the form the host modules and the metadata files use. */
function norm(p) {
  return String(p === undefined || p === null ? '' : p).replace(/\\/g, '/')
}

/** An absolute path folded to the form two spellings of it compare equal in. */
function pathKey(p) {
  const resolved = path.resolve(p)
  return CASELESS ? resolved.toLowerCase() : resolved
}

/** Whether `target` is `root` itself or sits somewhere beneath it. */
function isInside(target, root) {
  const t = pathKey(target)
  const r = pathKey(root)
  return t === r || t.startsWith(r + path.sep)
}

/**
 * Whether `file` sits under `dir`, and where it lands under `into` if it does.
 * Operates on normalized (forward-slash) paths, as the metadata files store them.
 */
function reparent(file, dir, into) {
  const f = norm(file)
  const d = norm(dir).replace(/\/+$/, '') + '/'
  if (f.length <= d.length || f.slice(0, d.length).toLowerCase() !== d.toLowerCase()) return undefined
  return norm(into).replace(/\/+$/, '') + '/' + f.slice(d.length)
}

function exists(p) {
  try {
    fs.statSync(p)
    return true
  } catch (_e) {
    return false
  }
}

/** Parse a JSON file, or undefined when it is absent or unreadable. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (_e) {
    return undefined
  }
}

/** Write pretty JSON with the trailing newline the metadata files carry. */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

/** Recursive copy; `filter(absoluteSourceFile)` decides which files travel. */
function copyDir(from, to, filter) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst, filter)
    else if (!filter || filter(src)) copyFile(src, dst)
  }
}

function dirSize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size
  }
  return total
}

module.exports = {
  CASELESS, norm, pathKey, isInside, reparent,
  exists, readJson, writeJson, copyFile, copyDir, dirSize,
}
