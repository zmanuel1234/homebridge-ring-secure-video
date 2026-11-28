import type { API } from 'homebridge'
import { setHap } from './hap.js'

// The push-receiver fix has to run before Node even reads ring-client-api's imports: Node reads a
// module's whole static import graph before running any of it, and from then on ring-client-api
// holds the PushReceiver class it imported. So it is loaded first, and everything that leads to
// ring-client-api (ring-platform.ts) only after it (see push-receiver-fix.ts).
await import('./push-receiver-fix.js')
const { platformName, RingPlatform } = await import('./ring-platform.js')

export default function (api: API) {
  setHap(api.hap)
  api.registerPlatform(platformName, RingPlatform)
}
