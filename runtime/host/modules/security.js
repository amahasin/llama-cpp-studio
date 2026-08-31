// security.js — input validation and sanitization for everything that touches
// the filesystem, the network, or a subprocess argv. Pure module.
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util

  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
  const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

  /**
   * Validate an http(s) URL for use as a download source.
   * Returns { ok: true, url } or { ok: false, code, message }.
   */
  function validateHttpUrl(raw) {
    const s = String(raw === undefined || raw === null ? '' : raw).trim()
    if (s.length === 0) return { ok: false, code: 'EMPTY_URL', message: 'URL is empty.' }
    if (CONTROL_CHARS.test(s) || /\s/.test(s)) {
      return { ok: false, code: 'BAD_URL_CHARS', message: 'URL contains whitespace or control characters.' }
    }
    if (!/^https?:\/\//i.test(s)) {
      return { ok: false, code: 'BAD_URL_SCHEME', message: 'Only http:// and https:// URLs are allowed.' }
    }
    // Reject userinfo so credentials cannot be smuggled through a download URL.
    const noScheme = s.replace(/^https?:\/\//i, '')
    const hostPart = noScheme.split(/[/?#]/, 1)[0]
    if (hostPart.includes('@')) {
      return { ok: false, code: 'URL_USERINFO', message: 'URLs with embedded credentials are not allowed.' }
    }
    if (hostPart.length === 0) {
      return { ok: false, code: 'BAD_URL_HOST', message: 'URL has no host.' }
    }
    // A hostname or IPv4 address, with an optional port. IPv6 literals — which
    // are bracketed — are deliberately not accepted: nothing this app downloads
    // from is addressed that way. This check replaces a condition whose body
    // was empty, so every host shape reached the return below unexamined.
    if (!/^[A-Za-z0-9._~-]+(:\d{1,5})?$/.test(hostPart)) {
      return {
        ok: false, code: 'BAD_URL_HOST',
        message: 'URL host must be a hostname or IPv4 address with an optional port.',
      }
    }
    return { ok: true, url: s }
  }

  /**
   * Validate a model filename / any single path segment.
   */
  function validateFileName(raw) {
    const s = String(raw === undefined || raw === null ? '' : raw).trim()
    if (s.length === 0) return { ok: false, code: 'EMPTY_NAME', message: 'Name is empty.' }
    if (CONTROL_CHARS.test(s)) return { ok: false, code: 'BAD_NAME_CHARS', message: 'Name contains control characters.' }
    if (/[\\/]/.test(s)) return { ok: false, code: 'BAD_NAME_SEP', message: 'Name must be a single file name, not a path.' }
    if (s === '.' || s === '..') return { ok: false, code: 'BAD_NAME_DOT', message: 'Name must not be "." or "..".' }
    if (s.length > 200) return { ok: false, code: 'NAME_TOO_LONG', message: 'Name is longer than 200 characters.' }
    if (/[<>:"|?*]/.test(s)) return { ok: false, code: 'BAD_NAME_CHARS', message: 'Name contains characters not allowed on Windows: < > : " | ? *' }
    if (/[. ]$/.test(s)) return { ok: false, code: 'BAD_NAME_END', message: 'Name must not end with a dot or space.' }
    if (WINDOWS_RESERVED.test(s.split('.')[0])) {
      return { ok: false, code: 'RESERVED_NAME', message: 'Name is a reserved Windows device name (CON, NUL, ...).' }
    }
    return { ok: true, name: s }
  }

  /**
   * Validate a Hugging Face repository id: "owner/repository" with optional ref.
   */
  function validateRepository(raw) {
    const s = String(raw === undefined || raw === null ? '' : raw).trim()
    if (!/^[A-Za-z0-9._-]{1,96}\/[A-Za-z0-9._-]{1,96}$/.test(s)) {
      return { ok: false, code: 'BAD_REPO', message: 'Repository must look like "owner/repository".' }
    }
    const parts = s.split('/')
    if (parts.length !== 2 || parts[0] === '.' || parts[0] === '..' || parts[1] === '.' || parts[1] === '..') {
      return { ok: false, code: 'BAD_REPO', message: 'Repository segments must not be "." or "..".' }
    }
    return { ok: true, repo: s }
  }

  /**
   * Validate a model id exposed through the OpenAI-compatible API (model alias).
   */
  function validateModelId(raw) {
    const s = String(raw === undefined || raw === null ? '' : raw).trim()
    if (s.length === 0 || s.length > 120) return { ok: false, code: 'BAD_MODEL_ID', message: 'Model id must be 1-120 characters.' }
    if (!/^[A-Za-z0-9._-]+$/.test(s)) return { ok: false, code: 'BAD_MODEL_ID', message: 'Model id may contain only letters, digits, ".", "_" and "-".' }
    return { ok: true, name: s }
  }

  /**
   * Validate a host binding string. Defaults are localhost-only.
   */
  function validateHost(raw) {
    const s = String(raw === undefined || raw === null ? '' : raw).trim()
    if (s.length === 0) return { ok: true, host: '127.0.0.1' }
    if (!/^[A-Za-z0-9.:_[\]-]{1,64}$/.test(s)) {
      return { ok: false, code: 'BAD_HOST', message: 'Host contains invalid characters.' }
    }
    return { ok: true, host: s }
  }

  function validatePort(raw) {
    const n = parseInt(raw, 10)
    if (Number.isNaN(n) || n < 1024 || n > 65535) {
      return { ok: false, code: 'BAD_PORT', message: 'Port must be an integer between 1024 and 65535.' }
    }
    return { ok: true, port: n }
  }

  /**
   * Validate every element of an argv array before it reaches subprocess.spawn.
   * Arguments are never shell-interpreted, but we still refuse control bytes
   * and absurd lengths so nothing surprising crosses the process boundary.
   */
  function validateArgv(argv) {
    if (!Array.isArray(argv)) return { ok: false, code: 'BAD_ARGV', message: 'argv must be an array of strings.' }
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i]
      if (typeof a !== 'string') return { ok: false, code: 'BAD_ARGV_ITEM', message: 'argv[' + i + '] is not a string.' }
      if (a.length === 0) return { ok: false, code: 'BAD_ARGV_EMPTY', message: 'argv[' + i + '] is an empty string.' }
      if (a.length > 8000) return { ok: false, code: 'BAD_ARGV_LONG', message: 'argv[' + i + '] is longer than 8000 characters.' }
      if (CONTROL_CHARS.test(a)) return { ok: false, code: 'BAD_ARGV_CTRL', message: 'argv[' + i + '] contains control characters.' }
    }
    return { ok: true, argv }
  }

  /**
   * Guard an advanced-options list supplied by the user: tokens must be sane,
   * and flag-shaped tokens must be known capabilities of the installed binary
   * when a capability set is provided (unknown flags kill the server at boot).
   */
  function validateExtraArgs(list, capabilitySet) {
    if (list === undefined || list === null) return { ok: true, args: [] }
    if (!Array.isArray(list)) return { ok: false, code: 'BAD_EXTRA', message: 'Advanced options must be a list of strings.' }
    const out = []
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i]
      if (typeof item !== 'string' || item.trim() === '') {
        return { ok: false, code: 'BAD_EXTRA_ITEM', message: 'Advanced option #' + (i + 1) + ' is empty.' }
      }
      const token = item.trim()
      if (CONTROL_CHARS.test(token)) {
        return { ok: false, code: 'BAD_EXTRA_CTRL', message: 'Advanced option #' + (i + 1) + ' contains control characters.' }
      }
      if (/^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$/.test(token) && capabilitySet !== undefined) {
        const flag = token.replace(/^-{1,2}/, '')
        if (capabilitySet[flag] !== true) {
          return {
            ok: false, code: 'UNSUPPORTED_FLAG', message: 'Option "' + token + '" is not supported by the installed llama.cpp version.',
          }
        }
      }
      out.push(token)
    }
    return { ok: true, args: out }
  }

  function validateVersionDirName(raw) {
    // Installed versions live under bin/<name>; allow bXXXX plus safe extras.
    const s = String(raw === undefined || raw === null ? '' : raw).trim()
    if (!/^[bB]\d{1,10}([-_.A-Za-z0-9]{0,40})?$/.test(s)) {
      return { ok: false, code: 'BAD_VERSION_DIR', message: 'Version directory name must look like "b1234".' }
    }
    return { ok: true, name: s }
  }

  LLAMA.modules.push('security')
  LLAMA.security = {
    validateHttpUrl, validateFileName, validateRepository, validateModelId,
    validateHost, validatePort, validateArgv, validateExtraArgs, validateVersionDirName,
  }
})(globalThis.LLAMA)
