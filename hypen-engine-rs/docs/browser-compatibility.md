# Browser & Platform Compatibility

## WASM Engine Compatibility

The Hypen Engine compiles to WebAssembly and runs in any environment that supports WASM.

### Browser Support

| Browser | Version | Support | Notes |
|---------|---------|---------|-------|
| Chrome | 57+ | Full | Includes Chrome for Android |
| Firefox | 52+ | Full | |
| Safari | 11+ | Full | Includes iOS Safari |
| Edge | 16+ | Full | Chromium-based Edge: 79+ |
| Samsung Internet | 7.2+ | Full | |
| Opera | 44+ | Full | |
| IE 11 | — | None | WebAssembly not supported |

### JavaScript Runtime Support

| Runtime | Version | WASM Target | Notes |
|---------|---------|-------------|-------|
| Node.js | 8+ | `nodejs` | Use `pkg/nodejs/` build |
| Bun | 1.0+ | `nodejs` | Compatible with Node.js target |
| Deno | 1.0+ | `web` | Use `pkg/web/` build |

### WASM Build Targets

| Target | Output Dir | Use Case | Module Format |
|--------|-----------|----------|---------------|
| `bundler` | `pkg/bundler/` | Webpack, Vite, Rollup | ES Module |
| `nodejs` | `pkg/nodejs/` | Node.js, Bun | CommonJS |
| `web` | `pkg/web/` | Vanilla HTML/JS, Deno | ES Module + init() |

### Build Size

| Build | Size | Notes |
|-------|------|-------|
| Optimized WASM | ~300 KB | `opt-level = "z"`, LTO, single codegen unit |
| Gzipped | ~100 KB | Typical gzip compression |

## Web SDK Compatibility

The `@hypen-space/web` renderer targets modern browsers with standard DOM APIs.

### Required Web APIs

| API | Used For | Fallback |
|-----|----------|----------|
| `document.createElement` | DOM renderer | Required |
| `Element.insertBefore` | Patch application | Required |
| `EventTarget.addEventListener` | Event handling | Required |
| `Proxy` | State management (SDK) | Required (no polyfill) |
| `Canvas 2D Context` | Canvas renderer | Only if using Canvas renderer |
| `WebSocket` | Remote UI | Only if using Remote UI |
| `requestAnimationFrame` | Batched rendering | `setTimeout` fallback |
| `MutationObserver` | Dev tools integration | Optional |
| `Performance.now()` | Timing/telemetry | Optional |

### CSS Feature Requirements

The DOM renderer generates standard CSS properties. Feature requirements depend on which applicators you use:

| CSS Feature | Applicators | Browser Support |
|-------------|-------------|-----------------|
| Flexbox | `Column`, `Row`, `weight`, `flexGrow` | All modern browsers |
| CSS Grid | `Grid` component | Chrome 57+, Firefox 52+, Safari 10.1+ |
| Custom Properties | Theme variables | Chrome 49+, Firefox 31+, Safari 9.1+ |
| `gap` (flexbox) | `.gap()` applicator | Chrome 84+, Firefox 63+, Safari 14.1+ |
| `aspect-ratio` | `.aspectRatio()` | Chrome 88+, Firefox 89+, Safari 15+ |
| `overflow: clip` | `.overflow("clip")` | Chrome 90+, Firefox 81+, Safari 16+ |

## Native Platform Support

### iOS (SwiftUI)

| Platform | Version | Renderer |
|----------|---------|----------|
| iOS | 15+ | SwiftUI views |
| macOS | 12+ | SwiftUI views |
| iPadOS | 15+ | SwiftUI views |

Integration: WASM via WebView or native WASM runtime. UniFFI bindings planned.

### Android (Kotlin)

| Platform | Version | Renderer |
|----------|---------|----------|
| Android | API 24+ (7.0) | Compose / View system |

Integration: Kotlin DSL module system (`hypen-kotlin/`). WASM via WebView or WasmEdge.

### Go

| Runtime | Renderer |
|---------|----------|
| Go 1.19+ | Module system only (no renderer) |

Integration: Module system via `hypen-golang/`. Used for server-side module logic.

## Remote UI Compatibility

The Remote UI protocol works over any bidirectional transport:

| Transport | Support | Notes |
|-----------|---------|-------|
| WebSocket | Full | Primary transport |
| MessageChannel | Full | Same-origin iframe/worker communication |
| TCP/Unix socket | Full | Server-to-server |
| HTTP SSE + POST | Partial | Server→client via SSE, client→server via POST |

### Message Format

All messages are JSON-encoded. No binary protocol support currently.

## Development Environment

### Required Tooling

| Tool | Version | Purpose |
|------|---------|---------|
| Rust | 1.70+ | Engine compilation |
| wasm-pack | Latest | WASM build |
| Bun | 1.0+ | TypeScript SDK development |
| Node.js | 18+ | npm compatibility (optional) |

### Optional Tooling

| Tool | Purpose |
|------|---------|
| `cargo-watch` | Auto-rebuild on file changes |
| `wasm-opt` | Additional WASM size optimization |
| `clippy` | Rust linting |

## Known Limitations

1. **No IE 11 support** — WebAssembly is a hard requirement
2. **Proxy required** — The TypeScript SDK's state management relies on `Proxy`, which cannot be polyfilled
3. **No SSR hydration** — Server-side rendering is not yet supported; use Remote UI protocol for server-driven UI
4. **Single-threaded engine** — The WASM engine runs on the main thread; `SharedArrayBuffer` support is planned for worker offloading
5. **No streaming WASM instantiation on Node.js** — Full module must be loaded before instantiation
