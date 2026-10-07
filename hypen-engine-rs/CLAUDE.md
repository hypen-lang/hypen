# CLAUDE.md

This file provides guidance to Claude Code when working with the Hypen engine crate.

## Project Overview

`hypen-engine` is the core reactive rendering engine for Hypen. It takes parsed AST, expands it into IR, tracks reactive dependencies, reconciles changes via keyed diffing, and emits minimal patches for platform renderers to apply.

## Module Structure

```
hypen-engine-rs/src/
├── lib.rs                    # Public API exports
├── engine.rs                 # Engine struct — main orchestrator
├── error.rs                  # EngineError type
├── state.rs                  # StateChange notifications
├── render.rs                 # Dirty node rendering logic
├── logger.rs                 # Debug logging
│
├── ir/                       # Intermediate Representation
│   ├── node.rs               # Element, Value, Props, NodeId
│   ├── component.rs          # ComponentRegistry, resolution
│   ├── anim.rs               # .transition/.enter/.exit/.layout → "__anim.*" prop lowering
│   ├── dnd.rs                # .draggable/.dropZone/.sortable/.pinboard → "__dnd.*" prop lowering
│   └── expand.rs             # AST → IR lowering
│
├── reactive/                 # Dependency Tracking
│   ├── binding.rs            # @{state.x} syntax parsing
│   ├── expression.rs         # Expression evaluation (exprimo)
│   ├── graph.rs              # Dependency graph
│   └── scheduler.rs          # Dirty marking and scheduling
│
├── reconcile/                # Virtual DOM Diffing
│   ├── tree.rs               # Virtual instance tree; ControlFlowKind::Router carries the per-route subtree cache
│   ├── diff.rs               # Keyed children diffing; Router reconcile emits Detach/Attach on nav
│   ├── patch.rs              # Patch enum (Create, SetProp, RemoveProp, SetText, Insert, Move, Remove — optional transition flag roots an animated exit, Detach, Attach)
│   ├── resolve.rs            # Value resolution during reconciliation
│   ├── conditionals.rs       # When/If matching; Router matching via portable::route::match_path
│   ├── keyed.rs              # Keyed list reconciliation
│   └── item_bindings.rs      # ForEach iteration context
│
├── dispatch/                 # Events & Actions
│   ├── action.rs             # Action dispatcher for @actions.xxx
│   └── event.rs              # Event routing
│
├── lifecycle/                # Lifecycle Management
│   ├── module.rs             # Module lifecycle (created/destroyed)
│   ├── component.rs          # Component lifecycle (mount/unmount)
│   └── resource.rs           # Resource cache
│
├── portable/                 # Canonical helpers shared with every SDK
│   ├── diff.rs               # State-diff algorithm (path-level)
│   ├── path.rs               # get/set/delete/has/move on JSON-ish state (move = __hypen_reorder)
│   ├── route.rs               # match_path (exact / :param / /*)
│   ├── session.rs             # Session state machine
│   └── url.rs                 # URL parse/build helpers
│
├── serialize/                # Remote UI Protocol
│   └── remote.rs             # Initial tree & incremental patch serialization
│
├── device/                   # Device Capability Protocol (RFC 001) server broker, sans-IO
│   ├── broker.rs             # DeviceBroker: ids, owners, leases, credit, uploads/downloads, violations
│   └── scheduler.rs          # Bulk transport scheduler (64 KiB turns, 256 KiB pending, 8 MiB queue)
│
├── wasm/                     # Language Bindings
│   ├── ffi.rs                # Shared FFI data types (ModuleConfig, etc.)
│   ├── shared.rs             # Binding-agnostic helpers shared by js.rs and wasi.rs
│   ├── device_binding.rs     # Device broker JSON shapes + WASI framing shared by JS/WASI/UniFFI
│   ├── js.rs                 # wasm-bindgen JS bindings (js feature)
│   ├── js_device.rs          # WasmDeviceBroker / WasmRetainedBytesPool / device* helpers (js feature)
│   ├── wasi.rs               # WASI C FFI (wasi feature)
│   └── wasi_device.rs        # hypen_device_* C ABI (wasi feature; also compiled for native tests)
│
└── uniffi/                   # Mobile Bindings
    ├── mod.rs                # UniFFI scaffolding (uniffi feature)
    └── device.rs             # DeviceBroker / DeviceRetainedBytesPool objects + device* helpers
```

## Development Commands

```bash
cargo test                                 # Run all tests
RUST_BACKTRACE=1 cargo test -- --nocapture # Tests with backtrace
cargo clippy                               # Lint
cargo bench                                # Benchmarks (criterion)
./build-wasm.sh                            # Build all WASM targets
```

## Device broker bindings (RFC 001)

One sans-IO `device::DeviceBroker` serves every server SDK through three surfaces with the
SAME JSON shapes (config, open spec, outputs, info — documented at the top of
`src/wasm/device_binding.rs`):

| Surface | Type | Consumers | Artifact |
|---|---|---|---|
| wasm-bindgen (`js,device-broker`) | `WasmDeviceBroker` (incl. `revision()`), `WasmRetainedBytesPool`, `deviceNegotiate`/`deviceSelectAck`/`deviceValidateHello`/`deviceValidateAck`/`deviceServerConsumes`/… | `@hypen-space/server`, `@hypen-space/cf` | `hypen-web/packages/server/wasm-node/`, `pkg/nodejs`, `pkg/bundler`, `pkg/web` (Cloudflare's `hypen-engine`) |
| WASI C ABI (`wasi`, implies `device-broker`) | `hypen_device_broker_*` handles, `hypen_device_pool_*`, `hypen_device_*` helpers; poll output framed `[u32 LE header_len][JSON array][payload]` with `offset`/`len` | Go SDK (wazero) | `hypen-golang/hypen_engine.wasm` |
| UniFFI (`uniffi`, implies `device-broker`) | `DeviceBroker`, `DeviceRetainedBytesPool`, `DeviceOutput`/`DeviceOutcome`/`DeviceOpenResult`, `device*` functions | Kotlin SDK, Swift server | `../target/release/libhypen_engine.so` + generated `hypen_engine.kt` / `hypen_engine.swift` / `hypen_engineFFI.h` |

Every surface holds the broker as `device_binding::OwnedBroker`: freeing the binding object
(JS `free()` or the `FinalizationRegistry`, the last UniFFI reference, `hypen_device_broker_destroy`)
closes an unclosed broker with `connectionLost`, so its retained bytes always return to the shared
pool even when the host skipped `close()`.

The `device-broker` feature gates the JS and WASI surfaces (and `device_binding.rs`). The
browser bundle (`pkg/browser` -> `hypen-web/packages/web-engine/wasm-browser/`) is built with
`js` alone and carries NO device broker: browsers never broker device requests, and leaving it
out keeps SHA-256, the broker and the device payload validators (~0.5 MB raw) out of the
download. `build-wasm.sh` fails if `WasmDeviceBroker` leaks into it.

Rebuild everything the SDKs consume (JS pkgs, WASI module, UniFFI cdylib + Kotlin/Swift bindings):

```bash
rustup target add wasm32-unknown-unknown wasm32-wasip1
# wasm-pack plus wasm-bindgen-cli matching Cargo.lock (0.2.111) on PATH. The script keeps
# each destination's tracked package.json (e.g. wasm-node's "type": "commonjs") and only
# syncs its "version".
./build-wasm.sh
```

Piecewise:

```bash
wasm-pack build --target nodejs --out-dir pkg/nodejs --features js,device-broker  # then cp pkg/nodejs/hypen_engine* ../hypen-web/packages/server/wasm-node/
wasm-pack build --target web --out-dir pkg/web --features js,device-broker        # Cloudflare (`hypen-engine` file: dep of the examples)
wasm-pack build --target web --out-dir pkg/browser --features js                  # then cp pkg/browser/hypen_engine* ../hypen-web/packages/web-engine/wasm-browser/
cargo build --target wasm32-wasip1 --release --features wasi && cp ../target/wasm32-wasip1/release/hypen_engine.wasm ../hypen-golang/
cargo build --release --features uniffi && bash ../scripts/generate-bindings.sh   # Kotlin + Swift bindings
```

Binding tests (all run in CI):
- Rust: `cargo test --lib wasm::` (shapes + the C ABI driven natively) and
  `cargo test --features uniffi --lib` (the UniFFI objects; rust.yml runs it, since plain
  `cargo test` does not compile `src/uniffi/`). rust.yml also clippy-gates the uniffi, `js`,
  `js,device-broker` and `wasi` builds, which the default clippy run never compiles.
- The shipped artifacts through each SDK's real binding code:
  `cd ../hypen-web && bun test tests/device-wasm-broker-binding.test.ts` (wasm-node broker, and
  Cloudflare's `pkg/web` glue — copied by `build-wasm.sh` into `tests/fixtures/wasm-web-glue/`
  with the SHA-256 of its wasm — loaded through `initSync`; no broker in wasm-browser), `cd ../hypen-golang && go test -run TestDeviceBrokerABI .`
  (hypen_engine.wasm via wazero), `cd ../hypen-kotlin && ./gradlew test --tests
  space.hypen.engine.DeviceBrokerBindingTest` (generated Kotlin via JNA), and
  `cd ../hypen-server-swift && swift test --filter DeviceBrokerBindingTests` (generated Swift).

## Public API

```rust
pub use engine::Engine;
pub use error::EngineError;
pub use ir::{ast_to_ir_node, Element, IRNode, Value};
pub use lifecycle::{Module, ModuleInstance};
pub use reconcile::Patch;
pub use state::StateChange;
```

## Architecture

```
Hypen DSL Source
    ↓ (hypen-parser)
AST (ComponentSpecification)
    ↓ (ir/expand.rs)
IR (Element/IRNode tree)
    ↓ (reactive/graph.rs)
Dependency Graph
    ↓ (reconcile/diff.rs)
Virtual Instance Tree → Patches
    ↓
Platform Renderer (DOM, Canvas, iOS, Android)
```

### Key Design Decisions

- **Path-Based Reactivity**: Dependencies tracked by string paths (`"user.name"`, `"items.0.title"`), not values. The host signals which paths changed.
- **Arc-Based Cloning**: Both `Props` (raw, with bindings) and `ResolvedProps` (resolved JSON values, on `Patch::Create`) are `Arc<IndexMap<...>>`. Cloning a node's props into a Create patch, or snapshotting old props before a dirty re-render, is an `Arc::clone` rather than a deep copy of the map. `InstanceNode.props` / `raw_props` are `LayeredProps` (`reconcile/layered.rs`): a shared `Arc` base plus a tiny per-node overlay, observationally identical to the flat map — list rows built from a `RowPrototype` share one base per template node and layer only their item-dependent props on top, so creating a row deep-copies no prop map.
- **First-Class Control Flow**: ForEach/When/If/Router are IR-level types with exhaustive pattern matching.
- **Keyed Reconciliation**: List diffing uses keys to produce minimal Create/Move/Remove patches.
- **Animation Channel + Deferred Remove**: The `.transition`/`.enter`/`.exit`/`.layout` applicators lower in `ir/anim.rs` to reserved `"__anim.*"` resolved props (one JSON object per channel) that are renderer-facing — never strip them as engine-internal. When a removal root's props carry `"__anim.exit"`, the reconciler emits `Patch::Remove { transition: true }` for the root FIRST, then descendants as plain Removes (parent-remove-wins); non-animated removals keep post-order. The flag is serde skip-if-false, so unaware renderers see an unchanged wire format and snap.
- **DnD Channel**: The `.draggable`/`.dropZone`/`.sortable`/`.pinboard` applicators lower in `ir/dnd.rs` to reserved `"__dnd.*"` props (contract: `hypen-web/docs/dnd.md`). Two are engine-filled: `"__dnd.key"` (the `ForEach` item key, stamped in `reconcile/item_bindings.rs`) and `"__dnd.pinGroup"` (propagated at expand time from a reserved-mode `.pinboard`; item expansion then injects `translateX.0`/`translateY.0` state bindings to `__dnd.<group>.<key>.{x,y}`). Templates carrying `"__dnd.source"` are unplannable for the `binding_map` prototype/Instantiate fast paths — only the substitution path knows the item key. A header-less `.states { … }` block is accepted on a `__dnd.*` node and lowers to a static `"__anim.states"` `{"label": null, "runtime": true}` plus `"__anim.statePoses"`.
- **Router Subtree Cache**: `ControlFlowKind::Router` holds a per-instance `cache: IndexMap<String, Vec<NodeId>>` keyed by route pattern. On navigation, children of the leaving route are unlinked with `Patch::Detach` but kept in the `InstanceTree` + `DependencyGraph` (so state updates still reconcile through them while off-screen). On return, the cache hits and the reconciler emits `Patch::Attach` instead of rebuilding the subtree — renderers reinsert the same native element under the same NodeId. Insertion-ordered LRU, default cap `DEFAULT_ROUTER_CACHE_SIZE = 10`; evicted entries are torn down via `remove_subtree`. Route-pattern keying means `/profile/42 → /profile/99` (both matching `/profile/:id`) is a no-op, not a cache swap.
- **Shared Route Matcher**: Router IR's `route_matches` delegates to `crate::portable::route::match_path`, the single source of truth that every SDK's `ManagedRouter` calls at runtime. Exact / `:param` / trailing `/*` semantics are uniform across the Router IR node and every platform router.

## Feature Flags

Crate always builds as both `cdylib` and `rlib`. Feature flags control which bindings are generated:

| Feature | Bindings | Use Case |
|---------|----------|----------|
| (none) | None (cdylib + rlib) | Rust embedding |
| `js` | wasm-bindgen | Web (bundler, Node.js, browser) |
| `wasi` | C FFI | Go, Python, native |
| `component-model` | WIT | Type-safe cross-language |
| `uniffi` | Kotlin/Swift | Android, iOS |

## Key Dependencies

- `hypen-parser` — upstream AST
- `hypen-tailwind-parse` — Tailwind CSS support
- `indexmap` — ordered property maps
- `im` — persistent/immutable data structures
- `slotmap` — slot allocation for node IDs
- `exprimo` — expression evaluation for `@{...}` bindings
