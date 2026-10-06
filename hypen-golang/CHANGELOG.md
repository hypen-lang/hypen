# Changelog

All notable changes to `hypen-golang` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed
- **The Go duplicate of the device protocol.** The Rust engine is the only
  device protocol decoder, validator and negotiator. `remote/device` drops the
  strict JSON decoder (`DecodeStrict`, `DecodeMessage`/`EncodeMessage`,
  `AttributeInvalid`, custom `UnmarshalJSON`/`MarshalJSON`), `SelectDeviceAck`,
  the frame codec (`EncodeFrame`/`DecodeFrame`/`ChannelSeq`), the registry mirror
  (`Registry`, `ValidateRequest`, `CheckRevision`), `ParseParams`/`ParseResult`/
  `ParseEvent`, every `Validate`/`Valid` method and the envelope/handshake/control
  types. It keeps the broker binding and plain encoding/json structs and enums
  for params, results and events. Typed helpers in `device` no longer pre-validate
  params: the broker refuses invalid ones at open (`CodeInvalidParams`, detail
  naming the JSON path; nothing is sent). `Files().Pick` sends a nil `Accept` as
  `[]`. `MicRecordParams.ChannelCount` (unused) is gone.

### Changed
- `Device.Save` no longer hashes in Go: the file.save announcement comes from
  Rust (`hypen_device_file_save_params`) through the new
  `device.Plane.FileSaveParams` (`remote/device.BrokerRuntime.FileSaveParams`),
  the same code the broker verifies the transfer with. Plane implementations
  must add the method.
- `DeviceConfig.AggregateRetainedBytes: 0` now resolves to the engine's
  `defaultProcessRetainedBytes` constant (Rust's
  `DEFAULT_PROCESS_RETAINED_BYTES`, currently 1 GiB) instead of a Go copy.
- **WebSocket compression is on by default again, device plane or not.**
  `CompressionEnabled()` / `Upgrader().EnableCompression` no longer turn false
  while the device plane is on; `DisableCompression()` /
  `ServerConfig.DisableCompression` still turn it off. gorilla/websocket
  negotiates permessage-deflate only with `server_no_context_takeover` and
  `client_no_context_takeover` (it answers exactly that even to a
  `permessage-deflate; client_max_window_bits` offer), so every message is
  compressed on its own and device data never shares a compression history
  with other messages — the mode clients require before enabling their device
  plane on a compressed socket. Go has no `syncActions`; nothing else changes.

### Added
- `remote/device.BrokerRuntime.SelectAck`, `ValidateHello`, `ValidateAck`,
  `Sha256Hex` and `Broker.Revision`, `OutstandingCredit`,
  `OutstandingEventCredit`, `ReopenCoreCapabilities` (Rust handshake and broker
  queries over the WASI ABI). Conformance (every shared transcript, the
  selection/messages/payloads corpora, frames.json, registry-v1.json) now
  replays through the Rust broker and negotiation via this binding.

### Fixed
- **Device admission on bring-your-own endpoints (decision D1).**
  `RemoteServer.Upgrader()` failed open on device-enabled servers (its
  `CheckOrigin` allowed every Origin); it now admits with `Admit` (allow-listed
  `Origin`, else the authenticator, fail closed → 403). `CreateSession` gives a
  device plane only to sessions whose upgrade was admitted: pass the request
  with the new `WithUpgradeRequest(r)` option (the built-in endpoint does).
  Without it, or when admission refuses it, the session is UI-only. The
  verdict is remembered per request, so the authenticator runs once per
  connection.
- **One trap no longer resets every connection's device plane.** The engine
  module is compiled once (`remote/device.BrokerModule`) and each connection's
  broker runs in its own instance (`BrokerModule.NewRuntime`); a trap closes
  only that connection (1011). The server's `AggregateRetainedBytes` budget
  still spans all connections: usage is reconciled in Go after every broker
  call, and the request that pushes the total over is cancelled (`cancel` to
  its client) and settles `throttled`, as the broker's own budget check does.
  `BrokerRuntime.TrapForTesting` drives fault-isolation tests.
- **Held upload results (TS parity).** Unary requests are opened with
  `holdResult`: a received upload keeps counting toward the connection's
  retained-bytes budget until the handler that got it returns (handler scope:
  `Device.Scoped`), then the charge is released (`release_result`); results
  delivered outside a scope are released on delivery. New
  `device.Plane.ReleaseResult`, `OpenSpec.HoldResult`, `Outcome.Held`,
  `remote/device.Broker.ReleaseResult`.
- Remote dispatch now strips the reserved `__hypenAnimate` payload key
  (the TS renderers' transaction-animation stamp, Option D) before module
  handlers run — handlers no longer observe renderer-internal directives.

### Known limitations
- The `animate:` event argument (transaction-scoped animation) is
  **TypeScript-host-only** for now. The Go host strips the stamp: the
  dispatch works, the resulting state flush snaps. Go's state-sync path
  (`NotifyStateChange` → `hypen_update_state`) has no animation envelope
  and the Go observable notifies synchronously per mutation, so honest
  stamping needs engine/interface work tracked separately. The
  `Patch.Spec` relay field remains so engine-emitted `batchAnimation`
  preludes survive transit.

### Changed
- **BREAKING:** Removed `IconPack`, the internal `svg.go` parser, and the `.Icons()` / `.IconsFromDir()` / `.IconFromFile()` builder methods. Use `Resources(map)` / `ResourcesDir(dir)` / `ResourcesFile(path)` instead — they forward raw SVG strings to the Rust engine, which now owns all SVG parsing. The `Icon("name")` / `Icon(@resources.name)` DSL syntax is unchanged.

### Added
- **Device plane on the remote server, on the Rust device broker (RFC 001,
  round 4).** On by default — no enable call: every connection that
  negotiates `hello.device` gets a device plane backed by the ONE
  broker implementation every server SDK shares (`hypen-engine`
  `device::DeviceBroker`, reached through the engine module's `hypen_device_*`
  WASI ABI with wazero — `remote/device.BrokerRuntime`/`Broker`).
  `RemoteServer.ConfigureDevice(DeviceConfig{...})` sets its options (same
  defaults), `DisableDevice()` is the one opt-out (the server then behaves
  exactly like the UI-only server), `DeviceEnabled()` reports it. Settings
  incompatible with the plane (an allow-multiple session config) turn it off
  with one startup warning; nothing device-related ever refuses to start.
  Native to Go: connection admission (`AllowedOrigins(...)`,
  `Authenticate(fn)`, `RemoteServer.Admit`) — enforced exactly when
  configured, for UI and device traffic alike; with neither every upgrade is
  admitted and `Prepare` logs one startup warning. Compression stays on
  (no context takeover in either direction), `sessionAck.device` + a rotating 256-bit
  `resumeToken` in every ack (constant-time checked; required only to resume a
  session that negotiated a device plane — UI-only sessions keep id-only
  resume: `SessionManager.MarkDeviceSession` / `RequiresResumeToken`), the
  legacy hello grace kept (a grace-initialised session has no device plane;
  a late hello can still negotiate one), the socket pump (text + binary
  frames, oversize device text counted before parsing), a timer driven by the
  broker's `tick()` deadline, and transport buffered bytes reported for bulk
  scheduling. Dispatches of a session with a negotiated plane run off the
  socket reader in arrival order; a handler waiting on the device yields the
  session's dispatch slot so later actions run meanwhile, and its state commit
  merges only the roots it changed. UI-only sessions dispatch as before.
- **Handler API: package `device`.** `ctx.Device()` on `ActionHandlerContext`
  and `TypedActionContext[T]` (never nil; unavailable without a plane):
  `Supports`, `Version`, `Request`, `Stream` (`Next`/`Result`/`Cancel`, credit
  replenished as the consumer returns), `Save`, `RequestAs[R]`, and typed helpers
  `Permissions().Query/Request` (closed `Permission` enum), `Gallery().Pick`,
  `Files().Pick/Save`, `Camera().Capture/Photo/Video`, `Mic().Record` (PCM16
  `onData`, verified result), `Bluetooth().Select/Scan`. Blocking calls take a
  `context.Context` (cancel → `cancelled`, deadline → `timeout`, both unwrap to
  the context error, and the deadline bounds the broker's `timeoutMs`); errors
  are `*device.Error` values with a closed `Code` (`errors.Is(err,
  device.ErrDenied)`). Options: `WithTimeout`, `WithInitialCredit`,
  `AllowZeroCredit`, `WithVersion`, `Background()`.
- **Activation authority tied to the module lifecycle.** `ModuleInstance`
  gets a device identity (`DeviceOwner`, `Device()`); with `WithDevicePlane`
  its `Activate`/`Deactivate`/`Destroy` drive the broker's owner activation and
  sweeps, and the `ManagedRouter` (`SetDevicePlane`) binds routed modules. The
  session activates its own primary/nested module owners before any handler
  runs. **Replay firewall:** agent dispatches (`Attach`/`DispatchExternal`) never
  acquire device authority (`unavailable`, `syncActions.replay`), a property of
  the `Device` value that survives goroutines and waits.
- **Late device hello binds Router apps.** A device hello arriving after the
  hello grace initialised the session (and auto-wired its `Router`) binds the
  plane to what the auto-wire built without one: the primary module's
  handlers act for the session's primary owner, the active routed module
  starts an activation at once and persisted ones on their next mount
  (`ManagedRouter.SetDevicePlane` now binds instances it already holds;
  `ModuleInstance.BindDevicePlane` / `BindDeviceOwner`). The late re-ack waits
  for the grace initialisation to finish, so it always follows the first ack
  and `initialTree`.
- `core.EngineWASM()`, `core.SharedCompilationCache()` (every runtime of the
  engine module compiles it once per process), `SessionManager.IssueResumeToken`
  / `VerifyResumeToken` / `Config`, `RemoteSession.ReceiveBinary`,
  `DeviceEnabled`, `ResumeToken`, `DeviceOwner`, `GorillaWebSocketTransport`
  `SendDeviceText`/`SendBinary` (the `DeviceTransport` route).
- Cross-language e2e: `remote/device_e2e_test.go` runs the TypeScript web client
  (hypen-web `RemoteEngine` + `FakeDeviceHost`, under bun) against this server
  over a real WebSocket.

### Changed
- `github.com/tetratelabs/wazero` v1.9.0 → v1.12.0 (its floor makes the module
  `go 1.25.0`; examples and `examples/social/go` tidied). Pinned by
  `TestDeviceBrokerABI_FileSaveAcrossSizes` (raw ABI, 1 B … 200 KB around the
  2 KiB and 64 KiB boundaries) and e2e saves of 2 KiB, 64 KiB + 1 and 300 KB;
  the e2e also covers successful `camera.capture` (photo and an
  undeclared-size video) and `bluetooth.select`.
- `github.com/tetratelabs/wazero` v1.8.2 → v1.9.0 (and `go 1.22.0`): v1.8.2's
  compiler traps with an out-of-bounds memory access in
  `hypen_device_broker_open` for any `file.save` above ~2 KiB (the interpreter
  and v1.9.0 run it correctly; pinned by `TestBrokerLargeDownload`).

### Added (earlier)
- **Device Capability Protocol wire layer (RFC 001 §6 Phase F, provisional).**
  New package `remote/device`: the three envelope messages
  (`DeviceRequest` / `DeviceResponse` / `DeviceEvent`) with exact camelCase
  wire tags, `Owner` (three shapes), `Lifetime`, `Control` (exactly one of
  grant / cancel / renewLease / leaseAck / paused), `DeviceError` with the
  closed ten-code taxonomy, the handshake extension (`DeviceHello`,
  `DeviceAck`, `CapabilityOffer`, `CapabilitySelection`,
  `CapabilitiesEvent`), `BlobStart` / `BlobItem`, typed params / result /
  event structs for the eight v1 capabilities, a registry mirror with
  `CheckRevision`, `SelectDeviceAck` (mirrors the Rust reference exactly),
  and the 12-byte little-endian frame codec (`EncodeFrame` / `DecodeFrame`,
  shortHeader vs violation classification). Decoding is strict (unknown
  fields rejected) and every type carries `Validate`. `DecodeMessage` /
  `EncodeMessage` route the device plane; nothing in the package satisfies
  `remote.Message`, so device traffic can never ride `broadcast()`.
  `schema_test.go` cross-checks struct tags, enums and bounds against the
  exported JSON Schemas; `conformance_test.go` replays every shared
  transcript, handshake and golden-frame fixture.
- **Attach mode for the agent surface.** `RemoteServer.Attach(sessionID)`
  returns a non-owning `remote.AgentHandle` bound to a live, hello-completed
  user session: `ListActions`, `Dispatch`, `GetState`, `Revision`,
  `SessionID`. `Dispatch` runs the engine's guarded `DispatchExternal` on the
  user's engine, so the user's transport receives exactly what a click emits
  (`patch` then `stateUpdate` at the next revision); a guard refusal returns
  `*core.EngineError` with no traffic and no revision bump. The handle never
  destroys, suspends or closes the session and returns `ErrSessionClosed`
  once it is gone. New errors `ErrNoSuchSession`, `ErrNoEngine`,
  `ErrSessionClosed`; new `RemoteSession.DispatchExternal`. `Ready()` now
  closes only after Router auto-wiring and before `OnConnection` callbacks,
  so attaching from one is supported. Attach is in-process only (no HTTP
  route) — the developer calling it is the authorizer.
- Drag-and-drop host side (`hypen-web/docs/dnd.md`):
  `ObservableState.Move(fromPath, from, toPath, to)` — a Go mirror of the
  engine's `portable::path_move` (`to` = final index clamped after removal,
  same-array `from == to` is a reported-true no-op, non-array / out-of-range
  leaves state untouched, nested tree destinations are re-addressed) that
  notifies both container paths; the reserved `__hypen_reorder`
  (`{fromPath, from, toPath, to}` or `{path, from, to}`; a missing `toPath`
  defaults to `fromPath`, §6.11) and `__hypen_pin`
  (`{path, x, y, xKey, yKey}`, two sets in one batched flush) actions are
  auto-registered next to `__hypen_bind` on every `ModuleInstance` and on
  engine-backed remote sessions (`core.ReorderActionName`,
  `core.PinActionName`, `core.ApplyReorderAction`, `core.ApplyPinAction`).
  Malformed payloads warn and no-op. Conformance is pinned against
  `engine-compatibility-tests/fixtures/dnd/path-move.json`.
- `core.LogHandler` — a pluggable log handler for routing Hypen logs into an
  application's own logging system (`slog`, `zap`, `logrus`, ...), reaching
  parity with the TypeScript and Kotlin SDKs. Install one with
  `core.SetLogHandler(h)`; `core.SetLogHandler(nil)` restores the default
  writer-based behaviour, and `core.GetLogHandler()` reports the current one.
  Handlers receive `(tag, format string, args ...any)` — the raw format string
  and its arguments, not a rendered line — so structured loggers can keep the
  template intact. Level filtering stays in the SDK, so handlers never re-check
  it. `core.LogHandlerFunc` adapts a single `func(level, tag, format, args...)`
  into a handler. Logs from the `remote` package route to the same handler
  (filtered by `remote.SetLogLevel`), so one handler covers the whole SDK. The
  existing `io.Writer` path (`SetLogOutput`, per-logger `SetOutput`) is
  unchanged and remains the default when no handler is installed.
- WebSocket **permessage-deflate compression (RFC 7692), enabled by
  default** on every upgrade and dial path in `remote`. Negotiated per
  connection, so peers that don't advertise the extension fall back to
  uncompressed frames automatically. Opt out via
  `ServerConfig.DisableCompression` / `RemoteServer.DisableCompression()`
  on the server and `EngineOptions.DisableCompression` on the client.
  New `RemoteServer.Upgrader()` returns the configured
  `websocket.Upgrader` so custom HTTP endpoints inherit the setting, and
  `RemoteServer.CompressionEnabled()` reports it. Note that
  `gorilla/websocket` supports no-context-takeover mode only.
- `core.NewApp[T]` — generic, strongly-typed module builder backed by a
  user-defined struct. Action and lifecycle handlers receive a
  `TypedActionContext[T]` / `*T` whose fields can be mutated directly; a
  diff against the pre-handler snapshot is batch-committed on return, so
  only changed top-level keys are notified to the engine.
- `core.TypedActionContext[T]`, `core.TypedActionHandler[T]`,
  `core.TypedLifecycleHandler[T]`.
- Documentation, doc comments, and the `examples/counter`,
  `examples/todo-app`, and `examples/router-app` programs updated to
  showcase the typed API as the recommended path. The untyped
  `NewAppBuilder` remains available and is the underlying foundation.

## [0.4.32] - 2026-02-19

### Added
- Initial changelog for the Go SDK
