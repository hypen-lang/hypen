# CLAUDE.md

This file provides guidance to Claude Code when working with the Hypen Kotlin SDK.

## Project Overview

The Kotlin SDK provides the module system for building Hypen applications on the JVM. It includes state management, action handling, lifecycle hooks, routing, and a Kotlin DSL — parallel to the TypeScript, Go, and Rust SDKs.

## Module Structure

```
hypen-kotlin/src/main/kotlin/space/hypen/core/
├── Engine.kt              # Engine interface (WASM via JNA)
├── NativeEngine.kt        # Native engine bindings
├── HypenServer.kt         # WebSocket server for remote UI
├── Session.kt             # Session management
├── AppBuilder.kt          # Fluent API for defining modules
├── ModuleInstance.kt      # Runtime module management
├── ObservableState.kt     # Reactive state with change tracking
├── Router.kt              # URL routing interface
├── ManagedRouter.kt       # Router with history management
├── GlobalContext.kt       # Cross-module communication
├── ComponentLoader.kt     # Dynamic component loading
├── ComponentResolver.kt   # Component path resolution
├── ComponentWatcher.kt    # File watching for hot reload
├── Events.kt              # Typed event emitter
├── Types.kt               # Core type definitions
├── ImportTypes.kt         # Import-related types
├── EngineError.kt         # Error types
├── Dsl.kt                 # Kotlin DSL for module definitions
├── Logger.kt              # Structured logging
├── Retry.kt               # Retry with backoff utilities
└── Utils.kt               # Utility functions
```

## Development Commands

```bash
./gradlew test              # Run all tests (includes compatibility tests)
./gradlew build             # Build
```

## Architecture

Same module pattern as all Hypen SDKs:
- **AppBuilder** — fluent API: `app { state { ... } onAction("x") { ... } }`
- **ObservableState** — reactive state with path-based tracking
- **NativeEngine** — WASM engine access via JNA
- **HypenServer** — WebSocket server streaming patches to clients
- **Kotlin DSL** — idiomatic Kotlin builder syntax via `Dsl.kt`

## Key Dependencies

- Kotlin 2.0, kotlinx-coroutines, kotlinx-serialization-json
- JNA 5.14.0 (native engine bindings)
- JUnit 5 (testing)

## Testing

Tests live in `src/test/kotlin/`. The compatibility test runner integrates with `../engine-compatibility-tests/` fixtures to ensure cross-SDK consistency.
