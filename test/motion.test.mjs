import assert from 'node:assert/strict'
import test from 'node:test'
import { Subject } from 'rxjs'
import { RingCamera } from 'ring-client-api'
import { addMotionWatchdog, getPushMotionEvents, MOTION_WATCHDOG_MS } from '../lib/camera.js'

function fakeCamera() {
  const restClient = { onSession: new Subject(), request: async () => ({}) }
  return new RingCamera(
    { id: 1, description: 'Front Door', kind: 'doorbell_scallop', settings: {} },
    true,
    restClient,
    false,
  )
}

// A push notification as ring-client-api receives it for a new motion alert.
function motionPush(id) {
  return {
    android_config: { category: 'com.ring.pn.live-event.motion' },
    data: { event: { ding: { id, detection_type: 'motion' } }, device: { id: 1 } },
  }
}

test('a new motion alert while an earlier one is still active turns motion on again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const camera = fakeCamera()
  const timeline = []
  // Seconds on the mocked clock, which starts at 0.
  const subscription = addMotionWatchdog(getPushMotionEvents(camera)).subscribe((value) => {
    timeline.push([Date.now() / 1000, value])
  })
  // In 5 s steps, so each event is stamped with the step it happened in.
  const advance = (seconds) => {
    for (let s = 0; s < seconds; s += 5) t.mock.timers.tick(5000)
  }

  try {
    camera.processPushNotification(motionPush(101))
    advance(MOTION_WATCHDOG_MS / 1000) // 30 s: the watchdog turns motion off
    advance(10) // 40 s: the first alert is still active in ring-client-api (65 s)
    camera.processPushNotification(motionPush(102))
    advance(70) // 110 s: both alerts have expired (the second at 105 s)
    assert.deepEqual(timeline, [
      [0, false], // nothing active when subscribing
      [0, true],
      [30, false],
      [40, true], // the second visit
      [70, false],
      [105, false], // ring-client-api: no alert active any more
    ])
  } finally {
    subscription.unsubscribe()
    camera.disconnect?.()
  }
})

test('the same alert again (snapshot follow-up or resend) is not a new visit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const camera = fakeCamera()
  const timeline = []
  const subscription = addMotionWatchdog(getPushMotionEvents(camera)).subscribe((value) => {
    timeline.push([Date.now() / 1000, value])
  })
  const advance = (seconds) => {
    for (let s = 0; s < seconds; s += 5) t.mock.timers.tick(5000)
  }

  try {
    camera.processPushNotification(motionPush(301))
    advance(5)
    camera.processPushNotification(motionPush(301)) // follow-up with the snapshot
    advance(35) // 40 s
    camera.processPushNotification(motionPush(301)) // resent after a reconnect
    advance(30) // 70 s
    assert.deepEqual(timeline, [
      [0, false],
      [0, true],
      [30, false],
      [65, false], // ring-client-api: the alert expired
    ])
  } finally {
    subscription.unsubscribe()
    camera.disconnect?.()
  }
})

test('a doorbell press is not motion', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const camera = fakeCamera()
  const values = []
  const subscription = getPushMotionEvents(camera).subscribe((value) => values.push(value))
  try {
    camera.processPushNotification({
      ...motionPush(201),
      android_config: { category: 'com.ring.pn.live-event.ding' },
    })
    t.mock.timers.tick(70_000)
    assert.deepEqual(values, [false])
  } finally {
    subscription.unsubscribe()
    camera.disconnect?.()
  }
})
