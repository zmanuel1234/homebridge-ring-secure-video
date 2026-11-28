import { BaseDeviceAccessory } from './base-device-accessory.js'
import type { RingDevice } from 'ring-client-api'
import { hap } from './hap.js'
import type { RingPlatformConfig } from './config.js'
import type { PlatformAccessory } from 'homebridge'
import { logInfo } from 'ring-client-api/util'

export class UnknownZWaveSwitchSwitch extends BaseDeviceAccessory {
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

    this.registerCharacteristic({
      characteristicType: Characteristic.On,
      serviceType: Service.Switch,
      getValue: (data) => Boolean(data.basicValue),
      setValue: (value) => this.setOnState(value),
    })
  }

  setOnState(on: boolean) {
    logInfo(`Turning ${this.device.name} ${on ? 'On' : 'Off'}`)

    return this.device.setInfo({ device: { v1: { basicValue: on ? 255 : 0 } } })
  }
}
