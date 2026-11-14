import assert from 'node:assert/strict'
import test from 'node:test'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { useLogger } from 'ring-client-api/util'
import { setHap } from '../lib/hap.js'
import { CameraSource, shutDownCameraSources } from '../lib/camera-source.js'

setHap(hapNodejs)
useLogger({ logInfo() {}, logError() {} })

test('shutting down a camera ends its live views, recordings and Ring call', () => {
  const ended = []
  const source = Object.create(CameraSource.prototype)
  Object.assign(source, {
    ringCamera: { name: 'Front Door' },
    sessions: {
      a: { stop: () => ended.push('live view a') },
      b: { stop: () => ended.push('live view b') },
    },
    closedRecordingStreams: new Set(),
    recordingWaiters: new Map(),
    activeRecordingSessions: new Map([[1, () => ended.push('recording 1')]]),
    mediaIngress: { shutdown: () => ended.push('ring call') },
  })

  source.shutdown()

  assert.deepEqual(ended, ['live view a', 'live view b', 'recording 1', 'ring call'])
  assert.deepEqual(source.sessions, {})
  assert.equal(source.activeRecordingSessions.size, 0)
})

test('Homebridge shutting down reaches every camera, even after one fails', (t) => {
  const camera = (name) => ({ name, id: name, operatingOnBattery: false, data: { settings: {} } })
  const front = new CameraSource(camera('Front Door'), {}),
    back = new CameraSource(camera('Back Door'), {})
  const shutDown = []
  t.mock.method(front.mediaIngress, 'shutdown', () => {
    shutDown.push('Front Door')
    throw new Error('failed')
  })
  t.mock.method(back.mediaIngress, 'shutdown', () => shutDown.push('Back Door'))

  shutDownCameraSources()

  assert.deepEqual(shutDown, ['Front Door', 'Back Door'])
})
