# CLAUDE.md

This file provides guidance to Claude Code when working with the Hypen Kotlin SDK.

## Project Overview

The Kotlin SDK provides the module system for building Hypen applications on the JVM. It includes state management, action handling, lifecycle hooks, routing, and a Kotlin DSL — parallel to the TypeScript, Go, and Rust SDKs.

## Module Structure

```
hypen-kotlin/src/main/kotlin/space/hypen/core/
├── Engine.kt              # Engine interface (WASM via JNA)
├── NativeEngine.kt        # Native engine bindings
├── HypenServer.kt         # WebSocket server for remote UI
├── Session.kt             # Session management
├── AppBuilder.kt          # Fluent API for defining modules
├── ModuleInstance.kt      # Runtime module management
├── ObservableState.kt     # Reactive state with change tracking
├── Router.kt              # URL routing interface
├── ManagedRouter.kt       # Router with history management
├── GlobalContext.kt       # Cross-module communication
├── ComponentLoader.kt     # Dynamic component loading
├── ComponentResolver.kt   # Component path resolution
├── ComponentWatcher.kt    # File watching for hot reload
├── Events.kt              # Typed event emitter
├── Types.kt               # Core type definitions
├── ImportTypes.kt         # Import-related types
├── EngineError.kt         # Error types
├── Dsl.kt                 # Kotlin DSL for module definitions
├── Logger.kt              # Structured logging
├── Retry.kt               # Retry with backoff utilities
└── Utils.kt               # Utility functions
```

### Device Capability Protocol: one implementation, in Rust (RFC 001, provisional)

The Rust engine (reached through the UniFFI bindings, `uniffi.hypen_engine`) is the ONLY device protocol decoder, validator and negotiator: strict JSON limits, envelope and per-revision schemas, registry, handshake selection (`deviceHandshake`), frames, leases, credit, blob verification. Do not add a Kotlin re-implementation.

- `remote/device/DeviceTypes.kt` — thin typed surface only: param classes encoded with kotlinx (the broker validates them at open; invalid ⇒ local `invalidParams` refusal naming the field), result/event classes decoded with plain kotlinx from broker-validated JSON, the closed enums (`Permission`, `MediaType`, …), `DeviceErrorCode`, `Lifetime`.
- Conformance runs against the broker via UniFFI: `DeviceBrokerTranscriptReplayTest` (every shared transcript, server role; port of `hypen-engine-rs/tests/test_device_broker_transcripts.rs`) and `DeviceBrokerConformanceTest` (selection / handshake / payload / envelope corpora through `deviceSelectAck`, `deviceValidateHello|Ack` and a live broker). `BrokerDriver` is the shared test driver.

### Device plane on the Rust broker (server side, RFC 001)

- `remote/device/DevicePlane.kt` — the JVM host driver of one connection's Rust `DeviceBroker` (UniFFI): socket text/frames in, `poll()` outputs out (sink / handler consumers / settlements), one coroutine timer re-armed from `nextDeadline()` and run through `tick()`, transport buffered bytes reported before every poll, consumer-paced event/upload credit. Injectable `DeviceClock` (tests use the `kotlinx-coroutines-test` scheduler).
- `remote/device/DeviceContext.kt` — the handler API: `DeviceResult`, typed `Capability.*` (`UnaryCapability` / `JsonStreamCapability` / `BinaryStreamCapability`), `request` / `stream` / `events` (Flow) / `data` (Flow) / `save`, wrappers, handler scopes, replay firewall, owner-live checks.
- `core/DeviceServer.kt` — `HypenTransport` (optional `bufferedAmount()` = the socket's own pending bytes), `UpgradeRequest` / `Admission` (D1 admission), `DeviceServerConfig`, the ordered `OutboundQueue` (`buffered` = UTF-8 wire bytes queued + the transport's buffer), `TopLevelMember` (exact `hello.device` text).
- `HypenServer`: the device plane is **on by default** — every hello that offers `device` negotiates one, no call needed. `HypenServerBuilder.configureDevice { … }` tunes `DeviceServerConfig` (limits, budgets, `revisionOverride`, `helloTimeoutMs`; same defaults as before), `disableDevice()` is the one opt-out (exactly the old UI-only server). Nothing about device ever refuses to start the server. Compression (`compression`, default `true`) is independent of the device plane: device traffic may be compressed only per message — the negotiated permessage-deflate must carry `server_no_context_takeover` AND `client_no_context_takeover`. The route owns the Ktor transport: the example server's `HypenDeflate` (example-server/src/main/kotlin/HypenDeflate.kt) negotiates exactly that (Ktor 3.1.1's own `WebSocketDeflateExtension` can't as a server — see its KDoc and `HypenDeflateTest`), and `openConnection(key, transport, webSocketExtensions = …)` takes the negotiated response value so a context-takeover socket's `hello.device` gets a UI-only session (one warning; `PerMessageDeflate`); `null` = not reported (the route vouches). Admission (`admit`) is independent of device: `allowedOrigins` / `authenticate` are enforced exactly when configured; with neither, everything is admitted and one startup warning is logged. `openConnection` (hello-driven; device negotiation; hello timeout 1008 while device is on), `handleBinary`; the ack always carries a rotating `resumeToken`, which is REQUIRED only to resume / kick-old-take-over a session that had a negotiated device plane (`SessionManager.markDeviceSession` / `requiresResumeToken`) — UI-only sessions keep id-only resume. Legacy hello-less `handleConnect` works on every server (no device plane; a device session's id there starts a new session). Session setup order is `sessionAck` → device plane attach + `core.capabilities` → module mount (auto-wired `ManagedRouter` or route mount) → render → `initialTree`, so every module — including the auto-router's initial route module — is bound to a live plane before `onCreated` / `onActivated`. `handleMessage` bounds nesting (iterative `JsonNesting` scan, 256) before the lenient kotlinx parser; device-typed texts it will not parse go to the broker (counted violations), never a `StackOverflowError` into the host. Cross-language e2e: `./gradlew deviceE2eTest` (tag `e2e`, excluded from `test`; run by CI). `BaseModuleInstance` owns `deviceInstanceId` + activation ids (`activate`/`deactivate`/`destroy` → `ownerActivated`/`ownerDeactivated`/`ownerDestroyed`; navigating away cancels the module's activation-owned device work), `createDeviceContext`, `runReplayed`, `attachDevice`.
- Tests: `DevicePlaneTest` (real broker + scripted `FakeDeviceClient`, virtual time), `DeviceModuleLifecycleTest`, `HypenServerDeviceTest` (in-process transport, incl. the default auto-router path, on-by-default / `disableDevice` / compression independence, device on a no-context-takeover socket vs UI-only on a context-takeover one, UI-only vs device resume), `HypenServerDeviceDefaultsTest` (startup warnings), `HypenServerCompressionTest` (config + `PerMessageDeflate`), example-server `HypenDeflateTest` (`./gradlew :example-server:test --tests space.hypen.HypenDeflateTest`: real Ktor/Netty handshake + per-message decode), `OutboundQueueTest`, `DeviceWebSocketE2ETest` (tag `e2e`: Netty WebSocket + the hypen-web TS client in bun, `src/test/e2e/device_e2e_client.ts`; the server runs the default auto-wired router and a route module issues device work from `onActivated`).

## Development Commands

```bash
./gradlew test              # Run all tests (includes compatibility tests; excludes the e2e tag)
./gradlew deviceE2eTest     # Device e2e: TS web client (bun) ↔ HypenServer over a real WebSocket
                            # (needs bun + hypen-web/node_modules and the native library)
./gradlew build             # Build
```

## Architecture

Same module pattern as all Hypen SDKs:
- **AppBuilder** — fluent API: `app { state { ... } onAction("x") { ... } }`
- **ObservableState** — reactive state with path-based tracking
- **NativeEngine** — WASM engine access via JNA
- **HypenServer** — WebSocket server streaming patches to clients
- **Kotlin DSL** — idiomatic Kotlin builder syntax via `Dsl.kt`

## Key Dependencies

- Kotlin 2.0, kotlinx-coroutines, kotlinx-serialization-json
- JNA 5.14.0 (native engine bindings)
- JUnit 5 (testing)

## Testing

Tests live in `src/test/kotlin/`. The compatibility test runner integrates with `../engine-compatibility-tests/` fixtures to ensure cross-SDK consistency.

## Rust device broker via UniFFI (RFC 001)

The generated bindings (`src/main/kotlin/uniffi/hypen_engine/hypen_engine.kt`) expose the Rust
device broker: `DeviceBroker(configJson, pool: DeviceRetainedBytesPool?, nowMs)` with `start`,
`open(specJson, download: ByteArray?, nowMs)` → `DeviceOpenResult.Opened(id)` /
`.Refused(code, detail)`, `onText`, `onFrame`, `tick(nowMs)` → next deadline, `poll()` →
`List<DeviceOutput>` (`SendText`, `SendFrame(frame)`, `Event(id, eventJson)`,
`Data(id, channel, bytes)`, `Settled(id, DeviceOutcome.Success|Failure)`, `CloseConnection`),
`consumedEvents/consumedData`, `ownerActivated/Deactivated/Destroyed`, `cancel`,
`releaseResult`, `close(code)`, `infoJson()`, `revisionJson(capability, version)` (effective
revision JSON or null); plus `deviceHandshake` (validate + select `hello.device`, with the reason when disabled), `deviceNegotiate`, `deviceSelectAck`,
`deviceValidateHello`, `deviceValidateAck`, `deviceServerAdvertisementJson`,
`deviceConstantsJson`, `deviceIsOversizeText`, `deviceFileSaveParamsJson`, `deviceSha256Hex`,
`deviceServerConsumes(revisionJson)`.
Host errors throw `DeviceBindingException`. JSON shapes: `hypen-engine-rs/src/wasm/device_binding.rs`.
`src/test/kotlin/space/hypen/engine/DeviceBrokerBindingTest.kt` drives these generated bindings
against the native library under `./gradlew test` (upload + SHA-256, file.save download,
refusals, pools and sweeps, leases, background owners, revision/`deviceServerConsumes`).

Rebuild the native library and regenerate the bindings after engine changes:

```bash
cd ../hypen-engine-rs
cargo build --release --features uniffi                      # -> ../target/release/libhypen_engine.so
cargo run --bin uniffi-bindgen --features uniffi-cli -- generate \
    --library ../target/release/libhypen_engine.so --language kotlin \
    --out-dir ../hypen-kotlin/src/main/kotlin
# or: bash ../scripts/generate-bindings.sh   (Kotlin + Swift), or ./build-wasm.sh (everything)
```
