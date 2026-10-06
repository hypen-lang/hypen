# Device communication test results — 25 September 2026

Tested checkout: `claude/hypen-device-protocol-25pn37`, commit `6a712c2c09738a122e4efa98fac35b4354f74885`, plus the test-only changes described below. No production device implementation was changed.

**Verdict: do not sign off on the requested five-client × five-server matrix.** Native desktop device support and Rust server SDK integration are absent. The iOS indicator advertisement requirement still fails a regression check. Several real-hardware and cross-client/server combinations remain untested.

## Confirmed gaps

1. **Native desktop has no device host.** `hypen-renderer-desktop/src/remote.rs:343` constructs a hello containing only session ID and props; at line 307 its receive loop discards binary messages. There is no capability negotiation or device request execution. Its 808 passing tests do not establish device support. This applies to the native desktop renderer, not desktop Chrome.
2. **Rust server SDK has no device integration.** `hypen-sdk-rs/src/remote/types.rs:10` uses a separate message enum whose hello and acknowledgement omit device negotiation and resume credentials. The SDK has no device context/plane. The engine's working Rust broker is not a working Rust SDK device server. This limitation was also acknowledged in the supplied plan.
3. **iOS still advertises recording when its indicator cannot appear.** With `FakeIndicatorSurface.canShow = false`, the real `DeviceHost` still includes `mic.record` in its advertisement. Added an assertion to `testMicRecordFailsUnavailableWithoutOpeningTheMicWhenTheOverlayCannotShow`; it fails at `DeviceHostRound3RepairTests.swift:291`. The existing request-time checks still refuse recording with `unavailable` / `no-activity-indicator`, and the microphone remains unopened. This is an advertisement consistency failure, not evidence of invisible recording. The supplied plan identified this as pending work; the latest Android change does not fix the Swift host.

## Executed server checks

| Server area | Result | What actually ran |
| --- | --- | --- |
| TypeScript / Bun | Pass | Full web suite: 4,385 passed, 38 skipped, zero failed; all package typechecks passed. Device server real-socket tests exercise admission, negotiation, capabilities, uploads/downloads, cancellation, leases, resume, isolation and malformed traffic. |
| Rust engine broker | Pass | `cargo test -p hypen-engine --features schema-export`: 1,794 passed, one ignored across 64 test executables/doc-test groups. Includes broker, protocol, schema, transcripts and conformance. |
| Rust server SDK | Feature absent | Existing SDK suite: 167 passed, 24 ignored. No device-enabled server to test. |
| Go | Pass | `HYPEN_E2E_REQUIRE=1 go test -race -count=1 ./...`: all four packages pass; the required TS-client cross-language socket test ran. |
| Kotlin | Pass | 1,077 unit/compatibility test cases and one cross-language E2E test pass after rebuilding the native engine. |
| Swift server / macOS | Pass after test harness repair | 278 unit tests; all 24 TS-client WebSocket E2E tests pass, including download ordering and concurrent connections. |

The Go/Kotlin/Swift E2E clients use the actual TS remote client and device runtime with **scripted device drivers**. They do not execute DOM, Canvas, iOS or Android platform APIs.

## Executed client checks

| Client | Result | Limits of the evidence |
| --- | --- | --- |
| Native desktop | 808 passed, 13 ignored | Existing renderer tests only; device functionality is absent. |
| DOM | Pass against TS | Added real Chrome test: click a rendered Hypen button → host consent → real file chooser → 96,000-byte upload → SHA-256 verification → rendered state update. |
| Canvas | Pass against TS | Added real Chrome test: coordinate click on a Canvas-rendered Hypen button → same picker/upload/hash path → renderer receives the updated text property. No screenshot/pixel assertion for the updated text. |
| Browser device host | 14/14 pass in real Chrome | Gallery/file pick, hashes, denial cooldown, key/click protection, camera photo/video, microphone AudioWorklet and ScriptProcessor paths, stereo Stop, permissions, Bluetooth chooser. Capture devices and Bluetooth peripheral are simulated. |
| Android | Pass after test expectation repair | 743 unit tests; renderer builds; one **non-skipped API 30 emulator instrumentation test** uses the real Android permission implementation, OkHttp, device host and TS server/Rust broker. Negotiation, resume-token issuance, camera permission query and return through UI patches succeed. This smoke uses a minimal permission-only host, not the full Compose host or native pickers. |
| iOS | Baseline passes; added regression fails | Simulator iOS 26.5: 357 XCTest + 361 Swift Testing cases passed before the new assertion. Mac renderer baseline: 357 XCTest + 374 Swift Testing passed. iOS-only code builds for the simulator. One **non-skipped simulator native socket test** uses `DeviceHost.iOS()`, URLSession, real permission status and the TS server. The added unavailable-indicator assertion fails as described above. |

## Requested client/server matrix

`Smoke` means only the stated native permission or rendered picker check, not the full capability plan.

| Client | TS | Rust SDK | Go | Kotlin | Swift |
| --- | --- | --- | --- | --- | --- |
| Native desktop | Missing client support | Missing both sides | Missing client support | Missing client support | Missing client support |
| iOS | Simulator smoke passed | Missing server support | Not run | Not run | Not run |
| Android | Emulator smoke passed | Missing server support | Not run | Not run | Not run |
| Canvas | Browser smoke passed | Missing server support | Not run with Canvas | Not run with Canvas | Not run with Canvas |
| DOM | Browser smoke passed | Missing server support | Not run with DOM | Not run with DOM | Not run with DOM |

## Test setup repairs and additions

- Restored web dependencies with `bun install --frozen-lockfile`; missing local workspace links initially caused import errors. Lockfile unchanged.
- Rebuilt `libhypen_engine.dylib` using `cargo build -p hypen-engine --release --features uniffi`. An old local library caused Kotlin's initial binding failures; the fresh build fixed them.
- Browser suite now accepts `HYPEN_CHROMIUM_PATH` and `HYPEN_BROWSER_REQUIRE=1`. Previously this Mac silently skipped the suite because the only executable path was a Linux path. Added DOM/Canvas fixture wiring and round-trip tests.
- Replaced an async-incompatible `DispatchGroup.wait()` in the Swift server ordering test with an awaited group notification. The original failed to compile on Apple Swift 6.3.3.
- Updated two Android expectations to match the new advertisement gate: undeclared microphone/Bluetooth capabilities are omitted, and unnegotiated requests return `unsupported`. Added explicit omission checks and a check that Bluetooth never starts.
- Merged duplicate JUnit license/notice resources so the Android instrumentation APK can package. Added a test-only manifest for network and camera permission status checks.
- Added opt-in native socket probes and a loopback TS fixture. Their assertions require successful negotiation, a successful platform permission result and the server's returned state patch.
- Added the intentionally failing Swift advertisement regression. The final Swift renderer suite is therefore **not green**; no expected-failure marker hides it.
- The first native iOS probe used notification status, but the unhosted XCTest runner terminated in `UNUserNotificationCenter.current()` because it has no application bundle proxy. The final shared probe uses camera status and passes. Notification behavior in a real app remains untested.

Physical iPhone attempt: the paired iPhone 13 appeared in both `devicectl` and Xcode destinations, but `xcodebuild ... build-for-testing` timed out. Xcode reported **“The developer disk image could not be mounted on this device.”** No physical-device test ran. This is an environment blocker, not a demonstrated Hypen failure. Android discovery found only the API 30 emulator.

## Reproduce

Run commands from the indicated package directory.

```sh
# hypen-web
bun install --frozen-lockfile
bun test
bun run typecheck
HYPEN_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  HYPEN_BROWSER_REQUIRE=1 bun test tests/device-browser.test.ts

# repository root
cargo test -p hypen-engine --features schema-export
cargo build -p hypen-engine --release --features uniffi
cargo test -p hypen-renderer-desktop --lib
cargo test -p hypen-server

# hypen-golang
HYPEN_E2E_REQUIRE=1 go test -race -count=1 ./...

# hypen-kotlin
JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ./gradlew test deviceE2eTest

# hypen-server-swift
LIBRARY_PATH="$PWD/../target/release" DYLD_LIBRARY_PATH="$PWD/../target/release" swift test
Tests/DeviceE2E/run.sh

# hypen-renderer-swift — this regression currently FAILS
swift test --filter testMicRecordFailsUnavailableWithoutOpeningTheMicWhenTheOverlayCannotShow

# hypen-renderer-android
JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ./gradlew :renderer:testDebugUnitTest
```

Native socket probe:

1. From `hypen-web`, leave `bun tests/fixtures/device-native-probe-server.ts` running on loopback port 44990.
2. Android: run `./gradlew :renderer:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=space.hypen.renderer.DeviceNativeSocketTest -Pandroid.testInstrumentationRunnerArguments.deviceServerUrl=ws://10.0.2.2:44990`. Use JDK 17. Without the argument this optional test skips.
3. iOS: use `xcodebuild -scheme HypenSwift -destination 'platform=iOS Simulator,id=<simulator-id>' -derivedDataPath /tmp/hypen-device-ios build-for-testing` from `hypen-renderer-swift`. In the generated `Build/Products/*.xctestrun` plist set `TestConfigurations[*].TestTargets[*].EnvironmentVariables.HYPEN_NATIVE_E2E` to `1`. Run `xcodebuild -xctestrun <file> -destination 'platform=iOS Simulator,id=<simulator-id>' -only-testing:HypenSwiftTests/DeviceNativeSocketTests test-without-building`. Setting only the parent shell's `SIMCTL_CHILD_HYPEN_NATIVE_E2E` did not propagate through Xcode here; the explicit test configuration did. Optional `HYPEN_NATIVE_E2E_URL` changes the server URL.

## Coverage still required

- Full real-device picker, save, camera, microphone and BLE behavior; permissions denied/revoked/limited; Android overlay/tapjacking; rotation, lock/background and interrupted platform pickers.
- All native/renderer × Go/Kotlin/Swift combinations; the Rust server and native desktop need implementations first.
- Oldest supported iOS, iPad, Android API 24/29/31/33/34+, mobile browsers, Edge/Safari/Firefox.
- Real OS save dialogs, cloud file providers, exact large-file boundaries through platform pickers, long recordings, network-loss stress and memory-soak runs.
- Node separately from Bun; Swift server on Linux; Cloudflare workerd/hibernation (included in the supplied plan, not executed here).

Environment: macOS arm64; Chrome 153.0.8010.53; Bun 1.3.11; Rust 1.94.0; Go 1.26.5; Apple Swift 6.3.3; JDK 17; Android emulator API 30; iPhone 17 Pro simulator iOS 26.5.

Evidence excerpts: [device-protocol-2026-09-25-evidence.txt](device-protocol-2026-09-25-evidence.txt). Complete transient command logs are under `/private/tmp/hypen-device-audit/`.
