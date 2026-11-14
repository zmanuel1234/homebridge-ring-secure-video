import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRefreshTokenSaver, hasRingRefreshToken } from '../lib/ring-platform.js'

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

test("a new token is not written into another plugin's block that has the old one", async () => {
  // homebridge-ring set up with the same token, while this plugin's token was changed meanwhile
  await withConfig({ platform: 'Ring Secure Video', refreshToken: 'T9' }, async (api, read) => {
    const configPath = api.user.configPath()
    const platforms = await read()
    platforms.push({ platform: 'Ring', refreshToken: 'T0' })
    await writeFile(configPath, JSON.stringify({ platforms }, null, 4))
    const before = await readFile(configPath, 'utf8')

    createRefreshTokenSaver(api, 'T0', false)({ oldRefreshToken: 'T0', newRefreshToken: 'T1' })
    assert.equal(await readFile(configPath, 'utf8'), before, 'config.json is left as it is')
  })
})

test('a config.json that is not JSON still gets the new token', async () => {
  await withConfig({ platform: 'Ring Secure Video', refreshToken: 'T0' }, async (api) => {
    const configPath = api.user.configPath()
    await writeFile(configPath, `${await readFile(configPath, 'utf8')}\n// note`)
    createRefreshTokenSaver(api, 'T0', false)({ oldRefreshToken: 'T0', newRefreshToken: 'T1' })
    const saved = await readFile(configPath, 'utf8')
    assert.match(saved, /"T1"/)
    assert.doesNotMatch(saved, /"T0"/)
  })
})

// ring-client-api's token: base64 JSON with the Ring refresh token in `rt`.
const wrapped = (auth) => Buffer.from(JSON.stringify(auth)).toString('base64')

test('a token without a Ring refresh token is never saved over a working one', async () => {
  const good = wrapped({ rt: 'r0', hid: 'h' }),
    broken = wrapped({ hid: 'h' }), // what an undecodable sign-in response turns into
    renewed = wrapped({ rt: 'r1', hid: 'h' })
  await withConfig({ platform: 'Ring Secure Video', refreshToken: good }, async (api, read) => {
    const save = createRefreshTokenSaver(api, good, false)
    save({ oldRefreshToken: good, newRefreshToken: broken })
    assert.equal((await read())[1].refreshToken, good, 'the working token stays')

    save({ oldRefreshToken: good, newRefreshToken: renewed })
    assert.equal((await read())[1].refreshToken, renewed, 'a good token still replaces it')
  })
})

test('which tokens count as having a Ring refresh token', () => {
  assert.equal(hasRingRefreshToken(wrapped({ rt: 'r', hid: 'h', pnc: {} })), true)
  assert.equal(hasRingRefreshToken(wrapped({ hid: 'h' })), false)
  assert.equal(hasRingRefreshToken(wrapped({ hid: 'h', pnc: {} })), false, 'as the push credentials setter then sends')
  assert.equal(hasRingRefreshToken(wrapped({ rt: '', hid: 'h' })), false)
  assert.equal(hasRingRefreshToken(wrapped({ rt: 42 })), false)
  assert.equal(hasRingRefreshToken('eyJhbGciOiJIUzI1NiJ9.plain-ring-refresh-token'), true, 'an old plain token')
  assert.equal(hasRingRefreshToken(''), false)
})
