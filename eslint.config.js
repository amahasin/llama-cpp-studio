// eslint.config.js — pins the house style that was, until now, held together
// by discipline alone. It had already drifted: the origin-matching block in
// src/server.js used double quotes and arrow functions against the grain of
// its own file.
//
// ESLint is deliberately NOT a dependency — this project ships with none, and
// `npm test` must keep working offline. Run it on demand:
//
//   npm run lint          (npx fetches eslint into the npm cache)
'use strict'

const HOUSE_STYLE = {
  // The three rules the codebase actually follows everywhere.
  quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
  semi: ['error', 'never'],
  indent: ['error', 2, { SwitchCase: 1 }],

  'comma-dangle': ['error', 'always-multiline'],
  'object-curly-spacing': ['error', 'always'],
  'space-before-function-paren': ['error', { anonymous: 'always', named: 'never', asyncArrow: 'always' }],
  'eol-last': ['error', 'always'],
  'no-trailing-spaces': 'error',

  // Caught real problems in this codebase; keep them errors.
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
  'no-undef': 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
}

const NODE_GLOBALS = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  URL: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  globalThis: 'readonly',
  Atomics: 'readonly',
  Int32Array: 'readonly',
  SharedArrayBuffer: 'readonly',
}

const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  localStorage: 'readonly',
  MutationObserver: 'readonly',
  fetch: 'readonly',
  CustomEvent: 'readonly',
  Function: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
}

module.exports = [
  {
    // Vendored and generated code is not ours to restyle — see
    // runtime/host/VENDORED.md. Linting it reports ~346 style findings that
    // nobody here can act on (the next `pack.js` overwrites the lot), and a
    // gate that always fails is a gate nobody reads. To look at it anyway:
    //
    //   npx eslint --no-ignore runtime/host
    //
    // data/ is runtime state; web/vendor is React.
    ignores: [
      'data/**',
      '.tmp/**',
      'runtime/**',
      'web/vendor/**',
      'native/build/**',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: HOUSE_STYLE,
  },
  {
    // Only reached with --no-ignore. The host modules are plain scripts
    // evaluated into a shared LLAMA namespace, not CommonJS, and they run in
    // both Node and a browser-ish sandbox.
    files: ['runtime/host/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: Object.assign({}, NODE_GLOBALS, {
        LLAMA: 'writable',
        harness: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
      }),
    },
  },
  {
    files: ['web/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: BROWSER_GLOBALS,
    },
  },
]
