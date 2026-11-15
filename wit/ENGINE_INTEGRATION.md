# Engine Integration Design — WASM Module Loader

How `hypen-engine-rs` hosts WASM Component modules implementing the
`hypen:module` world. Pre-implementation design pass — argue with this
before any Rust gets written.

Status: **draft v0.2 — core implemented.** Sibling document to
`wit/V0_2_NOTES.md`. This is the v1.0 cut of the engine-side loader.

> **Implementation landed (both native and browser paths).** Two
> `ModuleHost` implementations now exist on the engine crate, both wired
> into `Engine::dispatch_action`:
>
> - **Native:** `WasmtimeHost` behind the `module-loader` feature
>   (`hypen-engine-rs/src/module_host/wasmtime_host.rs`). Proven by
>   `tests/test_module_host.rs` (**10 tests**): reducer loop, lifecycle,
>   storage persistence, cloud compare-and-set, **link-time capability
>   denial**, the full **UI-action → WASM reducer → reactive patch** loop,
>   **cross-module read + directed dispatch with manifest ACLs**, and a
>   module calling `wasi:http` directly via `waki` to round-trip against a
>   one-shot TCP server.
> - **Browser:** `BridgedHost` behind the `module-loader-bridged` feature
>   (`src/module_host/bridged_host.rs`). When the engine itself runs in
>   wasm32 it cannot embed wasmtime, so module loading is delegated to a
>   JS shim (jco-based) via wasm-bindgen. Proven by
>   `wit-spikes/web-host/src/bridged-test.mjs`: `engine.wasm`'s
>   `WasmHostedEngine.dispatchAction("increment")` ×3 reaches the
>   jco-loaded counter through the bridge and the engine reports
>   `{count: 3}` — same `ModuleHost` trait, different impl, no embedded
>   runtime in wasm.
>
> Packaged for end users via the **`hypen-runtime` binary**
> (`src/bin/hypen_runtime.rs`, gated behind `module-loader`): a tiny CLI
> that hosts any `hypen:module` `.wasm` via `WasmtimeHost` in two modes:
>
> - **REPL** (default): stdin→action / stdout→state, for quick scripting
>   and CI.
> - **HTTP server** (`--serve PORT`): static client at `/`, `GET /state`,
>   `POST /dispatch`. A user opens their browser, types in actions via
>   buttons, and the engine reports updated state — no extra tooling.
>
> Proven by `tests/test_hypen_runtime.rs` (**9 tests**), including
> `runtime_hosts_a_module_that_does_real_http_via_wasi_http` (the binary
> loads `fetcher_module.wasm`; the module's `waki` call goes through
> `wasi:http` to a real local TCP server) and five `--serve` tests that
> spawn the binary, connect a tiny stdlib-only HTTP client, and assert
> the state endpoints + dispatch + error envelopes behave correctly.
>
> **Cross-language authoring proven across three languages**
> (Rust, TypeScript, Go — `wit-spikes/{stub,ts,go}-module/`). The same
> `hypen-runtime` binary loads counter modules written in each language;
> they produce the identical `{count, history}` state shape because the
> WIT contract is the unit of language-agnosticity, not the SDK.
> Verified by `runtime_drives_a_ts_authored_module_end_to_end` and
> `runtime_drives_a_go_authored_module_end_to_end` in
> `tests/test_hypen_runtime.rs`.
>
> Build-artifact sizes worth knowing before any SDK launch:
> - Rust counter: ~65 KB (no runtime).
> - Go counter (TinyGo): ~1 MB (TinyGo runtime).
> - TS counter (jco / componentize-js): ~14 MB (StarlingMonkey bundled).
>
> Each language's build pipeline has its own quirks (TS needs esbuild
> bundling because componentize-js doesn't follow imports; Go needs a
> `tinygo-module` extension world because TinyGo's runtime pulls in
> wasi:cli/* imports our base `module` world doesn't declare). These are
> *SDK polish* problems, not WIT-contract problems.
>
> **Hot reload** landed in `hypen-runtime --serve` via `notify-debouncer-mini`
> watching the .wasm path. On change the runtime calls `host.register` with
> the new bytes, `host.instantiate` for a fresh component, hands the
> previous state to `host.on_activated`, then `engine.rewire_module_instance`
> swaps the routing — **engine-side state is untouched**, so the new
> instance wakes up where the old one left off. Proven by
> `hot_reload_preserves_state_across_module_swap` in
> `tests/test_hypen_runtime.rs`: increment to count=3, rewrite the .wasm,
> assert state=3 after reload, increment again and assert state=4
> (proves the new instance is the one running, not a stale closure).
>
> **Self-describing actions** landed: the module world exports
> `actions: func() -> list<string>`, and every `ModuleHost` exposes
> `actions(id)`. The host queries it once after instantiation and wires
> routing automatically — `hypen-runtime` no longer needs `--actions`
> (now an optional override), and the browser client renders a button per
> discovered action. The module is the single source of truth. Proven
> across all three languages (the Rust/TS/Go fixtures each export it) plus
> `runtime_discovers_actions_from_module` and `actions_flag_overrides_discovery`
> in `tests/test_hypen_runtime.rs`, and through the bridge in
> `wit-spikes/web-host/src/bridged-test.mjs` (which passes `null` for
> actions and lets discovery run).
>
> What's *not* yet built: `Effect::Delay`, the network registry,
> DSL parsing + patches over the wire, wasmtime disk cache (helps
> cold-restart, not in-session reloads). See "Phasing" for the cut line.

Changes from v0.1:
- Pulled module manifests into v1.0 (was deferred). Without them, the
  "link-time capability denial" story was theatre.
- Pulled cross-module *reads* and *directed dispatches* into v1.0;
  *subscriptions* into v1.1. Anchored against the actual shape of
  today's `HypenGlobalContext` in `hypen-web/packages/core/src/context.ts`,
  including the TS-vs-Swift/Kotlin dispatch inconsistency the migration
  converges.
- Added Module Registry abstraction supporting both bundled and
  network-fetched modules. v1.0 ships bundled-only; network fetcher
  drops in behind the same trait in v1.1.
- Revised phasing estimates to be honest about scope (4-5w / 5-6w / 4w
  ≈ 14 weeks, not 10).

## Context

Today the engine knows how to:
- Parse Hypen DSL into an IR tree (`ir/`)
- Track reactive dependencies by path (`reactive/`)
- Reconcile and emit patches (`reconcile/`)
- Route `@actions.X` to a *host-provided callback* via
  `Engine::on_action(name, closure)` at `engine.rs:177`
- Apply state patches via `Engine::update_state(scope, patch)`
  at `engine.rs:243`

What it does not know how to do: **run module business logic itself.**
Today, when `dispatch_action` fires, control flies out to a host callback
(JS via wasm-bindgen, Swift/Kotlin via UniFFI, Go via WASI FFI). The host
implements the reducer, then calls back into the engine with state
updates.

The WASM module world inverts this: the module's `dispatch` function
lives in WASM and the *engine* calls it. The host stops implementing
reducers and starts implementing capabilities. This document is about
the slot in the engine that does the calling.

## The core abstraction: `ModuleHost`

One trait, two implementations.

```rust
// hypen-engine-rs/src/module_host/mod.rs (new module)

pub struct ModuleInstanceId(pub u64);

pub struct Action {
    pub name: String,
    pub payload: Vec<u8>,    // JSON bytes
}

pub enum Effect {
    Fetch(FetchEffect),
    Delay(DelayEffect),
    Navigate(String),
    Log { level: LogLevel, message: String },
}

pub struct ReducerOutput {
    pub state: Option<Vec<u8>>,
    pub effects: Vec<Effect>,
    pub emit: Vec<Action>,
}

pub trait ModuleHost: Send {
    /// Register a module type. Idempotent — repeat calls with the same
    /// name replace bytes (used by hot reload).
    fn register(&mut self, name: &str, component_bytes: &[u8]) -> Result<(), HostError>;

    /// Create a new instance of a registered module type.
    fn instantiate(&mut self, name: &str) -> Result<ModuleInstanceId, HostError>;

    /// Tear down. Engine calls this after on_destroyed.
    fn destroy(&mut self, id: ModuleInstanceId) -> Result<(), HostError>;

    /// Lifecycle + dispatch — straight passthrough to the WIT exports.
    fn init(&mut self, id: ModuleInstanceId, config: &[u8]) -> Result<Vec<u8>, HostError>;
    fn dispatch(&mut self, id: ModuleInstanceId, state: &[u8], action: Action) -> Result<ReducerOutput, HostError>;
    fn on_activated(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<ReducerOutput, HostError>;
    fn on_deactivated(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<ReducerOutput, HostError>;
    fn on_destroyed(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<(), HostError>;
}
```

`Engine` holds a `Box<dyn ModuleHost>` (set via constructor or
`Engine::with_module_host(host)`). Two concrete implementations:

- **`WasmtimeHost`** — native loader, embeds `wasmtime`'s component
  model runtime. Used in mobile (compiled to native lib), desktop, server.
- **`BridgedHost`** — calls into the embedder (JS) over wasm-bindgen.
  Used when engine itself is running in browser via `wasm/js.rs` — the
  engine can't embed wasmtime in WASM, so the JS host loads modules
  through jco and the engine reaches them via FFI.

The engine's internal model doesn't change between them. Same trait,
same calls, same state flow.

## State ownership

**Engine is canonical. Module is a pure reducer.**

This is the most important decision in the doc. Two options were on the
table:

1. State lives in module's linear memory; engine sees only deltas. Cleaner
   ownership but breaks `portable/diff.rs` (path-based reactivity needs
   the full state tree).
2. State lives in the engine; module gets it as a function argument.
   Module is pure. Engine path-diffs new vs old.

We pick (2). Reasons:
- `EngineCore` already holds per-module state under lowercased-name
  scopes (see `ModuleInstance` at `lifecycle/module.rs:106`).
- `portable/diff.rs` is built around having the full state on hand.
- Module sandboxing is stronger — module can't smuggle hidden state.
- Replay and time-travel debugging are trivial: re-feed actions to a
  fresh instance and the state stream reconstructs.

Concrete flow on every action:

```
1. UI fires `@actions.increment`
2. Engine::dispatch_action(Action { name: "increment", ... })
3. Look up module owning the action → action_scope_for("increment") → "counter"
4. Pull current state for "counter" from ModuleInstance ($state)
5. Serialize state to JSON bytes ($state_bytes)
6. host.dispatch(counter_id, &state_bytes, action) → ReducerOutput
7. If output.state is Some(new_bytes):
     a. portable::diff::diff(&state, &new_bytes) → Vec<StateChange>
     b. For each change: Engine::notify_state_change(change)
        (re-uses reactive/graph.rs marking dirty IR nodes)
     c. ModuleInstance::update_state_sparse(paths, new_state)
8. For each effect in output.effects:
     - Engine-native ones (Log, Navigate): handle inline
     - Host-delegated ones (Fetch, Delay): host.perform_effect(...)
9. For each follow-up action in output.emit:
     - Recurse into Engine::dispatch_action
10. render_dirty() → emit_patches() → renderer
```

The diff step in 7a is the only piece that doesn't exist today. The
engine has `portable::diff::diff` for path-level diffing but currently
the host calls it. Moving the call inside the dispatch path means we
need to ensure paths come out in a stable order that
`update_state_sparse` accepts.

## Module discovery & registry

The engine's `ModuleHost::register(name, bytes)` takes bytes — the
question is **where the bytes come from at runtime.** There are three
real sources, and v1.0 ships infrastructure for all of them via a
single trait, but only enables the first.

```rust
// hypen-engine-rs/src/module_host/registry.rs (new)

pub trait ModuleRegistry: Send {
    /// Resolve a module by name + semver-compatible version. Returns the
    /// raw component bytes ready to hand to `ModuleHost::register`.
    fn resolve(&self, name: &str, version: &str) -> Result<Vec<u8>, RegistryError>;

    /// Optional: list every module the registry knows about. Used for
    /// preloading at app startup.
    fn list(&self) -> Result<Vec<RegistryEntry>, RegistryError> {
        Err(RegistryError::NotSupported)
    }
}

pub struct RegistryEntry {
    pub name: String,
    pub version: String,
    pub source: ModuleSource,    // tags where this came from
}

pub enum ModuleSource {
    Bundled,         // shipped in the app binary
    Network(Url),    // fetched from a registry server
    Filesystem(PathBuf), // dev mode only
}
```

Three concrete implementations:

**`BundledRegistry`** — module bytes embedded in the app binary at
build time. `hypen-cli build` walks the app's module-instantiation
sites, collects the referenced `.wasm` files, and emits a static
manifest the engine consumes at startup. Resolution is a
`HashMap<(String, String), &'static [u8]>` lookup. Ships in v1.0.

- ✓ Offline-native; no fetch logic
- ✓ Module version = app version (no skew bugs)
- ✓ App-store-friendly; code-signed with the app
- ✗ Module updates require app submissions

**`NetworkRegistry`** — fetches from a registry URL on first use,
validates a signature, caches locally under a `hypen:storage/local`
namespace owned by the host. Ships in v1.1.

- ✓ Module updates without app submissions
- ✓ Offline works after first fetch (cache)
- ✗ Trust boundary moves to the registry server — TLS pinning + code
  signing required
- ✗ First-launch-offline UX needs fallback

**`FilesystemRegistry`** — reads `.wasm` from a directory. Dev mode
and server only. Ships in v1.0 behind `cfg(debug_assertions)`.

The interesting design choice is **chaining**. Production registries
combine sources:

```rust
pub struct ChainedRegistry {
    sources: Vec<Box<dyn ModuleRegistry>>,
}

impl ModuleRegistry for ChainedRegistry {
    fn resolve(&self, name: &str, version: &str) -> Result<Vec<u8>, RegistryError> {
        for src in &self.sources {
            match src.resolve(name, version) {
                Ok(bytes) => return Ok(bytes),
                Err(RegistryError::NotFound) => continue,
                Err(e) => return Err(e),
            }
        }
        Err(RegistryError::NotFound)
    }
}
```

Each module's manifest declares **which sources it's allowed to come
from** — see next section. The chain check is "first match wins,"
but the manifest gate runs first: a module declared `source = "bundled"`
that's missing from the bundle is an error, not a fallback to network.
This matters for security: critical modules (auth, billing) shouldn't
silently swap to a fetched copy if the bundle's tampered with.

## Module manifests

Each module ships with a manifest declaring its identity, the
capabilities it imports, and where its bytes are allowed to come from.
The host enforces the manifest at instantiation; mismatches fail.

```toml
# module.toml — colocated with the .wasm in the app bundle, or
# embedded as a custom WASM section for network-fetched modules.

[module]
name = "auth"
version = "1.4.0"
hypen-module-world = "0.1.0"   # which world version this targets

[source]
# Where the host is allowed to load this module from. Multiple values
# allow chained resolution; first match wins. Single-value pins.
allowed = ["bundled"]
# (Equivalent to: allowed = ["bundled", "network"] for a fetchable plugin.)

[capabilities]
# Storage scopes the module imports. "local" is implicit; named scopes
# must be listed here, otherwise instantiation fails.
storage = ["app", "cloud"]

# Cross-module access — see "Cross-module state" below. Empty means
# this module operates in isolation.
reads = ["session"]              # modules whose state this can read
dispatches = ["cart", "navbar"]  # modules this can dispatch actions to
subscribes = []                  # (module, path) pairs — v1.1 only

# Network access. v0.1 routes through Effect::Fetch which has no
# concept of origin; the manifest just gates whether Fetch is allowed
# at all. v0.2 swaps in wasi:http and we add per-origin allowlists.
network = "any"   # "none" | "any" | { origins = ["api.example.com"] }
```

The engine's `register` call gains a manifest argument:

```rust
pub trait ModuleHost: Send {
    fn register(
        &mut self,
        name: &str,
        bytes: &[u8],
        manifest: ModuleManifest,
    ) -> Result<(), HostError>;
}
```

At instantiation time, the host's `Linker` is built from the manifest:
storage scopes outside `manifest.capabilities.storage` are not added
to the linker, so the module's `import hypen:storage/app` fails to
resolve and instantiation errors. **This is link-time scope denial in
practice, not in slide deck.**

For v1.0, manifests are required and read from disk alongside each
bundled `.wasm`. The CLI synthesizes them from module-side annotations
(an `[hypen::module]` macro in Rust modules, or `package.json` fields
for TS modules generated via the SDK).

## Lifecycle integration

Engine treats module instances as having three states:

- **Active** — component instance loaded, state in engine, rendering.
- **Cached** — component instance still loaded, state in engine, not
  rendering (Router subtree cache).
- **Persisted** — component instance unloaded (memory reclaimed),
  state still in engine, can be rehydrated.

These map onto existing engine semantics:

| Engine state | Existing trigger                   | New WASM-side action               |
|--------------|-----------------------------------|------------------------------------|
| First mount  | IR tree creates module subtree    | `host.instantiate` + `host.init`   |
| Activate     | Router enters route               | `host.on_activated(cached_state)`  |
| Deactivate   | Router leaves route               | `host.on_deactivated(state)`       |
| Cache hit    | Router subtree cache (`Attach`)   | `host.on_activated(cached_state)`  |
| Cache evict  | Router LRU eviction               | `host.on_destroyed` + `host.destroy` |
| Unmount      | IR tree removes module subtree    | `host.on_destroyed` + `host.destroy` |

Note **`init` runs only on first mount.** Re-entry via cache hit or
rehydration calls `on_activated` with whatever state the engine had
cached. The module can detect "fresh start" by checking if state looks
default, but doesn't need separate `restore()` semantics.

Open question: **when persisted state is rehydrated, does the engine
call `init` again with the cached state as config, or directly call
`on_activated`?** Tentative answer: directly `on_activated`. `init` is
"compute initial state"; rehydration is "you already have state, just
wake up." Keeps the WIT surface minimal.

## Action dispatch — concrete changes

Touchpoints in current code:

- **`dispatch/action.rs:65`** (`ActionDispatcher`). Currently stores
  `HashMap<String, Box<dyn Fn>>`. Need a second handler kind:
  `Module(ModuleInstanceId)`. New enum:

  ```rust
  enum ActionHandler {
      Closure(Box<dyn Fn(&Action) -> Result<(), EngineError>>),
      Module(ModuleInstanceId),
  }
  ```

  Existing `Engine::on_action(name, closure)` keeps working. New
  `Engine::register_module_actions(module_id, action_names)` wires the
  Module variant.

- **`engine.rs:263`** (`Engine::dispatch_action`). Currently a one-liner
  delegating to `self.actions.dispatch`. New body branches on handler
  kind. If `Module(id)`, the engine pulls state, calls
  `host.dispatch(id, state, action)`, applies the result.

- **`engine.rs:243`** (`Engine::update_state`). Stays as is, just gets
  called from the new dispatch path. Public API doesn't change.

- **`lifecycle/module.rs:106`** (`ModuleInstance`). Gains optional
  `host_instance_id: Option<ModuleInstanceId>` field. Hosts wired to
  WASM modules set this; legacy callback-based modules leave it None.

## Cross-module state

This is the WASM translation of today's `HypenGlobalContext`. Survey of
the current code in `hypen-web/packages/core/src/context.ts`,
`hypen-server-swift/GlobalContext.swift`, `hypen-kotlin/GlobalContext.kt`,
and `hypen-golang/context.go` shows three things:

1. **State read** is consistent across every SDK:
   `context.getModule(id).getState()` — used in real apps
   (`hypen-web/example-bun/components/ProductsPage/component.ts:85`
   pulls `App` state to surface a cart count).
2. **Cross-module dispatch** is inconsistent. Swift and Kotlin expose
   `ModuleReference.dispatchAction(name, payload)`. TS does not — the
   ProductsPage example falls back to `context.emit("addToCart", ...)`,
   which is broadcast-to-all-listeners rather than directed dispatch.
3. **No access controls anywhere.** Any module can read any other; the
   `engine_core.rs:26` modules map is fully open.

The WASM migration is an opportunity to **converge on directed dispatch
across all hosts and add manifest-gated ACLs.** The broadcast `emit`
pattern is a workaround for missing primitives, not a feature.

WIT shape (lives in `wit/deps/hypen-engine/state.wit`, sibling to
`hypen-storage`):

```wit
package hypen:engine@0.1.0;

interface state {
    use hypen:module/types.{action};

    variant error {
        not-found,                // module doesn't exist
        permission-denied(string), // not in manifest's reads/dispatches
        module-error(string),     // target module's dispatch returned Err
    }

    /// Snapshot of another module's current state. Cheap — engine
    /// already has the bytes.
    read: func(module: string) -> result<list<u8>, error>;

    /// Send an action to another module's reducer. Replaces both
    /// today's TS `context.emit()` (broadcast) and Swift/Kotlin
    /// `ModuleReference.dispatchAction()` (direct) with one directed
    /// primitive. Goes through the target's reducer; never writes its
    /// state directly.
    dispatch: func(module: string, action: action) -> result<_, error>;

    /// (v1.1) Subscribe to changes at a path in another module.
    /// Engine fires `on-change` action on this module whenever the
    /// path is touched. Replaces no current pattern — TS Proxy magic
    /// doesn't translate across the WASM boundary.
    // subscribe: func(module: string, path: string, on-change: string) -> result<_, error>;
}
```

ACLs are enforced by the host against the manifest at every call:

```
host.state.read(module="auth")
  -> if "auth" in manifest.capabilities.reads { engine.module_state("auth") }
  -> else                                     { Err(permission-denied) }

host.state.dispatch(module="cart", action=...)
  -> if "cart" in manifest.capabilities.dispatches { engine.dispatch_action(scoped="cart", ...) }
  -> else                                          { Err(permission-denied) }
```

Crucially, `dispatch` here recurses into `Engine::dispatch_action` with
the target module's scope, runs *its* reducer, applies *its* state
delta. No module ever holds a writable handle to another's state. This
is a stricter contract than today's SDK (where Swift's
`dispatchAction` is technically directed but undocumented as such) and
fixes the TS `emit()` ergonomic gap.

**Migration note for existing SDKs.** Once v1.0 lands, the existing
TS `context.emit()` pattern in `ProductsPage/component.ts:85` gets a
proper translation: `context.getModule("App").dispatchAction("addToCart", {...})`.
The broadcast version gets deprecated and removed in a follow-up.

**v1.0 ships `read` + `dispatch`.** `subscribe` waits for v1.1 because
the reactivity wiring touches the existing graph in a way that needs
care (off-screen module subscribers shouldn't keep instances pinned in
the Router cache against eviction policy).

## Effect performance

Split by who owns the side-effect:

**Engine-native** (engine performs directly, no host call):
- `Log` → existing `crate::logger`
- `Navigate(path)` → existing `portable::route` + router IR node update
- `Delay { ms, then }` → engine starts a timer; on fire, dispatches
  `Action { name: then, payload: empty }`. Timer wheel lives in engine.

**Host-delegated** (engine asks host, host performs, dispatches result back):
- `Fetch { url, ..., on_success, on_failure }` → `host.perform_fetch(...)`
  returns a future; on completion, host calls back via
  `engine.dispatch_action(Action { name: on_success_or_failure, payload: response })`.

This split means **the engine can perform Log/Navigate/Delay even when
running in WASM with no host help.** Only Fetch needs the round-trip,
which matches reality: engine.wasm can't make HTTP calls.

(`Fetch` goes away entirely in v0.2 when modules import `wasi:http`
directly; see `wit/V0_2_NOTES.md` §1.)

## Capability provisioning

Module imports — `hypen:storage/{local,app,cloud}` and v0.2's
`wasi:http` — are wired by the **`ModuleHost` implementation**, not by
`EngineCore`. The engine doesn't know storage exists.

- **`WasmtimeHost`** uses wasmtime's `ComponentLinker` to bind storage
  resources to host implementations. Storage backend per platform:
  - Desktop/server: filesystem-backed (`sled` or plain
    `tokio::fs`-shaped wrappers).
  - iOS: bridges to `FileManager` / Keychain via UniFFI back to Swift.
    The UniFFI surface gains a `StorageProvider` trait the Swift side
    implements.
  - Android: same shape, bridges to JVM through UniFFI/JNI.

- **`BridgedHost`** delegates capability impls to the JS embedder
  entirely — engine.wasm calls into JS via wasm-bindgen, JS provides
  `hypen:storage/*` to jco at instantiation. The engine sees nothing.

So the storage WIT specs in `wit/` are implemented twice (once natively
in Rust, once in JS for the web path), and the engine is the consumer
of both via the trait. Clean separation.

## Errors, fuel, safety

Module misbehavior categories:

1. **Returns `Err(string)` from `dispatch`** — engine logs at warn
   level, drops the action, state unchanged. Same posture as today's
   callback errors.
2. **Component traps (panic, OOM, divide by zero)** — wasmtime returns
   `Trap`. Engine marks the instance as poisoned, surfaces a
   `EngineError::ModulePoisoned`, the next dispatch attempts a fresh
   instance restoring last-known-good state. If three rehydrations fail
   in a row, the module is permanently dead and route renders an error
   boundary.
3. **Infinite loop / runaway compute** — wasmtime `Store::set_fuel`
   with a per-dispatch budget. Default 10M units (single-digit ms on
   modern hardware). On exhaustion: same as trap.
4. **Memory exhaustion** — wasmtime's resource limiter. Default 64 MB
   per module instance, configurable.
5. **Time budget per dispatch** — wasmtime `epoch_interruption` with a
   wall-clock budget (default 100ms). Prevents a single action stalling
   the UI thread.

All of these are configurable via `EngineConfig::module_limits`. Defaults
are conservative enough for production; dev mode loosens them.

**Phasing within this section:** fuel (3) and memory (4) ship in v1.0.
Epoch deadline (5) and full trap-recovery rehydration (2) wait for
v1.1 — both need integration with the async timer wheel and instance
re-mount path that come in that cut.

## Native loader sketch

```rust
// hypen-engine-rs/src/module_host/wasmtime_host.rs

use wasmtime::{Engine, Store, component::{Component, Linker, Instance}};

pub struct WasmtimeHost {
    engine: Engine,
    components: HashMap<String, Component>,        // by module name
    instances: SlotMap<ModuleInstanceId, ModuleInstanceData>,
    linker: Linker<HostCtx>,
    config: HostConfig,
}

struct ModuleInstanceData {
    name: String,
    store: Store<HostCtx>,
    instance: Instance,
    // Resolved exports — cached so we don't re-look-up on each call.
    init_fn: TypedFunc<(Vec<u8>,), (Result<Vec<u8>, String>,)>,
    dispatch_fn: TypedFunc<(Vec<u8>, ActionWit), (Result<ReducerOutputWit, String>,)>,
    // ... lifecycle fns
}

struct HostCtx {
    wasi: wasmtime_wasi::WasiCtx,
    storage: StorageProviderHandle,    // user-provided
    table: wasmtime::component::ResourceTable,
}

impl ModuleHost for WasmtimeHost {
    fn instantiate(&mut self, name: &str) -> Result<ModuleInstanceId, HostError> {
        let component = self.components.get(name).ok_or(HostError::UnknownModule)?;
        let mut store = Store::new(&self.engine, self.fresh_ctx());
        store.set_fuel(self.config.fuel_per_dispatch)?;
        let instance = self.linker.instantiate(&mut store, component)?;
        // ... cache typed funcs, insert into SlotMap, return id
    }

    fn dispatch(&mut self, id: ModuleInstanceId, state: &[u8], action: Action) -> Result<ReducerOutput, HostError> {
        let inst = self.instances.get_mut(id).ok_or(HostError::DeadInstance)?;
        // Refuel before each call so previous calls don't deplete budget.
        inst.store.set_fuel(self.config.fuel_per_dispatch)?;
        let (result,) = inst.dispatch_fn.call(&mut inst.store, (state.to_vec(), action.into()))?;
        let output = result.map_err(HostError::ModuleError)?;
        Ok(output.into())
    }
}
```

Wiring is mechanical; the only judgement calls are storage-provider
shape and the WIT-to-Rust conversion between `ActionWit`/`Action`. Those
are generated by `wit-bindgen` from `wit/`.

## Web loader sketch

When the engine itself is running in WASM (`features = ["js"]`), it
can't embed wasmtime. The `BridgedHost` impl delegates everything over
wasm-bindgen back to JS.

```rust
// hypen-engine-rs/src/module_host/bridged_host.rs
// (compiled under `cfg(target_arch = "wasm32")` only)

#[wasm_bindgen]
extern "C" {
    type JsModuleHost;

    #[wasm_bindgen(method)]
    fn dispatch(this: &JsModuleHost, id: u64, state: Vec<u8>, action: JsAction) -> JsValue;
    // ... etc
}

pub struct BridgedHost {
    js: JsModuleHost,    // the JS shim provided by the embedder
}

impl ModuleHost for BridgedHost {
    fn dispatch(&mut self, id: ModuleInstanceId, state: &[u8], action: Action) -> Result<ReducerOutput, HostError> {
        let raw = self.js.dispatch(id.0, state.to_vec(), action.into());
        decode_reducer_output(raw)
    }
    // ...
}
```

JS side wires this against jco's instantiated module:

```javascript
class JsModuleHost {
  #instances = new Map();
  dispatch(id, state, action) {
    return this.#instances.get(id).dispatch(state, action);
  }
  // ...
}
window.__hypenModuleHost = new JsModuleHost();
```

Same shape as `wit-spikes/web-host/src/run.mjs`, just with a stable bridge
contract.

## Hot reload

Dev affordance. Mechanism:

1. File watcher (in `hypen-cli`) detects module .wasm change.
2. Calls `engine.module_host_mut().register(name, new_bytes)` which
   re-registers, bumping a version counter.
3. Engine notices version bump on next render tick. For each live
   instance of that module:
   - Snapshot state (already in engine).
   - `host.destroy(id)` the old instance.
   - `host.instantiate(name)` for a fresh one.
   - `host.on_activated(new_id, snapshot)` to wake it with prior state.
   - Replace `host_instance_id` in `ModuleInstance`.

State preserved across reload.

## Integration points — file by file

Concrete map of where each piece lands. Order is approximate dependency
order.

| File | Change |
|---|---|
| `module_host/mod.rs` *(new)* | Trait, types, error enum. |
| `module_host/wasmtime_host.rs` *(new)* | Native impl, behind `module-loader-wasmtime` feature. |
| `module_host/bridged_host.rs` *(new)* | Web impl, behind `module-loader-bridged` + wasm target. |
| `module_host/storage_provider.rs` *(new)* | Trait for platform-specific storage backends; impls live in SDK crates. |
| `module_host/registry.rs` *(new)* | `ModuleRegistry` trait + `BundledRegistry`, `FilesystemRegistry`, `ChainedRegistry`. `NetworkRegistry` slot in v1.1. |
| `module_host/manifest.rs` *(new)* | `ModuleManifest` struct, TOML parsing, validation against the world version. |
| `module_host/state_bridge.rs` *(new)* | `hypen:engine/state` capability — `read` + `dispatch` implementations against `EngineCore::modules`. |
| `lifecycle/module.rs:106` | Add `host_instance_id: Option<ModuleInstanceId>` and `manifest: Option<Arc<ModuleManifest>>` to `ModuleInstance`. |
| `dispatch/action.rs:65` | `ActionHandler` enum, two variants. |
| `engine.rs:55` | Add `Option<Box<dyn ModuleHost>>`, `Option<Box<dyn ModuleRegistry>>` fields. |
| `engine.rs:84` | Constructor variant `Engine::with_module_host(host, registry)`. |
| `engine.rs:153` | `register_module` gains a manifest argument; bytes come from registry. |
| `engine.rs:263` | `dispatch_action` branches on handler kind; new path drives the host. |
| `engine.rs` *(new method)* | `perform_effects(effects, scope)` — split engine-native vs host-delegated. |
| `engine.rs` *(new method)* | `apply_state_delta(scope, old, new)` — wraps `portable::diff` + `notify_state_change`. |
| `engine.rs` *(new method)* | `module_state_snapshot(name) -> Option<&[u8]>` — backing for cross-module `read`. |
| `Cargo.toml` | New deps: `wasmtime` (with `component-model` + `runtime`) behind feature; `toml`, `serde` for manifests. |
| `wasm/js.rs` | Plumbs `BridgedHost` constructor for the JS embedder to call. |
| `wit/deps/hypen-engine/state.wit` *(new)* | Cross-module read/dispatch capability WIT. |

## Phasing

Don't ship the whole thing at once. Three cuts, ~14 weeks total. Each
cut is independently shippable.

**v1.0 — foundation, ~4-5 weeks**

The minimum that's actually useful: real modules can be written, real
capability scoping is enforced.
- `ModuleHost` trait, `WasmtimeHost` impl
- `ModuleRegistry` trait, `BundledRegistry` + `FilesystemRegistry` impls
  (no network fetcher yet)
- `ModuleManifest` parsing + enforcement at linker construction
- **Multi-module support** (not single-module as previously scoped — the
  manifest + state-bridge work makes single-module a false economy)
- Full lifecycle (`init`, `dispatch`, `on_activated`, `on_deactivated`,
  `on_destroyed`)
- Storage: `hypen:storage/local` only, filesystem-backed via a
  `StorageProvider` trait
- Cross-module `hypen:engine/state.read` + `.dispatch` (no `subscribe`)
- Effects: `Log` + `Navigate`. `Fetch` and `Delay` queue but no-op.
- Conservative fuel + memory limits; no epoch deadline yet
- No hot reload
- Native targets only (desktop + server). Engine compiled for native
  paths; web path unchanged from today.

**v1.1 — production-ready native, ~5-6 weeks**
- `hypen:storage/app` + `hypen:storage/cloud` scopes
- Cross-module `subscribe` for reactive sibling-state observation
- `Fetch` (via reqwest) + `Delay` (via async timer wheel)
- Epoch deadline + per-module memory limits
- Hot reload in dev mode (Router cache interaction is the tricky part)
- Native iOS/Android via UniFFI gain `StorageProvider` surface that
  Swift/Kotlin impls
- `NetworkRegistry` slot for fetched modules; signature validation;
  cache eviction policy

**v1.2 — web, ~4 weeks**
- `BridgedHost` impl bridging `ModuleHost` calls to JS
- JS-side `JsModuleHost` class in `hypen-web/packages/web-engine`
- Capability impls in JS (productionize `wit-spikes/web-host`,
  IndexedDB instead of localStorage)
- Service worker integration for offline asset caching of bundled
  modules
- `engine.wasm` + `module.wasm` coexistence in browser

The previous "3 + 4 + 3 = 10 weeks" estimate was optimistic. Real
calibration anchored against the actual engine module layout
(`engine.rs` is 700+ lines, `engine_core.rs` is dense, the reactive
graph integration is non-trivial) puts each cut a week longer.

iOS perf risk is **not** in v1.0 because v1.0 doesn't ship to iOS;
moves to v1.1 with explicit go/no-go gate (see Open Questions §3
below).

## Open questions

Things still uncertain that should get explicit decisions before v1.0
lands:

1. **State serialization format.** WIT says JSON bytes. Faster
   alternatives (MessagePack, CBOR, postcard) would cut per-dispatch
   overhead, especially for large states. The WIT alias
   `type json = list<u8>` keeps the door open. Decide now or kick to
   v0.2 alongside the `value` variant?
2. **Async dispatch.** wasmtime supports async; our
   `ModuleHost::dispatch` signature is sync. Is that OK for v1.0, or do
   we need `async fn` right away? Implications for callsites in
   `engine.rs` are non-trivial.
3. **iOS perf go/no-go (v1.1 gate).** Action dispatch p99 needs to be
   <5ms on WasmKit interpreter for v1.1 to ship without an AOT
   pipeline. Microbenchmark a typical reducer call (parse JSON state,
   minimal work, return JSON state) on WasmKit before committing the
   v1.1 timeline. If >5ms, AOT-compilation path needs to land in v1.1
   alongside the bridged host, adding ~2 weeks.
4. **Per-module vs shared engine `wasmtime::Engine`.** Sharing saves
   compilation cost; per-module is more isolated. Tentative: share.
5. **Threading model.** Engine is single-threaded today
   (`thread_local!` in `wasm/wasi.rs`). wasmtime can be multi-threaded,
   but action dispatch is fundamentally sequential. Keep single-threaded
   for v1.0; revisit if/when we need parallel dispatch across modules.
6. **Manifest format: TOML vs custom WASM section vs both.** TOML
   alongside the `.wasm` is human-readable and editable, good for
   bundled modules. Custom WASM section is tamper-resistant and survives
   network transfer without a sidecar. v1.0 picks TOML; v1.1's
   `NetworkRegistry` needs the WASM-section path. Both eventually.

**Resolved since v0.1:**
- ~~Module manifests — deferred to v1.1.~~ Now in v1.0.
- ~~Cross-module state access — deferred to v1.1.~~ Read + dispatch in
  v1.0; subscribe in v1.1.
- ~~Module discovery hand-waved.~~ Registry trait + bundled impl in
  v1.0; network impl in v1.1.

## What this design rejects

For record-keeping — paths I considered and chose against:

- **Module state in linear memory, deltas across the wire.** Breaks
  reactivity. Rejected.
- **Embedding wasmtime via dynamic link instead of static.** Build
  complexity not worth the binary-size saving.
- **One `wasmtime::Engine` per module instance.** Wastes compilation;
  shared engine is fine.
- **Direct synchronous capability imports for everything in v1.0.**
  Storage stays sync (already is), Fetch goes through effect
  descriptors. Direct `wasi:http` waits for v0.2 per
  `V0_2_NOTES.md` §1.
- **Letting modules call each other directly.** Module-to-module is
  routed through the engine (`hypen:engine/state.dispatch` enters
  `Engine::dispatch_action` scoped to the target). Keeps the
  dependency graph explicit.
- **Broadcast event-bus dispatch (today's TS `context.emit`).** The
  WASM migration converges every host on directed dispatch
  (`hypen:engine/state.dispatch(module, action)`) — matches Swift/Kotlin's
  `ModuleReference.dispatchAction`, retires the TS `emit` workaround,
  no targets-of-emit-unknown ambiguity in the dependency graph.
- **Network-fetched modules in v1.0.** Bundled-only ships first because
  it's app-store-clean and offline-native. `NetworkRegistry` drops in
  behind the same trait in v1.1 without an API break.
- **Manifest enforcement at runtime via permission checks.** Scope
  denial is link-time (Linker omits the import) for storage, not a
  runtime `permission-denied`. The exception is `hypen:engine/state`
  where per-target-module ACLs need a runtime check — Linker can't
  enumerate every possible peer-module name ahead of time.
