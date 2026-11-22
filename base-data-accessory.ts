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
import { debounceTime, distinctUntilChanged, map } from 'rxjs/operators'
import type {
  PlatformAccessory,
  CharacteristicValue,
  CharacteristicSetCallback,
  CharacteristicGetCallback,
} from 'homebridge'
import { CharacteristicEventTypes } from 'homebridge'
import { logError } from 'ring-client-api/util'

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
     * Ring reported that value before. Off for a characteristic that shows Ring's value itself
     * once a request is done.
     */
    trackSetValue?: boolean
    requestUpdate?: () => any
  }) {
    const service = this.getService(serviceType, name, serviceSubType),
      characteristic = service.getCharacteristic(characteristicType),
      { device } = this,
      onValue = new Subject<CharacteristicValue>()

    if (requestUpdate) {
      // Only register for GET if an async request should be made to get an updated value
      characteristic.on(
        CharacteristicEventTypes.GET,
        (callback: CharacteristicGetCallback) => {
          try {
            const value = getValue(device.data)
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
            onValue.next(newValue)
          }
          Promise.resolve(setValue(newValue)).catch(logError)
          callback()
        },
      )
    }

    merge(
      (this.device.onData as Observable<T['data']>).pipe(map(getValue)),
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
