import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatDuration,
  HOMEKIT_ABSENT_WARNING_MS,
  HomeKitConnectionMonitor,
  readHomeKitConnections,
} from '../lib/homekit-connections.js'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { setHap } from '../lib/hap.js'
import { RingPlatform } from '../lib/ring-platform.js'
import { isChildBridge } from '../lib/config.js'

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

function monitorWith(remotes, { ports = [BRIDGE], cameraRemotes = [] } = {}) {
  const clock = { now: 0 },
    logs = []
  let connections = { ports, connections: [...on(BRIDGE, remotes), ...on(CAMERA, cameraRemotes)] }
  const log = {
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
    debug: (m) => logs.push(['debug', m]),
  }
  const monitor = new HomeKitConnectionMonitor(log, () => connections, () => clock.now)
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
