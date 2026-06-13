# CLAUDE.md

This file provides guidance to Claude Code when working with the Hypen Go SDK.

## Project Overview

The Go SDK (`github.com/hypen-space/core`) provides the module system for building Hypen applications in Go. It includes state management, action handling, lifecycle hooks, routing, and a remote UI server — parallel to the TypeScript, Kotlin, and Rust SDKs.

## Module Structure

```
hypen-golang/
├── app.go                # AppBuilder — fluent API for defining modules
├── context.go            # GlobalContext for cross-module communication
├── state.go              # ObservableState — reactive state
├── events.go             # Typed event emitter
├── router.go             # URL routing interface
├── managed_router.go     # Router with history management
├── logger.go             # Structured logging
├── resolver.go           # Component path resolution
├── renderer.go           # Renderer interface
├── loader.go             # Dynamic component loading
├── discovery.go          # Component file discovery
├── errors.go             # Error types
├── doc.go                # Package documentation
├── wasm_engine.go        # WASM engine via Wazero
├── *_test.go             # 13 test files (includes mock_engine_test.go)
└── remote/               # Remote UI protocol
    ├── server.go         # WebSocket server
    ├── client.go         # WebSocket client
    ├── types.go          # Protocol types
    └── remote_test.go    # Remote UI tests
```

## Development Commands

```bash
go test ./...              # Run all tests
go test ./... -v           # Verbose test output
go build ./...             # Build
go doc ./...               # View documentation
```

## Architecture

Same module pattern as all Hypen SDKs:
- **AppBuilder** — fluent API: `app.DefineState(...).OnAction("x", handler).Build()`
- **ObservableState** — reactive state with path-based tracking
- **WasmEngine** — WASM engine access via Wazero runtime
- **Remote Server/Client** — WebSocket-based patch streaming

## Key Dependencies

- Go 1.21+
- `gorilla/websocket` — WebSocket implementation
- `tetratelabs/wazero` — WASM runtime (pure Go, no CGo)

## Testing

Tests use Go's standard testing package. The compatibility test runner in `../engine-compatibility-tests/runners/golang/` runs shared fixtures to ensure cross-SDK consistency.
