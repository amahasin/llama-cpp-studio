// Boot strap for the llama.cpp manager plugin host modules.
// Every host module file is plain JavaScript with no imports. Modules attach
// themselves to the shared `LLAMA` namespace so the dynamic-package loader can
// evaluate them in order inside the harness sandbox realm, and the Node test
// suite can load the very same files.
'use strict'
;(function (root) {
  if (root.LLAMA === undefined) root.LLAMA = {}
  if (root.LLAMA.version === undefined) root.LLAMA.version = '1.0.0'
  if (root.LLAMA.modules === undefined) root.LLAMA.modules = []
})(typeof globalThis !== 'undefined' ? globalThis : this)
