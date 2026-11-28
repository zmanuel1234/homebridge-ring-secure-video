import { BaseDeviceAccessory } from './base-device-accessory.js'
import type { RingDevice } from 'ring-client-api'
import { hap } from './hap.js'
import type { RingPlatformConfig } from './config.js'
import type { PlatformAccessory } from 'homebridge'

export class ContactSensor extends BaseDeviceAccessory {
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

    const {
      Characteristic: { ContactSensorState },
      Service,
    } = hap

    this.registerCharacteristic({
      characteristicType: ContactSensorState,
      serviceType: Service.ContactSensor,
      getValue: (data) => {
        return data.faulted
          ? ContactSensorState.CONTACT_NOT_DETECTED
          : ContactSensorState.CONTACT_DETECTED
      },
    })

    this.initSensorService(Service.ContactSensor)
  }
}
