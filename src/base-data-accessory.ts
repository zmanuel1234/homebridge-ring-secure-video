import type { CharacteristicType, ServiceType } from './base-accessory.js'
import { BaseAccessory } from './base-accessory.js'
import type { Observable } from 'rxjs'
import { merge, Subject } from 'rxjs'
import type {
  RingCamera,
  RingChime,
  RingDevice,
  RingIntercom,
} from 'ring-client-api'
import type { RingPlatformConfig } from './config.js'
import { debounceTime, distinctUntilChanged, filter, map } from 'rxjs/operators'
import type {
  PlatformAccessory,
  CharacteristicValue,
  CharacteristicSetCallback,
  CharacteristicGetCallback,
} from 'homebridge'
import { CharacteristicEventTypes } from 'homebridge'
import { logError } from 'ring-client-api/util'
import { toError } from './errors.js'

// How long a value set from HomeKit (not debounced) is shown at most, unless Ring reports it
// sooner, before Ring's reports count again
export const SET_VALUE_SHOWN_MS = 10_000
// How long a level set from HomeKit is shown while waiting for Ring to report it
export const LEVEL_TARGET_TIMEOUT_MS = 30_000

export abstract class BaseDataAccessory<
  T extends RingDevice | RingCamera | RingChime | RingIntercom,
> extends BaseAccessory<T> {
  abstract override readonly device: T
  abstract override readonly accessory: PlatformAccessory
  abstract override readonly config: RingPlatformConfig

  /**
   * `V` is the characteristic's value type, from `getValue` (boolean for On, number for states
   * and levels, string for names): `setValue` gets HomeKit's writes as that type.
   */
  registerCharacteristic<V extends CharacteristicValue>({
    characteristicType,
    serviceType,
    getValue,
    setValue,
    setValueDebounceTime = 0,
    trackSetValue = true,
    name,
    requestUpdate,
    serviceSubType,
  }: {
    characteristicType: CharacteristicType
    serviceType: ServiceType
    serviceSubType?: string
    name?: string
    /** undefined: Ring didn't report it; HomeKit keeps the last value (it can't show undefined). */
    getValue: (data: T['data']) => V | undefined
    setValue?: (value: V) => unknown
    setValueDebounceTime?: number
    /**
     * Whether a value set from HomeKit counts as the one shown, so that Ring's next report of
     * another value (e.g. the old one, if Ring didn't act on the request) reaches HomeKit even if
     * Ring reported that value before. Other values Ring reports before it reports the requested
     * one, within SET_VALUE_SHOWN_MS, don't count, as they may predate the request. Off for a
     * characteristic that shows Ring's value itself once a request is done.
     */
    trackSetValue?: boolean
    requestUpdate?: () => unknown
  }) {
    const service = this.getService(serviceType, name, serviceSubType),
      characteristic = service.getCharacteristic(characteristicType),
      { device } = this,
      onValue = new Subject<CharacteristicValue>()
    // Until when Ring's reports don't replace a value just set from HomeKit (one sent before
    // Ring acted on the request would show the old value for a moment)
    let setValueShownUntil = 0,
      setValueShownTimer: ReturnType<typeof setTimeout> | undefined,
      setValueRequested: CharacteristicValue | undefined
    const endSetValueHold = () => {
      setValueShownUntil = 0
      clearTimeout(setValueShownTimer)
      setValueShownTimer = undefined
    }
    // shows a value set from HomeKit for holdMs, unless Ring reports it sooner
    const holdSetValue = (newValue: CharacteristicValue, holdMs: number) => {
      endSetValueHold()
      setValueRequested = newValue
      setValueShownUntil = Date.now() + holdMs
      onValue.next(newValue)
      // Ring never reported the request: its latest value, even if it came meanwhile
      setValueShownTimer = setTimeout(() => {
        endSetValueHold()
        try {
          const value = getValue(device.data)
          if (value !== undefined) onValue.next(value)
        } catch (e) {
          logError(e)
        }
      }, holdMs)
    }

    if (requestUpdate) {
      // Only register for GET if an async request should be made to get an updated value
      characteristic.on(
        CharacteristicEventTypes.GET,
        (callback: CharacteristicGetCallback) => {
          try {
            // a value just set from HomeKit stays shown for its hold, as in the pushed updates
            const value =
              Date.now() < setValueShownUntil ? setValueRequested : getValue(device.data)
            callback(null, value ?? characteristic.value)
            requestUpdate()
          } catch (e) {
            callback(toError(e))
          }
        },
      )
    }

    if (setValue && setValueDebounceTime) {
      const onValueToSet = new Subject<V>()

      characteristic.on(
        CharacteristicEventTypes.SET,
        (
          newValue: CharacteristicValue,
          callback: CharacteristicSetCallback,
        ) => {
          if (trackSetValue) {
            // held until Ring has had as long to report it as an undebounced value
            holdSetValue(newValue, setValueDebounceTime + SET_VALUE_SHOWN_MS)
          } else {
            onValue.next(newValue)
          }
          onValueToSet.next(newValue as V) // HAP checked it against the characteristic's format
          callback()
        },
      )

      onValueToSet
        .pipe(debounceTime(setValueDebounceTime))
        .subscribe((value) => {
          Promise.resolve()
            .then(() => setValue(value))
            .catch(logError)
        })
    } else if (setValue) {
      characteristic.on(
        CharacteristicEventTypes.SET,
        (
          newValue: CharacteristicValue,
          callback: CharacteristicSetCallback,
        ) => {
          if (trackSetValue) {
            holdSetValue(newValue, SET_VALUE_SHOWN_MS)
          }
          Promise.resolve(setValue(newValue as V)).catch(logError) // checked by HAP, as above
          callback()
        },
      )
    }

    merge(
      (this.device.onData as Observable<T['data']>).pipe(
        map(getValue),
        filter((value): value is V => value !== undefined),
        filter((value) => {
          if (Date.now() >= setValueShownUntil) return true
          // Ring reports the request: from now on its reports count again
          if (value === setValueRequested) {
            endSetValueHold()
            return true
          }
          return false
        }),
      ),
      onValue,
    )
      .pipe(distinctUntilChanged())
      .subscribe((value) => characteristic.updateValue(value))

    return (value: CharacteristicValue) => onValue.next(value)
  }

  registerLevelCharacteristic({
    characteristicType,
    serviceType,
    getValue,
    setValue,
    requestUpdate,
  }: {
    characteristicType: CharacteristicType
    serviceType: ServiceType
    getValue: (data: T['data']) => number
    setValue: (value: number) => unknown
    requestUpdate?: () => unknown
  }) {
    let targetLevel: number | undefined,
      targetTimeout: ReturnType<typeof setTimeout> | undefined,
      levelRequestId = 0

    // Ring's levels are 0-1, so 57 % comes back as 56.99999999999999: rounded, as HomeKit's are
    const getLevel = (data: T['data']) => Math.round(getValue(data)),
      clearTarget = () => {
        clearTimeout(targetTimeout)
        targetTimeout = undefined
        targetLevel = undefined
      }

    const updateValue = this.registerCharacteristic({
      characteristicType,
      serviceType,
      getValue: (data) => {
        const newLevel = getLevel(data)

        if (newLevel === targetLevel) {
          clearTarget()
        }

        return targetLevel === undefined ? newLevel : targetLevel
      },
      setValue: async (level: number) => {
        const requestId = ++levelRequestId
        clearTarget()
        targetLevel = level
        // If Ring never reports the level (it ignored or changed the request), Ring's level is
        // shown again, rather than the request until the next one
        targetTimeout = setTimeout(() => {
          if (requestId === levelRequestId) {
            clearTarget()
            updateValue(getLevel(this.device.data))
          }
        }, LEVEL_TARGET_TIMEOUT_MS)

        try {
          await setValue(level)
        } catch (e) {
          if (requestId === levelRequestId) {
            clearTarget()
            updateValue(getLevel(this.device.data))
          }
          throw e
        }
      },
      setValueDebounceTime: 500,
      // the target level above is its own hold
      trackSetValue: false,
      requestUpdate,
    })
  }
}
