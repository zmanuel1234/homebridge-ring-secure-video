// Stand-ins shared by the tests.
import type { RtpSplitter } from '@homebridge/camera-utils'
import type { Accessory, Service, WithUUID } from '@homebridge/hap-nodejs'
import type { PlatformAccessory } from 'homebridge'
import { RingCamera, type AnyCameraData, type PushNotification } from 'ring-client-api'
import { Subject } from 'rxjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { TestContext } from 'node:test'
// Not public rxjs API, but the only way to give rxjs mock-timer-friendly intervals.
import { intervalProvider } from 'rxjs/internal/scheduler/intervalProvider'
import { CameraSource } from '../src/camera-source.js'
import type { RingPlatformConfig } from '../src/config.js'

/** A HomeKit answer callback: called with an error, or nothing when it worked. */
export type Answer = (error?: unknown) => void

/** A live view's session, as the tests reach into it (CameraSource keeps its sessions private). */
export interface TestSession {
  stop(): void
  activate(request: unknown): Promise<void>
  audioSplitter: RtpSplitter
  transcodedAudioSplitter: RtpSplitter
  listenForAudioPackets(request: unknown): void
  [member: string]: unknown
}

/**
 * A CameraSource's private parts, as the tests set them up or read them. Methods take the HAP
 * requests the tests build by hand.
 */
export interface CameraSourceInternals {
  ringCamera: unknown
  sessions: Record<string, TestSession>
  mediaIngress: unknown
  controller: unknown
  config: unknown
  prepareStream(request: object, callback: Answer): unknown
  shutdown(): void
  handleStreamRequest(request: object, callback: Answer): unknown
  [member: string]: unknown
}

/** A CameraSource without its constructor (no Ring camera, no HomeKit controller): the test sets what it needs. */
export function bareCameraSource(): CameraSourceInternals {
  return Object.create(CameraSource.prototype) as CameraSourceInternals
}

/** The same object, seen with its private parts (what a test reaches into). */
export function internals<T>(value: unknown): T {
  return value as T
}

/** A stand-in (a fake Ring device, a log): only what the code under test uses, typed as the real thing. */
export const fake: <T>(value: object) => T = internals

/** The plugin's settings for a test: only those it sets, the rest as the plugin finds them missing. */
export function config(settings: Partial<RingPlatformConfig> & { platform?: string } = {}): RingPlatformConfig {
  return settings as RingPlatformConfig
}

/** A config as a user may have written it, possibly with settings that are wrong or unknown. */
export const rawConfig: (value: object) => RingPlatformConfig = fake

/**
 * A Homebridge accessory around a HAP accessory, as Homebridge's own PlatformAccessory wraps one:
 * the services the plugin adds land on `hap`, where the test reads them.
 */
export function platformAccessory(hap: Accessory, displayName: string = hap.displayName, context: Record<string, unknown> = {}): PlatformAccessory {
  return fake<PlatformAccessory>({
    displayName,
    UUID: hap.UUID,
    context,
    get services() {
      return hap.services
    },
    getService: hap.getService.bind(hap),
    getServiceById: hap.getServiceById.bind(hap),
    addService: hap.addService.bind(hap),
    removeService: hap.removeService.bind(hap),
    configureController: hap.configureController.bind(hap),
  })
}

interface FakeInterval {
  timer?: NodeJS.Timeout
  cleared: boolean
}

/**
 * Mock timers (setTimeout and Date, from `now` if given) that rxjs's intervals follow too: Node's
 * mock setInterval keeps firing after it was cleared, so rxjs gets intervals built from the mocked
 * setTimeout, for this test only.
 */
export function useMockFriendlyIntervals(t: TestContext, now?: number): void {
  t.mock.timers.enable(now === undefined ? { apis: ['setTimeout', 'Date'] } : { apis: ['setTimeout', 'Date'], now })
  intervalProvider.delegate = {
    setInterval(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) {
      const interval: FakeInterval = { cleared: false }
      const schedule = () => {
        interval.timer = setTimeout(() => {
          if (interval.cleared) return
          schedule()
          handler(...args)
        }, timeout)
      }
      schedule()
      return fake<ReturnType<typeof setInterval>>(interval)
    },
    clearInterval(handle) {
      const interval = internals<FakeInterval>(handle)
      interval.cleared = true
      clearTimeout(interval.timer)
    },
  }
  t.after(() => {
    intervalProvider.delegate = undefined
  })
}

/** A service the plugin must have added to the accessory (by type, and subtype if given). */
export function serviceOf(hap: Accessory, type: WithUUID<typeof Service>, subtype?: string): Service {
  const service = subtype === undefined ? hap.getService(type) : hap.getServiceById(type, subtype)
  assert.ok(service, `${hap.displayName} has no ${type.name}${subtype === undefined ? '' : ` (${subtype})`}`)
  return service
}

/**
 * A real ring-client-api RingCamera on a fake REST client (it never reaches Ring): `data` is the
 * camera as Ring's API would list it (only the fields the test needs).
 */
export function ringCamera(data: object, isDoorbot = true): RingCamera {
  const restClient = { onSession: new Subject(), request: async () => ({}) }
  return new RingCamera(fake<AnyCameraData>(data), isDoorbot, fake<ConstructorParameters<typeof RingCamera>[2]>(restClient), false)
}

/** A push notification as ring-client-api receives it from Ring (only the fields the test needs). */
export const pushNotification: (value: object) => PushNotification = fake

/** One setting in config.schema.json (the parts the tests read). */
export interface SchemaField {
  type?: string
  default?: unknown
  properties?: Record<string, SchemaField>
  [key: string]: unknown
}

/** The plugin's config.schema.json. */
export const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8')) as {
  pluginAlias: string
  schema: { properties: Record<string, SchemaField> }
  [key: string]: unknown
}
