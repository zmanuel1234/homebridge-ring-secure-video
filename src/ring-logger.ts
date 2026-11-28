import type { Logging } from 'homebridge'

/**
 * Video session messages Ring sends that ring-client-api 14.3.0 doesn't list, so it logs each as
 * an "UNKNOWN MESSAGE" error followed by the message. camera_options is Ring confirming the
 * stealth_mode setting the library sends when a session starts: harmless, so debug only.
 */
const HARMLESS_SESSION_MESSAGES = new Set(['camera_options'])

interface SessionMessage {
  method: string
  body?: { stealth_mode?: unknown }
}

function isHarmlessSessionMessage(message: unknown): message is SessionMessage {
  const method = (message as { method?: unknown } | null)?.method
  return typeof method === 'string' && HARMLESS_SESSION_MESSAGES.has(method)
}

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
    // Variadic, as ring-client-api's logInfo is (e.g. "Pruning unused service" with its details).
    logInfo(...message: unknown[]) {
      flushUnknown()
      // As Homebridge's log formats them: the first is usually the text, the rest its details
      log.info(...(message as [string, ...unknown[]]))
    },
    logError(message: unknown) {
      if (message === 'UNKNOWN MESSAGE') {
        flushUnknown()
        unknownPending = true
        return
      }

      if (unknownPending && isHarmlessSessionMessage(message)) {
        unknownPending = false
        // Not the whole message: its session_id is a session token.
        log.debug(
          `Ring video session message ignored: ${message.method} (stealth_mode=${String(message.body?.stealth_mode)})`,
        )
        return
      }

      flushUnknown()
      // Passed through unchanged: Homebridge's log formats an Error or an object itself (with
      // util.format), though its type only names text
      log.error(message as string)
    },
  }
}
