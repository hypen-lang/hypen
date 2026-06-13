# Implementing a Hypen engine for a new runtime

This guide is for porting Hypen's server-side engine to a runtime that isn't
already supported (Node/Bun, the browser, and Cloudflare Workers are). It
captures the non-obvious decisions — which WASM target to use, how to install
the portable helpers, and how action payloads need normalizing — that
otherwise have to be reverse-engineered from the three existing engine
wrappers.

If you only want to *host* a Hypen app on a new transport (a different
WebSocket library, SSE, etc.) you probably don't need a new engine at all —
see "Do you actually need a new engine?" below.

---

## Background: what an "engine" is here

`@hypen-space/core` is deliberately **WASM-free**. It contains the app builder,
observable state, router, and the remote protocol (`RemoteSession`), but it
never imports the Rust/WASM engine binary. The WASM engine is wrapped by a
small platform-specific subclass of `BaseEngine`
(`@hypen-space/core/engine-base`). There are three today:

| Package | Runtime | WASM target |
|---|---|---|
| `@hypen-space/server` | Node / Bun | `wasm-node` (bundler target) |
| `@hypen-space/web-engine` | Browser | `wasm-browser` (web target) |
| example `CFEngine` | Cloudflare Workers (workerd) | `wasm-browser` (web target) |

`BaseEngine` provides every method `RemoteSession` and the SDK call
(`renderSource`, `setRenderCallback`, `setComponentResolver`, `dispatchAction`,
`onAction`, `discoverRouters`, `registerModule`, `registerResources`, …). A
subclass implements just **two abstract methods** plus, usually, **two install
side-effects**.

---

## The WASM target landscape

`hypen-engine-rs` builds with `wasm-bindgen` into multiple targets. Picking the
wrong one is the single biggest time sink in a port.

### `wasm-node` (a.k.a. bundler target)

- The generated JS glue does, at module-load time,
  `import * as wasm from "./hypen_engine_bg.wasm"; wasm.__wbindgen_start();`.
- The runtime's module loader must be able to *instantiate a `.wasm` import as
  a module with exports*. Node and Bun do this. **workerd does not** — there
  the `.wasm` import gives you a bare `WebAssembly.Module`, and
  `wasm.__wbindgen_start` is `undefined` (the classic
  `__wbindgen_start is not a function` error).
- No async init step. `new WasmEngine()` is enough.

### `wasm-browser` (a.k.a. web target)

- Exposes an explicit init you call yourself:
  - `await __wbg_init(url)` (async, fetches the `.wasm` over the network), **or**
  - `initSync({ module })` (sync, takes a pre-instantiated `WebAssembly.Module`).
- This is the **only** target that accepts a pre-instantiated
  `WebAssembly.Module`, which is what every "bring your own bytes" runtime
  (Cloudflare's `CompiledWasm`, Deno's `WebAssembly.compile`, an embedded
  byte array) can hand you.
- **Caveat — returns `Map`s.** The web target returns structured action
  payloads as JS `Map` instances, not plain objects. This is handled for you
  now (see "Action normalization") but it's the reason a naive port sees
  `payload.to === undefined` and `@router.push` silently no-op.

### Rule of thumb

- Your runtime can load a `.wasm` import as an ES module with live exports
  (Node, Bun) → **`wasm-node`**.
- Your runtime hands you bytes / a `WebAssembly.Module` and expects you to
  instantiate (workerd, Deno, embedders) → **`wasm-browser` + `initSync`**.

---

## The minimum: subclass `BaseEngine`

```ts
import { BaseEngine } from "@hypen-space/core/engine-base";

export class MyEngine extends BaseEngine {
  // 1. Stand up the WASM module and assign this.wasmEngine.
  async init(): Promise<void> {
    if (this.initialized) return;
    // ...target-specific init (see below)...
    this.wasmEngine = new WasmEngine();
    this.wasmEngine.registerDefaultPrimitives();
    this.initialized = true;
  }

  // 2. Convert host state (proxies, Maps) into something safe to cross the
  //    WASM boundary. Called on every updateState / registerModule / etc.
  protected unwrapForWasm<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    // Hypen's observable state exposes a snapshot fast-path:
    const snap = (value as { __getSnapshot?: () => T }).__getSnapshot;
    if (typeof snap === "function") return snap.call(value);
    try {
      return structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value));
    }
  }
}
```

That's the whole abstract surface. Everything else is inherited.

---

## The two install side-effects

### a) Install the portable helpers

`@hypen-space/core` defers a set of pure helpers — state diffing, route
matching, path get/set/delete, URL parsing — to whatever host installs them via
`setPortableImpl` (`@hypen-space/core/portable`). **If you skip this, core
throws** the moment `createObservableState` or `HypenRouter.matchPath` runs:

```
[@hypen-space/core] Portable helper "diffState" called before the engine was installed...
```

The implementations are exposed by the same WASM module
(`diffPaths`, `matchPath`, `pathGet`, …). Mirror
`@hypen-space/server/install-portable.ts` (or the example CFEngine's
`installPortable()`), binding each helper to your target's WASM exports, and
call `setPortableImpl(impl)` **at module-load time**, before any
`app.defineState(...)` in the worker's module graph runs (that triggers
`createObservableState`, which needs `diffState`).

### b) Action normalization (usually free now)

`BaseEngine.normalizeAction` defaults to deep-converting `Map` payloads to
plain objects — the web-target fix. So if you use `wasm-browser`, **you inherit
it; do nothing.** If you use `wasm-node` (plain objects already), override with
an identity to skip the walk:

```ts
protected override normalizeAction(action: Action): Action {
  return action;
}
```

> Historical note: this conversion used to live only in
> `@hypen-space/web-engine`, so every new web-target consumer rediscovered the
> `payload instanceof Map` landmine. It's now the base default.

---

## Worked example: the `initSync` (bytes-in) path

This is the pattern for workerd, Deno, or any embedder that gives you a
`WebAssembly.Module`:

```ts
import { BaseEngine } from "@hypen-space/core/engine-base";
import { setPortableImpl, type PortableImpl } from "@hypen-space/core/portable";
// The web-target glue + the compiled module (however your runtime supplies it):
import * as wasm from "hypen-engine";              // wasm-browser JS glue
import wasmModule from "hypen-engine/hypen_engine_bg.wasm"; // a WebAssembly.Module

let initialized = false;
function ensureWasmInit(): void {
  if (initialized) return;
  (wasm as any).initSync({ module: wasmModule as WebAssembly.Module });
  installPortable();   // bind setPortableImpl to wasm's diffPaths/matchPath/...
  initialized = true;
}

// Install eagerly at module load so portable is ready before any defineState.
ensureWasmInit();

export class MyEngine extends BaseEngine {
  constructor() {
    super();
    ensureWasmInit();
    this.wasmEngine = new (wasm as any).WasmEngine();
    this.wasmEngine.registerDefaultPrimitives();
    this.initialized = true;
  }
  async init(): Promise<void> {/* no-op: constructor did it */}
  protected unwrapForWasm<T>(value: T): T { /* as above */ return value; }
  // normalizeAction inherited from BaseEngine (web target → keep the Map walk).
}
```

See `examples/calorie-counter/cloudflare/src/engine.ts` for the full, working
`installPortable()` body.

---

## Do you actually need a new engine?

Often not. The protocol envelope (`hello` → `sessionAck` → `initialTree` →
streaming patches), nested-module registration, resource registration, and
router auto-wiring all live in **`RemoteSession`** (`@hypen-space/core/remote`),
which is transport- and engine-agnostic. To bring Hypen to a new place you
usually only need:

1. A **`SessionTransport`** (`{ send, close }`) over your wire.
2. A **`SessionHost`** built from your app config — its `createEngine()` returns
   your engine.
3. To forward inbound messages to `session.receive(msg)` and call
   `session.destroy()` on close.

`@hypen-space/cf`'s `HypenDurableObject` is ~250 lines of exactly this glue
around `RemoteSession`; a non-hibernating runtime is much smaller. Only write a
new `BaseEngine` subclass if your runtime needs a WASM target the three
existing wrappers don't cover.

---

## Checklist

- [ ] Pick the WASM target by how your runtime loads WASM (`wasm-node` vs
      `wasm-browser` + `initSync`).
- [ ] Subclass `BaseEngine`; implement `init()` and `unwrapForWasm()`.
- [ ] Install portable helpers via `setPortableImpl` at module-load time.
- [ ] Web target → inherit the `Map` normalization; node target → identity
      override.
- [ ] Reuse `RemoteSession` for the protocol instead of re-implementing it.
- [ ] Smoke-test with `validatePatches(patches, knownTypes)` to catch silent
      resolver misses (opaque component `elementType`s) — see
      `@hypen-space/core`.
