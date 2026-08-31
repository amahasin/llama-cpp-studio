// tests/progress.test.js — the model-loading progress the router streams.
//
// llama.cpp reports a real 0..1 load fraction, but only as server-sent events
// on the router's /models/sse — /models and /v1/models carry the state and
// nothing else, so polling can never see it. What is tested here is the part
// that turns that stream into something a pill can show: the events are fed in
// directly, without a socket.
//
// A model loads in stages (text weights, then the projector, then the draft
// head). Reporting each stage's own 0..1 would show the bar restarting at every
// boundary, so they are weighted into one figure.
'use strict'

const { loadHostModules } = require('../src/host.js')
const { createChecker } = require('./helpers.js')

const LLAMA = loadHostModules()
const { check, finish } = createChecker()

/** A ServerManager with nothing but the progress bookkeeping. */
function tracker() {
  const s = Object.create(LLAMA.server.ServerManager.prototype)
  s._progressByModel = {}
  return s
}

/** Shorthand for one /models/sse event. */
function ev(model, status, progress) {
  return { model, event: 'status_change', data: { status, progress } }
}

function main() {
  console.log('llama.cpp Studio load progress')

  // ---- one stage ----
  {
    const s = tracker()
    check('an unknown model has no progress', s._progressFor('nope') === undefined)

    s._applyProgress(ev('m', 'loading', { stages: ['text_model'], current: 'text_model', value: 0 }))
    check('a fresh load reads 0%', s._progressFor('m').percent === 0)

    s._applyProgress(ev('m', 'loading', { stages: ['text_model'], current: 'text_model', value: 0.638 }))
    check('a fraction becomes a percentage', s._progressFor('m').percent === 63.8,
      String(s._progressFor('m').percent))
    check('and the stage is reported', s._progressFor('m').stage === 'text_model')
  }

  // ---- stages are weighted into one figure ----
  {
    const s = tracker()
    const stages = ['text_model', 'mmproj_model']
    s._applyProgress(ev('m', 'loading', { stages, current: 'text_model', value: 0.5 }))
    check('half of the first of two stages is a quarter overall',
      s._progressFor('m').percent === 25, String(s._progressFor('m').percent))

    s._applyProgress(ev('m', 'loading', { stages, current: 'text_model', value: 1 }))
    check('all of the first of two stages is half overall',
      s._progressFor('m').percent === 50, String(s._progressFor('m').percent))

    s._applyProgress(ev('m', 'loading', { stages, current: 'mmproj_model', value: 0.5 }))
    check('half of the second is three quarters',
      s._progressFor('m').percent === 75, String(s._progressFor('m').percent))

    s._applyProgress(ev('m', 'loading', { stages, current: 'mmproj_model', value: 1 }))
    check('and the end is 100%', s._progressFor('m').percent === 100)

    const three = ['text_model', 'spec_model', 'mmproj_model']
    const t = tracker()
    t._applyProgress(ev('m', 'loading', { stages: three, current: 'spec_model', value: 0 }))
    check('a model with a draft head divides into three',
      Math.round(t._progressFor('m').percent) === 33, String(t._progressFor('m').percent))
  }

  // ---- a stage change carries no value ----
  {
    const s = tracker()
    const stages = ['text_model', 'mmproj_model']
    s._applyProgress(ev('m', 'loading', { stages, current: 'text_model', value: 1 }))
    // llama.cpp emits a bare { stage } between stages.
    s._applyProgress(ev('m', 'loading', { stage: 'mmproj_model' }))
    check('the bar does not blank between stages',
      typeof s._progressFor('m').percent === 'number', JSON.stringify(s._progressFor('m')))
    check('and it does not go backwards',
      s._progressFor('m').percent >= 50, String(s._progressFor('m').percent))
  }

  // ---- finishing clears it ----
  {
    const s = tracker()
    s._applyProgress(ev('m', 'loading', { stages: ['text_model'], current: 'text_model', value: 0.4 }))
    s._applyProgress({ model: 'm', event: 'model_status', data: { status: 'loaded' } })
    check('a loaded model reports no progress', s._progressFor('m') === undefined)

    s._applyProgress(ev('m', 'loading', { stages: ['text_model'], current: 'text_model', value: 0.4 }))
    s._applyProgress({ model: 'm', event: 'model_status', data: { status: 'unloaded' } })
    check('nor does an unloaded one', s._progressFor('m') === undefined)

    s._applyProgress(ev('m', 'loading', { stages: ['text_model'], current: 'text_model', value: 0.4 }))
    s._applyProgress({ model: 'm', event: 'model_status', data: { status: 'sleeping' } })
    check('nor a sleeping one', s._progressFor('m') === undefined)
  }

  // ---- rubbish in the stream ----
  {
    const s = tracker()
    s._applyProgress(ev('m', 'loading', { stages: ['text_model'], current: 'text_model', value: 4 }))
    check('a fraction above one is clamped', s._progressFor('m').percent === 100,
      String(s._progressFor('m').percent))
    s._applyProgress(ev('m', 'loading', { stages: ['text_model'], current: 'text_model', value: -2 }))
    check('and one below zero', s._progressFor('m').percent === 0, String(s._progressFor('m').percent))

    const t = tracker()
    t._applyProgress({ model: 'm', event: 'status_change', data: { status: 'loading' } })
    check('a loading event with no progress block reports none', t._progressFor('m') === undefined)
    t._applyProgress({ model: 'm', event: 'status_change', data: { status: 'loading', progress: 'nonsense' } })
    check('and neither does a malformed one', t._progressFor('m') === undefined)
  }

  // ---- models do not bleed into each other ----
  {
    const s = tracker()
    s._applyProgress(ev('a', 'loading', { stages: ['text_model'], current: 'text_model', value: 0.2 }))
    s._applyProgress(ev('b', 'loading', { stages: ['text_model'], current: 'text_model', value: 0.9 }))
    check('two models are tracked separately',
      s._progressFor('a').percent === 20 && s._progressFor('b').percent === 90)
    s._applyProgress({ model: 'a', event: 'model_status', data: { status: 'loaded' } })
    check('and finishing one leaves the other alone', s._progressFor('b').percent === 90)
  }

  return finish('progress.test.js')
}

process.exit(main())
