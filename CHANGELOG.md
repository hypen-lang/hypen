# Changelog

All notable changes to Hypen will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Animation API (Layers 1–2)** — Portable `.transition()`, `.enter()`, `.exit()`, and `.layout()` applicators. The engine lowers each into a reserved `__anim.*` prop carrying one JSON object (vocabulary: curves `linear|easeIn|easeOut|easeInOut|spring`, presets `fade|slide|scale`, directions `top|bottom|leading|trailing`) and filters `.transition(props: [...])` against a cross-renderer animatable whitelist. Exit animations are enabled by a new optional `transition: true` flag on the `Remove` patch: the flagged subtree root is emitted before its descendants' plain Removes so renderers can play the exit and defer teardown; the field is omitted when false, keeping the wire format unchanged for existing renderers. The DOM renderer implements all four channels (CSS transitions, enter/exit presets, FLIP layout moves, reduced-motion snapping, inert exiting subtrees); native renderers ignore the new props/flag and snap (Canvas parity landed separately — see below). See `hypen-web/docs/animation.md`.
- **`.animate()` preset timelines** — Built-in looping/one-shot keyframe presets `pulse`, `spin`, `shimmer`, and `shake` via a fifth animation applicator: `.animate(spin)`, `.animate(pulse, duration: 800, repeat: 3, curve: easeInOut)`. The first positional token names the preset; `duration:`/`delay:` (ms), `repeat:` (`loop` or a positive integer), and `curve:` are named-only modifiers with per-preset defaults filled by the engine. Lowered to the `__anim.animate` prop (`{"preset","duration","repeat","curve"}` plus `"delay"` when given); an unknown preset warns and omits the animation, every other invalid argument falls back to the preset's default. The DOM renderer plays presets via one injected stylesheet (CSS `@keyframes` + per-node CSS custom properties; `shimmer` is a gradient `::after` overlay) and reduced motion disables playback; other renderers ignore the prop and show the node static. Author-defined `animation { }` blocks and a `when:` trigger are deferred — a preset inside an `If` plays when the node enters. See `hypen-web/docs/animation.md`.
- **Canvas renderer animation parity** — The Canvas 2D renderer now plays the `__anim.*` animation channels instead of snapping, via a per-frame numeric ticker (`CanvasAnimator`, `hypen-web/packages/web/src/canvas/anim.ts`) driven by the renderer's own coalescing redraw loop (the engine never ticks; the ticker stands down when the last animation settles). Interpolated values are written into the real node props before layout and hit-testing each frame, and layout-affecting props (width/height/gap/fontSize/padding/margin/borderColor) re-solve layout per tick, so hit targets follow the animated geometry. Supported: `.transition` on numeric whitelist props plus RGBA color interpolation (`color`/`backgroundColor`/`borderColor`; hex, `rgb()`/`rgba()`, basic named colors) with seamless mid-flight retargeting; `.enter` `fade`/`slide`/`scale` (RTL-aware, first-batch and cached-route suppression as on DOM); `.exit` with deferred teardown, immediate hit-test and scroll-target exclusion of the exiting subtree, and finalize on settle or a `duration + delay + 80ms` timeout backbone; `.animate` `pulse`/`spin`/`shake` with DOM-matching keyframe shapes (finite repeats never replay on a cached re-attach). Easing shares the DOM renderer's numeric curve layer, so both renderers trace identical curves. Deliberate canvas snaps: `.layout` FLIP moves (a transform FLIP would desync hit-testing from painted position), `cornerRadius` transitions (canvas paint reads `borderRadius`), and `shimmer` (DOM-only gradient overlay). Reduced motion (live `matchMedia`) snaps everything including immediate exit finalize; unknown or malformed specs are silent no-ops. See the Canvas capability matrix in `hypen-web/docs/animation.md`.

### Deprecated
- The web-only CSS string form `.transition("opacity 0.3s ease")`. It still works on the DOM renderer but logs a deprecation warning; use the portable `.transition(duration:, curve:, props:)` form instead.

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
