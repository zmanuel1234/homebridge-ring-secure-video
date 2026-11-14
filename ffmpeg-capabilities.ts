import { execFile } from 'node:child_process'
import { accessSync, constants, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { defaultFfmpegPath } from '@homebridge/camera-utils'
import { getFfmpegPath } from 'ring-client-api/ffmpeg'
import { logDebug, logError } from 'ring-client-api/util'

const execFileAsync = promisify(execFile)

/** A probe that hangs must not hold every recording (they wait for it) forever. */
export const FFMPEG_PROBE_TIMEOUT_MS = 10_000

export interface FfmpegCapabilities {
  /** Encoders the recording FFmpeg lists that can also work on this machine. */
  encoders: Set<string>
  hwaccels: Set<string>
}

let cachedCapabilities: Promise<FfmpegCapabilities> | undefined,
  /** Set when the last check failed: when to ask FFmpeg again. */
  retryAt: number | undefined,
  reportedFailure = false

/** How long a failed check is kept, so a hanging FFmpeg doesn't hold every recording. */
export const FFMPEG_PROBE_RETRY_MS = 5 * 60_000

/** The FFmpeg HKSV recordings run with: the plugin's ffmpegPath, or the bundled one. */
export function getRecordingFfmpegPath() {
  return getFfmpegPath() || defaultFfmpegPath
}

function parseNames(output: string) {
  return new Set(
    output
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
}

export async function getFfmpegOutput(
  args: string[],
  ffmpegPath = getRecordingFfmpegPath(),
  timeout = FFMPEG_PROBE_TIMEOUT_MS,
) {
  try {
    const { stdout, stderr } = await execFileAsync(ffmpegPath, args, {
      maxBuffer: 1024 * 1024,
      timeout,
    })

    return `${stdout}\n${stderr}`
  } catch (e: any) {
    return `${e.stdout ?? ''}\n${e.stderr ?? ''}`
  }
}

/**
 * The names of the Linux video devices Homebridge can open (a Raspberry Pi 4's encoder is
 * "bcm2835-codec-encode"). A device listed in sysfs but not usable, as in Docker without the
 * device passed through or without access to the video group, is left out.
 */
export function getV4l2DeviceNames(sysfs = '/sys/class/video4linux', dev = '/dev') {
  try {
    return readdirSync(sysfs).flatMap((device) => {
      try {
        accessSync(join(dev, device), constants.R_OK | constants.W_OK)
        return [readFileSync(join(sysfs, device, 'name'), 'utf8').trim()]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

/**
 * A video encoder device: not a JPEG/image encoder (the Pi 4 has both) or an MPEG capture card's
 * ("ivtv0 encoder MPG").
 */
export function isV4l2VideoEncoder(name: string) {
  return /encode|-enc$/i.test(name) && !/image|jpeg|mpe?g/i.test(name)
}

/**
 * FFmpeg builds list hardware encoders whether or not the hardware is there: the bundled FFmpeg
 * and Ubuntu's list h264_v4l2m2m on any x86 machine, where encoding with it fails. So
 * h264_v4l2m2m only counts on Linux with a usable V4L2 video encoder device (a Raspberry Pi 4 has
 * one, a Pi 5 none), and h264_videotoolbox only on macOS.
 */
export function getUsableEncoders(
  listed: Set<string>,
  platform: string = process.platform,
  v4l2DeviceNames: string[] = platform === 'linux' ? getV4l2DeviceNames() : [],
) {
  const usable = new Set(listed)
  if (platform !== 'linux' || !v4l2DeviceNames.some(isV4l2VideoEncoder)) {
    usable.delete('h264_v4l2m2m')
  }
  if (platform !== 'darwin') {
    usable.delete('h264_videotoolbox')
  }
  return usable
}

async function loadCapabilities(): Promise<FfmpegCapabilities> {
  const [encodersOutput, hwaccelsOutput] = await Promise.all([
    getFfmpegOutput(['-hide_banner', '-encoders']),
    getFfmpegOutput(['-hide_banner', '-hwaccels']),
  ])

  if (/Encoders:/.test(encodersOutput)) {
    retryAt = undefined
  } else {
    // FFmpeg didn't start or answer in time (a slow first start on a busy Pi): ask again a little
    // later rather than record in software until a restart.
    retryAt = Date.now() + FFMPEG_PROBE_RETRY_MS
    const message = `Could not list the encoders of FFmpeg (${getRecordingFfmpegPath()}); codec auto records with libx264 until it answers (asked again after ${FFMPEG_PROBE_RETRY_MS / 60_000} minutes)`
    if (reportedFailure) {
      logDebug(message)
    } else {
      reportedFailure = true
      logError(message)
    }
  }

  const capabilities = {
    encoders: getUsableEncoders(parseNames(encodersOutput)),
    hwaccels: parseNames(hwaccelsOutput),
  }

  logDebug(
    `FFmpeg HKSV capabilities: encoders=${[
      'h264_v4l2m2m',
      'h264_videotoolbox',
      'libx264',
    ]
      .filter((encoder) => capabilities.encoders.has(encoder))
      .join(',') || 'none detected'}`,
  )

  return capabilities
}

export function getFfmpegCapabilities() {
  if (retryAt !== undefined && Date.now() >= retryAt) {
    retryAt = undefined
    cachedCapabilities = undefined
  }
  cachedCapabilities ??= loadCapabilities()
  return cachedCapabilities
}
