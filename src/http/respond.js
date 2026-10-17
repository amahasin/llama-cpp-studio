// http/respond.js — the response shapes the app serves.
//
// The request handler used to write eight ad-hoc writeHead/end pairs, each
// repeating its own content type and cache header; every response the app makes
// is one of the four below.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  // Served with the right type or the browser ignores it, and "Add to Home
  // Screen" falls back to a screenshot instead of the app icon.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

const NO_STORE = 'no-store'

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': NO_STORE,
  })
  res.end(text)
}

function sendText(res, status, text, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/plain', 'Cache-Control': NO_STORE })
  res.end(text)
}

/** Serve a file already known to exist, typed by its extension. */
function sendFile(res, file, type) {
  res.writeHead(200, { 'Content-Type': type || mimeFor(file), 'Cache-Control': NO_STORE })
  res.end(fs.readFileSync(file))
}

/** Whether `file` names a regular file — not a directory, not nothing. */
function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch (_e) {
    return false
  }
}

/** A weak validator from size and modification time: cheap, and it changes on every rebuild. */
function etagOf(stat) {
  return 'W/"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"'
}

function matchesEtag(req, etag) {
  const header = req.headers['if-none-match']
  if (typeof header !== 'string') return false
  return header.split(',').some(function (tag) { return tag.trim() === etag || tag.trim() === '*' })
}

/**
 * Serve a static asset — the UI bundle, React, the stylesheets — so that a
 * reload costs a 304 rather than the whole download again. Everything was
 * `no-store`, which on a phone over Wi-Fi or a tunnel meant re-fetching about
 * 380 KB of scripts on every visit.
 *
 * `no-cache`, not a lifetime: the browser keeps its copy but asks every time
 * whether it is still current, so a re-packed bundle or an edited stylesheet
 * is never served stale. The page itself, which carries the session token,
 * stays `no-store` (see sendText).
 */
function sendStatic(req, res, file, type) {
  const stat = fs.statSync(file)
  const etag = etagOf(stat)
  const headers = {
    'Content-Type': type || mimeFor(file),
    'Cache-Control': 'no-cache',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  }
  if (matchesEtag(req, etag)) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  const body = fs.readFileSync(file)
  res.writeHead(200, Object.assign({ 'Content-Length': body.length }, headers))
  res.end(body)
}

function notFound(res) {
  sendText(res, 404, 'not found')
}

/** Collect a request body, rejecting once it passes `limitBytes`. */
function readBody(req, limitBytes) {
  return new Promise(function (resolve, reject) {
    const chunks = []
    let size = 0
    req.on('data', function (chunk) {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

module.exports = {
  MIME, mimeFor, sendJson, sendText, sendFile, sendStatic, isFile, etagOf, notFound, readBody,
}
