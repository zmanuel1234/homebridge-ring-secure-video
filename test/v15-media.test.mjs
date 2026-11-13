import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ReplaySubject, Subject } from 'rxjs'
import {
  CameraSource,
  getReturnAudioPrepareStreamRequest,
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

test("decrypts Ring pushes with the current FCM header format through ring-client-api's push-receiver", async () => {
  const { createECDH, randomBytes } = await import('node:crypto')
  const { createRequire } = await import('node:module')
  const { fileURLToPath } = await import('node:url')
  const { applyPushReceiverDecryptFix } = await import('../lib/push-receiver-fix.js')
  await import('ring-client-api') // loads push-receiver's client the way the plugin does
  const ringRequire = createRequire(fileURLToPath(import.meta.resolve('ring-client-api')))
  const decryptModules = Object.keys(ringRequire.cache).filter((path) =>
    path.endsWith('/@eneris/push-receiver/dist/utils/decrypt.js'),
  )
  assert.deepEqual(
    decryptModules,
    [ringRequire.resolve('@eneris/push-receiver/dist/utils/decrypt.js')],
    "the decrypt module patched is the one ring-client-api's push client loaded",
  )
  const ece = ringRequire('http_ece')
  const loadedDecrypt = ringRequire('@eneris/push-receiver/dist/utils/decrypt.js')

  // A push encrypted the way FCM sends it today: "dh=...; p256ecdsa=..." and "salt=...".
  const receiver = createECDH('prime256v1')
  receiver.generateKeys()
  const sender = createECDH('prime256v1')
  sender.generateKeys()
  const keys = {
    privateKey: receiver.getPrivateKey('base64'),
    authSecret: randomBytes(16).toString('base64'),
  }
  const salt = randomBytes(16).toString('base64url')
  const payload = { android_config: { category: 'com.ring.pn.live-event.motion' } }
  const rawData = ece.encrypt(Buffer.from(JSON.stringify(payload)), {
    version: 'aesgcm',
    dh: receiver.getPublicKey('base64url'),
    privateKey: sender,
    salt,
    authSecret: keys.authSecret,
  })
  const message = {
    rawData,
    appData: [
      { key: 'crypto-key', value: `dh=${sender.getPublicKey('base64url')}; p256ecdsa=BOgus` },
      { key: 'encryption', value: `salt=${salt}` },
    ],
  }

  assert.throws(() => loadedDecrypt.default(message, keys), 'push-receiver 4.3.0 fails on this format')
  const fix = applyPushReceiverDecryptFix()
  assert.equal(fix.result, 'applied', fix.detail)
  assert.deepEqual(loadedDecrypt.default(message, keys), payload)
  assert.equal(applyPushReceiverDecryptFix().result, 'applied', 'applying twice is harmless')
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
