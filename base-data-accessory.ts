import type { CharacteristicType, ServiceType } from './base-accessory.ts'
import { BaseAccessory } from './base-accessory.ts'
import type { Observable } from 'rxjs'
import { merge, Subject } from 'rxjs'
import type {
  RingCamera,
  RingChime,
  RingDevice,
  RingIntercom,
} from 'ring-client-api'
import type { RingPlatformConfig } from './config.ts'
import { debounceTime, distinctUntilChanged, filter, map } from 'rxjs/operators'
import type {
  PlatformAccessory,
  CharacteristicValue,
  CharacteristicSetCallback,
  CharacteristicGetCallback,
} from 'homebridge'
import { CharacteristicEventTypes } from 'homebridge'
import { logError } from 'ring-client-api/util'

// How long a value set from HomeKit (not debounced) is shown at most, unless Ring reports it
// sooner, before Ring's reports count again
export const SET_VALUE_SHOWN_MS = 10_000
// How long a level set from HomeKit is shown while waiting for Ring to report it
export const LEVEL_TARGET_TIMEOUT_MS = 30_000

export abstract class BaseDataAccessory<
  T extends RingDevice | RingCamera | RingChime | RingIntercom,
> extends BaseAccessory<T> {
  abstract readonly device: T
  abstract readonly accessory: PlatformAccessory
  abstract readonly config: RingPlatformConfig

  registerCharacteristic({
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
    getValue: (data: T['data']) => any
    setValue?: (data: any) => any
    setValueDebounceTime?: number
    /**
     * Whether a value set from HomeKit counts as the one shown, so that Ring's next report of
     * another value (e.g. the old one, if Ring didn't act on the request) reaches HomeKit even if
     * Ring reported that value before. Other values Ring reports before it reports the requested
     * one, within SET_VALUE_SHOWN_MS, don't count, as they may predate the request. Off for a
     * characteristic that shows Ring's value itself once a request is done.
     */
    trackSetValue?: boolean
    requestUpdate?: () => any
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

    if (requestUpdate) {
      // Only register for GET if an async request should be made to get an updated value
      characteristic.on(
        CharacteristicEventTypes.GET,
        (callback: CharacteristicGetCallback) => {
          try {
            // a value just set from HomeKit stays shown for its hold, as in the pushed updates
            const value =
              Date.now() < setValueShownUntil ? setValueRequested : getValue(device.data)
            callback(null, value)
            requestUpdate()
          } catch (e: any) {
            callback(e)
          }
        },
      )
    }

    if (setValue && setValueDebounceTime) {
      const onValueToSet = new Subject<any>()

      characteristic.on(
        CharacteristicEventTypes.SET,
        (
          newValue: CharacteristicValue,
          callback: CharacteristicSetCallback,
        ) => {
          onValue.next(newValue)
          onValueToSet.next(newValue)
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
            endSetValueHold()
            setValueRequested = newValue
            setValueShownUntil = Date.now() + SET_VALUE_SHOWN_MS
            onValue.next(newValue)
            // Ring never reported the request: its latest value, even if it came meanwhile
            setValueShownTimer = setTimeout(() => {
              endSetValueHold()
              try {
                onValue.next(getValue(device.data))
              } catch (e) {
                logError(e)
              }
            }, SET_VALUE_SHOWN_MS)
          }
          Promise.resolve(setValue(newValue)).catch(logError)
          callback()
        },
      )
    }

    merge(
      (this.device.onData as Observable<T['data']>).pipe(
        map(getValue),
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
    setValue: (data: any) => any
    requestUpdate?: () => any
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
      requestUpdate,
    })
  }
}
