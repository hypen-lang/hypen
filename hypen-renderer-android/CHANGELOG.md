# Changelog

All notable changes to `hypen-renderer-android` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Device Capability Protocol DeviceHost (RFC 001, provisional) in
  `renderer/.../device/`. Protocol core (JVM-testable, no Android imports):
  12-byte frame codec, closed-schema envelope parsing, `sessionAck.device`
  validation, per-socket `DeviceConnection` (monotone request ids, lease acks
  echoing `renewLease`, client lease expiry → `connectionLost`, local deadline maximum,
  server cancel → one `cancelled` terminal with the late driver result
  suppressed, credit-paced 64 KiB upload frames with sha256 items, JSON event
  credit with per-key coalescing, teardown on socket close), host-wide prompt
  gate (`throttled`), denial/dismissal cooldowns and persistable consent
  grants. Drivers: `core.capabilities`, `gallery.pick` (system photo
  picker), `permission.query` / `permission.request`, `bluetooth.scan`
  (`BluetoothLeScanner`, host consent dialog, BLUETOOTH_SCAN on API 31+).
  `AndroidDeviceHost.create(activity, url)`; `RemoteEngine(deviceHost = …)` /
  `HypenApp(deviceHost = …)` advertise it in `hello.device` only on an
  uncompressed socket, or one whose permessage-deflate has no context
  takeover in both directions (see Changed), and route device JSON and binary
  frames to it.
- DeviceHost hardening (RFC 001 review): strict device JSON at the socket
  edge (`StrictDeviceJson`: duplicate keys at any depth, depth > 64 and
  oversize text are refused; `1.0`/`1e0`/`-0` are never integers) routed to
  `DeviceConnection.handleMalformed` (a fresh request id is consumed and
  refused `invalidParams`, a live id terminates); envelope bounds from the
  shared schema (`activationId` 1..u32, non-empty `moduleInstanceId` /
  `capability`, `timeoutMs` ≤ 86 400 000, `initialCredit` ≤ 4 MiB, `grant`
  1..8 MiB, `renewLease`/`leaseAck` 1..u32); `timeoutMs` above the selected
  revision's maximum is refused `invalidParams` instead of being clamped
  (the local maximum still shortens deadlines); string bounds and truncation
  in code points (BLE ids/names never split a surrogate pair);
  `sessionAck.device` with a duplicate capability name or a version outside
  1..u32 disables the plane, binary-plane revisions are dropped when
  `binary` is false. Inbound memory: the per-connection inbox is bounded by
  messages (8192) and bytes (8 MiB) and closes 1008 only on a real bound
  violation; device JSON, the ack and binary frames go straight from the
  socket reader into it; server → client frames are copied only up to their
  header unless a download operation is live, and frames over 64 KiB + 12
  are violations. Resume credential: `sessionAck.resumeToken` is stored and
  sent as `hello.resumeToken` whenever that session id is resumed
  (`SessionOptions.resumeToken` / `SessionInfo.resumeToken`), cleared on
  `sessionExpired`, redacted from `toString`, never logged.
  `bluetooth.scan` now requires a host-owned indicator with a Stop control
  (`DeviceActivityIndicator`; default `ComposeDeviceActivityIndicator`
  drawn by `HypenApp` / `DeviceActivityOverlay`) and is advertised only
  while one is ready; Stop ends the scan `cancelled`. BLE preconditions per
  API level (Location Services on ≤ 30, and fine location + Location
  Services on 31+ without `neverForLocation`) answer `unavailable`.
  Permission status is `prompt` (not `denied`) when the rationale is unknown
  without a foreground Activity. Prompts never hold the host-wide gate past
  their Activity: pickers/permission dialogs re-register their result key on
  the recreated Activity (or settle `cancelled` if it finishes or is not
  recreated within 30 s), and the consent dialog settles on Activity
  destroy. Consent dialog: back/outside tap → `cancelled` without cooldown,
  partially obscured touches dropped on API 29+, and a visible
  development-mode notice for `ws://` origins (also shown by the overlay).
  Gallery sizes come from `openAssetFileDescriptor().length`, spooling when
  unknown. `AndroidDeviceHost.create` is documented as Application-scoped;
  `HypenApp(disposeDeviceHost = true)` binds a host to the composition.
- Device Capability Protocol round 3 (RFC 001 C1–C4; `device/CaptureDrivers.kt`,
  `device/CaptureSupport.kt`, `device/android/CapturePlatforms.kt`,
  `device/android/BluetoothChooserDialog.kt`), advertised by
  `AndroidDeviceHost.create` by default:
  - `file.pick` via `ACTION_OPEN_DOCUMENT` (`EXTRA_MIME_TYPES` from `accept`
    — MIME types, `type/` wildcards, extensions via `MimeTypeMap`;
    `EXTRA_ALLOW_MULTIPLE` when `maxCount > 1`), items named from
    `DISPLAY_NAME`, sizes declared when known, picked items re-matched
    against `accept` (outside ones dropped; none left → `cancelled`).
  - `file.save` via the host consent dialog, then `ACTION_CREATE_DOCUMENT`
    (sanitized suggested name + MIME), and the server → client DOWNLOAD
    plane: no credit until the destination is chosen, then a window of at
    most 256 KiB (≤ `maxOutstandingCredit`, ≤ the declared size) replenished
    only as bytes are written to the `Uri`; the runtime enforces seq /
    64 KiB / non-empty / credit / declared size and verifies SHA-256 before
    `{bytesWritten}`. Cancel, deadline, lease, detach, a violation or a
    write failure delete the partial document (`DocumentsContract.
    deleteDocument`, truncation when the provider refuses). Frames whose
    header names a live download now reach the host whole at the socket
    edge (every other frame is still copied header-only).
  - `camera.capture` via `TakePicture` / `CaptureVideo` (subclassed for the
    facing hint extras and `EXTRA_DURATION_LIMIT`) into a temp file shared
    through the library's own `HypenDeviceFileProvider` (declared in the
    renderer manifest, authority `${applicationId}.hypen.device.files`,
    cache-only paths, stale files swept); the media type is sniffed from the
    bytes and must fit the mode (the runtime also refuses a mismatched
    announcement); CAMERA (+ RECORD_AUDIO for video) is requested through
    the OS flow whenever the app declares it; refusal `denied`, dismissal
    `cancelled`.
  - `mic.record` via `AudioRecord` `ENCODING_PCM_16BIT` (remixed/resampled
    when the device cannot capture the requested rate/channels natively):
    host consent per use, RECORD_AUDIO, then the always-visible recording
    indicator with Stop (`ComposeDeviceActivityIndicator`); `audio/L16`
    frames sent as captured without a declared size, credit-paced with a
    bounded 1 MiB window (overflow → `throttled` `capture-buffer-full`);
    Stop, the indicator becoming invisible, `maxDurationMs` (or the 64 MiB
    item cap) and backgrounding end it normally with `{durationMs, item}`;
    reaching the limit stops the microphone and hides the indicator at once,
    even while the server withholds credit (the captured bytes then upload
    as credit arrives).
  - `bluetooth.select` via a host-owned `AlertDialog` chooser over a live BLE
    scan filtered by `services` (all must be advertised) and `namePrefix`
    (exact code points), input-armed and overlay-guarded; identity-only
    result; Cancel `cancelled`, adapter off `unavailable`.
  - Runtime additions: live blob sources (`DriverBlob.live`), result fields
    computed after the upload, `DriverContext.onEnd` / `abort` /
    `onHostSuspend` (a recording ends normally on suspension instead of
    `cancelled`), `grantDownload` returns what it granted; the shared
    corpus (registry, payloads, transcripts incl. live mic streams fed frame
    by frame) replays with no skips.
- Drag and drop (`hypen-web/docs/dnd.md`, the `__dnd.*`
  channel). A renderer-resident runtime in `renderer/.../dnd/`:
  `DndCoordinator` (the pure state machine — activation plans, zone
  resolution against rendered rects, the FLIP-style sortable preview,
  `lifted`/`over` poses, the §4.2 drop commit `reserved write → .onSort /
  .onPin / .onDrop → .onDragEnd`, the hold-until-`Move` release, the
  translate-deferral gate, silent cancel on `Remove`/`Detach`/exit-flagged
  removes) and `rememberHypenDnd` (the Compose face: `awaitEachGesture`
  activation — any-axis slop, cross-axis slop inside an axis-constrained
  sortable, 300ms press, immediate — `onGloballyPositioned` bounds reported
  as RENDERED rects (layout rect + the element's own engine
  `translateX.0`/`translateY.0`, so a positioned note re-pins from where it
  is drawn), the lift surface and pointer mapping INSIDE the element's
  applicator chain (`HypenDndModifiers.outer` / `.inner` around it), the
  claiming pointer's own up as the drop, a system cancel as
  `.onDragEnd {dropped:false}`, a `graphicsLayer {}` ghost + shift with no
  per-frame recomposition, `zIndex` raise, and "Move up/down" TalkBack custom
  actions on sortable items that run the same commit path). `HypenElement` gained a runtime pose-override layer
  above the glide overrides so `__anim.statePoses[label]` shows through every
  applicator/component. `__hypen_reorder` / `__hypen_pin` payloads and the
  `.on*` event payload are byte-exact per plan §4.1 / §4.2. Zero engine
  traffic during a drag except opted-in `.onDragStart` / `.onDragOver(dwell:)`.
  Not compiled in the authoring environment (no Android SDK); JVM unit tests
  for the parsers, the coordinator and the renderer hooks under
  `renderer/src/test/.../dnd/`.

### Changed
- **The device plane runs on a compressed socket when compression is per
  message.** `RemoteEngine` used to disable the device plane whenever the
  upgrade response's `Sec-WebSocket-Extensions` mentioned permessage-deflate.
  It now enables it when the negotiated permessage-deflate carries BOTH
  `server_no_context_takeover` and `client_no_context_takeover` (parameters
  parsed properly, `PerMessageDeflate.allowsDevice`; OkHttp honours both), so
  device data never shares a compression history with other messages — what
  the Hypen servers negotiate by default now. With context takeover in either
  direction the hello still omits `device`, the socket runs UI-only, and one
  warning is logged.
- Device advertisement follows the one cross-host rule (RFC 001 §2.2
  "advertise only implementable capabilities"): a capability is offered iff
  (1) its hardware exists, (2) the merged manifest declares what the OS
  requires for it on this API level, and (3) for `bluetooth.scan` and
  `mic.record` the host indicator is ready. (2) is new: an app without
  `RECORD_AUDIO` no longer advertises `mic.record`, and one without the BLE
  scan permissions for its API level (`BLUETOOTH_SCAN` on 31+, plus
  `ACCESS_FINE_LOCATION` without `neverForLocation`; fine location on
  29–30; fine or coarse before) no longer advertises `bluetooth.scan` /
  `bluetooth.select` — instead of advertising them and answering
  `not-declared:*`. Declarations are read once through `PackageManager`
  (`ManifestPermissions`, the testable seam behind `DeclaredPermissions`,
  which carries no grant state): whether a permission is granted, was
  refused or was ever asked never changes the advertisement.
  `camera.capture` stays hardware-only (the system capture UI records under
  the capture app's own permissions). `permission.query` / `.request` stay
  advertised and answer `not-declared:<name>` per undeclared name.
  Re-advertisement: `DeviceHost.recheckCapabilities()` re-evaluates the
  offers and emits a fresh `core.capabilities` snapshot only when the set
  changed; `AndroidDeviceHost` calls it when the default indicator's
  readiness flips and when the app gains or loses the foreground (covering
  custom indicators without a readiness callback).
- Device `permission.query` / `permission.request` take the closed permission
  enum (`camera | microphone | photos | location | notifications | bluetooth |
  contacts`, RFC 001 P1): anything else — including the former `geolocation`
  alias — is `invalidParams` at decode; a name a host cannot represent would
  answer `unsupported` with the name as `platformDetail`.
- `translateX` / `translateY` (and the `transform` shorthand's translate keys)
  now read bare numbers as **dp** — the renderer's logical unit, matching
  every other length applicator and the DOM (CSS px) / iOS (points) renderers
  — instead of raw pixels, and read an explicit `null` as 0 (the engine's
  reserved-mode pinboard injection emits `translateX.0: null` for an unpinned
  item). A drag-and-drop pin reports `(x, y)` in dp and the engine writes them
  back as `translateX.0` / `translateY.0`, so the two must agree.
- Video v2 (`hypen-docs/content/docs/guide/components.mdx` §"Playback control & composition
  slots"): a contract player state (idle/loading/playing/paused/ended/error)
  derived from the ExoPlayer callbacks — a rebuffer re-enters `loading`
  without emitting `onPause`, `error` is sticky until the source list
  changes. `.bind(@state.playback)` two-way binds `{playing, position,
  duration, state}`: reports go out per key on the `__hypen_bind` channel
  with position throttled to 250 ms while playing (transitions immediate),
  inbound writes play/pause (a `true` write in `ended` restarts from 0) and
  seek behind the 1 s epsilon + last-reported echo guards. `startPosition`
  seeks once on the first READY. Children tagged `.slot("controls" |
  "loading" | "error" | "poster")` overlay the surface full-bleed and are
  shown/hidden strictly per the normative visibility table, never
  mounted/unmounted, so slot state survives transitions; a present slot
  replaces the built-in for that concern (`controls` also forces
  `useController = false`). New `Scrubber` component: wired to the enclosing
  player renderer-side, previews drags locally and commits on release via
  the bind or its `onSeek` action, with `progressBarRangeInfo` /
  `stateDescription` / `setProgress` for TalkBack; inert outside a Video.
  `muted` and `loop` are now re-applied live rather than at player creation.
- Animation stage 1 (#159): the daily-driver half of the shipped `__anim.*`
  protocol. `.transition` glides the 27 whitelisted props by interpolating
  the presented value back onto the element, so every prop animates through
  its existing applicator/component; `.states` pose flips glide for free
  through the engine's synthesized transition. `.enter`/`.exit` play as a
  single `graphicsLayer` pose, with the renderer-owned deferred-remove
  contract behind them: a `Remove{transition:true}` keeps the subtree alive,
  excludes it from touch, action dispatch, focus/IME and TalkBack
  immediately, and finalizes on natural settle OR the
  `duration + delay + 80ms` timeout backbone. `.animate` presets
  (pulse/spin/shake/shimmer) run with their normative timing defaults;
  looping presets never complete, a cached Router attach never replays a
  finite one. `batchAnimation` is honoured at batch index 0 only, with
  precedence `structural > transaction > node .transition > snap`. Reduced
  motion gates on `Settings.Global.ANIMATOR_DURATION_SCALE` with a live
  `ContentObserver`, and `.motion(essential)` exempts a node from all of it.
  `.onAnimationComplete` dispatches on NATURAL settle only.
  Curves are the pinned cubic beziers — `spring` is
  `cubic-bezier(0.34, 1.56, 0.64, 1)`, never Compose's physics `spring()`.

### Fixed
- **`camera.capture` always failed with `internal` / `driver-failure`.** The
  library manifest declared `HypenDeviceFileProvider` without the
  `android.support.FILE_PROVIDER_PATHS` `<meta-data>`. The static
  `FileProvider.getUriForFile(...)` that builds the capture file's URI reads
  the paths only from that meta-data (the subclass's `FileProvider(R.xml…)`
  constructor argument serves the provider instance alone; androidx.core
  ≥ 1.10 parses paths lazily per instance and never seeds the static lookup),
  so it threw `IllegalArgumentException("Missing
  android.support.FILE_PROVIDER_PATHS meta-data")` before the camera app was
  launched. The meta-data is now declared (it lands in the app's merged
  manifest), and a provider that still cannot share the file fails `internal`
  with the named detail `capture-file-provider-misconfigured` instead of an
  anonymous driver failure (`HypenDeviceFileProvider.uriForCapture`,
  `CaptureFileProviderTest` runs the real androidx code against the real
  manifest and paths XML).
- **`mic.record` / `bluetooth.scan` missing from the negotiation.** Both are
  advertised only while the indicator overlay is composed on a started
  screen, and the `hello.device` advertisement was snapshotted the moment
  the socket opened. When the socket opened before the overlay attached (a
  reconnect racing the screen, `RemoteEngine` connected before the UI), the
  hello — and so `sessionAck.device`, the client's ceiling for the whole
  connection — lacked them; the later `core.capabilities` snapshot made the
  server's broker select them anyway, and every request was refused
  `unsupported` ("not in the negotiated selection"). `RemoteEngine` now waits
  (at most 2 s, only while the app is in the foreground) for
  `DeviceHost.helloAwaitsIndicator()` to clear before snapshotting the hello;
  the advertisement rule itself is unchanged. New `DeviceDriver.awaitsIndicator()`
  (default `false`). `DeviceLiveSelectionTest`, `RemoteEngineDeviceHelloTest`.
- **UI updates from servers that omit `module` / `state`.** `patch`
  (`module`) and `initialTree` / `stateUpdate` (`module`, `state`) no longer
  require the informational members: the Kotlin server omitted them and
  Moshi dropped every such `patch` whole. One message that cannot be parsed
  or handled — including anything the device plane rejects — is logged and
  dropped; it never escapes OkHttp's listener (which would fail the socket),
  the engine's coroutine scope, or `HypenSession`'s patch collector (which
  would stop all later UI updates). `RemoteEngineWireRobustnessTest`.

### Known limitations
- `.layout` (FLIP on `move`) is parsed and deliberately snapped, matching
  the canvas and desktop renderers; `.sharedElement` and `.scrub`/`.settle`
  remain unimplemented (stage 2). See the capability matrix in
  `ANIMATION.md`.

## [0.4.32] - 2026-02-19

### Added
- Initial changelog for the Android native renderer
