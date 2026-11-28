import type { RingPlatformConfig } from './config.ts'

export type MediaProfile = 'adaptive' | 'lowPower' | 'quality'

export type HksvVideoCodec =
  | 'auto'
  | 'copy'
  | 'libx264'
  | 'h264_v4l2m2m'
  | 'h264_videotoolbox'

export type HksvVideoPreset =
  | 'ultrafast'
  | 'superfast'
  | 'veryfast'
  | 'faster'
  | 'fast'
  | 'medium'
  | 'slow'
  | 'slower'
  | 'veryslow'

export type MediaRateControl = 'cbr' | 'vbr'

export interface MediaRecordingConfigInput {
  codec?: HksvVideoCodec
  bitrateKbps?: number
  maxBitrateKbps?: number
  bufferSizeKbps?: number
  rateControl?: MediaRateControl
  crf?: number
  preset?: HksvVideoPreset
  keyframeInterval?: number
  prebufferLengthMs?: number
  fragmentLengthMs?: number
  maxDurationSeconds?: number
  maxQueuedBytes?: number
  maxConcurrentRecordings?: number
}

export interface MediaConfigInput {
  profile?: MediaProfile
  recording?: MediaRecordingConfigInput
}

export interface NormalizedMediaRecordingConfig {
  codec: HksvVideoCodec
  bitrateKbps: number
  maxBitrateKbps: number
  bufferSizeKbps: number
  rateControl: MediaRateControl
  crf?: number
  preset: HksvVideoPreset
  keyframeInterval: number
  prebufferLengthMs: number
  fragmentLengthMs: number
  maxDurationSeconds?: number
  maxQueuedBytes: number
  maxConcurrentRecordings: number
}

export interface NormalizedMediaConfig {
  profile: MediaProfile
  recording: NormalizedMediaRecordingConfig
}

const codecs: readonly HksvVideoCodec[] = [
  'auto',
  'copy',
  'libx264',
  'h264_v4l2m2m',
  'h264_videotoolbox',
]
const presets: readonly HksvVideoPreset[] = [
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow',
  'slower', 'veryslow',
]
const mediaKeys = new Set(['profile', 'recording'])
const recordingKeys = new Set<keyof MediaRecordingConfigInput>([
  'codec',
  'bitrateKbps',
  'maxBitrateKbps',
  'bufferSizeKbps',
  'rateControl',
  'crf',
  'preset',
  'keyframeInterval',
  'prebufferLengthMs',
  'fragmentLengthMs',
  'maxDurationSeconds',
  'maxQueuedBytes',
  'maxConcurrentRecordings',
])

/** A media setting that can't be used; path is where it is, e.g. "media.recording.crf". */
export class MediaConfigError extends Error {
  readonly path: string
  readonly expectation: string

  constructor(path: string, expectation: string) {
    super(`Invalid media configuration at ${path}: expected ${expectation}`)
    this.path = path
    this.expectation = expectation
  }
}

function invalid(path: string, expectation: string): never {
  throw new MediaConfigError(path, expectation)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getMediaInput(config: RingPlatformConfig) {
  const media = config.media as unknown
  if (media === undefined) {
    return { profile: undefined, recording: {} as Record<string, unknown> }
  }

  if (!isRecord(media)) {
    return invalid('media', 'an object')
  }

  for (const key of Object.keys(media)) {
    if (!mediaKeys.has(key)) {
      return invalid(`media.${key}`, 'a supported media setting')
    }
  }

  if (media.recording === undefined) {
    return { profile: media.profile, recording: {} as Record<string, unknown> }
  }

  if (!isRecord(media.recording)) {
    return invalid('media.recording', 'an object')
  }

  for (const key of Object.keys(media.recording)) {
    if (!recordingKeys.has(key as keyof MediaRecordingConfigInput)) {
      return invalid(`media.recording.${key}`, 'a supported recording setting')
    }
  }

  return { profile: media.profile, recording: media.recording }
}

function enumValue<T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !values.includes(value as T)) {
    return invalid(path, values.join(', '))
  }
  return value as T
}

function integer(
  value: unknown,
  path: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    return invalid(path, `an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function optionalInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number | undefined {
  return value === undefined ? undefined : integer(value, path, minimum, minimum, maximum)
}

/** Converts the media options into one validated configuration, with each profile's defaults. */
export function normalizeMediaConfig(config: RingPlatformConfig): NormalizedMediaConfig {
  const media = getMediaInput(config)
  const profile = enumValue(media.profile, 'media.profile', ['adaptive', 'lowPower', 'quality'], 'adaptive')
  const input = media.recording
  const lowPower = profile === 'lowPower'
  const bitrateKbps = integer(input.bitrateKbps, 'media.recording.bitrateKbps', lowPower ? 1000 : profile === 'quality' ? 5000 : 3000, 256, 12000)
  const maxBitrateKbps = integer(input.maxBitrateKbps, 'media.recording.maxBitrateKbps', Math.min(bitrateKbps * 2, 20000), bitrateKbps, 20000)
  const bufferSizeKbps = integer(input.bufferSizeKbps, 'media.recording.bufferSizeKbps', Math.min(maxBitrateKbps * 2, 40000), maxBitrateKbps, 40000)

  return {
    profile,
    recording: {
      codec: enumValue(input.codec, 'media.recording.codec', codecs, lowPower ? 'copy' : 'auto'),
      bitrateKbps,
      maxBitrateKbps,
      bufferSizeKbps,
      rateControl: enumValue(input.rateControl, 'media.recording.rateControl', ['cbr', 'vbr'], 'vbr'),
      crf: optionalInteger(input.crf, 'media.recording.crf', 18, 35),
      preset: enumValue(input.preset, 'media.recording.preset', presets, lowPower ? 'ultrafast' : 'veryfast'),
      keyframeInterval: integer(input.keyframeInterval, 'media.recording.keyframeInterval', 30, 5, 240),
      prebufferLengthMs: integer(input.prebufferLengthMs, 'media.recording.prebufferLengthMs', 4000, 4000, 16000),
      fragmentLengthMs: integer(input.fragmentLengthMs, 'media.recording.fragmentLengthMs', 4000, 1000, 8000),
      maxDurationSeconds: optionalInteger(input.maxDurationSeconds, 'media.recording.maxDurationSeconds', 0, 300),
      maxQueuedBytes: integer(input.maxQueuedBytes, 'media.recording.maxQueuedBytes', lowPower ? 6 * 1024 * 1024 : 16 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024),
      maxConcurrentRecordings: integer(input.maxConcurrentRecordings, 'media.recording.maxConcurrentRecordings', lowPower ? 1 : 2, 1, 4),
    },
  }
}

// Error paths are "media", "media.<key>", "media.recording" or "media.recording.<key>", where
// <key> is the user's own key and may itself contain dots.
function removeSetting(config: Record<string, unknown>, path: string) {
  const media = config.media
  const recordingKey = path.slice('media.recording.'.length)
  if (
    path.startsWith('media.recording.') &&
    isRecord(media) &&
    isRecord(media.recording) &&
    Object.hasOwn(media.recording, recordingKey)
  ) {
    delete media.recording[recordingKey]
  } else if (path.startsWith('media.') && isRecord(media)) {
    delete media[path.slice('media.'.length)]
  } else {
    delete config.media
  }
}

/**
 * Like normalizeMediaConfig, but never throws: each media setting that can't be used is taken out
 * of config (in memory only, so every later normalizeMediaConfig call agrees) and reported, and the
 * default is used instead. A bad value, for example a maximum bitrate below the bitrate, would
 * otherwise stop the plugin from starting and take everything on its bridge down with it.
 */
export function sanitizeMediaConfig(config: RingPlatformConfig): {
  media: NormalizedMediaConfig
  ignored: MediaConfigError[]
} {
  const ignored: MediaConfigError[] = []
  // Each round removes one setting. After 64 (only possible with many unknown keys), all media
  // settings are dropped below.
  for (let round = 0; round < 64; round++) {
    try {
      return { media: normalizeMediaConfig(config), ignored }
    } catch (e) {
      if (!(e instanceof MediaConfigError)) throw e
      ignored.push(e)
      removeSetting(config as unknown as Record<string, unknown>, e.path)
    }
  }
  delete (config as { media?: unknown }).media
  ignored.push(new MediaConfigError('media', 'fewer than 64 unusable settings, so all of them are ignored'))
  return { media: normalizeMediaConfig(config), ignored }
}

/** Each flat recording setting removed in 1.0.0 and the media setting that replaced it. */
export const removedMediaSettings = {
  hksvPerformanceMode: 'media.profile',
  cameraVideoCodec: 'media.recording.codec',
  hksvVideoBitrateKbps: 'media.recording.bitrateKbps',
  hksvVideoMaxBitrateKbps: 'media.recording.maxBitrateKbps',
  hksvVideoBufferSizeKbps: 'media.recording.bufferSizeKbps',
  hksvVideoCrf: 'media.recording.crf',
  hksvVideoPreset: 'media.recording.preset',
  hksvVideoKeyframeInterval: 'media.recording.keyframeInterval',
  hksvPrebufferLengthMs: 'media.recording.prebufferLengthMs',
  hksvFragmentLengthMs: 'media.recording.fragmentLengthMs',
  hksvMaxRecordingSeconds: 'media.recording.maxDurationSeconds',
  hksvMaxQueuedBytes: 'media.recording.maxQueuedBytes',
  hksvMaxConcurrentRecordings: 'media.recording.maxConcurrentRecordings',
} as const

/** Removed settings still in a config (they are ignored), with what replaced each. */
export function getRemovedSettings(config: RingPlatformConfig) {
  return Object.entries(removedMediaSettings)
    .filter(([removed]) => (config as unknown as Record<string, unknown>)[removed] != null)
    .map(([removed, replacement]) => ({ removed, replacement }))
}
