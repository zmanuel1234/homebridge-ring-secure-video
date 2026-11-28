import assert from 'node:assert/strict'
import test from 'node:test'
import { Subject, type Subscription } from 'rxjs'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { useLogger } from 'ring-client-api/util'
import { setHap } from '../src/hap.js'
import { Camera, getUsableSnapshotUuid, SNAPSHOT_NOTIFICATION_WAIT_MS } from '../src/camera.js'
import { bareCameraSource, internals } from './helpers.js'

/** A notification as the camera's snapshot code reads it. */
interface Notification {
  img?: { snapshot_uuid?: string }
}

/** Camera's event and snapshot handling, and the private state the tests check. */
interface CameraInternals {
  device: {
    name: string
    canTakeSnapshotWhileRecording: boolean
    latestNotificationSnapshotUuid?: string
    onNewNotification: Subject<Notification>
    data: unknown
  }
  cameraSource: { loadSnapshot(uuid?: string): Promise<void> }
  snapshotNotificationsArrive: boolean
  missedSnapshotWaits: number
  lastMissedSnapshotWaitAt: number
  pendingSnapshotNotification?: Subscription
  loadSnapshotForEvent<T>(description: string, value: T): Promise<T>
}

setHap(hapNodejs)
useLogger({ logInfo() {}, logError() {} })

// A camera event as Camera.loadSnapshotForEvent sees it, without the rest of the accessory.
function fakeCamera({ onBattery, snapshotUuid }: { onBattery: boolean; snapshotUuid?: string }) {
  const loaded: (string | undefined)[] = []
  const camera = internals<CameraInternals>(Object.create(Camera.prototype))
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
    loadSnapshot: async (uuid?: string) => {
      loaded.push(uuid)
    },
  }
  return { camera, loaded }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('a battery camera event goes to HomeKit at once until snapshots are seen to come', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { camera, loaded } = fakeCamera({ onBattery: true })
  let value: boolean | undefined
  void camera.loadSnapshotForEvent('Detected Motion', true).then((v) => (value = v))
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
  // rxjs's deprecated observers list, where it still has one
  const { observers } = internals<{ observers?: unknown[] }>(subject)
  assert.equal(observers?.length ?? (subject.observed ? 1 : 0), 1)
  assert.ok(camera.pendingSnapshotNotification, 'a background wait is pending')
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
  const run = (description: string) => {
    const result: { value?: string } = {}
    void camera.loadSnapshotForEvent(description, description).then((v) => (result.value = v))
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
  assert.ok(camera.pendingSnapshotNotification, 'a background wait is pending')
  camera.pendingSnapshotNotification.unsubscribe()
})

test('a snapshot by uuid that comes while another load runs is loaded after it', async () => {
  const source = bareCameraSource(),
    loads: string[] = [],
    finish: Record<string, () => void> = {}
  source.loadAndCacheSnapshot = (uuid?: string) => {
    loads.push(uuid ?? 'live')
    return new Promise<void>((resolve) => (finish[uuid ?? 'live'] = resolve))
  }
  const { loadSnapshot } = internals<{ loadSnapshot(this: unknown, uuid?: string): Promise<void> }>(source)
  const live = loadSnapshot.call(source) // HomeKit's request, without a uuid
  const byUuid = loadSnapshot.call(source, 'snap-late') // the notification's snapshot
  const again = loadSnapshot.call(source) // another request joins the running load
  await settle()
  assert.deepEqual(loads, ['live'])
  finish.live?.()
  await live
  await again
  await settle()
  assert.deepEqual(loads, ['live', 'snap-late'])
  finish['snap-late']?.()
  await byUuid
})

test('a camera whose snapshots come 3 s after its events stops waiting after 3 of them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { camera } = fakeCamera({ onBattery: true })
  Object.assign(camera, { snapshotNotificationsArrive: true }) // learned earlier
  const values: number[] = []
  for (let i = 1; i <= 4; i++) {
    t.mock.timers.tick(20000)
    void camera.loadSnapshotForEvent(`event-${i}`, i).then((v) => values.push(v))
    await settle()
    t.mock.timers.tick(2000) // the wait misses
    await settle()
    t.mock.timers.tick(1000) // the snapshot comes 3 s after the event
    camera.device.onNewNotification.next({ img: { snapshot_uuid: `snap-${i}` } })
    await settle()
  }
  assert.equal(camera.snapshotNotificationsArrive, false, 'stopped waiting')
  // the 4th event already went at once
  t.mock.timers.tick(20000)
  let value: number | undefined
  void camera.loadSnapshotForEvent('event-5', 5).then((v) => (value = v))
  await settle()
  assert.equal(value, 5)
  camera.pendingSnapshotNotification?.unsubscribe()
})

const zeroUuid = '00000000000000000000000000000000'

test("Ring's all-zero placeholder snapshot uuid counts as none", () => {
  assert.equal(getUsableSnapshotUuid(zeroUuid), undefined)
  assert.equal(getUsableSnapshotUuid(`${zeroUuid}:1234`), undefined)
  assert.equal(getUsableSnapshotUuid('00000000-0000-0000-0000-000000000000'), undefined)
  assert.equal(getUsableSnapshotUuid(''), undefined)
  assert.equal(getUsableSnapshotUuid(undefined), undefined)
  assert.equal(getUsableSnapshotUuid('a1b2c3:1234'), 'a1b2c3:1234')
})

test('an event with an all-zero snapshot uuid goes at once and loads nothing', async () => {
  // wired: it would load the notification's snapshot before sending the event
  const { camera, loaded } = fakeCamera({ onBattery: false, snapshotUuid: zeroUuid })
  const value = await camera.loadSnapshotForEvent('Detected Motion', true)
  assert.equal(value, true)
  assert.deepEqual(loaded, [undefined], 'a new snapshot, as without a uuid')
})

test('an all-zero snapshot uuid after an event teaches no wait and loads nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { camera, loaded } = fakeCamera({ onBattery: true })
  await camera.loadSnapshotForEvent('Detected Motion', true)
  camera.device.onNewNotification.next({ img: { snapshot_uuid: zeroUuid } })
  await settle()
  assert.deepEqual(loaded, [])
  assert.equal(camera.snapshotNotificationsArrive, false, 'events still go at once')
  camera.device.onNewNotification.next({ img: { snapshot_uuid: 'real' } })
  await settle()
  assert.deepEqual(loaded, ['real'], 'a real one that follows is still loaded')
})
