# Changelog

All notable changes to `HypenSwift` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (Device Capability Protocol — one advertisement rule; provisional API)
- **Advertisement rule** (RFC 001 §2.2, shared with the Android host): a
  capability is advertised iff (1) its hardware is present, (2) the app
  declared what the OS requires (Info.plist usage descriptions), and (3) for
  `bluetooth.scan` and `mic.record`, the host's always-visible indicator can
  be shown right now. What the user granted never enters the rule (an
  un-asked permission is still advertised; no permission history leaks).
  `DeviceAdvertisementRule` + `DeviceAdvertisementEnvironment` hold the
  platform-neutral logic; `DeviceAdvertisementRule.iOSRequirements` is the
  stock table and `DeviceHost(origin:drivers:rule:…)` applies it:
  undeclared capabilities are left out of `hello.device`; hardware and
  indicator readiness gate every `core.capabilities` snapshot, and a fresh
  snapshot is sent whenever the rule's answer changes while connected
  (`DeviceHost.refreshAdvertisement()`: change-only, per socket).
- `DeviceHost.iOS()` no longer advertises `bluetooth.scan` / `mic.record`
  while no foreground scene can show the overlay (previously they were
  advertised and failed `unavailable` at request time); it re-advertises them
  when a scene comes to the foreground. `camera.capture` hardware and
  `mic.record` audio input are probed live
  (`SystemDeviceAdvertisementEnvironment`; audio route changes re-advertise).
  Bluetooth hardware counts as present: probing it shows the permission alert.
- **`DeviceActivityIndicator` gains `isReady` and
  `observeReadiness(_:)`** (source-breaking for app-supplied indicators);
  `DeviceActivityIndicatorSurface` gains `canShow` and `readinessHandler`.
  `UIKitDeviceActivityOverlay` reports every scene connect/disconnect and
  foreground/background transition; `HostDeviceActivityIndicator` also
  reports the overlay being lost.
- `permission.query` and `permission.request` stay advertised and answer a
  permission whose usage description is missing with `unavailable`
  `not-declared:<name>` before reading any status (query previously answered
  the status; request answered `missing-usage-description:<key>` only when
  undetermined). `camera.capture`, `mic.record`, `bluetooth.scan` and
  `bluetooth.select` use the same `not-declared:<name>` detail.

### Added
- **DeviceHost round 3 — capability coverage** (RFC 001 §3, provisional v1):
  - *Typed permissions (P1)*: `DevicePermission` is the closed enum
    `camera | microphone | photos | location | notifications | bluetooth |
    contacts`; any other name (a typo, `geolocation`, a different case) is
    `invalidParams` at decode. `SystemPermissionAuthority` maps every name
    (AVCaptureDevice, AVAudioApplication/AVAudioSession, PHPhotoLibrary,
    CLLocationManager when-in-use, UNUserNotificationCenter, CBManager,
    CNContactStore); an authority that cannot represent one answers
    `unsupported` with the name as `platformDetail` (`supports(_:)`).
  - *file.pick / file.save (C1)*: `FilePickDriver` over
    `UIDocumentPickerViewController(forOpeningContentTypes:)` (`accept` MIME
    types, `type/*` wildcards and extensions → UTType; multiple selection when
    `maxCount > 1`; items declare their size and carry `name`). The picked
    original is never memory-mapped: each file is read under
    `NSFileCoordinator` (iCloud placeholders download first; an already
    oversized one is refused before downloading), size-checked before any
    byte is copied, cloned to a private first-unlock file that is unlinked at
    once, and only the clone is mapped (`DeviceFileClone`,
    `DeviceDocumentLoader`), so a file provider, iCloud or another process
    truncating the original mid-upload cannot SIGBUS the app;
    security-scoped access ends as soon as the clone exists. `gallery.pick`
    and camera video share the same clone helper. `FileSaveDriver` implements the
    server → client download plane: host consent naming the origin, then the
    document exporter as the destination picker (`pendingConsent`), and only
    then a credit grant of one bounded window (≤ 256 KiB, ≤ the declaration),
    replenished per durable write to a temp file; after the host verified
    byte count and SHA-256 the bytes are published to the chosen location and
    the driver answers `{bytesWritten}`. Cancel, deadline, lease expiry,
    detach, write/verification/commit failure delete partial output.
  - *camera.capture (C2)*: `CameraCaptureDriver` over
    `UIImagePickerController` (camera source; photo → `image/jpeg`, video →
    `video/quicktime` with `videoMaximumDuration` from `maxDurationMs`,
    front/back). Needs `camera` (+ `microphone` for video) — undetermined
    permissions go through the OS prompt, refusals are `denied` naming the
    permission; dismissal is `cancelled`. The host enforces that an item's
    media type fits the requested mode.
  - *mic.record (C3)*: `MicRecordDriver` over AVAudioEngine + AVAudioConverter
    → little-endian PCM16 (interleaved stereo when `channels: 2`), one
    `audio/L16` item without a declared size, credit-paced with a bounded
    queue (1 MiB) that ends `throttled` (`capture-buffer-full`) when credit
    starves. Host consent, then the always-visible activity indicator with
    Stop for the whole recording (the microphone opens only once it is
    visible); Stop, `maxDurationMs`, an OS interruption, backgrounding and
    the indicator becoming invisible end it normally with
    `{durationMs, item}`. Advertised by the stock `DeviceHost.iOS()` whenever
    `NSMicrophoneUsageDescription` is present.
  - *Host-owned activity indicator*: `HostDeviceActivityIndicator` over
    `UIKitDeviceActivityOverlay` — a passthrough window above every app
    window (alerts included) on the foreground scene, one pill per running
    stream naming the origin and the host's activity label, with a Stop
    button (VoiceOver-labelled, announced on start). It is the default
    indicator of `DeviceHost.iOS()` (an app-supplied `activityIndicator:`
    still replaces it), so `mic.record` and `bluetooth.scan` no longer depend
    on the app. No foreground scene → the stream fails `unavailable` before
    any hardware opens; the overlay's scene backgrounding or disconnecting
    stops every stream it lists.
  - *bluetooth.select (C4)*: `BluetoothSelectDriver` shows a host-owned
    chooser (`SheetBluetoothChooser`, or the app's own `BluetoothChooser`)
    over a live CoreBluetooth scan filtered by `services` (scan filter) and
    `namePrefix` (exact code points); the result is identity only.
    `BluetoothScannerFactory.makeScanner(services:)` has no default any more
    (a backend that ignored the filter would silently widen it), and every
    discovery now reports its advertised services
    (`BluetoothScanUpdate.discovered(…, services:)`; CoreBluetooth's short
    forms are canonicalised by `DeviceBluetoothUUID`): with a `services`
    filter the driver lists only devices advertising a requested service, and
    a device that reports none is not listed.
  - Registry and payload validation carry `camera.capture@1` and
    `bluetooth.select@1`, `mic.record` `channels`, the permission enum and the
    camera media-type set; `DeviceOperation.onSuspend` lets a driver end
    normally on backgrounding; `DeviceBlobWriter.pendingBytes` exposes queued
    bytes. The shared transcript runner produces uploads incrementally (live
    streams), and the round-3 transcripts are also replayed through the real
    drivers with fakes at the platform seams.
- **Native DeviceHost** (RFC 001, Device Capability Protocol; provisional):
  `RemoteEngine(url:…, device:)` advertises `hello.device`, applies
  `sessionAck.device`, and routes `deviceRequest`/`deviceEvent` JSON and
  12-byte-header binary frames to a `DeviceHost`, which is detached on every
  socket close (and not enabled on a socket that negotiated
  `permessage-deflate`). The host owns leases (`renewLease` → `leaseAck`,
  15 s expiry), cancellation (a live op answers server cancel with
  `cancelled`, then ignores late results), deadline clamp,
  one-prompt-at-a-time admission (`throttled`), capped denial cooldowns
  (persisted across reconnect), strict wire decoding (closed shapes,
  duplicate-key rejection, code-point string bounds, `u32` lease
  sequences), event-credit pacing for JSON streams (held events bounded,
  `core.capabilities` coalesced to the latest snapshot), and credit-paced blob
  upload: frames are cut lazily from each item and sized to
  `min(64 KiB, remaining credit)`, with `paused` transitions, SHA-256, and a
  256 KiB pending bound. Drivers: `core.capabilities`, `gallery.pick`
  (PHPicker via `loadFileRepresentation`, size-checked before reading and
  memory-mapped; no library permission), `permission.query`/
  `permission.request` (camera, microphone, photos, notifications,
  bluetooth), `bluetooth.scan` (CoreBluetooth, foreground; under an
  always-visible `DeviceActivityIndicator` with a stop control — since round
  3 the host's own by default).
  `DeviceHost.iOS(origin:activityIndicator:)` wires the iOS backends. Device-
  enabled servers' `sessionAck.resumeToken` is kept in memory (never logged)
  and sent as `hello.resumeToken` when resuming that session. The protocol
  core is platform-agnostic and unit-tested (`DeviceHostTests.swift`, also
  runnable under Linux XCTest).
- **Video v2** (`hypen-docs/content/docs/guide/components.mdx` §"Playback control & composition
  slots"): a `VideoPlayerStateMachine` derives the normative
  `idle/loading/playing/paused/ended/error` state from AVPlayer signals;
  `.bind(@state.playback)` reports `{playing, position, duration, state}`
  back as per-key `__hypen_bind` writes (position throttled to 250 ms,
  transitions immediate) and applies inbound writes as play/pause/seek
  (1 s seek epsilon + clamp + last-reported echo guard); `startPosition`
  seeks once when the item becomes ready; `.slot("controls"|"loading"|
  "error"|"poster")` children overlay the player full-bleed, shown/hidden
  strictly per the spec's visibility table without ever being unmounted;
  and a new `Scrubber` component drives the enclosing player renderer-side
  (local drag preview, commit on release, VoiceOver-adjustable ±5 s).
  All the logic is pure and unit-tested in `VideoPlayback.swift`.

- Animation protocol relay (no playback yet): `Patch` now carries the
  deferred-remove `transition` flag and parses the `batchAnimation`
  prelude's `spec` instead of dropping the whole patch as an unknown
  type. `HypenRenderer` exposes the batch stamp as
  `currentBatchAnimation` (index 0 only) and surfaces the exit flag in
  `applyRemove`. Every channel still snaps — the sanctioned degradation;
  see `ANIMATION.md` for the implementation contract.

### Changed (Device Capability Protocol, round 2; provisional API)
- **Strict JSON everywhere on the device plane** (RFC 001 §2.1, D4):
  `DeviceStrictJSON.parse` is now a complete validator that yields a
  `DeviceJSON` tree, and every typed device decode reads that tree through
  an internal tree decoder — `JSONDecoder` no longer sees device input. It
  enforces the shared limits: 1 MiB before parsing, depth ≤ 32, integer
  tokens only (`1.0`, `1e0`, `-0`, 17+ digits, > 2^53−1 rejected), valid
  UTF-8 with no raw control characters or lone surrogate escapes in keys and
  values, duplicate keys at any depth. A malformed object key can no longer
  reach FoundationEssentials' `try!` key path (a one-message app kill).
  `sessionAck.device` is decoded from the ack's exact text under the same
  limits. Text breaking the limits names no request: it is dropped and
  counted (D3/D8), and repeated violations close the connection
  (`Options.maxConnectionViolations`).
- **Connection model and violation reactions** (D8, shared transcripts):
  an app request before `core.capabilities`, or a second live core stream,
  closes the connection (`DeviceTransport.closeDeviceConnection`); a
  request outside the live selection is `unsupported`; the live selection
  follows the snapshots the core stream actually sends
  (`setAvailable(_:_:)` / `setUnavailable(_:)`); `activationId` may not go
  backwards per module instance; renewals start at 1 and strictly increase;
  a server `deviceResponse`, `paused` on an upload, or any other
  wrong-direction message on a live id ends that id with `invalidParams`.
- **The ack is validated against the advertisement** (§2.2, #11): no common
  protocol or no `core.capabilities@1` keeps the device plane off; entries
  never offered, and binary-plane revisions on a `binary:false` ack, are
  dropped. Duplicate capability names are invalid in hello, ack and
  snapshots, compared by exact code points (D7).
- **Blob sizes are optional** (D5): `DeviceBlob(declaresSize:itemFields:)`
  and the new live-item API `DeviceOperation.openBlob(contentType:
  declaredBytes:)` → `DeviceBlobWriter` stream items of unknown length
  (microphone, transcoding): `blobStart` omits `bytes`, `maxItemBytes` is
  enforced as bytes are written, and the terminal item always states the
  actual size and SHA-256 (incremental on every platform). `mic.record`
  results carry `item`; `file.pick` items carry extra fields such as `name`.
- **Empty items send no frame** (D2): `blobStart{bytes:0}` and the empty-
  string hash; the TS broker rejects every zero-length frame.
- **Downloads** (`file.save` core support): `grantDownload`,
  `onDownloadChunk`, `onDownloadComplete`; frames are checked for direction,
  size, channel, seq, credit and the declared size, and the SHA-256 is
  verified before a driver may succeed.
- **Driver API**: `progress(_:)` (credit-free, never back to
  `pendingConsent`), `onEnd(_:)` (runs once on every ending), cleanup
  registered with `onCancel` before `succeed(…, blobs:)` now runs if the
  upload is cancelled (#7), `markUserChoiceMade()` exempts loading picked
  items from host suspension, and `simulated:` for fakes. Invalid driver
  events/results end the request `internal` instead of reaching the wire.
- **Origin binding** (#6): `DeviceHost(origin: nil)` / `DeviceHost.iOS()`
  bind prompts and grants to each socket's own origin; a configured origin
  refuses a socket that reaches another one (`attach` returns false).
- **RemoteEngine socket identity** (#3): every socket carries a
  generation; stale opens, closes and receives are ignored, a socket's end
  schedules at most one reconnect, `connect()` is a no-op while connecting
  or reconnecting, and each receive loop is bound to its own socket.
- **Native admission** (D1): `RemoteEngineConfig(upgradeHeaders:
  upgradeHeaderProvider: origin:)` sets upgrade headers (e.g.
  `Authorization`) on a `URLRequest`; no `Origin` is sent unless configured.
- **PHPicker** (#8/#9/#10): the prompt slot is released at
  `didFinishPicking` (new `GalleryPicker` `selected` callback), item loading
  is cancelled with its `Progress`, a refused UIKit presentation reports
  `unavailable` at once (`DeviceConsentOutcome`, `GalleryPickOutcome
  .presentationFailed`), load errors send `load-failed:<domain>:<code>`
  instead of the OS error text, and the memory-mapped clone uses
  first-unlock data protection.
- `SystemDeviceClock` timers re-check `CLOCK_MONOTONIC` in ≤ 1 s slices, so
  deadlines stay measured from receipt across device sleep (#13).
- The resume token is hidden from `dump`/`Mirror`, and unparseable server
  frames are logged by size only (#13).
- `HypenView(url:config:device:)` attaches a DeviceHost (#13).
- Tests: the shared corpora (`messages.json` incl. handshake cases,
  `payloads.json`, `selection.json`, `frames.json`, `registry-v1.json`) and
  all 105 transcripts replay against the iOS host with no skips
  (`DeviceTranscriptTests.swift`), plus `DeviceHostRound2Tests.swift`.

### Fixed
- Video `onEnded.completed` on a playlist is now `isLast && !loop`, so a
  wrapping queue reports `completed: false` (matches DOM/canvas/Android/
  desktop; iOS was the outlier).
- A looping single-source Video no longer dispatches `onEnded` on every
  lap — it loops silently, native-style, exactly like the DOM's `el.loop`.
- No more spurious `onPause`: pausing at the end of an item is part of the
  ended transition, and a rebuffer re-enters `loading` instead of pausing.

## [0.4.32] - 2026-02-19

### Added
- Initial changelog for the iOS/SwiftUI renderer
