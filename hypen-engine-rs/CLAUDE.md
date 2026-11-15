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
│   ├── patch.rs              # Patch enum (Create, SetProp, RemoveProp, SetText, Insert, Move, Remove — optional transition flag roots an animated exit, ClearChildren — one patch for a list pass that removes every child of its element, Detach, Attach)
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
├── module_host/              # WASM Component module hosting (`hypen:module`, see /wit/ENGINE_INTEGRATION.md)
│   ├── mod.rs                # ModuleHost trait + value types (always compiled; Engine holds Option<Box<dyn ModuleHost>>)
│   ├── registry.rs           # ModuleRegistry / BundledRegistry
│   ├── kv.rs                 # Storage backend shared by the wasmtime hosts: per-module `local` partitions, quotas, per-call flush (module-loader)
│   ├── wasmtime_host.rs      # WasmtimeHost: v0.1 sync world; also ModuleLimits, HostCore (engine + epoch ticker + tokio runtime), TotalMemoryLimiter (module-loader, native only)
│   ├── wasmtime_host_async.rs # WasmtimeHostAsync: v0.2 CM-async world (module-loader, native only)
│   ├── dual.rs               # DualHost: sniffs a component's ABI and routes to the matching host
│   └── bridged_host.rs       # BridgedHost: delegates to a JS host (module-loader-bridged, wasm32 only)
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
│   ├── js_hosted.rs          # WasmHostedEngine: `Engine` + BridgedHost for JS (module-loader-bridged feature)
│   ├── wasi.rs               # WASI C FFI (wasi feature)
│   └── wasi_device.rs        # hypen_device_* C ABI (wasi feature; also compiled for native tests)
│
└── uniffi/                   # Mobile Bindings
    ├── mod.rs                # UniFFI scaffolding (uniffi feature)
    ├── module_host.rs        # HypenModuleHost object over DualHost (uniffi + module-loader)
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

With `wasm-opt` (binaryen) on PATH, `build-wasm.sh` strips each module's `name` section (debug-only function names, ~3 MB per module on current toolchains); without it the modules ship roughly twice as large. Put `ktlint` on PATH too, or the regenerated Kotlin bindings come out unformatted. Use binaryen 116 (`cargo install wasm-opt --locked`): 108 and 132 write modules that do not work, and the script load-checks the stripped Node build and stops if it fails.

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
- **Control-Flow Placement**: control-flow containers are transparent, so content they create, move or re-attach on a later pass is anchored, never blindly appended: `Insert`/`Instantiate`/`Attach` take `InstanceTree::render_anchor_after(node)` (first RENDERED node after it — following siblings, descending into control-flow siblings, skipping empty ones, then up through transparent ancestors to the nearest real element; a linear sibling scan per level climbed, per call, with a fast path for a just-appended last child — nothing is cached, so a pass where N mid-parent control-flow nodes of a K-child parent turn on costs O(N·K)), and keyed `Move`s at the end of a range anchor on `range_end_anchor(container)`. Rows rooted at control flow move as their rendered roots. During a keyed pass the old children stay linked in old order (the final order is installed after matching) so in-place row content anchors on its real neighbour; replacement paths (`replace_subtree_impl` / `replace_with_control_flow`) link the new node into the old slot via `InstanceTree::place_before_slot`.
- **Keyed Reconciliation**: List diffing uses keys to produce minimal Create/Move/Remove patches.
- **Animation Channel + Deferred Remove**: The `.transition`/`.enter`/`.exit`/`.layout` applicators lower in `ir/anim.rs` to reserved `"__anim.*"` resolved props (one JSON object per channel) that are renderer-facing — never strip them as engine-internal. When a removal root's props carry `"__anim.exit"`, the reconciler emits `Patch::Remove { transition: true }` for the root FIRST, then descendants as plain Removes (parent-remove-wins); non-animated removals keep post-order. The flag is serde skip-if-false, so unaware renderers see an unchanged wire format and snap.
- **Scheme-Switched Values**: a variant-form value map with color-scheme keys (`.color({default: "#111", dark: "#fff", sepia: "#5b4636"})`) lowers in `ir/expand.rs` (`is_variant_map` / `lower_scheme_variants`) to ONE `Value::SchemeSwitch { cases, default }` on the base key `<name>.0`; breakpoint/state keys of the same map still lower to their renderer-resolved `<name>@md.0` / `<name>:hover.0` props. Scheme keys are `light` / `dark`, plus — only beside a `default` — every key that is not a breakpoint/state token (a custom scheme name); without a `default` an unknown key keeps the map an ordinary object argument. The switch is engine-internal like `Value::StateSwitch`: `reconcile/resolve.rs::pick_scheme_entry` selects the entry for the theme's `appearance.scheme` data source (no theme or no matching case → `default`; no default → the prop is absent) and the entry then resolves like any prop value. Entries are leaf `Value`s (literal, binding, template string — an action/resource drops the scheme form with a warning), so every site that walks a prop's bindings also walks `Value::scheme_entries()`: dependency registration in `reconcile/diff.rs` and `binding_map.rs` (plus `ds:appearance:scheme` via `ir::node::scheme_switch_binding`), row substitution in `item_bindings.rs`, `ir/refs.rs` and `agent_core.rs`. `.tw("… dark:bg-black")` lowers to the same switch in `expand_tailwind_classes` (the `dark` case over the value it overrides as default; `dark:md:` / `dark:hover:` switch that variant's prop). The scheme tokens (`portable::variant::SCHEMES`) are deliberately NOT variant tokens and never appear in a prop key.
- **DnD Channel**: The `.draggable`/`.dropZone`/`.sortable`/`.pinboard` applicators lower in `ir/dnd.rs` to reserved `"__dnd.*"` props (contract: `hypen-web/docs/dnd.md`). Two are engine-filled: `"__dnd.key"` (the `ForEach` item key, stamped in `reconcile/item_bindings.rs`) and `"__dnd.pinGroup"` (propagated at expand time from a reserved-mode `.pinboard`; item expansion then injects `translateX.0`/`translateY.0` state bindings to `__dnd.<group>.<key>.{x,y}`). Templates carrying `"__dnd.source"` are unplannable for the `binding_map` prototype/Instantiate fast paths — only the substitution path knows the item key. A header-less `.states { … }` block is accepted on a `__dnd.*` node and lowers to a static `"__anim.states"` `{"label": null, "runtime": true}` plus `"__anim.statePoses"`.
- **List Virtualization** (contract: `hypen-web/docs/virtualization.md`): `List`/`Grid` (lazy unless `lazy: false`) and `ForEach(…, lazy: true)` carry `IRNode::ForEach.lazy: Option<LazyList>` (`initialCount`, optional `estimatedItemSize`); `lazy:` must be a literal boolean (a binding lowers to `__Error`). There is no engine switch: every renderer must handle `__virt.window`. A lazy ForEach windows only as the sole child of a real element — at creation the parent signals that through `InstanceTree::sole_child_slot` (consumed by the very next `create_ir_node_tree_full`); on every later pass `sync_window` re-checks it against the tree and installs/drops the `ListWindow` (on `ControlFlowKind::ForEach`), so hot reloads of `lazy:`/`estimatedItemSize:` or a gained/lost sibling apply in the same pass. The ForEach's stored `ir_node_template` is refreshed on each reconcile, since dirty passes and viewport reports re-run the list from it. The window is anchored on the KEYS of its first two items: when both moved together (inserts/removes above) `start` follows them; when only the anchor moved (a reorder) it stays with the neighbour. Rows that merely leave the window get a plain `Remove` (`keyed::Eviction`), never an exit transition or tombstone; only deleted items animate out. `__virt.window` = `{total, start, end, estimatedSize?}` is a SetProp on the render parent, never stored in its props (so its own dirty re-render can't diff it away); removing a windowed list withdraws it. The engine never knows item sizes: renderers report the visible range plus overscan with `set_list_viewport(list_id, start, end)` (`Engine`/`EngineCore::set_list_viewport[_wire]`, JS `setListViewport`, WASI `hypen_set_list_viewport`, UniFFI `set_list_viewport`; remote clients send a `viewport` message). The narrow dirty path maps item indices through the window and ignores edits outside it. A nested loop over the outer item (`@item.children`, `@g.children`) gets the array as the reserved `__items` container prop at row substitution (`item_bindings.rs`), since its source can't resolve against state.
- **Router Subtree Cache**: `ControlFlowKind::Router` holds a per-instance `cache: IndexMap<String, Vec<NodeId>>` keyed by route pattern. On navigation, children of the leaving route are unlinked with `Patch::Detach` but kept in the `InstanceTree` + `DependencyGraph` (so state updates still reconcile through them while off-screen). On return, the cache hits and the reconciler emits `Patch::Attach` instead of rebuilding the subtree — renderers reinsert the same native element under the same NodeId. Insertion-ordered LRU, default cap `DEFAULT_ROUTER_CACHE_SIZE = 10`; evicted entries are torn down via `remove_subtree`, and removing the Router itself tears down its whole cache (`InstanceTree::remove_subtree_with` walks it). Route-pattern keying means `/profile/42 → /profile/99` (both matching `/profile/:id`) is a no-op, not a cache swap. A route root that is itself control flow (ForEach/If/When/nested Router) never reached the renderer, so Detach/Attach address its rendered roots (`InstanceTree::for_each_rendered_root`, Attach anchored via `render_anchor_after`); control flow that goes dirty while it sits in such a detached root (`InstanceTree::in_detached_range`) is deferred to `deferred_detached` and re-run from its template when the route is attached again, instead of inserting content at "root"; `remove_subtree_with` drops torn-down ids from that set (route evicted, Router removed, parent branch switched away). "root" is an ordinary container: root-level control flow anchors its `Insert`s (`Patch::insert_root(id, before)`) and keyed `Move`s (`Patch::move_root`) like any other range, and a root-level ForEach creates rows on later passes with plain Create + Insert (no element to `Instantiate` under).
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
| `module-loader` | none (adds `WasmtimeHost`/`WasmtimeHostAsync`/`DualHost`) | Hosting `hypen:module` WASM Components natively (wasmtime 46; native targets only). The library surface UniFFI/mobile/desktop embeds link |
| `runtime-bin` | none (implies `module-loader`; adds the `hypen-runtime` bin and its `tiny_http` / file-watcher deps) | The dev runtime binary (`--serve`, hot reload) |
| `module-loader-bridged` | wasm-bindgen `WasmHostedEngine` (implies `js`) | Engine in wasm32 delegating module hosting to a JS host |

`module-loader` links wasmtime into every test binary (~0.5 GB each with debuginfo), so run the
feature's tests targeted rather than as the whole suite:

```bash
cargo test --features module-loader --lib --test test_module_host --test test_module_host_async
cargo test --features runtime-bin --test test_hypen_runtime   # builds + drives the hypen-runtime binary
cargo test --features uniffi,module-loader --test test_uniffi_host
cargo test --test test_module_host_routing   # engine-side routing with a mock host, default features
cargo test --test test_module_host_cascade   # reducer-output fold (ACLs, cascade queue, state, teardown), mock host
```

Module-host sandbox (both wasmtime hosts; details in the `wasmtime_host.rs` / `kv.rs` module docs):
every guest entry is an async wasmtime call on the host's own current-thread tokio runtime, bounded
by `ModuleLimits::max_call` twice over — epoch interruption for guest CPU, `tokio::time::timeout`
for time parked in host calls (wasi:io poll, wasi:http, `hypen:time.sleep-ms`). A trapped or
timed-out instance is dead (`HostError::DeadInstance` afterwards). `max_memory_bytes` is a total
over all of an instance's memories and tables. `local` storage is partitioned by registered module
name, `app`/`cloud` are shared by grant; writes are quota-checked. Manifests are deny-by-default
(`ModuleManifest::all` is the explicit grant-everything constructor).

`Engine::dispatch_action` is the renderer-facing entry: its input is client-controlled, and with or
without a module instance wired it is resolved by `route_ui_action` first (a `__hypen_dispatch`
envelope by node ownership, a registered `__hypen_scoped:<scope>:<name>`, or a bare name exactly
one scope handles). A resolved scoped name owned by a hosted instance drives that module, anything
else the closure dispatcher. There is no `scope:action` qualifier and no sender-node shortcut;
trusted embedder code (REPL, timers, tests) uses `Engine::dispatch_module_action(scope, name, payload)`.

Folding a reducer output (`dispatch`, `on_activated`, `on_deactivated`) never routes by string:
`emit` stays in the emitting scope, cross-dispatch and `subscribe` are re-checked against the
`ModuleGrants` given at `register_module_instance`, and follow-ups drain from a FIFO queue bounded
by `MAX_CASCADE_DEPTH` and `Engine::module_dispatch_budget` (a failed follow-up is collected and
reported after the queue is empty). The scope's state is replaced wholesale with what the reducer
returned; the old/new comparison only yields the changed paths to invalidate.

## Key Dependencies

- `hypen-parser` — upstream AST
- `hypen-tailwind-parse` — Tailwind CSS support
- `indexmap` — ordered property maps
- `im` — persistent/immutable data structures
- `slotmap` — slot allocation for node IDs
- `exprimo` — expression evaluation for `@{...}` bindings
