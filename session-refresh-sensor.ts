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
 * for a value it finds: so after a refresh in this run the sensor opens 10 s after a Home app
 * or home hub is subscribed to it (or after 3 minutes). After a restart later that day it is
 * simply open, without a second notification.
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
    // Its value is kept from the last run (Homebridge caches it) until show() decides: every
    // update is sent to the Home app, so closing it here and opening it again in show() would
    // notify a second time.
    this.characteristic = service.getCharacteristic(Characteristic.ContactSensorState)
    this.runStartedAt = runStartedAt
  }

  private set(value: number) {
    if (this.characteristic.value !== value) this.characteristic.updateValue(value)
  }

  /** Shows a refresh done at refreshDoneAt (if it is less than a day ago); closed otherwise. */
  show(refreshDoneAt: number | undefined) {
    const now = Date.now(),
      { ContactSensorState } = hap.Characteristic,
      closeAt = (refreshDoneAt ?? 0) + SESSION_REFRESH_SENSOR_OPEN_MS
    this.stop()
    if (!refreshDoneAt || refreshDoneAt > now || closeAt <= now) {
      this.set(ContactSensorState.CONTACT_DETECTED)
      return
    }
    const open = () => {
      this.stopWaiting()
      if (Date.now() < closeAt) this.set(ContactSensorState.CONTACT_NOT_DETECTED)
    }
    if (refreshDoneAt < this.runStartedAt) {
      open()
    } else {
      // A refresh in this run: closed until the Home app can see it open.
      this.set(ContactSensorState.CONTACT_DETECTED)
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
      this.openTimer.unref?.()
      // hap-nodejs only reports the first subscriber; a home hub that came back while the
      // plugin was connecting to Ring has subscribed already (the count is private).
      if ((this.characteristic as unknown as { subscriptions?: number }).subscriptions) {
        this.onSubscribe()
      } else {
        this.characteristic.on(hap.CharacteristicEventTypes.SUBSCRIBE, this.onSubscribe)
      }
    }
    this.closeTimer = setTimeout(() => {
      this.set(ContactSensorState.CONTACT_DETECTED)
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
