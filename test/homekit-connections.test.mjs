import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatDuration,
  getHomeKitRestartMinutes,
  HOMEKIT_ABSENT_WARNING_MS,
  HOMEKIT_RESTART_INTERVAL_MS,
  readHomeKitRestartState,
  HomeKitConnectionMonitor,
  readHomeKitConnections,
} from '../lib/homekit-connections.js'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { setHap } from '../lib/hap.js'
import { RingPlatform } from '../lib/ring-platform.js'
import { isChildBridge } from '../lib/config.js'
import { hksvRecordingQueue } from '../lib/hksv-work-queue.js'

setHap(hapNodejs)

const header =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
// A /proc/net/tcp line: addresses and ports as the kernel writes them
const line = (local, remote, state, inode) =>
  `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 20 4 30 10 -1`

/** A /proc with the sockets this process holds (fd links) and the system's TCP tables. */
function fakeProc(t, { ownInodes, tcp, tcp6 }) {
  const proc = mkdtempSync(join(tmpdir(), 'rsv-proc-'))
  t.after(() => rmSync(proc, { recursive: true, force: true }))
  mkdirSync(join(proc, 'self', 'fd'), { recursive: true })
  mkdirSync(join(proc, 'net'))
  ownInodes.forEach((inode, fd) => symlinkSync(`socket:[${inode}]`, join(proc, 'self', 'fd', String(fd + 20))))
  symlinkSync('/dev/null', join(proc, 'self', 'fd', '0'))
  writeFileSync(join(proc, 'net', 'tcp'), [header, ...tcp].join('\n') + '\n')
  if (tcp6) writeFileSync(join(proc, 'net', 'tcp6'), [header, ...tcp6].join('\n') + '\n')
  return proc
}

// port 46486 = B596; 10.0.4.23 = 1704000A; 127.0.0.1 = 0100007F; 52.1.2.3 (Ring) = 03020134
test('counts connections to the ports this process listens on, from other hosts', (t) => {
  const proc = fakeProc(t, {
    ownInodes: ['100', '101', '102', '103', '104', '105'],
    tcp: [
      line('00000000:B596', '00000000:0000', '0A', '100'), // the bridge's HomeKit port
      line('F5040A0A:B596', '1704000A:C001', '01', '101'), // the home hub
      line('0100007F:B596', '0100007F:D000', '01', '102'), // a local client: not HomeKit
      line('F5040A0A:B596', '1804000A:C002', '01', '999'), // another process's socket
      line('F5040A0A:A000', '03020134:01BB', '01', '103'), // the plugin's own connection to Ring
      line('F5040A0A:B596', '1904000A:C003', '06', '104'), // closing (TIME_WAIT)
    ],
    tcp6: [
      // an IPv4 phone on the IPv6 socket
      line('00000000000000000000000000000000:B596', '0000000000000000FFFF00001A04000A:C004', '01', '105'),
    ],
  })
  assert.deepEqual(readHomeKitConnections(proc), {
    ports: [46486],
    connections: [
      { port: 46486, remote: '10.0.4.23:49153' },
      { port: 46486, remote: '10.0.4.26:49156' },
    ],
  })
})

test('writes IPv6 addresses in their short form and leaves out ::1', (t) => {
  const proc = fakeProc(t, {
    ownInodes: ['1', '2', '3'],
    tcp: [],
    tcp6: [
      line('00000000000000000000000000000000:B596', '00000000000000000000000000000000:0000', '0A', '1'),
      // fe80::1 (link-local)
      line('00000000000000000000000000000000:B596', '000080FE000000000000000001000000:C005', '01', '2'),
      line('00000000000000000000000001000000:B596', '00000000000000000000000001000000:C006', '01', '3'),
    ],
  })
  assert.deepEqual(readHomeKitConnections(proc), {
    ports: [46486],
    connections: [{ port: 46486, remote: '[fe80::1]:49157' }],
  })
})

test('reports nothing where /proc cannot be read', (t) => {
  const proc = mkdtempSync(join(tmpdir(), 'rsv-proc-'))
  t.after(() => rmSync(proc, { recursive: true, force: true }))
  assert.equal(readHomeKitConnections(proc), undefined)
})

test('finds the port this process listens on in the real /proc', { skip: process.platform !== 'linux' }, async (t) => {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { port } = server.address(),
    connections = readHomeKitConnections()
  assert.ok(connections.ports.includes(port))
  assert.deepEqual(connections.connections, []) // nothing connected from another host
})

test('formats durations for the log', () => {
  assert.equal(formatDuration(40_000), '40 s')
  assert.equal(formatDuration(14 * 60_000), '14 min')
  assert.equal(formatDuration((9 * 60 + 12) * 60_000), '9 h 12 min')
})

const BRIDGE = 46486,
  CAMERA = 52101
const on = (port, remotes) => remotes.map((remote) => ({ port, remote }))

function monitorWith(remotes, { ports = [BRIDGE], cameraRemotes = [], events } = {}) {
  const clock = { now: 0 },
    logs = []
  let connections = { ports, connections: [...on(BRIDGE, remotes), ...on(CAMERA, cameraRemotes)] }
  const log = {
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
    debug: (m) => logs.push(['debug', m]),
  }
  const monitor = new HomeKitConnectionMonitor(log, () => connections, () => clock.now, events)
  // minutes since start; the bridge's connections (and the cameras') from then on
  const check = (minutes, bridge, camera = cameraRemotes) => {
    clock.now = minutes * 60_000
    if (bridge) {
      cameraRemotes = camera
      connections = { ports, connections: [...on(BRIDGE, bridge), ...on(CAMERA, camera)] }
    }
    monitor.check()
  }
  const info = () => logs.filter(([level]) => level !== 'debug')
  return { monitor, check, logs, info }
}

test('logs the connections to the bridge when it starts, and only debug for a phone coming and going', () => {
  const { check, logs, info } = monitorWith(['10.0.4.23:49153'])
  check(1)
  assert.deepEqual(logs, [
    ['info', 'HomeKit connections to this bridge (port 46486): 1 (10.0.4.23)'],
  ])
  logs.length = 0
  check(2, ['10.0.4.23:49153', '10.0.4.30:50000'])
  check(5, ['10.0.4.23:49153'])
  assert.equal(logs.length, 2)
  assert.deepEqual(info(), [])
})

test('without a home hub, a phone visit is logged at debug level only, and nothing is warned', () => {
  const { check, info } = monitorWith([])
  check(1)
  check(5, ['10.0.4.30:50000'])
  check(8, [])
  check(8 + 2 * 60)
  assert.deepEqual(info(), [['info', 'HomeKit connections to this bridge (port 46486): none']])
})

test('logs the hub closing its connection, warns after 10 minutes without any, and again next time', () => {
  const { check, logs, info } = monitorWith(['10.0.4.23:49153'])
  check(1)
  check(2 * 60) // the hub's connection has been open well over 30 minutes
  logs.length = 0

  check(9 * 60 + 13, [])
  assert.deepEqual(logs, [
    ['info', 'HomeKit connection from 10.0.4.23 to this bridge (port 46486) closed after 9 h 12 min; none now'],
  ])
  logs.length = 0

  check(9 * 60 + 13 + 9) // 9 minutes without: not yet
  assert.deepEqual(logs, [])
  check(9 * 60 + 13 + HOMEKIT_ABSENT_WARNING_MS / 60_000)
  assert.equal(logs.length, 1)
  assert.equal(logs[0][0], 'warn')
  assert.match(
    logs[0][1],
    /^No HomeKit connection to this bridge \(port 46486\) for 10 min: the home hub seems to have lost it/,
  )
  check(9 * 60 + 13 + 60) // once per absence
  assert.equal(logs.length, 1)
  logs.length = 0

  check(9 * 60 + 13 + 61, ['10.0.4.23:49200'])
  assert.deepEqual(logs, [
    ['info', 'HomeKit connection from 10.0.4.23 to this bridge (port 46486) opened; 1 (10.0.4.23) now (none for 1 h 1 min)'],
  ])
  logs.length = 0

  // the hub's new connection (46 minutes old) closes too
  check(11 * 60, [])
  check(11 * 60 + 10)
  assert.deepEqual(
    info().map(([level]) => level),
    ['info', 'warn'],
    'the next absence is logged and warned about too',
  )
})

test('a connection that closes after 30 minutes or more counts as a home hub\'s', () => {
  const { check, logs } = monitorWith(['10.0.4.23:49153'])
  check(1)
  check(60, []) // seen once, at 1 minute; closed 59 minutes later
  logs.length = 0
  check(70)
  assert.equal(logs.length, 1)
  assert.match(logs[0][1], /^No HomeKit connection to this bridge \(port 46486\) for 10 min/)
})

test('counts only the bridge\'s own port: the cameras\' connections do not hide it losing the hub', () => {
  const { monitor, check, logs } = monitorWith(['10.0.4.23:49153'], {
    ports: [BRIDGE, CAMERA],
    cameraRemotes: ['10.0.4.23:49160'],
  })
  monitor.setBridgePorts([BRIDGE]) // as captured before the cameras were published
  check(1)
  assert.deepEqual(logs[0], [
    'info',
    'HomeKit connections to this bridge (port 46486): 1 (10.0.4.23); cameras have ports of their own (52101), not counted',
  ])
  check(2 * 60)
  logs.length = 0
  check(3 * 60, [], ['10.0.4.23:49160']) // the hub keeps the camera, drops the bridge
  check(3 * 60 + 10)
  assert.deepEqual(
    logs.map(([level]) => level),
    ['info', 'warn'],
  )
})

test('takes the bridge port from the ports listening before the cameras are published', () => {
  const logs = []
  let connections = { ports: [BRIDGE], connections: [] }
  const monitor = new HomeKitConnectionMonitor(
    { info: (m) => logs.push(m), warn() {}, debug() {} },
    () => connections,
    () => 0,
  )
  monitor.captureBridgePorts()
  connections = { ports: [BRIDGE, CAMERA], connections: on(CAMERA, ['10.0.4.23:49160']) }
  monitor.check()
  assert.match(logs[0], /^HomeKit connections to this bridge \(port 46486\): none; cameras have ports of their own \(52101\)/)
})

test('skips a check that cannot read /proc this time, and stops only where there is none', () => {
  const debug = []
  let result = () => {
    throw Object.assign(new Error('too many open files'), { code: 'EMFILE' })
  }
  const monitor = new HomeKitConnectionMonitor(
    { info() {}, warn() {}, debug: (m) => debug.push(m) },
    () => result(),
  )
  monitor.start(60_000)
  monitor.check()
  assert.equal(monitor.running, true, 'a passing error')
  assert.match(debug[0], /this time: Error: too many open files/)

  result = () => undefined
  monitor.check()
  assert.equal(monitor.running, false, 'no /proc')
  assert.match(debug[1], /cannot be counted here/)
})

test('a child bridge checks its HomeKit connections from launch until shutdown; the main bridge does not', (t) => {
  const make = () => {
    const events = {},
      api = { on: (event, handler) => (events[event] = handler), user: { storagePath: () => tmpdir() } },
      log = { info() {}, debug() {}, error() {}, warn() {} },
      // as Homebridge passes it: without _bridge, which it removes in a child bridge
      platform = new RingPlatform(log, { platform: 'Ring Secure Video', disableLogs: true }, api)
    return { events, monitor: platform.homeKitConnections }
  }
  const [script, send] = [process.argv[1], process.send]
  t.after(() => {
    process.argv[1] = script
    process.send = send
  })
  process.send = () => true // hb-service forks the main bridge too

  process.argv[1] = '/usr/lib/node_modules/homebridge/dist/childBridgeFork.js'
  const child = make()
  assert.equal(child.monitor.running, false)
  child.events.didFinishLaunching()
  assert.equal(child.monitor.running, true)
  child.events.shutdown()
  assert.equal(child.monitor.running, false)

  process.argv[1] = '/usr/lib/node_modules/homebridge/bin/homebridge'
  assert.equal(make().monitor, undefined)
})

test('once the cameras are published without the bridge port known, no port is taken for it', () => {
  const debug = []
  let connections = { ports: [], connections: [] } // the bridge isn't listening (yet)
  const monitor = new HomeKitConnectionMonitor(
    { info() {}, warn() {}, debug: (m) => debug.push(m) },
    () => connections,
    () => 0,
  )
  monitor.start(60_000)
  monitor.captureBridgePorts()
  connections = { ports: [CAMERA], connections: on(CAMERA, ['10.0.4.23:49160']) }
  monitor.check()
  assert.match(debug[0], /HomeKit port of this bridge is not known/)
  assert.equal(monitor.running, false, 'it can\'t be known later either')
})

test('isChildBridge tells a child bridge by its script', () => {
  assert.equal(isChildBridge('/usr/lib/node_modules/homebridge/dist/childBridgeFork.js'), true)
  assert.equal(isChildBridge('/usr/lib/node_modules/homebridge/lib/childBridgeFork.js'), true)
  assert.equal(isChildBridge('/opt/homebridge/lib/node_modules/homebridge/bin/homebridge'), false)
  assert.equal(isChildBridge(undefined), false)
})

test('reports how long the bridge has had no connection, its port, and whether a hub was seen', () => {
  const absent = [],
    present = []
  const { monitor, check } = monitorWith([], {
    ports: [BRIDGE, CAMERA],
    cameraRemotes: ['10.0.4.23:49160'], // not the bridge's: no help
    events: {
      onAbsent: (ms, bridge) => absent.push([ms / 60_000, bridge.port, bridge.hubSeen]),
      onPresent: (bridge) => present.push(bridge),
    },
  })
  monitor.setBridgePorts([BRIDGE])
  check(1) // none from the first check
  check(2)
  check(3, ['10.0.4.23:49153'])
  check(40, []) // open 37 minutes: a hub's
  check(42)
  assert.deepEqual(absent, [
    [0, '46486', false],
    [1, '46486', false],
    [0, '46486', true],
    [2, '46486', true],
  ])
  assert.deepEqual(present, [{ port: '46486', hubSeen: false }])
})

test('Restart Bridge Without HomeKit takes 10 to 1440 minutes, and is off otherwise', () => {
  const minutes = (value) => getHomeKitRestartMinutes({ restartBridgeWithoutHomeKitMinutes: value })
  assert.equal(minutes(10), 10)
  assert.equal(minutes(1440), 1440)
  for (const off of [undefined, 0, 9, 1441, '30', Number.NaN, null]) {
    assert.equal(minutes(off), undefined, `${off} is off`)
  }
})

function asChildBridge(t) {
  const script = process.argv[1]
  process.argv[1] = '/usr/lib/node_modules/homebridge/dist/childBridgeFork.js'
  t.after(() => (process.argv[1] = script))
}

const PORT = '46486',
  hub = { port: PORT, hubSeen: true },
  noHub = { port: PORT, hubSeen: false },
  stateFile = (dir) => join(dir, '.ring-secure-video-homekit.json')

function restartPlatform(t, { minutes = 30, states } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rsv-homekit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  if (states) writeFileSync(stateFile(dir), JSON.stringify(states))
  const warnings = [],
    restarts = [],
    api = { on() {}, user: { storagePath: () => dir } }
  class TestPlatform extends RingPlatform {
    restartChildBridge() {
      restarts.push(true)
    }
  }
  const log = { info() {}, debug() {}, error() {}, warn: (m) => warnings.push(m) },
    config = { platform: 'Ring Secure Video', disableLogs: true, restartBridgeWithoutHomeKitMinutes: minutes }
  return { dir, warnings, restarts, platform: new TestPlatform(log, config, api) }
}

test('a child bridge restarts once it has had no HomeKit connection for the set minutes', (t) => {
  asChildBridge(t)
  const { dir, warnings, restarts, platform: p } = restartPlatform(t)
  p.homeKitAbsent(29 * 60_000, hub)
  assert.equal(restarts.length, 0)
  p.homeKitAbsent(30 * 60_000, hub)
  assert.equal(restarts.length, 1)
  assert.match(warnings.at(-1), /No HomeKit connection to this bridge for 30 min: restarting this child bridge/)
  const state = readHomeKitRestartState(dir, PORT)
  assert.equal(state.restartsWithoutConnection, 1)
  assert.ok(Math.abs(state.lastRestartAt - Date.now()) < 5000)
})

test('without a home hub seen, no restart series starts; one under way goes on', (t) => {
  asChildBridge(t)
  const fresh = restartPlatform(t)
  fresh.platform.homeKitAbsent(60 * 60_000, noHub)
  assert.equal(fresh.restarts.length, 0, 'no hub: having no connection is normal')

  // restarted for it an hour ago: the new run hasn't seen the hub (it's what is missing)
  const goingOn = restartPlatform(t, {
    states: { [PORT]: { lastRestartAt: Date.now() - HOMEKIT_RESTART_INTERVAL_MS - 1000, restartsWithoutConnection: 1 } },
  })
  goingOn.platform.homeKitAbsent(40 * 60_000, noHub)
  assert.equal(goingOn.restarts.length, 1)
})

test('it restarts at most once an hour, a clock set back aside', (t) => {
  asChildBridge(t)
  const recent = restartPlatform(t, {
    states: { [PORT]: { lastRestartAt: Date.now() - 59 * 60_000, restartsWithoutConnection: 1 } },
  })
  recent.platform.homeKitAbsent(40 * 60_000, hub)
  assert.equal(recent.restarts.length, 0)

  const earlier = restartPlatform(t, {
    states: { [PORT]: { lastRestartAt: Date.now() - HOMEKIT_RESTART_INTERVAL_MS - 1000, restartsWithoutConnection: 1 } },
  })
  earlier.platform.homeKitAbsent(40 * 60_000, hub)
  assert.equal(earlier.restarts.length, 1)
  assert.equal(readHomeKitRestartState(earlier.dir, PORT).restartsWithoutConnection, 2)

  const future = restartPlatform(t, {
    states: { [PORT]: { lastRestartAt: Date.now() + 24 * HOMEKIT_RESTART_INTERVAL_MS, restartsWithoutConnection: 1 } },
  })
  future.platform.homeKitAbsent(40 * 60_000, hub)
  assert.equal(future.restarts.length, 1, 'a restart dated in the future holds nothing up')
})

test('after 2 restarts that brought no connection, it waits for one before restarting again', (t) => {
  asChildBridge(t)
  const { dir, warnings, restarts, platform: p } = restartPlatform(t, {
    states: { [PORT]: { lastRestartAt: Date.now() - 2 * HOMEKIT_RESTART_INTERVAL_MS, restartsWithoutConnection: 2 } },
  })
  p.homeKitAbsent(40 * 60_000, hub)
  p.homeKitAbsent(41 * 60_000, hub)
  assert.equal(restarts.length, 0)
  assert.equal(warnings.length, 1, 'logged once')
  assert.match(warnings[0], /2 restarts in a row brought none/)

  p.homeKitPresent(hub)
  assert.equal(readHomeKitRestartState(dir, PORT).restartsWithoutConnection, 0)
  p.homeKitAbsent(30 * 60_000, hub)
  assert.equal(restarts.length, 1)
})

test('each child bridge keeps its own restart state', (t) => {
  asChildBridge(t)
  const other = '51830',
    { dir, restarts, platform: p } = restartPlatform(t, {
      states: { [other]: { lastRestartAt: Date.now(), restartsWithoutConnection: 2 } },
    })
  p.homeKitAbsent(30 * 60_000, hub)
  assert.equal(restarts.length, 1, "the other bridge's restarts don't hold this one up")
  p.homeKitPresent(hub)
  assert.deepEqual(readHomeKitRestartState(dir, other), {
    lastRestartAt: JSON.parse(readFileSync(stateFile(dir)))[other].lastRestartAt,
    restartsWithoutConnection: 2,
  })
})

test('saved values that are not numbers count as none', (t) => {
  asChildBridge(t)
  const { dir } = restartPlatform(t, {
    states: { [PORT]: { lastRestartAt: 'yesterday', restartsWithoutConnection: '1' } },
  })
  assert.deepEqual(readHomeKitRestartState(dir, PORT), {
    lastRestartAt: undefined,
    restartsWithoutConnection: undefined,
  })
})

test('it waits for recordings and live views to end', (t) => {
  asChildBridge(t)
  const { restarts, platform: p } = restartPlatform(t),
    release = hksvRecordingQueue.trackRingCall()
  try {
    p.homeKitAbsent(30 * 60_000, hub)
    assert.equal(restarts.length, 0)
  } finally {
    release()
  }
  p.homeKitAbsent(31 * 60_000, hub)
  assert.equal(restarts.length, 1)
})

test('a restart held up by a call for an hour is warned about, once', (t) => {
  asChildBridge(t)
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 })
  const { warnings, restarts, platform: p } = restartPlatform(t),
    release = hksvRecordingQueue.trackRingCall()
  try {
    p.homeKitAbsent(30 * 60_000, hub)
    t.mock.timers.tick(HOMEKIT_RESTART_INTERVAL_MS)
    p.homeKitAbsent(90 * 60_000, hub)
    p.homeKitAbsent(91 * 60_000, hub)
  } finally {
    release()
  }
  assert.equal(restarts.length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /has waited 1 h 0 min for recordings and live views to end \(0 recording, 1 Ring call\)/)
})

test('it does not restart when its state cannot be saved, and says so once', (t) => {
  asChildBridge(t)
  const { dir, warnings, restarts, platform: p } = restartPlatform(t)
  mkdirSync(stateFile(dir)) // a folder where the file should go: it can't be written
  p.homeKitAbsent(30 * 60_000, hub)
  p.homeKitAbsent(31 * 60_000, hub)
  assert.equal(restarts.length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /not restarting in this run, as its state could not be saved/)
})

test('not while shutting down, nor without the setting', (t) => {
  asChildBridge(t)
  const events = {},
    dir = mkdtempSync(join(tmpdir(), 'rsv-homekit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const restarts = []
  class TestPlatform extends RingPlatform {
    restartChildBridge() {
      restarts.push(true)
    }
  }
  const api = { on: (event, handler) => (events[event] = handler), user: { storagePath: () => dir } },
    log = { info() {}, debug() {}, error() {}, warn() {} },
    p = new TestPlatform(log, { platform: 'Ring Secure Video', disableLogs: true, restartBridgeWithoutHomeKitMinutes: 30 }, api)
  events.shutdown()
  p.homeKitAbsent(30 * 60_000, hub)
  assert.equal(restarts.length, 0)

  const off = restartPlatform(t, { minutes: 0 })
  off.platform.homeKitAbsent(24 * 60 * 60_000, hub)
  off.platform.homeKitPresent(hub)
  assert.equal(off.restarts.length, 0)
  assert.deepEqual(off.warnings, [])
  assert.equal(existsSync(stateFile(off.dir)), false, 'nothing saved')
})

test('the monitor reports to the platform: its checks lead to the restart', (t) => {
  asChildBridge(t)
  const { restarts, platform: p } = restartPlatform(t, { minutes: 10 })
  const monitor = p.homeKitConnections,
    clock = { now: 0 },
    reads = [
      { ports: [BRIDGE], connections: on(BRIDGE, ['10.0.4.23:49153']) }, // the hub...
      { ports: [BRIDGE], connections: on(BRIDGE, ['10.0.4.23:49153']) },
      { ports: [BRIDGE], connections: [] }, // ...lost after 40 minutes
      { ports: [BRIDGE], connections: [] },
    ]
  // stand in for /proc and the clock of the platform's own monitor
  monitor.read = () => reads.shift()
  monitor.elapsed = () => clock.now
  for (const minutes of [1, 41, 42, 52]) {
    clock.now = minutes * 60_000
    monitor.check()
  }
  assert.equal(restarts.length, 1)
})

test('on the main bridge, the setting is ignored with a warning', (t) => {
  const script = process.argv[1]
  process.argv[1] = '/usr/lib/node_modules/homebridge/bin/homebridge'
  t.after(() => (process.argv[1] = script))
  const { warnings, platform: p } = restartPlatform(t)
  assert.equal(p.homeKitConnections, undefined)
  assert.match(warnings[0], /only works when the plugin runs as a child bridge/)
})
