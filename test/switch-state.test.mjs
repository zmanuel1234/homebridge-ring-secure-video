import assert from 'node:assert/strict'
import test from 'node:test'
import { BehaviorSubject } from 'rxjs'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { setHap } from '../lib/hap.js'
import { Switch } from '../lib/switch.js'
import { SET_VALUE_SHOWN_MS } from '../lib/base-data-accessory.js'

setHap(hapNodejs)

// A Ring switch on a real HAP accessory; setInfo is Ring's command (it resolves once sent).
function ringSwitch(setInfo = async () => {}) {
  const data = { name: 'Porch Light', zid: 'zid-switch', on: false },
    onData = new BehaviorSubject(data),
    device = {
      name: 'Porch Light',
      zid: 'zid-switch',
      get data() {
        return onData.value
      },
      onData,
      setInfo,
    },
    hap = new hapNodejs.Accessory('Porch Light', hapNodejs.uuid.generate(`switch-${Math.random()}`)),
    accessory = {
      displayName: 'Porch Light',
      UUID: hap.UUID,
      context: {},
      getService: (s) => hap.getService(s),
      getServiceById: (s, sub) => hap.getServiceById(s, sub),
      addService: (...a) => hap.addService(...a),
      removeService: (s) => hap.removeService(s),
    }
  new Switch(device, accessory, { disableLogs: true })
  const on = hap.getService(hapNodejs.Service.Switch).getCharacteristic(hapNodejs.Characteristic.On)
  return { on, onData, data }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('a switch Ring left off shows off again at its next report', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { on, onData, data } = ringSwitch()
  assert.equal(on.value, false)

  await on.handleSetRequest(true) // sent, but Ring doesn't act on it
  await tick()
  assert.equal(on.value, true, 'shown as requested meanwhile')

  t.mock.timers.tick(SET_VALUE_SHOWN_MS)
  onData.next({ ...data }) // Ring's next report: still off
  await tick()
  assert.equal(on.value, false)
})

test("a report sent before Ring acted on the request doesn't flip the switch back", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { on, onData, data } = ringSwitch()

  await on.handleSetRequest(true)
  onData.next({ ...data }) // a report from before the request: still off
  await tick()
  assert.equal(on.value, true)

  onData.next({ ...data, on: true }) // Ring turned it on
  t.mock.timers.tick(SET_VALUE_SHOWN_MS)
  await tick()
  assert.equal(on.value, true)
})

test("Ring's only report during the hold is shown once it ends", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { on, onData, data } = ringSwitch()

  await on.handleSetRequest(true) // Ring doesn't act on it, and reports only once, at once
  onData.next({ ...data })
  await tick()
  assert.equal(on.value, true)

  t.mock.timers.tick(SET_VALUE_SHOWN_MS)
  await tick()
  assert.equal(on.value, false)
})

test('a switch Ring turned on stays on', async () => {
  const { on, onData, data } = ringSwitch()
  await on.handleSetRequest(true)
  onData.next({ ...data, on: true })
  await tick()
  assert.equal(on.value, true)
})

test("once Ring reports the request, Ring's next change shows at once", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { on, onData, data } = ringSwitch()

  await on.handleSetRequest(true)
  onData.next({ ...data, on: true }) // Ring turned it on
  onData.next({ ...data, on: false }) // and off again at the switch, a second later
  await tick()
  assert.equal(on.value, false)
})

test('a slow confirmation within the hold does not flip the switch back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { on, onData, data } = ringSwitch()

  await on.handleSetRequest(true)
  t.mock.timers.tick(SET_VALUE_SHOWN_MS - 1000) // slow, but within the hold
  onData.next({ ...data, on: true })
  t.mock.timers.tick(1000)
  await tick()
  assert.equal(on.value, true)
})

// A control that asks Ring for an update on each HomeKit read (as cameras' and chimes' do).
async function polledSwitch() {
  const { BaseDataAccessory } = await import('../lib/base-data-accessory.js')
  const data = { siren: 'off' },
    onData = new BehaviorSubject(data),
    device = {
      name: 'Camera',
      get data() {
        return onData.value
      },
      onData,
      requestUpdate() {},
    },
    hap = new hapNodejs.Accessory('Camera', hapNodejs.uuid.generate(`camera-${Math.random()}`)),
    accessory = {
      displayName: 'Camera',
      UUID: hap.UUID,
      context: {},
      getService: (s) => hap.getService(s),
      getServiceById: (s, sub) => hap.getServiceById(s, sub),
      addService: (...a) => hap.addService(...a),
      removeService: (s) => hap.removeService(s),
    }
  class Siren extends BaseDataAccessory {
    constructor() {
      super()
      this.device = device
      this.accessory = accessory
      this.config = {}
      this.registerCharacteristic({
        characteristicType: hapNodejs.Characteristic.On,
        serviceType: hapNodejs.Service.Switch,
        getValue: (d) => d.siren === 'on',
        setValue: async () => {},
        requestUpdate: () => device.requestUpdate(),
      })
    }
  }
  new Siren()
  return hap.getService(hapNodejs.Service.Switch).getCharacteristic(hapNodejs.Characteristic.On)
}

test('a HomeKit read during the hold answers the value just set, not the old one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const on = await polledSwitch()
  await on.handleSetRequest(true)
  assert.equal(await on.handleGetRequest(), true, 'Ring still has the old value')
  t.mock.timers.tick(SET_VALUE_SHOWN_MS)
  assert.equal(await on.handleGetRequest(), false, "Ring's value once the hold ends")
})
