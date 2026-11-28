// Run in its own process by the tests: loads the plugin the way Homebridge does (one dynamic
// import of its entry) and reports the PushReceiver ring-client-api got.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type * as PushReceiverFixModule from '../src/push-receiver-fix.js'
import { encryptedPush, type Ece } from './push-message.js'

// The built plugin (typed as its sources), as Homebridge loads it.
await import(new URL('../dist/index.js', import.meta.url).href)
const { pushReceiverFix } = (await import(new URL('../dist/push-receiver-fix.js', import.meta.url).href)) as typeof PushReceiverFixModule

const own = createRequire(fileURLToPath(new URL('../dist/push-receiver-fix.js', import.meta.url)))
const ring = createRequire(own.resolve('ring-client-api'))
// the module ring-client-api's `import { PushReceiver } from '@eneris/push-receiver'` gets
const loaded = (await import(pathToFileURL(ring.resolve('@eneris/push-receiver')).href)) as {
  PushReceiver: { heartbeatIntervalMs?: number; name: string }
}
const { message, keys, payload } = encryptedPush(ring('http_ece') as Ece)
const decrypt = (ring('@eneris/push-receiver/dist/utils/decrypt.js') as { default: (message: unknown, keys: unknown) => unknown }).default
process.stdout.write(
  `${JSON.stringify({
    result: pushReceiverFix.result,
    version: (ring('@eneris/push-receiver/package.json') as { version: string }).version,
    heartbeatIntervalMs: loaded.PushReceiver.heartbeatIntervalMs,
    heartbeatClass: loaded.PushReceiver.name,
    // Google's current header format, which push-receiver 4.3.0 couldn't decrypt
    decrypts: JSON.stringify(decrypt(message, keys)) === JSON.stringify(payload),
  })}\n`,
)
