import type { PlatformAccessory } from 'homebridge'
import type { Observable, Subscription } from 'rxjs'
import { logInfo } from 'ring-client-api/util'
import { hap } from './hap.ts'

/**
 * A camera's own motion sensor triggers its HomeKit Secure Video recordings, and with
 * recording on, the Home app only notifies once its hub has analysed the clip. The optional
 * notification sensor is a separate motion sensor accessory driven by the same motion
 * events but not tied to the camera, so HomeKit notifies from it at once, like a plain
 * sensor.
 */

// Kept stable so the accessory, and the user's rooms and notification settings for it,
// survive restarts and updates.
export function getMotionNotificationSensorUuid(cameraAccessoryId: string) {
  return hap.uuid.generate(`${cameraAccessoryId}-zmnotify`)
}

export function setUpMotionNotificationSensor(
  accessory: PlatformAccessory,
  name: string,
  serialNumber: string,
  motionDetected: Observable<boolean>,
): Subscription {
  const { Characteristic, Service } = hap

  accessory
    .getService(Service.AccessoryInformation)!
    .setCharacteristic(Characteristic.Manufacturer, 'Ring')
    .setCharacteristic(Characteristic.Model, 'Motion notification sensor')
    .setCharacteristic(Characteristic.SerialNumber, serialNumber)

  const service =
    accessory.getService(Service.MotionSensor) ??
    accessory.addService(Service.MotionSensor, name)
  const characteristic = service.getCharacteristic(Characteristic.MotionDetected)

  characteristic.updateValue(false)

  return motionDetected.subscribe((motion) => {
    characteristic.updateValue(motion)
    if (motion) {
      logInfo(`${name}: motion sent to HomeKit (notification sensor)`)
    }
  })
}
