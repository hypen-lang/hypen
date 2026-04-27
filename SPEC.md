# RFC-0001: Hypen Stateful Modules

**Author:** Ian Rumac  
**Date:** 2025-10-08  
**Status:** Draft  
**Version:** 1.1

---

## 1. Abstract

This RFC defines the **stateful module system** for Hypen.

Hypen separates the world into:
- **Components** — purely declarative, stateless UI definitions.
- **Modules** — stateful controllers that hold data, react to lifecycle events, and expose named actions.

This document formalizes how modules are declared, how they interact with the Hypen runtime and UI engine, and how they remain language-agnostic and portable across JavaScript/TypeScript and WASM runtimes.

---

## 2. Motivation & Goals

Hypen’s design principle is that *UI should be declarative and state should be explicit*.  
Modules give developers a unified way to:

- Define reactive state for a feature or page.
- Handle lifecycle events (`onCreated`, `onActivated`, `onDeactivated`, `onDestroyed`).
- Respond to user or network actions (`onAction(name, handler)`).
- Synchronize changes with the rendering engine or a remote host.
- Remain portable between local, remote, and embedded contexts.

### Goals
- **Typed DX for host languages (JS/TS).**
- **Reactive state propagation** to Hypen’s engine.
- **WASM parity** through a minimal ABI.
- **Remote-UI support** — a module can live on a server, client, or other host.
- **Predictable lifecycle** independent of rendering framework.

### Non-Goals
- Hypen core will **not manage schema typing or validation**.  
  Typing is a **host-side concern** (e.g., TypeScript, Rust types, etc.).

---

## 3. High-Level Architecture

```
 ┌──────────────────────────┐
 │  Hypen Runtime Engine    │
 │  (Rust/WASM core)        │
 ├──────────┬───────────────┤
 │          │               │
 ▼          ▼               ▼
 UI Layer   Module Host(s)  Remote Stream
 (render)   (JS/TS/WASM)    (WebSocket)
```

1. **Modules** define state and behavior via the `app` API (JS/TS) or a WIT-based ABI (WASM).  
2. **Components** render UI declaratively using `@actions` and `@{state.*}` bindings.  
3. The **engine** observes state mutations and triggers incremental re-renders or transmits patches over the network.

---

## 4. JavaScript / TypeScript Reference API

### 4.1 Example

```ts
// ProfilePage.ts
import { app } from "@hypen-space/core";

type User = { id: string; name: string; premium: boolean };
const initialUser: User | null = null;

export default app
  .defineState<User | null>(initialUser)
  .onCreated(async (state, context) => {
    // Called once when module is instantiated
    // State changes are automatically tracked via Proxy
    console.log("ProfilePage created");
  })
  .onAction("signInWithGoogle", async ({ action, state, context }) => {
    // Called whenever @actions.signInWithGoogle is dispatched
    // State mutations are automatically tracked and synced
    state.user = { id: "1", name: "Ian", premium: true };
  })
  .onDestroyed((state, context) => {
    console.log("ProfilePage destroyed");
  });
```

### 4.2 API Shape

```ts
interface HypenApp {
  defineState<T>(
    initial: T,
    options?: { persist?: boolean; version?: number; name?: string }
  ): HypenAppBuilder<T>;
}

interface HypenAppBuilder<T> {
  onCreated(fn: LifecycleHandler<T>): this;
  onActivated(fn: LifecycleHandler<T>): this;
  onDeactivated(fn: LifecycleHandler<T>): this;
  onAction(name: string, fn: ActionHandler<T>): this;
  onDestroyed(fn: LifecycleHandler<T>): this;
  onDisconnect(fn: DisconnectHandler<T>): this;
  onReconnect(fn: ReconnectHandler<T>): this;
  onExpire(fn: ExpireHandler): this;
  onError(fn: ErrorHandler<T>): this;
  ui(template: string): HypenModuleDefinition<T>;
  build(): HypenModuleDefinition<T>;
}

// Lifecycle handlers receive state and optional global context
type LifecycleHandler<T> = (state: T, context?: GlobalContext) => void | Promise<void>;

// Action handlers receive a context object with all parameters
type ActionHandler<T, P = unknown> = (ctx: ActionHandlerContext<T, P>) => void | Promise<void>;

interface ActionHandlerContext<T, P = unknown> {
  action: ActionContext<P>;
  state: T;
  context: GlobalContext; // Cross-module communication + router
}

interface ActionContext<P = unknown> {
  name: string;
  payload?: P;
  sender?: string;
}

interface GlobalContext {
  getModule: <T>(id: string) => ModuleReference<T>;
  hasModule: (id: string) => boolean;
  getModuleIds: () => string[];
  getGlobalState: () => Record<string, unknown>;
  emit: (event: string, payload?: unknown) => void;
  on: (event: string, handler: (payload?: unknown) => void) => () => void;
  router: HypenRouter | null; // Access to router for programmatic navigation
}

// Session lifecycle handlers (for Remote UI)
type DisconnectHandler<T> = (ctx: { state: T; session: Session }) => void | Promise<void>;
type ReconnectHandler<T> = (ctx: { session: Session; restore: (saved: T) => void }) => void | Promise<void>;
type ExpireHandler = (ctx: { session: Session }) => void | Promise<void>;

// Error handler - controls error propagation
type ErrorHandler<T> = (ctx: ErrorContext<T>) => ErrorHandlerResult | Promise<ErrorHandlerResult>;
type ErrorHandlerResult = void | { handled: true } | { retry: true } | { rethrow: true };

interface ErrorContext<T> {
  error: HypenError;
  state: T;
  actionName?: string;
  lifecycle?: "created" | "destroyed" | "disconnect" | "reconnect" | "expire";
}
```

- `.defineState()` registers the initial reactive state.
- `.onCreated()` / `.onActivated()` / `.onDeactivated()` / `.onDestroyed()` hook into module lifecycle. Under `ManagedRouter`, `onActivated` / `onDeactivated` fire every time the module gains or loses the active route slot (state persists across re-entry), while `onCreated` / `onDestroyed` fire only once per instance.
- `.onAction(name, handler)` listens to named actions triggered by the UI or remote dispatch.
- `.onDisconnect()` / `.onReconnect()` / `.onExpire()` handle session lifecycle for Remote UI.
- `.onError()` provides centralized error handling with control over propagation.
- `.ui(template)` attaches an inline Hypen DSL template (single-file component) and calls `build()`.
- Mutating `state` automatically publishes change events to the engine (no `next()` callback needed).

---

## 5. Hypen File Bindings

### 5.1 Example

```hypen
module ProfilePage() {
  Column {
    Text("Welcome, @{state.user?.name ?? 'Guest'}")
    Button { Text("Sign in with Google") }
      .onClick(@actions.signInWithGoogle)
  }
}
```

| Syntax | Description |
|---------|-------------|
| `@{state.key}` | Reads reactive state value |
| `@actions.name` | Dispatches action by name (via event applicators) |
| `@resources.name` | References a registered resource (e.g., SVG icon) |
| `@state.path` | State binding reference (used in `.bind()`, `ForEach`, etc.) |
| `@provider.path` | Data source binding (e.g., `@spacetime.messages`) |

When the user taps the button, the `.onClick` applicator dispatches a `"signInWithGoogle"` action to the module, invoking the registered `onAction()` handler.

> **Note:** Actions are attached via event applicators (`.onClick`, `.onPress`, `.onLongPress`, etc.), not as positional string arguments. The applicator form ensures correct cross-platform behavior across Web, iOS, and Android renderers.

---

## 6. Runtime Lifecycle

| Phase | Callback | Description |
|-------|-----------|-------------|
| **Created** | `onCreated` | Called once per instance on first mount. |
| **Activated** | `onActivated` | Called every time the module gains the active route slot (including re-entry from the `ManagedRouter` cache). |
| **Action** | `onAction(name)` | Called per dispatched action event. |
| **Deactivated** | `onDeactivated` | Called every time the module loses the active route slot. The instance may stay cached and be re-activated later. |
| **Disconnected** | `onDisconnect` | Called when client disconnects (session persists for TTL). |
| **Reconnected** | `onReconnect` | Called when client reconnects with existing session. |
| **Expired** | `onExpire` | Called when session TTL expires without reconnection. |
| **Error** | `onError` | Called when any error occurs in handlers. |
| **Destroyed** | `onDestroyed` | Called once on final teardown (evicted from cache, or app shutdown). |

The runtime wraps state in a reactive proxy. Direct mutations (`state.count++`) are diffed, persisted, and re-emitted to the renderer.

---

## 7. WASM Compatibility

### 7.1 ABI Definition (WIT)

The engine is compiled to WASM and exposes an engine-centric interface. Host languages (JS/TS, Go, Python) call into the engine and provide callbacks for patches and actions.

```wit
package hypen:engine@0.1.0;

interface types {
    record patch { json: string }
    record module-config {
        name: string,
        actions: list<string>,
        state-keys: list<string>,
        initial-state: string,  // JSON
    }
    record action-payload { name: string, payload: string }
    record sparse-update { paths: list<string>, values: string }
    record resolved-component { source: string, path: string, passthrough: bool, lazy: bool }
}

interface engine {
    use types.{module-config, action-payload, sparse-update, resolved-component};

    init: func() -> u64;
    destroy: func(handle: u64);
    render-source: func(handle: u64, source: string) -> result-value;
    update-state: func(handle: u64, patch: string) -> result-value;
    update-state-sparse: func(handle: u64, update: sparse-update) -> result-value;
    set-module: func(handle: u64, config: module-config) -> result-value;
    dispatch-action: func(handle: u64, action: action-payload) -> result-value;
    register-component: func(handle: u64, name: string, source: string, path: string) -> result-value;
    parse-to-json: func(source: string) -> result-value;
    get-patches: func(handle: u64) -> string;
    clear-patches: func(handle: u64);
}

interface callbacks {
    use types.{patch, action-payload, resolved-component};
    on-patches: func(patches: list<patch>);
    on-action: func(action: action-payload);
    resolve-component: func(name: string, context-path: option<string>) -> option<resolved-component>;
}

world hypen-engine {
    export engine;
    import callbacks;
}

world hypen-engine-simple {
    export engine;  // Polling-based, no callbacks
}
```

### 7.2 Architecture

The WASM engine is **renderer-agnostic**. Host SDKs (JS/TS, Kotlin, Swift, Go) implement module lifecycle and state management natively, then communicate with the engine via:

- `set-module` — registers module config (name, actions, state keys, initial state).
- `render-source` — parses and renders Hypen DSL into patches.
- `update-state` / `update-state-sparse` — pushes state changes, engine re-reconciles.
- `dispatch-action` — routes actions from UI to host-side handlers.
- `get-patches` / `on-patches` — retrieves or receives incremental UI patches.

Module lifecycle (`onCreated`, `onAction`, `onDestroyed`) is handled by the host SDK, not the WASM engine. The engine only manages rendering, reconciliation, and patch generation.

---

## 8. Remote UI / Host-Client Streaming

Modules are pure state machines that produce a UI tree.  
They can execute locally or remotely.

### 8.1 Protocol Messages

```jsonc
// Host → Client (initial connection)
{
  "type": "initialTree",
  "module": "ProfilePage",
  "state": { "user": null },
  "patches": [ /* initial patches to construct the tree */ ],
  "revision": 0,
  "hash": "optional-integrity-hash"
}

// Client → Host (action dispatch)
{
  "type": "dispatchAction",
  "module": "ProfilePage",
  "action": "signInWithGoogle",
  "payload": null
}

// Host → Client (state update)
{
  "type": "stateUpdate",
  "module": "ProfilePage",
  "state": { "user": { "id": "1", "name": "Ian", "premium": true } }
}

// Host → Client (incremental patches)
{
  "type": "patch",
  "patches": [ /* incremental UI patches */ ],
  "revision": 1
}
```

The runtime synchronizes state patches and re-renders affected nodes.
Actions are sent as discrete events, making Hypen inherently network-transparent.
Revision tracking ensures patches are applied in order, with optional integrity hashes for verification.

---

## 9. Persistence & Versioning

Modules may specify persistence and schema version:

```ts
app.defineState<User>(initialUser, { persist: true, version: 2 });
```

- **persist** — the runtime stores serialized state snapshots.  
- **version** — optional numeric identifier used by hosts to perform migrations or invalidations.  
  Hypen core itself does not enforce migrations.

---

## 10. Multi-Module Composition

Modules communicate through a shared `GlobalContext` that provides cross-module state access and an event bus:

```ts
// In an action handler, access another module via context
.onAction("checkout", async ({ state, context }) => {
  // Read another module's state
  const auth = context.getModule<AuthState>("auth");
  if (!auth.state.isLoggedIn) {
    return; // guard
  }

  // Mutate own state
  state.orderStatus = "processing";

  // Emit a cross-module event
  context.emit("order:placed", { orderId: state.orderId });
})

// In another module, listen for cross-module events
.onCreated((state, context) => {
  context.on("order:placed", (payload) => {
    state.pendingOrders.push(payload.orderId);
  });
})
```

Each module has its own lifecycle and state. Cross-module access is explicit through `context.getModule(id)` and the event bus (`context.emit` / `context.on`). The engine does not implicitly share state between modules.

---

## 11. Security & Sandboxing

- JS/TS modules run inside the host language sandbox.  
- WASM modules run in isolated instances with:
  - no ambient file/network access;
  - explicit capability imports (e.g., `state`, `emit`);
  - memory/time limits per instance.
- Remote UI connections are authenticated and signed (nonce + HMAC) to prevent spoofed actions.

---

## 12. Developer Experience

- **Minimal boilerplate** — one fluent chain per module.  
- **Hot reload** — re-executes `onCreated` if the state definition changes.  
- **Inspector panel** — displays state keys, actions, and live values.  
- **Autocomplete** for `@actions.*` and `@{state.*}` powered by the module manifest.  
- **Testing** — mock host API to verify action logic in isolation.

---

## 13. Future Extensions

| Area | Direction |
|------|------------|
| **Selectors / Computed values** | Derived read-only fields for performant re-renders. |
| **Effects** | Declarative side-effects with cleanup. |

### Shipped since v1.0

| Area | Status |
|------|--------|
| **Streaming UI** | Shipped. Remote UI protocol with WebSocket streaming (see Section 8). |
| **Multi-language SDKs** | Shipped. TypeScript, Kotlin/JVM, Swift, Go SDKs available. |
| **Module composition** | Shipped. `GlobalContext` provides cross-module state access and event bus (see Section 10). |
| **Data Sources** | Shipped. Plugin system for reactive external data (`@provider.path` bindings). |
| **Two-way Binding** | Shipped. `.bind(@state.path)` for form elements. |
| **Control Flow** | Shipped. First-class `ForEach`, `If`, `When` constructs in the IR. |
| **Virtualized Lists** | Shipped. `List` and `Grid` with native lazy rendering (LazyColumn, LazyVStack). |
| **Resource System** | Shipped. `@resources.name` references for SVG icons and assets. |
| **Router** | Shipped. Client-side `Router`/`Route`/`Link` with path params and wildcards. |
| **Tailwind CSS** | Shipped. `.tw("classes")` applicator expands to native properties. |
| **Responsive Breakpoints** | Shipped. `.fontSize@md(18)` variant syntax. |

---

## 14. Example End-to-End Flow

1. Runtime loads `ProfilePage.ts` → builds module definition.  
2. `onCreated` fires → initializes state.  
3. Engine renders `ProfilePage.hypen`.  
4. User taps button → `@actions.signInWithGoogle` dispatches action.  
5. Module’s `onAction()` mutates `state`.  
6. Engine observes diff → updates UI (or streams patch).  
7. On teardown, `onDestroyed()` cleans up and persists final state.

---

## 15. Guiding Principles

| Principle | Description |
|------------|-------------|
| **Stateless UI, Stateful Logic** | Components render; modules act. |
| **Direct, reactive state** | No reducers or immutability boilerplate. |
| **Named, explicit actions** | Simple event system instead of opaque dispatchers. |
| **Portable by design** | Runs locally, remotely, or inside WASM. |
| **Schema-agnostic core** | Type safety handled by host, not Hypen runtime. |

---

## 16. Appendix: Minimal Manifest

Each built module produces a manifest consumed by the engine:

```json
{
  "name": "ProfilePage",
  "actions": ["signInWithGoogle"],
  "stateKeys": ["user"],
  "persist": true,
  "version": 1
}
```

---

## 17. Revision History

| Version | Date | Notes |
|----------|------|-------|
| 1.0 | 2025-10-08 | Initial draft by Ian Rumac |
| 1.1 | 2026-04-05 | Updated DSL syntax (event applicators), expanded binding table, moved shipped features from Future Extensions |

---

**End of Document**
