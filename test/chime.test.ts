import assert from 'node:assert/strict'
import test from 'node:test'
import { BehaviorSubject } from 'rxjs'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { setHap } from '../src/hap.js'
import type { RingChime } from 'ring-client-api'
import { Chime } from '../src/chime.js'
import { config, fake, platformAccessory, serviceOf } from './helpers.js'

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
    accessory = platformAccessory(hap, 'Chime')
  new Chime(fake<RingChime>(device), accessory, config({ disableLogs: true }))
  return (subtype: string) => serviceOf(hap, hapNodejs.Service.Switch, subtype).getCharacteristic(hapNodejs.Characteristic.On)
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
