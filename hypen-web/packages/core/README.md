# @hypen-space/core

The reactive runtime for Hypen - a declarative UI language that separates what your UI looks like from how it behaves.

## What is Hypen?

Hypen lets you write UI templates in a clean, declarative syntax:

```hypen
Column {
  Text("Hello, @{state.user.name}!")
  Button(onClick: @actions.logout) {
    Text("Sign Out")
  }
}
```

The `@hypen-space/core` package provides the engine that:

1. **Parses** your Hypen templates
2. **Tracks** reactive state bindings (like `@{state.user.name}`)
3. **Generates patches** when state changes (instead of re-rendering everything)
4. **Dispatches actions** triggered from the UI (like `@actions.logout`)

You provide a renderer that applies those patches to your platform (DOM, Canvas, Native, etc).

## Installation

```bash
npm install @hypen-space/core
# or
bun add @hypen-space/core
```

## Core Concepts

### Templates

Hypen templates describe your UI structure. Components can have:

- **Arguments**: `Text("Hello")` or `Button(disabled: true)`
- **Children**: Nested inside `{ }` braces
- **Applicators**: Chained styling like `.padding(16).color(blue)`

### State Bindings

Use `@{state.path}` to bind template values to your module's state:

```hypen
Text("Count: @{state.count}")
Text("User: @{state.user.name}")
```

When state changes, only the affected parts of the UI update.

### Actions

Use `@actions.name` to dispatch events from the UI to your module:

```hypen
Button(onClick: @actions.increment) { Text("+") }
Button(onClick: @actions.submitForm) { Text("Submit") }
```

### Patches

The engine doesn't manipulate the UI directly. Instead, it emits **patches** - minimal instructions describing what changed:

```typescript
{ type: "Create", id: "1", elementType: "Text", props: { text: "Hello" } }
{ type: "SetProp", id: "1", name: "text", value: "Hello, World" }
{ type: "Remove", id: "1" }
```

Your renderer applies these patches to the actual platform.

## Quick Start

```typescript
import { app } from "@hypen-space/core";
import { Engine } from "@hypen-space/web-engine";

// 1. Define your module's state and actions
const counter = app
  .defineState({ count: 0 })
  .onAction("increment", ({ state }) => state.count++)
  .onAction("decrement", ({ state }) => state.count--)
  .build();

// 2. Initialize the engine
const engine = new Engine();
await engine.init();

// 3. Mount a renderer (one call wires up patch streaming + actions)
import { createHypenClient } from "@hypen-space/web/dom";
const { renderer } = createHypenClient(document.getElementById("app")!, engine);

// 4. Register the module and render
engine.setModule("counter", counter.actions, counter.stateKeys, counter.initialState);

engine.renderSource(`
  Column {
    Text("Count: @{state.count}")
    Row {
      Button(onClick: @actions.decrement) { Text("-") }
      Button(onClick: @actions.increment) { Text("+") }
    }
  }
`);
```

## Modules

Modules manage state and handle actions. Use the `app` builder to define them:

```typescript
import { app } from "@hypen-space/core";

interface UserState {
  user: { id: string; name: string } | null;
  loading: boolean;
}

interface LoadUserPayload { id: string; }

const userModule = app
  .defineState<UserState>({ user: null, loading: false })

  // Lifecycle handler: receives (state, context?)
  .onCreated(async (state, context) => {
    state.loading = true;
    // State changes are auto-synced via Proxy
  })

  // Typed action handler: declare the payload type as a generic so
  // `action.payload` is statically typed instead of `unknown`.
  .onAction<LoadUserPayload>("loadUser", async ({ state, action, context }) => {
    state.user = await fetchUser(action.payload.id);
    state.loading = false;
    // State changes are auto-synced via Proxy
    // context.router is available for programmatic navigation
  })

  // Actions without a payload: omit the generic.
  .onAction("logout", ({ state }) => {
    state.user = null;
  })

  // Lifecycle handler: receives (state, context?)
  .onDestroyed((state, context) => {
    console.log("Cleanup");
  })

  .build();
```

State mutations are automatically tracked via Proxy and synced to the engine.
Action payloads default to `unknown` — always pass a payload type to
`.onAction<P>(...)` when the action carries data so you get end-to-end
type safety instead of manual casting.

## State

State is automatically tracked via Proxy. Mutations trigger UI updates:

```typescript
import { createObservableState, batchStateUpdates, getStateSnapshot } from "@hypen-space/core";

const state = createObservableState({ count: 0, items: [] }, {
  onChange: (path, oldVal, newVal) => {
    console.log(`${path.join(".")} changed: ${oldVal} -> ${newVal}`);
  }
});

// Direct mutations are tracked
state.count = 5;
state.items.push("item");

// Batch multiple updates into one render cycle
batchStateUpdates(state, () => {
  state.count = 10;
  state.items = ["a", "b", "c"];
});

// Get an immutable snapshot
const snapshot = getStateSnapshot(state);
```

## Custom Renderers

Extend `BaseRenderer` to render to any platform:

```typescript
import { BaseRenderer } from "@hypen-space/core";

class MyRenderer extends BaseRenderer {
  protected onCreate(id: string, type: string, props: Record<string, any>) {
    // Create an element
  }
  protected onSetProp(id: string, name: string, value: any) {
    // Update a property
  }
  protected onSetText(id: string, text: string) {
    // Set text content
  }
  protected onInsert(parentId: string, id: string, beforeId?: string) {
    // Insert into parent
  }
  protected onMove(parentId: string, id: string, beforeId?: string) {
    // Reorder element
  }
  protected onRemove(id: string) {
    // Remove element
  }
}
```

See `@hypen-space/web` for a DOM renderer implementation.

## Routing

Built-in hash or pathname routing:

```typescript
import { HypenRouter } from "@hypen-space/core";

const router = new HypenRouter();

router.navigate("/products/123");

router.subscribe((state) => {
  console.log("Path:", state.currentPath);
  console.log("Params:", state.params);   // { id: "123" }
  console.log("Query:", state.query);
});
```

Use built-in components in templates:

```hypen
Router {
  Route(path: "/") { HomePage }
  Route(path: "/products/:id") { ProductPage }
}
Link(to: "/products/42") { Text("View Product") }
```

## Component Discovery

For larger apps, organize components as files and auto-discover them:

```typescript
import { discoverComponents, loadDiscoveredComponents } from "@hypen-space/server";

const components = await discoverComponents("./src/components");
const loaded = await loadDiscoveredComponents(components);
```

Supported file patterns:

```
Counter/
├── component.hypen    # Template
└── component.ts       # Module

Counter.hypen          # Or sibling files
Counter.ts

Counter/
├── index.hypen        # Or index-based
└── index.ts
```

Watch for changes (hot reload):

```typescript
import { watchComponents } from "@hypen-space/server";

const watcher = watchComponents("./src/components", {
  onUpdate: (c) => console.log("Updated:", c.name),
});
```

## Component Loader

Register components programmatically:

```typescript
import { componentLoader, ComponentLoader } from "@hypen-space/server";

// Global loader
componentLoader.register("Counter", counterModule, counterTemplate);
componentLoader.get("Counter");
componentLoader.has("Counter");

// Or create your own
const loader = new ComponentLoader();
await loader.loadFromComponentsDir("./src/components");
```

## Remote UI

Connect to a Hypen server for server-driven UI:

```typescript
import { RemoteEngine } from "@hypen-space/core";

const remote = new RemoteEngine("ws://localhost:3000", {
  autoReconnect: true,
});

// Mount a renderer once — `createHypenClient` accepts RemoteEngine
// directly (it picks up `onPatches` automatically).
import { createHypenClient } from "@hypen-space/web/dom";
createHypenClient(document.getElementById("app")!, remote);

remote
  .onStateUpdate((state) => console.log("Server state:", state))
  .onConnect(() => console.log("Connected"));

await remote.connect();
remote.dispatchAction("loadData", { page: 1 });
```

## Global Context

Share state and events across modules:

```typescript
import { HypenGlobalContext } from "@hypen-space/core";

const context = new HypenGlobalContext();

context.registerModule("auth", authModule);
context.registerModule("cart", cartModule);

// Cross-module access
const user = context.getModule("auth").getState().user;

// Event bus
context.on("userLoggedIn", (user) => { /* ... */ });
context.emit("userLoggedIn", { id: "1", name: "Ian" });
```

## Browser vs Node.js

```typescript
// Node.js / Bundler - WASM loads automatically
import { Engine } from "@hypen-space/server";
const engine = new Engine();
await engine.init();

// Browser - specify WASM path
import { Engine } from "@hypen-space/web-engine";
const engine = new Engine();
await engine.init({ wasmPath: "/hypen_engine_bg.wasm" });
```

## Single-File Components

Use template literals with the `hypen`, `state`, `item`, and `index` helpers:

```typescript
import { app, hypen, state, item, index } from "@hypen-space/core";

export default app
  .defineState({ items: ["A", "B", "C"] })
  .ui(hypen`
    Column {
      ForEach(items: @{state.items}) {
        Text("@{index}: @{item}")
      }
    }
  `);
```

## Error Handling

### Result Type

Type-safe error handling without exceptions:

```typescript
import { Ok, Err, fromPromise, match, all, isOk, isErr } from "@hypen-space/core";

// Create results
const success = Ok(42);
const failure = Err(new Error("failed"));

// Pattern matching
const message = match(result, {
  ok: (value) => `Got ${value}`,
  err: (error) => `Failed: ${error.message}`,
});

// Convert promises to Result
const result = await fromPromise(fetch("/api/data"));

// Combine multiple results
const combined = all([result1, result2, result3]);
```

### Module Error Handler

Handle errors in module actions:

```typescript
app
  .defineState({ error: null })
  .onError(({ error, action, state }) => {
    console.error(`Action ${action.name} failed:`, error);
    state.error = error.message;
    return { handled: true };  // Prevent error from propagating
  })
  .onAction("riskyAction", async ({ state }) => {
    throw new Error("Something went wrong");
  });
```

## Session Lifecycle

Handle connection state for remote UI:

```typescript
app
  .defineState({ connected: true })
  .onDisconnect(({ state, reason }) => {
    state.connected = false;
    console.log("Disconnected:", reason);
  })
  .onReconnect(({ state, wasExpired }) => {
    state.connected = true;
    if (wasExpired) {
      // Session was restored from server
    }
  })
  .onExpire(({ state, reason }) => {
    // Session expired, need to re-authenticate
    state.connected = false;
  });
```

## Disposable Pattern

Resource management with automatic cleanup:

```typescript
import { DisposableStack, using, disposableListener } from "@hypen-space/core";

// Automatic cleanup with using()
await using(new DisposableStack(), async (stack) => {
  const listener = stack.use(
    disposableListener(window, "resize", handleResize)
  );
  // listener is automatically removed when scope exits
});

// Manual stack management
const stack = new DisposableStack();
stack.use(disposableTimeout(() => {}, 1000));
stack.use(disposableInterval(() => {}, 100));
stack.dispose(); // Cleans up everything
```

## Retry Utilities

Retry failed operations with backoff:

```typescript
import { retry, retryResult, RetryPresets } from "@hypen-space/core";

// Simple retry with exponential backoff
const data = await retry(
  () => fetch("/api/data"),
  { maxAttempts: 3, backoff: "exponential" }
);

// Retry returning Result type
const result = await retryResult(
  () => fetchData(),
  RetryPresets.network  // Pre-configured for network errors
);
```

## Logger

Structured logging with levels:

```typescript
import { createLogger, setLogLevel, Logger } from "@hypen-space/core";

const log = createLogger("MyModule");

log.debug("Detailed info");
log.info("Normal operation");
log.warn("Something unexpected");
log.error("Something failed", error);

// Configure globally
setLogLevel("warn");  // Only warn and error
```

## Typed Events

Type-safe event emitter:

```typescript
import { TypedEventEmitter, createEventEmitter } from "@hypen-space/core";

interface MyEvents {
  userLogin: { userId: string };
  dataLoaded: { items: string[] };
}

const events = createEventEmitter<MyEvents>();

events.on("userLogin", ({ userId }) => {
  console.log("User logged in:", userId);
});

events.emit("userLogin", { userId: "123" });
```

## Package Exports

| Export | Description |
|--------|-------------|
| `@hypen-space/core` | Main entry point (app, state, router, types) |
| `@hypen-space/core/app` | Module builder |
| `@hypen-space/core/state` | Observable state utilities |
| `@hypen-space/core/renderer` | Abstract renderer |
| `@hypen-space/core/router` | Routing system |
| `@hypen-space/core/context` | Global context |
| `@hypen-space/core/remote/client` | Remote UI client (RemoteEngine) |
| `@hypen-space/core/components` | Built-in Router, Route, Link |
| `@hypen-space/core/result` | Result type for error handling |
| `@hypen-space/core/disposable` | Disposable pattern utilities |
| `@hypen-space/core/logger` | Structured logging |
| `@hypen-space/core/events` | Typed event emitter |
| `@hypen-space/server` | Node.js WASM engine, loader, discovery, RemoteServer |
| `@hypen-space/web-engine` | Browser WASM engine, Hypen orchestrator |
| `@hypen-space/web` | DOM & Canvas renderers |

## Requirements

- Node.js >= 18.0.0
- TypeScript 5+ (optional)

## License

MIT
