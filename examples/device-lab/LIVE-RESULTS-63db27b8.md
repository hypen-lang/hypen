# Device communication — live retest, September 26, 2026

**Verdict: FAIL with the default configuration.** Pulled and rebuilt commit
`63db27b8ec68b710b0d8c81f36207bba232e82b4` on
`claude/hypen-device-protocol-25pn37`, preserving the existing local test work.
The previous live report is preserved as [LIVE-RESULTS-2026-09-25.md](LIVE-RESULTS-2026-09-25.md).

The new desktop and Rust device implementations work. Kotlin's previously broken
wire format and Android's capture failures are fixed in the exercised paths.
However, iOS disables device access against the new TS and Go server defaults.
Turning off compression on those test servers makes the same native iOS flows pass.
This is a controlled comparison, not a passing result for the defaults.

## Real clients and scope

This run used the Device Lab app in the rebuilt native Hypen Browser, rebuilt iOS
Gallery on an iPhone 17 Pro simulator (iOS 26.5), rebuilt Android Gallery on an
Android 11/API 30 emulator, and DOM and Canvas renderers in the in-app Chromium
browser. iOS interactions used XCTest; Android used adb/UI Automator; desktop
and web used CUA. Device hosts and platform pickers/capture drivers were real.
No scripted host responses or substituted device bytes were used.

All 25 requested client/server combinations were connected and exercised. The
matrix below describes **observed operations**, not blanket capability approval.

| Client | TypeScript | Rust | Go | Kotlin | Swift |
|---|---|---|---|---|---|
| Desktop Hypen Browser | Query, photo, save, 3s audio pass | Query, photo, save, 3s audio pass | Query/photo/save pass; audio partial¹ | Query/photo/save pass; audio partial¹ | Query/photo/save pass; audio unavailable¹ |
| iOS simulator | **FAIL: device-disabled**² | Query/photo/save/3s audio/ping pass | **FAIL: device-disabled**² | Full flow passes on retry; intermittent save failure³ | Query/photo/save/3s audio/ping pass |
| Android emulator | Query/save/3s audio/ping pass; camera pass; gallery unresolved⁴ | Query/save/3s audio/ping pass; picker cancellation pass⁴ | Same as Rust⁴ | Same as Rust⁴; UI updates fixed | Same as Rust⁴ |
| DOM | Query and photo upload pass⁵ | Query and photo upload pass⁵ | Query and photo upload pass⁵ | Query and photo upload pass⁵ | Query and photo upload pass⁵ |
| Canvas | Query and photo upload pass⁵ | Query and photo upload pass⁵ | Query and photo upload pass⁵ | Query and photo upload pass⁵ | Query and photo upload pass⁵ |

1. Desktop microphone results are affected by window visibility during automation.
   Go and Kotlin streamed actual audio but ended early (36,864 bytes/1,152ms and
   53,590 bytes/1,675ms respectively). Requests also returned `unavailable/no-presenter`;
   Swift returned that error in both the original and fresh-session attempts.
   The desktop log records OS occlusion; the capture implementation refuses hidden
   windows. These are **not counted as full three-second passes**, and the evidence
   does not isolate a product defect from automation/foreground behavior. TS and
   Rust each completed 96,000 bytes/3,000ms through the same real desktop host.
2. With `DEVICE_LAB_NO_COMPRESSION=1` on TS and Go, both iOS flows passed query,
   native photo selection, native save, three-second audio, and UI ping. The
   comparison flag was then removed from the running environment: both servers
   were restarted with their defaults. No production client guard was changed.
3. The first Kotlin iOS save returned `UNAVAILABLE/presentation-failed` immediately
   after a successful photo upload. The identical full flow passed on retry without
   code changes. Keep this as an intermittent presentation issue. The Kotlin lab
   uses its real SDK with the existing test Netty transport, which does **not**
   negotiate compression; this does not verify iOS against Kotlin's compression-
   enabled production transport. Rust's lab transport and the Swift server also
   did not negotiate compression in these runs.
4. Android's real gallery picker opened and returned `cancelled/picker-dismissed`
   correctly on all five servers. Selecting the seeded PNG did not complete in
   the UI automation; actual gallery upload remains unverified, not a proven SDK
   failure. The TS camera flow did return a real emulator-camera JPEG: 45,204 bytes,
   SHA-256 `d45ecd3e38a918eb51f1a97d9f034b1a6ab2b4b75c833f324e19b13f6ed2ca9d`.
5. DOM/Canvas used real browser file choosers and displayed the verified received
   image hash for every server. Browser file-save completion and microphone capture
   are **not verified in this rerun**. Prior native browser permission/save dialog
   automation limits remain; no fake media or permission bypass was substituted.

## Confirmed regression: iOS with compressed server defaults

Reproduction:

1. Start the TS or Go Device Lab server with its default configuration.
2. Launch the rebuilt iOS Gallery at the matching `ws://127.0.0.1:4510x/ws?token=device-lab` URL.
3. Tap **Query camera**, then **Pick photo**.
4. The result is `unavailable/device-disabled`; the photo picker never opens.
5. Restart the same server with `DEVICE_LAB_NO_COMPRESSION=1`, relaunch the same
   app, and repeat. Query, photo, save, audio and ping all succeed.

The Swift client still has an unconditional `guard !compressed` in
[`RemoteEngine.swift`](../../hypen-renderer-swift/Sources/HypenSwift/Remote/RemoteEngine.swift#L576).
It omits the device plane when URLSession negotiates permessage-deflate. The new
[TS default](../../hypen-web/packages/server/src/remote/server.ts#L742) and
[Go default](../../hypen-golang/remote/server.go#L812) enable stateless compression.
The server/client policy mismatch breaks ordinary iOS device calls without any
special proxy or unsupported configuration.

Observed XCTest results:

| Run | Go | Kotlin | Rust | Swift | TS |
|---|---|---|---|---|---|
| Defaults | FAIL, 13.591s | FAIL, 28.453s | PASS, 31.806s | PASS, 32.386s | FAIL, 12.350s |
| Kotlin retry, unchanged | — | PASS, 32.610s | — | — | — |
| TS/Go compression off | PASS, 33.847s | — | — | — | PASS, 32.471s |

## Integrity checks

Every successful photo-upload smoke check received the repository-owned icon:
85,595 bytes, SHA-256
`6465bbf6110e746367789368366419b0fbd7919d02558e92a2dfccfa246fb2fe`.

All five desktop saves and all five Android saves were read back from the actual
filesystem and matched the 102,000-byte fixture, SHA-256
`ca3da39460b02267afabd8da42778d5e434e64d3302ed4be304f7318c0335350`.
All five iOS saved files match too, with TS/Go files produced during the explicit
compression-off comparison. Successful full audio runs delivered 96,000 bytes
of mono PCM16 at 16kHz over three seconds; this validates streaming and byte counts,
not physical microphone fidelity in the simulators.

## Evidence

All new evidence is in [results-2026-09-26](results-2026-09-26/); September 25 artifacts
remain separate in `results/`.

- [iOS default-run log](results-2026-09-26/ios-ui-sep26.log),
  [Kotlin retry](results-2026-09-26/ios-kotlin-sep26-retry.log),
  [compression comparison](results-2026-09-26/ios-no-compression-sep26.log).
- Screenshots and native UI failure attachments in
  [iOS matrix](results-2026-09-26/ios-matrix-attachments/manifest.json),
  [Kotlin retry](results-2026-09-26/ios-kotlin-retry-attachments/manifest.json), and
  [compression comparison](results-2026-09-26/ios-no-compression-attachments/manifest.json).
  Friendly `SERVER-action.png` copies accompany the original attachments.
- Android `android-SERVER-evidence.json` contains each action's actual UI text;
  the adjacent XML and PNG files retain each native screen and picker state.
- [Desktop observations](results-2026-09-26/desktop-matrix-observations.json),
  [DOM/Canvas observations](results-2026-09-26/browser-matrix-observations.json).
  These are recorded observations from CUA, not a fabricated automated assertion log.
- [Desktop/iOS saved-file hashes](results-2026-09-26/saved-file-hashes.json),
  [Android saved-file hashes](results-2026-09-26/android-saved-file-hashes.json),
  actual saved files, server logs and received upload bytes.

## Limits and remaining checks

This is a real-app compatibility and transfer retest, not completion of every item
in the supplied broad test plan. BLE hardware, physical-device capture fidelity,
all permission states, route/background lifetimes, connection interruption and
resume, large-file limits, security/admission negative cases, minimum OS versions,
other browser engines, Cloudflare/workerd and Linux Swift were not rerun here.
Android selected-photo upload, browser save/audio, and consistently foregrounded
Go/Kotlin/Swift desktop audio still need completion. The default iOS compression
regression is independently reproducible and already prevents an all-clear.

Local test fixtures were updated to use Rust's new real device APIs and the new
server defaults. Existing local changes were preserved, no commit was created,
and the pre-pull stash remains as a backup.
