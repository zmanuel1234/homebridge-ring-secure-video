import assert from 'node:assert/strict'
import test from 'node:test'
import { Subject } from 'rxjs'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { RingDevice } from 'ring-client-api'
import { setHap } from '../lib/hap.js'
import { getRetryDelayMs, isPermanentRingError, RingPlatform } from '../lib/ring-platform.js'

setHap(hapNodejs)

// What the accessory classes use of Homebridge's PlatformAccessory, backed by a real HAP accessory.
class PlatformAccessory {
  constructor(displayName, UUID, category) {
    this.displayName = displayName
    this.UUID = UUID
    this.category = category
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
}

const fakeRingLocation = () => ({
  onDeviceDataUpdate: new Subject(),
  onDevices: new Subject(),
  onConnected: new Subject(),
})

function contactSensor(zid, name, location) {
  return new RingDevice(
    { zid, name, deviceType: 'sensor.contact', faulted: false, batteryStatus: 'full' },
    location,
    'asset-1',
  )
}

function fakeLocation(name, getDevices) {
  return {
    id: `loc-${name}`,
    name,
    cameras: [],
    chimes: [],
    intercoms: [],
    getDevices,
    supportsLocationModeSwitching: async () => false,
  }
}

function platformWith(locations, cached = [], { getLocations } = {}) {
  const events = {},
    log = { info() {}, warn() {}, debug() {}, errors: [], error(m) { this.errors.push(String(m)) } },
    calls = { registered: [], unregistered: [], published: [], disconnects: 0, created: 0 },
    api = {
      on: (event, handler) => (events[event] = handler),
      platformAccessory: PlatformAccessory,
      registerPlatformAccessories: (_p, _n, accessories) => calls.registered.push(...accessories),
      unregisterPlatformAccessories: (_p, _n, accessories) => calls.unregistered.push(...accessories),
      publishExternalAccessories: (_p, accessories) => calls.published.push(...accessories),
      user: { configPath: () => '/nonexistent/config.json', storagePath: () => '/nonexistent' },
    }

  class TestPlatform extends RingPlatform {
    createRingApi() {
      calls.created++
      return {
        onRefreshTokenUpdated: new Subject(),
        getLocations: getLocations ?? (async () => locations),
        disconnect: () => calls.disconnects++,
      }
    }
  }

  const platform = new TestPlatform(
    log,
    { platform: 'Ring Secure Video', refreshToken: 'token', disableLogs: true },
    api,
  )
  for (const accessory of cached) platform.configureAccessory(accessory)
  return { platform, log, calls, events }
}

test('a device that fails to set up does not stop the others', async () => {
  const location = fakeRingLocation(),
    good = contactSensor('good', 'Front Door Sensor', location),
    broken = { id: 'broken', name: 'Broken Sensor', deviceType: 'sensor.contact', data: {} }
  const { platform, log, calls } = platformWith([
    fakeLocation('Home', async () => [broken, good]),
  ])

  await platform.connectToApi()

  assert.deepEqual(calls.registered.map((a) => a.displayName), ['Front Door Sensor'])
  assert.ok(log.errors.some((e) => e.startsWith('Could not set up Broken Sensor (sensor.contact)')))
})

test("a device that fails keeps its HomeKit accessory instead of it being removed", async () => {
  const location = fakeRingLocation(),
    broken = { id: 'broken', name: 'Broken Sensor', deviceType: 'sensor.contact', data: {} },
    uuid = hapNodejs.uuid.generate('broken'),
    cachedBroken = new PlatformAccessory('Broken Sensor', uuid),
    cachedGone = new PlatformAccessory('Removed Sensor', hapNodejs.uuid.generate('gone'))
  const { platform, calls } = platformWith(
    [fakeLocation('Home', async () => [broken, contactSensor('good', 'Door', location)])],
    [cachedBroken, cachedGone],
  )

  await platform.connectToApi()

  assert.deepEqual(calls.unregistered.map((a) => a.displayName), ['Removed Sensor'])
})

test('a location that fails to load keeps all cached accessories and does not stop other locations', async () => {
  const location = fakeRingLocation(),
    cached = new PlatformAccessory('Garage Sensor', hapNodejs.uuid.generate('garage'))
  const { platform, log, calls } = platformWith(
    [
      fakeLocation('Cabin', async () => {
        throw new Error('Ring returned 500')
      }),
      fakeLocation('Home', async () => [contactSensor('good', 'Front Door Sensor', location)]),
    ],
    [cached],
  )

  await platform.connectToApi()

  assert.deepEqual(calls.registered.map((a) => a.displayName), ['Front Door Sensor'])
  assert.deepEqual(calls.unregistered, [], 'nothing is removed as stale')
  assert.ok(log.errors.some((e) => e.includes('location "Cabin": Ring returned 500')))
})

test('a location whose connection failed once is not asked again (Ring would never answer)', async () => {
  const location = fakeRingLocation()
  let calls = 0
  const { platform, log, calls: platformCalls } = platformWith([
    // Like ring-client-api: rejects once, then waits forever for a connection that failed.
    fakeLocation('Cabin', () => (++calls === 1 ? Promise.reject(new Error('ticket 503')) : new Promise(() => {}))),
    fakeLocation('Home', async () => [contactSensor('good', 'Front Door Sensor', location)]),
  ])

  await platform.connectToApi()

  assert.deepEqual(platformCalls.registered.map((a) => a.displayName), ['Front Door Sensor'])
  assert.ok(log.errors.some((e) => e.includes('location "Cabin": ticket 503')))
  assert.equal(calls, 1)
})

test('connecting is retried when Ring cannot be reached, with a fresh connection each time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let failures = 2
  const { platform, log, calls } = platformWith([], [], {
    getLocations: async () => {
      if (failures-- > 0) throw new Error('Ring returned 503')
      return []
    },
  })

  await platform.connectWithRetry()
  assert.equal(calls.created, 1)
  assert.match(log.errors.at(-1), /Ring returned 503\). Trying again in 30 s/)

  t.mock.timers.tick(30_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.created, 2)
  assert.match(log.errors.at(-1), /Trying again in 60 s/)

  t.mock.timers.tick(60_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.created, 3, 'connected on the third attempt')
  assert.equal(calls.disconnects, 2, 'each failed connection is closed')
})

test('a sign-in Ring rejects during an outage is retried; shutting down stops retrying', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // ring-client-api reports a Ring sign-in server outage as "Refresh token is not valid".
  let failures = 1
  const outage = platformWith([], [], {
    getLocations: async () => {
      if (failures-- > 0) {
        throw new Error('Refresh token is not valid.  Unable to authenticate with Ring servers.')
      }
      return []
    },
  })
  await outage.platform.connectWithRetry()
  assert.match(outage.log.errors.at(-1), /Trying again in 30 s\. If this keeps happening, sign in again/)
  t.mock.timers.tick(30_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(outage.calls.created, 2)

  const down = platformWith([], [], {
    getLocations: async () => {
      throw new Error('Ring returned 503')
    },
  })
  await down.platform.connectWithRetry()
  down.events.shutdown()
  t.mock.timers.tick(600_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(down.calls.created, 1)
})

test('a retry signs in with the newest token and does not force a new registration again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const tokens = [],
    events = {},
    log = { info() {}, warn() {}, debug() {}, error() {} },
    api = {
      on: (event, handler) => (events[event] = handler),
      platformAccessory: PlatformAccessory,
      registerPlatformAccessories() {},
      unregisterPlatformAccessories() {},
      publishExternalAccessories() {},
      user: { configPath: () => '/nonexistent/config.json', storagePath: () => '/nonexistent' },
    }
  let attempt = 0
  class TestPlatform extends RingPlatform {
    createRingApi(options) {
      tokens.push(options.refreshToken)
      const onRefreshTokenUpdated = new Subject()
      return {
        onRefreshTokenUpdated,
        disconnect() {},
        getLocations: async () => {
          // Signing in works and replaces the token; loading the locations fails once.
          onRefreshTokenUpdated.next({ oldRefreshToken: options.refreshToken, newRefreshToken: `T${++attempt}` })
          if (attempt === 1) throw Object.assign(new Error(), { response: { status: 500 } })
          return []
        },
      }
    }
  }
  const config = { platform: 'Ring Secure Video', refreshToken: 'T0', disableLogs: true }
  const platform = new TestPlatform(log, config, api)

  await platform.connectWithRetry()
  t.mock.timers.tick(30_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(tokens, ['T0', 'T1'])
  assert.equal(config.refreshToken, 'T2')
})

test("when no location's devices can be loaded, connecting is retried", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let failures = 1
  const location = fakeRingLocation()
  const { platform, calls } = platformWith([], [], {
    getLocations: async () => [
      fakeLocation('Home', async () => {
        if (failures-- > 0) throw Object.assign(new Error(), { response: { status: 502 } })
        return [contactSensor('good', 'Front Door Sensor', location)]
      }),
    ],
  })

  await platform.connectWithRetry()
  assert.equal(calls.registered.length, 0)
  t.mock.timers.tick(30_000)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.created, 2)
  assert.deepEqual(calls.registered.map((a) => a.displayName), ['Front Door Sensor'])
})

test('a kept accessory that could not be set up shows No Response', async () => {
  const location = fakeRingLocation(),
    broken = { id: 'broken', name: 'Broken Sensor', deviceType: 'sensor.contact', data: {} },
    cached = new PlatformAccessory('Broken Sensor', hapNodejs.uuid.generate('broken'))
  const service = cached.addService(hapNodejs.Service.ContactSensor)
  const { platform } = platformWith(
    [fakeLocation('Home', async () => [broken, contactSensor('good', 'Door', location)])],
    [cached],
  )

  await platform.connectToApi()

  const state = service.getCharacteristic(hapNodejs.Characteristic.ContactSensorState)
  await assert.rejects(
    () => state.handleGetRequest(),
    (e) => e === hapNodejs.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
  )
})

test('retry delays, permanent errors and error descriptions', async () => {
  const { describeError } = await import('../lib/ring-platform.js')
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(getRetryDelayMs), [
    30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000,
  ])
  assert.equal(isPermanentRingError(new Error('Your current NodeJS version (v18) is too old to support this plugin.')), true)
  assert.equal(isPermanentRingError(new Error('Refresh token is not valid.  Unable to authenticate')), false)
  assert.equal(isPermanentRingError(new Error('Ring returned 503')), false)
  assert.equal(describeError(Object.assign(new Error(), { response: { status: 503 } })), 'Ring returned HTTP 503')
  assert.equal(describeError('plain'), 'plain')
})
