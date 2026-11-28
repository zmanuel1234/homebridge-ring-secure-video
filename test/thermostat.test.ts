import assert from 'node:assert/strict'
import test from 'node:test'
import { BehaviorSubject, of } from 'rxjs'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { useLogger } from 'ring-client-api/util'
import { setHap } from '../src/hap.js'
import type { RingDevice } from 'ring-client-api'
import { Thermostat } from '../src/thermostat.js'
import { config, fake, platformAccessory, serviceOf, useMockFriendlyIntervals } from './helpers.js'

setHap(hapNodejs)
useLogger({ logInfo() {}, logError() {} })

// A Ring thermostat whose writes go to setInfo, on a real HAP accessory.
function thermostat() {
  const calls: unknown[] = [],
    data: Record<string, unknown> = { name: 'Thermostat', zid: 'zid-thermostat', mode: 'heat', setPoint: 20 },
    onData = new BehaviorSubject(data),
    device = {
      name: 'Thermostat',
      zid: 'zid-thermostat',
      get data() {
        return onData.value
      },
      onData,
      onComponentDevices: of([]),
      setInfo: async (body: unknown) => {
        calls.push(body)
      },
    },
    hap = new hapNodejs.Accessory('Thermostat', hapNodejs.uuid.generate(`thermostat-${Math.random()}`)),
    accessory = platformAccessory(hap, 'Thermostat')
  new Thermostat(fake<RingDevice>(device), accessory, config({ disableLogs: true }))
  const target = serviceOf(hap, hapNodejs.Service.Thermostat).getCharacteristic(hapNodejs.Characteristic.TargetTemperature)
  return { target, calls, onData }
}

async function settle(t: test.TestContext, ms: number) {
  t.mock.timers.tick(ms)
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

test('a temperature slider sends Ring only the setpoint it settles on', async (t) => {
  useMockFriendlyIntervals(t)
  const { target, calls } = thermostat()

  // dragged from 20 to 23 °C in half-degree steps
  for (const value of [20.5, 21, 21.5, 22, 22.5, 23]) {
    await target.handleSetRequest(value)
    await settle(t, 100)
  }
  assert.deepEqual(calls, [], 'nothing while the slider moves')
  assert.equal(target.value, 23, 'HomeKit shows the request meanwhile')

  await settle(t, 500)
  assert.deepEqual(calls, [{ device: { v1: { setPoint: 23 } } }])
})

test("a Ring report still on the old setpoint doesn't move the slider back", async (t) => {
  useMockFriendlyIntervals(t)
  const { target, calls, onData } = thermostat()

  await target.handleSetRequest(23)
  await settle(t, 100)
  // another field changed; Ring hasn't acted on the request yet
  onData.next({ ...onData.value, state: 'heating' })
  assert.equal(target.value, 23, 'while the slider settles')

  await settle(t, 500)
  assert.equal(calls.length, 1)
  onData.next({ ...onData.value, state: 'idle' })
  assert.equal(target.value, 23, 'once sent, before Ring confirms')

  // Ring never takes the setpoint: its own is shown again after the hold
  await settle(t, 10_000)
  assert.equal(target.value, 20)
})
