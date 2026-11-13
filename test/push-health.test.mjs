import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Subject } from 'rxjs'
import { intervalProvider } from 'rxjs/internal/scheduler/intervalProvider'
import { getHistoryMotionEvents } from '../lib/camera.js'
import {
  MAX_REFRESHES_WITHOUT_PUSH,
  PushHealthMonitor,
  readPushRecoveryState,
} from '../lib/push-health.js'
import { getSavedPlatformConfig, RingPlatform } from '../lib/ring-platform.js'

const minutes = (n) => n * 60_000
const day = minutes(24 * 60)

function storage(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rsv-push-health-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const writeState = (dir, state) =>
  writeFileSync(join(dir, '.ring-secure-video-push.json'), JSON.stringify(state))

function monitor(t, state) {
  const dir = storage(t),
    clock = { now: 10 * day },
    refreshes = []
  if (state) writeState(dir, state)
  const health = new PushHealthMonitor(
    dir,
    () => refreshes.push(clock.now),
    () => clock.now,
    () => clock.now,
  )
  return { dir, clock, refreshes, health }
}

test('3 unpushed motion events over 30 minutes ask for one session refresh', (t) => {
  const { dir, clock, refreshes, health } = monitor(t)

  health.recordMissed(1)
  clock.now += minutes(15)
  health.recordMissed(1)
  clock.now += minutes(15)
  health.recordMissed(1)
  assert.equal(refreshes.length, 1)
  assert.deepEqual(readPushRecoveryState(dir), {
    refreshPending: true,
    lastRefreshAt: clock.now,
    refreshesWithoutPush: 1,
  })

  clock.now += minutes(60)
  health.recordMissed(5)
  assert.equal(refreshes.length, 1, 'once per run')
})

test('misses close together, or with a push in between, do not', (t) => {
  const { refreshes, clock, health } = monitor(t)

  health.recordMissed(3)
  clock.now += minutes(29)
  health.recordMissed(1)
  assert.equal(refreshes.length, 0, 'one visit can make several events')

  health.recordPush(true)
  clock.now += minutes(31)
  health.recordMissed(2)
  assert.equal(refreshes.length, 0, 'counted again from the push')
  clock.now += minutes(31)
  health.recordMissed(1)
  assert.equal(refreshes.length, 1)
})

test('at most once a day', (t) => {
  const start = 10 * day,
    { refreshes, clock, health } = monitor(t, {
      lastRefreshAt: start - minutes(60),
      refreshesWithoutPush: 1,
    })

  health.recordMissed(2)
  clock.now += minutes(30)
  health.recordMissed(1)
  assert.equal(refreshes.length, 0)
  clock.now = start - minutes(60) + day
  health.recordMissed(1)
  assert.equal(refreshes.length, 1)
})

test(`no more after ${MAX_REFRESHES_WITHOUT_PUSH} refreshes that brought no push, until a push arrives`, (t) => {
  const { dir, refreshes, clock, health } = monitor(t, {
    lastRefreshAt: 0,
    refreshesWithoutPush: MAX_REFRESHES_WITHOUT_PUSH,
  })

  health.recordMissed(2)
  clock.now += minutes(30)
  health.recordMissed(1)
  assert.equal(refreshes.length, 0)

  health.recordPush(false)
  assert.equal(readPushRecoveryState(dir).refreshesWithoutPush, 2, 'a doorbell push does not')
  health.recordPush(true)
  assert.equal(readPushRecoveryState(dir).refreshesWithoutPush, 0)
})

test('a push drops a refresh still waiting for a restart', (t) => {
  const { dir, health } = monitor(t, { refreshPending: true, lastRefreshAt: 5, refreshesWithoutPush: 1 })

  health.recordPush(false)
  assert.deepEqual(readPushRecoveryState(dir), {
    refreshPending: false,
    lastRefreshAt: 5,
    refreshesWithoutPush: 1,
  })
})

test('a refresh saved with a clock that was ahead does not hold up the next', (t) => {
  const { refreshes, clock, health } = monitor(t, { lastRefreshAt: 20 * day })

  health.recordMissed(2)
  clock.now += minutes(30)
  health.recordMissed(1)
  assert.equal(refreshes.length, 1)
})

test('the history check reports pushes and unpushed motion events', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000_000_000 })
  intervalProvider.delegate = {
    setInterval(handler, timeout) {
      const interval = { cleared: false }
      const schedule = () => {
        interval.timer = setTimeout(() => {
          if (interval.cleared) return
          schedule()
          handler()
        }, timeout)
      }
      schedule()
      return interval
    },
    clearInterval(interval) {
      interval.cleared = true
      clearTimeout(interval.timer)
    },
  }
  t.after(() => (intervalProvider.delegate = undefined))

  const startedAt = Date.now(),
    events = [],
    camera = {
      name: 'Front Door',
      onNewNotification: new Subject(),
      getEvents: async () => ({ events: [...events].reverse() }),
    },
    reported = []
  const subscription = getHistoryMotionEvents(camera, 20, {
    recordPush: (isMotion) => reported.push(isMotion ? 'motion push' : 'push'),
    recordMissed: (count) => reported.push(`missed ${count}`),
  }).subscribe()
  t.after(() => subscription.unsubscribe())
  const at = async (seconds) => {
    while (Date.now() - startedAt < seconds * 1000) {
      t.mock.timers.tick(5000)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  await at(25)
  events.push({ ding_id: 1, ding_id_str: '1', kind: 'motion', created_at: new Date().toISOString() })
  await at(120)
  camera.onNewNotification.next({ android_config: { category: 'com.ring.pn.live-event.ding' } })
  assert.deepEqual(reported, ['missed 1', 'push'])

  // Not counted: an event Ring saw no person in, and anything while motion is snoozed.
  events.push({
    ding_id: 2,
    ding_id_str: '2',
    kind: 'motion',
    created_at: new Date().toISOString(),
    cv_properties: { person_detected: false },
  })
  await at(240)
  camera.data = { motion_snooze: { scheduled: false } }
  events.push({ ding_id: 3, ding_id_str: '3', kind: 'motion', created_at: new Date().toISOString() })
  await at(360)
  assert.deepEqual(reported, ['missed 1', 'push'])
})

function platform(t, { config = {}, state, savedToken = 'T0', bridge, saved = {} } = {}) {
  const dir = storage(t),
    created = [],
    warnings = [],
    restarts = []
  writeFileSync(join(dir, '.ring.json'), JSON.stringify({ systemId: 'old-system-id' }))
  if (state) writeState(dir, state)
  const block = {
    platform: 'Ring Secure Video',
    refreshToken: savedToken,
    ...(bridge ? { _bridge: bridge } : {}),
    ...saved,
  }
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ platforms: [{ platform: 'Ring', refreshToken: 'other' }, block] }),
  )
  const events = {},
    api = {
      on: (event, handler) => (events[event] = handler),
      user: { configPath: () => join(dir, 'config.json'), storagePath: () => dir },
    }
  class TestPlatform extends RingPlatform {
    createRingApi(options) {
      const onRefreshTokenUpdated = new Subject()
      created.push({ options, onRefreshTokenUpdated })
      return { onRefreshTokenUpdated, getLocations: async () => [], disconnect() {} }
    }
    restartChildBridge() {
      restarts.push(true)
    }
  }
  const log = { info() {}, debug() {}, error() {}, warn: (m) => warnings.push(m) },
    fullConfig = {
      platform: 'Ring Secure Video',
      refreshToken: 'T0',
      disableLogs: true,
      ...(bridge ? { _bridge: bridge } : {}),
      ...config,
    }
  return {
    dir,
    created,
    warnings,
    restarts,
    events,
    config: fullConfig,
    platform: new TestPlatform(log, fullConfig, api),
  }
}

test('a pending automatic refresh gives a new Ring identity, cleared once the token is saved', async (t) => {
  const { dir, created, platform: p, config, warnings } = platform(t, {
    state: { refreshPending: true, lastRefreshAt: 5, refreshesWithoutPush: 1 },
  })

  await p.connectToApi()
  assert.notEqual(created[0].options.systemId, 'old-system-id')
  created[0].onRefreshTokenUpdated.next({ oldRefreshToken: 'T0', newRefreshToken: 'T1' })
  assert.deepEqual(readPushRecoveryState(dir), {
    refreshPending: false,
    lastRefreshAt: 5,
    refreshesWithoutPush: 1,
  })
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'))).platforms[1].refreshToken, 'T1')
  assert.equal(config.refreshToken, 'T1')
  assert.match(warnings.at(-1), /Remove the older entry/)

  await p.connectToApi()
  assert.equal(created[1].options.systemId, created[0].options.systemId, 'only once')
})

test('a refresh whose token could not be saved stays pending, but a retry does not redo it', async (t) => {
  // config.json holds another token, so the new one can't replace it.
  const { dir, created, platform: p } = platform(t, {
    state: { refreshPending: true },
    savedToken: 'signed-in-again',
  })

  await p.connectToApi()
  created[0].onRefreshTokenUpdated.next({ oldRefreshToken: 'T0', newRefreshToken: 'T1' })
  assert.equal(readPushRecoveryState(dir).refreshPending, true, 'the next start does it again')

  await p.connectToApi()
  assert.equal(created[1].options.systemId, created[0].options.systemId)
})

test('with the setting off, a pending refresh is not done, and nothing is watched', async (t) => {
  const { dir, created, platform: p } = platform(t, {
    config: { automaticSessionRefresh: false },
    state: { refreshPending: true },
  })

  await p.connectToApi()
  assert.equal(created[0].options.systemId, 'old-system-id')
  assert.equal(p.pushHealth, undefined)
  assert.equal(readPushRecoveryState(dir).refreshPending, false, 'not done later on old evidence')
})

test('a child bridge restarts itself for the refresh; the main bridge waits for a restart', (t) => {
  const child = platform(t, { bridge: { username: '0E:C2:A3:65:0D:A2' } }),
    main = platform(t)
  const send = process.send
  process.send = () => true
  t.after(() => (process.send = send))

  child.platform.refreshSessionAutomatically()
  main.platform.refreshSessionAutomatically()
  assert.equal(child.restarts.length, 1)
  assert.equal(main.restarts.length, 0)
  assert.match(main.warnings[0], /refreshed the next time Homebridge restarts/)

  child.events.shutdown()
  child.platform.refreshSessionAutomatically()
  assert.equal(child.restarts.length, 1, 'not while shutting down')
})

test('a restarted child bridge uses the token and force settings saved in config.json', async (t) => {
  const bridge = { username: '0E:C2:A3:65:0D:A2' },
    { created, events, config } = platform(t, {
      bridge,
      savedToken: 'T5',
      // Homebridge hands over the settings from its own start; the force setting cleared since.
      config: { forceRefreshRingApiSession: true },
      saved: { forceRefreshRingApiSession: false },
    })

  events.didFinishLaunching()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(config.refreshToken, 'T5')
  assert.equal(created[0].options.refreshToken, 'T5')
  assert.equal(created[0].options.systemId, 'old-system-id', 'no forced refresh')
})

test("only this bridge's own block gives the saved token", (t) => {
  const dir = storage(t),
    api = { user: { configPath: () => join(dir, 'config.json') } },
    block = (token, username) => ({
      platform: 'Ring Secure Video',
      refreshToken: token,
      ...(username ? { _bridge: { username } } : {}),
    }),
    saved = (platforms, config) => {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ platforms }))
      return getSavedPlatformConfig(api, config)?.refreshToken
    },
    child = { _bridge: { username: 'AA' } }

  assert.equal(saved([block('M'), block('A', 'AA'), block('B', 'BB')], child), 'A')
  assert.equal(saved([block('M'), block('A', 'AA')], {}), 'M', 'main bridge')
  assert.equal(saved([block('B', 'BB')], child), undefined, "another bridge's")
  assert.equal(saved([block('A', 'AA'), block('A2', 'AA')], child), undefined, 'two blocks')
  assert.equal(saved([block('', 'AA')], child), undefined, 'signed out')
  assert.equal(saved([block('a', 'aa')], child), 'a', 'username in lower case')
  assert.equal(
    saved([{ ...block('p', 'AA'), platform: 'homebridge-ring-secure-video.Ring Secure Video' }], child),
    'p',
    'platform named with the plugin',
  )
  rmSync(join(dir, 'config.json'))
  assert.equal(getSavedPlatformConfig(api, child), undefined, 'no config.json')
})
