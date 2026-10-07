# CLAUDE.md

This file provides guidance to Claude Code when working with the Hypen Go SDK.

## Project Overview

The Go SDK (`github.com/hypen-space/core`) provides the module system for building Hypen applications in Go. It includes state management, action handling, lifecycle hooks, routing, and a remote UI server — parallel to the TypeScript, Kotlin, and Rust SDKs.

## Module Structure

```
hypen-golang/
├── app.go                # AppBuilder — fluent API for defining modules
├── context.go            # GlobalContext for cross-module communication
├── state.go              # ObservableState — reactive state
├── events.go             # Typed event emitter
├── router.go             # URL routing interface
├── managed_router.go     # Router with history management
├── logger.go             # Structured logging
├── resolver.go           # Component path resolution
├── renderer.go           # Renderer interface
├── loader.go             # Dynamic component loading
├── discovery.go          # Component file discovery
├── errors.go             # Error types
├── doc.go                # Package documentation
├── wasm_engine.go        # WASM engine via Wazero
├── *_test.go             # test files (device_plane_test.go: Device() on contexts, activation lifecycle, resume tokens)
├── device/               # Handler-facing device API (RFC 001): ctx.Device() → Device (Supports/Version/Request/
│                         #   Stream/Save/RequestAs + Permissions/Gallery/Files/Camera/Mic/Bluetooth helpers),
│                         #   *Error with closed Code, Plane/Sink/Waiter interfaces the remote server implements
└── remote/               # Remote UI protocol
    ├── server.go         # WebSocket server (device plane on by default: ConfigureDevice/DisableDevice;
    │                     #   AllowedOrigins/Authenticate + Admit: admission when configured; startup warnings)
    ├── session.go        # Per-connection session (hello.device, sessionAck.device + resumeToken, dispatch queue)
    ├── session_device.go # Device handshake/attach, session module owners, dispatch provenance, state merge
    ├── device_plane.go   # DeviceConfig + sessionDevice: pumps socket ⇄ Rust broker, tick() timer, sinks
    ├── dispatch_queue.go # FIFO dispatch slot; device waits yield it (device.Waiter)
    ├── client.go         # WebSocket client
    ├── types.go          # Protocol types
    ├── remote_test.go    # Remote UI tests
    ├── device_*_test.go  # Device plane over real WebSockets (Go client) + device_e2e_test.go (TS client via bun,
    │                     #   testdata/device_e2e_client.ts)
    └── device/           # Go binding of the ONE device protocol implementation (the Rust broker; RFC 001, provisional)
        ├── broker.go         # Rust broker over the hypen_device_* WASI ABI (BrokerModule/BrokerRuntime, Broker, Output
        │                     #   decoding) + Rust handshake helpers (Negotiate, SelectAck, ValidateHello/ValidateAck)
        ├── types.go          # Thin typed surface ONLY: plain encoding/json structs for capability params/results/events,
        │                     #   closed string enums, DeviceErrorCode, Lifetime, transport constants (MaxMessageBytes,
        │                     #   FrameHeaderLen). No validation: the broker validates params at open and results/events
        │                     #   before they reach Go
        ├── broker_test.go    # The binding against the shipped hypen_engine.wasm (upload, download, refusals, pools, traps)
        ├── driver_test.go    # Test driver around the real broker (server role) + strict fixture loader (dup keys fail)
        ├── conformance_test.go        # Every shared wire transcript replayed through the Rust broker (Go port of
        │                              #   test_device_broker_transcripts.rs) + handshake fixtures via SelectAck + frames.json
        │                              #   through a live broker; every registry capability requested (and every unary one
        │                              #   completed) by a positive transcript; closed fixture format
        ├── conformance_shared_test.go # conformance/{selection,messages,payloads}.json through SelectAck/ValidateHello|Ack and a
        │                              #   live broker (typed structs decode every broker-validated value); registry-v1.json ==
        │                              #   the revisions the broker enforces; every revision has valid+invalid payload cases
        ├── types_test.go     # Typed structs/enums vs ../engine-compatibility-tests/schema/device/; constants vs the broker
        └── fuzz_test.go      # Native fuzz targets on the binding (OnText/OnFrame into a live broker; seeds run under go test)
```

The Rust engine is the ONLY device protocol decoder, validator and negotiator (strict JSON limits, envelope
and per-revision schemas, registry, handshake selection, frames, leases, credit, blob verification). Do not
add a Go re-implementation. Adding a capability revision: add it in Rust (`registry()` in
`hypen-engine-rs/src/serialize/device.rs` + the broker), rebuild `hypen_engine.wasm`, then add plain typed
structs/enums to `remote/device/types.go` (and helpers in `device/typed.go`) and list them in
`types_test.go`; the shared schemas, registry-v1.json, corpus and transcripts are consumed through the
broker with no skips: `go vet ./... && go test -race -count=1 ./...`.

## Development Commands

```bash
go test ./...              # Run all tests
go test ./... -v           # Verbose test output
go build ./...             # Build
go doc ./...               # View documentation
```

## Architecture

Same module pattern as all Hypen SDKs:
- **AppBuilder** — fluent API: `app.DefineState(...).OnAction("x", handler).Build()`
- **ObservableState** — reactive state with path-based tracking
- **WasmEngine** — WASM engine access via Wazero runtime
- **Remote Server/Client** — WebSocket-based patch streaming

## Device plane (RFC 001) on the remote server

One broker implementation for every server SDK: the Rust `device::DeviceBroker`, reached through
`remote/device.BrokerRuntime`. The engine module is compiled ONCE per process (`remote/device.BrokerModule`)
and every connection's broker runs in its own instance of it (`BrokerModule.NewRuntime`), so a trap resets only
that connection's device plane (1011). The server's aggregate retained-bytes budget spans those instances in
Go (`aggregateBudget` in `remote/device_plane.go`: each instance's pool usage is reconciled after every broker
call; the request that pushes the total over is cancelled and settles `throttled`). This deliberately differs
from Kotlin, which shares one Rust `DeviceRetainedBytesPool` across connections: a Rust pool lives in one
instance's linear memory, so sharing it would mean one instance for every connection and give up trap
isolation. Each instance still gets a Rust pool capped at the aggregate limit (the broker's own budget check
runs there); Go only sums the pools' usage, attributes an overrun to the request that grew (the id of the
input it just fed) and cancels it. The default limit (`AggregateRetainedBytes: 0`) is read from the engine's
constants (`defaultProcessRetainedBytes`, Rust's `DEFAULT_PROCESS_RETAINED_BYTES`), not restated in Go.
`Device.Save`'s file.save announcement is built by Rust (`Plane.FileSaveParams` →
`hypen_device_file_save_params`), as Kotlin's `deviceFileSaveParamsJson`. Unary requests are opened
with `holdResult`: a result's retained bytes stay charged until the handler scope ends (`Device.Scoped`,
`runScoped`), then `release_result`. The device plane is ON by default (no enable call):
`RemoteServer.ConfigureDevice(DeviceConfig{...})` sets options, `DisableDevice()` is the one opt-out, and a
setting incompatible with it (allow-multiple session config) turns it off with one startup warning —
never a startup error. `remote/device_plane.go` is the native half (pump, timer from `tick()`, sinks,
transport buffered bytes); handlers use `ctx.Device()` (package `device`). Sessions with a negotiated
plane run dispatches on a FIFO queue off the socket reader (installed when the plane attaches; UI-only
sessions keep dispatching on the reader) — a handler blocked on the device yields the slot (never call
`DispatchExternal` on the same session from a handler). Agent dispatches are replayed provenance
(device refused). Admission (`AllowedOrigins` / `Authenticate`, RFC 001 §5) is the app's connection
policy, not a device switch: enforced only when configured (else admit + one startup warning), on every
upgrade path — `RemoteServer.Upgrader()` runs `Admit` as its `CheckOrigin` (403), and bring-your-own
endpoints pass the request to `CreateSession(…, WithUpgradeRequest(r))` — with admission configured, a
session whose upgrade was not admitted never gets a device plane. The hello grace stays for legacy
clients (a grace session has no device plane); every ack carries a `resumeToken`, required only to resume
a session that negotiated a device plane (`SessionManager.MarkDeviceSession` / `RequiresResumeToken`).
Pinned to wazero v1.12.0 (v1.8.2's compiler traps in `hypen_device_broker_open` for `file.save` ≥ 2 KiB;
`TestDeviceBrokerABI_FileSaveAcrossSizes` and the e2e sized saves pin it).

Cross-language e2e (TS web client → this server, real WebSocket; needs `bun` + `hypen-web/node_modules`,
skipped without them unless `HYPEN_E2E_REQUIRE=1`). CI (the Go jobs in `.github/workflows/cross-platform.yml`
and `integration.yml`) installs bun + `hypen-web` deps and sets `HYPEN_E2E_REQUIRE=1`, so it never skips there:

```bash
go test ./remote -run TestDeviceE2ETypeScriptClient -count=1 -v
```

## Key Dependencies

- Go 1.25+ (wazero v1.12.0 requires it)
- `gorilla/websocket` — WebSocket implementation
- `tetratelabs/wazero` — WASM runtime (pure Go, no CGo)

## Testing

Tests use Go's standard testing package. The compatibility test runner in `../engine-compatibility-tests/runners/golang/` runs shared fixtures to ensure cross-SDK consistency.

## Rust device broker over WASI (RFC 001)

`hypen_engine.wasm` (embedded via `embed.go`) exports the Rust device broker as a
handle-based C ABI, `hypen_device_*` (source: `hypen-engine-rs/src/wasm/wasi_device.rs`;
JSON shapes: `hypen-engine-rs/src/wasm/device_binding.rs`, shared with TS/Kotlin/Swift):

- `hypen_device_broker_create(cfg_ptr, cfg_len, pool_handle, now_ms) -> u32` (0 = error),
  `hypen_device_broker_destroy(h)`; pools: `hypen_device_pool_create(limit) -> u32`.
- Feed: `..._on_text(h, ptr, len, now)`, `..._on_frame(h, ptr, len, now)`,
  `..._tick(h, now) -> i64` (next deadline, -1 none), `..._set_transport_buffered(h, n)`,
  `..._owner_activated/_deactivated/_destroyed`, `..._open(h, spec, len, dl, dl_len, has_dl, now)`,
  `..._start`, `..._cancel`, `..._consumed_events`, `..._consumed_data`, `..._close(h, code)`.
- Results (open/start/poll/info/handshake helpers) go to the device result buffer:
  `hypen_device_result_len()` then `hypen_device_result(out, len)`. Errors: status <= -2
  (-2 handle, -3 pointer/UTF-8, -4 JSON), text via `hypen_device_last_error_len/_last_error`.
- `..._poll(h)` result framing: `[u32 LE header_len][JSON array of outputs][payload]`;
  `sendFrame`/`data` objects and each settled `outcome.blobs[i]` carry `offset`/`len` into
  the payload section (text never shares it, so decoding is unambiguous).
- Handshake: `hypen_device_negotiate(hello, len, binary_route)` → ack JSON or `null`,
  `hypen_device_select_ack`, `hypen_device_validate_hello`, `hypen_device_validate_ack`.
- `hypen_device_broker_revision(h, cap, len, version)` → the effective revision JSON (registry
  revision or its override, `maxItemBytes` capped) or `null`; `hypen_device_server_consumes(rev,
  len)` → 1/0 (-4 when `mode`/`data` is missing or unknown).
- `device_broker_abi_test.go` (package `core_test`) drives this ABI in the shipped
  `hypen_engine.wasm` through wazero: handshake helpers, upload with SHA-256 verification,
  file.save download, refusals/host errors, shared pools and sweeps, leases, background owners,
  revision/server_consumes. It runs under plain `go test ./...`.

Rebuild the embedded module after engine changes:

```bash
cd ../hypen-engine-rs
rustup target add wasm32-wasip1
cargo build --target wasm32-wasip1 --release --features wasi
cp ../target/wasm32-wasip1/release/hypen_engine.wasm ../hypen-golang/hypen_engine.wasm
# (./build-wasm.sh does this plus the JS and UniFFI artifacts)
```
