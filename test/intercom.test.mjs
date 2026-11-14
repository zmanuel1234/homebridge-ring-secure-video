import assert from 'node:assert/strict'
import test from 'node:test'
import { BehaviorSubject, Subject } from 'rxjs'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { RingCamera } from 'ring-client-api'
import { useLogger } from 'ring-client-api/util'
import { setHap } from '../lib/hap.js'
import { Intercom } from '../lib/intercom.js'

setHap(hapNodejs)
useLogger({ logInfo() {}, logError() {} })

class PlatformAccessory {
  constructor(displayName, UUID) {
    this.displayName = displayName
    this.UUID = UUID
    this.context = {}
    this._associatedHAPAccessory = new hapNodejs.Accessory(displayName, UUID)
  }
  get services() {
    return this._associatedHAPAccessory.services
  }
  getService(service) {
    return this._associatedHAPAccessory.getService(service)
  }
  getServiceById(service, subtype) {
    return this._associatedHAPAccessory.getServiceById(service, subtype)
  }
  addService(service, ...args) {
    return this._associatedHAPAccessory.addService(service, ...args)
  }
  removeService(service) {
    return this._associatedHAPAccessory.removeService(service)
  }
  configureController(controller) {
    this._associatedHAPAccessory.configureController(controller)
  }
}

function fakeIntercom(deviceType, requests) {
  const data = { device_id: '1234', kind: deviceType }
  return {
    id: 1,
    name: 'Front Gate',
    deviceType,
    batteryLevel: null,
    isOffline: false,
    data,
    onData: new BehaviorSubject(data),
    onDing: new Subject(),
    onUnlocked: new Subject(),
    onBatteryLevel: new Subject(),
    requestUpdate() {},
    restClient: {
      request: async (options) => {
        requests.push(options.url)
        return []
      },
    },
  }
}

const mockTimers = (t) => t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })

/** Call mockTimers(t) first. */
function setUp(t, deviceType, config = {}) {
  const requests = [],
    device = fakeIntercom(deviceType, requests),
    intercom = new Intercom(
      device,
      new PlatformAccessory(device.name, hapNodejs.uuid.generate(deviceType)),
      config,
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
  const requests = [],
    device = fakeIntercom('intercom_handset_video', requests)
  let answer
  device.restClient.request = (options) => {
    requests.push(options.url)
    return new Promise((resolve) => (answer = resolve))
  }
  const intercom = new Intercom(
    device,
    new PlatformAccessory(device.name, hapNodejs.uuid.generate('slow')),
    {},
  )
  const pressed = []
  intercom
    .getService(hapNodejs.Service.Doorbell)
    .getCharacteristic(hapNodejs.Characteristic.ProgrammableSwitchEvent)
    .on('change', () => pressed.push(1))

  t.mock.timers.tick(5_000)
  t.mock.timers.tick(15_000)
  assert.equal(requests.length, 1, 'no new request while one is running')
  answer([{ id: 7, doorbot_id: 1, kind: 'ding' }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pressed.length, 1, 'the slow answer still counts')
})

test('a pre-warmed call that fails is handled, and the recording starts its own', async (t) => {
  const calls = []
  const cameras = []
  t.mock.method(RingCamera.prototype, 'startLiveCall', function () {
    cameras.push(this)
    const call = calls.length === 0 ? Promise.reject(new Error('no call')) : Promise.resolve({ stop() {} })
    calls.push(call)
    return call
  })
  const unhandled = []
  const onUnhandled = (e) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))

  mockTimers(t)
  const { device } = setUp(t, 'intercom_handset_video')
  device.onDing.next()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1, 'a ding pre-warms a call')
  assert.deepEqual(unhandled, [])

  await cameras[0].startLiveCall() // the proxy's, as a recording calls it
  assert.equal(calls.length, 2, 'the failed pre-warmed call is not handed to the recording')
})

test('no pre-warmed call without HKSV', async (t) => {
  const calls = []
  t.mock.method(RingCamera.prototype, 'startLiveCall', function () {
    calls.push(1)
    return Promise.resolve({ stop() {} })
  })
  mockTimers(t)
  const { device } = setUp(t, 'intercom_handset_video', { enableHksv: false })
  device.onDing.next()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 0)
})

test('an unclaimed pre-warmed call is stopped after 20 s without touching a later call', async (t) => {
  const resolvers = [],
    cameras = [],
    stopped = []
  t.mock.method(RingCamera.prototype, 'startLiveCall', function () {
    cameras.push(this)
    return new Promise((resolve) => resolvers.push(resolve))
  })
  mockTimers(t)
  const { device } = setUp(t, 'intercom_handset_video')
  device.onDing.next()
  await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(20_000) // the pre-warmed call is still connecting

  const recording = cameras[0].startLiveCall()
  assert.equal(resolvers.length, 2, 'a recording after 20 s starts its own call')
  resolvers[0]({ stop: () => stopped.push('pre-warmed') })
  resolvers[1]({ stop: () => stopped.push('recording') })
  await recording
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(stopped, ['pre-warmed'])
})
