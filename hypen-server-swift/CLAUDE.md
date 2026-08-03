# CLAUDE.md

This file provides guidance to Claude Code when working with the Hypen Swift Server SDK.

## Project Overview

The Swift Server SDK (`HypenServer`) provides the module system for building server-driven Hypen applications in Swift. It includes state management, action handling, lifecycle hooks, routing, sessions, events, component discovery, and a WebSocket server — parallel to the TypeScript, Go, Kotlin, and Rust SDKs.

This package also includes the **HypenEngine** UniFFI bindings to the Rust engine, enabling native Hypen DSL parsing and patch generation. The `RemoteServer` uses `NativeEngine` to render Hypen DSL into patches that are streamed to connected clients.

## Module Structure

```text
hypen-server-swift/
├── Package.swift                           # Swift 6 package manifest
├── README.md                              # Full documentation with typed actions samples
├── Sources/
│   ├── hypen_engineFFI/                    # C FFI header for Rust engine (UniFFI)
│   │   ├── hypen_engineFFI.h
│   │   └── module.modulemap
│   ├── HypenEngine/                        # UniFFI-generated Swift bindings
│   │   └── hypen_engine.swift              # Auto-generated — do not edit manually
│   └── HypenServer/
│       ├── HypenServer.swift               # Public exports & version constant
│       ├── NativeEngine.swift              # Engine wrapper (UniFFI → server types)
│       ├── Types.swift                     # Patch, MessageType, AnyCodable, etc.
│       ├── ObservableState.swift           # Reactive state with path-based tracking
│       ├── AppBuilder.swift                # Fluent API + HypenAction + typed/async handlers
│       ├── ModuleInstance.swift            # Runtime module with error handling & session lifecycle
│       ├── Events.swift                    # TypedEventEmitter + framework events
│       ├── Router.swift                    # HypenRouter + RouteDefinition
│       ├── ManagedRouter.swift             # Route-driven module mount/unmount orchestration
│       ├── Session.swift                   # SessionManager with TTL, reconnection, policies
│       ├── GlobalContext.swift             # Cross-module communication hub
│       ├── ComponentLoader.swift           # Component registry + filesystem loading
│       ├── ComponentDiscovery.swift        # Filesystem scanning + file watcher
│       ├── ComponentResolver.swift         # Import resolution (local + URL)
│       ├── Logger.swift                    # Structured logging + pluggable HypenLogHandler
│       └── Remote/
│           ├── RemoteServer.swift          # WebSocket server (NIO + WebSocketKit)
│           └── RemoteEngine.swift          # WebSocket client with auto-reconnect
├── Tests/HypenServerTests/
│   ├── ObservableStateTests.swift          # State management tests
│   ├── AppBuilderTests.swift              # Builder API, typed actions, async, lifecycle
│   ├── EventsTests.swift                  # TypedEventEmitter tests
│   ├── RouterTests.swift                  # Router path matching & navigation
│   ├── ManagedRouterTests.swift           # Route-driven module lifecycle
│   ├── SessionTests.swift                 # Session lifecycle, TTL, reconnection
│   ├── GlobalContextTests.swift           # Cross-module communication tests
│   ├── ComponentTests.swift               # ComponentLoader, import parsing, resolver
│   └── NativeEngineTests.swift            # Engine rendering, state, actions, patches
└── Examples/
    └── CounterExample.swift                # Example modules
```

## Development Commands

The native Rust library must be built before `swift build` or `swift test`:

```bash
# Build the native engine (required first)
cd hypen-engine-rs
cargo build --release --features uniffi

# Then build/test the Swift package (Linux)
# Note: the workspace target dir is hypen-rs/target/release (workspace root), not hypen-engine-rs/target/release.
cd ../hypen-server-swift
LD_LIBRARY_PATH=../target/release LIBRARY_PATH=../target/release swift build
LD_LIBRARY_PATH=../target/release LIBRARY_PATH=../target/release swift test

# macOS uses DYLD_LIBRARY_PATH for runtime, but the linker also needs LIBRARY_PATH
DYLD_LIBRARY_PATH=../target/release LIBRARY_PATH=../target/release swift test

# Or use the convenience script
./build-engine.sh   # builds the Rust library and prints the test command
swift package clean  # Clean
```

## Architecture

Same module pattern as all Hypen SDKs:
- **AppBuilder** — fluent API with typed (`Codable`) and async action handlers
- **HypenAction** — protocol for type-safe action enums
- **ObservableState** — reactive state with path-based tracking
- **ModuleInstance** — runtime module with error handling and session lifecycle
- **TypedEventEmitter** — type-safe event system with `EventKey<T>`
- **HypenRouter** — URL routing with path params, wildcards, query parsing
- **ManagedRouter** — route-driven module mount/unmount orchestration
- **SessionManager** — TTL-based session persistence with concurrent policies
- **GlobalContext** — cross-module communication (dispatch, events, state)
- **ComponentLoader** — component registry with filesystem loading
- **ComponentDiscovery** — filesystem scanning with file watcher for hot reload
- **ComponentResolver** — import resolution from local files and remote URLs
- **RemoteServer** — WebSocket server streaming state/patches to clients
- **RemoteEngine** — WebSocket client with auto-reconnect

## Engine Integration

The `NativeEngine` class wraps the UniFFI-generated `HypenEngine` to provide:
- Hypen DSL parsing → patch generation via `renderSource(_:)`
- Reactive state updates → incremental patches via `updateState(_:)`
- Action dispatch and pending action processing
- Component registration and import resolution

The `RemoteServer` creates a per-client `NativeEngine` instance. On connection, it renders the DSL template into patches sent as the `initialTree`. On state changes, it calls `updateState()` to produce incremental patches.

To regenerate bindings after engine changes:
```bash
./scripts/generate-bindings.sh
```

## Transport: no WebSocket compression

`RemoteServer` does **not** negotiate RFC 7692 `permessage-deflate`, unlike the
other Hypen server SDKs, and `ServerConfig` has no `compression` option as a
result. `NIOWebSocketServerUpgrader` never reads or echoes
`Sec-WebSocket-Extensions`, and WebSocketKit has no compression support
(vapor/websocket-kit#55, open since 2020). The maintained Swift RFC 7692
implementation (`WSCompression` in hummingbird-project/swift-websocket) is
bound to that package's own `WSCore` upgrade stack and cannot be spliced into
this pipeline.

This is protocol-safe: clients offering the extension get a 101 that does not
accept it and fall back to uncompressed frames. **Do not make `shouldUpgrade`
echo the extension header without also installing a compressor/decompressor** —
accepting an unimplemented extension breaks clients hard. See the comment block
at the upgrader site in `Sources/HypenServer/Remote/RemoteServer.swift` and the
Compression section in `README.md`.

## Key Dependencies

- Swift 6.0+
- Rust `libhypen_engine` (built with `--features uniffi`)
- WebSocketKit (Vapor's NIO-based WebSocket)
- SwiftNIO (async networking)

## Testing

Tests use XCTest. Requires native Rust library (see Development Commands above). Tests cover:
- ObservableState (get/set/nested/replace/onChange)
- AppBuilder (untyped, typed Codable payloads, async, lifecycle hooks)
- ModuleInstance (dispatch, bind, destroy, session lifecycle)
- TypedEventEmitter (on/once/emit/unsubscribe)
- HypenRouter (push/replace/back/matchPath/params/query)
- ManagedRouter (mount/unmount/persist/inline)
- SessionManager (create/suspend/resume/expire/stats)
- GlobalContext (register/dispatch/events/global state)
- ComponentLoader (register/get/names/clear)
- Import parsing (named/default/URL/multiple)
- ComponentResolver (registry lookup/cache)
- NativeEngine (DSL rendering, state updates, actions, components, patch format)
