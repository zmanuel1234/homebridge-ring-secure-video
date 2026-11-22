import { BaseDeviceAccessory } from './base-device-accessory.ts'
import type {
  AlarmMode,
  AlarmState,
  RingDevice,
  RingDeviceData,
} from 'ring-client-api'
import { allAlarmStates, RingDeviceType } from 'ring-client-api'
import { hap } from './hap.ts'
import type { RingPlatformConfig } from './config.ts'
import type { PlatformAccessory } from 'homebridge'
import { logError, logInfo } from 'ring-client-api/util'
import type { Subscription } from 'rxjs'
import { filter } from 'rxjs'

// How long HomeKit alarm requests must stop before the last one is sent to Ring (see
// setTargetState), unless alarmModeChangeDelaySeconds sets it (0 to 5 s)
export const ALARM_TARGET_SETTLE_MS = 1000

export function getAlarmTargetSettleMs({ alarmModeChangeDelaySeconds: seconds }: RingPlatformConfig) {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds <= 5
    ? Math.round(seconds * 1000)
    : ALARM_TARGET_SETTLE_MS
}
// How long to wait for Ring to report the new mode after a command
export const ALARM_COMMAND_TIMEOUT_MS = 20_000
// How long after ring-client-api reports a failure Ring may still report the new mode
export const ALARM_MODE_GRACE_MS = 5000

const alarmModeNames: Record<AlarmMode, string> = {
  all: 'armed (Away)',
  some: 'armed (Home)',
  none: 'disarmed',
}

function isValidNightModeBypass(mode?: AlarmMode) {
  return mode && (mode === 'all' || mode === 'some')
}

export class SecurityPanel extends BaseDeviceAccessory {
  private alarmStates: AlarmState[]

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

    this.alarmStates = this.config.alarmOnEntryDelay
      ? allAlarmStates
      : allAlarmStates.filter((x) => x !== 'entry-delay')

    const { Characteristic, Service } = hap,
      validValues = [
        Characteristic.SecuritySystemTargetState.AWAY_ARM,
        Characteristic.SecuritySystemTargetState.STAY_ARM,
        Characteristic.SecuritySystemTargetState.DISARM,
      ]

    if (isValidNightModeBypass(config.nightModeBypassFor)) {
      validValues.push(Characteristic.SecuritySystemTargetState.NIGHT_ARM)
    }

    this.registerCharacteristic({
      characteristicType: Characteristic.SecuritySystemCurrentState,
      serviceType: Service.SecuritySystem,
      getValue: (data) => this.getCurrentState(data),
    })

    this.showTargetState = this.registerCharacteristic({
      characteristicType: Characteristic.SecuritySystemTargetState,
      serviceType: Service.SecuritySystem,
      getValue: (data) => this.getShownTargetState(data),
      setValue: (value) => this.setTargetState(value),
      // the panel shows Ring's state once a change is done (showRingAlarmState); meanwhile a
      // Ring update in the old mode would move the slider back while it settles
      trackSetValue: false,
    })

    this.getService(Service.SecuritySystem)
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .setProps({ validValues })

    if (!config.hideAlarmSirenSwitch) {
      this.registerCharacteristic({
        characteristicType: Characteristic.On,
        serviceType: Service.Switch,
        name: this.device.name + ' Siren',
        getValue: (data) => data.siren && data.siren.state === 'on',
        setValue: (value) => {
          if (value) {
            return this.device.location.soundSiren()
          }
          return this.device.location.silenceSiren()
        },
      })
    }

    this.getService(Service.SecuritySystem).setPrimaryService(true)
  }

  getTargetNightMode() {
    return this.targetingNightMode && this.config.nightModeBypassFor
  }

  getTargetState({ mode }: RingDeviceData) {
    const {
      Characteristic: { SecuritySystemTargetState: State },
    } = hap

    if (mode === this.getTargetNightMode()) {
      return State.NIGHT_ARM
    }

    // current mode does not match night mode target, so we are no longer targeting night mode,
    // unless a mode change is still in progress (Ring may report the old mode first)
    if (this.requestedTargetState === undefined) {
      this.targetingNightMode = false
    }

    switch (mode) {
      case 'all':
        return State.AWAY_ARM
      case 'some':
        return State.STAY_ARM
      case 'none':
        return State.DISARM
      default:
        return State.DISARM
    }
  }

  getCurrentState(data: RingDeviceData) {
    const { alarmInfo } = data

    if (alarmInfo && this.alarmStates.includes(alarmInfo.state)) {
      return hap.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED
    }

    return this.getTargetState(data)
  }

  get targetingNightMode() {
    return this.accessory.context.targetingNightMode
  }
  set targetingNightMode(value: boolean) {
    this.accessory.context.targetingNightMode = value
  }

  // A HomeKit target the plugin hasn't sent to Ring yet, its timer, and the Ring command being
  // sent (one at a time). Left unset by the constructor, so they start out undefined.
  // requestedTargetState is HomeKit's latest request until the change it led to is done, and
  // targetRequests counts requests, so a change can tell whether a newer one came meanwhile.
  private requestedTargetState?: number
  private targetRequests?: number
  private pendingTargetState?: number
  private pendingTargetTimer?: ReturnType<typeof setTimeout>
  private pendingTargetWaiters?: (() => void)[]
  private sendingTargetState?: Promise<void>
  // Shows a target through the characteristic's updates, so that they know what HomeKit shows
  // (a direct updateValue would leave them holding the request, and drop Ring's next report of
  // the same state as a repeat)
  private showTargetState?: (value: number) => void

  /**
   * A HomeKit request to change the alarm mode. A slider in a HomeKit app sends a value for every
   * mode it passes (Off to Home passes Away), so requests are collected until none has come for
   * getAlarmTargetSettleMs (1 s by default), and only the last one is sent to Ring. Resolves once
   * that one is done.
   */
  setTargetState(state: any) {
    this.pendingTargetState = state
    this.requestedTargetState = state
    this.targetRequests = (this.targetRequests ?? 0) + 1
    // HomeKit shows the request already: so the updates know it, and show Ring's state after it
    this.showTargetState?.(state)
    clearTimeout(this.pendingTargetTimer)

    return new Promise<void>((resolve) => {
      ;(this.pendingTargetWaiters ??= []).push(resolve)
      this.pendingTargetTimer = setTimeout(() => {
        const target = this.pendingTargetState,
          request = this.targetRequests,
          waiters = this.pendingTargetWaiters ?? []
        this.pendingTargetState = undefined
        this.pendingTargetTimer = undefined
        this.pendingTargetWaiters = undefined

        // after any Ring command still being sent, so each one checks Ring's answer to itself
        const sending = (this.sendingTargetState ?? Promise.resolve())
          .then(() => this.sendTargetState(target, request))
          .catch((e) => {
            logError(e)
            // so the slider doesn't stay at the request
            this.showRingAlarmState(request)
          })
        this.sendingTargetState = sending
        void sending.then(() => {
          if (this.sendingTargetState === sending) {
            this.sendingTargetState = undefined
          }
          waiters.forEach((done) => done())
        })
      }, getAlarmTargetSettleMs(this.config))
    })
  }

  private async sendTargetState(state: any, request?: number) {
    const {
        Characteristic: { SecuritySystemTargetState: State },
      } = hap,
      { location } = this.device,
      { nightModeBypassFor } = this.config

    let bypass = false
    this.targetingNightMode = state === State.NIGHT_ARM

    if (state === State.NIGHT_ARM) {
      if (
        nightModeBypassFor &&
        (nightModeBypassFor === 'all' || nightModeBypassFor === 'some')
      ) {
        state = nightModeBypassFor === 'all' ? State.AWAY_ARM : State.STAY_ARM
        bypass = true
      } else {
        // Switch to Home since we don't know which mode the user wanted
        state = State.STAY_ARM
      }
    }

    const mode: AlarmMode =
      state === State.AWAY_ARM ? 'all' : state === State.DISARM ? 'none' : 'some'

    // Ring sends no update when the mode doesn't change, so a command would never be confirmed
    if (!bypass && this.device.data.mode === mode) {
      logInfo(`${this.device.name} is already ${alarmModeNames[mode]}`)
      this.showRingAlarmState(request)
      return
    }

    let commandError: any
    try {
      const bypassContactSensors = bypass
          ? (await location.getDevices()).filter((device) => {
              return (
                device.deviceType === RingDeviceType.ContactSensor &&
                device.data.faulted
              )
            })
          : [],
        bypassSensorZids = bypassContactSensors.map((sensor) => sensor.id),
        bypassSensorNames = bypassContactSensors.map((sensor) => sensor.name),
        bypassLog = bypassSensorNames.length
          ? ' - Bypassing Sensors: ' + bypassSensorNames.join(', ')
          : ''

      let command: Promise<void>
      if (mode === 'all') {
        logInfo(`Arming (Away) ${this.device.name}${bypassLog}`)
        command = location.armAway(bypassSensorZids)
      } else if (mode === 'none') {
        logInfo(`Disarming ${this.device.name}`)
        command = location.disarm()
      } else {
        logInfo(`Arming (Home) ${this.device.name}${bypassLog}`)
        command = location.armHome(bypassSensorZids)
      }

      // ring-client-api waits for Ring's next update only: it reports a failure if that update
      // shows another mode, even when the requested one follows, and waits forever if Ring sends
      // none. So the command is done once Ring reports the mode; after ring-client-api's failure,
      // the mode gets a few more seconds; and after any other error, none.
      let reportedModeSubscription: Subscription | undefined
      const timers: ReturnType<typeof setTimeout>[] = [],
        after = (ms: number) =>
          new Promise<void>((resolve) => {
            timers.push(setTimeout(resolve, ms))
          }),
        modeReported = new Promise<void>((resolve) => {
          reportedModeSubscription = this.device.onData
            .pipe(filter((data) => data.mode === mode))
            .subscribe(() => resolve())
        }),
        commandFailed = command.then(
          () => undefined,
          (e: any) => {
            commandError = e
            return /Failed to set alarm mode/.test(e?.message)
              ? after(ALARM_MODE_GRACE_MS)
              : undefined
          },
        )
      await Promise.race([
        modeReported,
        commandFailed,
        after(ALARM_COMMAND_TIMEOUT_MS),
      ])
      timers.forEach((timer) => clearTimeout(timer))
      reportedModeSubscription?.unsubscribe()
    } catch (e: any) {
      commandError = e
    }

    const reportedMode = this.device.data.mode as AlarmMode | undefined
    if (reportedMode !== mode) {
      logError(
        `Ring didn't change ${this.device.name} to ${alarmModeNames[mode]}: it is ${
          (reportedMode && alarmModeNames[reportedMode]) || 'in an unknown mode'
        }.${mode === 'none' ? '' : ' An open sensor may need bypassing, which can only be done in the Ring app.'}`,
      )
      // ring-client-api's own "Failed to set alarm mode" says no more than the line above
      if (commandError && !/Failed to set alarm mode/.test(commandError?.message)) {
        logError(commandError)
      }
    }

    this.showRingAlarmState(request)
  }

  /**
   * The target HomeKit shows: its latest request while the change is in progress, so a Ring
   * update with the old mode doesn't move the slider back while it settles or the command runs.
   */
  getShownTargetState(data: RingDeviceData) {
    return this.requestedTargetState ?? this.getTargetState(data)
  }

  // Both states from Ring's data: also after a command that wasn't sent or brought no update
  // from Ring (e.g. Night to Home in the same Ring mode), so the Home app doesn't stay at "Arming"
  // (the target: unless a newer request is in progress)
  private showRingAlarmState(request?: number) {
    if (request === undefined || request === this.targetRequests) {
      this.requestedTargetState = undefined
    }
    const service = this.getService(hap.Service.SecuritySystem),
      { data } = this.device,
      target = this.getShownTargetState(data)
    if (this.showTargetState) {
      this.showTargetState(target)
    } else {
      service.getCharacteristic(hap.Characteristic.SecuritySystemTargetState).updateValue(target)
    }
    service
      .getCharacteristic(hap.Characteristic.SecuritySystemCurrentState)
      .updateValue(this.getCurrentState(data))
  }
}
