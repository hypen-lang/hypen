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
│   ├── path.rs               # get/set/delete/has on JSON-ish state
│   ├── route.rs               # match_path (exact / :param / /*)
│   ├── session.rs             # Session state machine
│   └── url.rs                 # URL parse/build helpers
│
├── serialize/                # Remote UI Protocol
│   └── remote.rs             # Initial tree & incremental patch serialization
│
├── wasm/                     # Language Bindings
│   ├── ffi.rs                # Shared FFI data types (ModuleConfig, etc.)
│   ├── shared.rs             # Binding-agnostic helpers shared by js.rs and wasi.rs
│   ├── js.rs                 # wasm-bindgen JS bindings (js feature)
│   └── wasi.rs               # WASI C FFI (wasi feature)
│
└── uniffi/                   # Mobile Bindings
    └── mod.rs                # UniFFI scaffolding (uniffi feature)
```

## Development Commands

```bash
cargo test                                 # Run all tests
RUST_BACKTRACE=1 cargo test -- --nocapture # Tests with backtrace
cargo clippy                               # Lint
cargo bench                                # Benchmarks (criterion)
./build-wasm.sh                            # Build all WASM targets
```

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
- **Arc-Based Cloning**: Both `Props` (raw, with bindings) and `ResolvedProps` (resolved JSON values, on `InstanceNode` and `Patch::Create`) are `Arc<IndexMap<...>>`. Cloning a node's props into a Create patch, or snapshotting old props before a dirty re-render, is an `Arc::clone` rather than a deep copy of the map.
- **First-Class Control Flow**: ForEach/When/If/Router are IR-level types with exhaustive pattern matching.
- **Keyed Reconciliation**: List diffing uses keys to produce minimal Create/Move/Remove patches.
- **Animation Channel + Deferred Remove**: The `.transition`/`.enter`/`.exit`/`.layout` applicators lower in `ir/anim.rs` to reserved `"__anim.*"` resolved props (one JSON object per channel) that are renderer-facing — never strip them as engine-internal. When a removal root's props carry `"__anim.exit"`, the reconciler emits `Patch::Remove { transition: true }` for the root FIRST, then descendants as plain Removes (parent-remove-wins); non-animated removals keep post-order. The flag is serde skip-if-false, so unaware renderers see an unchanged wire format and snap.
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
