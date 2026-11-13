import { readFileSync } from 'fs'
import { join } from 'path'
import { logError, logInfo } from 'ring-client-api/util'
import { writeFileAtomic } from './config.ts'

const stateFileName = '.ring-secure-video-push.json'
/** Motion events in Ring's history with no push notification, since the last push... */
export const MISSES_BEFORE_REFRESH = 3
/** ...spread over at least this long (one visit can make several events)... */
export const MISS_SPAN_BEFORE_REFRESH_MS = 30 * 60_000
/** ...give an automatic session refresh, at most once in this long... */
export const REFRESH_INTERVAL_MS = 24 * 60 * 60_000
/** ...and no more after this many in a row that brought no push. */
export const MAX_REFRESHES_WITHOUT_PUSH = 2

export interface PushRecoveryState {
  /** A session refresh is to be done at the next start (cleared once the new token is saved). */
  refreshPending?: boolean
  lastRefreshAt?: number
  /** Automatic refreshes since the last push notification. */
  refreshesWithoutPush?: number
}

export function readPushRecoveryState(storagePath: string): PushRecoveryState {
  try {
    const state = JSON.parse(readFileSync(join(storagePath, stateFileName)).toString())
    return state && typeof state === 'object' ? state : {}
  } catch {
    return {}
  }
}

export function writePushRecoveryState(storagePath: string, state: PushRecoveryState) {
  try {
    writeFileAtomic(join(storagePath, stateFileName), JSON.stringify(state))
    return true
  } catch (error) {
    logError(`Failed to save ${stateFileName}`)
    logError(error)
    return false
  }
}

/** What a camera reports: every Ring push notification, and history motion that had none. */
export interface PushHealthReporter {
  recordPush(): void
  recordMissed(count: number): void
}

/**
 * Notices when Ring has stopped sending push notifications to the plugin while its event history
 * still shows motion, and then asks for a Ring API session refresh (a new device identity and push
 * registration, as "Force Ring API Session Refresh" does), which is what brings them back.
 *
 * Only when no push at all arrived while the misses piled up: Ring sometimes drops a single
 * notification, and then a refresh would only add an entry to Authorized Client Devices.
 */
export class PushHealthMonitor implements PushHealthReporter {
  private missTimes: number[] = []
  private pushSeen = false
  private done = false
  private loggedWaitUntil = 0
  private readonly storagePath
  private readonly refresh
  private readonly now

  constructor(storagePath: string, refresh: () => void, now: () => number = Date.now) {
    this.storagePath = storagePath
    this.refresh = refresh
    this.now = now
  }

  recordPush() {
    this.missTimes = []
    if (this.pushSeen) return
    this.pushSeen = true
    const state = readPushRecoveryState(this.storagePath)
    if (state.refreshesWithoutPush) {
      writePushRecoveryState(this.storagePath, { ...state, refreshesWithoutPush: 0 })
      logInfo('Ring push notifications arrive again after the automatic Ring session refresh')
    }
  }

  recordMissed(count: number) {
    if (this.done || count < 1) return
    const now = this.now()
    for (let i = 0; i < count; i++) this.missTimes.push(now)
    if (
      this.missTimes.length < MISSES_BEFORE_REFRESH ||
      now - this.missTimes[0] < MISS_SPAN_BEFORE_REFRESH_MS
    ) {
      return
    }

    const state = readPushRecoveryState(this.storagePath),
      refreshes = state.refreshesWithoutPush ?? 0
    if (refreshes >= MAX_REFRESHES_WITHOUT_PUSH) {
      this.done = true
      logError(
        `Ring still sends no push notifications after ${refreshes} automatic Ring session refreshes; not trying again until one arrives. Check that mtalk.google.com resolves and port 5228 is open, and remove old homebridge-ring-secure-video entries from Authorized Client Devices in the Ring app (see the README, Troubleshooting).`,
      )
      return
    }
    const nextAllowedAt = (state.lastRefreshAt ?? 0) + REFRESH_INTERVAL_MS
    if (now < nextAllowedAt) {
      if (this.loggedWaitUntil !== nextAllowedAt) {
        this.loggedWaitUntil = nextAllowedAt
        logInfo(
          `Ring sends no push notifications for motion; the last automatic Ring session refresh was less than a day ago, so the next one is due after ${new Date(nextAllowedAt).toLocaleString()}`,
        )
      }
      return
    }

    this.done = true
    if (
      writePushRecoveryState(this.storagePath, {
        refreshPending: true,
        lastRefreshAt: now,
        refreshesWithoutPush: refreshes + 1,
      })
    ) {
      this.refresh()
    }
  }
}
