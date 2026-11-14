import assert from 'node:assert/strict'
import test from 'node:test'
import { BehaviorSubject } from 'rxjs'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { setHap } from '../lib/hap.js'
import { LocationModeSwitch } from '../lib/location-mode-switch.js'

setHap(hapNodejs)
const { SecuritySystemTargetState: Target, SecuritySystemCurrentState: Current } =
  hapNodejs.Characteristic

// A Ring location whose mode changes go to setLocationMode, on a real HAP accessory.
function setup(t, setLocationMode) {
  const unhandled = []
  const onUnhandled = (e) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))

  const location = {
      name: 'Home',
      id: 'loc-1',
      onLocationMode: new BehaviorSubject('disarmed'),
      getLocationMode: async () => ({ mode: location.onLocationMode.value }),
      setLocationMode,
    },
    hap = new hapNodejs.Accessory('Home Mode', hapNodejs.uuid.generate(`mode-${Math.random()}`)),
    accessory = {
      displayName: 'Home Mode',
      UUID: hap.UUID,
      context: {},
      getService: (s) => hap.getService(s),
      getServiceById: (s, sub) => hap.getServiceById(s, sub),
      addService: (...a) => hap.addService(...a),
      removeService: (s) => hap.removeService(s),
    }
  new LocationModeSwitch(location, accessory, { disableLogs: true })
  const service = hap.getService(hapNodejs.Service.SecuritySystem)
  return {
    location,
    unhandled,
    target: service.getCharacteristic(hapNodejs.Characteristic.SecuritySystemTargetState),
    current: service.getCharacteristic(hapNodejs.Characteristic.SecuritySystemCurrentState),
  }
}

// HomeKit's write: the SET handler as a controller's request reaches it, with HAP's check that
// the value is one the characteristic allows (only done for a connection). It answers HomeKit at
// once and talks to Ring afterwards, so it resolves even when Ring then fails.
const controller = { remoteAddress: 'test', sessionID: 'test' }
const write = (characteristic, value) => characteristic.handleSetRequest(value, controller)
// NIGHT_ARM isn't one of the allowed values, so HAP refuses it from a controller and from code
// alike; these tests hand it straight to the SET handler (as upstream's do) to cover the handler's
// NIGHT_ARM branch.
const writeFromCode = (characteristic, value) =>
  characteristic.emit(hapNodejs.CharacteristicEventTypes.SET, value, () => {})

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

function pending() {
  const calls = []
  const setLocationMode = (mode) =>
    new Promise((resolve, reject) => calls.push({ mode, resolve, reject }))
  return { calls, setLocationMode }
}

test('a failed mode change is logged, not a crash, and the target goes back to the reported mode', async (t) => {
  const { target, unhandled, location } = setup(t, async () => {
    throw new Error('Ring API down')
  })
  await write(target, Target.AWAY_ARM)
  await settle()
  assert.deepEqual(unhandled, [], 'no unhandled rejection (it would take Homebridge down)')
  assert.equal(target.value, Target.DISARM, 'back to the mode Ring reports')

  // And the next report from Ring is shown, not held back by a stale target.
  location.onLocationMode.next('home')
  await settle()
  assert.equal(target.value, Target.STAY_ARM)
})

test('the requested target is kept until Ring reports it, also for STAY_ARM (value 0)', async (t) => {
  const { calls, setLocationMode } = pending()
  const { target, current, location } = setup(t, setLocationMode)

  await write(target, Target.STAY_ARM)
  await settle()
  assert.deepEqual(calls.map((c) => c.mode), ['home'])
  location.onLocationMode.next('away') // another mode reported meanwhile (Ring app, keypad)
  await settle()
  assert.equal(target.value, Target.STAY_ARM, 'the pending STAY_ARM target is not overwritten')
  assert.equal(current.value, Current.AWAY_ARM)

  calls[0].resolve({ mode: 'home' })
  location.onLocationMode.next('home')
  await settle()
  assert.equal(target.value, Target.STAY_ARM)
  assert.equal(current.value, Current.STAY_ARM)
})

test('an older request failing late does not undo a newer one', async (t) => {
  const { calls, setLocationMode } = pending()
  const { target } = setup(t, setLocationMode)

  await write(target, Target.AWAY_ARM)
  await settle()
  await write(target, Target.STAY_ARM)
  await settle()
  assert.deepEqual(calls.map((c) => c.mode), ['away', 'home'])

  calls[0].reject(new Error('Ring API down'))
  await settle()
  assert.equal(target.value, Target.STAY_ARM, 'the newer request stays')
})

test('NIGHT_ARM (handed to the handler) becomes STAY_ARM, but not over a failure that already reset the target', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { target, unhandled } = setup(t, async () => {
    throw new Error('Ring API down')
  })
  writeFromCode(target, Target.NIGHT_ARM)
  await settle()
  assert.equal(target.value, Target.DISARM, 'the failure reset it to the reported mode')
  t.mock.timers.tick(100) // the delayed NIGHT_ARM → STAY_ARM change
  await settle()
  assert.equal(target.value, Target.DISARM)
  assert.deepEqual(unhandled, [])
})

test('NIGHT_ARM (handed to the handler) asks Ring for home, and shows as STAY_ARM', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { calls, setLocationMode } = pending()
  const { target } = setup(t, setLocationMode)
  writeFromCode(target, Target.NIGHT_ARM)
  await settle()
  assert.deepEqual(calls.map((c) => c.mode), ['home'])
  t.mock.timers.tick(100)
  await settle()
  assert.equal(target.value, Target.STAY_ARM)
})
