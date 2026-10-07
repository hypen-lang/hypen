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
- `.syncActions()` — mirror every client's actions to every other connected client (the device plane stays on; see below)
- `.config({ allowedOrigins, authenticate })` — WebSocket upgrade admission: an `Origin` allowlist for browsers and/or an authenticator (bearer token, cookie) for every client. Enforced exactly when configured; with neither, every client is admitted and one startup warning is logged — set them in production.

### Device access (always on)

Every `RemoteServer` offers the Device Capability Protocol (RFC 001) with no setup: a client whose `hello` offers `device` gets a device plane, and handlers reach it through `context.device`.

- `.configureDevice({ processRetainedBytes, connectionRetainedBytes, broker })` — tune budgets (defaults: 1 GiB per process, 128 MiB per connection) and broker limits.
- `.disableDevice()` — opt out: the server behaves exactly like a UI-only server.
- WebSocket compression (permessage-deflate) is on by default, one message at a time: the server negotiates both `server_no_context_takeover` and `client_no_context_takeover`, so no message shares a DEFLATE history with another and device data rides compressed sockets safely. `config({ compression: false })` turns it off; either way the device plane is unaffected. A client whose socket negotiated context takeover (in either direction, e.g. through a proxy) keeps that connection UI-only, with one warning.
- While the device plane is on, messages are capped at 4 MiB (`maxPayloadLength`) unless configured.
- `.syncActions()` keeps the device plane on: a dispatch mirrored onto another client's session runs with replay provenance, so its `context.device` refuses with `unavailable` (`syncActions.replay`). Only the client that actually dispatched can start device work.
- `session({ concurrent: "allow-multiple" })` cannot coexist with the device plane: it keeps working, the device plane is off, with one startup warning.
- Every `sessionAck` carries a `resumeToken`. It is required to resume a session that negotiated a device plane; UI-only sessions still resume by session id alone. Legacy clients that never send `hello` are initialised after the 1 s grace period (without a device plane).

Clients connect via `RemoteEngine` from `@hypen-space/core`:

```typescript
import { RemoteEngine } from "@hypen-space/core";

const engine = new RemoteEngine("ws://localhost:3000/ws");
engine.connect();
engine.dispatchAction("increment");
```

## Agent surface and attach mode

`RemoteServer.agent()` mounts a small REST surface under `/__hypen__/agent` for callers that are not the rendered UI — an MCP server, a CLI, an LLM agent. It is off until you call `.agent()`, and every dispatch goes through the engine's external guard: only `.onAction()` names, `Router { Route }` targets, `.bind()` fields and the state paths the template renders are reachable. `__hypen_bind` and the raw `router.*` verbs never are.

```
GET  /__hypen__/agent/manifest                          # tools + resources, verbatim from the engine
GET  /__hypen__/agent/openapi.json
POST /__hypen__/agent/sessions                          # 201 { sessionId, revision }                  — headless (default)
POST /__hypen__/agent/sessions      { sessionId }       # 201 { sessionId, attached: true, revision }  — attach
POST /__hypen__/agent/sessions/:id/dispatch  { name, payload? }   # 200 { dispatched, revision }
GET  /__hypen__/agent/sessions/:id/state?module=&path=            # 200 { module, path, value, revision }
```

`revision` is a **settlement cursor**: the session's render counter, monotonic and moved only by a render that produced patches. Dispatch answers "dispatched", never "done" — handlers are async and not awaited — but its `revision` is read after the dispatch returns, so every later read of that session is at-or-above it, and a read strictly above it has observed a render since. A refused dispatch (403) moves nothing. Compare cursors only within one session.

**Bearer token.** `.agent({ token })` gates the *whole* surface: every route under the base path requires `Authorization: Bearer <token>` (constant-time comparison), else `401 { error: "unauthorized" }` with `WWW-Authenticate: Bearer` — the same body on every route, so it confirms nothing about any session id. Unset, the surface is open and you are expected to put it behind your own authentication. `authorize` (below) is the finer gate on attach and runs on top of the token.

By default `POST /sessions` opens a **headless** session: a fresh engine sandboxed to the caller, on a transport nobody watches. **Attach mode** binds the caller to a live user session instead — the same guarded dispatch runs on that user's engine, so the user's browser receives exactly the `patch` a click produces, at the next revision. That is a grant only your app can make:

- **No `authorize` callback ⇒ every attach is refused.** Return `true` from `authorize(req, sessionId)` only after checking whatever you authenticate with — a cookie, a bearer token, an internal network. `false`, a throw, and an id that names no ready session all answer the byte-identical `404 unknown_session`, so the route is not an oracle for which session ids exist.
- The 201 carries a fresh agent id, never the user's. Use it on `/dispatch` and `/state` as usual.

```typescript
const server = new RemoteServer()
  .app(myApp)
  .agent({
    token: process.env.HYPEN_AGENT_TOKEN,          // gates every route
    authorize: (req, sessionId) =>                 // gates attach only
      isOperatorFor(req.headers.get("x-operator"), sessionId),
  })
  .listen(3000);
```

The bundled browser client exposes the id an app needs to hand over — `window.__hypen.getSessionId()`, or `window.__hypen.onSessionEstablished(cb)` for every (re)connect. It is the session's resume token: forward it only to a backend you trust.

In-process, skip HTTP and attach directly. `server.attach(sessionId)` performs no authorization — whoever holds the `RemoteServer` already holds every session on it, so the calling handler is the authorizer:

```typescript
import { AgentSessionGoneError } from "@hypen-space/server";

const handle = server.attach(sessionId); // null: unknown id, hello not finished, or destroyed
if (handle) {
  handle.listActions();                        // what the app declared
  handle.dispatch("addToCart", { sku: "A1" }); // the user's browser re-renders
  handle.getState("cart", "total");            // bounded to the paths the template renders
  handle.revision();                           // the session's wire revision
}
```

Two guarantees hold whichever way you attach. A handle **never owns the session**: it cannot destroy, suspend or close it, and once the user disconnects `handle.alive` is `false` and every call throws `AgentSessionGoneError`. And a **guard refusal is silent on the wire**: `dispatch` throws before any handler runs, nothing is sent to the user, and the revision does not move. Under `.syncActions()` an attached dispatch mirrors a click and is fanned out to the other hello-completed sessions; under `concurrent: "allow-multiple"` the first ready session with that id is chosen, and its render callback already reaches its peers.

`handle.engine` is an `AgentEngine`-shaped view, so `new HypenMcpServer({ engine: handle.engine })` from `@hypen-space/agent` serves MCP over the session a human is looking at — see that package's README.

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
| `@hypen-space/server` | Main - Engine, ComponentLoader, discoverComponents, RemoteServer, AgentHandle |
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
