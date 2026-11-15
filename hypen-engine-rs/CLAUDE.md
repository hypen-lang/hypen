# CLAUDE.md

This file provides guidance to Claude Code when working with the Hypen engine crate.

## Project Overview

`hypen-engine` is the core reactive rendering engine for Hypen. It takes parsed AST, expands it into IR, tracks reactive dependencies, reconciles changes via keyed diffing, and emits minimal patches for platform renderers to apply.

## Module Structure

```
hypen-engine-rs/src/
├── lib.rs                    # Public API exports
├── engine.rs                 # Engine struct — main orchestrator (EngineCore + HostedModules; module-instance methods delegate to hosted/)
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
├── hosted/                   # Engine-side half of module hosting: everything `Engine` keeps for hosted (WASM-backed) scopes
│   ├── mod.rs                # HostedModules (owned by Engine and by the JS WasmEngine) + EngineCtx (the engine parts it works on: core, ClosureActions, PatchOutlet); contract docs; register/rewire/destroy, UI + trusted dispatch, host-write notification
│   ├── names.rs              # ScopeName (lowercased, validated once), ActionSet (Named | Wildcard, `accepts`)
│   ├── registry.rs           # Instance table, ModuleGrants (public) -> Grants (normalized), wire/unwire of the core's routing records
│   ├── cascade.rs            # Work queue (hosted reducers + in-process handlers reached by cross-dispatch), depth cap + budget, drain loop, the host call (`invoke`)
│   ├── fold.rs               # Applying one ReducerOutput: state -> subscriptions -> effects -> follow-ups
│   ├── subscriptions.rs      # Cross-module subscriptions, who a change notifies
│   ├── snapshots.rs          # Encoded-state cache lent to host calls (Weak-identity invalidation)
│   ├── paths.rs              # Changed-path collection (replace / merge / sparse) + paths_overlap
│   ├── report.rs             # CascadeReport / CascadeFailure / FailureCause / Origin, their rendering and `to_json` (the shape bindings hand out)
│   └── tests.rs              # Subsystem tests: HostedModules + bare EngineCore + scripted host, no Engine
│
├── module_host/              # WASM Component module hosting (`hypen:module`, see /wit/ENGINE_INTEGRATION.md)
│   ├── mod.rs                # ModuleHost trait + value types (always compiled; `hosted::HostedModules` holds Option<Box<dyn ModuleHost>>) + re-exports
│   ├── registry.rs           # ModuleRegistry / BundledRegistry
│   ├── kv.rs                 # Storage backend of the wasmtime hosts: ModuleName, per-module `local` partitions, typed entry keys, quotas, per-call flush (module-loader)
│   ├── wasmtime/             # The native hosts (module-loader, native only): one implementation, generic over the module ABI
│   │   ├── mod.rs            # Sandbox model (module docs); WasmtimeHost = Host<V01>, WasmtimeHostAsync = Host<V02>
│   │   ├── host.rs           # Host<A: Abi> + its ModuleHost impl; the Abi trait (what a bindgen! world must supply); HostConfig, ComponentCompiler
│   │   ├── core.rs           # HostCore (engine + epoch ticker + tokio runtime + compiled-component table), Deadline, ExecStrategy, CompileStats
│   │   ├── cache_dir.rs      # The opt-in on-disk compilation cache directory: keying, trust statement, the checks (`prepare`)
│   │   ├── limits.rs         # ModuleLimits, TotalMemoryLimiter, host-side bounds (handles, request sizes)
│   │   ├── store.rs          # HostState: per-instance store data shared by both ABIs, WASI ctx, HostClock
│   │   ├── linker.rs         # Capability, import inspection, manifest-gated linker construction
│   │   ├── storage.rs        # `hypen:storage` bucket operations over KvBackend
│   │   ├── cross_module.rs   # `hypen:engine/state`: ACL-checked read/dispatch/subscribe, request bounds
│   │   ├── instances.rs      # Instance table, InstanceSlot::{Live, Dead { reason }}, id tagging
│   │   ├── error.rs          # Every failure → HostError mapping (module + export + cause)
│   │   ├── wit_glue.rs       # Generated-type ⇄ neutral-type conversions (one macro, invoked per ABI)
│   │   ├── v01.rs            # hypen:module@0.1.0: bindgen! + forwarding impls + Abi adapter
│   │   └── v02.rs            # hypen:module@0.2.0 (CM-async): same, plus hypen:time
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
│   ├── js_modules.rs         # Hosted modules on WasmEngine: setModuleHost / registerHostedModule / dispatchModuleAction / … (module-loader-bridged feature)
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
| wasm-bindgen (`js,device-broker`; shipped as `js,device-broker,module-loader-bridged`) | `WasmDeviceBroker` (incl. `revision()`), `WasmRetainedBytesPool`, `deviceNegotiate`/`deviceSelectAck`/`deviceValidateHello`/`deviceValidateAck`/`deviceServerConsumes`/… | `@hypen-space/server`, `@hypen-space/cf` | `hypen-web/packages/server/wasm-node/`, `pkg/nodejs`, `pkg/bundler`, `pkg/web` (Cloudflare's `hypen-engine`) |
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
wasm-pack build --target nodejs --out-dir pkg/nodejs --features js,device-broker,module-loader-bridged  # then cp pkg/nodejs/hypen_engine* ../hypen-web/packages/server/wasm-node/
wasm-pack build --target web --out-dir pkg/web --features js,device-broker,module-loader-bridged        # Cloudflare (`hypen-engine` file: dep of the examples)
wasm-pack build --target web --out-dir pkg/browser --features js                  # then cp pkg/browser/hypen_engine* ../hypen-web/packages/web-engine/wasm-browser/
cargo build --target wasm32-wasip1 --release --features wasi && cp ../target/wasm32-wasip1/release/hypen_engine.wasm ../hypen-golang/
cargo build --release --features uniffi && bash ../scripts/generate-bindings.sh   # Kotlin + Swift bindings
```

Binding tests (all run in CI):
- Rust: `cargo test --lib wasm::` (shapes + the C ABI driven natively) and
  `cargo test --features uniffi --lib` (the UniFFI objects; rust.yml runs it, since plain
  `cargo test` does not compile `src/uniffi/`). rust.yml also clippy-gates the uniffi, `js`,
  `js,device-broker`, `js,device-broker,module-loader-bridged` and `wasi` builds, which the
  default clippy run never compiles.
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
| `module-loader-bridged` | more methods on wasm-bindgen `WasmEngine` (implies `js`) | Hosted modules in the JS engine, run by a JS module host (`@hypen-space/module-host`) next to in-process modules. Server builds only |

`module-loader` links wasmtime into every test binary (~0.5 GB each with debuginfo), so run the
feature's tests targeted rather than as the whole suite:

```bash
cargo test --features module-loader --lib --test test_module_host --test test_module_host_async
cargo test --features runtime-bin --bin hypen-runtime          # the runtime's unit tests (fake ModuleHost, no wasm/sockets)
cargo test --features runtime-bin --test test_hypen_runtime --test test_hypen_runtime_hardening   # build + drive the hypen-runtime binary
cargo test --features uniffi,module-loader --test test_uniffi_host
cargo test --test test_module_host_routing   # engine-side routing with a mock host, default features
cargo test --test test_module_host_cascade   # reducer-output fold (ACLs, cascade queue, state, teardown), mock host
cargo test --lib hosted::                    # the subsystem without an Engine: bad paths, failure report, names, snapshots, paths
```

Module-host sandbox (one implementation for both ABIs; the model is stated in the
`module_host/wasmtime/mod.rs` module docs, storage in `kv.rs`):
- **Link time**: manifests are deny-by-default (`ModuleManifest::all` is the explicit
  grant-everything constructor). An ungranted storage scope or `wasi:http` is not linked; the
  instantiation error names the import and the missing grant. `register` rejects bytes that are
  not a component of the host's world and says which (not wasm / core module / other ABI version
  / unlinkable imports / missing exports).
- **Call time**: every guest entry is an async wasmtime call on the host's own current-thread
  tokio runtime, bounded by `ModuleLimits::max_call` twice over — epoch interruption for guest
  CPU, `tokio::time::timeout` for time parked in host calls (wasi:io poll, wasi:http,
  `hypen:time.sleep-ms`). `max_memory_bytes` is a total over all of an instance's memories and
  tables. Open bucket handles, namespace length, the resource table and cross-module requests
  are bounded host-side.
- **Death**: a trapped or timed-out instance is dead — `HostError::DeadInstance` afterwards.
  `ModuleHost::instance_status(id)` (`Live` / `Dead { reason }` / `Gone`; trait default `Unknown`)
  answers from the instance table without calling the guest — use it, never a probing call or
  error text, to tell a crash from a reducer error. An export returning `Err(string)` is a
  `ModuleError` and kills nothing. Errors name the module and the export (`error.rs` has the
  mapping table).
- **Link denials as data**: `ModuleHost::denied_capabilities(name)` (trait default: empty) lists
  the imports a registered component needs and its manifest does not grant. `HostError` has no
  variant for it and must not grow one (other code matches it exhaustively).
- **Compilation**: `HostCore::compile` is the only place a component is compiled. The table is
  keyed by SHA-256 of the bytes only — compiled code does not depend on ABI, name or manifest
  (those decide linking, done per registration) and the table belongs to one engine. Entries are
  `Weak`; a `Registration` holds the `Arc`. `HostConfig::cache_dir` enables wasmtime's own disk
  cache (`Config::cache`, which covers components in 46); `cache_dir.rs` states what the
  directory must be and why it is opt-in. Don't add a second cache or hand-rolled
  `Component::deserialize`.
- **Storage**: `local` is partitioned by registered module name, `app`/`cloud` are shared by
  grant; writes are quota-checked and flushed once per call. Every write is stamped with the
  instance's `HostClock` (`modified-ms`; `kv.rs` never reads a clock itself). Snapshot format 3;
  format 2 is migrated on load and rewritten on the next flush (`kv.rs` module docs). Blob
  storage is unimplemented (`unavailable`) — README "Native WASM module host" is the one place
  that says so to users. A failed flush is logged with its
  path and retried; it never costs the caller the guest's result (`flush_storage()` surfaces it).
- **Re-register**: live instances keep the code and manifest they were created with; ids come
  from a process-wide counter, so a stale or foreign id can only miss.

A fix to quota logic, ACL checks, the deadline policy or dead-instance handling belongs in the
shared files, never in `v01.rs` / `v02.rs` (those are `bindgen!` glue).

The `hypen-runtime` binary is a crate directory, `src/bin/hypen_runtime/` (`main.rs` is the table
of contents): `cli` (argv → typed `Command`), `manifest` (app.json → validated `AppManifest`:
unique addressable names, paths confined to the manifest directory, grant targets exist),
`usage_plan` + `template` (per-usage instances via template rewriting, pure), `app` (`Runtime`:
the engine and hosted-module table behind one lock; boot, dispatch, crash recovery), `patches`
(`PatchHub`: tree mirror behind `GET /patches`, capture window that gives each render to exactly
one of the `/dispatch` response or SSE), `effects` + `timers` (one timer thread, min-heap, 1024
pending per module), `reload` (`.wasm`/`.hypen` hot reload over the live module table), `server`
(`request.rs` is the pure admission policy: loopback `Host`, own-or-`--allow-origin` `Origin`,
JSON content type, 1 MiB bodies), `repl`, `error` (`RuntimeError` + `render`), `sync` (poisoned
locks are recovered, not propagated). Single-module mode grants nothing beyond `local` storage
unless `--grant-http` / `--grant-storage` / `--grant-all` is passed. A module instance that traps
or times out fails that dispatch (`module_crashed`, with the host's death reason) and is
re-instantiated + re-`init`ed from its original config on the next action. Crashes are detected
with `instance_status` (fallback for `Unknown` hosts such as the unit tests' fake: the engine's
cascade report of that same dispatch); capability hints come from `denied_capabilities`. An
action no module handles is `RuntimeError::UnknownAction` (404), a bare name several export is
`AmbiguousAction` (409); both list `scope:action` candidates from the runtime's module table.

`server/mod.rs` documents what `tiny_http` forces on the server: dropping (so also answering) a
request with unread body bytes blocks and allocates the declared remainder, so the `/dispatch`
body is read on a helper thread under `--request-timeout-ms`, replies to requests with body bytes
outstanding go through `finish` (detached thread, or `abandon` past 16 MiB), and nothing
client-paced runs on the accept loop or inside an in-flight slot. `reload.rs` watches the files'
*directories* (rename-replaced `.wasm`), compiles outside the engine lock via the host's
`ComponentCompiler`, retires usage scopes a template edit orphaned (after the re-render), and
re-seeds the single module when its `--ui` declaration config changes. `--cache-dir` is the
opt-in compiled-module cache. When two worktrees share a target dir, copy the built binary
aside and point the subprocess suites at it with `HYPEN_RUNTIME_BIN`.

Two action entries, by where the input comes from (`src/action_routing.rs`):

- `Engine::dispatch_action` (`route_ui_action`; JS `dispatchAction`, WASI `hypen_dispatch_action`,
  UniFFI `dispatch_action`) is the **same-trust-domain** entry: an in-process renderer, or host code
  replaying an already-resolved action. It resolves a `__hypen_dispatch` envelope by node
  *ownership* (any live node of a scope may name any handler of that scope), takes a registered
  `__hypen_scoped:<scope>:<name>` as given, and dispatches a bare name exactly one scope handles —
  reserved writes (`__hypen_bind`) included. A resolved scoped name owned by a hosted instance
  drives that module, anything else the closure dispatcher. There is no `scope:action` qualifier
  and no sender-node shortcut.
- `Engine::dispatch_client_action` / `resolve_client_action` (`route_client_action`; JS
  `resolveClientAction`, WASI `hypen_dispatch_client_action`, UniFFI `dispatch_client_action`) is
  the entry for input that **crossed a trust boundary** (a Remote UI client). Only an envelope is
  accepted, and its node must be live, attached, and itself carry the binding: a `Value::Action`
  (or data-source binding) of that name in its own raw props — rendered data can never forge one —
  or, for `__hypen_bind` / `__hypen_reorder` / `__hypen_pin`, the `.bind` / pin declaration
  `validate_ui_write` checks. Scoped names, bare names and every other `__hypen_*` name are
  refused. The result is trusted input for `dispatch_action`. A remote-session server must feed
  wire input to this entry, never to `dispatch_action`; bare names it wants to accept (a client's
  back action) are its own explicit allowlist. Pinned by `tests/test_client_action_authorization.rs`
  and `engine-compatibility-tests/fixtures/actions/client-action-authorization.json`.

Trusted embedder code (REPL, timers, tests) addresses a hosted scope with
`Engine::dispatch_module_action(scope, name, payload)`.

The hosted-module subsystem is `src/hosted/` (`HostedModules`, one field of `Engine`; the `Engine`
module-instance methods are delegations). It never takes `&mut Engine`: each call gets an `EngineCtx`
(`&mut EngineCore`, the in-process handlers as `&dyn ClosureActions`, the renderer as
`&mut dyn PatchOutlet`), so it is driven in unit tests (`src/hosted/tests.rs`) with a scripted
`ModuleHost` and no `Engine` — and composed a second time by the JS binding (below), with the JS
handler map and the JS render callback behind the same two traits.

**In-process scopes are part of the cross-module contract.** A grant may name a scope that is not
hosted (an SDK module: closures / JS handlers + host-written state). `reads` on it hands its state
over as a sibling snapshot and allows subscribing (a host `update_state*` notifies). `dispatches`
on it lets a reducer cross-dispatch to the handler registered under the scope's wire name
(`__hypen_scoped:<scope>:<action>`): queued in the same FIFO, same ACL check, depth cap, budget and
failure reporting; the handler gets the decoded payload and the sending scope as `sender`. Reserved
`__hypen_*` actions are never deliverable that way (`__hypen_bind` writes an arbitrary state path),
nor is a target/name containing `:`. A handler that fails is `FailureCause::Handler`.

### Hosted modules in the JS engine (`module-loader-bridged`)

There is ONE JS engine class. In server builds (`js,device-broker,module-loader-bridged`: `pkg/nodejs`,
`pkg/bundler`, `pkg/web`) `WasmEngine` composes `HostedModules` with its `EngineCore` exactly as the
native `Engine` does (`src/wasm/js_modules.rs`), so hosted modules and ordinary JS-handler modules
run side by side. The browser bundle (`pkg/browser`, `js` alone) has none of it; `build-wasm.sh`
fails if the methods leak into it.

| JS method | Does |
|---|---|
| `setModuleHost(host)` | install a `JsModuleHost` (`@hypen-space/module-host`); components are `prepare()`d there (async) first |
| `registerHostedModule(scope, component?, manifest?, config?, actions?)` | host `register` → `instantiate` → `init` → `actions`, then wire; returns `{scope, component, instanceId, actions, wildcard}` |
| `reloadHostedModule(scope, component?, manifest?, actions?)` | new instance, state kept (rewire), old instance destroyed |
| `activateHostedModule` / `deactivateHostedModule` / `destroyHostedModule(scope)` | lifecycle; `false` when the scope hosts nothing |
| `dispatchModuleAction(scope, name, payload)` | trusted dispatch (`Engine::dispatch_module_action`) |
| `hostedModules()` / `isHostedModule(scope)` / `getModuleState(scope)` | introspection; `getModuleState` is the trusted whole-state read (`getStateAt` is the guarded external one) |
| `lastModuleCascadeReport()` | `CascadeReport::to_json()` or `null` |
| `setModuleEffectHandler(fn)` | `fn(scope, {type:"navigate",path} \| {type:"delay",ms,then})` |
| `moduleDispatchBudget()` / `setModuleDispatchBudget(n)` | the cascade budget |

Existing methods gained hooks, all behind `#[cfg(feature)]` and a no-hosted-module fast path:
`dispatchAction` (routed action owned by a hosted module drives it, else the JS handlers exactly as
before), `updateState` / `updateStateSparse` / `updateStateSparseJson` (host-write subscriber
notification), `unregisterModule` (a hosted scope gets the full teardown), `reset` (hosted
instances released).

Errors of the hosted methods are JS `Error`s with `type: "moduleError"`, a stable `code`
(table on `Thrown` in `js_modules.rs`) and, for `moduleCallFailed` / `cascadeIncomplete`, the
`report`. `dispatchAction` keeps its `{type: "actionError", message}` objects for routing refusals.

Re-entrancy: every engine→JS callback (module host, in-process handler reached by cross-dispatch,
effect handler, render callback) runs inside a `&mut self` call, and wasm-bindgen refuses a call
back into the same `WasmEngine` at the re-entrant caller ("recursive use of an object…"; nothing
runs, nothing is corrupted). If the callback lets that escape it is recorded like any failing
callback, with the message rewritten by `bridged_host::describe_js_error`. JS that needs the engine
from a callback defers the call (`queueMicrotask`).

Test: `cd ../hypen-web && bun test packages/module-host/tests/e2e-engine.test.ts` (the shipped
wasm-node engine + `JsModuleHost` + the committed fixture components, hosted and in-process modules
in one engine, every cross-boundary direction, bad paths, re-entrancy, and that the browser build
has no hosted surface).

Folding a reducer output (`dispatch`, `on_activated`, `on_deactivated`) never routes by string:
`emit` stays in the emitting scope, cross-dispatch and `subscribe` are re-checked against the
`ModuleGrants` given at `register_module_instance`, and follow-ups drain from a FIFO queue bounded
by `MAX_CASCADE_DEPTH` and `Engine::module_dispatch_budget` (a failed follow-up is collected and
reported after the queue is empty). The scope's state is replaced wholesale with what the reducer
returned; the old/new comparison only yields the changed paths to invalidate. Fold order: state
(unusable state rejects the whole output) -> requested subscriptions -> effects -> follow-ups
(`emit`, cross-dispatch, subscriber notifications).

Types carry the invariants: a `ScopeName` (lowercase, non-empty, no `:`, not `__hypen_*`) and an
`ActionSet` are built once in `register`/`rewire` and nothing downstream re-validates or
re-lowercases; every queued item has an `Origin` (`Root`, `Lifecycle`, `Emit`, `CrossDispatch { from }`,
`SubscriptionChange { target, path }`); every refusal/failure is a `CascadeFailure { scope, action,
origin, cause: FailureCause }` in a `CascadeReport`. The public error type is unchanged — the report
is rendered into `EngineError::ModuleError` (one line per failure; an ACL refusal names the grant to
add), a failing root keeps its variant (`ModuleError` / `StateError`) — and the structured report of
the most recent cascade is `Engine::last_module_cascade_report()` (also the only place the failures
of a host write's subscriber notifications surface, since `update_state*` return nothing).
A follow-up payload must be JSON: empty means `null`, anything else malformed is refused and
reported (`FailureCause::PayloadNotJson`), not delivered.

## Key Dependencies

- `hypen-parser` — upstream AST
- `hypen-tailwind-parse` — Tailwind CSS support
- `indexmap` — ordered property maps
- `im` — persistent/immutable data structures
- `slotmap` — slot allocation for node IDs
- `exprimo` — expression evaluation for `@{...}` bindings
