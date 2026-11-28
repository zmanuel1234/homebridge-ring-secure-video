import assert from 'node:assert/strict'
import test from 'node:test'
import { BehaviorSubject } from 'rxjs'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { setHap } from '../src/hap.js'
import type { RingDevice } from 'ring-client-api'
import { Fan } from '../src/fan.js'
import { LEVEL_TARGET_TIMEOUT_MS } from '../src/base-data-accessory.js'
import { config, fake, platformAccessory, serviceOf, useMockFriendlyIntervals } from './helpers.js'

setHap(hapNodejs)

// A Ring fan (multi-level switch) whose writes go to setInfo, on a real HAP accessory.
/** What the plugin sends Ring for a level change. */
interface SetInfoBody {
  device: { v1: { level?: number; on?: boolean } }
}

function fan(setInfo: (body: SetInfoBody) => Promise<unknown>) {
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
    accessory = platformAccessory(hap, 'Ceiling Fan')
  new Fan(fake<RingDevice>(device), accessory, config({ disableLogs: true }))
  const speed = serviceOf(hap, hapNodejs.Service.Fan).getCharacteristic(hapNodejs.Characteristic.RotationSpeed)
  return { speed, onData, data }
}

// HomeKit's write: the SET handler, as a controller would call it. The handler answers HomeKit
// at once and sends the debounced write later, so it doesn't reject itself.
const write = (characteristic: hapNodejs.Characteristic, value: number) => characteristic.handleSetRequest(value)

async function settle(t: test.TestContext, ms: number) {
  t.mock.timers.tick(ms)
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

test('a rejected speed write is logged, not a crash, and the speed goes back', async (t) => {
  useMockFriendlyIntervals(t)
  const unhandled: unknown[] = []
  const onUnhandled = (e: unknown) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))

  const calls: SetInfoBody[] = []
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
  useMockFriendlyIntervals(t)
  const pending: { body: SetInfoBody; resolve: (value?: unknown) => void; reject: (reason: Error) => void }[] = []
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
  useMockFriendlyIntervals(t)
  const { speed, onData, data } = fan(async () => {})
  await write(speed, 70)
  await settle(t, 500)
  onData.next({ ...data, level: 0.7 })
  await settle(t, 0)
  assert.equal(speed.value, 70)
})

test("a level that doesn't survive Ring's 0-1 round trip still matches, so later changes show", async (t) => {
  useMockFriendlyIntervals(t)
  const { speed, onData, data } = fan(async () => {})
  await write(speed, 57)
  await settle(t, 500)
  onData.next({ ...data, level: 0.57 }) // 0.57 * 100 is 56.99999999999999
  await settle(t, 0)
  assert.equal(speed.value, 57)

  onData.next({ ...data, level: 0.3 }) // changed at the device or in the Ring app
  await settle(t, 0)
  assert.equal(speed.value, 30, 'the request no longer hides what Ring reports')
})

test('a level Ring never reports is replaced by the one it does, after 30 s', async (t) => {
  useMockFriendlyIntervals(t)
  const { speed } = fan(async () => {}) // Ring accepts the request but its level stays 50
  await write(speed, 80)
  await settle(t, 500)
  assert.equal(speed.value, 80, 'the request is shown while Ring may still report it')
  await settle(t, LEVEL_TARGET_TIMEOUT_MS)
  assert.equal(speed.value, 50)
})
