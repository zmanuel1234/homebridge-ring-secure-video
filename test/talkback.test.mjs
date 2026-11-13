import assert from 'node:assert/strict'
import test from 'node:test'
import { ReturnAudioTranscoder, RtpSplitter } from '@homebridge/camera-utils'

// camera-source.ts listens on camera-utils' talk-back ffmpeg the same way (ffmpegProcess.ff and
// its outputs); this checks that this reaches the process and catches a failed start in time.
test("talk-back's ffmpeg failing to start is caught where camera-source.ts listens", async () => {
  const splitter = new RtpSplitter()
  const transcoder = new ReturnAudioTranscoder({
    prepareStreamRequest: {
      targetAddress: '127.0.0.1',
      addressVersion: 'ipv4',
      audio: { srtp_key: Buffer.alloc(16), srtp_salt: Buffer.alloc(14) },
    },
    startStreamRequest: { audio: { codec: 'OPUS', sample_rate: 16, channel: 1, pt: 110 } },
    incomingAudioOptions: { ssrc: 1, rtcpPort: 0 },
    outputArgs: [],
    ffmpegPath: '/nonexistent/ffmpeg',
    returnAudioSplitter: splitter,
  })
  const ff = transcoder.ffmpegProcess?.ff
  assert.ok(ff, 'camera-utils still keeps its ffmpeg at ffmpegProcess.ff')
  const errors = []
  for (const emitter of [ff, ff.stdout, ff.stderr]) emitter?.on('error', (e) => errors.push(e.code))

  await transcoder.start().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 100))
  transcoder.stop()
  splitter.close()
  assert.deepEqual(errors, ['ENOENT'])
})

test('live view with a talk-back ffmpeg that cannot start fails cleanly instead of crashing', async () => {
  const { Subject, Subscription } = await import('rxjs')
  const hapNodejs = await import('@homebridge/hap-nodejs')
  const { setHap } = await import('../lib/hap.js')
  setHap(hapNodejs)
  const { setFfmpegPath } = await import('ring-client-api/ffmpeg')
  setFfmpegPath('/nonexistent/ffmpeg')
  const { CameraSource } = await import('../lib/camera-source.js')
  const { hksvRecordingQueue } = await import('../lib/hksv-work-queue.js')

  let released = 0
  const lease = {
    session: { onCallEnded: new Subject(), activateCameraSpeaker() {}, sendAudioPacket() {} },
    subscribeVideo: () => new Subscription(),
    createTranscoder: async () => ({ stop() {}, exited: Promise.resolve() }),
    release: () => released++,
  }
  const source = Object.create(CameraSource.prototype)
  source.ringCamera = { name: 'Front Door' }
  source.sessions = {}
  source.mediaIngress = { acquire: async () => lease }
  const key = Buffer.alloc(16),
    salt = Buffer.alloc(14)
  const prepare = {
    sessionID: 's1',
    targetAddress: '127.0.0.1',
    sourceAddress: '127.0.0.1',
    addressVersion: 'ipv4',
    audio: { port: 50000, srtp_key: key, srtp_salt: salt },
    video: { port: 50002, srtp_key: key, srtp_salt: salt },
  }
  const prepareError = await new Promise((resolve) => source.prepareStream(prepare, resolve))
  assert.equal(prepareError, undefined, 'the stream prepares')
  const start = {
    sessionID: 's1',
    type: 'start',
    audio: { codec: 'OPUS', sample_rate: 16, channel: 1, pt: 110, packet_time: 20, max_bit_rate: 24 },
    video: { pt: 99 },
  }
  const error = await new Promise((resolve) => source.handleStreamRequest(start, resolve))
  await new Promise((resolve) => setTimeout(resolve, 200))

  assert.ok(error, 'HomeKit is told the stream did not start')
  assert.deepEqual(Object.keys(source.sessions), [])
  assert.equal(released, 1, 'the Ring call is released')
  assert.equal(hksvRecordingQueue.getMetrics().activeFfmpegProcesses, 0)
})
