import type { PlatformAccessory } from 'homebridge'
import { logInfo } from 'ring-client-api/util'
import { hap } from './hap.ts'

/** How long the sensor stays open after an automatic Ring session refresh. */
export const SESSION_REFRESH_SENSOR_OPEN_MS = 24 * 60 * 60_000
/** After a home hub subscribes again, the sensor opens this much later... */
export const SESSION_REFRESH_SENSOR_SUBSCRIBED_DELAY_MS = 10_000
/** ...or after this long at most. */
export const SESSION_REFRESH_SENSOR_MAX_DELAY_MS = 3 * 60_000

// Kept stable so the accessory, and its room and notification settings, survive restarts.
export function getSessionRefreshSensorUuid(id: string) {
  return hap.uuid.generate(`${id}-zm-session-refresh`)
}

/**
 * A contact sensor that opens after an automatic Ring session refresh, so the Home app can
 * notify: the older homebridge-ring-secure-video entry in Authorized Client Devices is then to
 * be removed. It closes again a day later.
 *
 * The refresh happens right after a restart, and the Home app notifies for a change it sees, not
 * for a value it finds: so after a refresh in this run the sensor opens once a home hub has
 * subscribed to it again (or after 3 minutes). After a restart later that day it is simply
 * open, without a second notification.
 */
export class SessionRefreshSensor {
  private readonly characteristic
  private readonly runStartedAt
  private openTimer?: ReturnType<typeof setTimeout>
  private closeTimer?: ReturnType<typeof setTimeout>
  private onSubscribe?: () => void

  constructor(accessory: PlatformAccessory, name: string, runStartedAt: number) {
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
    this.runStartedAt = runStartedAt
  }

  /** Shows a refresh done at refreshDoneAt (if it is less than a day ago). */
  show(refreshDoneAt: number | undefined) {
    const now = Date.now()
    if (!refreshDoneAt || refreshDoneAt > now) return
    const closeAt = refreshDoneAt + SESSION_REFRESH_SENSOR_OPEN_MS
    if (closeAt <= now) return
    const { ContactSensorState } = hap.Characteristic
    this.stop()
    const open = () => {
      this.stopWaiting()
      this.characteristic.updateValue(ContactSensorState.CONTACT_NOT_DETECTED)
    }
    if (refreshDoneAt < this.runStartedAt) {
      open()
    } else {
      this.openTimer = setTimeout(() => {
        open()
        logInfo('Ring Session Refreshed sensor opened (remove the older entry in Authorized Client Devices)')
      }, Math.min(SESSION_REFRESH_SENSOR_MAX_DELAY_MS, closeAt - now))
      this.onSubscribe = () => {
        clearTimeout(this.openTimer)
        this.openTimer = setTimeout(() => {
          open()
          logInfo('Ring Session Refreshed sensor opened (remove the older entry in Authorized Client Devices)')
        }, SESSION_REFRESH_SENSOR_SUBSCRIBED_DELAY_MS)
        this.openTimer.unref?.()
        this.stopWaiting()
      }
      this.characteristic.on(hap.CharacteristicEventTypes.SUBSCRIBE, this.onSubscribe)
      this.openTimer.unref?.()
    }
    this.closeTimer = setTimeout(() => {
      this.characteristic.updateValue(ContactSensorState.CONTACT_DETECTED)
    }, closeAt - now)
    this.closeTimer.unref?.()
  }

  private stopWaiting() {
    if (this.onSubscribe) {
      this.characteristic.removeListener(hap.CharacteristicEventTypes.SUBSCRIBE, this.onSubscribe)
      this.onSubscribe = undefined
    }
  }

  stop() {
    this.stopWaiting()
    clearTimeout(this.openTimer)
    clearTimeout(this.closeTimer)
  }
}
