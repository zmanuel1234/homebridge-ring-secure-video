import assert from 'node:assert/strict'
import test from 'node:test'
import { createRingLogger } from '../lib/ring-logger.js'

function fakeLog() {
  const lines = []
  return {
    lines,
    info: (...m) => lines.push(['info', ...m]),
    error: (m) => lines.push(['error', m]),
    debug: (m) => lines.push(['debug', m]),
  }
}

const cameraOptions = {
  body: { doorbot_id: 1, session_id: 'x', stealth_mode: false },
  dialog_id: 'd',
  method: 'camera_options',
}

test("Ring's camera_options session message is logged at debug, not as an error", () => {
  const log = fakeLog(),
    ring = createRingLogger(log)
  ring.logError('UNKNOWN MESSAGE')
  ring.logError(cameraOptions)
  assert.deepEqual(log.lines, [['debug', 'Ring video session message ignored: camera_options (stealth_mode=false)']])
})

test('any other unknown session message is still an error, with the message', () => {
  const log = fakeLog(),
    ring = createRingLogger(log),
    other = { method: 'something_new', body: {} }
  ring.logError('UNKNOWN MESSAGE')
  ring.logError(other)
  assert.deepEqual(log.lines, [
    ['error', 'UNKNOWN MESSAGE'],
    ['error', other],
  ])
})

test('other errors and info pass through unchanged, also right after UNKNOWN MESSAGE', () => {
  const log = fakeLog(),
    ring = createRingLogger(log)
  ring.logInfo('Activating Session')
  ring.logError('Video stream closed')
  ring.logError(cameraOptions) // not after UNKNOWN MESSAGE: an ordinary error
  ring.logError('UNKNOWN MESSAGE')
  ring.logInfo('connected')
  assert.deepEqual(log.lines, [
    ['info', 'Activating Session'],
    ['error', 'Video stream closed'],
    ['error', cameraOptions],
    ['error', 'UNKNOWN MESSAGE'],
    ['info', 'connected'],
  ])
})

test('two UNKNOWN MESSAGE calls in a row, or a text message after one, stay errors', () => {
  const log = fakeLog(),
    ring = createRingLogger(log)
  ring.logError('UNKNOWN MESSAGE')
  ring.logError('UNKNOWN MESSAGE')
  ring.logError('some text')
  assert.deepEqual(log.lines, [
    ['error', 'UNKNOWN MESSAGE'],
    ['error', 'UNKNOWN MESSAGE'],
    ['error', 'some text'],
  ])
})

test('info with several parts keeps all of them', () => {
  const log = fakeLog(),
    ring = createRingLogger(log)
  ring.logInfo('Pruning unused service', 'uuid', 'Siren', 'from', 'Front Door')
  assert.deepEqual(log.lines, [['info', 'Pruning unused service', 'uuid', 'Siren', 'from', 'Front Door']])
})
