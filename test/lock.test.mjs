import assert from 'node:assert/strict'
import test from 'node:test'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { setHap } from '../lib/hap.js'
import { Lock } from '../lib/lock.js'

setHap(hapNodejs)
const { LockTargetState: Target } = hapNodejs.Characteristic

// The lock's state logic, with a fake Ring lock (the HomeKit wiring is BaseDeviceAccessory's).
function fakeLock(locked) {
  const commands = []
  const lock = Object.create(Lock.prototype)
  lock.device = {
    data: { locked },
    sendCommand: async (command) => {
      commands.push(command)
    },
  }
  return { lock, commands }
}

test('the target follows a locked or unlocked lock', () => {
  assert.equal(fakeLock('locked').lock.getTargetState({ locked: 'locked' }), Target.SECURED)
  assert.equal(fakeLock('unlocked').lock.getTargetState({ locked: 'unlocked' }), Target.UNSECURED)
})

test('a jammed or unknown lock reports a valid target (locked), not its current state', () => {
  // LockTargetState only allows UNSECURED (0) and SECURED (1); JAMMED (2) and UNKNOWN (3) are
  // current states only, and HAP rejects them as a target
  for (const locked of ['jammed', 'something-new', undefined]) {
    const target = fakeLock(locked).lock.getTargetState({ locked })
    assert.equal(target, Target.SECURED, String(locked))
  }
})

test('unlocking from HomeKit keeps the unlocked target until Ring reports it', async () => {
  const { lock, commands } = fakeLock('locked')
  await lock.setTargetState(Target.UNSECURED)
  assert.deepEqual(commands, ['lock.unlock'])
  // still locked at Ring: the target is the requested unlock (0), not the locked state
  assert.equal(lock.getTargetState({ locked: 'locked' }), Target.UNSECURED)
})

test('locking from HomeKit sends lock.lock and keeps the locked target', async () => {
  const { lock, commands } = fakeLock('unlocked')
  await lock.setTargetState(Target.SECURED)
  assert.deepEqual(commands, ['lock.lock'])
  assert.equal(lock.getTargetState({ locked: 'unlocked' }), Target.SECURED)
})

test('asking for the state the lock is already in sets no pending target', async () => {
  const { lock, commands } = fakeLock('locked')
  await lock.setTargetState(Target.SECURED)
  assert.deepEqual(commands, ['lock.lock'])
  assert.equal(lock.targetState, undefined)
})

// A whole Lock accessory on a real HAP accessory, fed by Ring's data stream.
async function lockAccessory(initial) {
  const { BehaviorSubject } = await import('rxjs')
  const onData = new BehaviorSubject({ locked: initial })
  const commands = []
  const device = {
    id: 'lock-1',
    zid: 'lock-1',
    name: 'Front Lock',
    deviceType: 'lock',
    onData,
    get data() {
      return onData.value
    },
    sendCommand: async (command) => {
      commands.push(command)
    },
  }
  const hap = new hapNodejs.Accessory('Front Lock', hapNodejs.uuid.generate(`lock-${Math.random()}`))
  const accessory = {
    displayName: 'Front Lock',
    UUID: hap.UUID,
    context: {},
    getService: (s) => hap.getService(s),
    getServiceById: (s, sub) => hap.getServiceById(s, sub),
    addService: (...a) => hap.addService(...a),
    removeService: (s) => hap.removeService(s),
  }
  new Lock(device, accessory, { disableLogs: true })
  const service = hap.getService(hapNodejs.Service.LockMechanism)
  const read = async () => ({
    current: await service.getCharacteristic(hapNodejs.Characteristic.LockCurrentState).handleGetRequest(),
    target: await service.getCharacteristic(Target).handleGetRequest(),
  })
  return { onData, read, service, commands }
}

test('a lock that jams and is then unlocked by hand shows unlocked, not "Locking…"', async () => {
  const { onData, read } = await lockAccessory('locked')
  assert.deepEqual(await read(), { current: 1, target: 1 })
  onData.next({ locked: 'jammed' })
  assert.deepEqual(await read(), { current: 2, target: 1 }, 'jammed: target is a valid value')
  onData.next({ locked: 'unlocked' })
  assert.deepEqual(await read(), { current: 0, target: 0 }, 'unlocked by hand')
})

test('an unlock from HomeKit is pending until Ring reports it, then settles', async () => {
  const { onData, read, service, commands } = await lockAccessory('locked')
  await service.getCharacteristic(Target).handleSetRequest(Target.UNSECURED)
  assert.deepEqual(commands, ['lock.unlock'])
  assert.deepEqual(await read(), { current: 1, target: 0 }, 'unlocking…')
  onData.next({ locked: 'unlocked' })
  assert.deepEqual(await read(), { current: 0, target: 0 })
})
