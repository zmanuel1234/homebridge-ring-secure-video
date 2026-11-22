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
 * The PushReceiver ring-client-api gets also checks its connection every 60 s instead of every
 * 5 minutes (see withPushHeartbeat).
 *
 * If ring-client-api's copy was already loaded (it can't be replaced any more), only its
 * decrypt function is swapped for 4.3.1's. Only the exact version 4.3.0 is changed; with any
 * other version (for example once ring-client-api moves on) this does nothing.
 */
export type PushReceiverFixResult = 'replaced' | 'decrypt-patched' | 'not-needed' | 'failed'

/**
 * How often the push client checks its connection to Google's push service when nothing else
 * arrives: it sends a heartbeat after this long without data, and reconnects after twice this
 * long. push-receiver's default is 5 minutes (so 10 before reconnecting), and ring-client-api
 * keeps it; a connection a home router dropped silently could then go unnoticed for that long,
 * or much longer if the system's TCP keepalive (2 hours on Linux) is all that notices
 * (dgreif/ring#1810).
 */
export const PUSH_HEARTBEAT_INTERVAL_MS = 60_000

type PushReceiverClass = new (...args: any[]) => object

/** A PushReceiver that sends heartbeats every PUSH_HEARTBEAT_INTERVAL_MS unless told otherwise. */
export function withPushHeartbeat<T extends PushReceiverClass>(PushReceiver: T): T {
  return class PushReceiverWithHeartbeat extends PushReceiver {
    static heartbeatIntervalMs = PUSH_HEARTBEAT_INTERVAL_MS

    constructor(...[config]: any[]) {
      super({ heartbeatIntervalMs: PUSH_HEARTBEAT_INTERVAL_MS, ...config })
    }
  }
}

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
      // ring-client-api imports { PushReceiver }; the package's own default export is the same
      // class, so both become the subclass
      const fixedExports = ownRequire(fixed) as { PushReceiver: PushReceiverClass; default: unknown }
      fixedExports.PushReceiver = withPushHeartbeat(fixedExports.PushReceiver)
      fixedExports.default = fixedExports.PushReceiver
      ownRequire(loggerPath)
      moduleCache[target] = moduleCache[fixed]
      moduleCache[targetLogger] = moduleCache[ownRequire.resolve(loggerPath)]
      return {
        result: 'replaced',
        detail: `ring-client-api loads @eneris/push-receiver ${fixedVersion} instead of ${loadedVersion}, checking its connection every ${PUSH_HEARTBEAT_INTERVAL_MS / 1000} s`,
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
