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
import {
  PushHealthMonitor,
  type PushRecoveryState,
  readPushRecoveryState,
  writePushRecoveryState,
} from './push-health.ts'
import { readFileSync } from 'fs'
import {
  getSessionRefreshSensorUuid,
  SessionRefreshSensor,
} from './session-refresh-sensor.ts'
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
import { getRemovedSettings, sanitizeMediaConfig } from './media-config.ts'
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
          (platform.platform === platformName ||
            platform.platform === `${pluginName}.${platformName}`) &&
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
 * This platform's block as saved in config.json now, if exactly one block matches and it has a
 * Ring token.
 *
 * Homebridge restarts a child bridge with the config it read when it started, not the one in
 * config.json now: after a renewal the token it hands over is out of date (and replacing it in
 * config.json would then fail), and a force setting cleared since would be on again. The block is
 * this child bridge's, or the one on the main bridge.
 */
export function getSavedPlatformConfig(
  api: API,
  config: PlatformConfig,
): (PlatformConfig & RingPlatformConfig & { refreshToken: string }) | undefined {
  try {
    // Homebridge upper-cases the username it hands over; config.json may have it either way.
    const username = config._bridge?.username?.toUpperCase(),
      blocks = (JSON.parse(readFileSync(api.user.configPath()).toString()).platforms ?? []).filter(
        (block: PlatformConfig) =>
          (block.platform === platformName ||
            block.platform === `${pluginName}.${platformName}`) &&
          (username
            ? String(block._bridge?.username ?? '').toUpperCase() === username
            : !block._bridge),
      )
    const block = blocks.length === 1 ? blocks[0] : undefined
    return typeof block?.refreshToken === 'string' && block.refreshToken ? block : undefined
  } catch {
    return undefined
  }
}

function clearRefreshPending(storagePath: string, update: PushRecoveryState = {}) {
  const state = readPushRecoveryState(storagePath)
  if (state.refreshPending) {
    writePushRecoveryState(storagePath, { ...state, ...update, refreshPending: false })
  }
}

/**
 * False for a token ring-client-api built from a Ring sign-in response without a refresh token
 * (its `rt`). Saving one would make every later start fail with invalid_grant until signing in
 * again, while the token it replaces may still work (dgreif/ring#1886). A token that isn't
 * ring-client-api's JSON form (an old plain refresh token) can't be checked and counts as valid.
 */
export function hasRingRefreshToken(token: string) {
  try {
    const auth = JSON.parse(Buffer.from(token, 'base64').toString())
    if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
      return typeof auth.rt === 'string' && auth.rt !== ''
    }
  } catch {
    // Not ring-client-api's JSON form.
  }
  return token !== ''
}

let reportedTokenWithoutRt = false

function isUsableNewToken(token: string) {
  if (hasRingRefreshToken(token)) return true
  if (!reportedTokenWithoutRt) {
    reportedTokenWithoutRt = true
    logError(
      'Could not read a refresh token in Ring\'s sign-in response (this can happen with an unsupported Node.js version); the previous Ring token is kept (in config.json and for reconnecting). If this repeats, check the Node.js version and update the plugin, then sign in again in the plugin settings if needed.',
    )
  }
  return false
}

/**
 * Saves each new Ring refresh token into config.json, replacing the token that is there now.
 *
 * The token in config.json is tracked here rather than taken from ring-client-api's
 * "oldRefreshToken": after a forced refresh, ring-client-api starts from a modified token that
 * was never written to config.json, and following its old token would save only the first new
 * token and none after it (so the next start would register with Ring again). onSaved is called
 * after the first save.
 */

export function createRefreshTokenSaver(
  api: API,
  tokenInConfig: string | undefined,
  clearRefreshFlags: boolean,
  onSaved?: () => void,
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
    if (!replace || newRefreshToken === replace || !isUsableNewToken(newRefreshToken)) {
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
      const firstSave = onSaved
      onSaved = undefined
      firstSave?.()
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
        `Ignoring the media setting ${setting.path} (expected ${setting.expectation}); the default is used instead. Correct it in the plugin settings.`,
      )
    }
    for (const { removed, replacement } of getRemovedSettings(config)) {
      this.log.warn(
        `The setting ${removed} was removed in 1.0.0 and is ignored: move its value to ${replacement} (Recording Settings) if it isn't set there yet, then delete ${removed} in the JSON editor (Config tab).`,
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
      this.sessionRefreshSensor?.stop()
    })

    if (config.automaticSessionRefresh !== false) {
      this.pushHealth = new PushHealthMonitor(api.user.storagePath(), () =>
        this.refreshSessionAutomatically(),
      )
    }

    this.api.on('didFinishLaunching', () => {
      this.log.debug('didFinishLaunching')
      const saved = config.refreshToken ? getSavedPlatformConfig(api, config) : undefined
      if (saved) {
        if (saved.refreshToken !== config.refreshToken) {
          this.log.info('Using the newer Ring token saved in config.json')
          config.refreshToken = saved.refreshToken
        }
        config.forceRefreshRingPushCredentials = Boolean(saved.forceRefreshRingPushCredentials)
        config.forceRefreshRingApiSession = Boolean(saved.forceRefreshRingApiSession)
      }
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
  private pushHealth?: PushHealthMonitor
  private gotNewToken = false
  private sessionRefreshSensor?: SessionRefreshSensor
  private readonly startedAt = Date.now()

  /**
   * Ring has stopped sending push notifications: the session is refreshed at the next start (see
   * connectToApi). A child bridge restarts itself for that; Homebridge starts it again at once.
   */
  private refreshSessionAutomatically() {
    if (this.shuttingDown) return
    const reason =
      'Ring event history shows motion that Ring sent no push notification for (3 events over at least 30 minutes, none pushed)'
    if (this.config._bridge && typeof process.send === 'function') {
      this.log.warn(
        `${reason}; restarting this child bridge to refresh the Ring API session (turn off "Automatic Ring Session Refresh" to stop this)`,
      )
      this.restartChildBridge()
    } else {
      this.log.warn(
        `${reason}; the Ring API session will be refreshed the next time Homebridge restarts (run the plugin as a child bridge to have this done automatically)`,
      )
    }
  }

  // A separate method so tests can stand in for it. Homebridge's own shutdown (SIGTERM) stops
  // the accessories cleanly, and a child bridge that ends that way is started again at once.
  protected restartChildBridge() {
    process.kill(process.pid, 'SIGTERM')
  }

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
      storagePath = api.user.storagePath(),
      // Asked for by the push check (refreshSessionAutomatically) before the last restart.
      refreshPendingInState = Boolean(readPushRecoveryState(storagePath).refreshPending),
      // Like the force settings, not again on a retry once Ring has given a new token.
      automaticRefresh =
        Boolean(this.pushHealth) && refreshPendingInState && !this.gotNewToken,
      shouldRotateRingApiSession =
        (config.forceRefreshRingApiSession || automaticRefresh) && config.refreshToken,
      systemId = shouldRotateRingApiSession
        ? rotateSystemId(storagePath)
        : getSystemId(storagePath),
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
        automaticRefresh && !config.forceRefreshRingApiSession
          ? 'Forcing Ring API session refresh because Ring stopped sending push notifications (automatic session refresh)'
          : 'Forcing Ring API session refresh because forceRefreshRingApiSession is enabled',
      )
    }

    // Until its new token is saved, a push must not drop this run's refresh: the next start
    // would sign in with the old token again.
    if (automaticRefresh) this.pushHealth?.setHoldPending(true)
    // Asked for while the setting was on: not done later on old evidence once it is back on.
    if (refreshPendingInState && !this.pushHealth) {
      clearRefreshPending(storagePath)
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
        // Cleared once the new identity's token is saved: until then the next start would
        // sign in with the old one.
        automaticRefresh
          ? () => {
            const doneAt = Date.now()
            this.pushHealth?.setHoldPending(false)
            clearRefreshPending(storagePath, { refreshDoneAt: doneAt })
            // Usually saved while connecting, before the sensor is set up (which then reads
            // refreshDoneAt); this covers a save after that.
            this.sessionRefreshSensor?.show(doneAt)
            this.log.warn(
              'Automatic Ring session refresh done: in the Ring app, Control Center > Authorized Client Devices now lists homebridge-ring-secure-video twice. Remove the older entry (keep the newest).',
            )
          }
          : undefined,
      ),
    )
    // A retry must sign in with the newest token (Ring may have replaced the old one) and must
    // not force a new identity or push registration again.
    ringApi.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
      // A broken token is not kept for reconnecting either (see hasRingRefreshToken).
      if (!isUsableNewToken(newRefreshToken)) return
      config.refreshToken = newRefreshToken
      config.forceRefreshRingPushCredentials = false
      config.forceRefreshRingApiSession = false
      this.gotNewToken = true
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
                  this.pushHealth,
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

    // Opens after an automatic session refresh, so the Home app can notify.
    if (this.pushHealth && config.sessionRefreshSensor) {
      const sensorUuid = getSessionRefreshSensorUuid(
          `${debug ? 'TEST ' : ''}ring-secure-video${accessoryIdSuffix}`,
        ),
        sensorName = `Ring Session Refreshed${accessoryNameSuffix}`
      let sensorAccessory = this.homebridgeAccessories[sensorUuid]
      if (!sensorAccessory) {
        sensorAccessory = new api.platformAccessory(sensorName, sensorUuid, hap.Categories.SENSOR)
        logInfo(`Adding session refresh sensor ${sensorUuid} ${sensorName}`)
        platformAccessories.push(sensorAccessory)
        this.homebridgeAccessories[sensorUuid] = sensorAccessory
      }
      this.sessionRefreshSensor = new SessionRefreshSensor(
        sensorAccessory,
        sensorName,
        this.startedAt,
      )
      this.sessionRefreshSensor.show(readPushRecoveryState(storagePath).refreshDoneAt)
      activeAccessoryIds.push(sensorUuid)
    }

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
