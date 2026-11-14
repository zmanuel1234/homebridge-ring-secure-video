import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isHksvEnabled } from '../lib/camera-source.js'
import { normalizeMediaConfig } from '../lib/media-config.js'

const schema = JSON.parse(await readFile(new URL('../config.schema.json', import.meta.url), 'utf8'))

// What the settings form fills in when a config is saved: every default for a missing setting.
function withFormDefaults(config, properties = schema.schema.properties) {
  const result = structuredClone(config)
  for (const [key, spec] of Object.entries(properties)) {
    if (spec.type === 'object' && spec.properties) {
      const nested = withFormDefaults(result[key] ?? {}, spec.properties)
      if (Object.keys(nested).length) result[key] = nested
    } else if (spec.default !== undefined && result[key] === undefined) {
      result[key] = spec.default
    }
  }
  return result
}

const configs = [
  {},
  { media: { profile: 'lowPower' } },
  { media: { profile: 'quality' } },
  { media: { profile: 'lowPower', recording: { bitrateKbps: 800 } } },
  { media: { profile: 'lowPower', recording: { rateControl: 'cbr' } } },
]

test('saving the settings form does not change the media settings in effect', () => {
  for (const config of configs) {
    assert.deepEqual(
      normalizeMediaConfig(withFormDefaults(config)),
      normalizeMediaConfig(config),
      JSON.stringify(config),
    )
  }
})

test('saving the settings form does not change whether a camera gets HKSV', () => {
  for (const config of [{}, { enableHksv: false }, { disableHksvOnBattery: false }]) {
    for (const onBattery of [false, true]) {
      assert.equal(
        isHksvEnabled(withFormDefaults(config), onBattery),
        isHksvEnabled(config, onBattery),
        `${JSON.stringify(config)} onBattery=${onBattery}`,
      )
    }
  }
})

test('HKSV is on unless turned off, except for cameras running on battery', () => {
  assert.equal(isHksvEnabled({}, false), true)
  assert.equal(isHksvEnabled({}, true), false)
  assert.equal(isHksvEnabled({ disableHksvOnBattery: false }, true), true)
  assert.equal(isHksvEnabled({ enableHksv: false }, false), false)
})

// Every setting with a form default must be covered above or listed here with where the code
// treats it the same when unset; a new default fails until it is checked.
const checkedElsewhere = {
  enableCameraMotionHistory: 'camera.ts: unset counts as on (!== false), like the default true',
  automaticSessionRefresh: 'ring-platform.ts: unset counts as on (!== false), like the default true',
  sessionRefreshSensor: 'ring-platform.ts: unset counts as off (truthy check), like the default false',
  doorbellPressMotion: 'camera.ts: unset counts as off (truthy check), like the default false',
}
test('every form default is checked', () => {
  const covered = new Set(['enableHksv', 'disableHksvOnBattery', 'media'])
  const withDefaults = Object.entries(schema.schema.properties)
    .filter(([, spec]) => spec.default !== undefined || (spec.type === 'object' && JSON.stringify(spec).includes('"default"')))
    .map(([key]) => key)
  for (const key of withDefaults) {
    assert.ok(covered.has(key) || checkedElsewhere[key], `form default for ${key} is not checked`)
  }
})
