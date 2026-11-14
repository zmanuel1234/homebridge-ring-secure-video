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

function legacyInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  // Keep the flat v14 options compatible: they were rounded and clamped at
  // consumption time. Nested media values use integer() and fail fast instead.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }

  return Math.min(Math.max(Math.round(value), minimum), maximum)
}

function preferInteger(
  modern: unknown,
  legacy: unknown,
  path: string,
  fallback: number,
  minimum: number,
  maximum: number,
  legacyMinimum = minimum,
) {
  return modern === undefined
    ? legacyInteger(legacy, fallback, legacyMinimum, maximum)
    : integer(modern, path, fallback, minimum, maximum)
}

function preferOptionalInteger(
  modern: unknown,
  legacy: unknown,
  path: string,
  minimum: number,
  maximum: number,
  legacyMinimum = minimum,
): number | undefined {
  if (modern !== undefined) {
    return integer(modern, path, minimum, minimum, maximum)
  }

  if (typeof legacy !== 'number' || !Number.isFinite(legacy)) {
    return undefined
  }

  return Math.min(Math.max(Math.round(legacy), legacyMinimum), maximum)
}

function legacyEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
) {
  return typeof value === 'string' && values.includes(value as T)
    ? value as T
    : fallback
}

function preferEnum<T extends string>(
  modern: unknown,
  legacy: unknown,
  path: string,
  values: readonly T[],
  fallback: T,
) {
  return modern === undefined
    ? legacyEnum(legacy, values, fallback)
    : enumValue(modern, path, values, fallback)
}

function getProfile(
  config: RingPlatformConfig,
  modernProfile: unknown,
): MediaProfile {
  // The nested media setting is authoritative when both forms are present.
  // This makes it safe for config UIs to retain legacy fields during upgrade.
  if (modernProfile !== undefined) {
    return enumValue(modernProfile, 'media.profile', ['adaptive', 'lowPower', 'quality'], 'adaptive')
  }
  return config.hksvPerformanceMode === 'rpi'
    ? 'lowPower'
    : config.hksvPerformanceMode === 'quality' ? 'quality' : 'adaptive'
}

/**
 * Converts legacy flat HKSV options and media options into one validated
 * configuration. New nested recording values intentionally win over legacy
 * values; legacy fields remain supported while users migrate.
 */
export function normalizeMediaConfig(config: RingPlatformConfig): NormalizedMediaConfig {
  const media = getMediaInput(config)
  const profile = getProfile(config, media.profile)
  const input = media.recording
  const lowPower = profile === 'lowPower'
  const bitrateKbps = preferInteger(input.bitrateKbps, config.hksvVideoBitrateKbps, 'media.recording.bitrateKbps', lowPower ? 1000 : profile === 'quality' ? 5000 : 3000, 256, 12000)
  const maxBitrateKbps = preferInteger(input.maxBitrateKbps, config.hksvVideoMaxBitrateKbps, 'media.recording.maxBitrateKbps', Math.min(bitrateKbps * 2, 20000), bitrateKbps, 20000)
  const bufferSizeKbps = preferInteger(input.bufferSizeKbps, config.hksvVideoBufferSizeKbps, 'media.recording.bufferSizeKbps', Math.min(maxBitrateKbps * 2, 40000), maxBitrateKbps, 40000)

  return {
    profile,
    recording: {
      codec: preferEnum(input.codec, config.cameraVideoCodec, 'media.recording.codec', codecs, lowPower ? 'copy' : 'auto'),
      bitrateKbps,
      maxBitrateKbps,
      bufferSizeKbps,
      rateControl: enumValue(input.rateControl, 'media.recording.rateControl', ['cbr', 'vbr'], 'vbr'),
      crf: preferOptionalInteger(input.crf, config.hksvVideoCrf, 'media.recording.crf', 18, 35),
      preset: preferEnum(input.preset, config.hksvVideoPreset, 'media.recording.preset', presets, lowPower ? 'ultrafast' : 'veryfast'),
      keyframeInterval: preferInteger(input.keyframeInterval, config.hksvVideoKeyframeInterval, 'media.recording.keyframeInterval', 30, 5, 240),
      prebufferLengthMs: preferInteger(input.prebufferLengthMs, config.hksvPrebufferLengthMs, 'media.recording.prebufferLengthMs', 4000, 4000, 16000),
      fragmentLengthMs: preferInteger(input.fragmentLengthMs, config.hksvFragmentLengthMs, 'media.recording.fragmentLengthMs', 4000, 1000, 8000),
      maxDurationSeconds: preferOptionalInteger(input.maxDurationSeconds, config.hksvMaxRecordingSeconds, 'media.recording.maxDurationSeconds', 0, 300, 0),
      maxQueuedBytes: preferInteger(input.maxQueuedBytes, config.hksvMaxQueuedBytes, 'media.recording.maxQueuedBytes', lowPower ? 6 * 1024 * 1024 : 16 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024),
      maxConcurrentRecordings: preferInteger(input.maxConcurrentRecordings, config.hksvMaxConcurrentRecordings, 'media.recording.maxConcurrentRecordings', lowPower ? 1 : 2, 1, 4),
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
 * older flat setting or the default is used instead. A bad value, for example a maximum bitrate below the bitrate, would
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

/** Each deprecated flat setting and the media setting that replaces it. */
export const legacyMediaSettings = {
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

/**
 * Deprecated flat settings that have no effect because their media setting is also set. Meant
 * for after sanitizeMediaConfig(config), which removes unusable media values; null counts as
 * unset either way.
 */
export function getOverriddenLegacySettings(config: RingPlatformConfig) {
  const media = config.media as Record<string, unknown> | undefined,
    recording = media?.recording as Record<string, unknown> | undefined
  return Object.entries(legacyMediaSettings)
    .filter(([legacy, modern]) => {
      if ((config as unknown as Record<string, unknown>)[legacy] == null) return false
      const [, group, key] = modern.split('.')
      return key === undefined ? media?.[group] != null : recording?.[key] != null
    })
    .map(([legacy, modern]) => ({ legacy, modern }))
}
