import { createECDH, randomBytes } from 'node:crypto'

// A Ring push encrypted the way FCM sends it today: "dh=...; p256ecdsa=..." and "salt=...".
export function encryptedPush(ece) {
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
  return { message, keys, payload }
}
