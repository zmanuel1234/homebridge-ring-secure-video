// Every Ring alarm/smart-home accessory type on a real HAP accessory, fed by a fake Ring device:
// what HomeKit shows for Ring's data, and what HomeKit's commands send to Ring.
import assert from 'node:assert/strict'
import test from 'node:test'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { useLogger } from 'ring-client-api/util'
import { BehaviorSubject } from 'rxjs'
import { setHap } from '../dist/hap.js'
import { ContactSensor } from '../dist/contact-sensor.js'
import { MotionSensor } from '../dist/motion-sensor.js'
import { FloodFreezeSensor } from '../dist/flood-freeze-sensor.js'
import { FreezeSensor } from '../dist/freeze-sensor.js'
import { WaterSensor } from '../dist/water-sensor.js'
import { TemperatureSensor } from '../dist/temperature-sensor.js'
import { SmokeAlarm } from '../dist/smoke-alarm.js'
import { CoAlarm } from '../dist/co-alarm.js'
import { SmokeCoListener } from '../dist/smoke-co-listener.js'
import { PanicButtons } from '../dist/panic-buttons.js'
import { Outlet } from '../dist/outlet.js'
import { Valve } from '../dist/valve.js'
import { MultiLevelSwitch } from '../dist/multi-level-switch.js'
import { BrightnessOnly } from '../dist/brightness-only.js'
import { UnknownZWaveSwitchSwitch } from '../dist/unknown-zwave-switch.js'
import { Beam } from '../dist/beam.js'
import { TargetValueTimer } from '../dist/target-value-timer.js'

setHap(hapNodejs)
useLogger({ logInfo: () => undefined, logError: () => undefined })
const { Characteristic: C, Service: S } = hapNodejs

/**
 * Builds `Type` for a fake Ring device whose data starts as `data`, as the platform does
 * (constructor, then initBase). Returns the data stream, the commands sent to Ring, and helpers.
 */
function build(Type, data, config = {}) {
  const onData = new BehaviorSubject({ deviceType: 'test.device', tamperStatus: 'ok', batteryStatus: 'none', ...data })
  const sent = []
  const location = {
    name: 'Home',
    triggerBurglarAlarm: async () => sent.push(['location.triggerBurglarAlarm']),
    triggerFireAlarm: async () => sent.push(['location.triggerFireAlarm']),
    setAlarmMode: async (mode) => sent.push(['location.setAlarmMode', mode]),
    setLightGroup: async (...a) => sent.push(['location.setLightGroup', ...a]),
  }
  const device = {
    id: 'd1',
    zid: 'd1',
    name: 'Test Device',
    deviceType: onData.value.deviceType,
    location,
    onData,
    get data() {
      return onData.value
    },
    sendCommand: async (command, body) => sent.push(body === undefined ? ['sendCommand', command] : ['sendCommand', command, body]),
    setInfo: async (body) => sent.push(['setInfo', body]),
  }
  const hap = new hapNodejs.Accessory('Test Device', hapNodejs.uuid.generate(`acc-${Math.random()}`))
  const accessory = {
    displayName: 'Test Device',
    UUID: hap.UUID,
    context: {},
    get services() {
      return hap.services
    },
    getService: (s) => hap.getService(s),
    getServiceById: (s, sub) => hap.getServiceById(s, sub),
    addService: (...a) => hap.addService(...a),
    removeService: (s) => hap.removeService(s),
  }
  const acc = new Type(device, accessory, { disableLogs: true, ...config })
  acc.initBase()
  const service = (type, subtype) => (subtype ? hap.getServiceById(type, subtype) : hap.getService(type))
  /** The value HomeKit has for characteristic `c` of `type` (optionally `subtype`). */
  const value = (type, c, subtype) => service(type, subtype).getCharacteristic(c).value
  /** HomeKit writes `v`. */
  const set = (type, c, v, subtype) => service(type, subtype).getCharacteristic(c).handleSetRequest(v)
  const next = (patch) => onData.next({ ...onData.value, ...patch })
  return { acc, hap, service, value, set, next, sent }
}

// ─── Sensors: Ring's data → HomeKit ───────────────────────────────────────

const sensorCases = [
  // [name, Type, service, characteristic, data → expected HomeKit value]
  ['contact sensor', ContactSensor, S.ContactSensor, C.ContactSensorState, [
    [{ faulted: false }, C.ContactSensorState.CONTACT_DETECTED],
    [{ faulted: true }, C.ContactSensorState.CONTACT_NOT_DETECTED],
  ]],
  ['motion sensor', MotionSensor, S.MotionSensor, C.MotionDetected, [
    [{ faulted: false }, false],
    [{ faulted: true }, true],
  ]],
  ['freeze sensor', FreezeSensor, S.OccupancySensor, C.OccupancyDetected, [
    [{ faulted: false }, C.OccupancyDetected.OCCUPANCY_NOT_DETECTED],
    [{ faulted: true }, C.OccupancyDetected.OCCUPANCY_DETECTED],
  ]],
  ['water sensor', WaterSensor, S.LeakSensor, C.LeakDetected, [
    [{ faulted: false }, C.LeakDetected.LEAK_NOT_DETECTED],
    [{ faulted: true }, C.LeakDetected.LEAK_DETECTED],
  ]],
  ['temperature sensor', TemperatureSensor, S.TemperatureSensor, C.CurrentTemperature, [
    [{ celsius: 21.5 }, 21.5],
    [{ celsius: -3 }, -3],
  ]],
  ['smoke alarm', SmokeAlarm, S.SmokeSensor, C.SmokeDetected, [
    [{ alarmStatus: 'inactive' }, C.SmokeDetected.SMOKE_NOT_DETECTED],
    [{ alarmStatus: 'active' }, C.SmokeDetected.SMOKE_DETECTED],
  ]],
  ['CO alarm', CoAlarm, S.CarbonMonoxideSensor, C.CarbonMonoxideDetected, [
    [{ alarmStatus: 'inactive' }, C.CarbonMonoxideDetected.CO_LEVELS_NORMAL],
    [{ alarmStatus: 'active' }, C.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL],
  ]],
]

for (const [name, Type, serviceType, characteristic, steps] of sensorCases) {
  test(`${name}: HomeKit follows Ring's data`, () => {
    const { value, next } = build(Type, steps[0][0])
    for (const [data, expected] of [...steps, steps[0]]) {
      next(data)
      assert.equal(value(serviceType, characteristic), expected, JSON.stringify(data))
    }
  })
}

test('sensors: tamper and low battery show on the sensor itself', () => {
  const { value, next } = build(ContactSensor, { faulted: false, batteryStatus: 'ok', batteryLevel: 80 })
  assert.equal(value(S.ContactSensor, C.StatusTampered), C.StatusTampered.NOT_TAMPERED)
  assert.equal(value(S.ContactSensor, C.StatusLowBattery), C.StatusLowBattery.BATTERY_LEVEL_NORMAL)
  next({ tamperStatus: 'tamper', batteryLevel: 15 })
  assert.equal(value(S.ContactSensor, C.StatusTampered), C.StatusTampered.TAMPERED)
  assert.equal(value(S.ContactSensor, C.StatusLowBattery), C.StatusLowBattery.BATTERY_LEVEL_LOW)
  assert.equal(value(S.Battery, C.BatteryLevel), 15)
})

test('sensors: a battery level from the status alone (no percentage), and charging', () => {
  const { value, next } = build(MotionSensor, { faulted: false, batteryStatus: 'full' })
  assert.equal(value(S.Battery, C.BatteryLevel), 100)
  next({ batteryStatus: 'ok' })
  assert.equal(value(S.Battery, C.BatteryLevel), 50)
  next({ batteryStatus: 'charging' })
  assert.equal(value(S.Battery, C.ChargingState), C.ChargingState.CHARGING)
  next({ batteryStatus: 'low' })
  assert.equal(value(S.Battery, C.BatteryLevel), 0)
  assert.equal(value(S.MotionSensor, C.StatusLowBattery), C.StatusLowBattery.BATTERY_LEVEL_LOW)
})

test('sensors: a mains-powered sensor (battery "none") gets no battery service', () => {
  const { service } = build(MotionSensor, { faulted: false, batteryStatus: 'none' })
  assert.equal(service(S.Battery), undefined)
})

test('accessory information: manufacturer, model and serial from Ring, with fallbacks', () => {
  const { value } = build(ContactSensor, { faulted: false, deviceType: 'sensor.contact', serialNumber: 'ABC123' })
  assert.equal(value(S.AccessoryInformation, C.Manufacturer), 'Ring')
  assert.equal(value(S.AccessoryInformation, C.Model), 'sensor.contact')
  assert.equal(value(S.AccessoryInformation, C.SerialNumber), 'ABC123')
  assert.equal(build(ContactSensor, { faulted: false }).value(S.AccessoryInformation, C.SerialNumber), 'Unknown')
})

test('flood/freeze sensor: flooding and freezing on their own services', () => {
  const { hap, next } = build(FloodFreezeSensor, { flood: { faulted: false }, freeze: { faulted: false } })
  const leak = hap.services.find((s) => s.UUID === S.LeakSensor.UUID)
  const freeze = hap.services.find((s) => s.UUID === S.OccupancySensor.UUID)
  assert.equal(leak.getCharacteristic(C.LeakDetected).value, C.LeakDetected.LEAK_NOT_DETECTED)
  next({ flood: { faulted: true } })
  assert.equal(leak.getCharacteristic(C.LeakDetected).value, C.LeakDetected.LEAK_DETECTED)
  assert.equal(freeze.getCharacteristic(C.OccupancyDetected).value, C.OccupancyDetected.OCCUPANCY_NOT_DETECTED)
  next({ flood: { faulted: false }, freeze: { faulted: true } })
  assert.equal(leak.getCharacteristic(C.LeakDetected).value, C.LeakDetected.LEAK_NOT_DETECTED)
  assert.equal(freeze.getCharacteristic(C.OccupancyDetected).value, C.OccupancyDetected.OCCUPANCY_DETECTED)
})

test('smoke/CO listener: both data shapes (top level and components), each alarm on its own', () => {
  const { value, next } = build(SmokeCoListener, { smoke: { alarmStatus: 'inactive' }, co: { alarmStatus: 'inactive' } })
  assert.equal(value(S.SmokeSensor, C.SmokeDetected), C.SmokeDetected.SMOKE_NOT_DETECTED)
  assert.equal(value(S.CarbonMonoxideSensor, C.CarbonMonoxideDetected), C.CarbonMonoxideDetected.CO_LEVELS_NORMAL)
  next({ smoke: { alarmStatus: 'active' } })
  assert.equal(value(S.SmokeSensor, C.SmokeDetected), C.SmokeDetected.SMOKE_DETECTED)
  assert.equal(value(S.CarbonMonoxideSensor, C.CarbonMonoxideDetected), C.CarbonMonoxideDetected.CO_LEVELS_NORMAL)
  next({ smoke: undefined, co: undefined, components: { 'alarm.smoke': { alarmStatus: 'inactive' }, 'alarm.co': { alarmStatus: 'active' } } })
  assert.equal(value(S.SmokeSensor, C.SmokeDetected), C.SmokeDetected.SMOKE_NOT_DETECTED)
  assert.equal(value(S.CarbonMonoxideSensor, C.CarbonMonoxideDetected), C.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL)
})

// ─── Controls: HomeKit → Ring ─────────────────────────────────────────────

test('panic buttons: show a burglar or fire alarm, trigger one, and turn it off with the alarm mode', async () => {
  const { value, set, next, sent } = build(PanicButtons, {})
  assert.equal(value(S.Switch, C.On, 'Burglar'), false)
  assert.equal(value(S.Switch, C.On, 'Fire'), false)
  next({ alarmInfo: { state: 'burglar-alarm' } })
  assert.equal(value(S.Switch, C.On, 'Burglar'), true)
  assert.equal(value(S.Switch, C.On, 'Fire'), false)
  next({ alarmInfo: { state: 'user-verified-co-or-fire-alarm' } })
  assert.equal(value(S.Switch, C.On, 'Burglar'), false)
  assert.equal(value(S.Switch, C.On, 'Fire'), true)
  await set(S.Switch, C.On, true, 'Burglar')
  await set(S.Switch, C.On, true, 'Fire')
  await set(S.Switch, C.On, false, 'Fire')
  assert.deepEqual(sent, [['location.triggerBurglarAlarm'], ['location.triggerFireAlarm'], ['location.setAlarmMode', 'none']])
})

test('outlet: on/off and in-use follow Ring; switching sends setInfo', async () => {
  const { value, set, next, sent } = build(Outlet, { on: false })
  assert.equal(value(S.Outlet, C.On), false)
  next({ on: true })
  assert.equal(value(S.Outlet, C.On), true)
  assert.equal(value(S.Outlet, C.OutletInUse), true)
  await set(S.Outlet, C.On, false)
  assert.deepEqual(sent, [['setInfo', { device: { v1: { on: false } } }]])
})

test('valve: open is on; switching sends valve.open / valve.close', async () => {
  const { value, set, next, sent } = build(Valve, { valveState: 'closed' })
  assert.equal(value(S.Switch, C.On), false)
  next({ valveState: 'open' })
  assert.equal(value(S.Switch, C.On), true)
  await set(S.Switch, C.On, false)
  await set(S.Switch, C.On, true)
  assert.deepEqual(sent, [['sendCommand', 'valve.close'], ['sendCommand', 'valve.open']])
})

test('Z-Wave switch: any basicValue is on; switching sends 255 or 0', async () => {
  const { value, set, next, sent } = build(UnknownZWaveSwitchSwitch, { basicValue: 0 })
  assert.equal(value(S.Switch, C.On), false)
  next({ basicValue: 99 })
  assert.equal(value(S.Switch, C.On), true)
  await set(S.Switch, C.On, false)
  await set(S.Switch, C.On, true)
  assert.deepEqual(sent, [['setInfo', { device: { v1: { basicValue: 0 } } }], ['setInfo', { device: { v1: { basicValue: 255 } } }]])
})

test('dimmer (multi-level switch): on/off and brightness both ways', async () => {
  const { value, set, next, sent } = build(MultiLevelSwitch, { on: false, level: 0.4 })
  assert.equal(value(S.Lightbulb, C.On), false)
  assert.equal(value(S.Lightbulb, C.Brightness), 40)
  next({ on: true, level: 0.75 })
  assert.equal(value(S.Lightbulb, C.On), true)
  assert.equal(value(S.Lightbulb, C.Brightness), 75)
  await set(S.Lightbulb, C.On, false)
  assert.deepEqual(sent[0], ['setInfo', { device: { v1: { on: false } } }])
})

test('dimmer without a level: no brightness on the light', () => {
  const { service } = build(MultiLevelSwitch, { on: true })
  assert.equal(service(S.Lightbulb).testCharacteristic(C.Brightness), false)
})

test('brightness-only light: on means brightness above 0, and turning on restores the last brightness', async () => {
  const { value, set, next, sent } = build(BrightnessOnly, { brightness: 0.6 })
  assert.equal(value(S.Lightbulb, C.On), true)
  assert.equal(value(S.Lightbulb, C.Brightness), 60)
  next({ brightness: 0 })
  assert.equal(value(S.Lightbulb, C.On), false)
  await set(S.Lightbulb, C.On, true)
  assert.equal(sent.length, 1)
  const body = JSON.stringify(sent[0])
  assert.ok(body.includes('0.6'), `turned back on at the last brightness (60%): ${body}`)
})

test('beam light with motion: light on/off, motion from motionStatus, group lights through the location', async () => {
  const { value, set, next, sent } = build(Beam, { deviceType: 'switch.multilevel.beams', on: false, level: 1, motionStatus: 'clear' })
  assert.equal(value(S.Lightbulb, C.On), false)
  assert.equal(value(S.MotionSensor, C.MotionDetected), false)
  next({ on: true, motionStatus: 'faulted' })
  assert.equal(value(S.Lightbulb, C.On), true)
  assert.equal(value(S.MotionSensor, C.MotionDetected), true)
  await set(S.Lightbulb, C.On, false)
  assert.equal(sent.length, 1)

  const group = build(Beam, { deviceType: 'group.light-group.beams', groupId: 'g1', on: false }, { beamDurationSeconds: 60 })
  await group.set(S.Lightbulb, C.On, true)
  assert.deepEqual(group.sent, [['location.setLightGroup', 'g1', true, 60]])
})

test('beam motion sensor only: no light service', () => {
  const { service, value } = build(Beam, { deviceType: 'motion-sensor.beams', motionStatus: 'faulted' })
  assert.equal(service(S.Lightbulb), undefined)
  assert.equal(value(S.MotionSensor, C.MotionDetected), true)
})

// ─── The camera light's pending target ────────────────────────────────────

test('target value timer: holds a target for its duration, then forgets it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const timer = new TargetValueTimer()
  assert.equal(timer.hasTarget(), false)
  timer.setTarget(true, 1000)
  assert.equal(timer.hasTarget(), true)
  assert.equal(timer.getTarget(), true)
  t.mock.timers.tick(999)
  assert.equal(timer.hasTarget(), true)
  t.mock.timers.tick(1)
  assert.equal(timer.hasTarget(), false)
  assert.equal(timer.getTarget(), undefined)
  timer.setTarget(false, 1000)
  timer.reset()
  assert.equal(timer.hasTarget(), false)
})

// ─── Values Ring doesn't report ───────────────────────────────────────────

test('a value Ring leaves out keeps the last one in HomeKit, instead of an invalid undefined', () => {
  const { value, next } = build(TemperatureSensor, { celsius: 20 })
  next({ celsius: undefined })
  assert.equal(value(S.TemperatureSensor, C.CurrentTemperature), 20)
  next({ celsius: 18 })
  assert.equal(value(S.TemperatureSensor, C.CurrentTemperature), 18)

  const motion = build(MotionSensor, { faulted: true })
  motion.next({ faulted: undefined })
  assert.equal(motion.value(S.MotionSensor, C.MotionDetected), true)
})
