import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRefreshTokenSaver } from '../lib/ring-platform.js'

async function withConfig(platform, run) {
  const dir = await mkdtemp(join(tmpdir(), 'ring-token-'))
  const configPath = join(dir, 'config.json')
  try {
    await writeFile(
      configPath,
      JSON.stringify({ platforms: [{ platform: 'Other', refreshToken: 'other' }, platform] }, null, 4),
    )
    const api = { user: { configPath: () => configPath } }
    const read = async () => JSON.parse(await readFile(configPath, 'utf8')).platforms
    await run(api, read)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('after a forced push refresh, every new token is saved, not only the first', async () => {
  await withConfig(
    { platform: 'Ring Secure Video', refreshToken: 'T0', forceRefreshRingPushCredentials: true },
    async (api, read) => {
      const save = createRefreshTokenSaver(api, 'T0', true)
      // ring-client-api started from a modified token (S0) that was never in config.json.
      save({ oldRefreshToken: 'S0', newRefreshToken: 'T1' })
      let [other, ring] = await read()
      assert.equal(ring.refreshToken, 'T1')
      assert.equal(ring.forceRefreshRingPushCredentials, false)

      save({ oldRefreshToken: 'T1', newRefreshToken: 'T2' })
      save({ oldRefreshToken: 'T2', newRefreshToken: 'T3' })
      ;[other, ring] = await read()
      assert.equal(ring.refreshToken, 'T3')
      assert.equal(other.refreshToken, 'other', 'other plugins are left alone')
    },
  )
})

test('the force settings are cleared once, not again on later renewals', async () => {
  await withConfig(
    { platform: 'Ring Secure Video', refreshToken: 'T0', forceRefreshRingPushCredentials: true },
    async (api, read) => {
      const save = createRefreshTokenSaver(api, 'T0', true)
      save({ oldRefreshToken: 'S0', newRefreshToken: 'T1' })
      // The user turns the setting on again (without restarting yet).
      const platforms = await read()
      platforms[1].forceRefreshRingPushCredentials = true
      await writeFile(api.user.configPath(), JSON.stringify({ platforms }, null, 4))

      save({ oldRefreshToken: 'T1', newRefreshToken: 'T2' })
      const [, ring] = await read()
      assert.equal(ring.refreshToken, 'T2')
      assert.equal(ring.forceRefreshRingPushCredentials, true)
    },
  )
})

test('a token that could not be saved is retried against the token still in config.json', async () => {
  await withConfig({ platform: 'Ring Secure Video', refreshToken: 'T0' }, async (api, read) => {
    const configPath = api.user.configPath
    let failOnce = true
    const flaky = {
      user: {
        configPath: () => {
          if (failOnce) {
            failOnce = false
            throw new Error('disk busy')
          }
          return configPath()
        },
      },
    }
    const save = createRefreshTokenSaver(flaky, 'T0', false)
    save({ oldRefreshToken: 'T0', newRefreshToken: 'T1' }) // fails
    save({ oldRefreshToken: 'T1', newRefreshToken: 'T2' })
    const [, ring] = await read()
    assert.equal(ring.refreshToken, 'T2')
  })
})

test('without a forced refresh, each new token replaces the previous one', async () => {
  await withConfig({ platform: 'Ring Secure Video', refreshToken: 'T0' }, async (api, read) => {
    const save = createRefreshTokenSaver(api, 'T0', false)
    save({ oldRefreshToken: 'T0', newRefreshToken: 'T1' })
    save({ oldRefreshToken: 'T1', newRefreshToken: 'T2' })
    const [, ring] = await read()
    assert.equal(ring.refreshToken, 'T2')
    assert.equal(ring.forceRefreshRingPushCredentials, undefined, 'no flags are added')
  })
})
