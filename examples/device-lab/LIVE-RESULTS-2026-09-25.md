# Live Device Lab results — 25 September 2026

**Result: FAIL — the PR cannot be signed off across the requested clients.**

Tested checkout: `6a712c2c09738a122e4efa98fac35b4354f74885`, with the uncommitted
Device Lab app and native Gallery integration described below. No fixes for the
product failures below were applied. These are findings on this checkout;
pre-existing versus introduced-by-PR status has not been established against the
base branch.

## Real app coverage

Each of the 25 client/server pairings was launched. This means an actual client
connected to an actual SDK server, not that all 25 passed every capability.
Native controls were driven with XCTest on iOS, adb/UI Automator on Android,
and computer control in Hypen Browser. DOM and Canvas ran in the actual in-app
Chromium browser with `WebDeviceHost`. No device driver was replaced with a mock.

| Actual client | TS / Bun | Go | Kotlin / JVM | Swift / macOS | Rust SDK |
| --- | --- | --- | --- | --- | --- |
| iPhone 17 Pro simulator, iOS 26.5 | Query, photo upload, save, 3s audio, UI ping pass | Same pass | Same pass | Same pass | UI runs; device API absent |
| Android emulator, API 30 | Query and save pass; mic fails; camera fails; picker selection unresolved | Query, picker cancellation, save and ping pass; mic fails | Device query/cancel/save reach server, but UI updates fail; mic fails | Query, picker cancellation, save and ping pass; mic fails | UI runs; device API absent |
| Native Hypen Browser desktop | UI runs; query/photo return device-disabled | UI runs; query returns device-disabled | Connects but blank content; initial message rejected | UI runs; query returns device-disabled | UI runs; device API absent |
| DOM | Query and 102,000-byte file upload pass | Query and photo upload pass | Query and photo upload pass | Query and photo upload pass | UI runs; device API absent |
| Canvas | Query and photo upload pass | Query and photo upload pass | Query and photo upload pass | Query and photo upload pass | UI runs; device API absent |

Canvas TS actions were also clicked at their rendered pixel positions, exercising
Canvas hit testing. Other browser actions used their real accessible controls.

## Release-blocking findings

### 1. Native desktop has no device integration

Reproduction: launch `HypenBrowserLab.app` with the TS test URL; click Query camera
or Pick photo. The rendered result is `unavailable`, detail `device-disabled`.
Go and Swift permission queries fail the same way.

The desktop client's `hypen-renderer-desktop/src/remote.rs:343` constructs a Hello
containing only session ID and props. Its receive loop does not route a device
plane. `hypen-sdk-rs/src/remote/types.rs:10` likewise has no device extension in
Hello. Native desktop device communication is not implemented by this path.

### 2. Rust server SDK has no device context

The real Rust `RemoteSession` serves the shared app and processes its UI actions
on all five clients. This SDK exposes neither a device context nor the device
handshake in its remote message model. The fixture explicitly displays
`NOT IMPLEMENTED IN RUST SDK`; it does not fabricate a successful hardware call.
A Rust broker used internally by other SDKs does not establish support in the
Rust server SDK.

### 3. Kotlin wire messages break Android updates and desktop startup

On Android, tap Query camera or Save. The Kotlin server completes the operation,
but the screen remains `Connected. Choose a check.` Even UI ping never updates.
The actual Android application log reports:

```
Error parsing message: Required value 'module' missing at $
```

`HypenServer.kt:1042` sends patch envelopes without `module`, while Android's
`model/RemoteMessage.kt:31` requires it. This is an envelope compatibility failure,
not a failed photo picker or a dropped network connection.

On desktop, the Kotlin connection receives its session acknowledgement but shows
blank content. The native client logs:

```
remote: ignoring malformed message: missing field `state`
```

Kotlin's initial-tree envelope at `HypenServer.kt:462` omits `state`, which the
Rust remote message model requires at `hypen-sdk-rs/src/remote/types.rs:32`.

Evidence: [Android parser errors](results/android-kotlin-parse-errors.log),
[Android action snapshots](results/android-Kotlin-evidence.json),
[desktop Kotlin log](results/desktop-Kotlin.log),
[Kotlin server outcomes](results/kotlin.log).

### 4. Android advertises microphone support but cannot execute it

Reproduction in the actual Gallery app: connect to TS, press Status, then Record
3s. Status reports `mic.record: true`; Record returns:

```
unsupported: mic.record@1 is not in the negotiated selection
```

This also occurred with Go, Kotlin, and Swift. No microphone data was received.
The emulator has a microphone feature and the app declares RECORD_AUDIO.

Source inspection points to startup ordering: `HypenSession.kt:53` begins the
connection before the Compose indicator attaches; `MicRecordDriver` offers the
capability only when that indicator is ready. Later capability updates do not
change the client's immutable negotiated selection (`DeviceHost.kt:509`). This
explains the observed support/execution mismatch, but is not a verified fix.

Evidence: [TS real action log](results/ts.jsonl),
[Go Android recording screen](results/screenshots/android-Go-record.png),
[Swift Android evidence](results/android-Swift-evidence.json).

### 5. Android camera returns an internal driver failure

On TS, Camera opened Android's native camera permission prompt. Choosing Only
this time returned `internal / driver-failure` without presenting capture UI.
The emulator does have an IMAGE_CAPTURE handler:
`com.android.camera2/com.android.camera.CaptureActivity`.
The underlying exception was not isolated; this is an observed failure, not a
claimed diagnosis.

Evidence: [camera result](results/screenshots/android-TS-camera-failure.png).

## Successful data transfers

The iOS simulator ran the installed HypenGallery app with `DeviceHost.iOS()`.
XCTest selected the seeded repository icon through PHPicker, saved through the
native document picker, and recorded through the native microphone driver.
Each of TS, Go, Kotlin and Swift completed these operations and then handled
another UI ping.

- Photo: **85,595 bytes**, SHA-256
  `6465bbf6110e746367789368366419b0fbd7919d02558e92a2dfccfa246fb2fe`.
  The received upload matches the repository's `icon-512.png`.
- Saved payload: **102,000 bytes**, SHA-256
  `ca3da39460b02267afabd8da42778d5e434e64d3302ed4be304f7318c0335350`.
  Files saved by all four servers on iOS, and the TS save on Android, were read
  back and compared byte-for-byte. All matched. The button's historical label
  says Save 96K; the actual payload is 102,000 bytes.
- iOS audio: **3,000 ms**, PCM16, mono, 16 kHz, **96,000 bytes** per server.
  These used the native simulator audio input, not prerecorded fixture frames.
  This is not a claim about physical iPhone microphones or cameras.
- DOM and Canvas uploads above were selected through the browser file chooser;
  their server-reported byte counts and hashes matched their selected fixtures.

Evidence: [saved-file verification](results/saved-file-verification.json),
[iOS TS photo](results/screenshots/ios-TS-gallery.png),
[iOS TS recording](results/screenshots/ios-TS-record.png),
[iOS Go recording](results/screenshots/ios-Go-record.png),
[iOS Kotlin recording](results/screenshots/ios-Kotlin-record.png),
[iOS Swift recording](results/screenshots/ios-Swift-record.png).

## Other issues and test limits

- The original positional `Button("@actions.status")` did not dispatch on iOS.
  Changing the fixture to `.onClick(@actions.status)` made it work. Source
  inspection suggests a local effective-modifier callback is not used by the
  outer tap gesture. This may predate this PR; no base comparison was run.
- Go's initial patches omit button semantics. iOS displayed and accepted taps on
  the text, but XCTest could not find them as buttons. The UI driver was adapted
  to the actual text elements; the rerun passed.
- Android's actual DocumentsUI opened and Cancel returned `cancelled`. Selecting
  the seeded photo or text file through the available UI driver did not finish.
  This remains an unresolved picker/automation issue, not a confirmed SDK upload
  defect. No successful Android upload is claimed.
- Browser Go Save opened the native save dialog, but it could not be controlled
  through the in-app browser surface. Browser TS microphone consent was accepted,
  but recording timed out without a completed browser/OS permission flow.
  Subsequent chooser automation also stalled. These are blocked checks, not
  proof of browser device-driver defects. Native control of Codex itself is
  unavailable; no attempt was made to bypass that restriction.
- Earlier simulator connectionLost and browser upload timeout observations from
  the stalled computer-control run are superseded by the successful native
  XCTest/file-chooser runs. They are not reported as product bugs.
- This was a live integration pass, not the entire pasted release checklist.
  Successful BLE discovery, physical camera/video capture, mobile browser/version
  matrices, large-file boundaries, limited-photo permissions, stream Stop and
  background/route lifetime behavior, reconnect/resume attacks, and workerd were
  not signed off. Linux Swift server was not run.
- Reload the Device Lab browser page after restarting a server. The small browser
  fixture does not reset its rendered tree on a fresh session and can duplicate
  the UI in that case; this is a harness limitation.

## Reproduction assets

[README](README.md) lists server commands and native URLs. The iOS UI driver is
`hypen-renderer-swift/Gallery/HypenGallery/HypenGalleryUITests/DeviceLabUITests.swift`.
Android's driver is `android-ui.py`, with per-server flows in `android-matrix.py`.

XCTest bundles remain in `/private/tmp/hypen-device-lab/ios-live-matrix.xcresult`
and `ios-live-go.xcresult`. The first matrix's Go accessibility lookup failed;
the corrected Go rerun passed. Exported result screenshots and run summaries are
under `results/`. Automated protocol/unit results from the earlier report are
separate and are not used to fill any of these live coverage gaps.

Final verification: the TS iOS flow was rerun with explicit 102,000-byte save
and 96,000-byte recording assertions; it passed (32.5s). The result bundle is
`/private/tmp/hypen-device-lab/ios-live-byte-assertions.xcresult`. `git diff --check`
also passed.
