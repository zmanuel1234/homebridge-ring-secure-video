<p align="center">
  <img alt="Homebridge x Ring" src="branding/Homebridge_x_Ring.svg" width="500px">
</p>

# homebridge-ring-secure-video

[![npm](https://badgen.net/npm/v/homebridge-ring-secure-video)](https://www.npmjs.com/package/homebridge-ring-secure-video)
[![npm](https://badgen.net/npm/dt/homebridge-ring-secure-video)](https://www.npmjs.com/package/homebridge-ring-secure-video)

`homebridge-ring-secure-video` is a Homebridge platform plugin for Ring devices (alarm, sensors,
locks, lights, cameras and doorbells), with HomeKit Secure Video (HKSV) recording for Ring cameras.
It is meant to replace `homebridge-ring` on its own: one plugin, one Ring sign-in.

## Origin and Attribution

This project is based on Dusty Greif's original Ring Homebridge ecosystem:

- Upstream plugin and API library: [dgreif/ring](https://github.com/dgreif/ring)
  (`homebridge-ring` and `ring-client-api`)

- HKSV fork: [trinityhades/homebridge-ring-hksv](https://github.com/trinityhades/homebridge-ring-hksv), whose history this repository continues

Big thanks to Dusty, trinityhades and all upstream contributors. This plugin reuses and extends that foundation.

## Important Plugin Options

| Option | Purpose |
| --- | --- |
| `enableHksv` | Enables experimental HKSV support for eligible cameras |
| `enableCameraMotionHistory` | Allows camera motion to fall back to recent Ring event history if live notifications are stale; disable to only trust push-triggered motion |
| `disableHksvOnBattery` | Disables HKSV on battery cameras to reduce battery/network usage |
| `hksvPrebufferLengthMs` | HKSV prebuffer duration (minimum 4000ms) |
| `hksvFragmentLengthMs` | HKSV fragment duration target |
| `hksvMaxRecordingSeconds` | Optional safety cap for a recording session (default 180 s; 0 disables) |
| `hksvPerformanceMode` | HKSV tuning profile (`balanced`, `rpi`, or `quality`) |
| `hksvMaxConcurrentRecordings` / `hksvMaxQueuedBytes` | HKSV safeguards for small systems under load |
| `hksvVideoBitrateKbps` / `hksvVideoMaxBitrateKbps` / `hksvVideoBufferSizeKbps` | HKSV recording bitrate controls for improving fast-motion quality |
| `hksvVideoCrf` / `hksvVideoPreset` | Optional libx264 quality and CPU tuning controls |
| `hksvVideoKeyframeInterval` | HKSV recording keyframe interval |
| `homeKitAccessoryTag` | Appends a tag to accessory names and HomeKit IDs so the same Ring device can be exposed as a distinct HomeKit accessory for debugging/testing |
| `cameraVideoCodec` | Preferred H.264 handling (`auto`, `copy`, `h264_v4l2m2m`, `h264_videotoolbox`, or `libx264`) |
| `hideDoorbellSwitch` / `hideCameraMotionSensor` / `hideCameraSirenSwitch` | Hides specific HomeKit-exposed services |
| `cameraMotionNotificationSensor` | Adds a separate "<camera> Motion" sensor per camera for instant motion notifications (see below) |
| `showPanicButtons` | Adds panic switches (use with caution) |
| `ffmpegPath` | Override FFmpeg binary path |
| `debug` | Enables additional logging |
| `disableLogs` | Disables plugin logging |

## v15 media configuration

v15 uses an adaptive media engine that keeps Ring call ownership separate from
each live-view and recording FFmpeg process. Configure `media.profile` as
`adaptive` (default), `lowPower`, or `quality`. Advanced overrides live in
`media.recording`; they are strictly validated and take precedence over legacy
`hksv*` fields, which remain compatibility aliases during migration. Set
`media.recording.maxDurationSeconds` to change its safety cap (default 180 seconds; HomeKit
normally ends a recording itself when motion stops), or to `0` to disable it.

## Installation

If Homebridge is installed globally:

```bash
npm i -g homebridge-ring-secure-video
```

To try a beta, install the `beta` tag instead:

```bash
npm i -g homebridge-ring-secure-video@beta
```

If running from source:

```bash
npm install
npm run build
```

Before a change is merged, CI runs `npm run lint`, `npm run build` and `npm test`, plus
`node .github/scripts/check-homebridge.mjs` (Homebridge plugin rules) and
`node .github/scripts/check-config-schema.mjs` (the settings schema, and every JSON example in
this README). Run them locally the same way.

Releases are published by GitHub Actions when a GitHub release is created: the tag must be
`v<version>` from `package.json`, the release needs notes, `CHANGELOG.md` needs a section for the
version, and "Set as a pre-release" (for a `-beta` version) publishes to the `beta` tag.

## Basic Configuration

Use Homebridge UI (`homebridge-config-ui-x`) when possible.

Add a platform block with your Ring refresh token:

```json
{
  "platform": "Ring Secure Video",
  "refreshToken": "your-refresh-token"
}
```

If you need Home app to treat the same physical Ring device as a different HomeKit accessory, add a `homeKitAccessoryTag`:

```json
{
  "platform": "Ring Secure Video",
  "refreshToken": "your-refresh-token",
  "homeKitAccessoryTag": "Debug Home A"
}
```

Changing `homeKitAccessoryTag` updates both the exposed accessory name and the generated HomeKit identity, which changes the advertised MAC-style identifier shown during manual camera pairing.

## HKSV Status

HKSV support is experimental and actively evolving. Behavior may vary by camera model, wired vs battery power, Ring API changes, and FFmpeg environment.

Verified so far: complete HomeKit clips from a Ring Video Doorbell 3 Plus on a Raspberry Pi 4
(Node 22, Homebridge 2) with the settings below. The HKSV fork this continues reported 3 cameras on an M4 Mac mini.
Please report your experience and setup details to help improve support.

Recordings follow the frame rate and audio format HomeKit asks for, and include audio only when
**Record Audio** is on in the camera's settings in the Home app.

With recording on, the Home app notifies about a camera's motion only after its home hub has
analysed the clip, which can be late or never. For a notification as soon as Ring reports
motion, turn on `cameraMotionNotificationSensor`: each camera gets a separate "<camera> Motion"
sensor on this plugin's bridge. If the bridge isn't in the Home app yet, add it with its pairing
code, then turn on notifications in the sensor's settings (and, if you like, turn off the
camera's own Activity Notifications to avoid two alerts).

For fast-motion pixelation or stuttering in HKSV recordings, try increasing
`hksvVideoBitrateKbps` first if you are transcoding. On Apple Silicon Macs,
`cameraVideoCodec: "h264_videotoolbox"` can reduce CPU load by using hardware
encoding.

For Raspberry Pi 4/5 and other small computers, start with what has been verified on a Pi 4:

```json
{
  "enableHksv": true,
  "media": {
    "profile": "lowPower",
    "recording": { "codec": "libx264", "bitrateKbps": 800 }
  }
}
```

The `lowPower` profile (also chosen by `"hksvPerformanceMode": "rpi"`) records one clip at a
time with conservative settings. Lighter codecs exist but complete HomeKit clips with them are
not verified yet: `copy` (the `lowPower` default for `auto`) remuxes Ring's H.264 without
re-encoding, which only works when Ring's stream meets HomeKit's recording requirements, and
`h264_v4l2m2m` uses the Pi's hardware encoder when FFmpeg has it.

### Minimum specifications for HKSV: 
[TBD - will be added as more users test and report their setups]

## Troubleshooting

For support and debugging:

- This repository issues: <https://github.com/zmanuel1234/homebridge-ring-secure-video/issues>

- Upstream Ring wiki (token/auth/camera references): <https://github.com/dgreif/ring/wiki>

If motion and doorbell events arrive late (the log shows "Detected Motion from Ring event history
fallback" rather than right away), Ring's instant notifications aren't reaching the plugin. At start the
log says which `@eneris/push-receiver` the Ring push client uses ("Ring push notifications: ..."), or
warns "Could not fix Ring push notifications" if the plugin couldn't give it the fixed 4.3.1. See also the upstream [notification troubleshooting](https://github.com/dgreif/ring/wiki/Notification-Troubleshooting).

Use the "Force Ring Push Credential Refresh" and "Force Ring API Session Refresh" settings only as a
last resort, once. Each refresh adds a registration with Ring, and repeated ones can make Ring stop
sending notifications to the plugin. If that happens, remove `homebridge-ring-secure-video` from
Authorized Client Devices in the Ring app's Control Center, create a new refresh token, and paste it
into the plugin's settings.

## Disclaimer

This plugin is not affiliated with Ring or Amazon.

Use emergency/panic-related automations at your own risk.

## License

MIT
