import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ReplaySubject, Subject } from 'rxjs'
import {
  CameraSource,
  getHksvRecordingFormatArguments,
  getMaxRecordingSeconds,
  getReturnAudioPrepareStreamRequest,
  HKSV_RECORDING_MOVFLAGS,
} from '../lib/camera-source.js'
import { addMotionWatchdog } from '../lib/camera.js'
import { FragmentedMp4Parser } from '../lib/fragmented-mp4-parser.js'
import { ResourceGovernor } from '../lib/hksv-work-queue.js'
import { ManagedFfmpegProcess } from '../lib/managed-ffmpeg-process.js'
import { normalizeMediaConfig } from '../lib/media-config.js'
import { RingMediaIngress } from '../lib/ring-media-ingress.js'

function box(type, length = 8) {
  const value = Buffer.alloc(length)
  value.writeUInt32BE(length, 0)
  value.write(type, 4, 4, 'ascii')
  return value
}

function fakeSession() {
  const onCallEnded = new ReplaySubject(1)
  let didStop = false

  return {
    connection: { onCallAnswered: new ReplaySubject(1) },
    onCallEnded,
    onAudioRtp: new Subject(),
    onVideoRtp: new Subject(),
    isUsingOpus: Promise.resolve(false),
    requestKeyFrame() {},
    stop() {
      if (didStop) return
      didStop = true
      onCallEnded.next()
    },
    get didStop() {
      return didStop
    },
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function within(promise, timeoutMs) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(`timed out after ${timeoutMs}ms`)
    }),
  ])
}

test('resets the motion watchdog on push events and clears motion after inactivity', async () => {
  const events = new Subject()
  const values = []
  const subscription = addMotionWatchdog(events, 40).subscribe((value) => {
    values.push(value)
  })

  try {
    events.next(true)
    await delay(20)
    events.next(true)
    await delay(20)

    assert.deepEqual(values, [true, true])

    await delay(50)
    assert.deepEqual(values, [true, true, false])

    events.next(false)
    assert.deepEqual(values, [true, true, false, false])
    await delay(50)
    assert.deepEqual(values, [true, true, false, false])
  } finally {
    subscription.unsubscribe()
  }
})

function startManagedNodeChild({ ignoreTerm, stopGraceMs }) {
  let markReady
  let markExited
  const ready = new Promise((resolve) => { markReady = resolve })
  const exit = new Promise((resolve) => { markExited = resolve })
  const ffmpeg = new ManagedFfmpegProcess({
    ffmpegPath: process.execPath,
    ffmpegArgs: [
      '-e',
      [
        // Install the SIGTERM handler before announcing readiness, so a stop can't arrive in between.
        ignoreTerm ? "process.on('SIGTERM', () => {})" : '',
        "process.stdout.write('ready\\n')",
        'setInterval(() => {}, 1000)',
      ].filter(Boolean).join(';'),
    ],
    logLabel: 'test child',
    logger: { error() {}, info() {} },
    stopGraceMs,
    stdoutCallback: (data) => {
      if (data.toString().includes('ready')) markReady()
    },
    exitCallback: (code, signal) => markExited({ code, signal }),
  })

  return { ffmpeg, ready, exit }
}

test('normalizes v15 media settings while preserving legacy HKSV semantics', () => {
  const lowPower = normalizeMediaConfig({
    hksvPerformanceMode: 'rpi',
    hksvMaxRecordingSeconds: 0,
  })

  assert.equal(lowPower.profile, 'lowPower')
  assert.equal(lowPower.recording.maxQueuedBytes, 6 * 1024 * 1024)
  assert.equal(lowPower.recording.maxDurationSeconds, 0)
  assert.equal(
    normalizeMediaConfig({
      hksvPerformanceMode: 'rpi',
      media: { profile: 'quality', recording: { bitrateKbps: 5000 } },
    }).profile,
    'quality',
  )
  assert.throws(
    () => normalizeMediaConfig({ media: { recording: { unexpected: true } } }),
    /supported recording setting/,
  )
  assert.throws(
    () => normalizeMediaConfig({ media: { recording: { maxDurationSeconds: -1 } } }),
    /integer from 0 to 300/,
  )
})

test('uses the Homebridge address for FFmpeg return-audio input binding', () => {
  const request = {
    sessionID: 'session',
    sourceAddress: '192.168.1.20',
    targetAddress: '192.168.1.30',
    addressVersion: 'ipv4',
    audio: { port: 5000 },
    video: { port: 5001 },
  }

  assert.equal(
    getReturnAudioPrepareStreamRequest(request).targetAddress,
    request.sourceAddress,
  )
})

test('retains only incomplete fragmented MP4 data under its parser bound', () => {
  const parser = new FragmentedMp4Parser(32)
  const packets = parser.append(Buffer.concat([
    box('ftyp'),
    box('moov'),
    box('styp'),
    box('moof'),
    box('mdat', 40),
  ]))

  assert.equal(packets.length, 2)
  assert.throws(
    () => new FragmentedMp4Parser(32).append(box('mdat', 40).subarray(0, 33)),
    /retained data exceeded/,
  )
})

test('uses available recording capacity without allowing a second encoder per camera', async () => {
  const governor = new ResourceGovernor({ recordingConcurrency: 2 })
  const firstA = await governor.acquireLease({ cameraId: 'a' })
  const waitingA = governor.acquireLease({ cameraId: 'a' })
  const firstB = await governor.acquireLease({ cameraId: 'b' })

  firstB.setQueuedBytes(123)
  assert.equal(governor.getMetrics().activeRecordings, 2)
  assert.equal(governor.getMetrics().queuedRecordings, 1)
  assert.equal(governor.getMetrics().queuedBytes, 123)

  firstB.release()
  firstA.release()
  const secondA = await waitingA
  assert.equal(governor.getMetrics().activeRecordings, 1)
  secondA.release()
})

test('cancels unanswered or disposed Ring media ingress startup', async () => {
  const earlySession = fakeSession()
  const ingress = new RingMediaIngress({
    name: 'test camera',
    startLiveCall: async () => earlySession,
  })
  const lease = await ingress.acquire('test')
  const starting = lease.createTranscoder({ video: false, output: [], label: 'test' })
  earlySession.onCallEnded.next()
  await assert.rejects(starting, /ended before the media SDP was answered/)
  lease.release()

  const abortController = new AbortController()
  const abortSession = fakeSession()
  const abortIngress = new RingMediaIngress({
    name: 'abortable camera',
    startLiveCall: async () => abortSession,
  })
  const abortLease = await abortIngress.acquire('test')
  const aborting = abortLease.createTranscoder({
    signal: abortController.signal,
    video: false,
    output: [],
    label: 'test',
  })
  abortController.abort()
  await assert.rejects(aborting, { name: 'AbortError' })
  abortLease.release()
  abortIngress.shutdown()

  let resolveLiveCall
  const lateSession = fakeSession()
  const pendingIngress = new RingMediaIngress({
    name: 'pending camera',
    startLiveCall: () => new Promise((resolve) => { resolveLiveCall = resolve }),
  })
  const pendingAcquire = pendingIngress.acquire('test')
  pendingIngress.shutdown()
  resolveLiveCall(lateSession)

  await assert.rejects(pendingAcquire, /ended before it could be acquired/)
  assert.equal(lateSession.didStop, true)

  let resolveAbortableCall
  const delayedSession = fakeSession()
  const abortableIngress = new RingMediaIngress({
    name: 'abortable acquire camera',
    startLiveCall: () => new Promise((resolve) => { resolveAbortableCall = resolve }),
  }, 0)
  const acquireAbortController = new AbortController()
  const abortedAcquire = abortableIngress.acquire('test', acquireAbortController.signal)
  acquireAbortController.abort()
  await assert.rejects(abortedAcquire, { name: 'AbortError' })
  resolveAbortableCall(delayedSession)
  await within(delay(0), 1_000)
  assert.equal(delayedSession.didStop, true)
})

test('honors Homebridge recording cancellation before pipeline startup', async () => {
  const source = Object.create(CameraSource.prototype)
  source.ringCamera = { id: 'test-camera', name: 'test camera' }
  source.config = {}
  source.recordingActive = true
  source.recordingConfiguration = {
    mediaContainerConfiguration: { fragmentLength: 4_000 },
  }
  source.closedRecordingStreams = new Set()
  source.recordingWaiters = new Map()
  source.activeRecordingSessions = new Map()

  const abortController = new AbortController()
  abortController.abort()
  const generator = source.handleRecordingStreamRequest(1, abortController.signal)

  assert.equal((await within(generator.next(), 1_000)).done, true)
  assert.equal(source.activeRecordingSessions.size, 0)
  assert.equal(source.recordingWaiters.size, 0)
})

test('escalates a non-terminating FFmpeg child without killing a normal child', async () => {
  const stuck = startManagedNodeChild({ ignoreTerm: true, stopGraceMs: 25 })
  try {
    await within(stuck.ready, 1_000)
    stuck.ffmpeg.stop()
    assert.deepEqual(await within(stuck.exit, 1_000), {
      code: null,
      signal: 'SIGKILL',
    })
  } finally {
    stuck.ffmpeg.forceStop()
    await within(stuck.ffmpeg.exited, 1_000)
  }

  const normal = startManagedNodeChild({ ignoreTerm: false, stopGraceMs: 200 })
  try {
    await within(normal.ready, 1_000)
    normal.ffmpeg.stop()
    assert.deepEqual(await within(normal.exit, 1_000), {
      code: null,
      signal: 'SIGTERM',
    })
  } finally {
    normal.ffmpeg.forceStop()
    await within(normal.ffmpeg.exited, 1_000)
  }
})

test('exposes all media recording controls and applies CBR arguments', async () => {
  const schema = JSON.parse(
    await readFile(new URL('../config.schema.json', import.meta.url), 'utf8'),
  )
  const recordingSchema = schema.schema.properties.media.properties.recording

  for (const key of [
    'codec', 'bitrateKbps', 'maxBitrateKbps', 'bufferSizeKbps', 'rateControl',
    'crf', 'preset', 'keyframeInterval', 'prebufferLengthMs', 'fragmentLengthMs',
    'maxDurationSeconds', 'maxQueuedBytes', 'maxConcurrentRecordings',
  ]) {
    assert.ok(key in recordingSchema.properties, `schema should expose ${key}`)
  }
  assert.equal(recordingSchema.additionalProperties, false)

  const source = Object.create(CameraSource.prototype)
  source.config = {
    media: {
      recording: {
        codec: 'libx264',
        rateControl: 'cbr',
        bitrateKbps: 2000,
        maxBitrateKbps: 4000,
        bufferSizeKbps: 4000,
        crf: 20,
      },
    },
  }
  const cbrArgs = source.getHksvVideoArguments({ encoders: new Set() })

  assert.deepEqual(cbrArgs.slice(cbrArgs.indexOf('-minrate'), cbrArgs.indexOf('-bufsize')), [
    '-minrate', '2000k', '-maxrate', '2000k',
  ])
  assert.equal(cbrArgs.includes('-crf'), false)
})

test('does not start, and does not crash, without a configuration block', async () => {
  const { RingPlatform } = await import('../lib/ring-platform.js')
  const infos = []
  const listeners = []
  const log = { info: (m) => infos.push(m), error() {}, warn() {}, debug() {} }
  const api = { on: (event) => listeners.push(event) }

  new RingPlatform(log, undefined, api)

  assert.deepEqual(infos, ['No configuration found for platform Ring Secure Video'])
  assert.deepEqual(listeners, [], 'nothing is started')
})

test('ring-client-api loads the full @eneris/push-receiver 4.3.1 when the plugin starts', async () => {
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  // A fresh process that loads the plugin's entry the way Homebridge does.
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('./push-receiver-child.mjs', import.meta.url))],
    { encoding: 'utf8' },
  )
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)), {
    result: 'replaced',
    sameClient: true,
    loggerQuietened: true,
    oldVersionFails: true,
    decrypts: true,
  })
})

test("falls back to 4.3.1's decrypt when ring-client-api's push-receiver is already loaded", async () => {
  const { createRequire } = await import('node:module')
  const { fileURLToPath } = await import('node:url')
  const { encryptedPush } = await import('./push-message.mjs')
  await import('ring-client-api') // already loaded: too late to replace the package
  const { applyPushReceiverFix } = await import('../lib/push-receiver-fix.js')
  const ringRequire = createRequire(fileURLToPath(import.meta.resolve('ring-client-api')))
  const loadedPath = ringRequire.resolve('@eneris/push-receiver/dist/utils/decrypt.js')
  assert.ok(ringRequire.cache[loadedPath], "ring-client-api's push client loaded its 4.3.0 decrypt")

  const fix = applyPushReceiverFix()
  assert.equal(fix.result, 'decrypt-patched', fix.detail)
  const { message, keys, payload } = encryptedPush(ringRequire('http_ece'))
  assert.equal(
    ringRequire.cache[loadedPath].exports,
    ringRequire('@eneris/push-receiver/dist/utils/decrypt.js'),
    'the module patched is the one in the cache',
  )
  assert.deepEqual(ringRequire.cache[loadedPath].exports.default(message, keys), payload)
})

test('a plugin update does not force a Ring push or session refresh', async () => {
  const { mkdtemp, writeFile, readFile: read, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { RingPlatform } = await import('../lib/ring-platform.js')
  const dir = await mkdtemp(join(tmpdir(), 'ring-update-'))
  const configPath = join(dir, 'config.json')
  const platformConfig = {
    platform: 'Ring Secure Video',
    refreshToken: 'token',
    lastKnownPluginVersion: '0.0.1',
  }
  try {
    const original = `${JSON.stringify({ platforms: [platformConfig] }, null, 4)}\n`
    await writeFile(configPath, original)
    const log = { info() {}, error() {}, warn() {}, debug() {} }
    const api = { on() {}, user: { configPath: () => configPath, storagePath: () => dir } }

    // disableLogs keeps this test from replacing the library's global logger.
    const config = { ...platformConfig, disableLogs: true }
    new RingPlatform(log, config, api)

    assert.equal(config.forceRefreshRingPushCredentials, undefined)
    assert.equal(config.forceRefreshRingApiSession, undefined)
    assert.equal(await read(configPath, 'utf8'), original, 'config.json is not rewritten')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("gives the Raspberry Pi's V4L2 encoder numeric profile and level IDs", () => {
  const argsFor = (codec) => {
    const source = Object.create(CameraSource.prototype)
    source.config = { media: { recording: { codec } } }
    const args = source.getHksvVideoArguments({ encoders: new Set([codec]) })
    return [
      args[args.indexOf('-profile:v') + 1],
      args[args.indexOf('-level:v') + 1],
    ]
  }

  assert.deepEqual(argsFor('h264_v4l2m2m'), ['66', '31'])
  assert.deepEqual(argsFor('libx264'), ['baseline', '3.1'])
  assert.deepEqual(argsFor('h264_videotoolbox'), ['baseline', '3.1'])

  const copy = Object.create(CameraSource.prototype)
  copy.config = { media: { recording: { codec: 'copy' } } }
  assert.equal(copy.getHksvVideoArguments({ encoders: new Set() }).includes('-profile:v'), false)
})

test('delays the recording init segment, which still goes out before the first fragment', () => {
  assert.ok(HKSV_RECORDING_MOVFLAGS.split('+').includes('delay_moov'))
  assert.ok(HKSV_RECORDING_MOVFLAGS.split('+').includes('frag_keyframe'))

  // With delay_moov FFmpeg writes ftyp, moov and the first moof/mdat together.
  const packets = new FragmentedMp4Parser().append(
    Buffer.concat([box('ftyp'), box('moov'), box('moof'), box('mdat')]),
  )
  assert.deepEqual(
    packets.map((p) => p.data.subarray(4, 8).toString('ascii')),
    ['ftyp', 'moof'],
    'init segment first, then the fragment',
  )
})

test('records in the frame rate and audio format HomeKit chose', () => {
  const configuration = {
    videoCodec: { resolution: [1280, 720, 30], parameters: { bitRate: 800 } },
    audioCodec: { samplerate: 1, bitrate: 24 }, // index 1 = 16 kHz
    mediaContainerConfiguration: { fragmentLength: 4000 },
  }
  const encode = ['-vcodec', 'libx264', '-b:v', '800k']

  const withAudio = getHksvRecordingFormatArguments(configuration, encode, false, true)
  assert.deepEqual(withAudio.video, [...encode, '-r', '30'])
  assert.deepEqual(withAudio.audio, [
    '-acodec', 'aac', '-profile:a', 'aac_low', '-ac', '1', '-ar', '16000', '-b:a', '24k',
  ])
  assert.match(withAudio.description, /1280x720 at 30 fps, 800 kbps, fragments 4000 ms/)

  const noAudio = getHksvRecordingFormatArguments(configuration, encode, false, false)
  assert.deepEqual(noAudio.audio, ['-an'], 'no audio track when Record Audio is off')

  const copy = getHksvRecordingFormatArguments(configuration, ['-vcodec', 'copy'], true, true)
  assert.deepEqual(copy.video, ['-vcodec', 'copy'], 'copied video keeps its own frame rate')

  const at48 = getHksvRecordingFormatArguments(
    { ...configuration, audioCodec: { samplerate: 5, bitrate: 0 } }, encode, false, true,
  )
  assert.deepEqual(at48.audio.slice(-4), ['-ar', '48000', '-b:a', '32k'])
})

test('starts a recording with the first fragment that begins with a keyframe', () => {
  const container = (type, ...children) => {
    const body = Buffer.concat(children)
    const header = Buffer.alloc(8)
    header.writeUInt32BE(8 + body.length, 0)
    header.write(type, 4, 4, 'ascii')
    return Buffer.concat([header, body])
  }
  const fullBox = (type, flags, fields) => {
    const body = Buffer.alloc(4 + fields.length * 4)
    body.writeUInt32BE(flags, 0) // version 0 + flags
    fields.forEach((value, i) => body.writeUInt32BE(value >>> 0, 4 + i * 4))
    return container(type, body)
  }
  const NON_SYNC = 0x10000
  // trun with first_sample_flags (0x4) and data_offset (0x1): sample_count, data_offset, flags
  const fragmentWithFirstSampleFlags = (sampleFlags) => [
    container('moof', container('traf',
      fullBox('tfhd', 0x20000, [1]),
      fullBox('trun', 0x1 | 0x4, [1, 0, sampleFlags]))),
    box('mdat', 16),
  ]
  // trun without first-sample flags: tfhd default_sample_flags (0x20) decide
  const fragmentWithDefaultFlags = (sampleFlags) => [
    container('moof', container('traf',
      fullBox('tfhd', 0x20, [1, sampleFlags]),
      fullBox('trun', 0x1, [1, 0]))),
    box('mdat', 16),
  ]
  const types = (packets) => packets.map((p) => p.data.subarray(4, 8).toString('ascii'))

  const parser = new FragmentedMp4Parser()
  const packets = parser.append(Buffer.concat([
    box('ftyp'), box('moov'),
    ...fragmentWithFirstSampleFlags(NON_SYNC), // SPS/PPS-only fragment, no keyframe: dropped
    ...fragmentWithDefaultFlags(NON_SYNC), // still no keyframe: dropped
    ...fragmentWithFirstSampleFlags(0), // keyframe: the recording starts here
    ...fragmentWithDefaultFlags(NON_SYNC), // later fragments are kept as they are
  ]))
  assert.deepEqual(types(packets), ['ftyp', 'moof', 'moof'])

  // per-sample flags (0x400) after duration (0x100) and size (0x200)
  const perSampleFragment = (sampleFlags) => [
    container('moof', container('traf',
      fullBox('tfhd', 0, [1]),
      fullBox('trun', 0x1 | 0x100 | 0x200 | 0x400, [1, 0, 3000, 100, sampleFlags]))),
    box('mdat', 16),
  ]
  const perSample = new FragmentedMp4Parser().append(Buffer.concat([
    box('ftyp'), box('moov'), ...perSampleFragment(NON_SYNC), ...perSampleFragment(0),
  ]))
  assert.equal(perSample.length, 2, 'per-sample sync flag is read: the first fragment is dropped')

  // Audio as track 1 and video as track 2: the video track's flags decide.
  const trak = (trackId, handler) => container('trak',
    fullBox('tkhd', 0, [0, 0, trackId]),
    container('mdia', container('hdlr', Buffer.concat([
      Buffer.alloc(8), Buffer.from(handler, 'ascii'), Buffer.alloc(12),
    ]))))
  const twoTrackFragment = (videoFlags) => [
    container('moof',
      container('traf', fullBox('tfhd', 0x20, [1, 0]), fullBox('trun', 0x1, [1, 0])),
      container('traf', fullBox('tfhd', 0x20, [2, videoFlags]), fullBox('trun', 0x1, [1, 0]))),
    box('mdat', 16),
  ]
  const twoTracks = new FragmentedMp4Parser().append(Buffer.concat([
    box('ftyp'), container('moov', trak(1, 'soun'), trak(2, 'vide')),
    ...twoTrackFragment(NON_SYNC), ...twoTrackFragment(0),
  ]))
  assert.equal(twoTracks.length, 2, 'an audio keyframe before the video keyframe does not start the recording')

  // A truncated trun can't be read: treated as a keyframe rather than throwing.
  const truncated = new FragmentedMp4Parser().append(Buffer.concat([
    box('ftyp'), box('moov'),
    container('moof', container('traf', fullBox('tfhd', 0, [1]), fullBox('trun', 0x1 | 0x4, [1, 0]))),
    box('mdat', 16),
  ]))
  assert.equal(truncated.length, 2)
})

test('caps recordings at 180 seconds unless configured otherwise', () => {
  assert.equal(getMaxRecordingSeconds({}), 180)
  assert.equal(getMaxRecordingSeconds({ media: { recording: { maxDurationSeconds: 90 } } }), 90)
  assert.equal(getMaxRecordingSeconds({ media: { recording: { maxDurationSeconds: 0 } } }), 0, '0 disables the cap')
  assert.equal(getMaxRecordingSeconds({ hksvMaxRecordingSeconds: 90 }), 90, 'legacy setting')
  assert.equal(getMaxRecordingSeconds({ hksvMaxRecordingSeconds: 0 }), 0, 'legacy 0 disables the cap')
})

test('marks the last fragment of a recording as the end of the stream', async () => {
  const session = fakeSession()
  let feed
  const source = Object.create(CameraSource.prototype)
  source.ringCamera = { id: 'eos-camera', name: 'eos camera' }
  source.config = { media: { recording: { codec: 'libx264', maxDurationSeconds: 0 } } }
  source.controller = {}
  source.recordingActive = true
  source.recordingConfiguration = {
    videoCodec: { resolution: [1280, 720, 30], parameters: { bitRate: 800 } },
    audioCodec: { samplerate: 1, bitrate: 24 },
    mediaContainerConfiguration: { fragmentLength: 4_000 },
  }
  source.closedRecordingStreams = new Set()
  source.recordingWaiters = new Map()
  source.activeRecordingSessions = new Map()
  source.mediaIngress = {
    acquire: async () => ({
      session,
      release() {},
      createTranscoder: async (options) => {
        feed = options.stdoutCallback
        return { stop() {}, exited: Promise.resolve() }
      },
    }),
  }
  const fragment = (size) => Buffer.concat([box('moof'), box('mdat', size)])
  const types = (packet) => packet.data.subarray(4, 8).toString('ascii')

  const generator = source.handleRecordingStreamRequest(7)
  const first = generator.next()
  while (!feed) await delay(5)

  feed(Buffer.concat([box('ftyp'), box('moov'), fragment(16)]))
  const init = (await within(first, 1_000)).value
  assert.deepEqual([types(init), init.isLast], ['ftyp', false], 'init segment goes out at once')

  const second = generator.next()
  assert.equal(
    await Promise.race([second.then(() => 'sent'), delay(50).then(() => 'held')]),
    'held',
    'a fragment is held until the next one arrives',
  )

  feed(fragment(24))
  const firstFragment = (await within(second, 1_000)).value
  assert.deepEqual([firstFragment.data.length, firstFragment.isLast], [8 + 16, false])

  const third = generator.next()
  session.stop() // the Ring call ends, so the recording ends
  const lastFragment = (await within(third, 1_000)).value
  assert.deepEqual(
    [lastFragment.data.length, lastFragment.isLast],
    [8 + 24, true],
    'the last real fragment carries isLast, so HomeKit gets the end of the stream',
  )
  assert.equal((await within(generator.next(), 1_000)).done, true)
})

test('drives the separate notification motion sensor from the camera motion events', async () => {
  const hapNodejs = await import('@homebridge/hap-nodejs')
  const { setHap } = await import('../lib/hap.js')
  const { getMotionNotificationSensorUuid, setUpMotionNotificationSensor } = await import(
    '../lib/motion-notification-sensor.js'
  )
  setHap(hapNodejs)
  const { Accessory, Characteristic, Service, uuid } = hapNodejs

  const sensorUuid = getMotionNotificationSensorUuid('12345camera-hksv')
  assert.equal(sensorUuid, uuid.generate('12345camera-hksv-zmnotify'), 'stable identity')

  const accessory = new Accessory('Front Door Motion', sensorUuid)
  const motion = new Subject()
  const subscription = setUpMotionNotificationSensor(accessory, 'Front Door Motion', '12345-motion', motion)
  const detected = () =>
    accessory.getService(Service.MotionSensor).getCharacteristic(Characteristic.MotionDetected).value

  assert.equal(detected(), false)
  motion.next(true)
  assert.equal(detected(), true)
  motion.next(false)
  assert.equal(detected(), false)
  assert.equal(
    accessory.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.Model).value,
    'Motion notification sensor',
  )

  // Set up again on the cached accessory: no second motion service.
  setUpMotionNotificationSensor(accessory, 'Front Door Motion', '12345-motion', motion).unsubscribe()
  assert.equal(accessory.services.filter((s) => s.UUID === Service.MotionSensor.UUID).length, 1)
  subscription.unsubscribe()
})
