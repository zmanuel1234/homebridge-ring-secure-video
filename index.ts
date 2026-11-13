import type { API } from 'homebridge'
import { setHap } from './hap.ts'

// The push-receiver fix has to run before Node even reads ring-client-api's imports: Node reads a
// module's whole static import graph before running any of it, and from then on ring-client-api is
// tied to its own @eneris/push-receiver 4.3.0. So it is loaded first, and everything that leads to
// ring-client-api (ring-platform.ts) only after it (see push-receiver-fix.ts).
await import('./push-receiver-fix.ts')
const { platformName, RingPlatform } = await import('./ring-platform.ts')

export default function (api: API) {
  setHap(api.hap)
  api.registerPlatform(platformName, RingPlatform)
}
