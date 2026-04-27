# Architecture

This is a short, current repo-level overview of Hypen.

For engine internals such as IR lowering, reconciliation, and dependency tracking, see [hypen-engine-rs/docs/architecture.md](hypen-engine-rs/docs/architecture.md).

## High-Level Flow

```text
Hypen DSL -> Parser -> Engine -> Patches -> Renderer
                     ^
                     |
              SDK state + actions
```

The parser turns Hypen source into an AST. The engine lowers that into its internal representation, resolves bindings against state, and emits renderer-agnostic patches. SDKs and renderers handle the platform-specific parts around that core.

## Main Pieces

- `parser/`: Hypen parser
- `hypen-engine-rs/`: shared core engine and bindings
- `hypen-sdk-rs/`: Rust SDK
- `hypen-web/`: TypeScript/Bun packages for core runtime, server runtime, browser engine, and web renderers
- `hypen-cli/`: CLI and studio tooling
- `hypen-kotlin/`: Kotlin SDK
- `hypen-server-swift/`: Swift server SDK
- `hypen-renderer-swift/`: SwiftUI renderer
- `hypen-renderer-android/`: Android renderer
- `hypen-golang/`: Go SDK
- `hypen-lsp/`: language server
- `hypen-docs/`: docs site
- `engine-compatibility-tests/`: cross-SDK compatibility tests

## Shared Engine Model

Hypen uses a shared-engine model for multi-module applications.

- A session or app uses one engine instance.
- Modules register namespaced state inside that shared engine.
- Nesting modules is expected.
- Parent and child modules share the engine while keeping separate state scopes.

This is the core composition model across SDKs. The SDK layer manages module lifecycle and action routing; the engine operates on the merged state tree plus the rendered templates.

## SDK Layer

The SDKs provide:

- module definitions
- lifecycle hooks
- action dispatch
- routing integration
- component discovery and host ergonomics

The engine remains shared; the SDK decides how state is created, updated, and exposed to user code in each language.

## Renderers

Renderers consume the same patch protocol and apply it to a platform target.

Current renderers include:

- DOM and Canvas in `hypen-web/packages/web/`
- SwiftUI in `hypen-renderer-swift/`
- Android Compose in `hypen-renderer-android/`

## Scope Of This File

This file is intentionally brief and repo-focused. If it drifts, prefer code and package-level docs as the source of truth and update this file to match.
