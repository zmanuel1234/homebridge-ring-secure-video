import assert from 'node:assert/strict'
import test from 'node:test'
import { Subject } from 'rxjs'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { RingDevice, type RingApi, type RingCamera } from 'ring-client-api'
import type { API, Logging, PlatformAccessory as HomebridgeAccessory } from 'homebridge'
import { setHap } from '../src/hap.js'
import {
  CONNECT_GRACE_MS,
  GET_DEVICES_TIMEOUT_MS,
  getRetryDelayMs,
  isPermanentRingError,
  RingPlatform,
} from '../src/ring-platform.js'
import { config as settings, fake, internals, serviceOf } from './helpers.js'

setHap(hapNodejs)

// What the accessory classes use of Homebridge's PlatformAccessory, backed by a real HAP accessory.
class PlatformAccessory {
  readonly displayName: string
  readonly UUID: string
  readonly category?: number
  readonly context: Record<string, unknown> = {}
  readonly _associatedHAPAccessory: hapNodejs.Accessory
  readonly getService: hapNodejs.Accessory['getService']
  readonly getServiceById: hapNodejs.Accessory['getServiceById']
  readonly addService: hapNodejs.Accessory['addService']
  readonly removeService: hapNodejs.Accessory['removeService']
  constructor(displayName: string, UUID: string, category?: number) {
    this.displayName = displayName
    this.UUID = UUID
    this.category = category
    const hap = new hapNodejs.Accessory(displayName, UUID)
    this._associatedHAPAccessory = hap
    this.getService = hap.getService.bind(hap)
    this.getServiceById = hap.getServiceById.bind(hap)
    this.addService = hap.addService.bind(hap)
    this.removeService = hap.removeService.bind(hap)
  }
  get services() {
    return this._associatedHAPAccessory.services
  }
}

const fakeRingLocation = () => ({
  onDeviceDataUpdate: new Subject(),
  onDevices: new Subject(),
  onConnected: new Subject(),
})

type RingDeviceArgs = ConstructorParameters<typeof RingDevice>

function contactSensor(zid: string, name: string, location: ReturnType<typeof fakeRingLocation>) {
  return new RingDevice(
    fake<RingDeviceArgs[0]>({ zid, name, deviceType: 'sensor.contact', faulted: false, batteryStatus: 'full' }),
    fake<RingDeviceArgs[1]>(location),
    'asset-1',
  )
}

function fakeLocation(name: string, getDevices: () => Promise<unknown[]>) {
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

function platformWith(
  locations: object[],
  cached: PlatformAccessory[] = [],
  { getLocations }: { getLocations?: () => Promise<object[]> } = {},
) {
  const events: Record<string, () => void> = {},
    log = {
      info() {},
      debug() {},
      warnings: [] as string[],
      warn(m: unknown) {
        this.warnings.push(String(m))
      },
      errors: [] as string[],
      error(m: unknown) {
        this.errors.push(String(m))
      },
    },
    calls = {
      registered: [] as PlatformAccessory[],
      unregistered: [] as PlatformAccessory[],
      published: [] as PlatformAccessory[],
      disconnects: 0,
      created: 0,
    },
    api = fake<API>({
      on: (event: string, handler: () => void) => (events[event] = handler),
      platformAccessory: PlatformAccessory,
      registerPlatformAccessories: (_p: string, _n: string, accessories: PlatformAccessory[]) => calls.registered.push(...accessories),
      unregisterPlatformAccessories: (_p: string, _n: string, accessories: PlatformAccessory[]) => calls.unregistered.push(...accessories),
      publishExternalAccessories: (_p: string, accessories: PlatformAccessory[]) => calls.published.push(...accessories),
      user: { configPath: () => '/nonexistent/config.json', storagePath: () => '/nonexistent' },
    })

  class TestPlatform extends RingPlatform {
    protected override createRingApi() {
      calls.created++
      return fake<RingApi>({
        onRefreshTokenUpdated: new Subject(),
        getLocations: getLocations ?? (async () => locations),
        disconnect: () => calls.disconnects++,
      })
    }
  }

  const platform = new TestPlatform(
    fake<Logging>(log),
    fake<ConstructorParameters<typeof RingPlatform>[1]>({ platform: 'Ring Secure Video', refreshToken: 'token', disableLogs: true }),
    api,
  )
  for (const accessory of cached) platform.configureAccessory(fake<HomebridgeAccessory>(accessory))
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

test("a location Ring never sends devices for doesn't hold up the others", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const location = fakeRingLocation()
  const { platform, log, calls } = platformWith([
    fakeLocation('Cabin', () => new Promise(() => {})),
    fakeLocation('Home', async () => [contactSensor('good', 'Front Door Sensor', location)]),
  ])

  const connecting = platform.connectToApi()
  await new Promise((resolve) => setImmediate(resolve))
  // a copy: deepEqual would narrow the list itself to an empty one for the rest of the test
  assert.deepEqual([...calls.registered], [], 'waits for Ring meanwhile')
  t.mock.timers.tick(GET_DEVICES_TIMEOUT_MS)
  await connecting

  assert.deepEqual(calls.registered.map((a) => a.displayName), ['Front Door Sensor'])
  assert.ok(
    log.errors.some((e) => e.includes('location "Cabin": Ring sent no devices for location "Cabin" within 60 s')),
  )
})

test('when Ring sends no devices for any location, connecting is retried', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { platform, log, calls } = platformWith([fakeLocation('Home', () => new Promise(() => {}))])

  const connecting = platform.connectWithRetry()
  await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(GET_DEVICES_TIMEOUT_MS)
  await connecting

  assert.match(String(log.errors.at(-1)), /within 60 s\). Trying again in 30 s/)
  assert.equal(calls.disconnects, 1, 'with a new connection')
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
  assert.match(String(log.errors.at(-1)), /Ring returned 503\). Trying again in 30 s/)

  t.mock.timers.tick(30_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.created, 2)
  assert.match(String(log.errors.at(-1)), /Trying again in 60 s/)

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
  assert.match(String(outage.log.errors.at(-1)), /Trying again in 30 s\. If this keeps happening, sign in again/)
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
  const tokens: (string | undefined)[] = [],
    events: Record<string, () => void> = {},
    log = fake<Logging>({ info() {}, warn() {}, debug() {}, error() {} }),
    api = fake<API>({
      on: (event: string, handler: () => void) => (events[event] = handler),
      platformAccessory: PlatformAccessory,
      registerPlatformAccessories() {},
      unregisterPlatformAccessories() {},
      publishExternalAccessories() {},
      user: { configPath: () => '/nonexistent/config.json', storagePath: () => '/nonexistent' },
    })
  let attempt = 0
  class TestPlatform extends RingPlatform {
    protected override createRingApi(options: ConstructorParameters<typeof RingApi>[0]) {
      tokens.push(options.refreshToken)
      const onRefreshTokenUpdated = new Subject<{ oldRefreshToken?: string; newRefreshToken: string }>()
      return fake<RingApi>({
        onRefreshTokenUpdated,
        disconnect() {},
        getLocations: async () => {
          // Signing in works and replaces the token; loading the locations fails once.
          onRefreshTokenUpdated.next({ oldRefreshToken: options.refreshToken, newRefreshToken: `T${++attempt}` })
          if (attempt === 1) throw Object.assign(new Error(), { response: { status: 500 } })
          return []
        },
      })
    }
  }
  const config: Record<string, unknown> = { platform: 'Ring Secure Video', refreshToken: 'T0', disableLogs: true }
  const platform = new TestPlatform(log, fake<ConstructorParameters<typeof RingPlatform>[1]>(config), api)

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

test("while Ring can't be reached at start-up, cached accessories show No Response", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const location = fakeRingLocation(),
    cached = new PlatformAccessory('Door', hapNodejs.uuid.generate('good'))
  cached.addService(hapNodejs.Service.ContactSensor)
  let failures = 1
  const { platform } = platformWith(
    [],
    [cached],
    {
      getLocations: async () => {
        if (failures-- > 0) throw new Error('Ring returned 503')
        return [fakeLocation('Home', async () => [contactSensor('good', 'Door', location)])]
      },
    },
  )
  const state = () =>
    serviceOf(cached._associatedHAPAccessory, hapNodejs.Service.ContactSensor)
      .getCharacteristic(hapNodejs.Characteristic.ContactSensorState)
      .handleGetRequest()

  await platform.connectWithRetry()
  await assert.rejects(state, (e) => e === hapNodejs.HAPStatus.SERVICE_COMMUNICATION_FAILURE)

  t.mock.timers.tick(30_000)
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(await state(), hapNodejs.Characteristic.ContactSensorState.CONTACT_DETECTED, "Ring's state once connected")
})

// A cached contact sensor for the device contactSensor('good', ...) sets up.
function cachedDoor() {
  const cached = new PlatformAccessory('Door', hapNodejs.uuid.generate('good'))
  cached.addService(hapNodejs.Service.ContactSensor)
  const state = () =>
    serviceOf(cached._associatedHAPAccessory, hapNodejs.Service.ContactSensor)
      .getCharacteristic(hapNodejs.Characteristic.ContactSensorState)
      .handleGetRequest()
  return { cached, state }
}
const noResponse = (e: unknown) => e === hapNodejs.HAPStatus.SERVICE_COMMUNICATION_FAILURE

test('with no answer from Ring at all (no network), cached accessories show No Response after 30 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const location = fakeRingLocation(),
    { cached, state } = cachedDoor()
  // ring-client-api retries a request that gets no answer by itself, without an error
  const pending: { answer?: (locations: object[]) => void } = {}
  const { platform, log } = platformWith([], [cached], {
    getLocations: () => new Promise((resolve) => (pending.answer = resolve)),
  })

  const connecting = platform.connectWithRetry()
  t.mock.timers.tick(CONNECT_GRACE_MS - 1)
  assert.equal(await state(), hapNodejs.Characteristic.ContactSensorState.CONTACT_DETECTED, 'not yet')
  t.mock.timers.tick(1)
  await assert.rejects(state, noResponse)
  assert.deepEqual(log.warnings, [
    'The Home app shows the Ring accessories as "No Response" until Ring can be reached.',
  ])

  assert.ok(pending.answer)
  pending.answer([fakeLocation('Home', async () => [contactSensor('good', 'Door', location)])])
  await connecting
  assert.equal(await state(), hapNodejs.Characteristic.ContactSensorState.CONTACT_DETECTED)
})

test('a quick connection leaves cached accessories alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const location = fakeRingLocation(),
    { cached, state } = cachedDoor()
  const { platform, log } = platformWith(
    [fakeLocation('Home', async () => [contactSensor('good', 'Door', location)])],
    [cached],
  )

  await platform.connectWithRetry()
  t.mock.timers.tick(CONNECT_GRACE_MS)
  assert.equal(await state(), hapNodejs.Characteristic.ContactSensorState.CONTACT_DETECTED)
  assert.deepEqual(log.warnings, [])
})

test('with an error a restart must follow, the No Response notice says so', async () => {
  const { cached, state } = cachedDoor()
  const { platform, log } = platformWith([], [cached], {
    getLocations: async () => {
      throw new Error('Your version of Node.js is too old to support this plugin')
    },
  })

  await platform.connectWithRetry()
  await assert.rejects(state, noResponse)
  assert.deepEqual(log.warnings, [
    'The Home app shows the Ring accessories as "No Response" until this is fixed and Homebridge restarts.',
  ])
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
  const { describeError } = await import('../src/ring-platform.js')
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(getRetryDelayMs), [
    30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000,
  ])
  assert.equal(isPermanentRingError(new Error('Your current NodeJS version (v18) is too old to support this plugin.')), true)
  assert.equal(isPermanentRingError(new Error('Refresh token is not valid.  Unable to authenticate')), false)
  assert.equal(isPermanentRingError(new Error('Ring returned 503')), false)
  assert.equal(describeError(Object.assign(new Error(), { response: { status: 503 } })), 'Ring returned HTTP 503')
  assert.equal(describeError('plain'), 'plain')
})

test('shutting down disconnects from Ring and shuts down the cameras', async () => {
  const location = fakeRingLocation()
  const { platform, calls, events } = platformWith([
    fakeLocation('Home', async () => [contactSensor('door', 'Door', location)]),
  ])
  await platform.connectToApi()
  const { CameraSource } = await import('../src/camera-source.js')
  const camera = new CameraSource(
    fake<RingCamera>({ name: 'Front Door', id: 'cam', operatingOnBattery: false, data: { settings: {} } }),
    settings(),
  )
  let cameraShutDown = false
  internals<{ mediaIngress: { shutdown(): void } }>(camera).mediaIngress.shutdown = () => (cameraShutDown = true)
  assert.equal(calls.disconnects, 0)
  events.shutdown()
  assert.equal(calls.disconnects, 1)
  assert.equal(cameraShutDown, true, 'cameras are shut down too')
})
