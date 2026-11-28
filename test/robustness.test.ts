import assert from 'node:assert/strict'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import test from 'node:test'
import { ManagedFfmpegProcess } from '../src/managed-ffmpeg-process.js'
import { CameraSource } from '../src/camera-source.js'
import { internals } from './helpers.js'

/** ManagedFfmpegProcess's private parts these tests reach into. */
interface FfmpegInternals {
  child: ChildProcessWithoutNullStreams
  isRunning(): boolean
}
const reach = (ffmpeg: ManagedFfmpegProcess) => internals<FfmpegInternals>(ffmpeg)

/** CameraSource's private snapshot methods, called on a stand-in. */
const snapshots = internals<{
  loadAndCacheSnapshot(this: object): Promise<void>
  getCurrentSnapshot(this: object): Promise<Buffer>
}>(CameraSource.prototype)

test('more ffmpeg errors after the first, or errors on its output, do not crash the bridge', async () => {
  const errors: unknown[] = []
  const ffmpeg = new ManagedFfmpegProcess({
    ffmpegPath: '/nonexistent/ffmpeg',
    ffmpegArgs: [],
    logLabel: 'test',
    logger: { error: (m) => errors.push(m), info() {} },
  })
  await ffmpeg.exited
  assert.match(String(errors[0]), /ENOENT/)

  // Without a listener each of these would throw, ending the Homebridge process.
  reach(ffmpeg).child.emit('error', new Error('second error'))
  reach(ffmpeg).child.stdout.emit('error', new Error('stdout error'))
  reach(ffmpeg).child.stderr.emit('error', new Error('stderr error'))
  assert.deepEqual(errors.slice(1), [
    'test: second error',
    'test: stdout error',
    'test: stderr error',
  ])
})

test('an error while ffmpeg runs keeps it tracked until it really exits', async () => {
  const errors: unknown[] = []
  let exitedAt: number | undefined
  const ffmpeg = new ManagedFfmpegProcess({
    ffmpegPath: process.execPath,
    ffmpegArgs: ['-e', 'setInterval(() => {}, 1000)'],
    logLabel: 'test',
    logger: { error: (m) => errors.push(m), info() {} },
    exitCallback: () => (exitedAt = Date.now()),
  })
  reach(ffmpeg).child.emit('error', new Error('kill failed'))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(exitedAt, undefined, 'still running, so not finished')
  assert.equal(reach(ffmpeg).isRunning(), true)
  ffmpeg.stop()
  await ffmpeg.exited
  assert.ok(exitedAt)
  assert.deepEqual(errors, ['test: kill failed'])
})

test('a snapshot that loads is timed from when it loaded', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 5_000_000 })
  const source = {
    ringCamera: { name: 'Front Door', getSnapshot: async () => Buffer.from('new') },
    cachedSnapshot: Buffer.from('old'),
    cachedSnapshotAt: 0,
  }
  await snapshots.loadAndCacheSnapshot.call(source)
  assert.equal(String(source.cachedSnapshot), 'new')
  assert.equal(source.cachedSnapshotAt, 5_000_000)
})

test('a cached snapshot is not shown once it is well past its lifetime', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const reloads = []
  const source = {
    ringCamera: {
      name: 'Front Door',
      isOffline: false,
      snapshotsAreBlocked: false,
      hasSnapshotWithinLifetime: false,
      snapshotLifeTime: 10_000,
    },
    cachedSnapshot: Buffer.from('jpeg'),
    cachedSnapshotAt: Date.now(),
    loadSnapshot: () => {
      reloads.push(Date.now())
      return Promise.reject(new Error('Ring returned 500'))
    },
  }
  const current = () => snapshots.getCurrentSnapshot.call(source)

  t.mock.timers.tick(60_000)
  assert.equal(String(await current()), 'jpeg', 'within the lifetime plus 2 minutes')
  t.mock.timers.tick(80_000)
  assert.equal(await current(), undefined, 'too old to show as current')
  assert.equal(reloads.length, 2, 'a new snapshot is requested each time')
})
