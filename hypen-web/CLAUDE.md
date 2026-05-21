# CLAUDE.md

This file provides guidance to Claude Code when working with the hypen-web SDK.

## Project Overview

hypen-web is a Bun workspace containing the TypeScript SDK for Hypen. It wraps the Rust/WASM engine and provides platform-agnostic runtime APIs plus browser-specific renderers (DOM and Canvas).

## Workspace Structure

```
hypen-web/
├── packages/
│   ├── core/                    # @hypen-space/core - Platform-agnostic runtime (NO WASM)
│   │   └── src/
│   │       ├── app.ts           # HypenAppBuilder - fluent API for modules
│   │       ├── state.ts         # Proxy-based observable state
│   │       ├── router.ts        # HypenRouter (hash/pathname routing)
│   │       ├── managed-router.ts # ManagedRouter (route-based module lifecycle)
│   │       ├── context.ts       # Global context for cross-module comms
│   │       ├── resolver.ts      # Component path resolution
│   │       ├── datasource.ts    # Data source plugin system
│   │       ├── events.ts        # Typed event emitter
│   │       ├── result.ts        # Result type (Ok/Err pattern)
│   │       ├── retry.ts         # Retry with exponential backoff
│   │       ├── disposable.ts    # Resource cleanup pattern
│   │       ├── logger.ts        # Structured logging
│   │       ├── renderer.ts      # BaseRenderer abstract class
│   │       ├── types.ts         # Shared types (Patch, Action, etc.)
│   │       ├── remote/          # Remote UI protocol (client only)
│   │       │   ├── client.ts    # RemoteEngine client
│   │       │   └── session.ts   # Session management
│   │       └── components/
│   │           └── builtin.ts   # Built-in Router/Route/Link
│   │
│   ├── web/                     # @hypen-space/web - Browser renderers (pure patch consumers)
│   │   └── src/
│   │       ├── dom/             # DOM renderer
│   │       │   ├── renderer.ts  # DOMRenderer - applies patches to DOM
│   │       │   ├── components/  # 33 component handlers
│   │       │   ├── applicators/ # 15 style applicators
│   │       │   ├── events.ts    # Event attachment/delegation
│   │       │   └── debug.ts     # Debug heatmap visualization
│   │       └── canvas/          # Canvas 2D renderer
│   │           ├── renderer.ts  # CanvasRenderer
│   │           ├── layout.ts    # Flexbox layout engine
│   │           ├── paint.ts     # Canvas 2D drawing
│   │           ├── text.ts      # Text measurement/rendering
│   │           └── events.ts    # Hit testing
│   │
│   ├── web-engine/              # @hypen-space/web-engine - Browser SPA engine
│   │   └── src/
│   │       ├── engine.ts        # Browser WASM wrapper (CDN/self-hosted)
│   │       ├── hypen.ts         # Hypen orchestrator class
│   │       └── index.ts         # Barrel exports
│   │
│   └── server/                  # @hypen-space/server - Node.js server engine
│       └── src/
│           ├── engine.ts        # Node.js WASM wrapper
│           ├── loader.ts        # Dynamic component loader
│           ├── discovery.ts     # Component file discovery
│           ├── plugin.ts        # Bun plugin for .hypen imports
│           ├── remote/
│           │   └── server.ts    # RemoteServer (WebSocket streaming)
│           └── index.ts         # Barrel exports
│
├── tests/                       # Bun test suite (30+ files)
├── playground/                  # Interactive dev playground
├── examples/                    # Runnable examples
└── docs/                        # SDK documentation
```

## Package Dependencies

```
core (no WASM, platform-agnostic)
  ↑              ↑
  │              │
web (renderers)  server (Node.js WASM + loader + discovery + remote server)
  ↑              │
  │              │
web-engine (Browser WASM + Hypen orchestrator)
  depends on: core + web
```

## Development Commands

```bash
# Testing
bun test                          # Run all tests
bun test tests/app.test.ts        # Single test file

# Building
bun run build                     # Build all packages (ordered: core → web → server → web-engine)
bun run build:core                # Build @hypen-space/core only
bun run build:web                 # Build @hypen-space/web only
bun run build:server              # Build @hypen-space/server only
bun run build:web-engine          # Build @hypen-space/web-engine only
bun run build:wasm                # Rebuild WASM from Rust + setup
bun run typecheck                 # TypeScript type checking

# Development
bun run playground                # Interactive playground (port 3000)
bun run replayground              # Rebuild WASM + restart playground

# Examples
bun run example                   # DOM counter
bun run example:canvas            # Canvas counter
bun run example:remote-server     # Remote server
```

## Architecture

### Data Flow

```
Hypen DSL (string)
  → Engine.renderSource() (Rust/WASM parser)
  → AST → IR + Reactive System
  → Patches (minimal deltas)
  → Renderer.applyPatches()
  → DOM or Canvas output
```

### Key Patterns

- **Observable State**: Proxy-based mutation tracking. Direct assignment (`state.count++`) auto-propagates — no `setState()` needed.
- **Sparse Updates**: Only changed state paths sent to engine via `updateStateSparse(scope, paths, values)`. Empty `scope` targets the primary module slot; non-empty `scope` targets a named nested module.
- **Patch-Based Rendering**: Engine emits Create/SetProp/RemoveProp/SetText/Insert/Move/Remove patches, plus Detach/Attach for Router subtree caching (off-screen routes stay alive under the same NodeId; re-entry emits `Attach` instead of `Create`, preserving DOM scroll/focus/form state for free). All renderers (DOM, Canvas, iOS, Android) consume the same format.
- **Route-Level Persistence**: `ManagedRouter` keeps module instances alive across navigation by default (opt out via `persist: false` on the module definition), and the engine's Router IR node caches detached route subtrees under the same `NodeId`s (LRU, default cap 10). Navigating back to a visited route fires `onActivated` (not `onCreated`) at the SDK layer and emits `Attach` patches (not `Create`) at the engine layer — no loading flash, no DOM rebuild. Both caches are bounded: `ManagedRouter` evicts the least-recently-persisted module past `maxPersistedModules` (default 10, matches the engine's `DEFAULT_ROUTER_CACHE_SIZE`) via the same `destroy() + unregisterModule()` path `persist: false` uses, so a long session over many routes cannot leak module instances indefinitely.
- **Module Scoping**: Each Engine instance binds to one active module. Cross-module comms use prop passing, actions, or GlobalContext.
- **Component Discovery**: Auto-scans directories for `.hypen` + `.ts` file pairs (server package only). Supports folder/sibling/index naming patterns.

### WASM Integration

WASM is built in `../hypen-engine-rs/` and copied to `packages/server/wasm-node/` and `packages/web-engine/wasm-browser/` during build. The build scripts handle this automatically.

### Package Separation

- **core**: Pure TypeScript, no WASM. Contains types, app builder, state proxy, router, context, events, result types, logger. Used by all other packages.
- **web**: Pure renderer package. Consumes patches and applies them to DOM or Canvas. No knowledge of where patches come from.
- **server**: Node.js WASM engine wrapper + server-side utilities (component discovery, loader, Bun plugin, RemoteServer for WebSocket streaming).
- **web-engine**: Browser WASM engine wrapper + Hypen orchestrator class that ties engine + renderer together for browser SPAs.

## Testing

Uses Bun's native test runner. Key test categories:
- Engine: `engine.test.ts` (server), `engine.browser.test.ts` (web-engine)
- Modules: `app.test.ts`, `action-handler.test.ts`
- State: `state.test.ts`, `variant-handling.test.ts`
- Router: `router.history.test.ts`, `router.lazy.test.ts`
- Canvas: `canvas-renderer.test.ts`, `canvas-integration.test.ts`
- Remote: `remote-server.test.ts`, `session.test.ts`

Common patterns: `FakeEngine` mock for unit tests, `flushMicrotasks()` for async sequencing, JSDOM for DOM renderer tests.

## Tooling

- **Bun** for everything — runtime, test runner, bundler, package manager
- Use `bun` instead of `node`/`npm`/`pnpm`
- Use `bun:test` instead of `jest`/`vitest`
- Bun auto-loads `.env` files
