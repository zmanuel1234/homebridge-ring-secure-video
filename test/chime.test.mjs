import assert from 'node:assert/strict'
import test from 'node:test'
import { BehaviorSubject } from 'rxjs'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { setHap } from '../lib/hap.js'
import { Chime } from '../lib/chime.js'

setHap(hapNodejs)

function chime() {
  const onData = new BehaviorSubject({
      device_id: 'chime-1',
      do_not_disturb: { seconds_left: 0 },
      settings: { volume: 5 },
    }),
    device = {
      name: 'Chime',
      model: 'Chime',
      get data() {
        return onData.value
      },
      onData,
      requestUpdate() {},
      playSound: async () => {},
    },
    hap = new hapNodejs.Accessory('Chime', hapNodejs.uuid.generate(`chime-${Math.random()}`)),
    accessory = {
      displayName: 'Chime',
      UUID: hap.UUID,
      context: {},
      getService: (s) => hap.getService(s),
      getServiceById: (s, sub) => hap.getServiceById(s, sub),
      addService: (...a) => hap.addService(...a),
      removeService: (s) => hap.removeService(s),
    }
  new Chime(device, accessory, { disableLogs: true })
  return (subtype) =>
    hap
      .getServiceById(hapNodejs.Service.Switch, subtype)
      .getCharacteristic(hapNodejs.Characteristic.On)
}

test('the Play Ding and Play Motion switches read as off again after their 1 s press', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const play = chime()
  for (const subtype of ['play-ding', 'play-motion']) {
    const on = play(subtype)
    await on.handleSetRequest(true)
    t.mock.timers.tick(2000)
    assert.equal(on.value, false, subtype)
    assert.equal(await on.handleGetRequest(), false, subtype)
  }
})
