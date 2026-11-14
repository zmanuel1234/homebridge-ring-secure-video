import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaultFfmpegPath } from '@homebridge/camera-utils'
import { setFfmpegPath } from 'ring-client-api/ffmpeg'
import {
  getFfmpegCapabilities,
  getFfmpegOutput,
  getRecordingFfmpegPath,
  getUsableEncoders,
  getV4l2DeviceNames,
} from '../lib/ffmpeg-capabilities.js'
import { selectHksvVideoCodec } from '../lib/hksv-options.js'

const listed = new Set(['libx264', 'h264_v4l2m2m', 'h264_videotoolbox'])
const pi4 = ['bcm2835-codec-decode', 'bcm2835-codec-encode', 'bcm2835-codec-isp']

test('the Pi hardware encoder only counts on Linux with an encoder device', () => {
  assert.deepEqual([...getUsableEncoders(listed, 'linux', pi4)], ['libx264', 'h264_v4l2m2m'], 'Raspberry Pi 4')
  assert.deepEqual([...getUsableEncoders(listed, 'linux', [])], ['libx264'], 'x86 Linux, Docker, a NAS')
  assert.deepEqual(
    [...getUsableEncoders(listed, 'linux', ['rpi-hevc-dec', 'pispbe'])],
    ['libx264'],
    'Raspberry Pi 5: no hardware encoder',
  )
  assert.deepEqual([...getUsableEncoders(listed, 'darwin', [])], ['libx264', 'h264_videotoolbox'], 'macOS')
  assert.deepEqual([...getUsableEncoders(listed, 'win32', [])], ['libx264'])
})

test("auto picks libx264 where the hardware encoder is listed but can't work", () => {
  const config = { media: { profile: 'adaptive' } },
    pick = (encoders) => selectHksvVideoCodec(undefined, { encoders, hwaccels: new Set() }, config)
  assert.equal(pick(getUsableEncoders(listed, 'linux', [])), 'libx264')
  assert.equal(pick(getUsableEncoders(listed, 'linux', pi4)), 'h264_v4l2m2m')
  assert.equal(pick(getUsableEncoders(listed, 'darwin', [])), 'h264_videotoolbox')
  assert.equal(
    selectHksvVideoCodec(undefined, { encoders: new Set(['h264_v4l2m2m']), hwaccels: new Set() }, { media: { profile: 'lowPower' } }),
    'copy',
    'lowPower stays on copy',
  )
})

test('only encoder devices that make video count, not JPEG ones or capture cards', () => {
  const pick = (names) => getUsableEncoders(listed, 'linux', names).has('h264_v4l2m2m')
  assert.equal(pick(['bcm2835-codec-encode_image']), false)
  assert.equal(pick(['coda-jpeg-encoder']), false)
  assert.equal(pick(['ivtv0 encoder MPG', 'cx18-0 encoder MPEG']), false)
  assert.equal(pick(['s5p-mfc-enc']), true)
  assert.equal(pick(['qcom-venus-encoder']), true)
})

test('video device names are read from sysfs, for devices Homebridge can open', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'v4l2-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sysfs = join(dir, 'sys'),
    dev = join(dir, 'dev')
  await mkdir(dev)
  for (const [device, name] of [
    ['video10', 'bcm2835-codec-decode'],
    ['video11', 'bcm2835-codec-encode'],
    ['video12', 'bcm2835-codec-isp'],
  ]) {
    await mkdir(join(sysfs, device), { recursive: true })
    await writeFile(join(sysfs, device, 'name'), `${name}\n`)
  }
  await writeFile(join(dev, 'video10'), '')
  await writeFile(join(dev, 'video11'), '')
  // video12 isn't in /dev, as in Docker without the device passed through
  assert.deepEqual(getV4l2DeviceNames(sysfs, dev).toSorted(), ['bcm2835-codec-decode', 'bcm2835-codec-encode'])
  assert.deepEqual(getV4l2DeviceNames(join(dir, 'missing'), dev), [])
  await rm(join(dev, 'video11'))
  assert.equal(getUsableEncoders(listed, 'linux', getV4l2DeviceNames(sysfs, dev)).has('h264_v4l2m2m'), false)
})

test('the check runs the FFmpeg that records', (t) => {
  t.after(() => setFfmpegPath(undefined))
  assert.equal(getRecordingFfmpegPath(), defaultFfmpegPath)
  setFfmpegPath('/opt/ffmpeg/bin/ffmpeg')
  assert.equal(getRecordingFfmpegPath(), '/opt/ffmpeg/bin/ffmpeg')
})

test('a hanging FFmpeg probe gives up instead of holding recordings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ffmpeg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const slow = join(dir, 'ffmpeg')
  await writeFile(slow, '#!/bin/sh\nsleep 5\necho late\n')
  await chmod(slow, 0o755)
  const started = Date.now()
  const output = await getFfmpegOutput(['-encoders'], slow, 200)
  assert.ok(Date.now() - started < 3000, 'returned well before the probe would finish')
  assert.equal(output.includes('late'), false)
})

test("on this machine, the bundled FFmpeg is probed and its hardware encoders kept only where they work", async () => {
  const output = await getFfmpegOutput(['-hide_banner', '-encoders'], defaultFfmpegPath)
  assert.match(output, /libx264/, 'the bundled FFmpeg answered')
  const names = new Set(output.split(/\s+/))
  const usable = getUsableEncoders(names)
  if (process.platform === 'linux' && !getV4l2DeviceNames().some((n) => /encode/i.test(n))) {
    assert.equal(usable.has('h264_v4l2m2m'), false)
  }
  if (process.platform !== 'darwin') assert.equal(usable.has('h264_videotoolbox'), false)
})

test('a probe that fails is tried again at the next recording', async (t) => {
  t.after(() => setFfmpegPath(undefined))
  setFfmpegPath('/nonexistent/ffmpeg')
  const failed = await getFfmpegCapabilities()
  assert.equal(failed.encoders.size, 0)
  setFfmpegPath(undefined)
  const retried = await getFfmpegCapabilities()
  assert.equal(retried.encoders.has('libx264'), true, 'asked the bundled FFmpeg again')
  assert.equal(await getFfmpegCapabilities(), retried, 'a probe that worked is kept')
})
