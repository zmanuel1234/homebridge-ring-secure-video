// Run in its own process by the tests: loads the plugin the way Homebridge does (one dynamic
// import of its entry) and reports which @eneris/push-receiver ring-client-api got.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { encryptedPush } from './push-message.mjs'

await import('../lib/index.js')
const { pushReceiverFix } = await import('../lib/push-receiver-fix.js')

const own = createRequire(fileURLToPath(new URL('../lib/push-receiver-fix.js', import.meta.url)))
const ringEntry = own.resolve('ring-client-api')
const ring = createRequire(ringEntry)
const loaded = await import(pathToFileURL(ring.resolve('@eneris/push-receiver')).href)
const fixed = own('@eneris/push-receiver')
// The logger ring-client-api changed (to quieten connection resets) must be the one 4.3.1 uses.
const fixedLogger = own('@eneris/push-receiver/dist/utils/logger.js')
const { message, keys, payload } = encryptedPush(ring('http_ece'))
let oldVersionFails = false
try {
  // Only the package entry and its logger are replaced, so this is still 4.3.0's own decrypt.
  ring('@eneris/push-receiver/dist/utils/decrypt.js').default(message, keys)
} catch {
  oldVersionFails = true
}
const fixedDecrypt = own('@eneris/push-receiver/dist/utils/decrypt.js').default
console.log(
  JSON.stringify({
    result: pushReceiverFix.result,
    // For a CommonJS package, an import's default is the whole module.exports.
    sameClient: loaded.PushReceiver === fixed.PushReceiver && loaded.default === fixed,
    loggerQuietened: (fixedLogger.default || fixedLogger).error !== console.error,
    oldVersionFails,
    decrypts: JSON.stringify(fixedDecrypt(message, keys)) === JSON.stringify(payload),
  }),
)
