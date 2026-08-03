# Changelog

All notable changes to Hypen will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- **BREAKING:** Removed `IconPack` and all `icons*` registration methods across every SDK. Use `resources(map)` / `resourcesDir(dir)` / `resourcesFile(path)` instead. The Rust engine now owns all SVG parsing; SDKs pass raw SVG strings through `registerResources`. The `@hypen-space/icons-lucide` package, per-SDK SVG parsers, and the UniFFI/WASM/WASI `registerIconPack` / `parse_svg_to_json` / `load_icons_from_dir` entry points have all been removed. The `Icon("name")` / `Icon(@resources.name)` DSL syntax is unchanged.

## [0.4.42] - 2026-03-25

Initial public alpha release of the Hypen cross-platform UI language and engine.

### Added
- **Hypen DSL** — Declarative UI language with components, applicators, modules, state bindings (`@{state.*}`), action dispatching (`@actions.*`), two-way binding (`.bind(@state.*)`) for form elements, and control flow (`ForEach`, `When`, `If`)
- **Parser** — Rust-based parser built on Chumsky combinators, supporting string escaping, nested block comments, arbitrary values, and Tailwind shorthand classes
- **Core Engine** — Rust reactive engine compiled to WASM with IR expansion, path-based dependency tracking, keyed reconciliation/diffing, and minimal patch output
- **Web SDK** — TypeScript packages: `@hypen-space/core` (platform-agnostic runtime with Proxy-based reactive state, router, module system), `@hypen-space/web` (DOM and Canvas renderers), `@hypen-space/server` (Node.js WASM engine, component loader, discovery, RemoteServer), `@hypen-space/web-engine` (browser WASM engine and Hypen orchestrator)
- **CLI** (`@hypen-space/cli`) — `hypen init`, `hypen dev` (hot reload), `hypen build`, and `hypen studio` (preview studio) commands
- **iOS/macOS renderer** (`hypen-swift`) — SwiftUI native renderer with UniFFI bindings
- **Android renderer** (`hypen-renderer-android`) — Jetpack Compose native renderer
- **Kotlin/JVM SDK** (`hypen-kotlin`) — Server-side engine SDK with Kotlin DSL for module definitions
- **Go SDK** (`hypen-golang`) — Server-side engine SDK with Go module system
- **LSP** (`hypen-lsp`) — Language Server Protocol implementation with diagnostics, completion, hover, and formatting
- **Tailwind CSS parser** (`tailwind-parse`) — Rust-based Tailwind class parser for shorthand styling in Hypen components
- **Renderer-agnostic patch protocol** — Unified `Patch` format (Create, SetProp, SetText, Insert, Move, Remove) consumed by all platform renderers
- **Cross-SDK compatibility test suite** — Engine compatibility tests covering Rust, TypeScript, Kotlin, and Go SDKs
- **Component gallery server** — Cross-platform screenshot testing infrastructure
- **Documentation site** — Fumadocs/Next.js docs at docs.hypen.space
- **Example projects** — Including an Instagram clone example with multi-server backends (TypeScript, Kotlin, Go, Rust, Swift)

### Known Limitations
- Canvas renderer is experimental (layout and text features incomplete)
- LSP uses regex-based parser fallback (WASM integration pending)
- `delete` and `in` operators are not reliably tracked by the Proxy-based state system in the TypeScript SDK
- This is an alpha release; APIs may change in future versions
