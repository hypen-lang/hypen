# Device communication — live retest at 773d936d

September 26, 2026. Pulled `773d936dd02c2ed4b89317cd20ec97a46675d88b`,
rebuilt the affected iOS and native desktop clients, and exercised all 25 requested
client/server pairings again. Local fixtures and previous evidence were preserved.

**The iOS compression and desktop capture regressions are fixed in the live
checks. One intermittent iOS gallery failure remains; this is not an all-clear
for every capability.** The previous [63db27b8 report](LIVE-RESULTS-63db27b8.md)
records the failures this commit was intended to fix.

## This round's actual coverage

| Client | TS | Rust | Go | Kotlin | Swift |
|---|---|---|---|---|---|
| Desktop Hypen Browser | 3s audio PASS | 3s audio PASS | 3s audio PASS | 3s audio PASS | 3s audio PASS |
| iOS simulator | Full flow PASS | Full flow PASS | Gallery failed once; full flow PASS on all 3 retries | Full flow PASS | Full flow PASS |
| Android emulator | Flow PASS¹ | Flow PASS¹ | Flow PASS¹ | Flow PASS¹ | Flow PASS¹ |
| DOM | Query + photo PASS | Query + photo PASS | Query + photo PASS | Query + photo PASS | Query + photo PASS |
| Canvas | Query + photo PASS | Query + photo PASS | Query + photo PASS | Query + photo PASS | Query + photo PASS |

The iOS full flow is permission query, actual Photos selection/upload, native file
save, three-second microphone stream, and UI ping. Desktop checks specifically
retested the changed capture/visibility behavior; the previous round's successful
photo and save checks were not repeated on desktop in this round.

¹ Android flow is permission query, opening/cancelling the native gallery picker,
native file save, three-second audio stream, and UI ping. Selecting/uploading an
Android gallery image remains unverified. The camera success in the previous
report is prior-run evidence, not a new camera check here.

The tests used the same real Device Lab app: Hypen Browser on macOS, iPhone 17 Pro
simulator running iOS 26.5, Android 11/API 30 emulator, and in-app Chromium with
DOM/Canvas renderers. No device drivers, permissions, media, or response bytes
were mocked. iOS used XCTest, Android used adb/UI Automator, and desktop/web used CUA.

## Confirmed fixes

- **iOS with compression:** TS passed immediately; Go completed permission query
  on the first run and passed the full flow on three retries. No compression
  override was used. Direct upgrade checks confirmed both servers still return
  `permessage-deflate` with `server_no_context_takeover` and
  `client_no_context_takeover`. The former `device-disabled` failure is gone.
- **Desktop capture while covered:** Go, Kotlin and Swift previously returned
  `no-presenter` or ended recordings early. All five servers now receive exactly
  96,000 bytes over 3,000ms through the rebuilt native client. No minimized-window
  behavior or BLE scanning is claimed from these microphone tests.
- **iOS save after photo picker:** every run that completed photo selection also
  saved successfully: seven completed flows, including three Go retries. The
  previous Kotlin save `presentation-failed` did not recur in these runs.

## Remaining intermittent failure

The first iOS Go run showed a successful permission query, opened the Photos
picker, and then reported `gallery: device: unavailable (presentation-failed)`.
The expected image hash never arrived. The exact same flow, without code or
server configuration changes, passed on all three subsequent runs.

| iOS execution | Outcome | Duration |
|---|---|---|
| Initial Go | FAIL at photo result | 26.954s |
| Initial Kotlin | PASS | 34.734s |
| Initial Rust | PASS | 34.509s |
| Initial Swift | PASS | 33.551s |
| Initial TS | PASS | 32.553s |
| Go retry 1 | PASS | 35.659s |
| Go retry 2 | PASS | 32.434s |
| Go retry 3 | PASS | 33.068s |

The native UI failure is retained in
[this UI hierarchy](results-773d936d/ios-attachments/7FD0DE40-90C8-425F-B519-DAB26791B077.txt).
The gallery presentation verifier in
[DeviceHostIOS.swift](../../hypen-renderer-swift/Sources/HypenSwift/Device/DeviceHostIOS.swift#L291)
can produce this outcome. The precise timing cause is not isolated; the evidence
does not establish a Go protocol defect. This failure was not discarded just
because the retries passed.

## Transfer integrity and evidence

- Every new successful iOS, DOM and Canvas photo upload matched the 85,595-byte
  fixture, SHA-256 `6465bbf6110e746367789368366419b0fbd7919d02558e92a2dfccfa246fb2fe`.
- The ten newly saved iOS/Android files were read from their real device
  filesystems. Every file is 102,000 bytes, SHA-256
  `ca3da39460b02267afabd8da42778d5e434e64d3302ed4be304f7318c0335350`.
- All five native desktop recordings and all five Android recordings reached
  96,000 bytes/3,000ms. The seven passing iOS flows also checked 96,000 bytes.
  Simulated-device capture validates the platform path and transport, not
  physical microphone fidelity.

New evidence is isolated in [results-773d936d](results-773d936d/):

- [Initial iOS run](results-773d936d/ios-773d936d.log) and
  [three Go retries](results-773d936d/ios-Go-retry-773d936d.log).
- [Initial iOS screenshot manifest](results-773d936d/ios-attachments/manifest.json)
  and [Go retry screenshot manifest](results-773d936d/ios-Go-retry-attachments/manifest.json).
- `android-SERVER-evidence.json`, native UI XML, and screenshots for each Android step.
- [Desktop audio observations](results-773d936d/desktop-audio-observations.json),
  [browser observations](results-773d936d/browser-observations.json), copied server
  logs, [saved-file hashes](results-773d936d/saved-file-hashes.json), actual saved
  files, and [compression handshakes](results-773d936d/server-compression-handshakes.json).
  Observation JSON files summarize the visible CUA results; they are not raw
  automated assertion traces.

## Limits and build notes

Browser save/audio, Android selected-photo upload, physical BLE/camera/mic
coverage, minimum OS versions, other browser engines, lifetime/navigation,
reconnect, admission-negative cases, large-file limits, workerd and Linux Swift
remain outside this rerun. The Kotlin lab's Netty transport does not negotiate
compression, so the iOS result does not cover Kotlin's production compressed
transport. Rust and Swift lab transports also did not negotiate compression.

The unchanged server implementations and Android app from the prior build were
reused; this commit changes the iOS and desktop clients. Both changed clients
were rebuilt. Desktop's first build encountered stale serde artifacts from the
standalone Rust lab sharing a target directory. Clearing the affected workspace
build artifacts resolved it; no source or dependency change was needed. The clean
build completed successfully in 19.36s. `git diff --check` passes.

No commits or pushes were made. The pre-pull stash remains as a backup.
