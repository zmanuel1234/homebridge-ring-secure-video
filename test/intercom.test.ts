import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { BehaviorSubject, Subject } from 'rxjs'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { RingCamera, type RingIntercom } from 'ring-client-api'
import type { StreamingSession } from 'ring-client-api/streaming/streaming-session'
import { useLogger } from 'ring-client-api/util'
import { setHap } from '../src/hap.js'
import type { RingPlatformConfig } from '../src/config.js'
import { Intercom } from '../src/intercom.js'
import { config, fake, internals, platformAccessory } from './helpers.js'

/** A Ring live call (only `stop` is used). */
const liveCall: (value: object) => StreamingSession = fake

setHap(hapNodejs)
useLogger({ logInfo() {}, logError() {} })

function fakeIntercom(deviceType: string, requests: string[]) {
  const data = { device_id: '1234', kind: deviceType }
  return {
    id: 1,
    name: 'Front Gate',
    deviceType,
    batteryLevel: null,
    isOffline: false,
    data,
    onData: new BehaviorSubject(data),
    onDing: new Subject<void>(),
    onUnlocked: new Subject(),
    onBatteryLevel: new Subject(),
    requestUpdate() {},
    restClient: {
      request: async (options: { url: string }): Promise<unknown> => {
        requests.push(options.url)
        return []
      },
    },
  }
}

const mockTimers = (t: TestContext) => t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })

/** Call mockTimers(t) first. */
function setUp(t: TestContext, deviceType: string, settings: Partial<RingPlatformConfig> = {}) {
  const requests: string[] = [],
    device = fakeIntercom(deviceType, requests),
    intercom = new Intercom(
      fake<RingIntercom>(device),
      platformAccessory(new hapNodejs.Accessory(device.name, hapNodejs.uuid.generate(deviceType))),
      config(settings),
    )
  return { device, intercom, requests }
}

test('only Intercom Video polls Ring for dings, every 5 s', async (t) => {
  mockTimers(t)
  const audio = setUp(t, 'intercom_handset_audio')
  t.mock.timers.tick(60_000)
  assert.equal(audio.requests.length, 0, 'audio intercoms get their dings by push')

  const video = setUp(t, 'intercom_handset_video')
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(5_000)
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(video.requests.filter((url) => url.endsWith('/dings/active')).length, 3)
})

test('a slow ding check is not stacked or cancelled by the next one', async (t) => {
  mockTimers(t)
  const requests: string[] = [],
    device = fakeIntercom('intercom_handset_video', requests)
  const pending: { answer?: (dings: unknown) => void } = {}
  device.restClient.request = (options) => {
    requests.push(options.url)
    return new Promise((resolve) => (pending.answer = resolve))
  }
  const intercom = new Intercom(
    fake<RingIntercom>(device),
    platformAccessory(new hapNodejs.Accessory(device.name, hapNodejs.uuid.generate('slow'))),
    config(),
  )
  const pressed: number[] = []
  internals<{ getService(type: typeof hapNodejs.Service.Doorbell): hapNodejs.Service }>(intercom)
    .getService(hapNodejs.Service.Doorbell)
    .getCharacteristic(hapNodejs.Characteristic.ProgrammableSwitchEvent)
    .on('change', () => pressed.push(1))

  t.mock.timers.tick(5_000)
  t.mock.timers.tick(15_000)
  assert.equal(requests.length, 1, 'no new request while one is running')
  assert.ok(pending.answer)
  pending.answer([{ id: 7, doorbot_id: 1, kind: 'ding' }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pressed.length, 1, 'the slow answer still counts')
})

test('a pre-warmed call that fails is handled, and the recording starts its own', async (t) => {
  const calls: Promise<unknown>[] = []
  const cameras: RingCamera[] = []
  t.mock.method(RingCamera.prototype, 'startLiveCall', function (this: RingCamera) {
    cameras.push(this)
    const call = calls.length === 0 ? Promise.reject(new Error('no call')) : Promise.resolve(liveCall({ stop() {} }))
    calls.push(call)
    return call
  })
  const unhandled: unknown[] = []
  const onUnhandled = (e: unknown) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))

  mockTimers(t)
  const { device } = setUp(t, 'intercom_handset_video')
  device.onDing.next()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1, 'a ding pre-warms a call')
  assert.deepEqual(unhandled, [])

  await cameras[0]?.startLiveCall() // the proxy's, as a recording calls it
  assert.equal(calls.length, 2, 'the failed pre-warmed call is not handed to the recording')
})

test('no pre-warmed call without HKSV', async (t) => {
  const calls: number[] = []
  t.mock.method(RingCamera.prototype, 'startLiveCall', function () {
    calls.push(1)
    return Promise.resolve(liveCall({ stop() {} }))
  })
  mockTimers(t)
  const { device } = setUp(t, 'intercom_handset_video', { enableHksv: false })
  device.onDing.next()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 0)
})

test('an unclaimed pre-warmed call is stopped after 20 s without touching a later call', async (t) => {
  const resolvers: ((call: StreamingSession) => void)[] = [],
    cameras: RingCamera[] = [],
    stopped: string[] = []
  t.mock.method(RingCamera.prototype, 'startLiveCall', function (this: RingCamera) {
    cameras.push(this)
    return new Promise<StreamingSession>((resolve) => resolvers.push(resolve))
  })
  mockTimers(t)
  const { device } = setUp(t, 'intercom_handset_video')
  device.onDing.next()
  await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(20_000) // the pre-warmed call is still connecting

  const recording = cameras[0]?.startLiveCall()
  assert.equal(resolvers.length, 2, 'a recording after 20 s starts its own call')
  resolvers[0]?.(liveCall({ stop: () => stopped.push('pre-warmed') }))
  resolvers[1]?.(liveCall({ stop: () => stopped.push('recording') }))
  await recording
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(stopped, ['pre-warmed'])
})
