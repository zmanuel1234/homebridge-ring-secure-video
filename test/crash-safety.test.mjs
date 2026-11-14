import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import test from 'node:test'
import { of } from 'rxjs'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { useLogger } from 'ring-client-api/util'
import { setHap } from '../lib/hap.js'
import '../lib/ring-platform.js'

setHap(hapNodejs)

const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))

function captureErrors(t) {
  const errors = []
  useLogger({ logInfo() {}, logError: (message) => errors.push(message) })
  t.after(() => useLogger({ logInfo() {}, logError() {} }))
  return errors
}

test('an error thrown in an rxjs subscriber is logged instead of stopping Homebridge', async (t) => {
  const errors = captureErrors(t)
  of(1).subscribe(() => {
    throw new Error('subscriber failed')
  })
  await settle()
  assert.equal(errors.length, 1)
  assert.match(String(errors[0]?.message ?? errors[0]), /subscriber failed/)
})

test('a packet that is not RTP on the live view audio port is dropped', async (t) => {
  const errors = captureErrors(t)
  const { Subject, Subscription } = await import('rxjs')
  const { CameraSource } = await import('../lib/camera-source.js')

  // A real live view session, from prepareStream, as in talkback.test.mjs.
  const lease = {
    session: { onCallEnded: new Subject(), activateCameraSpeaker() {}, sendAudioPacket() {} },
    subscribeVideo: () => new Subscription(),
    release() {},
  }
  const source = Object.create(CameraSource.prototype)
  source.ringCamera = { name: 'Front Door' }
  source.sessions = {}
  source.mediaIngress = { acquire: async () => lease }
  const key = Buffer.alloc(16),
    salt = Buffer.alloc(14)
  await new Promise((resolve) =>
    source.prepareStream(
      {
        sessionID: 's1',
        targetAddress: '127.0.0.1',
        sourceAddress: '127.0.0.1',
        addressVersion: 'ipv4',
        audio: { port: 9, srtp_key: key, srtp_salt: salt },
        video: { port: 9, srtp_key: key, srtp_salt: salt },
      },
      resolve,
    ),
  )
  const session = source.sessions.s1
  t.after(() => session.stop())
  const sent = []
  session.audioSplitter.send = async (message) => {
    sent.push(message)
  }
  session.listenForAudioPackets({ audio: { sample_rate: 16, packet_time: 20 } })

  const port = await session.transcodedAudioSplitter.portPromise,
    socket = createSocket('udp4')
  t.after(() => socket.close())
  const rtp = Buffer.concat([Buffer.from([0x80, 110, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), Buffer.alloc(20)])
  const sendPacket = async (packet) => {
    await new Promise((resolve) => socket.send(packet, port, '127.0.0.1', resolve))
    await settle(50)
  }
  await sendPacket(Buffer.from([0x80, 110, 0, 1]))
  await sendPacket(rtp)
  assert.deepEqual(errors, [], 'nothing reached the unhandled error path')
  assert.equal(sent.length, 1, 'the RTP packet after it still goes to HomeKit')

  // A 1-byte packet already fails in camera-utils' RtpSplitter, before the plugin sees it: the
  // rxjs safety net logs it instead of stopping Homebridge.
  await sendPacket(Buffer.from([0x80]))
  assert.equal(errors.length, 1)
  assert.equal(errors[0]?.code, 'ERR_OUT_OF_RANGE')
})
