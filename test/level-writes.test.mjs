import assert from 'node:assert/strict'
import test from 'node:test'
import { BehaviorSubject } from 'rxjs'
// Not public rxjs API, but the only way to give rxjs mock-timer-friendly intervals (as in the
// other tests): rxjs's debounceTime schedules with setInterval and Date.
import { intervalProvider } from 'rxjs/internal/scheduler/intervalProvider'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { setHap } from '../lib/hap.js'
import { Fan } from '../lib/fan.js'

setHap(hapNodejs)

function useMockTimers(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
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

// A Ring fan (multi-level switch) whose writes go to setInfo, on a real HAP accessory.
function fan(setInfo) {
  const data = { name: 'Ceiling Fan', zid: 'zid-fan', on: true, level: 0.5 },
    onData = new BehaviorSubject(data),
    device = {
      name: 'Ceiling Fan',
      zid: 'zid-fan',
      get data() {
        return onData.value
      },
      onData,
      setInfo,
    },
    hap = new hapNodejs.Accessory('Ceiling Fan', hapNodejs.uuid.generate(`fan-${Math.random()}`)),
    accessory = {
      displayName: 'Ceiling Fan',
      UUID: hap.UUID,
      context: {},
      getService: (s) => hap.getService(s),
      getServiceById: (s, sub) => hap.getServiceById(s, sub),
      addService: (...a) => hap.addService(...a),
      removeService: (s) => hap.removeService(s),
    }
  new Fan(device, accessory, { disableLogs: true })
  const speed = hap.getService(hapNodejs.Service.Fan).getCharacteristic(hapNodejs.Characteristic.RotationSpeed)
  return { speed, onData, data }
}

// HomeKit's write: the SET handler, as a controller would call it. The handler answers HomeKit
// at once and sends the debounced write later, so it doesn't reject itself.
const write = (characteristic, value) => characteristic.handleSetRequest(value)

async function settle(t, ms) {
  t.mock.timers.tick(ms)
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

test('a rejected speed write is logged, not a crash, and the speed goes back', async (t) => {
  useMockTimers(t)
  const unhandled = []
  const onUnhandled = (e) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))

  const calls = []
  const { speed } = fan(async (body) => {
    calls.push(body)
    throw new Error('Ring API down')
  })
  assert.equal(speed.value, 50)

  await write(speed, 80)
  await settle(t, 500) // the write is debounced
  assert.deepEqual(calls, [{ device: { v1: { level: 0.8 } } }])
  assert.deepEqual(unhandled, [], 'no unhandled rejection (it would take Homebridge down)')
  assert.equal(speed.value, 50, 'back to the last level Ring reported')
})

test('a write that fails after a newer one was sent does not undo the newer one', async (t) => {
  useMockTimers(t)
  const pending = []
  const { speed, onData, data } = fan((body) => new Promise((resolve, reject) => pending.push({ body, resolve, reject })))

  await write(speed, 80)
  await settle(t, 500)
  await write(speed, 30)
  await settle(t, 500)
  assert.deepEqual(pending.map((p) => p.body.device.v1.level), [0.8, 0.3])

  pending[0].reject(new Error('Ring API down')) // the older write fails late
  await settle(t, 0)
  assert.equal(speed.value, 30, 'the newer request stays')

  pending[1].resolve() // the newer write succeeds, and Ring then reports its level
  onData.next({ ...data, level: 0.3 })
  await settle(t, 0)
  assert.equal(speed.value, 30)
})

test('a successful write keeps the requested speed', async (t) => {
  useMockTimers(t)
  const { speed, onData, data } = fan(async () => {})
  await write(speed, 70)
  await settle(t, 500)
  onData.next({ ...data, level: 0.7 })
  await settle(t, 0)
  assert.equal(speed.value, 70)
})
