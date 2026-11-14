import type { AlarmMode, RingApiOptions } from 'ring-client-api'
import { logError, logInfo } from 'ring-client-api/util'
import {
  closeSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import type { Stats } from 'fs'
import type { API } from 'homebridge'
import { createHash, randomBytes } from 'crypto'
import { basename, dirname, join } from 'path'
import type {
  HksvVideoCodec,
  MediaConfigInput,
} from './media-config.ts'

const systemIdFileName = '.ring.json'
export const controlCenterDisplayName = 'homebridge-ring-secure-video'

export interface RingPlatformConfig extends RingApiOptions {
  alarmOnEntryDelay?: boolean
  enableHksv?: boolean
  forceRefreshRingPushCredentials?: boolean
  forceRefreshRingApiSession?: boolean
  automaticSessionRefresh?: boolean
  sessionRefreshSensor?: boolean
  doorbellPressMotion?: boolean
  enableCameraMotionHistory?: boolean
  disableHksvOnBattery?: boolean
  hksvPrebufferLengthMs?: number
  hksvFragmentLengthMs?: number
  hksvMaxRecordingSeconds?: number
  hksvVideoBitrateKbps?: number
  hksvVideoMaxBitrateKbps?: number
  hksvVideoBufferSizeKbps?: number
  hksvVideoCrf?: number
  hksvVideoKeyframeInterval?: number
  hksvPerformanceMode?: 'quality' | 'balanced' | 'rpi'
  hksvMaxQueuedBytes?: number
  hksvMaxConcurrentRecordings?: number
  hksvVideoPreset?:
    | 'ultrafast'
    | 'superfast'
    | 'veryfast'
    | 'faster'
    | 'fast'
    | 'medium'
    | 'slow'
    | 'slower'
    | 'veryslow'
  /**
   * Media configuration. Values in media.recording take precedence over
   * profile defaults and legacy HKSV tuning fields.
   */
  media?: MediaConfigInput
  homeKitAccessoryTag?: string
  cameraVideoCodec?: HksvVideoCodec
  beamDurationSeconds?: number
  ffmpegPath?: string
  hideLightGroups?: boolean
  hideDoorbellSwitch?: boolean
  hideCameraLight?: boolean
  hideCameraMotionSensor?: boolean
  cameraMotionNotificationSensor?: boolean
  hideCameraSirenSwitch?: boolean
  hideInHomeDoorbellSwitch?: boolean
  hideAlarmSirenSwitch?: boolean
  externalCameraIdSalt?: string
  hideDeviceIds?: string[]
  nightModeBypassFor: AlarmMode
  onlyDeviceTypes?: string[]
  showPanicButtons?: boolean
  disableLogs?: boolean
}

// Errors where a temporary file next to the target can't be created or can't replace it, but
// writing the file in place may still work: a folder you can't write to, a file bind-mounted on
// its own (Docker), a file another program has open on Windows, another file system, an owner or
// group a container can't map (EINVAL from fchown).
const writeInPlaceOn = new Set(['EACCES', 'EPERM', 'EBUSY', 'EXDEV', 'EROFS', 'EINVAL'])

const reportedInPlace = new Set<string>()

function writeInPlace(filePath: string, contents: string, reason: string) {
  // Once per file: a bind-mounted config.json would otherwise log this with every token renewal.
  if (!reportedInPlace.has(filePath)) {
    reportedInPlace.add(filePath)
    logInfo(`Writing ${filePath} in place (${reason})`)
  }
  writeFileSync(filePath, contents)
}

function removeStaleTemporaryFiles(folder: string, name: string) {
  try {
    for (const entry of readdirSync(folder)) {
      if (!entry.startsWith(`.${name}.`) || !entry.endsWith('.tmp')) continue
      const file = join(folder, entry)
      // Older than a minute: left behind by a crash, not another writer's work in progress.
      if (Date.now() - statSync(file).mtimeMs > 60_000) rmSync(file, { force: true })
    }
  } catch {
    // best effort
  }
}

/**
 * Replaces a file's contents so that it is never left half-written: the new contents go to a
 * temporary file next to it, are flushed to disk, and then take the file's place in one step. A
 * power cut or a full disk on a Raspberry Pi would otherwise leave config.json cut short, and
 * Homebridge would not start. A symlinked file is written where its link points, and the file
 * keeps its permissions. Where that can't work (the file belongs to someone else and this isn't
 * root, a folder you can't write to, a bind-mounted file, ...) it is written in place as before.
 */
export function writeFileAtomic(filePath: string, contents: string) {
  let target = filePath,
    previous: Stats | undefined
  try {
    target = realpathSync(filePath)
    previous = statSync(target)
  } catch {
    let dangling = false
    try {
      dangling = lstatSync(filePath).isSymbolicLink()
    } catch {
      // a new file
    }
    if (dangling) {
      return writeInPlace(filePath, contents, 'its link points nowhere yet')
    }
  }

  const uid = process.getuid?.()
  if (previous && uid !== undefined && uid !== 0 && previous.uid !== uid) {
    // A new file would be owned by this user instead of the file's owner.
    return writeInPlace(target, contents, 'it belongs to another user')
  }

  const folder = dirname(target),
    name = basename(target),
    temporary = join(folder, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      // Unlike writeSync, this writes everything or throws (e.g. ENOSPC on a full disk).
      writeFileSync(fd, contents)
      // Owner and group first: changing them clears setuid/setgid bits set by a chmod.
      if (previous && uid === 0) {
        fchownSync(fd, previous.uid, previous.gid)
      } else if (previous && previous.gid !== process.getgid?.()) {
        // A shared group (e.g. for the Homebridge UI); EPERM writes in place, keeping it.
        fchownSync(fd, -1, previous.gid)
      }
      fchmodSync(fd, previous ? previous.mode & 0o7777 : 0o644 & ~process.umask())
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, target)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // the original error matters
    }
    const code = (error as NodeJS.ErrnoException).code
    if (code && writeInPlaceOn.has(code)) {
      return writeInPlace(target, contents, code)
    }
    throw error
  }

  // Make the rename itself survive a power cut (best effort; not possible on every system).
  try {
    const dir = openSync(folder, 'r')
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  } catch {
    // ignore
  }
  removeStaleTemporaryFiles(folder, name)
}

export function updateHomebridgeConfig(
  homebridge: API,
  update: (config: string) => string,
) {
  try {
    const configPath = homebridge.user.configPath(),
      config = readFileSync(configPath).toString(),
      updatedConfig = update(config)

    if (config !== updatedConfig) {
      writeFileAtomic(configPath, updatedConfig)
      return true
    }
  } catch (error) {
    logError('Failed to update Homebridge config')
    logError(error)
  }

  return false
}

function createSystemId() {
  return createHash('sha256').update(randomBytes(32)).digest('hex')
}

interface RingContext {
  systemId: string
}

export function getSystemId(homebridgeStoragePath: string) {
  const filePath = join(homebridgeStoragePath, systemIdFileName)

  try {
    const ringContext: RingContext = JSON.parse(
      readFileSync(filePath).toString(),
    )
    if (ringContext.systemId) {
      return ringContext.systemId
    }
  } catch {
    // expect errors if file doesn't exist or is in a bad format
  }

  const systemId = createSystemId(),
    ringContext: RingContext = { systemId }

  try {
    mkdirSync(homebridgeStoragePath, { recursive: true })
    writeFileAtomic(filePath, JSON.stringify(ringContext))
  } catch (error) {
    logError('Failed to persist Ring system id')
    logError(error)
  }

  return systemId
}

export function rotateSystemId(homebridgeStoragePath: string) {
  const filePath = join(homebridgeStoragePath, systemIdFileName),
    systemId = createSystemId(),
    ringContext: RingContext = { systemId }

  try {
    mkdirSync(homebridgeStoragePath, { recursive: true })
    writeFileAtomic(filePath, JSON.stringify(ringContext))
  } catch (error) {
    logError('Failed to rotate Ring system id')
    logError(error)
  }

  return systemId
}

export const debug = process.env.RING_DEBUG === 'true'
