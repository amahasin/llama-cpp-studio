// lib/platform.js — this app is Windows-only, on purpose.
//
// package.json already says os: ["win32"], but npm only enforces that at
// install time. Started anywhere else the app would get several steps in and
// then fail somewhere unhelpful — the exec layer is embedded PowerShell, the
// process tree is torn down with taskkill.exe, and every llama.cpp build it
// installs is a .exe. Saying so up front beats a stack trace from a shell that
// does not exist.
//
// A real port means replacing the exec layer, not deleting this file.
'use strict'

const SUPPORTED = 'win32'

function isSupported() {
  return process.platform === SUPPORTED
}

function unsupportedMessage() {
  return [
    'llama.cpp Studio runs on Windows only (this is ' + process.platform + ').',
    '',
    'It drives llama.cpp through PowerShell helpers, tears down process trees',
    'with taskkill.exe, and installs Windows release builds. None of that has a',
    'portable equivalent in the app today.',
  ].join('\n')
}

/** Print the reason and stop, or return true when this platform will work. */
function requireSupportedPlatform() {
  if (isSupported()) return true
  console.error(unsupportedMessage())
  return false
}

module.exports = { SUPPORTED, isSupported, unsupportedMessage, requireSupportedPlatform }
