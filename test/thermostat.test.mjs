import assert from 'node:assert/strict'
import test from 'node:test'
import { BehaviorSubject, of } from 'rxjs'
// Not public rxjs API, but the only way to give rxjs mock-timer-friendly intervals (as in the
// other tests): rxjs's debounceTime schedules with setInterval and Date.
import { intervalProvider } from 'rxjs/internal/scheduler/intervalProvider'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { useLogger } from 'ring-client-api/util'
import { setHap } from '../lib/hap.js'
import { Thermostat } from '../lib/thermostat.js'

setHap(hapNodejs)
useLogger({ logInfo() {}, logError() {} })

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

// A Ring thermostat whose writes go to setInfo, on a real HAP accessory.
function thermostat() {
  const calls = [],
    data = { name: 'Thermostat', zid: 'zid-thermostat', mode: 'heat', setPoint: 20 },
    onData = new BehaviorSubject(data),
    device = {
      name: 'Thermostat',
      zid: 'zid-thermostat',
      get data() {
        return onData.value
      },
      onData,
      onComponentDevices: of([]),
      setInfo: async (body) => {
        calls.push(body)
      },
    },
    hap = new hapNodejs.Accessory('Thermostat', hapNodejs.uuid.generate(`thermostat-${Math.random()}`)),
    accessory = {
      displayName: 'Thermostat',
      UUID: hap.UUID,
      context: {},
      getService: (s) => hap.getService(s),
      getServiceById: (s, sub) => hap.getServiceById(s, sub),
      addService: (...a) => hap.addService(...a),
      removeService: (s) => hap.removeService(s),
    }
  new Thermostat(device, accessory, { disableLogs: true })
  const target = hap
    .getService(hapNodejs.Service.Thermostat)
    .getCharacteristic(hapNodejs.Characteristic.TargetTemperature)
  return { target, calls }
}

async function settle(t, ms) {
  t.mock.timers.tick(ms)
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

test('a temperature slider sends Ring only the setpoint it settles on', async (t) => {
  useMockTimers(t)
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
