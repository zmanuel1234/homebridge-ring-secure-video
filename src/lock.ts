import { BaseDeviceAccessory } from './base-device-accessory.js'
import type { RingDevice, RingDeviceData } from 'ring-client-api'
import { distinctUntilChanged, skip } from 'rxjs/operators'
import { hap } from './hap.js'
import type { RingPlatformConfig } from './config.js'
import type { PlatformAccessory } from 'homebridge'

// How long a lock/unlock request from HomeKit is shown while waiting for Ring to report it
export const LOCK_TARGET_TIMEOUT_MS = 30_000

function getCurrentState({ locked }: RingDeviceData) {
  const {
    Characteristic: { LockCurrentState: State },
  } = hap

  switch (locked) {
    case 'unlocked':
      return State.UNSECURED
    case 'locked':
      return State.SECURED
    case 'jammed':
      return State.JAMMED
    default:
      return State.UNKNOWN
  }
}

export class Lock extends BaseDeviceAccessory {
  private targetState?: number
  private targetTimer?: ReturnType<typeof setTimeout>
  private showTarget?: (value: number) => void

  public readonly device
  public readonly accessory
  public readonly config

  constructor(
    device: RingDevice,
    accessory: PlatformAccessory,
    config: RingPlatformConfig,
  ) {
    super()

    this.device = device
    this.accessory = accessory
    this.config = config

    const { Characteristic, Service } = hap

    // Ring reported a new lock state (the requested one, a jam, or a change by hand): any
    // target HomeKit was waiting for is over, and the target follows Ring's state again.
    // (Storing the derived target here, as upstream does, would keep a jam's "locked" target
    // pending, and a lock then unlocked by hand would show "Locking…".)
    this.device.onData
      .pipe(
        distinctUntilChanged((a, b) => a.locked === b.locked),
        skip(1),
      )
      .subscribe(() => {
        this.clearTargetState()
      })

    this.registerCharacteristic({
      characteristicType: Characteristic.LockCurrentState,
      serviceType: Service.LockMechanism,
      getValue: (data) => {
        const state = getCurrentState(data)

        if (state === this.targetState) {
          this.clearTargetState()
        }

        return state
      },
    })

    this.showTarget = this.registerCharacteristic({
      characteristicType: Characteristic.LockTargetState,
      serviceType: Service.LockMechanism,
      getValue: (data) => this.getTargetState(data),
      setValue: (value) => this.setTargetState(value),
    })
  }

  setTargetState(state: number) {
    const {
        Characteristic: { LockTargetState: State },
      } = hap,
      command = state === State.SECURED ? 'lock' : 'unlock'

    this.clearTargetState()
    if (state !== getCurrentState(this.device.data)) {
      this.targetState = state
      // If Ring never reports a new state (the command was lost, or the lock ignored it), the
      // lock's state is shown again, instead of "Locking…" or "Unlocking…" until the next one
      this.targetTimer = setTimeout(() => {
        this.targetTimer = undefined
        this.targetState = undefined
        this.showTarget?.(this.getTargetState(this.device.data))
      }, LOCK_TARGET_TIMEOUT_MS)
      // nothing to wait for when Homebridge stops
      this.targetTimer.unref?.()
    }

    return this.device.sendCommand(`lock.${command}`)
  }

  private clearTargetState() {
    clearTimeout(this.targetTimer)
    this.targetTimer = undefined
    this.targetState = undefined
  }

  getTargetState(data: RingDeviceData) {
    if (this.targetState !== undefined) {
      return this.targetState
    }

    const {
      Characteristic: { LockCurrentState, LockTargetState },
    } = hap
    const currentState = getCurrentState(data)

    if (
      currentState === LockCurrentState.JAMMED ||
      currentState === LockCurrentState.UNKNOWN
    ) {
      return LockTargetState.SECURED
    }

    return currentState
  }
}
