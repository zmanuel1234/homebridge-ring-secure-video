import type { Logging } from 'homebridge'

/**
 * Video session messages Ring sends that ring-client-api 14.3.0 doesn't list, so it logs each as
 * an "UNKNOWN MESSAGE" error followed by the message. camera_options is Ring confirming the
 * stealth_mode setting the library sends when a session starts: harmless, so debug only.
 */
const HARMLESS_SESSION_MESSAGES = new Set(['camera_options'])

/** The logger ring-client-api uses, writing to the Homebridge log. */
export function createRingLogger(log: Pick<Logging, 'info' | 'error' | 'debug'>) {
  // ring-client-api logs "UNKNOWN MESSAGE" and then, right after, the message itself.
  let unknownPending = false

  const flushUnknown = () => {
    if (unknownPending) {
      unknownPending = false
      log.error('UNKNOWN MESSAGE')
    }
  }

  return {
    logInfo(message: any) {
      flushUnknown()
      log.info(message)
    },
    logError(message: any) {
      if (message === 'UNKNOWN MESSAGE') {
        flushUnknown()
        unknownPending = true
        return
      }

      if (unknownPending && HARMLESS_SESSION_MESSAGES.has(message?.method)) {
        unknownPending = false
        log.debug(`Ring video session message ignored: ${message.method}`)
        return
      }

      flushUnknown()
      log.error(message)
    },
  }
}
