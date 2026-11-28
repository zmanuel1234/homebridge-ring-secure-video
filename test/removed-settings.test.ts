import assert from 'node:assert/strict'
import test from 'node:test'
import type { RingPlatformConfig } from '../src/config.js'
import { getRemovedSettings, removedMediaSettings } from '../src/media-config.js'
import { schema } from './helpers.js'

const media = schema.schema.properties.media

// Configs as users have them: with settings this version no longer has.
const removedSettings = (config: object) => getRemovedSettings(config as RingPlatformConfig)

test('each removed setting is gone from the settings form and has its media setting', () => {
  const text = JSON.stringify(schema)
  for (const [removed, replacement] of Object.entries(removedMediaSettings)) {
    assert.equal(text.includes(`"${removed}"`), false, `${removed} is still in the schema`)
    const [, group, key] = replacement.split('.')
    assert.ok(key === undefined ? media.properties?.[group] : media.properties?.recording?.properties?.[key], replacement)
  }
})

test('removed settings left in a config are reported with their replacement', () => {
  assert.deepEqual(removedSettings({}), [])
  assert.deepEqual(removedSettings({ media: { profile: 'lowPower' }, hksvVideoCrf: null }), [])
  assert.deepEqual(
    removedSettings({
      hksvPerformanceMode: 'balanced',
      cameraVideoCodec: 'auto',
      hksvVideoBitrateKbps: 3000,
      hksvVideoKeyframeInterval: 30,
      media: { profile: 'lowPower', recording: { codec: 'copy' } },
    }),
    [
      { removed: 'hksvPerformanceMode', replacement: 'media.profile' },
      { removed: 'cameraVideoCodec', replacement: 'media.recording.codec' },
      { removed: 'hksvVideoBitrateKbps', replacement: 'media.recording.bitrateKbps' },
      { removed: 'hksvVideoKeyframeInterval', replacement: 'media.recording.keyframeInterval' },
    ],
  )
})
