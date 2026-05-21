# CLAUDE.md

This file provides guidance to Claude Code when working with the Hypen Rust SDK.

## Project Overview

`hypen-sdk-rs` (crate name: `hypen-server`) is the Rust server SDK for building Hypen applications. It provides the module system (state, actions, lifecycle, routing) for Rust backends, parallel to the TypeScript and Go SDKs.

## Module Structure

```
hypen-sdk-rs/src/
├── lib.rs          # Public API and prelude
├── app.rs          # HypenApp and HypenAppBuilder — top-level app API
├── module.rs       # ModuleBuilder and ModuleInstance — module definition and runtime
├── state.rs        # State trait and StateContainer — reactive state with change tracking
├── action.rs       # Action types and dispatch
├── router.rs       # URL routing with pattern matching
├── context.rs      # GlobalContext for cross-module communication
├── events.rs       # Typed event emitter
├── discovery.rs    # Component file discovery
├── error.rs        # Error types
└── prelude.rs      # Common re-exports
```

## Development Commands

```bash
cargo test              # Run all tests
cargo build             # Build
cargo doc --open        # Generate and open API docs
cargo clippy            # Lint
```

## Architecture

Follows the same module pattern as TypeScript/Go SDKs:
- **ModuleBuilder** — fluent API: `HypenApp::module::<S>("name").state(...).on_action(...).build()`
- **HypenAppBuilder** — top-level app builder
- **State trait / StateContainer** — reactive state with path-based change tracking (StateContainer is `pub(crate)`)
- **ModuleInstance** — bridges module definition and engine
- **Router** — URL routing with pattern matching and history
- **GlobalContext** — cross-module communication

## Key Dependencies

- `hypen-engine` — core rendering engine
- `hypen-parser` — DSL parser
- `tokio` (optional, `async` feature) — async runtime support
