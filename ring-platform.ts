// Already applied by index.ts before this module (and so ring-client-api) is loaded; read here
// for the log line.
import { pushReceiverFix } from './push-receiver-fix.ts'
import {
  RingApi,
  RingCamera,
  RingChime,
  RingDevice,
  RingDeviceCategory,
  RingDeviceType,
  RingIntercom,
} from 'ring-client-api'
import { hap } from './hap.ts'
import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge'
import { SecurityPanel } from './security-panel.ts'
import { Chime } from './chime.ts'
import { BrightnessOnly } from './brightness-only.ts'
import { ContactSensor } from './contact-sensor.ts'
import { MotionSensor } from './motion-sensor.ts'
import { Lock } from './lock.ts'
import { SmokeAlarm } from './smoke-alarm.ts'
import { CoAlarm } from './co-alarm.ts'
import { SmokeCoListener } from './smoke-co-listener.ts'
import type { RingPlatformConfig } from './config.ts'
import {
  controlCenterDisplayName,
  debug,
  getSystemId,
  rotateSystemId,
  updateHomebridgeConfig,
} from './config.ts'
import { Beam } from './beam.ts'
import { MultiLevelSwitch } from './multi-level-switch.ts'
import { Fan } from './fan.ts'
import { Outlet } from './outlet.ts'
import { Switch } from './switch.ts'
import { Camera } from './camera.ts'
import { PanicButtons } from './panic-buttons.ts'
import type { RefreshTokenAuth } from 'ring-client-api/rest-client'
import { logError, logInfo, useLogger } from 'ring-client-api/util'
import type { BaseAccessory } from './base-accessory.ts'
import { FloodFreezeSensor } from './flood-freeze-sensor.ts'
import { FreezeSensor } from './freeze-sensor.ts'
import { TemperatureSensor } from './temperature-sensor.ts'
import { WaterSensor } from './water-sensor.ts'
import { LocationModeSwitch } from './location-mode-switch.ts'
import { Thermostat } from './thermostat.ts'
import { UnknownZWaveSwitchSwitch } from './unknown-zwave-switch.ts'
import { generateMacAddress } from './util.ts'
import { Intercom } from './intercom.ts'
import { Valve } from './valve.ts'
import { sanitizeMediaConfig } from './media-config.ts'
import { configureHksvResourceGovernor } from './hksv-work-queue.ts'
import {
  getMotionNotificationSensorUuid,
  setUpMotionNotificationSensor,
} from './motion-notification-sensor.ts'

type WrappedRefreshToken = {
  rt?: string
  hid?: string
  pnc?: unknown
  [key: string]: unknown
}

const ignoreHiddenDeviceTypes: string[] = [
  RingDeviceType.RingNetAdapter,
  RingDeviceType.ZigbeeAdapter,
  RingDeviceType.CodeVault,
  RingDeviceType.SecurityAccessCode,
  RingDeviceType.ZWaveAdapter,
  RingDeviceType.ZWaveExtender,
  RingDeviceType.BeamsDevice,
  RingDeviceType.PanicButton,
]

export const platformName = 'Ring Secure Video'
export const pluginName = 'homebridge-ring-secure-video'

function getAccessoryClass(
  device: RingDevice,
): (new (...args: any[]) => BaseAccessory<RingDevice>) | null {
  const { deviceType } = device

  if (device.data.status === 'disabled') {
    return null
  }

  switch (deviceType) {
    case RingDeviceType.ContactSensor:
    case RingDeviceType.RetrofitZone:
    case RingDeviceType.TiltSensor:
    case RingDeviceType.GlassbreakSensor:
      return ContactSensor
    case RingDeviceType.MotionSensor:
      return MotionSensor
    case RingDeviceType.FloodFreezeSensor:
      return FloodFreezeSensor
    case RingDeviceType.FreezeSensor:
      return FreezeSensor
    case RingDeviceType.SecurityPanel:
      return SecurityPanel
    case RingDeviceType.BaseStation:
    case RingDeviceType.BaseStationPro:
    case RingDeviceType.Keypad:
      return BrightnessOnly
    case RingDeviceType.SmokeAlarm:
      return SmokeAlarm
    case RingDeviceType.CoAlarm:
      return CoAlarm
    case RingDeviceType.SmokeCoListener:
    case RingDeviceType.KiddeSmokeCoAlarm:
      return SmokeCoListener
    case RingDeviceType.BeamsMotionSensor:
    case RingDeviceType.BeamsSwitch:
    case RingDeviceType.BeamsMultiLevelSwitch:
    case RingDeviceType.BeamsTransformerSwitch:
    case RingDeviceType.BeamsLightGroupSwitch:
      return Beam
    case RingDeviceType.MultiLevelSwitch:
      return device instanceof RingDevice &&
        device.categoryId === RingDeviceCategory.Fans
        ? Fan
        : MultiLevelSwitch
    case RingDeviceType.MultiLevelBulb:
      return MultiLevelSwitch
    case RingDeviceType.Switch:
      return device instanceof RingDevice &&
        device.categoryId === RingDeviceCategory.Outlets
        ? Outlet
        : Switch
    case RingDeviceType.TemperatureSensor:
      return TemperatureSensor
    case RingDeviceType.WaterSensor:
      return WaterSensor
    case RingDeviceType.Thermostat:
      return Thermostat
    case RingDeviceType.WaterValve:
      return Valve
    case RingDeviceType.UnknownZWave:
      return UnknownZWaveSwitchSwitch
  }

  if (/^lock($|\.)/.test(deviceType)) {
    return Lock
  }

  if (deviceType === RingDeviceType.Sensor) {
    // Generic sensor that could be any type of sensor, but should at least have `faulted`
    if (device.name.toLowerCase().includes('motion')) {
      return MotionSensor
    }
    return ContactSensor
  }

  return null
}

function removePushCredentialsFromRefreshToken(
  refreshToken: string,
  removeHardwareId = false,
) {
  try {
    const authConfig = JSON.parse(
      Buffer.from(refreshToken, 'base64').toString('utf8'),
    ) as WrappedRefreshToken

    if (
      !authConfig.rt ||
      (!authConfig.pnc && (!removeHardwareId || !authConfig.hid))
    ) {
      return
    }

    delete authConfig.pnc

    if (removeHardwareId) {
      delete authConfig.hid
    }

    return Buffer.from(JSON.stringify(authConfig)).toString('base64')
  } catch {
    return
  }
}

function updateRefreshTokenInConfig(
  configContents: string,
  oldRefreshToken: string,
  newRefreshToken: string,
  clearRefreshFlags: boolean,
) {
  try {
    const homebridgeConfig = JSON.parse(configContents),
      platformConfig = homebridgeConfig.platforms?.find(
        (platform: PlatformConfig) =>
          platform.platform === platformName &&
          platform.refreshToken === oldRefreshToken,
      )

    if (!platformConfig) {
      throw new Error('Ring platform config not found')
    }

    platformConfig.refreshToken = newRefreshToken

    if (clearRefreshFlags) {
      platformConfig.forceRefreshRingPushCredentials = false
      platformConfig.forceRefreshRingApiSession = false
    }

    return `${JSON.stringify(homebridgeConfig, null, 4)}\n`
  } catch {
    return configContents.replace(oldRefreshToken, newRefreshToken)
  }
}

/**
 * Saves each new Ring refresh token into config.json, replacing the token that is there now.
 *
 * The token in config.json is tracked here rather than taken from ring-client-api's
 * "oldRefreshToken": after a forced refresh, ring-client-api starts from a modified token that
 * was never written to config.json, and following its old token would save only the first new
 * token and none after it (so the next start would register with Ring again).
 */
export function createRefreshTokenSaver(
  api: API,
  tokenInConfig: string | undefined,
  clearRefreshFlags: boolean,
) {
  let current = tokenInConfig,
    // Only with the first save: turning a force setting back on later must survive renewals.
    clearFlags = clearRefreshFlags,
    warned = false
  return ({
    oldRefreshToken,
    newRefreshToken,
  }: {
    oldRefreshToken?: string
    newRefreshToken: string
  }) => {
    const replace = current ?? oldRefreshToken
    if (!replace || newRefreshToken === replace) {
      return
    }

    const saved = updateHomebridgeConfig(api, (configContents) => {
      return updateRefreshTokenInConfig(
        configContents,
        replace,
        newRefreshToken,
        clearFlags,
      )
    })
    if (saved) {
      current = newRefreshToken
      clearFlags = false
    } else if (!warned) {
      // Once per run: after a new sign-in while running, every renewal would end up here.
      warned = true
      logInfo(
        'Could not save a new Ring token to config.json (it may have been changed or signed in again while running). If you did not sign in again, the next start may register with Ring again.',
      )
    }
  }
}

/** An error as a short text; ring-client-api's HTTP errors have no message, only a status. */
export function describeError(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  const status = (error as { response?: { status?: number } } | undefined)?.response?.status
  if (status) return `Ring returned HTTP ${status}`
  return error instanceof Error ? error.name : String(error)
}

/**
 * A Ring error that retrying can't fix. Only an outdated Node.js: ring-client-api reports a Ring
 * sign-in server outage (5xx, 429) as "Refresh token is not valid", the same as a revoked token,
 * so that is retried (every 10 minutes at most, a single request each time).
 */
export function isPermanentRingError(error: unknown) {
  return describeError(error).includes('too old to support')
}

/**
 * Keeps an accessory that couldn't be set up in HomeKit (its room, name and automations stay)
 * but makes it show "No Response", rather than old values and controls that silently do nothing
 * (an alarm that seems to arm).
 */
function markNotResponding(accessory: PlatformAccessory) {
  const failure = () => {
    throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
  }
  for (const service of accessory.services) {
    if (service.UUID === hap.Service.AccessoryInformation.UUID) continue
    for (const characteristic of service.characteristics) {
      characteristic.onGet(failure)
      if (characteristic.props.perms.includes(hap.Perms.PAIRED_WRITE)) {
        characteristic.onSet(failure)
      }
    }
  }
}

/** 30 s, 1 min, 2 min, ... up to 10 min between attempts to reach Ring at startup. */
export function getRetryDelayMs(attempt: number) {
  return Math.min(30_000 * 2 ** attempt, 600_000)
}

export class RingPlatform implements DynamicPlatformPlugin {
  private readonly homebridgeAccessories: {
    [uuid: string]: PlatformAccessory
  } = {}

  public log
  public config
  public api

  constructor(
    log: Logging,
    config: PlatformConfig & RingPlatformConfig & RefreshTokenAuth,
    api: API,
  ) {
    this.log = log
    this.config = config
    this.api = api

    if (!config) {
      log.info('No configuration found for platform Ring Secure Video')
      return
    }

    if (!config.disableLogs) {
      useLogger({
        logInfo(message) {
          log.info(message)
        },
        logError(message) {
          log.error(message)
        },
      })
    }

    if (pushReceiverFix.result === 'failed') {
      this.log.warn(
        `Could not fix Ring push notifications (${pushReceiverFix.detail}); instant motion and doorbell events may not arrive`,
      )
    } else {
      this.log.info(`Ring push notifications: ${pushReceiverFix.detail}`)
    }

    config.cameraStatusPollingSeconds = config.cameraStatusPollingSeconds ?? 20
    config.locationModePollingSeconds = config.locationModePollingSeconds ?? 20

    // Media resources are platform-wide. Configure the singleton once before
    // cameras are constructed; individual cameras must never overwrite it.
    const { media, ignored } = sanitizeMediaConfig(config)
    for (const setting of ignored) {
      this.log.warn(
        `Ignoring the media setting ${setting.path} (expected ${setting.expectation}); the older setting or the default is used instead. Correct it in the plugin settings.`,
      )
    }
    configureHksvResourceGovernor({
      recordingConcurrency: media.recording.maxConcurrentRecordings,
      queueTimeoutMs: 30_000,
    })
    logInfo(
      `Media profile ${media.profile}: recordingConcurrency=${media.recording.maxConcurrentRecordings}, codec=${media.recording.codec}`,
    )

    this.api.on('shutdown', () => {
      this.shuttingDown = true
      clearTimeout(this.retryTimer)
    })

    this.api.on('didFinishLaunching', () => {
      this.log.debug('didFinishLaunching')
      if (config.refreshToken) {
        void this.connectWithRetry()
      } else {
        this.log.warn(
          'Plugin is not configured. See the README of homebridge-ring-secure-video for setup instructions.',
        )
      }
    })
  }

  private retryTimer?: ReturnType<typeof setTimeout>
  private shuttingDown = false
  private devicesSetUp = false

  /**
   * Connects to Ring, retrying later if Ring can't be reached when Homebridge starts (an outage,
   * a server error), with a fresh connection each time: until then the alarm and every other
   * accessory would stay unconnected. Not retried: an outdated Node.js, a failure once devices
   * were being set up (which would set them up twice), and anything after shutdown.
   */
  async connectWithRetry(attempt = 0): Promise<void> {
    try {
      await this.connectToApi()
    } catch (e) {
      const message = describeError(e)
      if (this.shuttingDown || this.devicesSetUp || isPermanentRingError(e)) {
        this.log.error(`Error connecting to Ring: ${message}`)
        return
      }
      const delay = getRetryDelayMs(attempt)
      this.log.error(
        `Could not connect to Ring (${message}). Trying again in ${Math.round(delay / 1000)} s.${
          message.includes('Refresh token is not valid')
            ? ' If this keeps happening, sign in again in the plugin settings.'
            : ''
        }`,
      )
      this.retryTimer = setTimeout(() => {
        void this.connectWithRetry(attempt + 1)
      }, delay)
    }
  }

  // A separate method so tests can stand in for Ring.
  protected createRingApi(options: ConstructorParameters<typeof RingApi>[0]) {
    return new RingApi(options)
  }

  configureAccessory(accessory: PlatformAccessory) {
    logInfo(
      `Configuring cached accessory ${accessory.UUID} ${accessory.displayName}`,
    )
    this.log.debug('%j', accessory)
    this.homebridgeAccessories[accessory.UUID] = accessory
  }

  async connectToApi() {
    const { api, config } = this,
      shouldRotateRingApiSession =
        config.forceRefreshRingApiSession && config.refreshToken,
      systemId = shouldRotateRingApiSession
        ? rotateSystemId(api.user.storagePath())
        : getSystemId(api.user.storagePath()),
      configuredHomeKitAccessoryTag = config.homeKitAccessoryTag?.trim(),
      accessoryIdSuffix = configuredHomeKitAccessoryTag
        ? `-${configuredHomeKitAccessoryTag}`
        : '',
      accessoryNameSuffix = configuredHomeKitAccessoryTag
        ? ` (${configuredHomeKitAccessoryTag})`
        : '',
      refreshTokenWithoutPushCredentials =
        (config.forceRefreshRingPushCredentials ||
          shouldRotateRingApiSession) &&
        config.refreshToken
          ? removePushCredentialsFromRefreshToken(
            config.refreshToken,
            Boolean(shouldRotateRingApiSession),
          )
          : undefined

    if (shouldRotateRingApiSession) {
      logInfo(
        'Forcing Ring API session refresh because forceRefreshRingApiSession is enabled',
      )
    }

    if (refreshTokenWithoutPushCredentials) {
      logInfo(
        'Forcing Ring push credential refresh because Ring push credentials were removed from the startup token',
      )
    }

    const ringApi = this.createRingApi({
        controlCenterDisplayName,
        ...config,
        ...(refreshTokenWithoutPushCredentials
          ? { refreshToken: refreshTokenWithoutPushCredentials }
          : {}),
        systemId,
      })

    ringApi.onRefreshTokenUpdated.subscribe(
      createRefreshTokenSaver(
        this.api,
        config.refreshToken,
        Boolean(refreshTokenWithoutPushCredentials),
      ),
    )
    // A retry must sign in with the newest token (Ring may have replaced the old one) and must
    // not force a new identity or push registration again.
    ringApi.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
      config.refreshToken = newRefreshToken
      config.forceRefreshRingPushCredentials = false
      config.forceRefreshRingApiSession = false
    })

    let locations, loadedDevices
    try {
      locations = await ringApi.getLocations()
      // Load the devices of every location now: if none can be loaded (a Ring error while
      // connecting to the alarm, say), a retry with a new connection may do better, and nothing
      // has been set up yet. A location that fails while others work is reported below.
      // Loaded once: after a failed connection, ring-client-api's getDevices() waits forever.
      loadedDevices = await Promise.allSettled(
        locations.map((location) => location.getDevices()),
      )
      const firstFailure = loadedDevices.find((result) => result.status === 'rejected')
      if (firstFailure && loadedDevices.every((result) => result.status === 'rejected')) {
        throw firstFailure.reason
      }
    } catch (e) {
      // A retry starts over with a new connection.
      ringApi.disconnect()
      throw e
    }
    if (this.shuttingDown) {
      ringApi.disconnect()
      return
    }
    this.devicesSetUp = true

    const cachedAccessoryIds = Object.keys(this.homebridgeAccessories),
      platformAccessories: PlatformAccessory[] = [],
      externalAccessories: PlatformAccessory[] = [],
      activeAccessoryIds: string[] = []

    logInfo('Found the following locations:')

    locations.forEach((location) => {
      logInfo(`  locationId: ${location.id} - ${location.name}`)
    })

    // One location (or device) that fails to set up must not stop the others, the alarm
    // included; its cached accessories are kept rather than removed as stale.
    const locationResults = await Promise.allSettled(
      locations.map(async (location, locationIndex) => {
        const loaded = loadedDevices[locationIndex]
        if (loaded.status === 'rejected') throw loaded.reason
        const devices = loaded.value,
          { cameras, chimes, intercoms } = location,
          allDevices = [...devices, ...cameras, ...chimes, ...intercoms],
          securityPanel = devices.find(
            (x) => x.deviceType === RingDeviceType.SecurityPanel,
          ),
          debugPrefix = debug ? 'TEST ' : '',
          hapDevices = allDevices.map((device) => {
            const isCamera = device instanceof RingCamera,
              isIntercomVideo =
                device instanceof RingIntercom &&
                device.deviceType === 'intercom_handset_video',
              cameraIdentitySalt =
                isCamera && config.externalCameraIdSalt
                  ? `-${config.externalCameraIdSalt}`
                  : '',
              // 'camera' forces bridged cameras from old plugin version to be seen as "stale"
              // 'intercam' gives Ring Intercom Video a distinct external-accessory UUID
              cameraIdDifferentiator = isCamera
                ? 'camera'
                : isIntercomVideo
                  ? 'intercam'
                  : '',
              AccessoryClass = (
                device instanceof RingCamera
                  ? Camera
                  : device instanceof RingChime
                  ? Chime
                  : device instanceof RingIntercom
                  ? Intercom
                  : getAccessoryClass(device)
              ) as (new (...args: any[]) => BaseAccessory<any>) | null

            return {
              deviceType: device.deviceType as string,
              device: device as any,
              isCamera,
              isIntercomVideo,
              id:
                device.id.toString() +
                cameraIdDifferentiator +
                cameraIdentitySalt +
                accessoryIdSuffix,
              name: device.name + accessoryNameSuffix,
              AccessoryClass,
            }
          }),
          hideDeviceIds = config.hideDeviceIds || [],
          onlyDeviceTypes = config.onlyDeviceTypes?.length
            ? config.onlyDeviceTypes
            : undefined

        if (config.showPanicButtons && securityPanel) {
          hapDevices.push({
            deviceType: securityPanel.deviceType,
            device: securityPanel,
            isCamera: false,
            isIntercomVideo: false,
            id: securityPanel.id.toString() + 'panic' + accessoryIdSuffix,
            name: 'Panic Buttons' + accessoryNameSuffix,
            AccessoryClass: PanicButtons,
          })
        }

        if (
          config.locationModePollingSeconds &&
          (await location.supportsLocationModeSwitching().catch(() => false))
        ) {
          hapDevices.push({
            deviceType: 'location.mode',
            device: location,
            isCamera: false,
            isIntercomVideo: false,
            id: location.id + 'mode' + accessoryIdSuffix,
            name: location.name + ' Mode' + accessoryNameSuffix,
            AccessoryClass: LocationModeSwitch,
          })
        }

        logInfo(
          `Configuring ${cameras.length} cameras and ${hapDevices.length} devices for location "${location.name}" - locationId: ${location.id}`,
        )
        hapDevices.forEach(
          ({
            deviceType,
            device,
            isCamera,
            isIntercomVideo,
            id,
            name,
            AccessoryClass,
          }) => {
            const uuid = hap.uuid.generate(debugPrefix + id),
              displayName = debugPrefix + name
            try {

              if (
                !AccessoryClass ||
                (config.hideLightGroups &&
                  deviceType === RingDeviceType.BeamsLightGroupSwitch) ||
                hideDeviceIds.includes(uuid) ||
                (onlyDeviceTypes && !onlyDeviceTypes.includes(deviceType))
              ) {
                if (!ignoreHiddenDeviceTypes.includes(deviceType)) {
                  logInfo(`Hidden accessory ${uuid} ${deviceType} ${displayName}`)
                }
                return
              }

              if (isCamera && this.homebridgeAccessories[uuid]) {
                // Camera was previously bridged.  Remove it from the platform so that it can be added as an external accessory
                this.log.warn(
                  `Camera ${displayName} was previously bridged. You will need to manually pair it as a new accessory.`,
                )
                this.api.unregisterPlatformAccessories(pluginName, platformName, [
                  this.homebridgeAccessories[uuid],
                ])
                delete this.homebridgeAccessories[uuid]
              }

              let addTo: PlatformAccessory[] | undefined
              const createHomebridgeAccessory = () => {
                  const category = isCamera
                    ? hap.Categories.CAMERA
                    : isIntercomVideo
                      ? hap.Categories.VIDEO_DOORBELL
                      : hap.Categories.SECURITY_SYSTEM

                  const accessory = new api.platformAccessory(
                    displayName,
                    uuid,
                    category,
                  )

                  if (isCamera) {
                    logInfo(
                      `Configured camera ${uuid} ${deviceType} ${displayName}`,
                    )
                    addTo = externalAccessories
                  } else if (isIntercomVideo) {
                    logInfo(
                      `Configured Ring Intercom Video ${uuid} ${deviceType} ${displayName}`,
                    )
                    addTo = externalAccessories
                  } else {
                    logInfo(
                      `Adding new accessory ${uuid} ${deviceType} ${displayName}`,
                    )
                    addTo = platformAccessories
                  }

                  return accessory
                },
                homebridgeAccessory =
                  this.homebridgeAccessories[uuid] || createHomebridgeAccessory(),
                accessory = new AccessoryClass(
                  device as any,
                  homebridgeAccessory,
                  config,
                )
              accessory.initBase()

              // Registered only once set up: a half-built accessory isn't added to HomeKit.
              addTo?.push(homebridgeAccessory)
              this.homebridgeAccessories[uuid] = homebridgeAccessory
              activeAccessoryIds.push(uuid)

              if (
                config.cameraMotionNotificationSensor &&
                accessory instanceof Camera &&
                accessory.motionDetected
              ) {
                const sensorUuid = getMotionNotificationSensorUuid(debugPrefix + id),
                  sensorName = `${displayName} Motion`
                let sensorAccessory = this.homebridgeAccessories[sensorUuid]

                if (!sensorAccessory) {
                  sensorAccessory = new api.platformAccessory(
                    sensorName,
                    sensorUuid,
                    hap.Categories.SENSOR,
                  )
                  logInfo(`Adding motion notification sensor ${sensorUuid} ${sensorName}`)
                }

                setUpMotionNotificationSensor(
                  sensorAccessory,
                  sensorName,
                  `${device.id}-motion`,
                  accessory.motionDetected,
                )
                if (!this.homebridgeAccessories[sensorUuid]) {
                  platformAccessories.push(sensorAccessory)
                }
                this.homebridgeAccessories[sensorUuid] = sensorAccessory
                activeAccessoryIds.push(sensorUuid)
              }
            } catch (e) {
              this.log.error(
                `Could not set up ${displayName} (${deviceType}): ${describeError(e)}. The other accessories are unaffected; restart Homebridge to try again.`,
              )
              const cached = this.homebridgeAccessories[uuid]
              if (cached) markNotResponding(cached)
              // Keep it (and a motion sensor it had) in HomeKit rather than removing it as stale.
              activeAccessoryIds.push(
                uuid,
                getMotionNotificationSensorUuid(debugPrefix + id),
              )
            }
          },
        )
      }),
    )

    const failedLocations = locations.filter(
      (_, i) => locationResults[i].status === 'rejected',
    )
    locationResults.forEach((result, i) => {
      if (result.status === 'rejected') {
        const reason: unknown = result.reason
        this.log.error(
          `Could not set up the devices of location "${locations[i].name}": ${describeError(reason)}. Restart Homebridge to try again.`,
        )
      }
    })

    if (platformAccessories.length) {
      api.registerPlatformAccessories(
        pluginName,
        platformName,
        platformAccessories,
      )
    }

    if (externalAccessories.length) {
      api.publishExternalAccessories(pluginName, externalAccessories)
    }

    // With a location that failed, which cached accessories belong to it is unknown: keep all,
    // showing "No Response" until a restart sets them up.
    if (failedLocations.length) {
      cachedAccessoryIds
        .filter((cachedId) => !activeAccessoryIds.includes(cachedId))
        .forEach((id) => markNotResponding(this.homebridgeAccessories[id]))
    }
    const staleAccessories = failedLocations.length
      ? []
      : cachedAccessoryIds
          .filter((cachedId) => !activeAccessoryIds.includes(cachedId))
          .map((id) => this.homebridgeAccessories[id])

    staleAccessories.forEach((staleAccessory) => {
      logInfo(
        `Removing stale cached accessory ${staleAccessory.UUID} ${staleAccessory.displayName}`,
      )
    })

    if (staleAccessories.length) {
      this.api.unregisterPlatformAccessories(
        pluginName,
        platformName,
        staleAccessories,
      )
    }

  }
}
