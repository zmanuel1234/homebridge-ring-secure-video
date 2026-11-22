import Module, { createRequire } from 'node:module'

/**
 * ring-client-api's push client (@eneris/push-receiver, 4.4.0 with ring-client-api 15) checks
 * its connection to Google's push service with a heartbeat every 5 minutes by default, and
 * ring-client-api keeps that default: with nothing arriving, it pings after 5 minutes and
 * reconnects after 10, so a connection a home router dropped silently stays dead that long
 * (dgreif/ring#1810). This makes the PushReceiver ring-client-api creates default to a heartbeat
 * every PUSH_HEARTBEAT_INTERVAL_MS instead.
 *
 * ring-client-api imports { PushReceiver } from the package (CommonJS). Before ring-client-api
 * is loaded, this loads that same package into Node's module cache and replaces its exported
 * PushReceiver with a subclass; Node then hands ring-client-api the cached exports. index.ts
 * loads this module before anything that imports ring-client-api, because Node fixes
 * ring-client-api's imports as soon as it reads them.
 *
 * (Up to 1.0.8, with ring-client-api 14.3.0 and its push-receiver 4.3.0, this also replaced the
 * package with 4.3.1, which decrypts Google's current push format; 4.4.0 already does.)
 */
export type PushReceiverFixResult = 'heartbeat' | 'already-loaded' | 'failed'

/**
 * How often the push client checks its connection to Google's push service when nothing else
 * arrives: it sends a heartbeat after this long without data, and reconnects after twice this
 * long.
 */
export const PUSH_HEARTBEAT_INTERVAL_MS = 60_000

type PushReceiverClass = new (...args: any[]) => object

/** A PushReceiver that sends heartbeats every PUSH_HEARTBEAT_INTERVAL_MS unless told otherwise. */
export function withPushHeartbeat<T extends PushReceiverClass>(PushReceiver: T): T {
  return class PushReceiverWithHeartbeat extends PushReceiver {
    static heartbeatIntervalMs = PUSH_HEARTBEAT_INTERVAL_MS

    constructor(...[config]: any[]) {
      super({
        ...config,
        heartbeatIntervalMs: config?.heartbeatIntervalMs ?? PUSH_HEARTBEAT_INTERVAL_MS,
      })
    }
  }
}

const moduleCache = (Module as unknown as { _cache: Record<string, unknown> })._cache

export function applyPushReceiverFix(): {
  result: PushReceiverFixResult
  detail: string
} {
  try {
    const ownRequire = createRequire(import.meta.url),
      ringRequire = createRequire(ownRequire.resolve('ring-client-api')),
      version: string = ringRequire('@eneris/push-receiver/package.json').version,
      target = ringRequire.resolve('@eneris/push-receiver')

    if (moduleCache[target]) {
      // ring-client-api may already hold the original class
      return {
        result: 'already-loaded',
        detail: `ring-client-api's @eneris/push-receiver ${version} was already loaded; it keeps its default heartbeat`,
      }
    }

    // ring-client-api imports { PushReceiver }; the package's own default export is the same
    // class, so both become the subclass
    const exports = ringRequire(target) as { PushReceiver?: unknown; default?: unknown }
    if (typeof exports.PushReceiver !== 'function') {
      return { result: 'failed', detail: 'unexpected @eneris/push-receiver layout' }
    }
    exports.PushReceiver = withPushHeartbeat(exports.PushReceiver as PushReceiverClass)
    exports.default = exports.PushReceiver
    return {
      result: 'heartbeat',
      detail: `@eneris/push-receiver ${version} checks its connection every ${PUSH_HEARTBEAT_INTERVAL_MS / 1000} s`,
    }
  } catch (e) {
    return { result: 'failed', detail: (e as Error).message }
  }
}

// Runs when this module is first imported, before ring-client-api is loaded.
export const pushReceiverFix = applyPushReceiverFix()
