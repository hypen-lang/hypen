# CLAUDE.md

## Project Overview

Hypen is a declarative UI language and runtime for building cross-platform applications. UI components are purely declarative while modules manage reactive state and business logic.

## Repository Structure

```
hypen-engine-rs/
├── parser/                      # Rust parser (Chumsky combinators)
├── hypen-engine-rs/             # Core reactive engine (Rust -> WASM)
├── hypen-sdk-rs/                # Rust SDK for embedding Hypen
├── hypen-web/                   # TypeScript/Bun Web SDK
│   ├── packages/core/           # @hypen-space/core - Platform-agnostic runtime (types, app, state, router - NO WASM)
│   ├── packages/web/            # @hypen-space/web - DOM & Canvas renderers (pure patch consumers)
│   ├── packages/server/         # @hypen-space/server - Node.js WASM engine, loader, discovery, RemoteServer
│   └── packages/web-engine/     # @hypen-space/web-engine - Browser WASM engine, Hypen orchestrator
├── hypen-cli/                   # @hypen-space/cli - CLI tools (init, dev, build)
├── hypen-docs/                  # Fumadocs/Next.js documentation site
├── hypen-renderer-android/      # Android/Kotlin native renderer
├── hypen-renderer-swift/        # iOS/SwiftUI native renderer
├── hypen-server-swift/          # Swift server SDK
├── hypen-kotlin/                # Kotlin/JVM SDK (module system with Kotlin DSL)
├── hypen-golang/                # Go implementation (module system)
├── hypen-lsp/                   # Language Server Protocol implementation
├── tailwind-parse/              # Tailwind CSS class parser (Rust)
├── component-gallery-server/    # Component gallery & screenshot testing
├── engine-compatibility-tests/  # Cross-SDK compatibility test suite
├── examples/                    # Example projects
├── skills/                      # Claude Code skills for Hypen development
└── scripts/                     # Build & utility scripts
```

## Development Commands

### Parser (Rust)
```bash
cd parser
cargo test                                 # Run all tests
cargo test test_name -- --nocapture        # Specific test with output
cargo run --example pretty_errors          # Pretty error display with Ariadne
```

### Engine (Rust/WASM)
```bash
cd hypen-engine-rs
cargo test                                 # Run tests natively
cargo clippy                               # Lint
./build-wasm.sh                            # Build all WASM targets (bundler, nodejs, web)
```

### Web SDK (TypeScript/Bun)
```bash
cd hypen-web
bun test                                   # Run tests
bun run playground                         # Interactive dev playground
bun run replayground                       # Rebuild WASM + restart playground
```

### CLI
```bash
cd hypen-cli
bun bin/hypen.ts init my-app               # Create new project
bun bin/hypen.ts dev                       # Dev server with hot reload
bun bin/hypen.ts build                     # Production build
```

### Docs
```bash
cd hypen-docs
bun install && bun dev                     # Local dev server
bun run build                              # Production build
```

### Kotlin SDK
```bash
cd hypen-kotlin
./gradlew test                             # Run tests (includes compatibility tests)
```

## Architecture

### Data Flow
```
Hypen DSL -> Parser (AST) -> Engine (IR) -> Reconciler -> Patches -> Platform Renderer
                                  ↑
                             State/Actions
```

### Core Components

**Parser** (`parser/`) - Rust combinator-based parser using Chumsky
- Entry: `src/lib.rs` exports `parse_component()`, `parse_components()`, `parse_document()`, `parse_import()`
- AST types: `src/ast.rs`
- Parser logic: `src/parser.rs`
- Tests: `src/tests.rs` (114 tests)

**Engine** (`hypen-engine-rs/`) - Core reactive runtime
- Orchestrator: `src/engine.rs` - `Engine` struct coordinates all systems
- WASM bindings: `src/wasm/` - `WasmEngine` in `js.rs`, WASI interface in `wasi.rs`
- IR system: `src/ir/` - AST to intermediate representation
- Reactive system: `src/reactive/` - dependency tracking for `@{state.*}` bindings
- Reconciliation: `src/reconcile/diff.rs` - keyed diffing, generates minimal patches
- Actions/Events: `src/dispatch/` - routes `@actions.*` to module handlers
- Lifecycle: `src/lifecycle/` - module/component lifecycle
- State: `src/state.rs` - observable state with change detection
- Serialization: `src/serialize/` - Remote UI protocol

**Web SDK** (`hypen-web/packages/`)
- `core/src/app.ts` - fluent API for defining stateful modules
- `core/src/state.ts` - Proxy-based reactive state
- `core/src/types.ts` - shared types (Patch, Action, etc.)
- `web/src/dom/` - browser DOM renderer
- `web/src/canvas/` - Canvas 2D renderer
- `server/src/engine.ts` - Node.js WASM engine wrapper
- `server/src/discovery.ts` - component file discovery
- `server/src/loader.ts` - dynamic component loader
- `web-engine/src/engine.ts` - browser WASM engine wrapper
- `web-engine/src/hypen.ts` - Hypen orchestrator class

**CLI** (`hypen-cli/`)
- `bin/hypen.ts` - command dispatcher
- `src/dev.ts` - dev server with hot reload

### Key Data Structures

**AST (Parser Output):**
```rust
ComponentSpecification {
    id: String,
    name: String,              // "Column", "Text", etc.
    declaration_type: DeclarationType, // Module, Component, or ComponentKeyword
    arguments: ArgumentList,   // Named/positional args
    applicators: Vec<ApplicatorSpecification>,  // .padding(16), .color(blue)
    children: Vec<ComponentSpecification>,
    metadata: MetaData,        // internal_id, name_range, block_range
}
```

**IR (Engine Internal):**
```rust
enum IRNode {
    Element(Element),             // { element_type, props, children, key, events }
    ForEach(ForEachNode),         // List iteration
    Conditional(ConditionalNode), // When/If branching
    Router(RouterNode),           // Route matching with per-route subtree cache
}
```

**Patches (Engine Output):**
```rust
enum Patch {
    Create { id, element_type, props },
    SetProp { id, name, value },
    RemoveProp { id, name },
    SetText { id, text },                             // reserved; reconciler emits SetProp for text
    Insert { parent_id, id, before_id },
    Move { parent_id, id, before_id },
    Remove { id, transition },                        // transition: true (serde skip-if-false) roots an animated exit
    Detach { id },                                    // unlink but keep alive (Router cache)
    Attach { parent_id, id, before_id },              // reinsert a previously-detached subtree
}
// Note: Event handling is done at the renderer level, not via patches.
// Detach/Attach back the Router subtree cache — navigating back to a visited route
// reuses the same NodeId subtree instead of rebuilding it.
// Remove.transition flags the root of a subtree whose node carried an "__anim.exit"
// prop (from the .exit() applicator): the flagged root Remove is emitted FIRST,
// then its descendants as plain Removes, and the renderer may defer teardown to
// play the exit. Absent flag = wire-identical to the old protocol (renderers snap).
```

## Hypen DSL Syntax

```hypen
// Components with arguments
Text("Hello")
Text(text: "Hello", color: red)

// Nesting
Column {
    Text("First")
    Text("Second")
}

// Modules (stateful)
module ProfilePage(userId: 123) {
    Text("Welcome, @{state.user.name}")
    Button("@actions.signIn") { Text("Sign In") }
}

// Applicators (styling)
Text("Styled")
    .fontSize(18)
    .color(blue)
    .padding(16)

// Two-way binding (syncs form element value with state automatically)
Input(placeholder: "Name").bind(@state.name)
Textarea(placeholder: "Bio").bind(@state.bio)
Checkbox {}.bind(@state.agreed)
Switch {}.bind(@state.darkMode)
Select {}.bind(@state.country)

// Strings: double or single quotes, with escape support
Text("Hello")
Text('Embed "double quotes" freely')
Text("Escaped \"quotes\" work too")

// Argument types: strings, numbers, booleans, lists, maps, references
Button(text: "Submit", enabled: true, tags: ["primary"], onClick: @actions.submit)
```

## Module System

Modules are stateful controllers that manage data and respond to events:

```typescript
import { app } from "@hypen-space/core";

export default app
  .defineState<{ count: number }>({ count: 0 })
  .onCreated(async (state, context) => {
    console.log("Module created (once per session)");
  })
  .onActivated(async (state) => {
    console.log("Module became visible (every navigation)");
  })
  .onAction("increment", async ({ action, state, context }) => {
    state.count += 1;  // Proxy auto-tracks mutations, no sync callback needed
    // context.router - access HypenRouter for navigation
  })
  .onDeactivated((state) => {
    console.log("Module left the screen");
  })
  .onDestroyed((state, context) => {
    console.log("Module destroyed");
  });
```

**Key points:**
- State mutations auto-tracked via Proxy (no callback needed)
- Lifecycle handlers: `onCreated` / `onActivated` / `onDeactivated` / `onDestroyed`, all `(state, context?)`
  - `onCreated` runs **once** per module instance
  - `onActivated` / `onDeactivated` run **every time** the module gains/loses the active route slot
  - `onDestroyed` runs when the instance is finally torn down
- Action handlers: `onAction(name, ({ action, state, context }) => ...)`
- `context.router` provides `HypenRouter` for programmatic navigation
- Actions dispatched from UI via `@actions.actionName`
- Under `ManagedRouter`, module-backed routes **persist across navigations by default** — navigate away and back to the same route and the module instance (and its state) is reused, avoiding "loading flash" on re-entry. Opt out with `{ persist: false }` on the definition. The persist cache is a bounded LRU (default 10, configurable via `maxPersistedModules`) so long sessions over many routes evict the least-recently-used module rather than retaining every visited route forever.

## Critical Architecture Notes

- **Shared Engine, Namespaced State**: Multi-module apps share a **single `Engine` instance** — there is NOT one engine per module. Each module registers its state under a lowercase-name prefix (e.g., `search`), and the engine holds one merged state tree. The SDK layer manages module lifecycles, action routing, and cross-module communication via `HypenGlobalContext`. Handlers receive both their local state and a `GlobalContext` that can read/mutate any sibling module's state.
- **Path-Based Dependency Tracking**: Dependencies tracked by string paths (`"user.name"`, `"items.0.title"`), not values. Host must correctly signal which paths changed.
- **Arc-Shared Props**: `Props` (raw, with bindings) and `ResolvedProps` (resolved JSON values, on `InstanceNode` and `Patch::Create`) are `Arc<IndexMap<...>>`. Cloning a node's props into a `Create` patch, or snapshotting old props before a dirty re-render, is an `Arc::clone` rather than a deep copy. Other per-render clones should be scrutinised — prefer moves and `&mut` over `.clone()` unless a shared-ownership handoff genuinely requires it.
- **First-Class Control Flow**: ForEach/When/If are IR-level types, not runtime hacks. Exhaustive pattern matching catches missing cases at compile time.
- **Proxy-Based State (SDK)**: TypeScript Proxy tracks mutations automatically. The `deleteProperty` trap correctly tracks `delete` operations. The `in` operator (`has` trap) is not tracked.
- **Renderer-Agnostic Patches**: All renderers (DOM, Canvas, iOS, Android) receive the same Patch format.

## Common Workflows

### Adding a Parser Feature
1. Add test in `parser/src/tests.rs`
2. Update AST types in `parser/src/ast.rs` if needed
3. Modify parser in `parser/src/parser.rs`
4. Run `cargo test`
5. Update engine IR expansion in `hypen-engine-rs/src/ir/expand.rs`

### Modifying the Engine
1. Edit `hypen-engine-rs/src/`
2. `cargo test`
3. `./build-wasm.sh`
4. Test: `cd ../hypen-web && bun run playground`

### Working on Web SDK
1. Edit `hypen-web/packages/*/src/`
2. `bun test`
3. `bun run playground` (hot reload)
4. For WASM changes: `bun run replayground`

## Quick Debugging

```bash
# Parser - specific test with output
cd parser && cargo test test_name -- --nocapture

# Engine - tests with backtrace
cd hypen-engine-rs && RUST_BACKTRACE=1 cargo test -- --nocapture

# Engine - lint
cd hypen-engine-rs && cargo clippy

# Web SDK - tests with debug output
cd hypen-web && DEBUG=hypen:* bun test

# Full rebuild after engine changes
cd hypen-engine-rs && ./build-wasm.sh && cd ../hypen-web && bun run playground
```

## Tooling Requirements

- Rust 1.70+ (2021 edition)
- wasm-pack (for WASM builds)
- Bun 1.0+ (for TypeScript SDK, CLI, docs)
