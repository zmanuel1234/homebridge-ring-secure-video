import type { RingPlatformConfig } from './config.ts'
import type { FfmpegCapabilities } from './ffmpeg-capabilities.ts'
import { normalizeMediaConfig, type HksvVideoCodec } from './media-config.ts'

export type { HksvVideoCodec } from './media-config.ts'

export function getHksvRecordingResolutions(config: RingPlatformConfig) {
  if (normalizeMediaConfig(config).profile === 'lowPower') {
    return [
      [1280, 720, 30],
      [640, 480, 30],
      [640, 360, 30],
      [320, 240, 15],
    ]
  }

  return [
    [1920, 1080, 30],
    [1280, 720, 30],
    [640, 480, 30],
    [320, 240, 15],
  ]
}

/** Only auto outside lowPower asks FFmpeg which encoders it has. */
export function hksvCodecNeedsCapabilities(config: RingPlatformConfig) {
  const media = normalizeMediaConfig(config)
  return media.recording.codec === 'auto' && media.profile !== 'lowPower'
}

export function selectHksvVideoCodec(
  configuredCodec: HksvVideoCodec | undefined,
  capabilities: FfmpegCapabilities | undefined,
  config: RingPlatformConfig,
): HksvVideoCodec {
  const media = normalizeMediaConfig(config)
  const codec = configuredCodec ?? media.recording.codec

  if (codec !== 'auto') {
    return codec
  }

  if (media.profile === 'lowPower') {
    return 'copy'
  }

  if (capabilities?.encoders.has('h264_v4l2m2m')) {
    return 'h264_v4l2m2m'
  }

  if (capabilities?.encoders.has('h264_videotoolbox')) {
    return 'h264_videotoolbox'
  }

  return 'libx264'
}
