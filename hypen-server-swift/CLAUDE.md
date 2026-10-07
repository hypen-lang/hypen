# CLAUDE.md

This file provides guidance to Claude Code when working with the Hypen Swift Server SDK.

## Project Overview

The Swift Server SDK (`HypenServer`) provides the module system for building server-driven Hypen applications in Swift. It includes state management, action handling, lifecycle hooks, routing, sessions, events, component discovery, and a WebSocket server — parallel to the TypeScript, Go, Kotlin, and Rust SDKs.

This package also includes the **HypenEngine** UniFFI bindings to the Rust engine, enabling native Hypen DSL parsing and patch generation. The `RemoteServer` uses `NativeEngine` to render Hypen DSL into patches that are streamed to connected clients.

## Module Structure

```text
hypen-server-swift/
├── Package.swift                           # Swift 6 package manifest
├── README.md                              # Full documentation with typed actions samples
├── Sources/
│   ├── hypen_engineFFI/                    # C FFI header for Rust engine (UniFFI)
│   │   ├── hypen_engineFFI.h
│   │   └── module.modulemap
│   ├── HypenEngine/                        # UniFFI-generated Swift bindings
│   │   └── hypen_engine.swift              # Auto-generated — do not edit manually
│   └── HypenServer/
│       ├── HypenServer.swift               # Public exports & version constant
│       ├── NativeEngine.swift              # Engine wrapper (UniFFI → server types)
│       ├── Types.swift                     # Patch, MessageType, AnyCodable, etc.
│       ├── ExternalCapabilities.swift      # AgentAction/AgentRoute/BoundInput (external surface)
│       ├── AgentHandle.swift               # Attach mode: agent surface bound to one live session
│       ├── ObservableState.swift           # Reactive state with path-based tracking
│       ├── AppBuilder.swift                # Fluent API + HypenAction + typed/async handlers
│       ├── ModuleInstance.swift            # Runtime module with error handling & session lifecycle
│       ├── Events.swift                    # TypedEventEmitter + framework events
│       ├── Router.swift                    # HypenRouter + RouteDefinition
│       ├── ManagedRouter.swift             # Route-driven module mount/unmount orchestration
│       ├── Session.swift                   # SessionManager with TTL, reconnection, policies
│       ├── GlobalContext.swift             # Cross-module communication hub
│       ├── ComponentLoader.swift           # Component registry + filesystem loading
│       ├── ComponentDiscovery.swift        # Filesystem scanning + file watcher
│       ├── ComponentResolver.swift         # Import resolution (local + URL)
│       ├── Logger.swift                    # Structured logging + pluggable HypenLogHandler
│       └── Remote/
│           ├── RemoteServer.swift          # WebSocket server (NIO + WebSocketKit)
│           ├── RemoteEngine.swift          # WebSocket client with auto-reconnect
│           └── Device/                     # Device Capability Protocol (RFC 001, provisional)
│               ├── DevicePlane.swift       # I/O driver of the Rust DeviceBroker (UniFFI): pump, timer, sinks
│               ├── DeviceContext.swift     # Handler API: ctx.device — typed requests, AsyncSequence streams, save, wrappers
│               ├── DeviceServerSupport.swift # Admission (D1), resume tokens, top-level member / `type` scanner, DeviceDigest
│               └── DeviceTypes.swift       # Handler-facing values only: typed params/results, error codes, lifetimes, revisions, constants (from Rust)
├── Tests/DeviceE2E/                        # Cross-language e2e: TS web client ↔ Swift server over a real WebSocket
│   ├── Server/main.swift                   # HypenDeviceE2EServer (executable target)
│   ├── device-e2e.test.ts                  # bun test: RemoteEngine + FakeDeviceHost against it
│   └── run.sh                              # builds the server, runs the bun test
├── Tests/HypenServerTests/
│   ├── DevicePlaneTests.swift              # DevicePlane + DeviceContext over the real broker, manual clock
│   ├── DeviceSessionTests.swift            # On by default, disableDevice, handshake, resumeToken, grace, replay firewall, resets, admission
│   ├── DeviceHostTestSupport.swift         # Manual clock, recording sink, raw client wire helpers
│   ├── DeviceBrokerBindingTests.swift      # The generated UniFFI broker bindings
│   ├── DeviceConformanceTests.swift        # Shared corpus through the runtime path: session routing, handshake helpers, broker
│   ├── DeviceSessionRoutingTests.swift     # Client-sent deviceRequest transcripts replayed through RemoteSession.receive
│   ├── DeviceTranscriptTests.swift         # Every transcript replayed through DevicePlane + the Rust broker (server role)
│   ├── DeviceCapabilityCoverageTests.swift # Typed API vs broker: permissions, camera, mic channels, bluetooth.select, pin cap
│   ├── DeviceFixtureSupport.swift          # Exact-span fixture reader + serializer, hex, SHA-256
│   ├── WebSocketTransportOrderingTests.swift # WebSocketKitTransport write order over a real loopback WebSocket
│   ├── ObservableStateTests.swift          # State management tests
│   ├── AppBuilderTests.swift              # Builder API, typed actions, async, lifecycle
│   ├── EventsTests.swift                  # TypedEventEmitter tests
│   ├── RouterTests.swift                  # Router path matching & navigation
│   ├── ManagedRouterTests.swift           # Route-driven module lifecycle
│   ├── SessionTests.swift                 # Session lifecycle, TTL, reconnection
│   ├── GlobalContextTests.swift           # Cross-module communication tests
│   ├── ComponentTests.swift               # ComponentLoader, import parsing, resolver
│   ├── NativeEngineTests.swift            # Engine rendering, state, actions, patches
│   ├── ExternalCapabilitiesTests.swift    # External surface: allowlists, refusals, destroy-only unregister
│   └── AgentAttachTests.swift             # Attach mode: wire-identical dispatch, silent refusal, never-destroys
└── Examples/
    └── CounterExample.swift                # Example modules
```

## Development Commands

The native Rust library must be built before `swift build` or `swift test`:

```bash
# Build the native engine (required first)
cd hypen-engine-rs
cargo build --release --features uniffi

# Then build/test the Swift package (Linux)
# Note: the workspace target dir is hypen-rs/target/release (workspace root), not hypen-engine-rs/target/release.
cd ../hypen-server-swift
LD_LIBRARY_PATH=../target/release LIBRARY_PATH=../target/release swift build
LD_LIBRARY_PATH=../target/release LIBRARY_PATH=../target/release swift test

# macOS uses DYLD_LIBRARY_PATH for runtime, but the linker also needs LIBRARY_PATH
DYLD_LIBRARY_PATH=../target/release LIBRARY_PATH=../target/release swift test

# Or use the convenience script
./build-engine.sh   # builds the Rust library and prints the test command
swift package clean  # Clean

# Device protocol cross-language e2e (TS client ↔ Swift server, real WebSocket)
Tests/DeviceE2E/run.sh
# Low-disk machines: add -Xswiftc -gnone -Xcc -g0 to swift build/test/run.sh
```

## Architecture

Same module pattern as all Hypen SDKs:
- **AppBuilder** — fluent API with typed (`Codable`) and async action handlers
- **HypenAction** — protocol for type-safe action enums
- **ObservableState** — reactive state with path-based tracking
- **ModuleInstance** — runtime module with error handling and session lifecycle
- **TypedEventEmitter** — type-safe event system with `EventKey<T>`
- **HypenRouter** — URL routing with path params, wildcards, query parsing
- **ManagedRouter** — route-driven module mount/unmount orchestration
- **SessionManager** — TTL-based session persistence with concurrent policies
- **GlobalContext** — cross-module communication (dispatch, events, state)
- **ComponentLoader** — component registry with filesystem loading
- **ComponentDiscovery** — filesystem scanning with file watcher for hot reload
- **ComponentResolver** — import resolution from local files and remote URLs
- **RemoteServer** — WebSocket server streaming state/patches to clients
- **AgentHandle** — attach mode: guarded, non-owning agent view of one live session via `RemoteServer.attach(_:)` (see Engine Integration below)
- **RemoteEngine** — WebSocket client with auto-reconnect

## Engine Integration

The `NativeEngine` class wraps the UniFFI-generated `HypenEngine` to provide:
- Hypen DSL parsing → patch generation via `renderSource(_:)`
- Reactive state updates → incremental patches via `updateState(_:)`
- Action dispatch and pending action processing
- Component registration and import resolution
- The **external capability surface** for callers that are not the rendered UI
  (`listActions()`, `listRoutes()`, `listBindings()`, `dispatchExternal(_:payload:)`,
  `getStateAt(module:path:)`, `unregisterModule(_:)`)

### External callers must not use `dispatchAction`

`dispatchAction(_:payloadJson:)` queues *any* registered action, which is right
for a renderer — it owns `router.push` and `__hypen_bind`. Anything that is not
the rendered UI (MCP server, REST handler, CLI, agent) goes through
`dispatchExternal(_:payload:)`, which the Rust engine guards against an
allowlist built from what the app declares: `.onAction()`, `Router { Route }`,
`.bind(@state.x)`. Never reimplement that allowlist in Swift.

`unregisterModule(_:)` is a **destroy-path call only**. Under the default
`persist: true` an off-screen module stays registered on purpose so siblings can
read its state; unregistering on unmount breaks the persist cache and every
cross-module read. `ManagedRouter` calls it in exactly two places — the
`persist: false` unmount branch and `stop()`'s teardown of persisted instances.

### Attach mode (`RemoteServer.attach(_:)` → `AgentHandle`)

`server.attach(sessionID)` binds the agent surface to an *existing* live
user session (`Sources/HypenServer/AgentHandle.swift`): `dispatch(_:payload:)`
runs `RemoteSession.dispatchExternal` on that user's engine, so the user's
own transport receives exactly what a click emits — `patch` at the next
revision, then `stateUpdate` — and a guard refusal throws, sends nothing, and
bumps no revision. The handle holds the session weakly and **never destroys,
suspends, or closes it**; once the user's session is gone every handle method
throws `AgentHandleError.sessionGone`. `attach` returns nil unless the session
has completed hello → initialTree (`RemoteSession.isReady`) — before the
initial render the engine's declaration tables are empty and every external
dispatch would be refused. Authorization is the caller's: there is no HTTP
route, and whoever holds the `RemoteServer` already holds every session.

**Attach requires a typed module** (`module(_:_:)` with a `ModuleDefinition`).
The legacy untyped `withState(_:_:)` + `onAction(_:)` shim is consulted only by
`RemoteSession.handleDispatchAction` and never registers engine handlers or
declares actions, so under it `listActions()` is empty and the guard refuses
every attached dispatch.

The `RemoteServer` creates a per-client `NativeEngine` instance. On connection, it renders the DSL template into patches sent as the `initialTree`. On state changes, it calls `updateState()` to produce incremental patches.

To regenerate bindings after engine changes:
```bash
./scripts/generate-bindings.sh
```

## Transport: no WebSocket compression

`RemoteServer` does **not** negotiate RFC 7692 `permessage-deflate`, unlike the
other Hypen server SDKs, and `ServerConfig` has no `compression` option as a
result. `NIOWebSocketServerUpgrader` never reads or echoes
`Sec-WebSocket-Extensions`, and WebSocketKit has no compression support
(vapor/websocket-kit#55, open since 2020). The maintained Swift RFC 7692
implementation (`WSCompression` in hummingbird-project/swift-websocket) is
bound to that package's own `WSCore` upgrade stack and cannot be spliced into
this pipeline.

This is protocol-safe: clients offering the extension get a 101 that does not
accept it and fall back to uncompressed frames. **Do not make `shouldUpgrade`
echo the extension header without also installing a compressor/decompressor** —
accepting an unimplemented extension breaks clients hard. See the comment block
at the upgrader site in `Sources/HypenServer/Remote/RemoteServer.swift` and the
Compression section in `README.md`.

## Device Capability Protocol (RFC 001) — device plane

The protocol state machine is the ONE Rust broker (`hypen-engine-rs/src/device/`,
UniFFI `DeviceBroker`) every server SDK uses; Swift adds only networking and the
app-facing API. Never re-implement broker logic (ids, leases, credit, blob
verification, scheduling, core.capabilities, violation reactions) in Swift.

- **Always on**: there is no enable call. Every `RemoteServer` negotiates a
  device plane for any client whose hello offers `device`.
  `configureDevice(DeviceServerOptions(...), processRetainedBytes:)` only
  changes options (defaults otherwise; `prepare()` validates configured options
  with a throwaway broker and throws `invalidDeviceOptions` — the only device
  error that stops a server). `disableDevice()` is the one opt-out (wins
  regardless of call order). `deviceEnabled` / `deviceIncompatibility` are
  read-only status. **Never** throw or refuse to start for a device
  prerequisite: an incompatible setting (`SessionConfig.concurrent =
  .allowMultiple`, via `RemoteServer(sessionConfig:)`; also checked per session
  in `RemoteSession.sessionDeviceOptions` for custom `SessionHost`s) turns the
  plane off with ONE startup warning from `prepare()`. `SessionHost`'s default
  `deviceOptions` is `DeviceServerOptions()` (on).
- **Admission (D1)** runs in NIO `shouldUpgrade` (`DeviceAdmission.refusal`),
  not tied to the device plane: each of `allowedOrigins` / `authenticate` is
  enforced exactly when configured (Origin present + allowlist → must match;
  Origin absent + allowlist without authenticator → refuse; a configured
  authenticator runs for every request that passed the Origin check). Neither
  configured → admit, with ONE startup warning from `listen()`
  (`admissionWarning`). A declined upgrade reaches `HTTPHandler`, which answers
  **403**. No WebSocket compression (see below).
- **Handshake**: `RemoteSession` reads `hello.device` as the raw member text
  (`deviceFindTopLevelMember`, never the `JSONSerialization` value) and calls
  `deviceHandshake(helloJson:binaryRoute:serverCapabilitiesJson:)` (the
  `deviceNegotiate` selection plus a reason); no ack disables the plane and
  the reason is logged.
  `sessionAck` carries `device` (the Rust ack, only when negotiated) and,
  always, `resumeToken` (256-bit, rotated per ack, constant-time compare in
  `SessionManager`). A session that has had a device plane (sticky:
  `issueResumeToken(_:devicePlane:)` / `resumeRequiresToken`) is resumed only
  with its current token — its id alone is a NEW session; a UI-only session
  keeps the legacy id-only resume. The hello grace (`helloGraceMs`) applies
  regardless of the device plane; a grace-initialised session has none. Without
  a grace window a `DeviceTransport` connection is closed 1008 after
  `helloTimeoutMs`. `dispatchAction` before hello is dropped.
- **Routing**: the message `type` is resolved like `JSON.parse` (the LAST
  top-level `type` wins; `deviceMessageType`, nothing else validated), and
  EVERY device type — `deviceRequest`, `deviceResponse`, `deviceEvent`
  (`RemoteSession.deviceMessageTypes`) — goes to `DevicePlane.receiveText` as
  exact text. A client-sent `deviceRequest` is the broker's to judge
  (liveness before direction, D8: ignored on an unknown id, `invalidParams` +
  `cancel` on a live one); never drop it on the way. So malformed device
  JSON (a duplicated `type` or `id`, number spellings, depth, even non-JSON
  after the type) reaches the broker and is counted, exactly as on the TS
  server (oversize text → `reportViolation` before parsing). Never route on a strict or `JSONSerialization` parse; binary
  WebSocket frames → `session.receiveBinary` → `receiveFrame`. Server → client
  device traffic uses the dedicated `DeviceTransport` routes
  (`sendDeviceText`/`sendBinary`/`bufferedAmount`), never `OutgoingMessage`.
  `WebSocketKitTransport` counts in-flight write bytes as the buffered amount,
  and writes in exactly the order its methods were called, from any thread:
  every write (and `close`) goes through one FIFO outbox drained on the event
  loop. Never call `ws.send` directly — NIO writes immediately on the loop but
  queues writes from other threads, so a frame sent on the loop (the pump
  after a credit grant) overtook frames queued from the clock queue or a
  handler task and broke downloads (`download seq N, expected M`).
  `WebSocketTransportOrderingTests` checks this over a real loopback socket.
- **DevicePlane** (one per connection): recursive lock around every broker
  call, outputs dispatched in broker order, ONE timer re-armed from
  `nextDeadline` and run via `tick` (`DeviceClock`; inject a manual clock in
  tests). A broker `closeConnection` → `RemoteSession.closeDevicePlane` →
  every module detached, socket closed 1012. Session `destroy()` closes the
  plane (`connectionLost`) before module teardown.
- **Ownership**: `ModuleInstance.deviceInstanceId` + a per-`activate()`
  `activationId`; `activate` → `ownerActivated` BEFORE `onActivated`,
  `deactivate` → `ownerDeactivated` BEFORE `onDeactivated`, `destroy` →
  `ownerDestroyed`. The primary module is activated after `initialTree`;
  `ManagedRouter.attachDevice` binds route modules before they activate.
- **Handler API** (`ctx.device`, `onActivatedAsync { state, device in }`):
  `supports`, `request(PermissionQuery(.camera))` → `DeviceResult<T>` =
  `Result<DeviceValue<T>, DeviceError>` (never throws; `.simulated`),
  `stream(BluetoothScan())` / `stream(MicRecord(...))` as `AsyncSequence`
  (credit returned as the `for await` loop advances; leaving the loop
  cancels), `save(_:name:contentType:)`, wrappers `permissions`, `camera`,
  `mic`, `bluetooth`, `gallery`, `files`. Swift `Task` cancellation cancels
  the request on the wire. Async handlers get a handler scope (pending unary
  work cancelled when the handler returns). The replay firewall is the
  `@TaskLocal DeviceProvenance.current`: `RemoteSession.dispatchReplayed`,
  `RemoteServer.broadcastAction` and `ModuleInstance.runReplayed` build
  contexts that answer `unavailable` ("replay").
- **Background lifetime**: only revisions that list it (e.g.
  `DeviceServerOptions.revisionOverrides`) admit it; the pin cap
  (`maxBackgroundOwners`, default 2) is the broker's — a further module's
  background request is refused `throttled`. `ManagedRouter` never evicts
  persisted modules, so `hasLiveBackgroundDeviceWork` is informational.
  `prepare()` builds a throwaway broker with the options and throws
  `invalidDeviceOptions` when the broker refuses them.
- **E2E**: `Tests/DeviceE2E/run.sh` (TS `RemoteEngine` + `FakeDeviceHost`
  over a real WebSocket against `HypenDeviceE2EServer`; extra arguments go
  to `swift build`, e.g. `--scratch-path`). The server writes its `E2E {json}`
  reports on **stderr**, one direct write per line; stdout is the logger's
  (`print`, block-buffered on a pipe). Don't move reports back to stdout and
  don't `fflush(NULL)` there: it takes stdin's lock, which the command
  thread holds inside `readLine`, and deadlocks the event loop.

## Device Capability Protocol (RFC 001) — no Swift wire layer

There is no Swift implementation of the device protocol: no strict JSON
parser, envelope/handshake decoders, frame codec, seq rule, registry or
payload validator. The Rust broker is the only one (the iOS *client* has
its own in `hypen-renderer-swift`). Rules:

- **Params out**: typed params are `Encodable` structs encoded with
  `JSONEncoder` (`DeviceBrokerJSON.encode`) and handed to `broker.open`,
  which validates them against the selected revision; a refusal is a
  `DeviceError` value and nothing is sent. `file.save` announcements come
  from the engine (`deviceFileSaveParamsJson`). Do not pre-validate in Swift.
- **Results/events in**: decode only JSON the broker produced after
  validating it (`DeviceOutcome.success.resultJson`, `DeviceOutput.event`)
  with `JSONDecoder` (`DeviceBrokerJSON.decode`). **Never decode client text
  in Swift** (Swift 6.0.3 FoundationEssentials `JSONDecoder` `try!`s
  unvalidated keys) — client text goes to the broker untouched.
- The untyped API takes/returns JSON text (`requestUntyped(_:paramsJSON:)`,
  `DeviceUntypedResult.resultJSON` / `.decode(_:)` / `.object`).
- Constants come from `deviceConstantsJson()` (`DeviceProtocol`); revisions
  from `DevicePlane.revision` (the broker's `revisionJson`).
- Conformance runs the shared corpus through the runtime path
  (`DeviceConformanceTests`, `DeviceTranscriptTests`): every messages.json
  case through `RemoteSession.receive`, handshake cases through
  `deviceValidateHello/Ack`, `deviceNegotiate` and a real session, selection
  through `deviceSelectAck`, payloads through `DevicePlane.open` and live
  requests, frames through `receiveBinary`, and every transcript through
  `DevicePlane` in the server role (mirroring the TS server replay).
- Transport: `RemoteServer` sets NIO `maxFrameSize` and the WebSocketKit
  aggregator to `DeviceProtocol.transportMaxInboundMessageBytes` (2 MiB, at
  least the 65,548-byte binary frame and above the 1 MiB device text limit).

## Key Dependencies

- Swift 6.0+
- Rust `libhypen_engine` (built with `--features uniffi`)
- WebSocketKit (Vapor's NIO-based WebSocket)
- SwiftNIO (async networking)

## Testing

Tests use XCTest. Requires native Rust library (see Development Commands above). Tests cover:
- ObservableState (get/set/nested/replace/onChange)
- AppBuilder (untyped, typed Codable payloads, async, lifecycle hooks)
- ModuleInstance (dispatch, bind, destroy, session lifecycle)
- TypedEventEmitter (on/once/emit/unsubscribe)
- HypenRouter (push/replace/back/matchPath/params/query)
- ManagedRouter (mount/unmount/persist/inline)
- SessionManager (create/suspend/resume/expire/stats)
- GlobalContext (register/dispatch/events/global state)
- ComponentLoader (register/get/names/clear)
- Import parsing (named/default/URL/multiple)
- ComponentResolver (registry lookup/cache)
- NativeEngine (DSL rendering, state updates, actions, components, patch format)
- ExternalCapabilities (allowlists, refusals, destroy-only unregister)
- AgentAttach (wire-identical dispatch, silent refusal, never-destroys)
- Device plane (DevicePlane/DeviceContext over the real Rust broker with a manual clock:
  typed unary requests, uploads with hash verification, downloads within granted credit,
  AsyncSequence streams with credit, Task cancellation, leases/deadlines, replay firewall,
  activation sweeps and background lifetime, handler scopes, violation resets; RemoteSession:
  on by default, `disableDevice`, incompatible
  settings, handshake, resume tokens (token vs id-only), hello grace, admission) and the
  cross-language e2e
- Device Capability Protocol conformance through the runtime path (the shared messages,
  handshake, selection, payload and frame corpora via RemoteSession / the negotiation helpers /
  DevicePlane, every transcript replayed through the Rust broker in the server role, routing
  of malformed device JSON incl. a duplicated `type` and of client-sent `deviceRequest`s
  through `RemoteSession`, the background pin cap)
- Device test awaits are bounded: `settle(_:)` / `awaitBounded(_:timeout:)` return at the
  timeout even when the awaited task ignores cancellation (never a task group, whose scope
  waits for every child — a lost device outcome then hung the whole xctest process).
  Wrap any await on a device outcome or a `for await` loop in `settle`.

## Rust device broker via UniFFI (RFC 001)

`Sources/HypenEngine/hypen_engine.swift` + `Sources/hypen_engineFFI/hypen_engineFFI.h` expose the
Rust device broker: `DeviceBroker(configJson:pool:nowMs:)` with `start`, `open(specJson:download:nowMs:)`
→ `DeviceOpenResult.opened(id:)` / `.refused(code:detail:)`, `onText`, `onFrame(frame: Data)`,
`tick(nowMs:)` → next deadline, `poll()` → `[DeviceOutput]` (`.sendText`, `.sendFrame(frame:)`,
`.event(id:eventJson:)`, `.data(id:channel:bytes:)`, `.settled(id:outcome:)` with
`DeviceOutcome.success/.failure`, `.closeConnection`), `consumedEvents/consumedData`,
`ownerActivated/Deactivated/Destroyed`, `cancel`, `releaseResult`, `close(code:)`, `infoJson()`,
`revisionJson(capability:version:)`; plus `deviceHandshake` (selection + disable reason),
`deviceNegotiate`, `deviceSelectAck`,
`deviceValidateHello`, `deviceValidateAck`, `deviceServerConsumes(revisionJson:)` and the
other `device*` helpers. Host errors throw `DeviceBindingError`. JSON shapes:
`hypen-engine-rs/src/wasm/device_binding.rs`. `Tests/HypenServerTests/DeviceBrokerBindingTests.swift`
drives these generated bindings against the native library under `swift test` (the test target
depends on `HypenEngine` directly).

Rebuild the native library and regenerate the Swift bindings after engine changes:

```bash
cd ../hypen-engine-rs
cargo build --release --features uniffi                      # -> ../target/release/libhypen_engine.so
bash ../scripts/generate-bindings.sh                         # regenerates hypen_engine.swift + hypen_engineFFI.h
# (the Apple xcframework `hypen_engineFFI.xcframework` must be rebuilt on macOS separately)
```
