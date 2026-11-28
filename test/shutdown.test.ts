import assert from 'node:assert/strict'
import test from 'node:test'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { useLogger } from 'ring-client-api/util'
import { setHap } from '../src/hap.js'
import type { RingCamera } from 'ring-client-api'
import { CameraSource, shutDownCameraSources } from '../src/camera-source.js'
import { bareCameraSource, config, fake, internals } from './helpers.js'

setHap(hapNodejs)
useLogger({ logInfo() {}, logError() {} })

test('shutting down a camera ends its live views, recordings and Ring call', () => {
  const ended: string[] = []
  const source = bareCameraSource()
  Object.assign(source, {
    ringCamera: { name: 'Front Door' },
    sessions: {
      a: { stop: () => ended.push('live view a') },
      b: { stop: () => ended.push('live view b') },
    },
    recordingWaiters: new Map(),
    activeRecordingSessions: new Map([[1, () => ended.push('recording 1')]]),
    mediaIngress: { shutdown: () => ended.push('ring call') },
  })

  source.shutdown()

  assert.deepEqual(ended, ['live view a', 'live view b', 'recording 1', 'ring call'])
  assert.deepEqual(source.sessions, {})
  assert.equal(internals<Map<number, unknown>>(source.activeRecordingSessions).size, 0)
})

test('Homebridge shutting down reaches every camera, even after one fails', (t) => {
  const camera = (name: string) => fake<RingCamera>({ name, id: name, operatingOnBattery: false, data: { settings: {} } })
  const front = new CameraSource(camera('Front Door'), config()),
    back = new CameraSource(camera('Back Door'), config())
  const shutDown: string[] = []
  // each camera's Ring call handling (private)
  const ingress = (source: CameraSource) => internals<{ mediaIngress: { shutdown(): void } }>(source).mediaIngress
  t.mock.method(ingress(front), 'shutdown', () => {
    shutDown.push('Front Door')
    throw new Error('failed')
  })
  t.mock.method(ingress(back), 'shutdown', () => shutDown.push('Back Door'))

  shutDownCameraSources()

  assert.deepEqual(shutDown, ['Front Door', 'Back Door'])
})
