import { readFileSync } from 'fs'
import { performance } from 'perf_hooks'
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
  recordPush(isMotion: boolean): void
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
  private motionPushSeen = false
  private done = false
  private loggedWaitUntil = 0
  private readonly storagePath
  private readonly refresh
  private readonly now
  private readonly elapsed

  /**
   * now: the clock saved with a refresh (it must survive restarts); elapsed: the clock the
   * misses are timed with, which a clock set by NTP after a boot (a Pi has no clock of its own)
   * can't make jump.
   */
  constructor(
    storagePath: string,
    refresh: () => void,
    now: () => number = Date.now,
    elapsed: () => number = () => performance.now(),
  ) {
    this.storagePath = storagePath
    this.refresh = refresh
    this.now = now
    this.elapsed = elapsed
  }

  /** Any push shows they reach the plugin; only a motion push ends the refresh count. */
  recordPush(isMotion: boolean) {
    this.missTimes = []
    const firstPush = !this.pushSeen,
      firstMotionPush = isMotion && !this.motionPushSeen
    this.pushSeen = true
    this.motionPushSeen ||= isMotion
    if (!firstPush && !firstMotionPush) return
    const state = readPushRecoveryState(this.storagePath),
      update: PushRecoveryState = {}
    // A refresh still waiting for a restart (main bridge) is no longer needed.
    if (firstPush && state.refreshPending) update.refreshPending = false
    if (firstMotionPush && state.refreshesWithoutPush) update.refreshesWithoutPush = 0
    if (!Object.keys(update).length) return
    writePushRecoveryState(this.storagePath, { ...state, ...update })
    if (update.refreshesWithoutPush === 0) {
      logInfo('Ring push notifications arrive again after the automatic Ring session refresh')
    }
  }

  recordMissed(count: number) {
    if (this.done || count < 1) return
    const at = this.elapsed()
    for (let i = 0; i < count; i++) this.missTimes.push(at)
    if (
      this.missTimes.length < MISSES_BEFORE_REFRESH ||
      at - this.missTimes[0] < MISS_SPAN_BEFORE_REFRESH_MS
    ) {
      return
    }
    const now = this.now()

    const state = readPushRecoveryState(this.storagePath),
      refreshes = state.refreshesWithoutPush ?? 0
    if (refreshes >= MAX_REFRESHES_WITHOUT_PUSH) {
      this.done = true
      logError(
        `Ring still sends no push notifications after ${refreshes} automatic Ring session refreshes; not trying again until one arrives. Check that mtalk.google.com resolves and port 5228 is open, and remove old homebridge-ring-secure-video entries from Authorized Client Devices in the Ring app (see the README, Troubleshooting).`,
      )
      return
    }
    // A refresh saved by a clock that was ahead (before NTP set it) doesn't hold up the next.
    const lastRefreshAt = (state.lastRefreshAt ?? 0) > now ? 0 : (state.lastRefreshAt ?? 0),
      nextAllowedAt = lastRefreshAt + REFRESH_INTERVAL_MS
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
