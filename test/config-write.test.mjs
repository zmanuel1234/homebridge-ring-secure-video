import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { getSystemId, updateHomebridgeConfig, writeFileAtomic } from '../lib/config.js'

async function inTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ring-write-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Replaces an fs function for the plugin's own named imports too, until the test ends.
function mockFs(t, name, implementation) {
  const original = fs[name]
  fs[name] = (...args) => implementation(original, ...args)
  syncBuiltinESMExports()
  t.after(() => {
    fs[name] = original
    syncBuiltinESMExports()
  })
}

const errno = (code) => Object.assign(new Error(code), { code })

test('replaces the file and leaves no temporary file behind', async () => {
  await inTempDir(async (dir) => {
    const file = join(dir, 'config.json')
    await writeFile(file, 'old')
    await chmod(file, 0o600)
    writeFileAtomic(file, 'new')
    assert.equal(await readFile(file, 'utf8'), 'new')
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.deepEqual(await readdir(dir), ['config.json'])
  })
})

test('keeps permissions the umask would otherwise change', async () => {
  await inTempDir(async (dir) => {
    const file = join(dir, 'config.json')
    await writeFile(file, 'old')
    await chmod(file, 0o664)
    const umask = process.umask(0o022)
    try {
      writeFileAtomic(file, 'new')
    } finally {
      process.umask(umask)
    }
    assert.equal((await stat(file)).mode & 0o777, 0o664)
  })
})

test('a symlinked config.json stays a symlink; its target gets the new contents', async () => {
  await inTempDir(async (dir) => {
    await mkdir(join(dir, 'real'))
    const real = join(dir, 'real', 'config.json'),
      link = join(dir, 'config.json')
    await writeFile(real, 'old')
    await symlink(real, link)
    writeFileAtomic(link, 'new')
    assert.equal(await readFile(real, 'utf8'), 'new')
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    assert.deepEqual(await readdir(join(dir, 'real')), ['config.json'])
  })
})

test('a link that points nowhere yet is written through, as before', async () => {
  await inTempDir(async (dir) => {
    const real = join(dir, 'real.json'),
      link = join(dir, '.ring.json')
    await symlink(real, link)
    writeFileAtomic(link, 'new')
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    assert.equal(await readFile(real, 'utf8'), 'new')
  })
})

test('a full disk leaves the old file untouched (no cut-short file is put in place)', async (t) => {
  await inTempDir(async (dir) => {
    const file = join(dir, 'config.json')
    await writeFile(file, 'old')
    mockFs(t, 'writeFileSync', (original, target, ...rest) => {
      if (typeof target === 'number') {
        original(target, 'cut sh')
        throw errno('ENOSPC')
      }
      return original(target, ...rest)
    })
    assert.throws(() => writeFileAtomic(file, 'new contents'), { code: 'ENOSPC' })
    assert.equal(await readFile(file, 'utf8'), 'old')
    assert.deepEqual(await readdir(dir), ['config.json'])
  })
})

test('when the file cannot be replaced (bind mount, open on Windows), it is written in place', async (t) => {
  await inTempDir(async (dir) => {
    const file = join(dir, 'config.json')
    await writeFile(file, 'old')
    mockFs(t, 'renameSync', () => {
      throw errno('EBUSY')
    })
    writeFileAtomic(file, 'new')
    assert.equal(await readFile(file, 'utf8'), 'new')
    assert.deepEqual(await readdir(dir), ['config.json'])
  })
})

test('when the folder is read-only but the file is writable, it is written in place', async (t) => {
  await inTempDir(async (dir) => {
    const file = join(dir, 'config.json')
    await writeFile(file, 'old')
    mockFs(t, 'openSync', (original, target, ...rest) => {
      if (String(target).endsWith('.tmp')) throw errno('EACCES')
      return original(target, ...rest)
    })
    writeFileAtomic(file, 'new')
    assert.equal(await readFile(file, 'utf8'), 'new')
  })
})

test('an owner or group a container cannot map is kept by writing in place', async (t) => {
  await inTempDir(async (dir) => {
    const file = join(dir, 'config.json')
    await writeFile(file, 'old')
    await chmod(file, 0o640)
    mockFs(t, 'fchownSync', () => {
      throw errno('EINVAL')
    })
    // Reaches fchown as root (owner always set); as another user only for a shared group.
    writeFileAtomic(file, 'new')
    assert.equal(await readFile(file, 'utf8'), 'new')
    assert.deepEqual(await readdir(dir), ['config.json'])
  })
})

test('other failures leave nothing behind and are reported', async () => {
  await inTempDir(async (dir) => {
    // A folder where the file should be: the new contents can't take its place.
    const target = join(dir, 'config.json')
    await mkdir(target)
    await writeFile(join(target, 'inside'), 'x')
    assert.throws(() => writeFileAtomic(target, 'new'))
    assert.deepEqual(await readdir(dir), ['config.json'])
    assert.equal(await readFile(join(target, 'inside'), 'utf8'), 'x')
  })
})

test('temporary files left by a crash are cleaned up; recent ones are not touched', async () => {
  await inTempDir(async (dir) => {
    const file = join(dir, 'config.json'),
      stale = join(dir, '.config.json.123.abcd.tmp'),
      recent = join(dir, '.config.json.456.ef01.tmp')
    await writeFile(file, 'old')
    await writeFile(stale, 'token')
    await writeFile(recent, 'token')
    const twoMinutesAgo = new Date(Date.now() - 120_000)
    await utimes(stale, twoMinutesAgo, twoMinutesAgo)
    writeFileAtomic(file, 'new')
    assert.deepEqual((await readdir(dir)).sort(), ['.config.json.456.ef01.tmp', 'config.json'])
  })
})

test('updateHomebridgeConfig writes through the safe path and reports a failed write', async (t) => {
  await inTempDir(async (dir) => {
    const file = join(dir, 'config.json')
    await writeFile(file, '{"a":1}')
    const api = { user: { configPath: () => file } }
    assert.equal(updateHomebridgeConfig(api, (text) => text.replace('1', '2')), true)
    assert.equal(await readFile(file, 'utf8'), '{"a":2}')
    assert.equal(updateHomebridgeConfig(api, (text) => text), false, 'no change, no write')

    mockFs(t, 'renameSync', () => {
      throw errno('EIO')
    })
    assert.equal(updateHomebridgeConfig(api, (text) => text.replace('2', '3')), false)
    assert.equal(await readFile(file, 'utf8'), '{"a":2}')
  })
})

test('the Ring system id file is created once and then reused', async () => {
  await inTempDir(async (dir) => {
    const first = getSystemId(dir)
    assert.equal(getSystemId(dir), first)
    assert.deepEqual(await readdir(dir), ['.ring.json'])
  })
})
