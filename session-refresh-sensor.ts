import type { PlatformAccessory } from 'homebridge'
import { logInfo } from 'ring-client-api/util'
import { hap } from './hap.ts'

/** How long the sensor stays open after an automatic Ring session refresh. */
export const SESSION_REFRESH_SENSOR_OPEN_MS = 24 * 60 * 60_000
/**
 * The sensor opens this long after the bridge is set up, not at once: the refresh happens right
 * after a restart, and the Home app notifies for a change it sees, not for a value it finds.
 */
export const SESSION_REFRESH_SENSOR_DELAY_MS = 60_000

// Kept stable so the accessory, and its room and notification settings, survive restarts.
export function getSessionRefreshSensorUuid(id: string) {
  return hap.uuid.generate(`${id}-zm-session-refresh`)
}

/**
 * A contact sensor that opens after an automatic Ring session refresh, so the Home app can
 * notify: the older homebridge-ring-secure-video entry in Authorized Client Devices is then to
 * be removed. It closes again a day later.
 */
export class SessionRefreshSensor {
  private readonly characteristic
  private readonly readyAt: number
  private openTimer?: ReturnType<typeof setTimeout>
  private closeTimer?: ReturnType<typeof setTimeout>

  constructor(accessory: PlatformAccessory, name: string) {
    const { Characteristic, Service } = hap
    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Ring')
      .setCharacteristic(Characteristic.Model, 'Session refresh sensor')
      .setCharacteristic(Characteristic.SerialNumber, 'session-refresh')
    const service =
      accessory.getService(Service.ContactSensor) ??
      accessory.addService(Service.ContactSensor, name)
    this.characteristic = service.getCharacteristic(Characteristic.ContactSensorState)
    this.characteristic.updateValue(Characteristic.ContactSensorState.CONTACT_DETECTED)
    this.readyAt = Date.now() + SESSION_REFRESH_SENSOR_DELAY_MS
  }

  /** Shows a refresh done at refreshDoneAt (if it is less than a day ago). */
  show(refreshDoneAt: number | undefined) {
    const now = Date.now()
    if (!refreshDoneAt || refreshDoneAt > now) return
    const closeAt = refreshDoneAt + SESSION_REFRESH_SENSOR_OPEN_MS
    if (closeAt <= this.readyAt) return
    const { ContactSensorState } = hap.Characteristic
    this.stop()
    this.openTimer = setTimeout(() => {
      this.characteristic.updateValue(ContactSensorState.CONTACT_NOT_DETECTED)
      logInfo('Ring Session Refreshed sensor opened (remove the older entry in Authorized Client Devices)')
    }, Math.max(0, this.readyAt - now))
    this.closeTimer = setTimeout(() => {
      this.characteristic.updateValue(ContactSensorState.CONTACT_DETECTED)
    }, closeAt - now)
    this.openTimer.unref?.()
    this.closeTimer.unref?.()
  }

  stop() {
    clearTimeout(this.openTimer)
    clearTimeout(this.closeTimer)
  }
}
