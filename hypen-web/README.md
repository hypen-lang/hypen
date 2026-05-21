# hypen-web

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.0+-f9f1e1?logo=bun)](https://bun.sh/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)

Hypen SDK for TypeScript/Bun - A declarative UI framework with stateful modules.

## Overview

Hypen separates UI and state:
- **Components** — purely declarative, stateless UI definitions (Hypen DSL)
- **Modules** — stateful controllers that hold data, react to lifecycle events, and expose named actions

This package provides the TypeScript/Bun SDK that wraps the Hypen engine (Rust/WASM) and implements the module system from RFC-0001.

## Installation

```bash
bun add @hypen-space/core @hypen-space/web @hypen-space/web-engine
```

## Quick Start

### 1. Define a Module

```typescript
import { app } from "@hypen-space/core";

type CounterState = {
  count: number;
};

const counterModule = app
  .defineState<CounterState>({ count: 0 })
  .onCreated(async (state, context) => {
    console.log("Counter created");
  })
  .onAction("increment", async ({ state }) => {
    state.count++;
  })
  .build();
```

### 2. Define UI in Hypen DSL

```hypen
Column {
  Text("Count: @{state.count}")
  Button("@actions.increment") { Text("+1") }
}
```

### 3. Wire Everything Together

**Option A: DOM Renderer** (standard web apps)

```typescript
import { HypenModuleInstance } from "@hypen-space/core";
import { Engine } from "@hypen-space/web-engine";
import { DOMRenderer } from "@hypen-space/web";

const engine = new Engine();
await engine.init();

// Set up DOM renderer
const renderer = new DOMRenderer(document.body, engine);
engine.setRenderCallback((patches) => {
  renderer.applyPatches(patches);
});

// Create module instance
const instance = new HypenModuleInstance(engine, counterModule);

// Render UI
const ui = `Column { Text("Count: @{state.count}") }`;
engine.renderSource(ui);
```

**Option B: Canvas Renderer** (high performance, game-like UIs)

```typescript
import { HypenModuleInstance } from "@hypen-space/core";
import { Engine } from "@hypen-space/web-engine";
import { CanvasRenderer } from "@hypen-space/web/canvas";

const engine = new Engine();
await engine.init();

// Set up canvas renderer
const canvas = document.getElementById("app");
const renderer = new CanvasRenderer(canvas, engine);
engine.setRenderCallback((patches) => {
  renderer.applyPatches(patches);
});

// Create module instance
const instance = new HypenModuleInstance(engine, counterModule);

// Render UI
const ui = `Column { Text("Count: @{state.count}") }`;
engine.renderSource(ui);
```

**Option C: Remote Server** (stream UI over WebSocket to Web, Android, iOS)

This is the recommended approach for cross-platform apps. Your server runs the WASM engine and streams UI patches to any client.

**Server (Bun/Node.js):**

```typescript
import { HypenApp } from "@hypen-space/core";
import { RemoteServer } from "@hypen-space/server";

// Define modules on a HypenApp registry.
const myApp = new HypenApp();

myApp.module("Counter")
  .defineState({ count: 0 })
  .onAction("increment", async ({ state }) => { state.count++; })
  .ui(`
    Column {
      Text("Count: @{state.count}")
      Button { Text("+") }
        .onClick("@actions.increment")
    }
  `)
  .build();

// Serve the whole app — every registered module is streamed over the same WebSocket.
new RemoteServer().app(myApp).listen(3000);

// Clients connect to ws://localhost:3000
```

> For a single-module demo you can skip `HypenApp` and chain `.module(name, def).ui(template)` directly on `RemoteServer`.

**Web Client - Embed with HypenApp:**

```hypen
// Embed a remote Hypen app in your UI
Column {
  Text("My Website")
  HypenApp("ws://localhost:3000")
}
```

Or connect programmatically:

```typescript
import { RemoteEngine } from "@hypen-space/core";
import { DOMRenderer } from "@hypen-space/web";

const engine = new RemoteEngine("ws://localhost:3000");
const renderer = new DOMRenderer(document.body);

engine.onPatches((patches) => renderer.applyPatches(patches));
await engine.connect();
```

**Android Client:**

```kotlin
// In your Jetpack Compose UI
HypenApp("ws://10.0.2.2:3000")  // Use 10.0.2.2 for emulator
```

See [examples/remote/README.md](./examples/remote/README.md) for full documentation.

## Architecture

### Local Rendering

```
┌─────────────────────────────────────────────────────┐
│  @hypen-space/core (TypeScript SDK)                       │
├─────────────────────────────────────────────────────┤
│  • app() builder API for modules                    │
│  • Engine wrapper (TypeScript → WASM)               │
│  • Renderer abstraction (DOM, Canvas, etc.)         │
│  • Module lifecycle management                      │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│  hypen-engine-rs (Rust/WASM)                        │
├─────────────────────────────────────────────────────┤
│  • Parser (Hypen DSL → AST)                         │
│  • Reactive system (dependency tracking)            │
│  • Reconciler (diffing & patch generation)          │
│  • Action dispatcher                                │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│  Platform Renderer                                  │
│  • DOMRenderer - Standard HTML/CSS                  │
│  • CanvasRenderer - Canvas 2D API                   │
└─────────────────────────────────────────────────────┘
```

### Remote Rendering (Cross-Platform)

```
┌─────────────────────────────────────────────────────┐
│  Server (Bun/Node.js)                               │
├─────────────────────────────────────────────────────┤
│  RemoteServer                                       │
│  • Runs WASM engine                                 │
│  • Manages module state                             │
│  • Streams patches over WebSocket                   │
└─────────────────────────────────────────────────────┘
                      ↓ WebSocket
┌─────────────────────────────────────────────────────┐
│  Clients                                            │
├─────────────────────────────────────────────────────┤
│  Web: HypenApp component + DOMRenderer              │
│  Android: HypenApp composable + ComposeRenderer     │
│  iOS: HypenApp view + SwiftUI renderer              │
└─────────────────────────────────────────────────────┘
```

## API Reference

### `app.defineState<T>(initial, options?)`

Creates a new module builder with initial state.

**Options:**
- `persist?: boolean` - Enable state persistence
- `version?: number` - Schema version for migrations
- `name?: string` - Module name

**Returns:** `HypenAppBuilder<T>`

### `HypenAppBuilder`

**Methods:**
- `.onCreated(handler)` - Called once when module is created
- `.onAction(name, handler)` - Register handler for specific action
- `.onDestroyed(handler)` - Called when module is destroyed
- `.build()` - Build the module definition

### `Engine`

**Methods:**
- `async init()` - Initialize WASM engine
- `setRenderCallback(callback)` - Set patch callback
- `renderSource(source)` - Parse and render Hypen DSL
- `updateState(patch)` - Update state (triggers re-render)
- `dispatchAction(name, payload?)` - Dispatch action
- `onAction(name, handler)` - Register action handler

### `Renderer`

**Interface:**
- `applyPatches(patches)` - Apply patches to render tree

**Built-in Renderers:**
- `DOMRenderer` - Renders to DOM (import from `@hypen-space/web`)
- `CanvasRenderer` - Renders to Canvas 2D (import from `@hypen-space/web/canvas`)
- `ConsoleRenderer` - Logs patches to console (for debugging)

## Examples

See the `examples/` directory:
- `simple-counter.ts` - Basic counter with increment/decrement
- `canvas-counter.ts` - Counter rendered on Canvas
- `profile-page.ts` - User profile from RFC-0001 spec

Run examples:
```bash
# DOM renderer examples
bun run example

# Canvas renderer examples
bun run example:canvas
```

## Development

### Build WASM Engine

```bash
bun run build
```

This compiles the Rust engine to WASM and generates TypeScript bindings.

### Project Structure

```
hypen-web/
├── packages/
│   ├── core/            # @hypen-space/core
│   ├── web/             # @hypen-space/web
│   ├── server/          # @hypen-space/server
│   └── web-engine/      # @hypen-space/web-engine
├── examples/            # TS examples and remote demos
├── playground/          # Local web playground
└── package.json         # Workspace root
```

## Features

✅ **Reactive State** - Direct mutations trigger re-renders
✅ **Named Actions** - Simple event system
✅ **Lifecycle Hooks** - onCreated, onAction, onDestroyed
✅ **Type-Safe** - Full TypeScript support
✅ **Pluggable Renderers** - DOM, Canvas, Native, etc.
✅ **WASM-Powered** - Fast engine written in Rust
✅ **Canvas Mode** - High-performance canvas rendering for game-like UIs
✅ **Remote Streaming** - Stream UI over WebSocket to any platform
✅ **Cross-Platform** - One codebase for Web, Android, and iOS

## Hypen DSL Syntax

### State Bindings
```hypen
Text("Hello, @{state.user.name}")
```

### Actions
```hypen
Button("@actions.signIn") { Text("Sign In") }
```

### Layout
```hypen
Column {
  Row { Text("Left") Text("Right") }
  Text("Bottom")
}
```

## Contributing

This is part of the Hypen project. See the main repository for contribution guidelines.

## License

MIT
