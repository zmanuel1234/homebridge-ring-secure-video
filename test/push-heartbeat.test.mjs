import assert from 'node:assert/strict'
import test from 'node:test'
import { PUSH_HEARTBEAT_INTERVAL_MS, withPushHeartbeat } from '../lib/push-receiver-fix.js'

// A stand-in for push-receiver's PushReceiver that keeps the config it was given.
class FakePushReceiver {
  constructor(config) {
    this.config = config
  }
}

test('the push client checks its connection every 60 s unless told otherwise', () => {
  const PushReceiver = withPushHeartbeat(FakePushReceiver)
  // as ring-client-api 14.3.0 creates it: no heartbeat given
  const receiver = new PushReceiver({ credentials: { fcm: {} }, debug: false })
  assert.equal(PUSH_HEARTBEAT_INTERVAL_MS, 60_000)
  assert.deepEqual(receiver.config, {
    heartbeatIntervalMs: 60_000,
    credentials: { fcm: {} },
    debug: false,
  })
  assert.ok(receiver instanceof FakePushReceiver)

  // a heartbeat ring-client-api sets itself (as upstream's #1810 does) is kept
  assert.equal(new PushReceiver({ heartbeatIntervalMs: 30_000 }).config.heartbeatIntervalMs, 30_000)
  // left out explicitly, it is still 60 s (push-receiver would otherwise send none at all)
  assert.equal(new PushReceiver({ heartbeatIntervalMs: undefined }).config.heartbeatIntervalMs, 60_000)
})
