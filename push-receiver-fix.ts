import Module, { createRequire } from 'node:module'

/**
 * ring-client-api 14.3.0 pins @eneris/push-receiver 4.3.0. That version reads the FCM
 * "crypto-key" and "encryption" headers by fixed position, which no longer matches the
 * header format Google sends ("dh=...; p256ecdsa=..."), so every Ring push fails to decrypt
 * and is dropped: no instant motion or doorbell events. 4.3.1 parses the headers properly
 * (and has a few other fixes).
 *
 * npm can't replace a pinned dependency of a dependency for the people who install this
 * plugin (package.json "overrides" only apply to the project being developed), so this plugin
 * depends on 4.3.1 itself and makes ring-client-api load it: before ring-client-api is
 * loaded, 4.3.1 is put into Node's module cache under the file name of ring-client-api's
 * 4.3.0, and Node then hands ring-client-api the cached 4.3.1. ring-client-api also imports
 * the package's logger directly (to quieten its connection-reset errors), so 4.3.1's logger is
 * put in place of 4.3.0's the same way. index.ts loads this module before anything that imports
 * ring-client-api, because Node fixes ring-client-api's imports as soon as it reads them.
 *
 * If ring-client-api's copy was already loaded (it can't be replaced any more), only its
 * decrypt function is swapped for 4.3.1's. Only the exact version 4.3.0 is changed; with any
 * other version (for example once ring-client-api moves on) this does nothing.
 */
export type PushReceiverFixResult = 'replaced' | 'decrypt-patched' | 'not-needed' | 'failed'

const decryptPath = '@eneris/push-receiver/dist/utils/decrypt.js'
const loggerPath = '@eneris/push-receiver/dist/utils/logger.js'
const moduleCache = (Module as unknown as { _cache: Record<string, unknown> })._cache

export function applyPushReceiverFix(): {
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

    const fixedVersion: string = ownRequire('@eneris/push-receiver/package.json').version,
      target = ringRequire.resolve('@eneris/push-receiver'),
      fixed = ownRequire.resolve('@eneris/push-receiver')
    if (fixedVersion === loadedVersion || target === fixed) {
      return {
        result: 'failed',
        detail: `only @eneris/push-receiver ${loadedVersion} is installed; reinstall the plugin`,
      }
    }

    const targetLogger = ringRequire.resolve(loggerPath)
    if (!moduleCache[target] && !moduleCache[targetLogger]) {
      ownRequire(fixed)
      ownRequire(loggerPath)
      moduleCache[target] = moduleCache[fixed]
      moduleCache[targetLogger] = moduleCache[ownRequire.resolve(loggerPath)]
      return {
        result: 'replaced',
        detail: `ring-client-api loads @eneris/push-receiver ${fixedVersion} instead of ${loadedVersion}`,
      }
    }

    // ring-client-api's copy is already loaded: swap in the fixed decrypt function. The push
    // client looks it up on every message, so this also covers a client already running.
    const loaded = ringRequire(decryptPath) as { default: unknown },
      fixedDecrypt = ownRequire(decryptPath) as { default: unknown }
    if (typeof loaded.default !== 'function' || typeof fixedDecrypt.default !== 'function') {
      return { result: 'failed', detail: 'unexpected @eneris/push-receiver layout' }
    }
    loaded.default = fixedDecrypt.default
    return {
      result: 'decrypt-patched',
      detail: `ring-client-api's @eneris/push-receiver ${loadedVersion} was already loaded; it now decrypts with ${fixedVersion}`,
    }
  } catch (e) {
    return { result: 'failed', detail: (e as Error).message }
  }
}

// Runs when this module is first imported, before ring-client-api is loaded.
export const pushReceiverFix = applyPushReceiverFix()
