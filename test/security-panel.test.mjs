import assert from 'node:assert/strict'
import test from 'node:test'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { useLogger } from 'ring-client-api/util'
import { BehaviorSubject } from 'rxjs'
import { setHap } from '../dist/hap.js'
import {
  ALARM_COMMAND_TIMEOUT_MS,
  ALARM_MODE_GRACE_MS,
  ALARM_TARGET_SETTLE_MS,
  getAlarmTargetSettleMs,
  SecurityPanel,
} from '../dist/security-panel.js'

setHap(hapNodejs)
const { SecuritySystemTargetState: State, SecuritySystemCurrentState: Current } =
  hapNodejs.Characteristic

const logs = []
useLogger({
  logInfo: (...m) => logs.push(['info', m.join(' ')]),
  logError: (m) => logs.push(['error', String(m?.message ?? m)]),
})

// The panel's alarm-change logic, with a fake Ring device and location. `answer(mode, report)`
// decides how a command for `mode` ends (`report(mode)` is Ring reporting a mode); by default Ring
// reports that mode and the command resolves.
function fakePanel(startMode, answer) {
  logs.length = 0
  const commands = [],
    shown = { target: [], current: [] },
    panel = Object.create(SecurityPanel.prototype),
    onData = new BehaviorSubject({ mode: startMode }),
    report = (mode) => onData.next({ mode }),
    device = {
      name: 'Alarm',
      onData,
      get data() {
        return onData.value
      },
    },
    run = (mode) => {
      commands.push(mode)
      if (answer) {
        return answer(mode, report)
      }
      report(mode)
      return Promise.resolve()
    }

  device.location = {
    armAway: () => run('all'),
    armHome: () => run('some'),
    disarm: () => run('none'),
    getDevices: async () => [],
  }
  panel.device = device
  panel.config = {}
  panel.accessory = { context: {} }
  panel.alarmStates = []
  panel.getService = () => ({
    getCharacteristic: (type) => ({
      updateValue: (value) =>
        (type === hapNodejs.Characteristic.SecuritySystemTargetState
          ? shown.target
          : shown.current
        ).push(value),
    }),
  })
  return { panel, device, commands, shown, report }
}

const errors = () => logs.filter(([level]) => level === 'error').map(([, m]) => m)

// lets the promise chain after a timer run
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('a slider dragged from Off to Home sends Ring only Home, once it settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { panel, commands } = fakePanel('none')

  // Off (3) to Home (0) passes Away (1): one request per position
  const done = []
  for (let i = 0; i < 15; i++) {
    done.push(panel.setTargetState(State.AWAY_ARM))
  }
  done.push(panel.setTargetState(State.STAY_ARM))

  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS - 1)
  await settle()
  assert.deepEqual(commands, [], 'nothing is sent while the slider may still move')

  t.mock.timers.tick(1)
  await Promise.all(done)
  assert.deepEqual(commands, ['some'])
  assert.deepEqual(errors(), [])
})

test('a request restarts the wait, so a slow drag still ends in one command', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { panel, commands } = fakePanel('some')

  panel.setTargetState(State.AWAY_ARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS - 100)
  const last = panel.setTargetState(State.DISARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS - 100)
  await settle()
  assert.deepEqual(commands, [])

  t.mock.timers.tick(100)
  await last
  assert.deepEqual(commands, ['none'])
})

test('a mode Ring is already in sends no command', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { panel, commands } = fakePanel('some')

  // Home to Away and back to Home
  panel.setTargetState(State.AWAY_ARM)
  const done = panel.setTargetState(State.STAY_ARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS)
  await done
  assert.deepEqual(commands, [])
  assert.deepEqual(logs, [['info', 'Alarm is already armed (Home)']])
})

test("a request during a Ring command is sent after it, and checks Ring's answer to itself", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const finish = []
  const { panel, device, commands } = fakePanel('none', (mode, report) => {
    return new Promise((resolve) => {
      finish.push(() => {
        report(mode)
        resolve()
      })
    })
  })

  const first = panel.setTargetState(State.AWAY_ARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS)
  await settle()
  assert.deepEqual(commands, ['all'])

  const second = panel.setTargetState(State.DISARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS)
  await settle()
  assert.deepEqual(commands, ['all'], 'waits for the Away command')

  finish.shift()()
  await first
  await settle()
  assert.deepEqual(commands, ['all', 'none'])

  finish.shift()()
  await second
  assert.equal(device.data.mode, 'none')
  assert.deepEqual(errors(), [])
})

test("ring-client-api's failure is ignored when Ring reports the mode soon after", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { panel, shown, report } = fakePanel('none', (mode, report) => {
    // Ring's next update showed another mode (e.g. one being left)
    report('all')
    return Promise.reject(new Error(`Failed to set alarm mode to "${mode}".`))
  })

  const done = panel.setTargetState(State.STAY_ARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS)
  await settle()
  t.mock.timers.tick(ALARM_MODE_GRACE_MS - 1)
  report('some')
  await done
  assert.deepEqual(errors(), [])
  assert.deepEqual(shown.target, [State.STAY_ARM])
})

test('a mode Ring did not switch to is logged once, and HomeKit gets the real states back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { panel, shown } = fakePanel('none', (mode) =>
    Promise.reject(new Error(`Failed to set alarm mode to "${mode}".`)),
  )

  const done = panel.setTargetState(State.AWAY_ARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS)
  await settle()
  assert.deepEqual(errors(), [], 'Ring may still report the mode')
  t.mock.timers.tick(ALARM_MODE_GRACE_MS)
  await done
  assert.deepEqual(errors(), [
    "Ring didn't change Alarm to armed (Away): it is disarmed. An open sensor may need bypassing, which can only be done in the Ring app.",
  ])
  assert.deepEqual(shown, { target: [State.DISARM], current: [Current.DISARMED] })
})

test('another error from the Ring command is logged too', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { panel } = fakePanel('some', () => Promise.reject(new Error('socket hang up')))

  const done = panel.setTargetState(State.DISARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS)
  await done // at once: no wait for a mode after an error like this
  assert.deepEqual(errors(), [
    "Ring didn't change Alarm to disarmed: it is armed (Home).",
    'socket hang up',
  ])
})

test('a Ring command that is never confirmed gives up and lets the next one through', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let hang = true
  const { panel, commands } = fakePanel('none', (mode, report) => {
    if (hang) {
      hang = false
      return new Promise(() => {})
    }
    report(mode)
    return Promise.resolve()
  })

  const first = panel.setTargetState(State.AWAY_ARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS)
  await settle()
  const second = panel.setTargetState(State.STAY_ARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS)
  await settle()
  assert.deepEqual(commands, ['all'])

  t.mock.timers.tick(ALARM_COMMAND_TIMEOUT_MS)
  await first
  await settle()
  t.mock.timers.tick(0)
  await second
  assert.deepEqual(commands, ['all', 'some'])
  assert.deepEqual(errors(), [
    "Ring didn't change Alarm to armed (Away): it is disarmed. An open sensor may need bypassing, which can only be done in the Ring app.",
  ])
})

test('night mode with bypass is still sent, even in the same mode, and targets night', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { panel, commands } = fakePanel('some')
  panel.config = { nightModeBypassFor: 'some' }

  const done = panel.setTargetState(State.NIGHT_ARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS)
  await done
  assert.deepEqual(commands, ['some'])
  assert.equal(panel.getTargetState({ mode: 'some' }), State.NIGHT_ARM)
})

test('Night to Home in the same Ring mode sends nothing and shows Home as current', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { panel, commands, shown } = fakePanel('some')
  panel.config = { nightModeBypassFor: 'some' }
  panel.targetingNightMode = true
  assert.equal(panel.getCurrentState({ mode: 'some' }), Current.NIGHT_ARM)

  const done = panel.setTargetState(State.STAY_ARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS)
  await done
  assert.deepEqual(commands, [])
  assert.deepEqual(shown, { target: [State.STAY_ARM], current: [Current.STAY_ARM] })
})

test("a command Ring confirms ends without waiting, and doesn't leave the mode watched", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { panel, device, commands } = fakePanel('none')

  const done = panel.setTargetState(State.AWAY_ARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS)
  await done
  assert.deepEqual(commands, ['all'])
  assert.equal(device.onData.observed, false)
})

test('alarmModeChangeDelaySeconds sets the wait: 0.5 s sends after half a second', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { panel, commands } = fakePanel('none')
  panel.config = { alarmModeChangeDelaySeconds: 0.5 }

  panel.setTargetState(State.AWAY_ARM)
  const done = panel.setTargetState(State.STAY_ARM)
  t.mock.timers.tick(499)
  await settle()
  assert.deepEqual(commands, [])
  t.mock.timers.tick(1)
  await done
  assert.deepEqual(commands, ['some'])
})

test('the alarm wait is 1 s unless set to a number from 0 to 5', () => {
  assert.equal(ALARM_TARGET_SETTLE_MS, 1000)
  assert.equal(getAlarmTargetSettleMs({}), 1000)
  assert.equal(getAlarmTargetSettleMs({ alarmModeChangeDelaySeconds: 0 }), 0)
  assert.equal(getAlarmTargetSettleMs({ alarmModeChangeDelaySeconds: 0.5 }), 500)
  assert.equal(getAlarmTargetSettleMs({ alarmModeChangeDelaySeconds: 5 }), 5000)
  for (const invalid of [-1, 6, '0.5', null, Number.NaN]) {
    assert.equal(getAlarmTargetSettleMs({ alarmModeChangeDelaySeconds: invalid }), 1000, String(invalid))
  }
})

test("a Ring update in the old mode doesn't move the slider back while a change is in progress", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finish
  const { panel, device, shown } = fakePanel('none', (mode, report) => {
    return new Promise((resolve) => {
      finish = () => {
        report(mode)
        resolve()
      }
    })
  })

  const done = panel.setTargetState(State.STAY_ARM)
  // while the slider settles, and while the command runs, Ring reports the old mode
  assert.equal(panel.getShownTargetState(device.data), State.STAY_ARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS)
  await settle()
  assert.equal(panel.getShownTargetState({ mode: 'none' }), State.STAY_ARM)
  assert.equal(panel.getCurrentState({ mode: 'none' }), Current.DISARMED, 'current stays Ring\'s')

  finish()
  await done
  assert.equal(panel.getShownTargetState({ mode: 'none' }), State.DISARM, "Ring's again once done")
  assert.deepEqual(shown.target, [State.STAY_ARM])
})

test('Night stays Night when Ring reports the old mode before the new one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { panel, device, shown } = fakePanel('none', (mode, report) => {
    report('none') // an update still in the old mode
    report(mode)
    return Promise.resolve()
  })
  panel.config = { nightModeBypassFor: 'some' }
  // as the Current State characteristic does with each of Ring's updates
  const subscription = device.onData.subscribe((data) => panel.getCurrentState(data))
  t.after(() => subscription.unsubscribe())

  const done = panel.setTargetState(State.NIGHT_ARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS)
  await done
  assert.equal(panel.targetingNightMode, true)
  assert.deepEqual(shown, { target: [State.NIGHT_ARM], current: [Current.NIGHT_ARM] })
})

test('a newer request keeps showing while an older change finishes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const finish = []
  const { panel, shown } = fakePanel('none', (mode, report) => {
    return new Promise((resolve) => {
      finish.push(() => {
        report(mode)
        resolve()
      })
    })
  })

  const first = panel.setTargetState(State.AWAY_ARM)
  t.mock.timers.tick(ALARM_TARGET_SETTLE_MS)
  await settle()
  panel.setTargetState(State.DISARM) // while Away is being sent
  finish.shift()()
  await first
  assert.equal(panel.getShownTargetState({ mode: 'all' }), State.DISARM, 'still the newer request')
  assert.deepEqual(shown.target, [State.DISARM])
})

// A panel on a real HAP accessory, whose arm commands Ring never acts on.
function hapPanel() {
  const onData = new BehaviorSubject({ mode: 'none' }),
    device = {
      name: 'Alarm',
      zid: 'zid-alarm',
      onData,
      get data() {
        return onData.value
      },
      location: {
        armHome: () => new Promise(() => {}),
        armAway: () => new Promise(() => {}),
        disarm: async () => {},
        getDevices: async () => [],
      },
    },
    hap = new hapNodejs.Accessory('Alarm', hapNodejs.uuid.generate(`alarm-${Math.random()}`)),
    accessory = {
      displayName: 'Alarm',
      UUID: hap.UUID,
      context: {},
      getService: (s) => hap.getService(s),
      getServiceById: (s, sub) => hap.getServiceById(s, sub),
      addService: (...a) => hap.addService(...a),
      removeService: (s) => hap.removeService(s),
    }
  new SecurityPanel(device, accessory, { hideAlarmSirenSwitch: true })
  const service = hap.getService(hapNodejs.Service.SecuritySystem)
  return {
    onData,
    target: service.getCharacteristic(hapNodejs.Characteristic.SecuritySystemTargetState),
    current: service.getCharacteristic(hapNodejs.Characteristic.SecuritySystemCurrentState),
  }
}

test('after a change Ring never made, the target follows Ring again', async (t) => {
  for (const oldModeReport of [false, true]) {
    t.mock.timers.reset()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { onData, target, current } = hapPanel()

    await target.handleSetRequest(State.STAY_ARM)
    t.mock.timers.tick(ALARM_TARGET_SETTLE_MS)
    await settle()
    if (oldModeReport) onData.next({ mode: 'none', other: 1 })
    assert.equal(target.value, State.STAY_ARM, `in progress (${oldModeReport})`)

    t.mock.timers.tick(ALARM_COMMAND_TIMEOUT_MS)
    for (let i = 0; i < 20; i++) await settle()
    assert.equal(target.value, State.DISARM, `back to Ring's mode (${oldModeReport})`)

    // armed Home from the keypad or the Ring app
    onData.next({ mode: 'some' })
    assert.equal(current.value, Current.STAY_ARM, `current (${oldModeReport})`)
    assert.equal(target.value, State.STAY_ARM, `target (${oldModeReport})`)
  }
})
