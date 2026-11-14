import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { getRemovedSettings, removedMediaSettings } from '../lib/media-config.js'

const schema = JSON.parse(await readFile(new URL('../config.schema.json', import.meta.url), 'utf8'))
const media = schema.schema.properties.media

test('each removed setting is gone from the settings form and has its media setting', () => {
  const text = JSON.stringify(schema)
  for (const [removed, replacement] of Object.entries(removedMediaSettings)) {
    assert.equal(text.includes(`"${removed}"`), false, `${removed} is still in the schema`)
    const [, group, key] = replacement.split('.')
    assert.ok(key === undefined ? media.properties[group] : media.properties.recording.properties[key], replacement)
  }
})

test('removed settings left in a config are reported with their replacement', () => {
  assert.deepEqual(getRemovedSettings({}), [])
  assert.deepEqual(getRemovedSettings({ media: { profile: 'lowPower' }, hksvVideoCrf: null }), [])
  assert.deepEqual(
    getRemovedSettings({
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
