import { createRequire } from 'node:module'

/**
 * ring-client-api 14.3.0 pins @eneris/push-receiver 4.3.0. That version reads the FCM
 * "crypto-key" and "encryption" headers by fixed position, which no longer matches the
 * header format Google sends ("dh=...; p256ecdsa=..."), so every Ring push fails to decrypt
 * and is dropped: no instant motion or doorbell events. 4.3.1 parses the headers properly.
 *
 * npm can't replace a pinned dependency of a dependency for the people who install this
 * plugin (package.json "overrides" only apply to the project being developed), so this plugin
 * depends on 4.3.1 itself and gives the 4.3.0 copy that ring-client-api loads the 4.3.1
 * decrypt function. Only the exact version 4.3.0 is changed; with any other version (for
 * example once ring-client-api moves on) this does nothing.
 */
export type PushReceiverFixResult = 'applied' | 'not-needed' | 'failed'

const decryptPath = '@eneris/push-receiver/dist/utils/decrypt.js'

export function applyPushReceiverDecryptFix(): {
  result: PushReceiverFixResult
  detail: string
} {
  try {
    const ownRequire = createRequire(import.meta.url),
      ringRequire = createRequire(ownRequire.resolve('ring-client-api')),
      loadedVersion: string = ringRequire('@eneris/push-receiver/package.json').version

    if (loadedVersion !== '4.3.0') {
      return {
        result: 'not-needed',
        detail: `ring-client-api uses @eneris/push-receiver ${loadedVersion}`,
      }
    }

    const fixedVersion: string = ownRequire('@eneris/push-receiver/package.json').version
    if (fixedVersion === loadedVersion) {
      return {
        result: 'failed',
        detail: `only @eneris/push-receiver ${loadedVersion} is installed; reinstall the plugin`,
      }
    }

    const loaded = ringRequire(decryptPath) as { default: unknown },
      fixed = ownRequire(decryptPath) as { default: unknown }
    if (typeof loaded.default !== 'function' || typeof fixed.default !== 'function') {
      return { result: 'failed', detail: 'unexpected @eneris/push-receiver layout' }
    }

    // push-receiver's client looks this function up on every message, so replacing the
    // export also covers a client that is already running.
    loaded.default = fixed.default
    return {
      result: 'applied',
      detail: `ring-client-api's @eneris/push-receiver ${loadedVersion} now decrypts with ${fixedVersion}`,
    }
  } catch (e) {
    return { result: 'failed', detail: (e as Error).message }
  }
}
