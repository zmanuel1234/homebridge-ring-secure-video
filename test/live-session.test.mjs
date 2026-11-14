import assert from 'node:assert/strict'
import test from 'node:test'
import { Subject, Subscription } from 'rxjs'
import * as hapNodejs from '@homebridge/hap-nodejs'
import { useLogger } from 'ring-client-api/util'
import { setHap } from '../lib/hap.js'
import { CameraSource } from '../lib/camera-source.js'

setHap(hapNodejs)
useLogger({ logInfo() {}, logError() {} })

// A live view session from prepareStream, with a fake Ring call (as in talkback.test.mjs).
async function prepare(sessionID = 's1') {
  const callEnded = new Subject()
  let released = 0
  const lease = {
    session: { onCallEnded: callEnded, activateCameraSpeaker() {}, sendAudioPacket() {} },
    subscribeVideo: () => new Subscription(),
    release: () => released++,
  }
  const source = Object.create(CameraSource.prototype)
  source.ringCamera = { name: 'Front Door' }
  source.sessions = {}
  source.mediaIngress = { acquire: async () => lease }
  const forceStopped = []
  source.controller = { forceStopStreamingSession: (id) => forceStopped.push(id) }
  const key = Buffer.alloc(16),
    salt = Buffer.alloc(14)
  await new Promise((resolve) =>
    source.prepareStream(
      {
        sessionID,
        targetAddress: '127.0.0.1',
        sourceAddress: '127.0.0.1',
        addressVersion: 'ipv4',
        audio: { port: 9, srtp_key: key, srtp_salt: salt },
        video: { port: 9, srtp_key: key, srtp_salt: salt },
      },
      resolve,
    ),
  )
  return { source, callEnded, released: () => released, forceStopped }
}

test('a live view that Ring ends leaves the session list, and HomeKit is told', async () => {
  const { source, callEnded, released, forceStopped } = await prepare()
  assert.ok(source.sessions.s1)
  callEnded.next()
  assert.deepEqual(source.sessions, {})
  assert.equal(released(), 1)
  assert.deepEqual(forceStopped, ['s1'])
})

test('a live view HomeKit stops is not reported back to HomeKit', async () => {
  const { source, forceStopped } = await prepare()
  await new Promise((resolve) => source.handleStreamRequest({ sessionID: 's1', type: 'stop' }, resolve))
  assert.deepEqual(forceStopped, [])
})

test("HomeKit's stop after the session stopped by itself is accepted without an error", async () => {
  const { source, callEnded } = await prepare()
  callEnded.next()
  const error = await new Promise((resolve) =>
    source.handleStreamRequest({ sessionID: 's1', type: 'stop' }, resolve),
  )
  assert.equal(error, undefined)
  const startError = await new Promise((resolve) =>
    source.handleStreamRequest({ sessionID: 's1', type: 'start' }, resolve),
  )
  assert.match(String(startError), /Cannot find session/, 'a start for it is still an error')
})

test('a stop from HomeKit removes the session once, as before', async () => {
  const { source, released } = await prepare()
  await new Promise((resolve) => source.handleStreamRequest({ sessionID: 's1', type: 'stop' }, resolve))
  assert.deepEqual(source.sessions, {})
  assert.equal(released(), 1)
})

test('a stopped session does not remove a newer one with the same id', async () => {
  const { source } = await prepare()
  const old = source.sessions.s1
  const newer = { stop() {} }
  source.sessions.s1 = newer
  old.stop()
  assert.equal(source.sessions.s1, newer)
})

test('a live view that stops while HomeKit starts it is answered with an error, not told twice', async () => {
  const { source, callEnded, forceStopped } = await prepare()
  const session = source.sessions.s1
  session.activate = async () => {
    callEnded.next() // Ring ends the call while the start request is handled
  }
  const error = await new Promise((resolve) =>
    source.handleStreamRequest({ sessionID: 's1', type: 'start' }, resolve),
  )
  assert.match(String(error), /ended while starting/)
  assert.deepEqual(forceStopped, [], 'the error answer tells HomeKit')
  assert.deepEqual(source.sessions, {})
})

test('a live view HomeKit stops while starting it is answered OK, so HomeKit closes it once', async () => {
  const { source, forceStopped } = await prepare()
  const session = source.sessions.s1
  session.activate = async () => {
    // HomeKit's stop arrives while the start is handled
    await new Promise((resolve) => source.handleStreamRequest({ sessionID: 's1', type: 'stop' }, resolve))
  }
  const error = await new Promise((resolve) =>
    source.handleStreamRequest({ sessionID: 's1', type: 'start' }, resolve),
  )
  assert.equal(error, undefined)
  assert.deepEqual(forceStopped, [])
  assert.deepEqual(source.sessions, {})
})
