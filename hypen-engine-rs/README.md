# Hypen Engine

[![Rust](https://img.shields.io/badge/Rust-1.70+-orange?logo=rust)](https://www.rust-lang.org/)
[![WASM](https://img.shields.io/badge/WASM-Ready-654FF0?logo=webassembly)](https://webassembly.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)

The core reactive rendering engine for Hypen, written in Rust. Compiles to WASM for web/desktop or native binaries with UniFFI for mobile platforms.

## Quick Start

### Rust

```rust
use hypen_engine::{Engine, ast_to_ir_node};
use hypen_parser::parse_component;
use serde_json::json;

let mut engine = Engine::new();
engine.set_render_callback(|patches| {
    // Apply patches to your renderer
});

let ast = parse_component(r#"Column { Text("Hello") }"#)?;
engine.render_ir_node(&ast_to_ir_node(&ast));
engine.update_state(json!({ "count": 42 }));
```

### JavaScript/TypeScript (WASM)

```typescript
import init, { WasmEngine } from './wasm/hypen_engine.js';
await init();

const engine = new WasmEngine();
engine.setRenderCallback((patches) => applyPatches(patches));
engine.setModule('App', ['increment'], ['count'], { count: 0 });
engine.renderSource(`Column { Text("@{state.count}") }`);
```

## Overview

Hypen Engine is a platform-agnostic UI engine that:
- **Expands** Hypen DSL components into an intermediate representation (IR)
- **Tracks** reactive dependencies between state and UI nodes
- **Reconciles** UI trees efficiently using keyed diffing
- **Generates** minimal platform-agnostic patches for renderers
- **Routes** actions and events between UI and application logic
- **Serializes** for Remote UI scenarios (client-server streaming)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Hypen Engine                          │
├─────────────────────────────────────────────────────────┤
│  Parser → IR → Reactive Graph → Reconciler → Patches   │
│     ↓                                            ↓       │
│  Component Registry                    Platform Renderer│
│  Dependency Tracking                   (Web/iOS/Android)│
│  State Management                                       │
└─────────────────────────────────────────────────────────┘
```

### Core Systems

1. **IR & Component Expansion** (`src/ir/`)
   - Canonical intermediate representation
   - Component registry and resolution
   - Props/slots expansion with defaults
   - Stable NodeId generation

2. **Reactive System** (`src/reactive/`)
   - Dependency graph tracking `@{state.*}` bindings
   - Dirty marking on state changes
   - Scheduling for efficient updates

3. **Reconciliation** (`src/reconcile/`)
   - Virtual instance tree (no platform objects)
   - Keyed children diffing algorithm
   - Minimal patch generation

4. **Patch Types** (Platform-agnostic, 9 total):
   - `Create(id, type, props)` - Create new node
   - `SetProp(id, name, value)` - Update property
   - `RemoveProp(id, name)` - Remove a property
   - `SetText(id, text)` - Update text content (reserved; reconciler emits `SetProp` for the positional text slot)
   - `Insert(parent, id, before?)` - Insert into tree
   - `Move(parent, id, before?)` - Reorder node
   - `Remove(id)` - Remove from tree
   - `Detach(id)` - Unlink subtree but keep native element alive (Router cache)
   - `Attach(parent, id, before?)` - Reattach a previously-detached subtree
   - Event handling is managed at the renderer level

5. **Action/Event Routing** (`src/dispatch/`)
   - Map `@actions.*` to module handlers
   - Forward UI events (click, input, etc.)
   - Stable dispatch contract for SDKs

6. **Lifecycle Management** (`src/lifecycle/`)
   - Module lifecycle (created/destroyed)
   - Component lifecycle (mount/unmount)
   - Resource cache (images/fonts) with pluggable fetcher

7. **Remote UI Serialization** (`src/serialize/`)
   - Initial tree serialization
   - Incremental patch streaming
   - Revision tracking and optional integrity hashes
   - JSON format support

## Usage

### Basic Example

```rust
use hypen_engine::{Engine, ir::{Element, Value, Component}};
use hypen_engine::reactive::parse_binding;
use indexmap::IndexMap;
use serde_json::json;

// Create engine
let mut engine = Engine::new();

// Register a custom component
// Note: In practice, you'd typically parse Hypen DSL with ast_to_ir_node
engine.register_component(Component::new("Greeting", |props: IndexMap<String, serde_json::Value>| {
    Element::new("Text")
        .with_prop("text", Value::Binding(
            parse_binding("@{state.name}").expect("valid binding")
        ))
}));

// Set render callback
engine.set_render_callback(|patches| {
    for patch in patches {
        println!("Patch: {:?}", patch);
    }
});

// Register action handler
engine.on_action("greet", |action| {
    println!("Hello from action: {:?}", action);
});

// Render UI
let ui = Element::new("Column")
    .with_child(Element::new("Greeting"));

engine.render(&ui);

// Update state
engine.update_state(json!({
    "name": "Alice"
}));
```

### With Module Host

```rust
use hypen_engine::lifecycle::{Module, ModuleInstance};

// Create module definition
let module = Module::new("ProfilePage")
    .with_actions(vec!["signIn".to_string(), "signOut".to_string()])
    .with_state_keys(vec!["user".to_string()])
    .with_persist(true);

// Create module instance
let instance = ModuleInstance::new(
    module,
    json!({ "user": null })
);

engine.set_module(instance);
```

## Native WASM module host and `hypen-runtime`

With the `module-loader` feature the engine hosts `hypen:module` WASM
Components natively (`WasmtimeHost`, `WasmtimeHostAsync`, `DualHost`); the
`runtime-bin` feature adds the `hypen-runtime` dev binary on top
(`hypen-runtime --help`). The sandbox model is documented in
`src/module_host/wasmtime/mod.rs`; this section is what an embedder or a
runtime user needs to know.

### Startup cost and the compilation cache

Compiling a component is the expensive part of start-up — seconds for a
module that embeds a JS engine (a `jco componentize` build is ~14 MB), and
tens of seconds in a debug build of the host, where the compiler itself is
unoptimized.

- **In-process:** a host compiles each *distinct* component once. Compiled
  code is found by the SHA-256 of the component bytes, so registering the same
  `.wasm` under several names (per-usage scopes such as `counter__a`), hot
  reloading several scopes backed by one file, and both ABIs of a `DualHost`
  share one compilation. Code is released when no registration or instance
  uses it. `host.compile_stats()` reports compiled / reused / disk hits.
- **Across processes (opt-in):** `HostConfig::cache_dir` (`hypen-runtime
  --cache-dir DIR`, UniFFI `"cacheDir"`) turns on wasmtime's on-disk
  compilation cache. Entries are keyed by the component bytes, the wasmtime
  version and the engine's whole compiler configuration (so Cranelift and
  Pulley never share entries), and re-checked on load: a stale artifact is
  never used, it is recompiled.
  **Trust:** a cache entry is code the process will execute, and it is
  checked for compatibility, not authenticity. The cache is therefore off
  unless a directory is named (`--data-dir` does not imply it); the directory
  is created `0700` if missing and refused if it is writable by group/others
  or owned by another user (Unix). Not checked — and the embedder's
  responsibility — is that no parent directory lets someone else replace it,
  and, on non-Unix platforms, that the location is private at all.
- `ComponentCompiler` (`host.compiler()`) compiles from another thread
  without borrowing the host; `hypen-runtime` uses it so a hot reload compiles
  outside the engine lock and requests keep being served meanwhile.
- `cargo test --features module-loader --test test_module_host startup_timing
  -- --ignored --nocapture` (add `--release`) prints the cost phase by phase.

### Liveness and capability denials as data

- `ModuleHost::instance_status(id)` → `Live` / `Dead { reason }` / `Gone` /
  `Unknown`, from the host's bookkeeping, without calling the guest. The
  default implementation answers `Unknown`.
- `ModuleHost::denied_capabilities(name)` → the imports the registered
  component needs and its manifest does not grant (`DeniedCapability { import,
  grant: ManifestGrant::Http | Storage(scope) }`). Non-empty exactly when
  `instantiate(name)` is refused for missing grants. Default: empty.

Neither changes `HostError`; both exist so embedders do not parse messages.

### Storage

`hypen:storage` key-value buckets are backed by one in-memory store per host,
optionally persisted to `<data_dir>/storage.json` (`local` and `app` scopes;
`cloud` is an in-process simulation of a sync service and is not persisted).
`entry-info.modified-ms` is the writing instance's host clock at the last
successful write (deterministic under `set_virtual_clock`). The file's
`format` is 3; a format-2 file (no modification times) is migrated in memory
— its entries read `modified-ms` 0 until rewritten — and rewritten by the
next flush. Any other format is refused with an error naming the file.

**Blob storage is not implemented.** The `blob-bucket` / `blob-handle` /
`blob-writer` resources of `hypen:storage` exist in the WIT and are linked,
but every operation answers `unavailable` on the native hosts (v0.1 and
v0.2). A module that needs large binary values must not depend on them yet.

### `hypen-runtime --serve`

| Situation | Status | `error.code` |
|---|---|---|
| unknown route / method / bad JSON / foreign Host or Origin | 404 / 405 / 400 / 403 | see `server/request.rs` |
| no module handles the action (`error.candidates` lists `scope:action` forms that exist) | 404 | `action_not_found` |
| a bare action name several modules export (`error.candidates` lists them) | 409 | `ambiguous_action` |
| the body did not arrive within `--request-timeout-ms` (default 10 s) | 408 | `request_timeout` |
| a reducer returned an error | 500 | `module_error` |
| an instance trapped or timed out (`error.scopes`, `error.reasons`) | 500 | `module_crashed` |

Request bodies: the `/dispatch` body is read under a deadline on a helper
thread, and a request that misses it stops counting against the 64 requests
handled at once. Known limits of the embedded HTTP library (`tiny_http`
0.12, which exposes no socket or timeout): a stalled connection still parks
one thread until the client disconnects; a request that declares more than
16 MiB of body is answered and its connection deliberately leaked (letting
the library free it would allocate the declared size); and connections opened
in a burst can queue inside the library behind long-lived ones (its thread
pool hands a connection to an "idle" thread that may already be taken).
`src/bin/hypen_runtime/server/mod.rs` states these precisely.

Hot reload: a changed `.wasm` swaps every scope it backs, keeping engine
state (the files' directories are watched, so a `.wasm` replaced by rename is
noticed every time); a changed `.hypen` re-renders, mints per-usage scopes
the edit introduced and retires the ones no template references any more
(`on_destroyed`, then the engine scope and host instance are removed). In
single-module mode, an edit that changes the `--ui` root declaration's
arguments (`module Counter(start: 5)`) restarts the module with the new
`init` config; other edits keep its state.

## Compilation Targets

### Native (Development)

```bash
cargo build
cargo test
```

### WASM (Web/Desktop)

The WASM build is fully functional and tested. Run `./build-wasm.sh` to build all targets (bundler, nodejs, web).

**Quick Start:**

```bash
# Install wasm-pack (one time)
cargo install wasm-pack

# Build for all WASM targets
./build-wasm.sh

# Or build manually for specific targets:
wasm-pack build --target bundler    # For webpack/vite/rollup
wasm-pack build --target nodejs     # For Node.js
wasm-pack build --target web        # For vanilla JS
```

**Output directories:**
- `pkg/bundler/` - For use with bundlers (webpack, vite, rollup)
- `pkg/nodejs/` - For Node.js
- `pkg/web/` - For vanilla HTML/JS (see `example.html`)

**Build to custom directory:**
```bash
# Build directly to your renderer project
wasm-pack build --target bundler --out-dir ../hypen-web/packages/web-engine/wasm-browser
```

The WASM binary is optimized for size (~300KB) with LTO and size optimizations enabled.

### JavaScript/TypeScript API

The WASM build provides a `WasmEngine` class with a complete API:

```typescript
import init, { WasmEngine } from './pkg/web/hypen_engine.js';

// Initialize WASM (required before creating engine)
await init();

// Create engine instance
const engine = new WasmEngine();

// Set render callback to receive patches
engine.setRenderCallback((patches) => {
    console.log('Patches:', patches);
    // Apply patches to your platform renderer
    applyPatchesToDOM(patches);
});

// Register action handlers
engine.onAction('increment', (action) => {
    console.log('Action received:', action.name, action.payload);
    // Handle action (e.g., update state)
    engine.updateState({ count: action.payload.count + 1 });
});

// Initialize module with state and actions
engine.setModule(
    'CounterModule',           // Module name
    ['increment', 'decrement'], // Available actions
    ['count'],                  // State keys
    { count: 0 }                // Initial state
);

// Render Hypen DSL source code
const source = `
    Column {
        Text("Count: @{state.count}")
        Button("@actions.increment") { Text("+1") }
    }
`;
engine.renderSource(source);

// Update state (triggers reactive re-render)
engine.updateState({ count: 42 });

// Dispatch action programmatically
engine.dispatchAction('increment', { amount: 1 });

// Get current revision number (for remote UI)
const revision = engine.getRevision();
```

**WasmEngine API Reference:**

- `constructor()` - Create a new engine instance
- `renderSource(source: string)` - Render Hypen DSL source code
- `setRenderCallback(callback: (patches: Patch[]) => void)` - Set patch callback
- `setModule(name, actions, stateKeys, initialState)` - Initialize module
- `updateState(patch: object)` - Update state and trigger re-render
- `dispatchAction(name: string, payload?: any)` - Dispatch an action
- `onAction(name: string, handler: (action: Action) => void)` - Register action handler
- `getRevision(): number` - Get current revision number
- `setComponentResolver(resolver: (name: string, context?: string) => ResolvedComponent | null)` - Set dynamic component resolver

### Testing WASM Build

Open `example.html` in a web server:

```bash
# Using Python
python3 -m http.server 8000

# Using Node.js
npx serve .

# Then visit: http://localhost:8000/example.html
```

### Mobile (UniFFI)

UniFFI bindings for native mobile platforms ship behind the `uniffi` feature flag (see `src/uniffi/`). They power the Kotlin (`hypen-kotlin`) and Swift (`hypen-server-swift`) SDKs today.

```bash
# Build the engine with UniFFI support
cargo build --features uniffi --release

# Generate Swift/Kotlin bindings via the generated uniffi-bindgen binary
cargo run --features uniffi --bin uniffi-bindgen -- generate --library target/release/libhypen_engine.dylib --language kotlin --out-dir out/kotlin
cargo run --features uniffi --bin uniffi-bindgen -- generate --library target/release/libhypen_engine.dylib --language swift  --out-dir out/swift
```

Non-UniFFI mobile targets can still consume the WASM build via WebView or native WASM runtimes.

## Project Structure

```
hypen-engine-rs/
├── src/
│   ├── lib.rs              # Public API exports
│   ├── engine.rs           # Main Engine orchestrator
│   ├── engine_core.rs      # Shared core engine logic
│   ├── state.rs            # State change tracking
│   ├── render.rs           # Dirty node rendering
│   ├── error.rs            # EngineError type
│   ├── logger.rs           # Logging utilities
│   ├── wasm/               # WASM bindings (multi-binding)
│   │   ├── mod.rs          # Binding selection (js vs wasi)
│   │   ├── shared.rs       # Binding-agnostic helpers
│   │   ├── ffi.rs          # Shared FFI data types
│   │   ├── js.rs           # wasm-bindgen JS bindings (js feature)
│   │   └── wasi.rs         # WASI C FFI (wasi feature)
│   ├── uniffi/             # UniFFI bindings (uniffi feature)
│   ├── ir/                 # IR & component expansion
│   │   ├── mod.rs          # Module exports
│   │   ├── node.rs         # NodeId, Element, Props, Value, IRNode
│   │   ├── component.rs    # Component registry & resolution
│   │   ├── icon.rs         # SVG icon parsing + ResourceRegistry
│   │   ├── walk.rs         # IR tree walkers
│   │   └── expand.rs       # AST → IR lowering
│   ├── reactive/           # Reactive system
│   │   ├── mod.rs          # Module exports
│   │   ├── binding.rs      # @{state.*} parsing
│   │   ├── expression.rs   # Expression evaluation (exprimo)
│   │   ├── graph.rs        # Dependency tracking
│   │   └── scheduler.rs    # Dirty marking & scheduling
│   ├── reconcile/          # Reconciliation
│   │   ├── mod.rs          # Module exports
│   │   ├── tree.rs         # Instance tree (virtual DOM) + Router subtree cache
│   │   ├── diff.rs         # Keyed diffing algorithm
│   │   ├── keyed.rs        # Keyed list reconciliation
│   │   ├── conditionals.rs # When/If + Router route matching
│   │   ├── item_bindings.rs# ForEach iteration context
│   │   ├── resolve.rs      # Value resolution
│   │   └── patch.rs        # 9 Patch variants
│   ├── dispatch/           # Events & actions
│   ├── lifecycle/          # Lifecycle management (module/component/resource)
│   ├── portable/           # Canonical helpers shared with every SDK (route match, session, path, url, diff)
│   └── serialize/          # Remote UI protocol (initial tree + incremental patches)
├── tests/                  # Integration tests
├── benches/                # Criterion benchmarks
├── wit/                    # WIT interfaces (component-model feature)
├── Cargo.toml              # Rust dependencies
├── build-wasm.sh           # WASM build script
├── example.html            # WASM demo page
└── README.md               # This file
```

## Key Data Structures

### Element (IR Node)
```rust
pub struct Element {
    pub element_type: String,               // "Column", "Text", etc.
    pub props: Props,                       // Arc<IndexMap<String, Value>>
    pub children: im::Vector<Arc<Element>>, // Child elements (O(1) clone)
    pub ir_children: Vec<IRNode>,           // Control-flow nodes (ForEach, When)
    pub key: Option<String>,                // For reconciliation
    // Note: Event handling is done at the renderer level, not in IR
}
```

### Value (Props)
```rust
pub enum Value {
    Static(serde_json::Value),  // Literal values
    Binding(Binding),            // Parsed @{state.user.name} binding
    TemplateString {             // Template with embedded bindings
        template: String,
        bindings: Vec<Binding>,
    },
    Action(String),              // @actions.signIn
}
```

### Patch (Output)
```rust
pub enum Patch {
    Create { id, element_type, props },
    SetProp { id, name, value },
    RemoveProp { id, name },
    SetText { id, text },                             // reserved; reconciler emits SetProp for text
    Insert { parent_id, id, before_id? },
    Move { parent_id, id, before_id? },
    Remove { id },
    Detach { id },                                    // unlink but keep alive (Router cache)
    Attach { parent_id, id, before_id? },             // reinsert a previously-detached subtree
    // Note: Event handling is done at the renderer level, not via patches.
}
```

## Integration with Parser

The engine integrates with the Hypen parser from `../parser`:

```rust
use hypen_parser::parse_component;
use hypen_engine::ast_to_ir_node;

let source = r#"
    Column {
        Text("Hello, @{state.name}")
        Button("@actions.greet") { Text("Greet") }
    }
"#;

let ast = parse_component(source)?;
let ir_node = ast_to_ir_node(&ast); // Convert AST → IR
engine.render_ir_node(&ir_node);
```

### Full Example with Parser

```rust
use hypen_engine::{Engine, ast_to_ir_node};
use hypen_parser::parse_component;
use serde_json::json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut engine = Engine::new();

    // Set render callback
    engine.set_render_callback(|patches| {
        println!("Patches: {:#?}", patches);
    });

    // Parse Hypen DSL
    let source = r#"
        Column {
            Text("Count: @{state.count}")
            Button("@actions.increment") { Text("+1") }
        }
    "#;

    let ast = parse_component(source)?;
    let ir_node = ast_to_ir_node(&ast);

    // Render
    engine.render_ir_node(&ir_node);

    // Update state
    engine.update_state(json!({"count": 42}));

    Ok(())
}
```

## Performance Considerations

- **Keyed reconciliation**: Use `key` props for list items to minimize DOM churn
- **Dependency tracking**: Only re-render nodes affected by state changes
- **Lazy evaluation**: Bindings are resolved on-demand during reconciliation
- **Resource caching**: Images/fonts are cached with configurable eviction

## Remote UI Protocol

For client-server streaming:

```json
// Initial tree (client connects)
{
  "type": "initialTree",
  "module": "ProfilePage",
  "state": { "user": null },
  "patches": [...],
  "revision": 0
}

// State update (server → client)
{
  "type": "stateUpdate",
  "module": "ProfilePage",
  "state": { "user": { "name": "Alice" } }
}

// Incremental patches (server → client)
{
  "type": "patch",
  "module": "ProfilePage",
  "patches": [{ "type": "setProp", ... }],
  "revision": 42
}

// Action dispatch (client → server)
{
  "type": "dispatchAction",
  "module": "ProfilePage",
  "action": "signIn",
  "payload": { "provider": "google" }
}
```

## Testing

```bash
# Run all tests
cargo test

# Run with output (useful for debugging)
cargo test -- --nocapture

# Test specific module
cargo test reactive::

# Test specific file
cargo test --test test_reactive_graph

# Run tests in parallel (default)
cargo test --jobs 4
```

The test suite includes:
- Unit tests for each module
- Integration tests for engine workflows
- WASM integration tests
- Reactive dependency tracking tests
- Reconciliation algorithm tests

## Contributing

This is part of the Hypen project. See the main repository for contribution guidelines.

## License

See main Hypen project for license information.

## API Reference

### Engine (Rust)

The main `Engine` struct provides the core functionality:

```rust
impl Engine {
    pub fn new() -> Self;
    pub fn register_component(&mut self, component: Component);
    pub fn set_component_resolver<F>(&mut self, resolver: F);
    pub fn set_module(&mut self, module: ModuleInstance);
    pub fn set_render_callback<F>(&mut self, callback: F);
    pub fn on_action<F>(&mut self, action_name: impl Into<String>, handler: F);
    pub fn render(&mut self, element: &Element);
    pub fn update_state(&mut self, state_patch: serde_json::Value);
    pub fn notify_state_change(&mut self, change: &StateChange);
    pub fn dispatch_action(&mut self, action: Action) -> Result<(), EngineError>;
    pub fn revision(&self) -> u64;
    pub fn component_registry(&self) -> &ComponentRegistry;
    pub fn resources(&self) -> &ResourceCache;
}
```

### Key Exports

```rust
pub use engine::Engine;
pub use ir::{ast_to_ir_node, Element, IRNode, Value};
pub use lifecycle::{Module, ModuleInstance};
pub use reconcile::Patch;
pub use state::StateChange;
```

---

## Status

**✅ Implemented:**
- Core reactive rendering engine
- Component expansion and registry
- Dependency tracking and dirty marking
- Keyed reconciliation algorithm
- Patch generation
- Action/event dispatch system
- Module lifecycle management
- Resource caching
- WASM bindings (fully functional)
- Remote UI serialization

---

## Related Documentation

- [Documentation Index](./docs/README.md) - Full documentation index
- [Control Flow Components](./docs/control-flow.md) - ForEach, When/If, Map usage guide
- [Router](./docs/router.md) - Declarative routing and navigation
- [Architecture Internals](./docs/architecture.md) - Reactive system, reconciliation, IR
- [Advanced SDK Usage](./docs/advanced-sdk-usage.md) - Custom renderers, component resolvers, Remote UI
- [Glossary](./docs/glossary.md) - Key terms and binding syntax reference
- [Browser Compatibility](./docs/browser-compatibility.md) - Browser, platform, and WASM target support
- [../parser/README.md](../parser/README.md) - Hypen parser documentation
