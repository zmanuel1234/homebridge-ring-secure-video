import assert from 'node:assert/strict'
import test from 'node:test'
import { BehaviorSubject } from 'rxjs'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { setHap } from '../lib/hap.js'
import { Switch } from '../lib/switch.js'

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

test('a switch Ring left off shows off again at its next report', async () => {
  const { on, onData, data } = ringSwitch()
  assert.equal(on.value, false)

  await on.handleSetRequest(true) // sent, but Ring doesn't act on it
  await tick()
  assert.equal(on.value, true, 'shown as requested meanwhile')

  onData.next({ ...data }) // Ring's next report: still off
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
