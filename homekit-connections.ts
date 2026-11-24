import { readdirSync, readFileSync, readlinkSync } from 'fs'
import { endianness } from 'os'
import { performance } from 'perf_hooks'
import { join } from 'path'

/** How often the HomeKit connections to the bridge are counted. */
export const HOMEKIT_CHECK_INTERVAL_MS = 60_000
/**
 * A connection open this long is taken to be a home hub's (the Home app on a phone connects
 * while it is open). Only once one has been seen are connections coming and going logged at info
 * level, and a bridge without any warned about: without a home hub, having none is normal.
 */
export const HOMEKIT_HUB_CONNECTION_MS = 30 * 60_000
/** With no connection for this long, after a hub's was seen, a warning is logged (once). */
export const HOMEKIT_ABSENT_WARNING_MS = 10 * 60_000

export interface HomeKitConnections {
  /**
   * The TCP ports this process listens on: in a child bridge, the bridge's HomeKit port, and one
   * more for each camera (Homebridge gives an external accessory a HomeKit server of its own).
   */
  ports: number[]
  /** The established connections to those ports from other hosts ("address:port"). */
  connections: { port: number; remote: string }[]
}

interface ProcSocket {
  localPort: number
  remote: string
  loopback: boolean
  state: string
  inode: string
}

const LISTEN = '0A',
  ESTABLISHED = '01'

/**
 * /proc/net/tcp writes addresses as the kernel holds them: 32-bit words in host byte order, read
 * here for a little-endian host (Raspberry Pi, x86; see readHomeKitConnections).
 */
function decodeAddress(hex: string): { address: string; loopback: boolean } {
  const bytes: number[] = []
  for (let word = 0; word < hex.length; word += 8) {
    for (let i = 6; i >= 0; i -= 2) {
      bytes.push(parseInt(hex.slice(word + i, word + i + 2), 16))
    }
  }
  const ipv4 = (b: number[]) => ({ address: b.join('.'), loopback: b[0] === 127 })
  if (bytes.length === 4) return ipv4(bytes)
  // an IPv4 client on an IPv6 socket (::ffff:a.b.c.d)
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return ipv4(bytes.slice(12))
  }
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
  // URL writes an IPv6 address in its short form
  const address = new URL(`http://[${groups.join(':')}]`).hostname.slice(1, -1)
  return { address, loopback: address === '::1' }
}

function parseProcNetTcp(text: string): ProcSocket[] {
  const sockets: ProcSocket[] = []
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10) continue
    const [, local, remote, state] = fields,
      [, localPortHex] = local.split(':'),
      [remoteHex, remotePortHex] = remote.split(':'),
      { address, loopback } = decodeAddress(remoteHex),
      remotePort = parseInt(remotePortHex, 16)
    sockets.push({
      localPort: parseInt(localPortHex, 16),
      remote: address.includes(':') ? `[${address}]:${remotePort}` : `${address}:${remotePort}`,
      loopback,
      state,
      inode: fields[9],
    })
  }
  return sockets
}

const isMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')

/**
 * The TCP ports this process listens on and the connections to them from other hosts, read from
 * /proc. Undefined where there is no /proc (not Linux), or on a big-endian host; throws if /proc is
 * there but can't be read this time.
 */
export function readHomeKitConnections(proc = '/proc'): HomeKitConnections | undefined {
  if (endianness() !== 'LE') return undefined
  const fdDirectory = join(proc, 'self', 'fd'),
    ownInodes = new Set<string>()
  let sockets: ProcSocket[]
  try {
    for (const fd of readdirSync(fdDirectory)) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(join(fdDirectory, fd)))
        if (match) ownInodes.add(match[1])
      } catch {
        // closed since it was listed
      }
    }
    sockets = parseProcNetTcp(readFileSync(join(proc, 'net', 'tcp'), 'utf8'))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  try {
    sockets.push(...parseProcNetTcp(readFileSync(join(proc, 'net', 'tcp6'), 'utf8')))
  } catch (error) {
    if (!isMissing(error)) throw error // no IPv6 otherwise
  }
  const own = sockets.filter((socket) => ownInodes.has(socket.inode)),
    ports = [...new Set(own.filter((s) => s.state === LISTEN).map((s) => s.localPort))].sort(
      (a, b) => a - b,
    ),
    connections = own
      .filter((s) => s.state === ESTABLISHED && !s.loopback && ports.includes(s.localPort))
      .map((s) => ({ port: s.localPort, remote: s.remote }))
  return { ports, connections }
}

export function formatDuration(ms: number) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return `${Math.round(ms / 1000)} s`
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

const hostOf = (remote: string) => remote.slice(0, remote.lastIndexOf(':'))

export interface HomeKitConnectionLog {
  info(message: string): void
  warn(message: string): void
  debug(message: string): void
}

/**
 * Logs the HomeKit connections to a child bridge's own port (not its cameras', which have ports
 * of their own), so that when the Home app shows the bridge's accessories as "No Response" the log
 * tells whether the home hub was still connected to it, and since when it wasn't. Counted every
 * minute. Once a home hub's connection has been seen, connections closing, opening after none and
 * a bridge left without any are logged at info level (and warned about after 10 minutes);
 * everything else, such as a phone's Home app coming and going, at debug level.
 */
export class HomeKitConnectionMonitor {
  private readonly log
  private readonly read
  private readonly elapsed
  private timer?: ReturnType<typeof setInterval>
  /** The bridge's own HomeKit port(s). */
  private bridgePorts?: number[]
  /** When each connection (address:port) was first counted. */
  private connectedAt?: Map<string, number>
  private absentSince?: number
  private hubSeen = false
  private warned = false

  constructor(
    log: HomeKitConnectionLog,
    read: () => HomeKitConnections | undefined = () => readHomeKitConnections(),
    elapsed: () => number = () => performance.now(),
  ) {
    this.log = log
    this.read = read
    this.elapsed = elapsed
  }

  /** The bridge's own HomeKit port(s). */
  setBridgePorts(ports: number[]) {
    if (!this.bridgePorts && ports.length) this.bridgePorts = [...ports]
  }

  // Set once the cameras are published: the ports listening from then on are not all the bridge's
  private camerasPublished = false

  /**
   * Takes the ports listening now as the bridge's: called just before the cameras are published
   * (each on a port of its own), when only the bridge listens.
   */
  captureBridgePorts() {
    if (this.bridgePorts || this.camerasPublished) return
    this.camerasPublished = true
    try {
      const connections = this.read()
      if (connections) this.setBridgePorts(connections.ports)
    } catch {
      // the bridge's port stays unknown
    }
  }

  start(intervalMs = HOMEKIT_CHECK_INTERVAL_MS) {
    this.stop()
    this.timer = setInterval(() => this.check(), intervalMs)
    this.timer.unref?.()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = undefined
  }

  get running() {
    return this.timer !== undefined
  }

  check() {
    let read: HomeKitConnections | undefined
    try {
      read = this.read()
    } catch (error) {
      this.log.debug(`Could not count the HomeKit connections to this bridge this time: ${String(error)}`)
      return
    }
    if (!read) {
      this.log.debug('HomeKit connections to this bridge cannot be counted here (no /proc); not checking them')
      this.stop()
      return
    }
    // Until cameras are published (each with a port of its own), only the bridge listens
    if (!this.camerasPublished) this.setBridgePorts(read.ports)
    const bridgePorts = this.bridgePorts
    if (!bridgePorts) {
      // Not listening when the cameras were published: their ports can't be told apart from it now
      if (this.camerasPublished) {
        this.log.debug('The HomeKit port of this bridge is not known; its connections are not counted')
        this.stop()
      }
      return // else not listening yet
    }

    const now = this.elapsed(),
      remotes = read.connections
        .filter(({ port }) => bridgePorts.includes(port))
        .map(({ remote }) => remote)
        .sort(),
      first = this.connectedAt === undefined,
      previous = this.connectedAt ?? new Map<string, number>(),
      current = new Map(remotes.map((remote) => [remote, previous.get(remote) ?? now])),
      port = `port ${bridgePorts.join(', ')}`
    this.connectedAt = current

    const closed = [...previous].filter(([remote]) => !current.has(remote)),
      opened = remotes.filter((remote) => !previous.has(remote))
    for (const [, since] of [...closed, ...current]) {
      if (now - since >= HOMEKIT_HUB_CONNECTION_MS) this.hubSeen = true
    }

    if (first) {
      const cameraPorts = read.ports.filter((p) => !bridgePorts.includes(p))
      this.log.info(
        `HomeKit connections to this bridge (${port}): ${describe(remotes)}${
          cameraPorts.length ? `; cameras have ports of their own (${cameraPorts.join(', ')}), not counted` : ''
        }`,
      )
    }
    for (const [remote, since] of closed) {
      const open = now - since,
        message = `HomeKit connection from ${hostOf(remote)} to this bridge (${port}) closed after ${formatDuration(open)}; ${describe(remotes)} now`
      if (open >= HOMEKIT_HUB_CONNECTION_MS || (this.hubSeen && remotes.length === 0)) {
        this.log.info(message)
      } else {
        this.log.debug(message)
      }
    }
    if (opened.length && !first) {
      const message = `HomeKit connection from ${opened.map(hostOf).join(', ')} to this bridge (${port}) opened; ${describe(remotes)} now`
      if (this.hubSeen && previous.size === 0 && this.absentSince !== undefined) {
        this.log.info(`${message} (none for ${formatDuration(now - this.absentSince)})`)
      } else {
        this.log.debug(message)
      }
    }

    if (remotes.length) {
      this.absentSince = undefined
      this.warned = false
      return
    }
    this.absentSince ??= now
    if (!this.warned && this.hubSeen && now - this.absentSince >= HOMEKIT_ABSENT_WARNING_MS) {
      this.warned = true
      this.log.warn(
        `No HomeKit connection to this bridge (${port}) for ${formatDuration(now - this.absentSince)}: the home hub seems to have lost it, and the Home app may show its accessories as "No Response". If they do, restart this bridge (or the home hub).`,
      )
    }
  }
}

function describe(remotes: string[]) {
  return remotes.length ? `${remotes.length} (${remotes.map(hostOf).join(', ')})` : 'none'
}
