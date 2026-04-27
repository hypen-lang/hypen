# @hypen-space/server

Server runtime for Hypen - Node.js/Bun WASM engine, component discovery, loader, and remote server for streaming UI over WebSocket.

## Installation

```bash
npm install @hypen-space/core @hypen-space/server
# or
bun add @hypen-space/core @hypen-space/server
```

## Quick Start

Most apps don't touch `Engine` directly — define modules on a `HypenApp` registry, then serve the whole app with `RemoteServer`:

```typescript
import { HypenApp } from "@hypen-space/core";
import { RemoteServer } from "@hypen-space/server/remote";

const myApp = new HypenApp();

myApp.module("Counter")
  .defineState<{ count: number }>({ count: 0 })
  .onAction("increment", ({ state }) => { state.count += 1; })
  .onAction<{ amount: number }>("add", ({ action, state }) => {
    state.count += action.payload.amount;
  })
  .ui(`
    Column {
      Text("Count: @{state.count}")
      Button("@actions.increment") { Text("+") }
    }
  `)
  .build();

new RemoteServer().app(myApp).listen(3000);
```

State mutations are tracked via a Proxy — just assign fields; no reducers, no dispatchers. Every module defined on the `HypenApp` auto-registers under its name and is streamed over the same WebSocket.

> **Single-module demo?** For a one-off counter with no routing or nesting, you can skip `HypenApp` and call `.module(name, def).ui(template)` directly on `RemoteServer`. Prefer `HypenApp` once you have more than one module or want the registry to drive routing/nesting.

### Lifecycle & Session Hooks

```typescript
const counter = app
  .defineState<{ count: number }>({ count: 0 })
  .onCreated(({ state }) => {
    console.log("counter created", state.count);
  })
  .onDestroyed(({ state }) => {
    console.log("counter destroyed", state.count);
  })
  .onDisconnect(({ state, session }) => {
    console.log(`session ${session.id} disconnected, count=${state.count}`);
  })
  .onReconnect(({ session, restore }) => {
    restore({ count: 42 });
  })
  .onExpire(({ session }) => {
    console.log(`session ${session.id} expired`);
  })
  .build();
```

Session hooks fire when a client drops, reconnects within the configured TTL, or lets the session expire. Configure TTL + concurrency policy via `RemoteServer.session({ ttl, concurrent })`.

### Low-level engine

If you need direct engine access (custom transports, testing), import `Engine` from the package entry:

```typescript
import { Engine } from "@hypen-space/server";

const engine = new Engine();
await engine.init();
engine.setRenderCallback((patches) => { /* ... */ });
engine.renderSource(`Column { Text("Hello") }`);
```

## Component Discovery

Auto-discover `.hypen` components and their `.ts` modules from the filesystem:

```typescript
import { discoverComponents, loadDiscoveredComponents, watchComponents } from "@hypen-space/server";

// Discover all components in a directory
const components = await discoverComponents("./src/components");
const loaded = await loadDiscoveredComponents(components);

// Watch for changes (hot reload)
const watcher = watchComponents("./src/components", {
  onUpdate: (c) => console.log("Updated:", c.name),
});
```

Supported file patterns:

```
Counter/
├── component.hypen    # Template
└── component.ts       # Module

Counter.hypen          # Sibling files
Counter.ts

Counter/
├── index.hypen        # Index-based
└── index.ts
```

## Component Loader

Register and manage components programmatically:

```typescript
import { ComponentLoader, componentLoader } from "@hypen-space/server";

// Global loader
componentLoader.register("Counter", counterModule, counterTemplate);
componentLoader.get("Counter");
componentLoader.has("Counter");

// Or create your own instance
const loader = new ComponentLoader();
await loader.loadFromComponentsDir("./src/components");
```

## Remote Server

`RemoteServer` streams server-driven UI over WebSocket. The primary entry point is `.app(hypenApp)` — attach a `HypenApp` (one or many named modules), add session config, and call `.listen(port)`:

```typescript
import { HypenApp } from "@hypen-space/core";
import { RemoteServer } from "@hypen-space/server/remote";

const myApp = new HypenApp();

myApp.module("Counter")
  .defineState({ count: 0 })
  .onAction("increment", ({ state }) => state.count++)
  .ui(`Column { Text("Count: @{state.count}") Button("@actions.increment") { Text("+") } }`)
  .build();

const server = new RemoteServer()
  .app(myApp)
  .session({ ttl: 300, concurrent: "kick-old" })
  .onConnection((client) => console.log(`connected: ${client.id}`))
  .onDisconnection((client) => console.log(`disconnected: ${client.id}`))
  .listen(3000);

// server.stop();
```

Other entry points:

- `.module(name, def).ui(template)` — single-module shortcut for demos (no `HypenApp` needed)
- `.source(dir)` — auto-discover `.hypen` + `.ts` files under `dir`
- `.resources({ key: path })` — expose static resources over the same WebSocket
- `.syncActions()` — turn on synchronous-action acknowledgements

Clients connect via `RemoteEngine` from `@hypen-space/core`:

```typescript
import { RemoteEngine } from "@hypen-space/core";

const engine = new RemoteEngine("ws://localhost:3000/ws");
engine.connect();
engine.dispatchAction("increment");
```

## Multi-Module Apps & Nested Modules

A single `HypenApp` can host many named modules. Each module owns its own state slice and handlers; they share a single engine instance and communicate through the global context. Bindings are namespaced: `@{feed.items}` / `@actions.feed.refresh` resolve from the parent template.

```typescript
import { HypenApp } from "@hypen-space/core";

const myApp = new HypenApp();

myApp.module("Feed")
  .defineState({ items: [] as Item[] })
  .onAction("refresh", ({ state }) => { /* ... */ })
  .build();

myApp.module("Counter")
  .defineState({ count: 0 })
  .onAction("increment", ({ state }) => { state.count++; })
  .build();

new RemoteServer().app(myApp).listen(3000);
```

`myApp.module("Name").defineState(...)...build()` auto-registers under `"Name"`; access the definitions later via `myApp.get("Counter")` or `myApp.components`.

On the browser side, `Hypen` (from `@hypen-space/web-engine`) instantiates one `HypenModuleInstance` per registered module.

## Bun Plugin

Import `.hypen` files directly in Bun:

```typescript
import { registerHypenPlugin } from "@hypen-space/server";

registerHypenPlugin();

// Now you can import .hypen files
import template from "./Counter.hypen";
```

## Exports

| Export | Description |
|--------|-------------|
| `@hypen-space/server` | Main - Engine, ComponentLoader, discoverComponents, RemoteServer |
| `@hypen-space/server/engine` | Node.js WASM engine wrapper |
| `@hypen-space/server/loader` | Component loader |
| `@hypen-space/server/discovery` | Filesystem component discovery |
| `@hypen-space/server/plugin` | Bun plugin for `.hypen` imports |
| `@hypen-space/server/remote` | RemoteServer for WebSocket streaming |

## Requirements

- Node.js >= 18.0.0 or Bun 1.0+
- `@hypen-space/core` peer dependency

## License

MIT
