import assert from 'node:assert/strict'
import test from 'node:test'
import { Subject } from 'rxjs'
import type { RingCamera } from 'ring-client-api'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { setHap } from '../src/hap.js'
import {
  addDoorbellPressMotion,
  addMotionWatchdog,
  Camera,
  getPushMotionEvents,
} from '../src/camera.js'
import type { RingPlatformConfig } from '../src/config.js'
import { config, platformAccessory, pushNotification, ringCamera, useMockFriendlyIntervals } from './helpers.js'

setHap(hapNodejs)

function fakeCamera() {
  return ringCamera({ id: 1, device_id: 'abc123', description: 'Front Door', kind: 'doorbell_scallop', settings: {} })
}

// Push notifications as ring-client-api receives them.
const push = (category: string, id: number) =>
  pushNotification({
    android_config: { category: `com.ring.pn.live-event.${category}` },
    data: { event: { ding: { id, detection_type: category } }, device: { id: 1 } },
  })

// The camera's motion as HomeKit gets it with doorbellPressMotion on, on a timeline in seconds.
function run(t: test.TestContext, camera: RingCamera) {
  useMockFriendlyIntervals(t)
  const timeline: (number|boolean)[][] = [],
    pressMotions: number[] = []
  const subscription = addDoorbellPressMotion(
    addMotionWatchdog(getPushMotionEvents(camera)),
    camera.onDoorbellPressed,
    () => pressMotions.push(Date.now() / 1000),
  ).subscribe((value) => timeline.push([Date.now() / 1000, value]))
  t.after(() => {
    subscription.unsubscribe()
    camera.disconnect()
  })
  const at = (seconds: number) => {
    while (Date.now() / 1000 < seconds) t.mock.timers.tick(5000)
  }
  return { timeline, pressMotions, at }
}

test('a doorbell press turns the camera motion on, and off 30 s later', (t) => {
  const camera = fakeCamera(),
    { timeline, pressMotions, at } = run(t, camera)

  camera.processPushNotification(push('ding', 1))
  at(60)
  assert.deepEqual(timeline, [
    [0, false],
    [0, true],
    [30, false],
  ])
  assert.deepEqual(pressMotions, [0])
})

test('a press while motion is already on keeps it on, without an off and on again', (t) => {
  const camera = fakeCamera(),
    { timeline, at } = run(t, camera)

  camera.processPushNotification(push('motion', 11)) // the visitor walks up
  at(10)
  camera.processPushNotification(push('ding', 12)) // and rings
  at(120)
  assert.deepEqual(timeline, [
    [0, false],
    [0, true],
    // Ring's motion goes off at 30 s and its alert expires at 65 s; the press keeps motion on
    // until 40 s. No second true: HomeKit keeps one recording.
    [40, false],
  ])
})

test('repeated presses and repeated Ring notifications give one recording', (t) => {
  const camera = fakeCamera(),
    { timeline, at } = run(t, camera)

  camera.processPushNotification(push('ding', 21))
  camera.processPushNotification(push('ding', 21)) // the same press again (snapshot follow-up)
  at(5)
  camera.processPushNotification(push('ding', 22)) // pressed again
  at(10)
  camera.processPushNotification(push('ding', 23))
  at(80)
  assert.deepEqual(timeline, [
    [0, false],
    [0, true],
    [40, false], // 30 s after the last press
  ])
})

test("Ring's motion alert expiring during a press does not cut the press short", (t) => {
  const camera = fakeCamera(),
    { timeline, at } = run(t, camera)

  camera.processPushNotification(push('motion', 61)) // Ring's alert stays active until 65 s
  at(50)
  camera.processPushNotification(push('ding', 62))
  at(100)
  assert.deepEqual(timeline, [
    [0, false],
    [0, true],
    [30, false],
    [50, true],
    [80, false], // 30 s after the press, although the alert expired at 65 s
  ])
})

test('a failing press stream does not stop the camera motion', (t) => {
  useMockFriendlyIntervals(t)
  const motion = new Subject<boolean>(),
    presses = new Subject(),
    values: boolean[] = []
  const subscription = addDoorbellPressMotion(motion, presses).subscribe((v) => values.push(v))
  t.after(() => subscription.unsubscribe())
  presses.error(new Error('press stream failed'))
  motion.next(true)
  motion.next(false)
  assert.deepEqual(values, [false, true, false])
})

test('motion from Ring after a press-only visit records as before', (t) => {
  const camera = fakeCamera(),
    { timeline, at } = run(t, camera)

  camera.processPushNotification(push('ding', 31))
  at(60) // off at 30 s
  camera.processPushNotification(push('motion', 32))
  at(100)
  assert.deepEqual(timeline, [
    [0, false],
    [0, true],
    [30, false],
    [60, true],
    [90, false],
  ])
})

// The Camera accessory itself, on a real HAP accessory.
function cameraAccessory(t: test.TestContext, settings: Partial<RingPlatformConfig>, kind = 'doorbell_scallop') {
  useMockFriendlyIntervals(t)
  const camera_ = ringCamera({ id: 1, device_id: 'abc123', description: 'Front Door', kind, settings: {} }, kind.startsWith('doorbell'))
  const hap = new hapNodejs.Accessory('Front Door', hapNodejs.uuid.generate(`front-door-${Math.random()}`))
  const accessory = platformAccessory(hap, 'Front Door')
  const camera = new Camera(
    camera_,
    accessory,
    config({
      platform: 'Ring Secure Video',
      enableCameraMotionHistory: false,
      enableHksv: true,
      disableLogs: true,
      ...settings,
    }),
  )
  const notificationValues: boolean[] = []
  const notifications = camera.motionDetected?.subscribe((v) => notificationValues.push(v))
  t.after(() => {
    notifications?.unsubscribe()
    camera_.disconnect()
  })
  const motion = () =>
    hap.getService(hapNodejs.Service.MotionSensor)?.getCharacteristic(hapNodejs.Characteristic.MotionDetected).value
  return { ringCamera: camera_, motion, notificationValues }
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

test('Camera: with doorbellPressMotion off (the default), a press does not touch motion', async (t) => {
  const { ringCamera, motion } = cameraAccessory(t, {})
  ringCamera.processPushNotification(push('ding', 41))
  await settle()
  assert.equal(motion(), false)
})

test("Camera: with doorbellPressMotion on, a press sets the camera's motion, not the notification sensor's", async (t) => {
  const { ringCamera, motion, notificationValues } = cameraAccessory(t, {
    doorbellPressMotion: true,
    cameraMotionNotificationSensor: true,
  })
  ringCamera.processPushNotification(push('ding', 51))
  await settle()
  assert.equal(motion(), true)
  assert.equal(notificationValues.includes(true), false, 'the notification sensor gets no motion')
  t.mock.timers.tick(30_000)
  await settle()
  assert.equal(motion(), false)
})

for (const [label, settings, kind, expected] of [
  ['without HKSV recording', { doorbellPressMotion: true, enableHksv: false }, 'doorbell_scallop', false],
  ['on a camera without a doorbell', { doorbellPressMotion: true }, 'stickup_cam_v4', false],
  ['with the motion sensor hidden', { doorbellPressMotion: true, hideCameraMotionSensor: true }, 'doorbell_scallop', undefined],
] satisfies [string, Partial<RingPlatformConfig>, string, boolean | undefined][]) {
  test(`Camera: no press motion ${label}`, async (t) => {
    const { ringCamera, motion } = cameraAccessory(t, settings, kind)
    ringCamera.processPushNotification(push('ding', 71))
    await settle()
    assert.equal(motion(), expected)
  })
}
