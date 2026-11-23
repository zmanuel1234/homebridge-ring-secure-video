import type { Location, LocationMode } from 'ring-client-api'
import { distinctUntilChanged, timeout } from 'rxjs/operators'
import { hap } from './hap.ts'
import type { RingPlatformConfig } from './config.ts'
import { logError, logInfo } from 'ring-client-api/util'
import { BaseAccessory } from './base-accessory.ts'
import { logRejection } from './log-rejection.ts'
import { toError } from './errors.ts'
import { firstValueFrom, of } from 'rxjs'
import type {
  PlatformAccessory,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
} from 'homebridge'
import { CharacteristicEventTypes } from 'homebridge'

/**
 * How long a HomeKit status read waits for Ring's first mode report. Homebridge warns about
 * an accessory slow to respond from 3 s, so the read gives up before that.
 */
export const LOCATION_MODE_READ_TIMEOUT_MS = 2500

function getStateFromMode(mode: LocationMode) {
  const {
    Characteristic: { SecuritySystemCurrentState: State },
  } = hap

  switch (mode) {
    case 'away':
      return State.AWAY_ARM
    case 'home':
      return State.STAY_ARM
    // 'disabled' (modes turned off for the location) and 'unset' (none chosen yet): nothing is armed
    case 'disarmed':
    case 'disabled':
    case 'unset':
      return State.DISARMED
  }
}

export class LocationModeSwitch extends BaseAccessory<Location> {
  private targetState: CharacteristicValue | undefined
  private modeRequestId = 0
  public device

  private readonly location
  public readonly accessory
  public readonly config

  constructor(
    location: Location,
    accessory: PlatformAccessory,
    config: RingPlatformConfig,
  ) {
    super()
    this.location = location
    this.accessory = accessory
    this.config = config
    this.device = location // for use in BaseAccessory

    const {
        Characteristic,
        Service: { SecuritySystem, AccessoryInformation },
      } = hap,
      accessoryName = location.name + ' Mode',
      service = this.getService(SecuritySystem, accessoryName),
      currentState = service.getCharacteristic(
        Characteristic.SecuritySystemCurrentState,
      ),
      targetState = service.getCharacteristic(
        Characteristic.SecuritySystemTargetState,
      ),
      getCurrentMode = () => {
        return firstValueFrom(location.onLocationMode)
      },
      getCurrentState = async () => getStateFromMode(await getCurrentMode()),
      // For HomeKit's reads: Ring's mode, or "No Response" if Ring hasn't reported one yet
      // (slow or unreachable at startup) rather than leaving the read unanswered.
      readCurrentState = async () => {
        try {
          return getStateFromMode(
            await firstValueFrom(
              location.onLocationMode.pipe(timeout({ first: LOCATION_MODE_READ_TIMEOUT_MS })),
            ),
          )
        } catch {
          throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
        }
      }

    location.onLocationMode.pipe(distinctUntilChanged()).subscribe((mode) => {
      const state = getStateFromMode(mode)

      if (state === this.targetState) {
        this.targetState = undefined
      }

      if (this.targetState === undefined) {
        targetState.updateValue(state)
      }

      currentState.updateValue(state)
    })

    currentState.on(
      CharacteristicEventTypes.GET,
      logRejection(`Reading the ${location.name} mode`, async (callback: CharacteristicGetCallback) => {
        location.getLocationMode().catch((e) => {
          logError('Failed to retrieve location mode for ' + location.name)
          logError(e)
        })
        let state
        try {
          state = await readCurrentState()
        } catch (e) {
          callback(toError(e))
          return
        }

        if (state === this.targetState) {
          this.targetState = undefined
        }

        callback(null, state)
      }),
    )

    targetState.on(
      CharacteristicEventTypes.GET,
      logRejection(`Reading the ${location.name} target mode`, async (callback: CharacteristicGetCallback) => {
        if (this.targetState !== undefined) {
          callback(null, this.targetState)
          return
        }
        try {
          callback(null, await readCurrentState())
        } catch (e) {
          callback(toError(e))
        }
      }),
    )

    targetState.on(
      CharacteristicEventTypes.SET,
      logRejection(`Setting the ${location.name} mode`, async (
        state: CharacteristicValue,
        callback: CharacteristicSetCallback,
      ) => {
        const {
            Characteristic: { SecuritySystemTargetState: State },
          } = hap,
          requestId = ++this.modeRequestId

        callback()

        try {
          const current = await getCurrentState()
          if (requestId !== this.modeRequestId) {
            return
          }

          if (state === State.NIGHT_ARM) {
            state = State.STAY_ARM
            // Ring doesn't have night mode, so switch over to stay mode
            setTimeout(() => {
              if (requestId === this.modeRequestId) {
                targetState.updateValue(state)
              }
            }, 100)
          }

          if (state === current) {
            this.targetState = undefined
            return
          }

          this.targetState = state

          if (state === State.AWAY_ARM) {
            logInfo(`Setting ${this.location.name} Mode to away`)
            await this.location.setLocationMode('away')
          } else if (state === State.DISARM) {
            logInfo(`Setting ${this.location.name} Mode to disarmed`)
            await this.location.setLocationMode('disarmed')
          } else {
            logInfo(`Setting ${this.location.name} Mode to home`)
            await this.location.setLocationMode('home')
          }
        } catch (e) {
          logError('Failed to set location mode for ' + location.name)
          logError(e)

          if (requestId !== this.modeRequestId) {
            return
          }

          const current = await getCurrentState()
          if (requestId === this.modeRequestId) {
            this.targetState = undefined
            this.modeRequestId++
            targetState.updateValue(current)
          }
        }
      }),
    )

    targetState.setProps({
      validValues: [
        Characteristic.SecuritySystemTargetState.AWAY_ARM,
        Characteristic.SecuritySystemTargetState.STAY_ARM,
        Characteristic.SecuritySystemTargetState.DISARM,
      ],
    })

    this.registerObservableCharacteristic({
      characteristicType: Characteristic.Manufacturer,
      serviceType: AccessoryInformation,
      onValue: of('Ring'),
    })

    this.registerObservableCharacteristic({
      characteristicType: Characteristic.Model,
      serviceType: AccessoryInformation,
      onValue: of('Location Mode'),
    })
    this.registerObservableCharacteristic({
      characteristicType: Characteristic.SerialNumber,
      serviceType: AccessoryInformation,
      onValue: of('N/A'),
    })
  }
}
