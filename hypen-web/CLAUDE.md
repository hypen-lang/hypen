# CLAUDE.md

This file provides guidance to Claude Code when working with the hypen-web SDK.

## Project Overview

hypen-web is a Bun workspace containing the TypeScript SDK for Hypen. It wraps the Rust/WASM engine and provides platform-agnostic runtime APIs plus browser-specific renderers (DOM and Canvas).

## Workspace Structure

```
hypen-web/
├── packages/
│   ├── core/                    # @hypen-space/core - Platform-agnostic runtime (NO WASM)
│   │   └── src/
│   │       ├── app.ts           # HypenAppBuilder - fluent API for modules
│   │       ├── state.ts         # Proxy-based observable state
│   │       ├── router.ts        # HypenRouter (hash/pathname routing)
│   │       ├── managed-router.ts # ManagedRouter (route-based module lifecycle)
│   │       ├── context.ts       # Global context for cross-module comms
│   │       ├── resolver.ts      # Component path resolution
│   │       ├── datasource.ts    # Data source plugin system
│   │       ├── events.ts        # Typed event emitter
│   │       ├── result.ts        # Result type (Ok/Err pattern)
│   │       ├── retry.ts         # Retry with exponential backoff
│   │       ├── disposable.ts    # Resource cleanup pattern
│   │       ├── logger.ts        # Structured logging
│   │       ├── renderer.ts      # BaseRenderer abstract class
│   │       ├── types.ts         # Shared types (Patch, Action, etc.)
│   │       ├── remote/          # Remote UI protocol (client only)
│   │       │   ├── client.ts    # RemoteEngine client
│   │       │   └── session.ts   # Session management
│   │       └── components/
│   │           └── builtin.ts   # Built-in Router/Route/Link
│   │
│   ├── web/                     # @hypen-space/web - Browser renderers (pure patch consumers)
│   │   └── src/
│   │       ├── dom/             # DOM renderer
│   │       │   ├── renderer.ts  # DOMRenderer - applies patches to DOM
│   │       │   ├── components/  # 33 component handlers
│   │       │   ├── applicators/ # 15 style applicators
│   │       │   ├── events.ts    # Event attachment/delegation
│   │       │   └── debug.ts     # Debug heatmap visualization
│   │       └── canvas/          # Canvas 2D renderer
│   │           ├── renderer.ts  # CanvasRenderer
│   │           ├── layout.ts    # Flexbox layout engine
│   │           ├── paint.ts     # Canvas 2D drawing
│   │           ├── text.ts      # Text measurement/rendering
│   │           └── events.ts    # Hit testing
│   │
│   ├── web-engine/              # @hypen-space/web-engine - Browser SPA engine
│   │   └── src/
│   │       ├── engine.ts        # Browser WASM wrapper (CDN/self-hosted)
│   │       ├── hypen.ts         # Hypen orchestrator class
│   │       └── index.ts         # Barrel exports
│   │
│   └── server/                  # @hypen-space/server - Node.js server engine
│       └── src/
│           ├── engine.ts        # Node.js WASM wrapper
│           ├── loader.ts        # Dynamic component loader
│           ├── discovery.ts     # Component file discovery
│           ├── plugin.ts        # Bun plugin for .hypen imports
│           ├── remote/
│           │   └── server.ts    # RemoteServer (WebSocket streaming)
│           └── index.ts         # Barrel exports
│
├── tests/                       # Bun test suite (30+ files)
├── playground/                  # Interactive dev playground
├── examples/                    # Runnable examples
└── docs/                        # SDK documentation
```

## Package Dependencies

```
core (no WASM, platform-agnostic)
  ↑              ↑
  │              │
web (renderers)  server (Node.js WASM + loader + discovery + remote server)
  ↑              │
  │              │
web-engine (Browser WASM + Hypen orchestrator)
  depends on: core + web
```

## Development Commands

```bash
# Testing
bun test                          # Run all tests
bun test tests/app.test.ts        # Single test file

# Building
bun run build                     # Build all packages (ordered: core → web → server → web-engine)
bun run build:core                # Build @hypen-space/core only
bun run build:web                 # Build @hypen-space/web only
bun run build:server              # Build @hypen-space/server only
bun run build:web-engine          # Build @hypen-space/web-engine only
bun run build:wasm                # Rebuild WASM from Rust + setup
bun run typecheck                 # TypeScript type checking

# Development
bun run playground                # Interactive playground (port 3000)
bun run replayground              # Rebuild WASM + restart playground

# Examples
bun run example                   # DOM counter
bun run example:canvas            # Canvas counter
bun run example:remote-server     # Remote server
```

## Architecture

### Data Flow

```
Hypen DSL (string)
  → Engine.renderSource() (Rust/WASM parser)
  → AST → IR + Reactive System
  → Patches (minimal deltas)
  → Renderer.applyPatches()
  → DOM or Canvas output
```

### Key Patterns

- **Observable State**: Proxy-based mutation tracking. Direct assignment (`state.count++`) auto-propagates — no `setState()` needed. The traps record *dirty roots* (which paths were written) and the microtask flush diffs only those subtrees against the snapshot — O(edit), not O(state) — using the TS port of the engine's canonical diff (`@hypen-space/core/diff`, pinned to `diff.rs` by the cross-SDK fixtures and a differential fuzz suite). Set `HYPEN_DIFF_ORACLE=1` (or `globalThis.__HYPEN_DIFF_ORACLE__ = true`) to cross-check every flush against the full diff and the WASM implementation at runtime.
- **Sparse Updates**: Only changed state paths sent to engine via `updateStateSparse(scope, paths, values)`. Empty `scope` targets the primary module slot; non-empty `scope` targets a named nested module.
- **Patch-Based Rendering**: Engine emits Create/SetProp/RemoveProp/SetText/Insert/Move/Remove patches, plus Detach/Attach for Router subtree caching (off-screen routes stay alive under the same NodeId; re-entry emits `Attach` instead of `Create`, preserving DOM scroll/focus/form state for free). All renderers (DOM, Canvas, iOS, Android) consume the same format.
- **Route-Level Persistence**: `ManagedRouter` keeps module instances alive across navigation by default (opt out via `persist: false` on the module definition), and the engine's Router IR node caches detached route subtrees under the same `NodeId`s (LRU, default cap 10). Navigating back to a visited route fires `onActivated` (not `onCreated`) at the SDK layer and emits `Attach` patches (not `Create`) at the engine layer — no loading flash, no DOM rebuild. Both caches are bounded: `ManagedRouter` evicts the least-recently-persisted module past `maxPersistedModules` (default 10, matches the engine's `DEFAULT_ROUTER_CACHE_SIZE`) via the same `destroy() + unregisterModule()` path `persist: false` uses, so a long session over many routes cannot leak module instances indefinitely.
- **Module Scoping**: Each Engine instance binds to one active module. Cross-module comms use prop passing, actions, or GlobalContext.
- **Component Discovery**: Auto-scans directories for `.hypen` + `.ts` file pairs (server package only). Supports folder/sibling/index naming patterns.

### WASM Integration

WASM is built in `../hypen-engine-rs/` and copied to `packages/server/wasm-node/` and `packages/web-engine/wasm-browser/` during build. The build scripts handle this automatically.

### Package Separation

- **core**: Pure TypeScript, no WASM. Contains types, app builder, state proxy, router, context, events, result types, logger. Used by all other packages.
- **web**: Pure renderer package. Consumes patches and applies them to DOM or Canvas. No knowledge of where patches come from.
- **server**: Node.js WASM engine wrapper + server-side utilities (component discovery, loader, Bun plugin, RemoteServer for WebSocket streaming).
- **web-engine**: Browser WASM engine wrapper + Hypen orchestrator class that ties engine + renderer together for browser SPAs.

## Testing

Uses Bun's native test runner. Key test categories:
- Engine: `engine.test.ts` (server), `engine.browser.test.ts` (web-engine)
- Modules: `app.test.ts`, `action-handler.test.ts`
- State: `state.test.ts`, `variant-handling.test.ts`
- Router: `router.history.test.ts`, `router.lazy.test.ts`
- Canvas: `canvas-renderer.test.ts`, `canvas-integration.test.ts`
- Remote: `remote-server.test.ts`, `session.test.ts`

Common patterns: `FakeEngine` mock for unit tests, `flushMicrotasks()` for async sequencing, JSDOM for DOM renderer tests.

## Tooling

- **Bun** for everything — runtime, test runner, bundler, package manager
- Use `bun` instead of `node`/`npm`/`pnpm`
- Use `bun:test` instead of `jest`/`vitest`
- Bun auto-loads `.env` files

## Rust device broker (WASM) — RFC 001

The server-side device broker is the Rust `DeviceBroker` (hypen-engine-rs `src/device/`), shared by
every server SDK. TypeScript has NO broker of its own any more (the former `broker.ts` /
`scheduler.ts` were removed):

- `@hypen-space/core` stays WASM-free. `remote/device/port.ts` describes the broker as a port
  (`DeviceBrokerPort`, `DeviceBrokerFactory`, config/open/output shapes); `remote/device/plane.ts`
  (`DevicePlane`) is the host driver every TS server shares: socket text/frames in, `poll()`
  outputs out (texts, download frames, JSON events, streamed upload bytes, settlements, close),
  one timer re-armed from the broker's next deadline (`DeviceClock` seam), transport buffered
  bytes reported before each poll, due bulk turns deferred so UI traffic goes first, consumer
  pacing via `consumedEvents` / `consumedData`. `DeviceContext` (context.ts) is the typed,
  Result-style handler API on top of the plane; `RemoteSession` keeps admission, `resumeToken`
  and module ownership (`ownerActivated/Deactivated/Destroyed`) native. The device plane is ON
  by default on every TS server (no `enableDevice`; `RemoteServer.disableDevice()` /
  `SessionHost.deviceDisabled` / CF `device: false` opt out; `configureDevice(options)` tunes
  budgets). Nothing device-related ever refuses to start a server: `allow-multiple` turns the
  plane off with ONE warning; no `allowedOrigins`/`authenticate` admits everyone with ONE
  warning. `syncActions` keeps the plane on (a replayed dispatch — `runReplayed`, replay
  provenance — gets a `context.device` that refuses `unavailable`/`syncActions.replay`; the
  agent handle's sibling mirror replays the same way). Compression is on by default and
  per message: `RemoteServer` passes `perMessageDeflate: { compress: "shared", decompress:
  "shared" }` (Bun answers `server_no_context_takeover; client_no_context_takeover`), and a
  connection keeps its device plane only when its negotiated extension has BOTH params
  (`remote/ws-extensions.ts` `deflateContextPolicy`, used by `RemoteEngine.attachDevice` and
  the CF DO per socket; CF `webSocketCompression: true` only makes an unobservable
  negotiation fail closed for clients that offered DEFLATE). Legacy clients keep the 1 s
  hello grace (grace-initialised ⇒ no device plane). Every
  ack carries a `resumeToken`; it is REQUIRED only to resume a session that negotiated a device
  plane (`SessionManager.markDeviceSession`), UI-only sessions keep id-only resume. Handshake negotiation
  (hello validation + selection) is the Rust `deviceHandshake`, reached through the port as
  `DeviceBrokerFactory.negotiate(helloText, binaryRoute, serverCapabilities?)` — TS has no
  selection code. On a live device connection `RemoteSession.receive` routes text by its RAW
  top-level `type` (`isDeviceTypedText`, before `JSON.parse`): every device type — a client
  `deviceRequest` included — goes to the broker, so D8 reactions happen and JSON-limit breakers
  (even text `JSON.parse` rejects) count against the connection's violation budget
  (`tests/device-srv-socket-routing.test.ts`, real socket).
- `@hypen-space/server` supplies the WASM-backed factory (`createWasmDeviceBrokerFactory`,
  `src/device-broker.ts`, one process-wide `WasmRetainedBytesPool`); `RemoteServer` wires it as
  `SessionHost.deviceBrokerFactory`. A host without a factory never admits the device plane.
- `@hypen-space/cf` supplies `createCFDeviceBrokerFactory(wasm, poolBytes)`;
  `HypenDurableObjectConfig.deviceWasm` (the web-target exports; `defineHypenWorker` sets it from
  `wasm` automatically — the `pkg/web` glue carries the broker) is needed for the device plane;
  without it the DO stays UI-only with one warning. The DO reset marker (the attachment's
  `deviceEnabled: true`, 1012 on wake) stays native.
- Tests build the broker through the port: `tests/device-srv-harness.ts` `makePlane()` (a plane
  over wasm-node's `WasmDeviceBroker` with a `FakeClock`), `loopback()` (plane ↔ `DeviceClient`),
  and `makeHost()` (a `SessionHost` with the WASM factory).
- End to end: `tests/device-remote-server-e2e.test.ts` drives a listening `RemoteServer` with
  `RemoteEngine` + `FakeDeviceHost` over a real WebSocket (admission, handshake, uploads,
  `file.save`, streams, cancel, lease renewals, `resumeToken` resume);
  `tests/device-cf-define-worker.test.ts` runs `defineHypenWorker({ wasm })` (device on by default) on the
  web-target glue (`tests/fixtures/wasm-web-glue`) Cloudflare uses.
- `RemoteSession` builds the broker BEFORE the `sessionAck`: a factory/config failure acks without
  `device` (UI-only continues); a broker that cannot open `core.capabilities` resets with 1012
  (`tests/device-srv-broker-failure.test.ts`).

The wasm-bindgen build exposes `WasmDeviceBroker` (+ `WasmRetainedBytesPool`,
`deviceHandshake`, `deviceNegotiate`, `deviceSelectAck`, `deviceValidateHello`, `deviceValidateAck`,
`deviceServerAdvertisement`, `deviceConstants`, `deviceIsOversizeText`,
`deviceFileSaveParams`, `deviceSha256Hex`, `deviceServerConsumes`). It ships in the SERVER
builds only (`--features js,device-broker`): `packages/server/wasm-node/` (Node/Bun) and
`hypen-engine-rs/pkg/web` (web target, which Cloudflare apps import as `hypen-engine`). The
browser bundle `packages/web-engine/wasm-browser/` is built with `--features js` alone and has
NO device broker exports (browsers never broker device requests; it saves ~0.5 MB raw).

- Construct: `new WasmDeviceBroker({ ack, ...limits }, nowMs)` or
  `WasmDeviceBroker.withPool(config, pool, nowMs)`; config/spec accept an object or JSON string.
- Drive: `start(now)`, `ownerActivated/Deactivated/Destroyed`, `open(spec, now, download?)`
  (`{id}` or `{error:{code,detail?}}`; host errors throw), `onText(text, now)`,
  `onFrame(uint8, now)`, `tick(now)` → next deadline, `setTransportBuffered(n)`, `poll()` →
  `[{type:"sendText"|"sendFrame"|"event"|"data"|"settled"|"closeConnection", ...}]`
  (`frame`/`bytes`/`outcome.blobs[i].bytes` are `Uint8Array`s), `consumedEvents/consumedData`,
  `cancel`, `releaseResult`, `close(code)`, `info()`, `revision(capability, version)` (the
  effective revision object or `null`; feed it to `deviceServerConsumes`).
- Shapes are defined once in `hypen-engine-rs/src/wasm/device_binding.rs` (shared with Go/Kotlin/Swift).

Rebuild and re-copy the WASM after any engine change:

```bash
cd ../hypen-engine-rs && ./build-wasm.sh    # needs wasm-pack + wasm-bindgen-cli 0.2.111 on PATH,
                                           # rustup targets wasm32-unknown-unknown + wasm32-wasip1
cd ../hypen-web && bun test tests/device-wasm-broker-binding.test.ts   # binding smoke (wasm-node) + no broker in wasm-browser
```
