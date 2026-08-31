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

module.exports = { MIME, mimeFor, sendJson, sendText, sendFile, notFound, readBody }
