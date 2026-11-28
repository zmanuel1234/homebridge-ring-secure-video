/** `e` as an Error, for callbacks and APIs that need one (anything thrown can be caught). */
export function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}
