// Run in its own process by the tests: loads the plugin the way Homebridge does (one dynamic
// import of its entry) and reports the PushReceiver ring-client-api got.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { encryptedPush } from './push-message.mjs'

await import('../lib/index.js')
const { pushReceiverFix } = await import('../lib/push-receiver-fix.js')

const own = createRequire(fileURLToPath(new URL('../lib/push-receiver-fix.js', import.meta.url)))
const ring = createRequire(own.resolve('ring-client-api'))
// the module ring-client-api's `import { PushReceiver } from '@eneris/push-receiver'` gets
const loaded = await import(pathToFileURL(ring.resolve('@eneris/push-receiver')).href)
const { message, keys, payload } = encryptedPush(ring('http_ece'))
console.log(
  JSON.stringify({
    result: pushReceiverFix.result,
    version: ring('@eneris/push-receiver/package.json').version,
    heartbeatIntervalMs: loaded.PushReceiver.heartbeatIntervalMs,
    heartbeatClass: loaded.PushReceiver.name,
    // Google's current header format, which push-receiver 4.3.0 couldn't decrypt
    decrypts:
      JSON.stringify(ring('@eneris/push-receiver/dist/utils/decrypt.js').default(message, keys)) ===
      JSON.stringify(payload),
  }),
)
