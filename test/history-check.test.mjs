import assert from 'node:assert/strict'
import test from 'node:test'
import { Subject } from 'rxjs'
import { intervalProvider } from 'rxjs/internal/scheduler/intervalProvider'
import { getHistoryMotionEvents } from '../lib/camera.js'

// rxjs times with setInterval; Node 20's mocked setInterval runs an interval once more after it
// was cleared. So rxjs gets intervals built from the mocked setTimeout, for these tests only.
function useMockFriendlyIntervals(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000_000_000 })
  intervalProvider.delegate = {
    setInterval(handler, timeout, ...args) {
      const interval = { timer: undefined, cleared: false }
      const schedule = () => {
        interval.timer = setTimeout(() => {
          if (interval.cleared) return
          schedule()
          handler(...args)
        }, timeout)
      }
      schedule()
      return interval
    },
    clearInterval(interval) {
      interval.cleared = true
      clearTimeout(interval.timer)
    },
  }
  t.after(() => {
    intervalProvider.delegate = undefined
  })
}

// A camera whose Ring event history holds `events`; counts history requests.
function fakeCamera() {
  const camera = {
    name: 'Front Door',
    onNewNotification: new Subject(),
    events: [],
    requests: 0,
    async getEvents() {
      camera.requests++
      return { events: [...camera.events].reverse() }
    },
  }
  return camera
}

const startedAt = 1_000_000_000_000
const motionEvent = (id, secondsAfterStart) => ({
  ding_id: Number(id),
  ding_id_str: String(id),
  kind: 'motion',
  created_at: new Date(startedAt + secondsAfterStart * 1000).toISOString(),
})
const motionPush = (id) => ({
  android_config: { category: 'com.ring.pn.live-event.motion' },
  data: { event: { ding: { id: String(id) } } },
})

function run(t, camera) {
  useMockFriendlyIntervals(t)
  const motion = []
  const subscription = getHistoryMotionEvents(camera, 20).subscribe(() =>
    motion.push(Math.round((Date.now() - startedAt) / 1000)),
  )
  t.after(() => subscription.unsubscribe())
  const at = async (seconds) => {
    while (Date.now() - startedAt < seconds * 1000) {
      t.mock.timers.tick(5000)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  return { motion, at }
}

test('without push notifications, the history is checked every 20 s and gives motion', async (t) => {
  const camera = fakeCamera()
  const { motion, at } = run(t, camera)

  await at(25)
  camera.events.push(motionEvent(1, 25))
  await at(300)
  assert.deepEqual(motion, [40])
  assert.equal(camera.requests, 15)
})

// Two motion events that also came by push: from then on push is trusted.
async function trustPush(camera, at) {
  await at(10)
  camera.onNewNotification.next(motionPush(1))
  camera.events.push(motionEvent(1, 10))
  await at(60)
  camera.onNewNotification.next(motionPush(2))
  camera.events.push(motionEvent(2, 60))
  await at(100)
}

test('once two motion events also came by push, the history is checked every 5 minutes', async (t) => {
  const camera = fakeCamera()
  const { motion, at } = run(t, camera)

  await trustPush(camera, at)
  const requests = camera.requests
  await at(100 + 30 * 60)
  assert.deepEqual(motion, [], 'push already gave this motion')
  assert.equal(camera.requests, requests + 6, 'every 5 minutes')
})

test('a push with another id at about the same time counts as delivered', async (t) => {
  const camera = fakeCamera()
  const { motion, at } = run(t, camera)

  await at(10)
  camera.onNewNotification.next(motionPush('push-a'))
  camera.events.push(motionEvent(11, 12))
  await at(60)
  camera.onNewNotification.next(motionPush('push-b'))
  camera.events.push(motionEvent(12, 61))
  await at(100 + 10 * 60)
  assert.deepEqual(motion, [])
  assert.ok(camera.requests < 10, `${camera.requests} requests`)
})

test('a push that arrives after the event is in the history still counts', async (t) => {
  const camera = fakeCamera()
  const { motion, at } = run(t, camera)

  await at(15)
  camera.events.push(motionEvent(21, 15)) // in the history before its push
  await at(20) // check: too young to judge, gives motion once
  camera.onNewNotification.next(motionPush(21))
  await at(80)
  camera.onNewNotification.next(motionPush(22))
  camera.events.push(motionEvent(22, 80))
  await at(120)
  assert.deepEqual(motion, [20])
  const requests = camera.requests
  await at(120 + 10 * 60)
  assert.equal(camera.requests, requests + 2, 'both counted as pushed: every 5 minutes')
})

test('motion push stops arriving: the next check switches back, and only recent events give motion', async (t) => {
  const camera = fakeCamera()
  const { motion, at } = run(t, camera)

  await trustPush(camera, at)
  await at(160)
  camera.events.push(motionEvent(3, 160)) // no push for this one (the last was 100 s before)
  await at(420) // the 5-minute check (at 400) finds it 4 minutes late: no motion, frequent again
  assert.deepEqual(motion, [])

  const requests = camera.requests
  await at(500)
  assert.equal(camera.requests, requests + 4, 'every 20 s again')
  camera.events.push(motionEvent(4, 500))
  await at(520)
  assert.deepEqual(motion, [520])
})

test('a Pi clock ahead of Ring does not silence the fallback while checking frequently', async (t) => {
  const camera = fakeCamera()
  const { motion, at } = run(t, camera)

  await at(400)
  camera.events.push(motionEvent(31, 400 - 5 * 60)) // Ring's time: 5 minutes behind the Pi
  await at(420)
  assert.deepEqual(motion, [420])
})

test('an error thrown by the history request does not stop push motion', async (t) => {
  const camera = fakeCamera()
  camera.getEvents = () => {
    camera.requests++
    throw new Error('thrown before any request')
  }
  const { at } = run(t, camera)
  await at(20)
  await at(60)
  assert.equal(camera.requests, 2, 'still checking after the error')
})

test('an event that stays in the history for hours gives motion once', async (t) => {
  const camera = fakeCamera()
  const { motion, at } = run(t, camera)

  await at(25)
  camera.events.push(motionEvent(41, 25)) // a quiet camera: it stays among the 10 newest
  await at(2 * 60 * 60)
  assert.deepEqual(motion, [40])
})

test('one push matching two events counts as one confirmation', async (t) => {
  const camera = fakeCamera()
  const { at } = run(t, camera)

  await at(10)
  camera.onNewNotification.next(motionPush('p1'))
  camera.events.push(motionEvent(51, 10), motionEvent(52, 40))
  await at(100)
  const requests = camera.requests
  await at(200)
  assert.equal(camera.requests, requests + 5, 'still checking every 20 s')
})

test('an unpushed event seen by a 5-minute check is judged soon after', async (t) => {
  const camera = fakeCamera()
  const { motion, at } = run(t, camera)

  await trustPush(camera, at) // trusted at the check at 80 s; the next is at 380 s
  await at(375)
  camera.events.push(motionEvent(61, 375)) // no push
  await at(380)
  assert.deepEqual(motion, [380], 'recent, so it gives motion')
  const requests = camera.requests
  await at(420)
  assert.equal(camera.requests, requests + 1, 'checked again 40 s later, not in 5 minutes')
  await at(500)
  assert.equal(camera.requests, requests + 5, 'and every 20 s once judged as missed')
  assert.deepEqual(motion, [380], 'motion only once')
})

test('a failed check is retried later instead of every 20 s', async (t) => {
  const camera = fakeCamera()
  let fail = true
  camera.getEvents = async () => {
    camera.requests++
    if (fail) throw new Error('Ring returned 500')
    return { events: [] }
  }
  const { at } = run(t, camera)
  await at(20)
  assert.equal(camera.requests, 1)
  await at(45)
  assert.equal(camera.requests, 1, 'waits 30 s after a failure')
  fail = false
  await at(60)
  assert.equal(camera.requests, 2)
})
