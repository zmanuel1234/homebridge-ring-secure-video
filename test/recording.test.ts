import assert from 'node:assert/strict'
import test from 'node:test'
import * as hapNodejs from '@homebridge/hap-nodejs'
import type { CameraRecordingConfiguration, PrepareStreamRequest, RecordingPacket } from '@homebridge/hap-nodejs'
import type { API, Logging } from 'homebridge'
import type { RingPlatform as RingPlatformClass } from '../src/ring-platform.js'
import type { RingCamera } from 'ring-client-api'
import type { StreamingSession } from 'ring-client-api/streaming/streaming-session'
import { ReplaySubject, Subject } from 'rxjs'
import {
  getHksvRecordingFormatArguments,
  getHksvFragmentDurationArguments,
  getHksvStallTimeoutMs,
  getMaxRecordingSeconds,
  getReturnAudioPrepareStreamRequest,
  HKSV_RECORDING_MOVFLAGS,
} from '../src/camera-source.js'
import { addMotionWatchdog } from '../src/camera.js'
import { FragmentedMp4Parser } from '../src/fragmented-mp4-parser.js'
import { ResourceGovernor } from '../src/hksv-work-queue.js'
import { ManagedFfmpegProcess } from '../src/managed-ffmpeg-process.js'
import { normalizeMediaConfig } from '../src/media-config.js'
import { RingMediaIngress } from '../src/ring-media-ingress.js'
import { setHap } from '../src/hap.js'
import type { IngressTranscoder, IngressTranscoderOptions } from '../src/ring-media-ingress.js'
import { bareCameraSource, config, fake, internals, platformAccessory, rawConfig, schema, serviceOf, type CameraSourceInternals } from './helpers.js'

setHap(hapNodejs)

/** The recording side of a CameraSource, as these tests set it up and drive it. */
interface RecordingSourceInternals extends CameraSourceInternals {
  recordingActive: boolean
  recordingConfiguration: unknown
  recordingWaiters: Map<unknown, unknown>
  activeRecordingSessions: Map<unknown, unknown>
  handleRecordingStreamRequest(streamId: number, signal?: AbortSignal): AsyncGenerator<RecordingPacket>
  closeRecordingStream(streamId: number, reason: string): void
  getHksvVideoArguments(capabilities: { encoders: Set<string> }): string[]
}

function recordingCameraSource(): RecordingSourceInternals {
  return internals<RecordingSourceInternals>(bareCameraSource())
}

type FeedCallback = (data: Buffer) => void

/** The packet a recording generator yielded (fails the test if the recording ended instead). */
function recordingPacket(result: IteratorResult<RecordingPacket>): RecordingPacket {
  assert.equal(result.done, false, 'the recording yields a packet')
  return result.value as RecordingPacket
}

/** Polls until a callback the code under test hands over has arrived. */
async function arrival<T>(get: () => T | undefined): Promise<T> {
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    await delay(5)
  }
}

/** The recording configuration HomeKit would choose, from a plain object. */
const recordingConfiguration = (value: object) => fake<CameraRecordingConfiguration>(value)

/** The four-character type of an MP4 box packet. */
const boxType = (packet: RecordingPacket | { data: Buffer }) => packet.data.subarray(4, 8).toString('ascii')

/** RingPlatform's config parameter, which the tests build by hand. */
type PlatformConfigArgument = ConstructorParameters<typeof RingPlatformClass>[1]

function box(type: string, length = 8): Buffer {
  const value = Buffer.alloc(length)
  value.writeUInt32BE(length, 0)
  value.write(type, 4, 4, 'ascii')
  return value
}

/** A Ring call with only what the media ingress and recordings use. */
type FakeSession = StreamingSession & { readonly didStop: boolean }

function fakeSession(): FakeSession {
  const onCallEnded = new ReplaySubject<void>(1)
  let didStop = false

  return fake<FakeSession>({
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
  })
}

/** A Ring camera that only starts live calls. */
function liveCallCamera(name: string, startLiveCall: () => Promise<StreamingSession>): RingCamera {
  return fake<RingCamera>({ name, startLiveCall })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(`timed out after ${timeoutMs}ms`)
    }),
  ])
}

test('resets the motion watchdog on push events and clears motion after inactivity', async () => {
  const events = new Subject<boolean>()
  const values: boolean[] = []
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

interface ChildExit { code: number | null; signal: NodeJS.Signals | null }

function startManagedNodeChild({ ignoreTerm, stopGraceMs }: { ignoreTerm: boolean; stopGraceMs: number }) {
  const signals: { ready?: () => void; exited?: (exit: ChildExit) => void } = {}
  const ready = new Promise<void>((resolve) => { signals.ready = resolve })
  const exit = new Promise<ChildExit>((resolve) => { signals.exited = resolve })
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
      if (data.toString().includes('ready')) signals.ready?.()
    },
    exitCallback: (code, signal) => signals.exited?.({ code, signal }),
  })

  return { ffmpeg, ready, exit }
}

test('normalizes media settings, ignoring the removed flat settings', () => {
  const lowPower = normalizeMediaConfig(config({
    media: { profile: 'lowPower', recording: { maxDurationSeconds: 0 } },
  }))

  assert.equal(lowPower.profile, 'lowPower')
  assert.equal(lowPower.recording.maxQueuedBytes, 6 * 1024 * 1024)
  assert.equal(lowPower.recording.maxDurationSeconds, 0)
  const removedOnly = normalizeMediaConfig(rawConfig({
    hksvPerformanceMode: 'rpi',
    cameraVideoCodec: 'libx264',
    hksvVideoBitrateKbps: 800,
    hksvVideoKeyframeInterval: 112,
    hksvMaxRecordingSeconds: 0,
  }))
  assert.equal(removedOnly.profile, 'adaptive')
  assert.equal(removedOnly.recording.codec, 'auto')
  assert.equal(removedOnly.recording.bitrateKbps, 3000)
  assert.equal(removedOnly.recording.keyframeInterval, 30)
  assert.equal(removedOnly.recording.maxDurationSeconds, undefined)
  assert.throws(
    () => normalizeMediaConfig(rawConfig({ media: { recording: { unexpected: true } } })),
    /supported recording setting/,
  )
  assert.throws(
    () => normalizeMediaConfig(config({ media: { recording: { maxDurationSeconds: -1 } } })),
    /integer from 0 to 300/,
  )
})

test('uses the Homebridge address for FFmpeg return-audio input binding', () => {
  const request = fake<PrepareStreamRequest>({
    sessionID: 'session',
    sourceAddress: '192.168.1.20',
    targetAddress: '192.168.1.30',
    addressVersion: 'ipv4',
    audio: { port: 5000 },
    video: { port: 5001 },
  })

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
  const ingress = new RingMediaIngress(liveCallCamera('test camera', async () => earlySession))
  const lease = await ingress.acquire('test')
  const starting = lease.createTranscoder({ video: false, output: [], label: 'test' })
  earlySession.onCallEnded.next()
  await assert.rejects(starting, /ended before the media SDP was answered/)
  lease.release()

  const abortController = new AbortController()
  const abortSession = fakeSession()
  const abortIngress = new RingMediaIngress(liveCallCamera('abortable camera', async () => abortSession))
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

  const calls: { answerLate?: (session: StreamingSession) => void; answerAborted?: (session: StreamingSession) => void } = {}
  const lateSession = fakeSession()
  const pendingIngress = new RingMediaIngress(liveCallCamera(
    'pending camera',
    () => new Promise((resolve) => { calls.answerLate = resolve }),
  ))
  const pendingAcquire = pendingIngress.acquire('test')
  pendingIngress.shutdown()
  assert.ok(calls.answerLate, 'the live call was started')
  calls.answerLate(lateSession)

  await assert.rejects(pendingAcquire, /ended before it could be acquired/)
  assert.equal(lateSession.didStop, true)

  const delayedSession = fakeSession()
  const abortableIngress = new RingMediaIngress(liveCallCamera(
    'abortable acquire camera',
    () => new Promise((resolve) => { calls.answerAborted = resolve }),
  ), 0)
  const acquireAbortController = new AbortController()
  const abortedAcquire = abortableIngress.acquire('test', acquireAbortController.signal)
  acquireAbortController.abort()
  await assert.rejects(abortedAcquire, { name: 'AbortError' })
  assert.ok(calls.answerAborted, 'the live call was started')
  calls.answerAborted(delayedSession)
  await within(delay(0), 1_000)
  assert.equal(delayedSession.didStop, true)
})

test('honors Homebridge recording cancellation before pipeline startup', async () => {
  const source = recordingCameraSource()
  source.ringCamera = { id: 'test-camera', name: 'test camera' }
  source.config = {}
  source.recordingActive = true
  source.recordingConfiguration = {
    mediaContainerConfiguration: { fragmentLength: 4_000 },
  }
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
  const recordingSchema = schema.schema.properties.media?.properties?.recording
  assert.ok(recordingSchema?.properties)

  for (const key of [
    'codec', 'bitrateKbps', 'maxBitrateKbps', 'bufferSizeKbps', 'rateControl',
    'crf', 'preset', 'keyframeInterval', 'prebufferLengthMs', 'fragmentLengthMs',
    'maxDurationSeconds', 'maxQueuedBytes', 'maxConcurrentRecordings',
  ]) {
    assert.ok(key in recordingSchema.properties, `schema should expose ${key}`)
  }
  assert.equal(recordingSchema.additionalProperties, false)

  const source = recordingCameraSource()
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
  const { RingPlatform } = await import('../src/ring-platform.js')
  const infos: string[] = []
  const listeners: string[] = []
  const log = fake<Logging>({ info: (m: string) => infos.push(m), error() {}, warn() {}, debug() {} })
  const api = fake<API>({ on: (event: string) => listeners.push(event) })

  new RingPlatform(log, internals<PlatformConfigArgument>(undefined), api)

  assert.deepEqual(infos, ['No configuration found for platform Ring Secure Video'])
  assert.deepEqual(listeners, [], 'nothing is started')
})

test('starts nothing, and does not crash, with a configuration block but no Ring token', async () => {
  const { RingPlatform } = await import('../src/ring-platform.js')
  const warnings: string[] = []
  const handlers: Record<string, (() => void) | undefined> = {}
  const log = fake<Logging>({ info() {}, error() {}, warn: (m: string) => warnings.push(m), debug() {} })
  const api = fake<API>({
    on: (event: string, handler: () => void) => { handlers[event] = handler },
    user: { storagePath: () => '/nonexistent-homebridge-storage' },
  })
  // A child bridge, where the plugin watches HomeKit's connections once it is configured
  const script = process.argv[1]
  process.argv[1] = '/homebridge/lib/childBridgeFork.js'
  let platform
  try {
    platform = new RingPlatform(log, fake<PlatformConfigArgument>({ platform: 'RingSecureVideo', disableLogs: true }), api)
  } finally {
    process.argv[1] = script
  }
  handlers.didFinishLaunching?.()

  const { homeKitConnections } = internals<{ homeKitConnections?: { running: boolean } }>(platform)
  assert.ok(homeKitConnections, 'the HomeKit connection monitor exists on a child bridge')
  assert.equal(homeKitConnections.running, false, 'and is not started without a token')
  assert.ok(warnings.some((m) => m.startsWith('Plugin is not configured')))
  handlers.shutdown?.()
})

test("ring-client-api's push client checks its connection every 60 s and decrypts current pushes", async () => {
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  // A fresh process that loads the plugin's entry the way Homebridge does.
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./push-receiver-child.ts', import.meta.url))],
    { encoding: 'utf8' },
  )
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1) ?? ''), {
    result: 'heartbeat',
    version: '4.4.0',
    heartbeatIntervalMs: 60_000,
    heartbeatClass: 'PushReceiverWithHeartbeat',
    decrypts: true,
  })
})

test("the push heartbeat isn't applied once ring-client-api's push client is loaded", async () => {
  await import('ring-client-api') // already loaded: too late to replace the class it imported
  const { applyPushReceiverFix } = await import('../src/push-receiver-fix.js')
  assert.equal(applyPushReceiverFix().result, 'already-loaded')
})

test('a plugin update does not force a Ring push or session refresh', async () => {
  const { mkdtemp, writeFile, readFile: read, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { RingPlatform } = await import('../src/ring-platform.js')
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
    const log = fake<Logging>({ info() {}, error() {}, warn() {}, debug() {} })
    const api = fake<API>({ on() {}, user: { configPath: () => configPath, storagePath: () => dir } })

    // disableLogs keeps this test from replacing the library's global logger.
    const config: Record<string, unknown> = { ...platformConfig, disableLogs: true }
    new RingPlatform(log, fake<PlatformConfigArgument>(config), api)

    assert.equal(config.forceRefreshRingPushCredentials, undefined)
    assert.equal(config.forceRefreshRingApiSession, undefined)
    assert.equal(await read(configPath, 'utf8'), original, 'config.json is not rewritten')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("gives the Raspberry Pi's V4L2 encoder numeric profile and level IDs", () => {
  const argsFor = (codec: string) => {
    const source = recordingCameraSource()
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

  const copy = recordingCameraSource()
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

  const withAudio = getHksvRecordingFormatArguments(recordingConfiguration(configuration), encode, false, true)
  assert.deepEqual(withAudio.video, [...encode, '-r', '30'])
  assert.deepEqual(withAudio.audio, [
    '-acodec', 'aac', '-profile:a', 'aac_low', '-ac', '1', '-ar', '16000', '-b:a', '24k',
  ])
  assert.match(withAudio.description, /1280x720 at 30 fps, 800 kbps, fragments 4000 ms/)

  const noAudio = getHksvRecordingFormatArguments(recordingConfiguration(configuration), encode, false, false)
  assert.deepEqual(noAudio.audio, ['-an'], 'no audio track when Record Audio is off')

  const copy = getHksvRecordingFormatArguments(recordingConfiguration(configuration), ['-vcodec', 'copy'], true, true)
  assert.deepEqual(copy.video, ['-vcodec', 'copy'], 'copied video keeps its own frame rate')

  const at48 = getHksvRecordingFormatArguments(
    recordingConfiguration({ ...configuration, audioCodec: { samplerate: 5, bitrate: 0 } }), encode, false, true,
  )
  assert.deepEqual(at48.audio.slice(-4), ['-ar', '48000', '-b:a', '32k'])
})

test('starts a recording with the first fragment that begins with a keyframe', () => {
  const container = (type: string, ...children: Buffer[]) => {
    const body = Buffer.concat(children)
    const header = Buffer.alloc(8)
    header.writeUInt32BE(8 + body.length, 0)
    header.write(type, 4, 4, 'ascii')
    return Buffer.concat([header, body])
  }
  const fullBox = (type: string, flags: number, fields: number[]) => {
    const body = Buffer.alloc(4 + fields.length * 4)
    body.writeUInt32BE(flags, 0) // version 0 + flags
    fields.forEach((value, i) => body.writeUInt32BE(value >>> 0, 4 + i * 4))
    return container(type, body)
  }
  const NON_SYNC = 0x10000
  // trun with first_sample_flags (0x4) and data_offset (0x1): sample_count, data_offset, flags
  const fragmentWithFirstSampleFlags = (sampleFlags: number) => [
    container('moof', container('traf',
      fullBox('tfhd', 0x20000, [1]),
      fullBox('trun', 0x1 | 0x4, [1, 0, sampleFlags]))),
    box('mdat', 16),
  ]
  // trun without first-sample flags: tfhd default_sample_flags (0x20) decide
  const fragmentWithDefaultFlags = (sampleFlags: number) => [
    container('moof', container('traf',
      fullBox('tfhd', 0x20, [1, sampleFlags]),
      fullBox('trun', 0x1, [1, 0]))),
    box('mdat', 16),
  ]
  const types = (packets: Array<{ data: Buffer }>) => packets.map(boxType)

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
  const perSampleFragment = (sampleFlags: number) => [
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
  const trak = (trackId: number, handler: string) => container('trak',
    fullBox('tkhd', 0, [0, 0, trackId]),
    container('mdia', container('hdlr', Buffer.concat([
      Buffer.alloc(8), Buffer.from(handler, 'ascii'), Buffer.alloc(12),
    ]))))
  const twoTrackFragment = (videoFlags: number) => [
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
  assert.equal(getMaxRecordingSeconds(config()), 180)
  assert.equal(getMaxRecordingSeconds(config({ media: { recording: { maxDurationSeconds: 90 } } })), 90)
  assert.equal(getMaxRecordingSeconds(config({ media: { recording: { maxDurationSeconds: 0 } } })), 0, '0 disables the cap')
  assert.equal(getMaxRecordingSeconds(rawConfig({ hksvMaxRecordingSeconds: 90 })), 180, 'removed setting')
})

test('marks the last fragment of a recording as the end of the stream', async () => {
  const session = fakeSession()
  const hooks: { feed?: FeedCallback } = {}
  const source = recordingCameraSource()
  source.ringCamera = { id: 'eos-camera', name: 'eos camera' }
  source.config = { media: { recording: { codec: 'libx264', maxDurationSeconds: 0 } } }
  source.controller = {}
  source.recordingActive = true
  source.recordingConfiguration = {
    videoCodec: { resolution: [1280, 720, 30], parameters: { bitRate: 800 } },
    audioCodec: { samplerate: 1, bitrate: 24 },
    mediaContainerConfiguration: { fragmentLength: 4_000 },
  }
  source.recordingWaiters = new Map()
  source.activeRecordingSessions = new Map()
  source.mediaIngress = {
    acquire: async () => ({
      session,
      release() {},
      createTranscoder: async (options: IngressTranscoderOptions): Promise<IngressTranscoder> => {
        hooks.feed = options.stdoutCallback
        return { stop() {}, exited: Promise.resolve() }
      },
    }),
  }
  const fragment = (size: number) => Buffer.concat([box('moof'), box('mdat', size)])
  const types = boxType

  const generator = source.handleRecordingStreamRequest(7)
  const first = generator.next()
  const feed = await arrival(() => hooks.feed)

  feed(Buffer.concat([box('ftyp'), box('moov'), fragment(16)]))
  const init = recordingPacket(await within(first, 1_000))
  assert.deepEqual([types(init), init.isLast], ['ftyp', false], 'init segment goes out at once')

  const second = generator.next()
  assert.equal(
    await Promise.race([second.then(() => 'sent'), delay(50).then(() => 'held')]),
    'held',
    'a fragment is held until the next one arrives',
  )

  feed(fragment(24))
  const firstFragment = recordingPacket(await within(second, 1_000))
  assert.deepEqual([firstFragment.data.length, firstFragment.isLast], [8 + 16, false])

  const third = generator.next()
  session.stop() // the Ring call ends, so the recording ends
  const lastFragment = recordingPacket(await within(third, 1_000))
  assert.deepEqual(
    [lastFragment.data.length, lastFragment.isLast],
    [8 + 24, true],
    'the last real fragment carries isLast, so HomeKit gets the end of the stream',
  )
  assert.equal((await within(generator.next(), 1_000)).done, true)
})

test('drives the separate notification motion sensor from the camera motion events', async () => {
  const hapNodejs = await import('@homebridge/hap-nodejs')
  const { setHap } = await import('../src/hap.js')
  const { getMotionNotificationSensorUuid, setUpMotionNotificationSensor } = await import(
    '../src/motion-notification-sensor.js'
  )
  setHap(hapNodejs)
  const { Accessory, Characteristic, Service, uuid } = hapNodejs

  const sensorUuid = getMotionNotificationSensorUuid('12345camera-hksv')
  assert.equal(sensorUuid, uuid.generate('12345camera-hksv-zmnotify'), 'stable identity')

  const hap = new Accessory('Front Door Motion', sensorUuid)
  const accessory = platformAccessory(hap)
  const motion = new Subject<boolean>()
  const subscription = setUpMotionNotificationSensor(accessory, 'Front Door Motion', '12345-motion', motion)
  const detected = () =>
    serviceOf(hap, Service.MotionSensor).getCharacteristic(Characteristic.MotionDetected).value

  assert.equal(detected(), false)
  motion.next(true)
  assert.equal(detected(), true)
  motion.next(false)
  assert.equal(detected(), false)
  assert.equal(
    serviceOf(hap, Service.AccessoryInformation).getCharacteristic(Characteristic.Model).value,
    'Motion notification sensor',
  )

  // Set up again on the cached accessory: no second motion service.
  setUpMotionNotificationSensor(accessory, 'Front Door Motion', '12345-motion', motion).unsubscribe()
  assert.equal(hap.services.filter((s) => s.UUID === Service.MotionSensor.UUID).length, 1)
  subscription.unsubscribe()
})

// A recording source whose Ring call is `session`; `feed` receives FFmpeg's output callback.
function recordingSource(
  session: StreamingSession,
  onTranscoder: (feed: FeedCallback | undefined, options: IngressTranscoderOptions) => void,
): RecordingSourceInternals {
  const source = recordingCameraSource()
  source.ringCamera = { id: 'end-camera', name: 'end camera' }
  source.config = { media: { recording: { codec: 'libx264', maxDurationSeconds: 0 } } }
  source.controller = {}
  source.recordingActive = true
  source.recordingConfiguration = {
    videoCodec: { resolution: [1280, 720, 30], parameters: { bitRate: 800 } },
    audioCodec: { samplerate: 1, bitrate: 24 },
    mediaContainerConfiguration: { fragmentLength: 4_000 },
  }
  source.recordingWaiters = new Map()
  source.activeRecordingSessions = new Map()
  source.mediaIngress = {
    acquire: async () => ({
      session,
      release() {},
      createTranscoder: async (options: IngressTranscoderOptions): Promise<IngressTranscoder> => {
        onTranscoder(options.stdoutCallback, options)
        return { stop() {}, exited: Promise.resolve() }
      },
    }),
  }
  return source
}

const isHdsError = (reason: hapNodejs.HDSProtocolSpecificErrorReason) => (e: unknown) =>
  e instanceof hapNodejs.HDSProtocolError && e.reason === reason

test('a recording that ends before any fragment ends with an error, so HAP frees the stream', async () => {
  const session = fakeSession()
  const hooks: { feed?: FeedCallback } = {}
  const generator = recordingSource(session, (f) => (hooks.feed = f)).handleRecordingStreamRequest(8)
  const first = generator.next()
  const feed = await arrival(() => hooks.feed)

  feed(Buffer.concat([box('ftyp'), box('moov')]))
  assert.equal(recordingPacket(await within(first, 1_000)).isLast, false, 'init segment')

  // the Ring call ends before a fragment: nothing can carry isLast, and HAP-NodeJS sends
  // nothing for an empty packet
  const next = generator.next()
  session.stop()
  await assert.rejects(
    within(next, 1_000),
    isHdsError(hapNodejs.HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE),
  )
})

test('a recording HomeKit closes ends without an error', async () => {
  const session = fakeSession()
  const hooks: { feed?: FeedCallback } = {}
  const source = recordingSource(session, (f) => (hooks.feed = f)),
    generator = source.handleRecordingStreamRequest(9),
    first = generator.next()
  const feed = await arrival(() => hooks.feed)
  feed(Buffer.concat([box('ftyp'), box('moov')]))
  await within(first, 1_000)

  const next = generator.next()
  source.closeRecordingStream(9, 'HomeKit closed it')
  assert.equal((await within(next, 1_000)).done, true)
})

test('a recording request while recording is off is refused at once', async () => {
  const source = recordingSource(fakeSession(), () => {})
  source.recordingActive = false
  await assert.rejects(
    within(source.handleRecordingStreamRequest(10).next(), 1_000),
    isHdsError(hapNodejs.HDSProtocolSpecificErrorReason.NOT_ALLOWED),
  )
})

test("a copied recording's fragments are cut at keyframes, up to 3 fragment lengths", () => {
  // with one fragment length FFmpeg cut between Ring's keyframes, so some fragments didn't start
  // with one; with no limit a fragment would grow until Ring's next keyframe
  assert.deepEqual(getHksvFragmentDurationArguments('copy', 4_000), ['-frag_duration', '12000000'])
  assert.deepEqual(getHksvFragmentDurationArguments('libx264', 4_000), [
    '-frag_duration',
    '4000000',
  ])
  assert.deepEqual(getHksvFragmentDurationArguments('h264_v4l2m2m', 4_000), [
    '-frag_duration',
    '4000000',
  ])
})

test("a copied recording's FFmpeg output allows fragments of 3 fragment lengths", async () => {
  const hooks: { output?: Array<string | number> } = {}
  const source = recordingSource(fakeSession(), (feed, options) => (hooks.output = options.output))
  source.config = { media: { recording: { codec: 'copy', maxDurationSeconds: 0 } } }
  const generator = source.handleRecordingStreamRequest(11),
    first = generator.next()
  const output = await arrival(() => hooks.output)
  assert.equal(output[output.indexOf('-frag_duration') + 1], '12000000')
  assert.ok(output.includes('-movflags'))
  source.closeRecordingStream(11, 'done')
  assert.equal((await within(first, 1_000)).done, true)
})

test('a recording counts as stalled only after more than its longest fragment', () => {
  // HomeKit's fragment lengths go from 1 to 8 s; a copied fragment can last 3 of them
  for (const fragmentLengthMs of [1_000, 4_000, 8_000]) {
    const timeout = getHksvStallTimeoutMs(fragmentLengthMs)
    assert.ok(timeout >= fragmentLengthMs * 3 + 5_000, `${fragmentLengthMs} ms: ${timeout} ms`)
    assert.ok(timeout >= 20_000 && timeout <= 60_000, `${fragmentLengthMs} ms: ${timeout} ms`)
  }
  assert.equal(getHksvStallTimeoutMs(4_000), 20_000)
  assert.equal(getHksvStallTimeoutMs(8_000), 29_000)
})
