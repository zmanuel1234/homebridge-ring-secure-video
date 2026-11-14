<p align="center">
  <img alt="Ring Secure Video" src="https://raw.githubusercontent.com/zmanuel1234/homebridge-ring-secure-video/main/branding/homebridge-ring-secure-video.svg" width="150">
</p>

# homebridge-ring-secure-video

[![npm](https://badgen.net/npm/v/homebridge-ring-secure-video)](https://www.npmjs.com/package/homebridge-ring-secure-video)
[![npm](https://badgen.net/npm/dt/homebridge-ring-secure-video)](https://www.npmjs.com/package/homebridge-ring-secure-video)

`homebridge-ring-secure-video` is a Homebridge platform plugin for Ring devices (alarm, sensors,
locks, lights, cameras and doorbells), with HomeKit Secure Video (HKSV) recording for Ring cameras.
It is meant to replace `homebridge-ring` on its own: one plugin, one Ring sign-in.

## What it adds to homebridge-ring

Everything `homebridge-ring` exposes is here too, with the same settings, plus:

- **HomeKit Secure Video recording** for Ring cameras and doorbells, with media profiles for small
  machines such as a Raspberry Pi (`media`).
- **Instant motion notifications** with HKSV on: an optional separate motion sensor per camera
  (`cameraMotionNotificationSensor`), so the Home app notifies without waiting for clip analysis.
- **Motion when Ring's push notifications fail**: motion from Ring's event history
  (`enableCameraMotionHistory`), checked often only until push is seen to work.
- **Automatic recovery when Ring stops sending push notifications** (`automaticSessionRefresh`),
  with an optional "Ring Session Refreshed" sensor (`sessionRefreshSensor`) to tell you.
- **A fix for dropped push notifications**: the push library ring-client-api ships (4.3.0) can drop
  them; 4.3.1 is used instead.
- **A second visit is not missed**: a new Ring motion alert while the last one is still active
  (ring-client-api keeps each active for 65 s) is reported to HomeKit as new motion, so it is
  recorded and notified.
- **Ring Intercom Video** as a video doorbell camera, and `homeKitAccessoryTag` to expose the same
  Ring device as a separate HomeKit accessory for testing.
- **Robustness**: one device or location that fails to set up doesn't stop the others; starting
  while Ring can't be reached is retried; a restarted child bridge uses the newest Ring token;
  config.json and the Ring identity are written so a power cut can't cut them short.

## Origin and Attribution

This is an independent project, not a GitHub fork and not maintained by the authors it builds on:

- [`homebridge-ring`](https://github.com/dgreif/ring) by Dusty Greif: this plugin's accessory code
  started from homebridge-ring 14.3.0, and it uses
  [`ring-client-api`](https://www.npmjs.com/package/ring-client-api) 14.3.0 from npm as a
  dependency.
- [`homebridge-ring-hksv`](https://github.com/trinityhades/homebridge-ring-hksv) by trinityhades:
  this plugin continues from its version 15.0.2 (HKSV recording pipeline, Ring Intercom Video).

Changes since then are listed in [CHANGELOG.md](CHANGELOG.md). Thanks to Dusty Greif, trinityhades
and all upstream contributors.

**Please report problems with this plugin
[here](https://github.com/zmanuel1234/homebridge-ring-secure-video/issues), not to dgreif/ring or
trinityhades.**

## Important Plugin Options

| Option | Purpose |
| --- | --- |
| `enableHksv` | Enables HKSV recording for eligible cameras; on by default, set `false` to turn it off |
| `media` | Recording profile (`media.profile`: `adaptive`, `lowPower` or `quality`) and optional recording settings (`media.recording`); see [Media configuration](#media-configuration) and [Recording codecs](#recording-codecs) |
| `enableCameraMotionHistory` | Allows camera motion to fall back to recent Ring event history if push notifications don't arrive. The history is checked every `cameraStatusPollingSeconds` until motion events turn out to come by push too, then every 5 minutes as a safety net (and frequently again once a push is missed, so motion can go unreported for up to 5 minutes after push stops working); disable to only trust push-triggered motion |
| `automaticSessionRefresh` | When Ring's event history shows motion that Ring sent no push notification for (3 events over at least 30 minutes, none pushed), refreshes the Ring API session by itself, as **Force Ring API Session Refresh** does (see Troubleshooting): a child bridge restarts for it, the main bridge does it at the next Homebridge restart. Events while motion is snoozed are not counted, nor, when the camera alerts for people only, events without a person. At most once a day, and no more after 2 refreshes that brought no motion push notification. Needs `enableCameraMotionHistory`. On by default; set `false` to turn it off, for example if Ring is set to send no motion alerts in some Modes or on a schedule |
| `sessionRefreshSensor` | Adds a "Ring Session Refreshed" contact sensor that opens after an automatic session refresh (10 s after the Home app is connected to it, within 3 minutes) and stays open for a day, also across restarts (which don't notify again). Turn on its notifications in the Home app (needs a home hub) to be told when to remove the older `homebridge-ring-secure-video` entry from Authorized Client Devices. Needs `automaticSessionRefresh`. Off by default |
| `disableHksvOnBattery` | Disables HKSV on cameras running on battery to reduce battery/network usage; wired battery models keep it. On by default |
| `homeKitAccessoryTag` | Appends a tag to accessory names and HomeKit IDs so the same Ring device can be exposed as a distinct HomeKit accessory for debugging/testing |
| `hideDoorbellSwitch` / `hideCameraMotionSensor` / `hideCameraSirenSwitch` | Hides specific HomeKit-exposed services |
| `cameraMotionNotificationSensor` | Adds a separate "<camera> Motion" sensor per camera for instant motion notifications (see below) |
| `doorbellPressMotion` | For Ring doorbells with HKSV recording on: a press also turns on the camera's motion for 30 seconds, so HKSV records the visitor even when Ring reported no motion (during a live view, or a quick press-and-leave). One recording per visit, not two. Notifications and automations on the camera's motion sensor also see it; the separate notification sensor does not. No effect with `hideCameraMotionSensor`. Off by default |
| `showPanicButtons` | Adds panic switches (use with caution) |
| `ffmpegPath` | Override FFmpeg binary path |
| `debug` | Enables additional logging |
| `disableLogs` | Disables plugin logging |

## Media configuration

Recording is set up in `media` ("Recording Settings" in the plugin settings). The media engine
keeps the Ring call separate from each live-view and recording FFmpeg process. Set
`media.profile` to `adaptive` (default), `lowPower` or `quality`. Advanced settings live in
`media.recording`; each is validated, and an unusable value is ignored with a warning. Set
`media.recording.maxDurationSeconds` to change its safety cap (default 180 seconds; HomeKit
normally ends a recording itself when motion stops), or to `0` to disable it.

### Settings removed in 1.0.0

The flat recording settings from earlier versions were removed in 1.0.0; `media` replaces each
of them, with the same allowed values (except `hksvPerformanceMode`, whose values are renamed as
shown). A removed setting left in a config is ignored, and the log says which one and what
replaces it: move its value there if it isn't set there yet, then delete it in the JSON editor.
Without `media.profile`, the profile is `adaptive`, so a config that only had
`"hksvPerformanceMode": "rpi"` needs `"media": { "profile": "lowPower" }`.

| Removed setting | Use instead |
| --- | --- |
| `hksvPerformanceMode` (`balanced`, `rpi`, `quality`) | `media.profile` (`adaptive`, `lowPower`, `quality`) |
| `cameraVideoCodec` | `media.recording.codec` |
| `hksvVideoBitrateKbps` / `hksvVideoMaxBitrateKbps` / `hksvVideoBufferSizeKbps` | `media.recording.bitrateKbps` / `maxBitrateKbps` / `bufferSizeKbps` |
| `hksvVideoCrf` / `hksvVideoPreset` | `media.recording.crf` / `preset` |
| `hksvVideoKeyframeInterval` | `media.recording.keyframeInterval` |
| `hksvPrebufferLengthMs` / `hksvFragmentLengthMs` | `media.recording.prebufferLengthMs` / `fragmentLengthMs` |
| `hksvMaxRecordingSeconds` | `media.recording.maxDurationSeconds` |
| `hksvMaxQueuedBytes` / `hksvMaxConcurrentRecordings` | `media.recording.maxQueuedBytes` / `maxConcurrentRecordings` |

`media.recording.rateControl` (`vbr` or `cbr`) had no flat setting.

## Installation

Requires Node.js 22, 24 or 26 and Homebridge 1.8 or later (tested with 2.5; 1.8 is supported but not
tested). If Homebridge is installed globally:

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

Behavior may vary by camera model, wired vs battery power, Ring API changes, and FFmpeg
environment.

Tested: complete HomeKit clips from a Ring Video Doorbell 3 Plus on a Raspberry Pi 4 (Node 22,
Homebridge 2.5) with each of `copy`, `h264_v4l2m2m` and `libx264` (see below). The HKSV fork this
continues reported 3 cameras on an M4 Mac mini. Not tested here: other Ring cameras, battery
cameras, Ring Intercom Video, `h264_videotoolbox` and Homebridge 1.8. Please
[report](https://github.com/zmanuel1234/homebridge-ring-secure-video/issues) how it works with
your setup.

Recordings follow the frame rate and audio format HomeKit asks for, and include audio only when
**Record Audio** is on in the camera's settings in the Home app.

While a live view of the camera is open in the Home app, Ring reports no motion for it: its Event
History shows only the live view (probably also with a live view in the Ring app; not tested). So
no motion event, motion notification or HKSV recording starts during a live view (with Ring
Protect, Ring may still save the live view itself). Once the live view is closed, motion is
reported again. Opening a live view doesn't cut off an HKSV recording that is already running
(both share one Ring connection), but that recording still ends as usual once its motion ends.
With `doorbellPressMotion` on, a doorbell press during a live view still starts a recording:
tested with a Ring Video Doorbell 3 Plus, both with a live view open in the Home app and with one
opened outside the plugin, through Ring (a Brilliant panel's Ring integration). Ring delivered the
press each time, and HomeKit asked for the recording 2 to 3 seconds after the press reached the
plugin. The clip starts only once Ring's video arrives, and the plugin keeps no video from before
an event, so the moment of the press itself isn't in the clip.

With recording on, the Home app notifies about a camera's motion only after its home hub has
analysed the clip, which can be late or never. For a notification as soon as Ring reports
motion, turn on `cameraMotionNotificationSensor`: each camera gets a separate "<camera> Motion"
sensor on this plugin's bridge. If the bridge isn't in the Home app yet, add it with its pairing
code, then turn on notifications in the sensor's settings (and, if you like, turn off the
camera's own Activity Notifications to avoid two alerts).

For fast-motion pixelation or stuttering in HKSV recordings with an encoder (not `copy`), try
increasing `media.recording.bitrateKbps` first. On Apple Silicon Macs, `"codec":
"h264_videotoolbox"` should reduce CPU load by using the hardware encoder (not verified in this
fork).

### Recording codecs

Only HKSV recordings are encoded; live view passes Ring's video through. `media.recording.codec`
chooses how:

| Codec | What it does | CPU |
| --- | --- | --- |
| `copy` | Records Ring's H.264 as received, without re-encoding (Ring's own picture) | Least |
| `h264_v4l2m2m` | Raspberry Pi 4 hardware encoder (the Pi 5 has none) | Low to medium: Ring's video is still decoded and scaled in software |
| `h264_videotoolbox` | Mac hardware encoder (not verified in this fork) | Low |
| `libx264` | Software encoder, with the most control over quality | Most |
| `auto` | Picks one of the above, see below | |

`copy` works when Ring's stream meets HomeKit's recording requirements, as it does for the
Doorbell 3 Plus; if clips from another camera don't appear or don't play, choose an encoder.
`bitrateKbps`, `maxBitrateKbps`, `bufferSizeKbps`, `rateControl` and `keyframeInterval` apply to
all encoders; `preset` and `crf` (the latter only with `vbr`) apply only to `libx264`. `copy`
ignores all of them. The Pi's hardware encoder uses `bitrateKbps` and `keyframeInterval`;
`rateControl` likely makes little difference there.

#### What `auto` picks

`auto` is the default, except in the `lowPower` profile, whose default is `copy`.

| Profile (`media.profile`) | `auto` picks |
| --- | --- |
| `lowPower` | `copy` |
| `adaptive` (default) or `quality` | `h264_v4l2m2m` on Linux with a usable video encoder device (Raspberry Pi 4), else `h264_videotoolbox` on a Mac, else `libx264` |

A hardware encoder is picked only if the FFmpeg that records has it and the computer has the
hardware: `h264_v4l2m2m` needs a Linux video encoder device that Homebridge can open (the Pi 4's
`bcm2835-codec-encode`), so a Raspberry Pi 5, a PC or a NAS gets `libx264`, as does Docker unless
the device is passed through. The log shows the choice for each recording:
`Starting HKSV recording pipeline ... video=<codec>`. If FFmpeg doesn't answer when asked which
encoders it has, an error is logged (the first time) and `auto` records with `libx264` until FFmpeg
is asked again, at the first recording after 5 minutes.

#### Settings verified on a Raspberry Pi 4

Raspberry Pi 4, Ring Video Doorbell 3 Plus (wired), Homebridge 2.5, Node 22, FFmpeg from
ffmpeg-for-homebridge. HomeKit asked for 1280x720 at 30 fps with 4-second fragments; every
setting below gave complete clips that play fully in the Home app.

| Codec | `media` settings | Notes |
| --- | --- | --- |
| `copy` | `{ "profile": "lowPower", "recording": { "codec": "copy" } }` | Least CPU, most natural picture; the recommended start on a Pi |
| `h264_v4l2m2m` | `{ "profile": "lowPower", "recording": { "codec": "h264_v4l2m2m", "bitrateKbps": 1500, "keyframeInterval": 30 } }` | FFmpeg used about 75% of one of the Pi's four cores while recording |
| `libx264` | `{ "profile": "lowPower", "recording": { "codec": "libx264", "bitrateKbps": 800, "keyframeInterval": 112 } }` | The `lowPower` preset is `ultrafast` |

For a Raspberry Pi, start with:

```json
{
  "enableHksv": true,
  "media": {
    "profile": "lowPower"
  }
}
```

## Troubleshooting

For support and debugging:

- This repository issues: <https://github.com/zmanuel1234/homebridge-ring-secure-video/issues>

- Upstream Ring wiki (token/auth/camera references): <https://github.com/dgreif/ring/wiki>

### Motion arrives late or doorbell presses are missed

If motion arrives 20–30 seconds late with "Detected Motion from Ring event history fallback" in the
log (or "Ring event history shows motion no push notification reported"), and doorbell presses don't
reach HomeKit at all, Ring's instant push notifications aren't reaching the plugin. Once they do, the
"...from Ring event history fallback" lines stop, and (with the motion history fallback on, the
default) the log says "Ring push notifications are arriving".

1. Check that the Homebridge machine can reach Google's push service: `mtalk.google.com` must
   resolve to a real address (not `0.0.0.0`; DNS ad blockers such as AdGuard or Pi-hole can block it)
   and TCP port 5228 must be open. See the upstream
   [notification troubleshooting](https://github.com/dgreif/ring/wiki/Notification-Troubleshooting).
2. If the connection is fine, Ring may have stopped sending to the plugin's device identity, even
   though the Ring app on your phone still gets alerts. Removing the plugin from Authorized Client
   Devices and signing in again keeps the same identity (it is stored in `.ring.json`), so it may not
   help. What does: turn on **Force Ring API Session Refresh** in the plugin's settings once, and
   restart. The log then shows "Forcing Ring API session refresh" (and usually "Session hardware_id
   not found" as Ring meets the new identity), and the setting turns itself off once the new sign-in
   is saved. Then, in
   the Ring app's Control Center, remove the older `homebridge-ring-secure-video` entry from
   Authorized Client Devices.

With **Automatic Ring Session Refresh** on (the default) and the motion history fallback on, the
plugin does step 2 by itself when Ring's event history shows 3 motion events over at least 30
minutes that Ring sent no push notification for, and no push arrived in between. Events while
motion is snoozed, and events Ring saw no person in (which Smart Alerts may keep quiet), are not
counted. The log then says "Ring event history shows motion that Ring sent no push notification
for", and as a child bridge it restarts (on the main bridge, the refresh waits for the next
Homebridge restart, and is dropped if a push arrives first). It does this at most once a day, and
stops after 2 refreshes that brought no motion push notification, logging "Ring still sends no
push notifications after 2 automatic Ring session refreshes": then check step 1 and Authorized
Client Devices. If you have Ring send no motion alerts on purpose (for example in some Modes, or on
a schedule), turn the setting off, or the plugin will take the missing alerts for a fault.

Use the "Force Ring ..." settings only for this, and only once. Each API session refresh, automatic
or not, adds an entry to Authorized Client Devices, and many entries can themselves make Ring stop
sending notifications, so after one remove the older `homebridge-ring-secure-video` entry (after
an automatic refresh the log says "Automatic Ring session refresh done", and the optional
`sessionRefreshSensor` opens in the Home app). It also
changes the identity that other Ring plugins in the same Homebridge (such as homebridge-ring) will
use the next time they sign in from scratch, since they share `.ring.json`.

## Disclaimer

- **Unofficial.** This plugin is not affiliated with, endorsed by or supported by Ring LLC, Amazon,
  Apple or the Homebridge project. Ring, HomeKit and other names and logos are trademarks of their
  owners and are used only to describe what the plugin works with.
- **Unsupported Ring API.** It talks to Ring through the same private, undocumented API the Ring app
  uses. Ring can change or block it at any time, and features can stop working without warning.
- **Not a safety device.** Don't rely on it for security, alarm monitoring or emergencies. Motion,
  doorbell presses and recordings can be late or missed (for example while a live view is open, when
  Ring stops sending push notifications, or when the Homebridge host is offline). Use the Ring app
  for anything that matters, and use panic or emergency automations at your own risk.
- **Your Ring sign-in.** The Ring refresh token is stored in Homebridge's `config.json` in plain
  text and gives access to your Ring account. Protect that file and its backups, and remove the
  token from logs or config before sharing them. Each Ring API session refresh (automatic or
  forced) adds an entry under Control Center > Authorized Client Devices in the Ring app; remove
  the older one there. Removing the plugin's current entry signs it out of Ring.
- **Recordings and privacy.** HKSV recordings are processed on your Homebridge host and stored in
  iCloud under Apple's terms. You are responsible for following local laws on recording video and
  audio.
- Provided as is, without warranty. See [LICENSE](LICENSE).

## License

MIT. Copyright Dusty Greif, trinityhades and contributors, and zmanuel1234; see [LICENSE](LICENSE).
