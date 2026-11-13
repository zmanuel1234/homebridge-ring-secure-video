import { hap } from './hap.ts'
import type { RingPlatformConfig } from './config.ts'
import { PushNotificationAction, type RingCamera } from 'ring-client-api'
import { BaseDataAccessory } from './base-data-accessory.ts'
import {
  catchError,
  exhaustMap,
  filter,
  finalize,
  map,
  mergeMap,
  share,
  switchMap,
  throttleTime,
} from 'rxjs/operators'
import { CameraSource } from './camera-source.ts'
import type { PlatformAccessory } from 'homebridge'
import { TargetValueTimer } from './target-value-timer.ts'
import { delay, logError, logInfo } from 'ring-client-api/util'
import { defer, EMPTY, firstValueFrom, from, merge, of, timer } from 'rxjs'
import type { Observable } from 'rxjs'

export const MOTION_WATCHDOG_MS = 30_000
/** How often Ring's event history is checked once its push notifications are known to arrive. */
export const HISTORY_CHECK_WHILE_PUSH_WORKS_MS = 5 * 60_000
/** A push motion this close to a history event's time is taken as that event's notification. */
export const PUSH_MATCH_WINDOW_MS = 90_000
/** After a gap in checking, a history event older than this no longer gives motion. */
export const HISTORY_MOTION_MAX_AGE_MS = 180_000
/** A history event first seen less than this ago may still get its push; judged at a later check. */
const PUSH_GRACE_MS = 30_000
/** Checks in a row that found only pushed events (no misses in between) before push is trusted. */
const MATCHES_TO_TRUST_PUSH = 2
/**
 * Ids no longer in the history are forgotten after this. Ids still in it are kept, however old:
 * on a quiet camera the 10 newest events can be days old, and must not count as new again.
 */
const ID_MEMORY_MS = 60 * 60_000

/**
 * Motion from Ring's event history, for when its push notifications don't arrive.
 *
 * Checking every pollSeconds (20 s by default) costs some 4,300 Ring requests a day per camera,
 * on the same session as everything else. So the history is checked that often only until motion
 * events in it (two in a row) turn out to have come by push too; from then on push is trusted
 * and the history is checked every 5 minutes as a safety net. A motion event no push reported
 * switches back to frequent checks. While checking frequently every new event gives motion; after
 * a gap (5-minute checks, a failure) only events from the last 3 minutes do, as one found later
 * would only record an empty doorway.
 */
export function getHistoryMotionEvents(
  device: Pick<RingCamera, 'name' | 'getEvents' | 'onNewNotification'>,
  pollSeconds: number,
): Observable<boolean> {
  return defer(() => {
    const startedAt = Date.now() - 5000,
      historySeen = new Map<string, number>(),
      // Events that already gave motion from here (a young one is judged again later).
      shownAsMotion = new Map<string, number>(),
      // When an event not judged yet was first seen in the history (by the Pi's clock).
      firstSeen = new Map<string, number>(),
      pushIds = new Map<string, number>(),
      pushMotionTimes: number[] = [],
      baseRetryMs = Math.max(pollSeconds * 1000, 30_000),
      forget = (ids: Map<string, number>, now: number) => {
        for (const [id, at] of ids) {
          if (now - at > ID_MEMORY_MS) ids.delete(id)
        }
      }
    let pushWorks = false,
      matchedInARow = 0,
      lastCheckAt = 0,
      lastSuccessAt = 0,
      failureCount = 0,
      nextCheckAt = 0

    const notifications = device.onNewNotification.subscribe((notification) => {
      if (notification.android_config?.category !== PushNotificationAction.Motion) return
      const id = notification.data?.event?.ding?.id,
        now = Date.now()
      if (id !== undefined) pushIds.set(String(id), now)
      pushMotionTimes.push(now)
      if (pushMotionTimes.length > 50) pushMotionTimes.shift()
    })

    return timer(pollSeconds * 1000, pollSeconds * 1000).pipe(
      exhaustMap(() => {
        const now = Date.now()
        if (now < nextCheckAt) return EMPTY
        if (pushWorks && now - lastCheckAt < HISTORY_CHECK_WHILE_PUSH_WORKS_MS) {
          return EMPTY
        }
        lastCheckAt = now
        // Checked recently and frequently: anything new is recent, whatever the clocks say
        // (a Pi clock ahead of Ring's would otherwise make every event look too old).
        const checkedJustBefore = !pushWorks && now - lastSuccessAt <= pollSeconds * 1000 + 30_000

        return defer(() => device.getEvents({ limit: 10, kind: 'motion' })).pipe(
          mergeMap(({ events }) => {
            const checkedAt = Date.now()
            failureCount = 0
            nextCheckAt = 0
            lastSuccessAt = checkedAt
            // Still in the history: remembered as long as it stays there.
            for (const event of events) {
              const id = event.ding_id_str || String(event.ding_id)
              for (const ids of [historySeen, shownAsMotion, firstSeen, pushIds]) {
                if (ids.has(id) && ids !== firstSeen) ids.set(id, checkedAt)
              }
            }
            forget(historySeen, checkedAt)
            forget(shownAsMotion, checkedAt)
            forget(firstSeen, checkedAt)
            forget(pushIds, checkedAt)

            const isPushed = (event: (typeof events)[number]) => {
              const id = event.ding_id_str || String(event.ding_id),
                at = Date.parse(event.created_at)
              return (
                pushIds.has(id) ||
                pushMotionTimes.some((t) => Math.abs(t - at) <= PUSH_MATCH_WINDOW_MS)
              )
            }
            const newEvents = events.filter((event) => {
              const id = event.ding_id_str || String(event.ding_id)
              return (
                event.kind === 'motion' &&
                Date.parse(event.created_at) >= startedAt &&
                !historySeen.has(id)
              )
            })
            // Too young to know whether its push is still coming: judged at a later check, but
            // it can still give motion now (once). Young by when it was first seen here, so a
            // Pi clock behind Ring's doesn't keep it young.
            const young = (event: (typeof events)[number]) => {
              const id = event.ding_id_str || String(event.ding_id)
              if (!firstSeen.has(id)) firstSeen.set(id, checkedAt)
              return !isPushed(event) && checkedAt - (firstSeen.get(id) ?? checkedAt) < PUSH_GRACE_MS
            }
            const judged = newEvents.filter((event) => !young(event)),
              missed = judged.filter((event) => !isPushed(event))
            judged.forEach((event) => {
              const id = event.ding_id_str || String(event.ding_id)
              historySeen.set(id, checkedAt)
              firstSeen.delete(id)
            })
            if (pushWorks && judged.length < newEvents.length) {
              // An event to judge soon: check again shortly rather than in 5 minutes.
              lastCheckAt = checkedAt - HISTORY_CHECK_WHILE_PUSH_WORKS_MS + PUSH_GRACE_MS + 10_000
            }

            if (missed.length) {
              matchedInARow = 0
              if (pushWorks) {
                pushWorks = false
                logInfo(
                  `${device.name}: Ring event history shows motion no push notification reported; checking it every ${pollSeconds} s again`,
                )
              }
            } else if (judged.length) {
              // One per check: a single push can match several events.
              matchedInARow += 1
              if (!pushWorks && matchedInARow >= MATCHES_TO_TRUST_PUSH) {
                pushWorks = true
                logInfo(
                  `${device.name}: Ring push notifications are arriving; checking Ring event history every ${HISTORY_CHECK_WHILE_PUSH_WORKS_MS / 60_000} minutes instead of every ${pollSeconds} s`,
                )
              }
            }

            const unpushedNow = newEvents.filter((event) => !isPushed(event)),
              givesMotion = unpushedNow.some(
                (event) =>
                  !shownAsMotion.has(event.ding_id_str || String(event.ding_id)) &&
                  (checkedJustBefore ||
                    checkedAt - Date.parse(event.created_at) <= HISTORY_MOTION_MAX_AGE_MS),
              )
            unpushedNow.forEach((event) =>
              shownAsMotion.set(event.ding_id_str || String(event.ding_id), checkedAt),
            )
            if (!givesMotion) return EMPTY

            logInfo(`${device.name} Detected Motion from Ring event history fallback`)
            return of(true)
          }),
          catchError(() => {
            failureCount++
            const retryDelayMs = Math.min(
              5 * 60 * 1000,
              baseRetryMs * 2 ** Math.min(failureCount - 1, 4),
            )
            nextCheckAt = Date.now() + retryDelayMs
            const nextInMs = pushWorks
              ? Math.max(retryDelayMs, lastCheckAt + HISTORY_CHECK_WHILE_PUSH_WORKS_MS - Date.now())
              : retryDelayMs
            logError(
              `${device.name} failed to poll Ring event history for motion fallback; retrying in ${Math.ceil(nextInMs / 1000)} seconds`,
            )
            return EMPTY
          }),
        )
      }),
      finalize(() => notifications.unsubscribe()),
    )
  })
}

/**
 * Motion from Ring's push notifications, as HomeKit needs it: true for every new motion alert.
 *
 * ring-client-api's onMotionDetected is true while any motion alert is active (each lasts 65 s)
 * and only reports changes, so a new alert while an earlier one is still active gives nothing.
 * The watchdog below turns motion off after 30 s, so a second visit 30-65 s after the first
 * would never turn it on again: no recording and no notification. So every new motion
 * notification gives a true (restarting the watchdog), and onMotionDetected only adds its
 * false once all alerts have expired. A notification repeating an alert seen in the last two
 * minutes (Ring sends a second one with the snapshot; a reconnect can resend) is not a new visit.
 */
export const REPEATED_ALERT_WINDOW_MS = 120_000

export function getPushMotionEvents(
  camera: Pick<RingCamera, 'onMotionDetected' | 'onNewNotification'>,
): Observable<boolean> {
  return defer(() => {
    const seenAt = new Map<string, number>()
    return merge(
      camera.onMotionDetected.pipe(filter((motion) => !motion)),
      camera.onNewNotification.pipe(
        filter((notification) => {
          if (notification.android_config?.category !== PushNotificationAction.Motion) {
            return false
          }
          const now = Date.now(),
            id = notification.data?.event?.ding?.id
          for (const [seenId, at] of seenAt) {
            if (now - at > REPEATED_ALERT_WINDOW_MS) seenAt.delete(seenId)
          }
          if (id === undefined) return true
          if (seenAt.has(String(id))) return false
          seenAt.set(String(id), now)
          return true
        }),
        map(() => true),
      ),
    )
  })
}

export function addMotionWatchdog(
  motionEvents: Observable<boolean>,
  watchdogMs = MOTION_WATCHDOG_MS,
): Observable<boolean> {
  return motionEvents.pipe(
    switchMap((motion) => {
      if (!motion) {
        return of(false)
      }

      return merge(
        of(true),
        timer(watchdogMs).pipe(map(() => false)),
      )
    }),
  )
}

export class Camera extends BaseDataAccessory<RingCamera> {
  private inHomeDoorbellStatus: boolean | undefined
  private cameraSource

  public readonly device
  public readonly accessory
  public readonly config
  public readonly motionDetected?: Observable<boolean>

  constructor(
    device: RingCamera,
    accessory: PlatformAccessory,
    config: RingPlatformConfig,
  ) {
    super()

    this.device = device
    this.accessory = accessory
    this.config = config
    this.cameraSource = new CameraSource(this.device, this.config)

    if (!hap.CameraController) {
      const error =
        'HAP CameraController not found.  Please make sure you are on homebridge version 1.0.0 or newer'
      logError(error)
      throw new Error(error)
    }

    const { Characteristic, Service } = hap,
      { ChargingState, StatusLowBattery } = Characteristic

    accessory.configureController(this.cameraSource.controller)

    this.registerCharacteristic({
      characteristicType: Characteristic.Mute,
      serviceType: Service.Microphone,
      getValue: () => false,
    })

    this.registerCharacteristic({
      characteristicType: Characteristic.Mute,
      serviceType: Service.Speaker,
      getValue: () => false,
    })

    // One motion source, shared by the camera's motion sensor and the optional
    // notification sensor, so Ring's event history isn't polled twice.
    if (!config.hideCameraMotionSensor || config.cameraMotionNotificationSensor) {
      this.motionDetected = this.getMotionDetectedObservable().pipe(share())
    }

    if (!config.hideCameraMotionSensor && this.motionDetected) {
      this.registerObservableCharacteristic({
        characteristicType: Characteristic.MotionDetected,
        serviceType: Service.MotionSensor,
        onValue: this.motionDetected.pipe(
          switchMap((motion) => {
            if (!motion) {
              return Promise.resolve(false)
            }

            return this.loadSnapshotForEvent('Detected Motion', true)
          }),
        ),
      })
    }

    if (device.isDoorbot) {
      this.registerObservableCharacteristic({
        characteristicType: Characteristic.ProgrammableSwitchEvent,
        serviceType: Service.Doorbell,
        onValue: device.onDoorbellPressed.pipe(
          throttleTime(15000),
          switchMap(() => {
            return this.loadSnapshotForEvent(
              'Doorbell Pressed',
              Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
            )
          }),
        ),
      })

      if (!config.hideDoorbellSwitch) {
        this.registerObservableCharacteristic({
          characteristicType: Characteristic.ProgrammableSwitchEvent,
          serviceType: Service.StatelessProgrammableSwitch,
          onValue: device.onDoorbellPressed.pipe(
            map(() => Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS),
          ),
        })

        // Hide long and double press events by setting max value
        this.getService(Service.StatelessProgrammableSwitch)
          .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
          .setProps({
            maxValue: Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
          })
      }
    }

    if (device.hasLight && !config.hideCameraLight) {
      const lightTargetTimer = new TargetValueTimer<boolean>()
      this.registerCharacteristic({
        characteristicType: Characteristic.On,
        serviceType: Service.Lightbulb,
        getValue: (data) => {
          const value = lightTargetTimer.hasTarget()
            ? lightTargetTimer.getTarget()
            : data.led_status === 'on'

          return value
        },
        setValue: (value: boolean) => {
          // Allow 30 seconds for the light value to update in our status updates from Ring
          lightTargetTimer.setTarget(value, 30000)
          return device.setLight(value)
        },
        requestUpdate: () => device.requestUpdate(),
      })
    }

    if (device.hasSiren && !config.hideCameraSirenSwitch) {
      this.registerCharacteristic({
        characteristicType: Characteristic.On,
        serviceType: Service.Switch,
        serviceSubType: 'Siren',
        name: device.name + ' Siren',
        getValue: (data) => {
          return Boolean(
            data.siren_status && data.siren_status.seconds_remaining,
          )
        },
        setValue: (value) => device.setSiren(value),
        requestUpdate: () => device.requestUpdate(),
      })
    }

    if (device.hasInHomeDoorbell && !config.hideInHomeDoorbellSwitch) {
      this.device.onInHomeDoorbellStatus.subscribe(
        (data: boolean | undefined) => {
          this.inHomeDoorbellStatus = data
        },
      )
      this.registerObservableCharacteristic({
        characteristicType: Characteristic.On,
        serviceType: Service.Switch,
        serviceSubType: 'In-Home Doorbell',
        name: device.name + ' In-Home Doorbell',
        onValue: device.onInHomeDoorbellStatus,
        setValue: (value) => device.setInHomeDoorbell(value),
        requestUpdate: () => device.requestUpdate(),
      })
    }

    this.registerCharacteristic({
      characteristicType: Characteristic.Manufacturer,
      serviceType: Service.AccessoryInformation,
      getValue: (data) => {
        if ('metadata' in data && 'third_party_manufacturer' in data.metadata) {
          return data.metadata.third_party_manufacturer
        }
        return 'Ring'
      },
    })
    this.registerCharacteristic({
      characteristicType: Characteristic.Model,
      serviceType: Service.AccessoryInformation,
      getValue: (data) => {
        if ('metadata' in data && 'third_party_model' in data.metadata) {
          return data.metadata.third_party_model
        }
        return `${device.model} (${data.kind})`
      },
    })
    this.registerCharacteristic({
      characteristicType: Characteristic.SerialNumber,
      serviceType: Service.AccessoryInformation,
      getValue: (data) => data.device_id,
    })

    if (device.hasBattery) {
      this.registerCharacteristic({
        characteristicType: Characteristic.StatusLowBattery,
        serviceType: Service.Battery,
        getValue: () => {
          return device.hasLowBattery
            ? StatusLowBattery.BATTERY_LEVEL_LOW
            : StatusLowBattery.BATTERY_LEVEL_NORMAL
        },
      })

      this.registerCharacteristic({
        characteristicType: Characteristic.ChargingState,
        serviceType: Service.Battery,
        getValue: () => {
          return device.isCharging
            ? ChargingState.CHARGING
            : ChargingState.NOT_CHARGING
        },
      })

      this.registerObservableCharacteristic({
        characteristicType: Characteristic.BatteryLevel,
        serviceType: Service.Battery,
        onValue: device.onBatteryLevel.pipe(
          map((batteryLevel) => {
            return batteryLevel === null ? 100 : batteryLevel
          }),
        ),
      })
    }
  }

  private getMotionDetectedObservable(): Observable<boolean> {
    const pushMotionEvents = getPushMotionEvents(this.device)

    if (this.config.enableCameraMotionHistory === false) {
      return addMotionWatchdog(pushMotionEvents)
    }

    const pollSeconds = Math.max(this.config.cameraStatusPollingSeconds ?? 20, 10)
    return addMotionWatchdog(
      merge(pushMotionEvents, getHistoryMotionEvents(this.device, pollSeconds)),
    )
  }

  private async loadSnapshotForEvent<T>(
    eventDescription: string,
    characteristicValue: T,
  ) {
    let imageUuid = this.device.latestNotificationSnapshotUuid

    /**
     * Battery cameras may receive an initial notification with no image uuid,
     * followed shortly by a second notification with the image uuid. We need to
     * wait for the second notification before we can load the snapshot.
     */
    if (!this.device.canTakeSnapshotWhileRecording && !imageUuid) {
      await Promise.race([
        firstValueFrom(
          this.device.onNewNotification.pipe(
            filter((notification) => Boolean(notification.img?.snapshot_uuid)),
          ),
        ),
        // wait up to 2 seconds for the second notification
        delay(2000),
      ])
      imageUuid = this.device.latestNotificationSnapshotUuid

      if (!imageUuid) {
        // did not receive an image uuid and one can't be taken while recording. Proceed without a snapshot
        logInfo(this.device.name + ' ' + eventDescription)
        return characteristicValue
      }
    }

    logInfo(
      this.device.name +
        ` ${eventDescription}. Loading snapshot before sending event to HomeKit`,
    )

    try {
      await this.cameraSource.loadSnapshot(imageUuid)
    } catch {
      logInfo(
        this.device.name +
          ' Failed to load snapshot.  Sending event to HomeKit without new snapshot',
      )
    }

    return characteristicValue
  }
}
