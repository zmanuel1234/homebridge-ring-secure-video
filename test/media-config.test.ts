import assert from 'node:assert/strict'
import test from 'node:test'
import type { API, Logging } from 'homebridge'
import { normalizeMediaConfig, sanitizeMediaConfig, type NormalizedMediaRecordingConfig } from '../src/media-config.js'
import { fake, rawConfig, schema, type SchemaField } from './helpers.js'

type Choices = { enum?: unknown[]; oneOf?: { enum: unknown[] }[]; minimum?: number; maximum?: number }
const mediaSchema = schema.schema.properties.media?.properties ?? {}
const recordingSchema = mediaSchema.recording?.properties ?? {}
const profileSchema = (mediaSchema.profile ?? {}) as SchemaField & Choices
const profiles = profileSchema.oneOf ? profileSchema.oneOf.flatMap((option) => option.enum) : (profileSchema.enum ?? [])
// These two must be at least the bitrate and the maximum bitrate, which the settings form can't
// express; a lower value is ignored (not fatal), a value at or above that bound is used.
const relativeLowerBound: Record<string, (media: { recording: NormalizedMediaRecordingConfig }) => number | undefined> = {
  maxBitrateKbps: (media) => media.recording.bitrateKbps,
  bufferSizeKbps: (media) => media.recording.maxBitrateKbps,
}

test('every value the settings form allows is accepted (or, for relative limits, ignored) without failing', () => {
  assert.ok(profiles.length >= 3, 'profiles are read from the schema')
  for (const profile of [undefined, ...profiles]) {
    const defaults = normalizeMediaConfig(rawConfig({ media: { profile } }))
    for (const [key, spec] of Object.entries(recordingSchema)) {
      const choices = spec as SchemaField & Choices
      const values = choices.enum ?? [choices.minimum, choices.maximum]
      for (const value of values) {
        const config = rawConfig({ media: { profile, recording: { [key]: value } } })
        const { media, ignored } = sanitizeMediaConfig(config)
        const bound = relativeLowerBound[key]?.(defaults)
        if (bound !== undefined && typeof value === 'number' && value < bound) {
          assert.deepEqual(ignored.map((s) => s.path), [`media.recording.${key}`], `${key}=${value} (${profile})`)
        } else {
          assert.deepEqual(ignored, [], `${key}=${value} (${profile}): ${ignored.map((s) => s.message)}`)
          assert.equal(media.recording[key as keyof NormalizedMediaRecordingConfig], value, `${key}=${String(value)} (${String(profile)}) is used`)
        }
        assert.doesNotThrow(() => normalizeMediaConfig(config))
      }
    }
  }
})

test('settings that cannot be used are ignored one by one, keeping the rest', () => {
  const config = rawConfig({
    media: {
      profile: 'lowPower',
      unknownSetting: true,
      recording: { codec: 'libx264', bitrateKbps: 800, maxBitrateKbps: 500, crf: 99, extra: 1 },
    },
  })
  assert.throws(() => normalizeMediaConfig(structuredClone(config)), /Invalid media configuration/)

  const { media, ignored } = sanitizeMediaConfig(config)
  assert.deepEqual(ignored.map((s) => s.path).sort(), [
    'media.recording.crf',
    'media.recording.extra',
    'media.recording.maxBitrateKbps',
    'media.unknownSetting',
  ])
  assert.equal(media.profile, 'lowPower')
  assert.equal(media.recording.codec, 'libx264')
  assert.equal(media.recording.bitrateKbps, 800)
  assert.equal(media.recording.maxBitrateKbps, 1600, 'default: twice the bitrate')
  assert.equal(media.recording.crf, undefined)
  // Later lookups (cameras) see the same, now valid, settings.
  assert.deepEqual(normalizeMediaConfig(config), media)
})

test('a setting name with a dot in it is ignored on its own', () => {
  const config = rawConfig({
    media: { profile: 'quality', 'x.y': 1, 'recording.crf': 20, recording: { 'a.b': 1, bitrateKbps: 4000 } },
  })
  const { media, ignored } = sanitizeMediaConfig(config)
  assert.deepEqual(ignored.map((s) => s.path).sort(), [
    'media.recording.a.b',
    'media.recording.crf', // the top-level key "recording.crf"
    'media.x.y',
  ])
  assert.equal(media.profile, 'quality')
  assert.equal(media.recording.bitrateKbps, 4000)
})

test('with very many unusable settings, all media settings are ignored with one last warning', () => {
  const media: Record<string, unknown> = { profile: 'quality' }
  for (let i = 0; i < 70; i++) media[`bad${i}`] = i
  const config = rawConfig({ media })
  const { media: normalized, ignored } = sanitizeMediaConfig(config)
  assert.equal(ignored.length, 65)
  assert.equal(ignored.at(-1)?.path, 'media')
  assert.equal(config.media, undefined)
  assert.equal(normalized.profile, 'adaptive')
})

test('defaults derived from a high bitrate stay within their limits', () => {
  const { media, ignored } = sanitizeMediaConfig(rawConfig({ media: { recording: { bitrateKbps: 12000 } } }))
  assert.deepEqual(ignored, [])
  assert.equal(media.recording.maxBitrateKbps, 20000)
  assert.equal(media.recording.bufferSizeKbps, 40000)
})

test('a media block that is not an object is ignored as a whole', () => {
  for (const media of ['fast', [], 3, { recording: 'x' }, { profile: 'turbo' }]) {
    const config = rawConfig({ media })
    const { media: normalized, ignored } = sanitizeMediaConfig(config)
    assert.equal(ignored.length, 1, JSON.stringify(media))
    assert.equal(normalized.profile, 'adaptive', 'falls back to the default')
  }
})

test('the plugin starts, with a warning, when a media setting cannot be used', async () => {
  const { RingPlatform } = await import('../src/ring-platform.js')
  const warnings: string[] = []
  const log = fake<Logging>({ info() {}, error() {}, warn: (m: string) => warnings.push(m), debug() {} })
  const api = fake<API>({ on() {}, user: { configPath: () => '/nonexistent/config.json', storagePath: () => '/nonexistent' } })
  const config = rawConfig({
    platform: 'Ring Secure Video',
    disableLogs: true,
    media: { recording: { maxBitrateKbps: 256 } },
  })

  assert.doesNotThrow(() => new RingPlatform(log, fake<ConstructorParameters<typeof RingPlatform>[1]>(config), api))
  assert.ok(
    warnings.some((w) => w.startsWith('Ignoring the media setting media.recording.maxBitrateKbps (expected an integer from 3000 to 20000)')),
    warnings.join('\n'),
  )
})
