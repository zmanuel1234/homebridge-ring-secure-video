import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  getOverriddenLegacySettings,
  legacyMediaSettings,
  normalizeMediaConfig,
} from '../lib/media-config.js'

const schema = JSON.parse(await readFile(new URL('../config.schema.json', import.meta.url), 'utf8'))
const properties = schema.schema.properties,
  recording = properties.media.properties.recording.properties

function layoutKeys(items, path = []) {
  const found = []
  for (const item of items ?? []) {
    if (typeof item === 'string') found.push({ key: item, path })
    else if (item?.key) found.push({ key: item.key, path })
    if (item?.items) found.push(...layoutKeys(item.items, [...path, item.title]))
  }
  return found
}

test('every deprecated setting has its media setting, with the same allowed values', () => {
  for (const [legacy, modern] of Object.entries(legacyMediaSettings)) {
    assert.ok(properties[legacy], legacy)
    const [, group, key] = modern.split('.'),
      target = key === undefined ? properties.media.properties[group] : recording[key]
    assert.ok(target, modern)
    if (legacy === 'hksvPerformanceMode') continue // renamed values, mapped in getProfile
    const values = (spec) =>
      JSON.stringify({
        minimum: spec.minimum,
        maximum: spec.maximum,
        values: (spec.enum ?? spec.oneOf?.map((o) => o.enum[0]))?.toSorted(),
      })
    assert.equal(values(properties[legacy]), values(target), legacy)
  }
})

test('the settings form only shows deprecated settings in their own section, and fills none in', () => {
  const keys = layoutKeys(schema.layout)
  for (const legacy of Object.keys(legacyMediaSettings)) {
    const places = keys.filter((k) => k.key === legacy)
    assert.equal(places.length, 1, legacy)
    assert.equal(places[0].path.at(-1), 'Legacy Recording Settings (deprecated)', legacy)
    assert.equal(properties[legacy].default, undefined, `${legacy} has a form default`)
    assert.match(properties[legacy].description, /^Deprecated: use /, legacy)
  }
})

test('a deprecated setting is reported only when its media setting is also set', () => {
  assert.deepEqual(getOverriddenLegacySettings({}), [])
  assert.deepEqual(
    getOverriddenLegacySettings({ hksvPerformanceMode: 'balanced', hksvVideoKeyframeInterval: 30 }),
    [],
    'used on their own, they still apply',
  )
  assert.deepEqual(
    getOverriddenLegacySettings({
      hksvPerformanceMode: 'balanced',
      cameraVideoCodec: 'auto',
      hksvVideoBitrateKbps: 3000,
      hksvVideoKeyframeInterval: 30,
      hksvVideoCrf: 20,
      media: { profile: 'lowPower', recording: { codec: 'copy', bitrateKbps: 1500, keyframeInterval: 30 } },
    }),
    [
      { legacy: 'hksvPerformanceMode', modern: 'media.profile' },
      { legacy: 'cameraVideoCodec', modern: 'media.recording.codec' },
      { legacy: 'hksvVideoBitrateKbps', modern: 'media.recording.bitrateKbps' },
      { legacy: 'hksvVideoKeyframeInterval', modern: 'media.recording.keyframeInterval' },
    ],
  )
})

test('null counts as unset on either side', () => {
  assert.deepEqual(
    getOverriddenLegacySettings({
      hksvVideoCrf: 20,
      hksvVideoPreset: null,
      media: { profile: null, recording: { crf: null, preset: 'veryfast' } },
    }),
    [],
  )
})

test('deprecated settings still apply when their media setting is not set', () => {
  const media = normalizeMediaConfig({
    hksvPerformanceMode: 'rpi',
    cameraVideoCodec: 'libx264',
    hksvVideoBitrateKbps: 800,
    hksvVideoKeyframeInterval: 112,
  })
  assert.equal(media.profile, 'lowPower')
  assert.equal(media.recording.codec, 'libx264')
  assert.equal(media.recording.bitrateKbps, 800)
  assert.equal(media.recording.keyframeInterval, 112)
})
