# Device Lab

Interactive app for testing the actual Hypen clients against local SDK servers.
This app uses the platform device hosts, not scripted device drivers. All five
variants, including Rust, use the current SDK device APIs.

## Start

Run each command in a separate terminal, from the indicated directory:

```sh
# Repository root: web page on 45100 and TS server on 45101
bun examples/device-lab/server.ts

# hypen-golang: Go server on 45102
go run ./cmd/device-lab

# hypen-kotlin: Kotlin server on 45103 (requires built native engine)
JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ./gradlew deviceLab

# hypen-server-swift: Swift server on 45104 (requires built native engine)
LIBRARY_PATH="$PWD/../target/release" DYLD_LIBRARY_PATH="$PWD/../target/release" swift run HypenDeviceLab

# examples/device-lab/rust: Rust SDK device server on 45105
cargo run
```

Open `http://127.0.0.1:45100/?renderer=dom` or
`http://127.0.0.1:45100/?renderer=canvas`. The server selector reconnects the
renderer to the selected backend.

In Hypen Browser or the iOS Gallery app, connect to
`ws://127.0.0.1:45101/ws?token=device-lab`. In the Android emulator, use
`ws://10.0.2.2:45101/ws?token=device-lab`. Change the port for each backend.
The native Gallery apps enable their real device host for URLs containing
`device-lab`. Their test application manifests include the required usage
descriptions and permissions.

## Fixtures and evidence

- `sample.txt`: 102,000-byte text upload fixture. The Save button generates the same 102,000-byte payload (its historical UI label says Save 96K).
- `empty.txt`: zero-byte file fixture.
- `../../hypen-browser/assets/icons/icon-512.png`: repository-owned photo fixture.
- `results-2026-09-26/ts.jsonl`: TS action results from the interactive app.
- `results-2026-09-26/uploads/`: received bytes named by SHA-256, for comparison with fixtures.
- Other backends print `DEVICE_LAB` action results to their terminal.

The Cancel button currently cancels pending TS and Go requests. The Kotlin and
Swift demo handlers currently instruct the tester to use the host's Cancel/Stop
control; app-originated cancellation still needs wiring there. Route lifetime,
background lifetime, all permission names, large-file boundaries, and reconnect
controls have not yet been added to this app.

## Live execution status

All 25 pairings were exercised again at `773d936d`. The iOS compression and
desktop audio regressions now pass with normal server defaults. One initial iOS
Go gallery request returned `presentation-failed`; three identical retries passed.
The report records this intermittent failure and the exact coverage limits.

See [LIVE-RESULTS.md](LIVE-RESULTS.md) for the exact matrix, reproduction steps,
screenshots, verified payload hashes, and checks that remain blocked or untested.
The earlier automated-suite report is not a substitute for these live results.

## Re-run native UI flows

Android (with the installed Gallery app and a running emulator):

```sh
/usr/bin/python3 examples/device-lab/android-matrix.py 45102 Go
```

The script captures native UI XML and screenshots; inspect the recorded outcomes.
It intentionally records unsupported and failed actions rather than treating every
completed script as a passing test. The iOS XCTest driver uses the Gallery scheme:

```sh
xcodebuild test \
  -project hypen-renderer-swift/Gallery/HypenGallery/HypenGallery.xcodeproj \
  -scheme HypenGallery \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -parallel-testing-enabled NO \
  -only-testing:HypenGalleryUITests/DeviceLabUITests
```

Seed `hypen-browser/assets/icons/icon-512.png` in the simulator's Photos first.
The UI driver currently matches its original Photos label, `Photo, September 25,
17:30`; update that label when reseeding. Native app builds need the platform
toolchains and existing project dependencies. The TS request deadline is 45s.
Reload browser pages after server restarts to avoid stale rendered trees.

## Compression regression comparison

The previous revision used `DEVICE_LAB_NO_COMPRESSION=1` on TS/Go to isolate the
iOS regression. The current retest passes with that variable omitted. Keep the
variable unset for normal testing. The Kotlin lab transport does not
negotiate compression; testing its production compression path remains separate.

Use `DEVICE_LAB_RESULTS=results-773d936d` with the Android driver to write evidence
to the latest round's directory. Previous evidence directories are retained.
