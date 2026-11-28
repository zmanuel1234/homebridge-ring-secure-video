import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type * as HapModule from '../src/hap.js'
import type * as CameraSourceModule from '../src/camera-source.js'
import { internals } from './helpers.js'

const root = fileURLToPath(new URL('..', import.meta.url))

test('the built-in camera images load from an install path with a space', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ring secure video '))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const entry of ['dist', 'media', 'package.json']) {
    await cp(join(root, entry), join(dir, entry), { recursive: true })
  }
  await symlink(join(root, 'node_modules'), join(dir, 'node_modules'))

  // the built copy, typed as its source
  const hap = (await import(pathToFileURL(join(dir, 'dist', 'hap.js')).href)) as typeof HapModule
  hap.setHap(await import('@homebridge/hap-nodejs'))
  const { CameraSource } = (await import(pathToFileURL(join(dir, 'dist', 'camera-source.js')).href)) as typeof CameraSourceModule
  const source = internals<{ ringCamera: unknown; getCurrentSnapshot(): Promise<Buffer> }>(Object.create(CameraSource.prototype))

  source.ringCamera = { name: 'Front Door', isOffline: true }
  const offline = await source.getCurrentSnapshot()
  assert.deepEqual(offline, await readFile(join(root, 'media', 'camera-offline.jpg')))

  source.ringCamera = { name: 'Front Door', isOffline: false, snapshotsAreBlocked: true }
  const blocked = await source.getCurrentSnapshot()
  assert.deepEqual(blocked, await readFile(join(root, 'media', 'snapshots-blocked.jpg')))
})
