import assert from 'node:assert/strict'
import test from 'node:test'
import { setFfmpegPath } from 'ring-client-api/ffmpeg'
import { useLogger } from 'ring-client-api/util'
import { FFMPEG_PROBE_RETRY_MS, getFfmpegCapabilities } from '../lib/ffmpeg-capabilities.js'

// Its own file: the check is cached per process, so this needs to be its first caller.
test('a check that fails is logged once and tried again a few minutes later', async (t) => {
  const errors = []
  useLogger({ logInfo() {}, logError: (message) => errors.push(message) })
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  t.after(() => setFfmpegPath(undefined))

  setFfmpegPath('/nonexistent/ffmpeg')
  const failed = await getFfmpegCapabilities()
  assert.equal(failed.encoders.size, 0)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /Could not list the encoders/)

  setFfmpegPath(undefined)
  assert.equal(await getFfmpegCapabilities(), failed, 'the failed check is kept for a while')

  t.mock.timers.tick(FFMPEG_PROBE_RETRY_MS)
  const retried = await getFfmpegCapabilities()
  assert.equal(retried.encoders.has('libx264'), true, 'asked the bundled FFmpeg again')
  assert.equal(await getFfmpegCapabilities(), retried, 'a check that worked is kept')

  setFfmpegPath('/nonexistent/ffmpeg')
  t.mock.timers.tick(FFMPEG_PROBE_RETRY_MS * 10)
  assert.equal(await getFfmpegCapabilities(), retried, 'and is not asked again')
  assert.equal(errors.length, 1)
})
