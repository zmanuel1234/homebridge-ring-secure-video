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
function fakeCamera({ onBattery, snapshotUuid }) {
  const loaded = []
  const camera = Object.create(Camera.prototype)
  camera.device = {
    name: 'Front Door',
    canTakeSnapshotWhileRecording: !onBattery,
    latestNotificationSnapshotUuid: snapshotUuid,
    onNewNotification: new Subject(),
    // ring-client-api sets this for every camera (it subscribes to ding events), so it says
    // nothing about Ring Protect and must not matter
    data: { subscribed: true },
  }
  // the per-camera state the constructor would set up
  Object.assign(camera, { snapshotNotificationsArrive: false, missedSnapshotWaits: 0, lastMissedSnapshotWaitAt: 0 })
  camera.cameraSource = {
    loadSnapshot: async (uuid) => {
      loaded.push(uuid)
    },
  }
  return { camera, loaded }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('a battery camera event goes to HomeKit at once until snapshots are seen to come', async (t) => {
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

test('once snapshots come (Ring Protect), events wait up to 2 s for one; 3 misses end that', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { camera, loaded } = fakeCamera({ onBattery: true })
  const run = (description) => {
    const result = { value: undefined }
    camera.loadSnapshotForEvent(description, description).then((v) => (result.value = v))
    return result
  }

  // a snapshot 5 s after an event is loaded, but doesn't make the camera wait (it'd miss it)
  const late = run('late')
  await settle()
  t.mock.timers.tick(5000)
  camera.device.onNewNotification.next({ img: { snapshot_uuid: 'snap-late' } })
  await settle()
  assert.equal(late.value, 'late')
  assert.deepEqual(loaded, ['snap-late'])
  loaded.length = 0
  t.mock.timers.tick(10000)

  // first event: sent at once; a snapshot follows within 1 s, so the camera learns that they come
  const first = run('first')
  await settle()
  assert.equal(first.value, 'first')
  t.mock.timers.tick(1000)
  camera.device.onNewNotification.next({ img: { snapshot_uuid: 'snap-1' } })
  await settle()
  assert.deepEqual(loaded, ['snap-1'])

  // next event waits for its snapshot and loads it before the event
  const second = run('second')
  await settle()
  assert.equal(second.value, undefined, 'waiting for the snapshot')
  t.mock.timers.tick(1000)
  camera.device.onNewNotification.next({ img: { snapshot_uuid: 'snap-2' } })
  await settle()
  await settle()
  assert.deepEqual(loaded, ['snap-1', 'snap-2'])
  assert.equal(second.value, 'second')

  // three events with no snapshot (each a press and its motion, waiting together): after them,
  // events go at once again
  for (const name of ['miss-1', 'miss-2', 'miss-3']) {
    t.mock.timers.tick(10000)
    const press = run(name),
      motion = run(`${name}-motion`)
    await settle()
    assert.equal(press.value, undefined, `${name} waits`)
    t.mock.timers.tick(2000)
    await settle()
    assert.equal(press.value, name)
    assert.equal(motion.value, `${name}-motion`)
  }
  t.mock.timers.tick(10000)
  const after = run('after')
  await settle()
  assert.equal(after.value, 'after', 'sent at once again')
  camera.pendingSnapshotNotification.unsubscribe()
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
