import assert from 'node:assert/strict'
import test from 'node:test'
import { Subject } from 'rxjs'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { useLogger } from 'ring-client-api/util'
import { setHap } from '../lib/hap.js'
import { Camera, SNAPSHOT_NOTIFICATION_WAIT_MS } from '../lib/camera.js'
import { CameraSource } from '../lib/camera-source.js'

setHap(hapNodejs)
useLogger({ logInfo() {}, logError() {} })

// A camera event as Camera.loadSnapshotForEvent sees it, without the rest of the accessory.
function fakeCamera({ onBattery, snapshotUuid, ringProtect = false }) {
  const loaded = []
  const camera = Object.create(Camera.prototype)
  camera.device = {
    name: 'Front Door',
    canTakeSnapshotWhileRecording: !onBattery,
    latestNotificationSnapshotUuid: snapshotUuid,
    onNewNotification: new Subject(),
    data: { subscribed: ringProtect },
  }
  camera.cameraSource = {
    loadSnapshot: async (uuid) => {
      loaded.push(uuid)
    },
  }
  return { camera, loaded }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('without Ring Protect, a battery camera event goes to HomeKit at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { camera, loaded } = fakeCamera({ onBattery: true })
  let value
  camera.loadSnapshotForEvent('Detected Motion', true).then((v) => (value = v))
  await settle()
  assert.equal(value, true, 'not held for a snapshot')
  assert.deepEqual(loaded, [])

  // A follow-up notification with a snapshot, 3 s later
  t.mock.timers.tick(3000)
  camera.device.onNewNotification.next({ img: {} })
  camera.device.onNewNotification.next({ img: { snapshot_uuid: 'snap-1' } })
  camera.device.onNewNotification.next({ img: { snapshot_uuid: 'snap-2' } })
  await settle()
  assert.deepEqual(loaded, ['snap-1'], 'the late snapshot is loaded, once')
})

test('the background wait for a snapshot ends after 10 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { camera, loaded } = fakeCamera({ onBattery: true })
  await camera.loadSnapshotForEvent('Doorbell Pressed', 'press')
  assert.equal(camera.device.onNewNotification.observed, true)
  t.mock.timers.tick(SNAPSHOT_NOTIFICATION_WAIT_MS)
  assert.equal(camera.device.onNewNotification.observed, false, 'nothing left waiting')
  camera.device.onNewNotification.next({ img: { snapshot_uuid: 'too-late' } })
  await settle()
  assert.deepEqual(loaded, [])
})

test('several events leave only one background wait', async () => {
  const { camera } = fakeCamera({ onBattery: true })
  for (let i = 0; i < 5; i++) await camera.loadSnapshotForEvent('Detected Motion', true)
  const subject = camera.device.onNewNotification
  assert.equal(subject.observers?.length ?? (subject.observed ? 1 : 0), 1)
  camera.pendingSnapshotNotification.unsubscribe()
})

test('a camera that has a snapshot loads it before the event, as before', async () => {
  const { camera, loaded } = fakeCamera({ onBattery: false, snapshotUuid: 'snap-now' })
  const value = await camera.loadSnapshotForEvent('Detected Motion', true)
  assert.equal(value, true)
  assert.deepEqual(loaded, ['snap-now'])
  assert.equal(camera.device.onNewNotification.observed, false)
})

test('with Ring Protect, the event waits up to 2 s for the snapshot, as before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { camera, loaded } = fakeCamera({ onBattery: true, ringProtect: true })
  let value
  camera.loadSnapshotForEvent('Doorbell Pressed', 'press').then((v) => (value = v))
  await settle()
  assert.equal(value, undefined, 'waiting for the snapshot')
  t.mock.timers.tick(1000)
  camera.device.onNewNotification.next({ img: { snapshot_uuid: 'snap-protect' } })
  await settle()
  await settle()
  assert.deepEqual(loaded, ['snap-protect'], 'the snapshot is loaded before the event')
  assert.equal(value, 'press')

  // and without the snapshot, it goes after 2 s with nothing left waiting
  const other = fakeCamera({ onBattery: true, ringProtect: true })
  let otherValue
  other.camera.loadSnapshotForEvent('Detected Motion', true).then((v) => (otherValue = v))
  t.mock.timers.tick(2000)
  await settle()
  assert.equal(otherValue, true)
  assert.equal(other.camera.device.onNewNotification.observed, false)
})

test('a snapshot by uuid that comes while another load runs is loaded after it', async () => {
  const source = Object.create(CameraSource.prototype),
    loads = [],
    finish = {}
  source.loadAndCacheSnapshot = (uuid) => {
    loads.push(uuid ?? 'live')
    return new Promise((resolve) => (finish[uuid ?? 'live'] = resolve))
  }
  const live = source.loadSnapshot() // HomeKit's request, without a uuid
  const byUuid = source.loadSnapshot('snap-late') // the notification's snapshot
  const again = source.loadSnapshot() // another request joins the running load
  await settle()
  assert.deepEqual(loads, ['live'])
  finish.live()
  await live
  await again
  await settle()
  assert.deepEqual(loads, ['live', 'snap-late'])
  finish['snap-late']()
  await byUuid
})
