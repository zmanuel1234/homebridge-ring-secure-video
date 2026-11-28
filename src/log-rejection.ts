import { logError } from 'ring-client-api/util'

/**
 * Wraps an async handler for a caller that ignores what it returns (HomeKit characteristic
 * events): a rejection is logged instead of becoming an unhandled rejection.
 */
export function logRejection<A extends unknown[]>(
  what: string,
  handler: (...args: A) => Promise<unknown>,
): (...args: A) => void {
  return (...args) => {
    handler(...args).catch((e: unknown) => {
      logError(what)
      logError(e)
    })
  }
}
