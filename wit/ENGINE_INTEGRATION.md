# Module hosting: architecture

How Hypen runs modules compiled to WebAssembly Components (the `hypen:module`
contract in this directory) inside the engine, next to modules written in the
host language. This is the map and the design rationale; the subsystem's
internals (file-by-file layout, invariants, failure types, binding tables)
are maintained in [`hypen-engine-rs/CLAUDE.md`](../hypen-engine-rs/CLAUDE.md)
and the module docs it points to. The contract itself:
[README.md](README.md). Authoring and the build pipelines:
[AUTHORING_MODEL.md](AUTHORING_MODEL.md).

## The model

- **One concept, two placements.** A module is the stateful controller behind
  a `.hypen` template. Its logic runs either in-process (a TypeScript, Go,
  Kotlin, Swift or Rust SDK module: closures registered with the engine) or
  as a **hosted** module: a WASM Component the engine calls through a
  `ModuleHost`. Templates, bindings (`@{state.x}`), actions (`@actions.x`),
  routing and nesting are the same for both, and both kinds share one engine
  and one state tree.
- **The engine owns the state; the module is a pure reducer.** Every call
  gets the scope's current state as JSON bytes and returns the new state. The
  engine replaces the scope's state wholesale and path-diffs old against new
  only to know which bindings to invalidate (`portable::diff`), so the
  reactive pipeline is the same one host-written state goes through.
  Consequences we rely on: a module cannot hide state between calls; a
  crashed instance is replaced by re-running `init`; hot reload swaps code
  without losing state; replaying actions reproduces a state stream.
- **Capabilities are imports, and grants decide links.** Storage tiers and
  HTTP are linked into a component only when its manifest grants them, so
  "what can this module reach" is answered from the manifest. Cross-module
  `read` / `dispatch` / `subscribe` cannot be decided at link time (any
  sibling name could be passed), so they are checked per call against the
  same manifest, and the engine checks again when it folds the output.
- **Hosts are libraries; renderers stay patch consumers.** Nothing about
  hosting reaches a renderer: a hosted module's state change produces the
  same patches as any other.

## Pieces

```
          .hypen template                  module.wasm (+ manifest / grants)
                │                                    │
                ▼                                    ▼
┌──────────────────────────────┐   ModuleHost   ┌───────────────────────────────┐
│ Engine (hypen-engine-rs)      │ ─────────────▶ │ wasmtime host (native)        │
│  EngineCore: IR, state,       │   register     │   WasmtimeHost   (v0.1)       │
│   reactive graph, reconcile   │   instantiate  │   WasmtimeHostAsync (v0.2)    │
│  HostedModules (src/hosted):  │   init         │   DualHost (sniffs the ABI)   │
│   grants, routing, cascade,   │   dispatch     ├───────────────────────────────┤
│   fold, subscriptions,        │   lifecycle    │ BridgedHost (engine in wasm32)│
│   deferred HTTP admission     │ ◀───────────── │   → JsModuleHost (JS, jco)    │
└──────────────────────────────┘  ReducerOutput  └───────────────────────────────┘
        │ patches                       ▲ effects (navigate, delay, http)
        ▼                               │ performed by the embedder
     renderer               hypen-runtime │ @hypen-space/server │ UniFFI embedder
```

| Piece | Where | Notes |
|-------|-------|-------|
| `ModuleHost` trait + value types (`ReducerOutput`, `Effect`, `ModuleManifest`, HTTP types) | `hypen-engine-rs/src/module_host/mod.rs`, `http.rs`, `aliases.rs` | Always compiled, no heavy deps, so the engine logic is testable with a scripted host |
| Engine side | `hypen-engine-rs/src/hosted/` | One `HostedModules` composed into `Engine` and, in server JS builds, into `WasmEngine`; it never takes `&mut Engine` |
| Native host | `hypen-engine-rs/src/module_host/wasmtime/` (`module-loader` feature) | One implementation generic over the ABI; sandbox model in its module docs |
| Bridged host | `hypen-engine-rs/src/module_host/bridged_host.rs` (`module-loader-bridged`) | The engine runs in wasm32 and cannot embed wasmtime, so a JS host does the hosting |
| JS host | `hypen-web/packages/module-host` | `JsModuleHost`: jco transpile at `prepare()`, link-time gating, scoped storage, deferred HTTP queue; v0.1 only |
| TypeScript server | `hypen-web/packages/server/src/hosted/` | Per-session instances, storage owners, performs HTTP effects, packages and drift checks |
| Reference runtime | `hypen-engine-rs/src/bin/hypen_runtime/` (`runtime-bin`) | REPL / `--serve` / `--app`; timers, HTTP worker pool, hot reload, crash recovery |
| UniFFI | `hypen-engine-rs/src/uniffi/module_host.rs` | `HypenModuleHost`: a bare host (no engine) for Kotlin / Swift embedders |
| Build and install | `hypen-cli/src/wasm/`, `hypen-cli/src/modules/` | `hypen build --target wasm`, `hypen pack`, `hypen add` / `remove` / `modules` |

## A dispatch, end to end

1. A renderer sends a UI event; it reaches the engine as a `__hypen_dispatch`
   envelope naming the node. Input that crossed a trust boundary (a Remote UI
   client) goes through `Engine::dispatch_client_action` first: the node must
   be live, attached and itself carry the binding, otherwise the action is
   refused. Same-trust-domain input uses `Engine::dispatch_action`. Trusted
   host code (timers, REPL) uses `dispatch_module_action(scope, name,
   payload)`. Nothing routes on a `scope:action` string.
2. The action resolves to a scope. A scope owned by a hosted instance drives
   the host: `dispatch(id, state, action)` with sibling snapshots for the
   scopes the module may `read`.
3. The **fold** applies the `ReducerOutput` in a fixed order: state (an
   unusable state rejects the whole output) → requested subscriptions →
   effects → deferred HTTP requests → follow-ups (`emit` to itself,
   cross-dispatch to granted scopes, subscriber notifications).
4. Follow-ups drain from one FIFO queue bounded by a depth cap and a
   per-dispatch budget. A failed follow-up is collected and reported after
   the queue is empty, in a `CascadeReport` (`Engine::last_module_cascade_report()`,
   JS `lastModuleCascadeReport()`), whose failures name the grant to add.
5. Dirty bindings re-render; patches go to the renderer.

In-process scopes take part in the same contract: a grant may name a scope
whose handlers are closures / JS handlers. `reads` hands over its state;
`dispatches` queues a cross-dispatch to its handler in the same FIFO, with
the sending scope as `sender`. Reserved `__hypen_*` actions are never
deliverable that way.

Scope aliases (`ModuleManifest::aliases`) let a module keep calling a sibling
by the name it was written with while the sibling lives under another scope
(a namespaced package internal, a renamed export, an app module a `map`
points at). The translation happens once, on the engine side of the host
boundary.

## Lifecycle integration

| Event | Engine | Host |
|-------|--------|------|
| Register | `register_module_instance(scope, id, grants)`: wires routing, grants, state slot | `register(name, bytes, manifest)` (compile once per byte hash; link per registration) → `instantiate` → `init(config)` → `actions()` |
| Activate / deactivate | `activate_module` / `deactivate_module`: runs the hook as a cascade root and folds its output | `on-activated(state)` / `on-deactivated(state)` |
| Hot reload | `rewire_module_instance`: new instance, **state kept**, own subscriptions dropped, in-flight HTTP of the old wiring dropped | `register` new bytes → `instantiate` → `on-activated(previous state)`; the old instance is destroyed |
| Crash | the dispatch fails (`module_crashed`) | instance is dead (`instance_status`); before the next action the embedder re-instantiates it and re-runs `init` from the original config, so the scope's state goes back to what `init` returns |
| Destroy | `destroy_module`: removes routing, grants, subscriptions in both directions, state slot | `on-destroyed(state)`, then the embedder calls `destroy(id)` |

`init` runs once per instance; re-entry is `on-activated` with the state the
engine kept. Subscriptions are registered from `dispatch` and from
`on-activated` output (not from `init`), so a module wires them on
activation. Which events fire when is the embedder's decision: the
TypeScript server activates a module when a session mounts it and gives each
session its own instances; `hypen-runtime` activates each module when it boots
it.

## Module discovery & registry

The engine does not find components; embedders hand bytes to
`ModuleHost::register`. Where bytes come from today:

- `hypen.json` `wasm.modules.<Name>.component` (a prebuilt `.wasm`) and
  `wasm.packages` (packages with a `hypen-modules.json` manifest, installed
  with `hypen add`, or `source` packages built from a folder), resolved by
  the CLI (`hypen-cli/src/wasm/packages.ts`) for `hypen dev` and the builds;
- `loadWasmPackage()` / `wasmModule()` / `loadWasmModules()` in
  `@hypen-space/server`;
- `app.json` (written by `hypen build --target wasm`) for `hypen-runtime --app`.

Integrity is a property of the package layer: the manifest carries each
component's SHA-256, and `hypen.lock.json` records what an app owner
reviewed (version, hashes, requests). A package that requests more, changes
bytes under the same version, or was never reviewed is refused before it is
registered.

`module_host::ModuleRegistry` / `BundledRegistry` (name + version → bytes)
exist from the original design but no embedder uses them yet; a
network-fetched registry would need signature checks and is not planned in
this release.

## Failure model

- A reducer returning `Err(string)` fails that action; state is unchanged and
  the instance lives.
- A trap or a call over its deadline kills the instance (`HostError::DeadInstance`
  afterwards). Embedders detect it with `instance_status`, never by parsing
  error text, and replace it before the next action.
- A refused link (ungranted import) is data: `denied_capabilities(name)`
  lists what the component needs and was not granted, so tools can print
  the grant to add.
- A refused deferred HTTP request never fails the dispatch that queued it; it
  completes as `ok: false` (`denied`) in the same cascade.

## Security posture

Deny-by-default grants, link-time denial for storage and HTTP, per-call ACLs
for cross-module access, `local` storage partitioned per module, strict URL
parsing with the allowlist applied at queue time, at admission and per
redirect hop, and authorization of client actions against the rendered tree.
On the native host every call is bounded in time (epoch interruption plus a
wall-clock timeout covering host calls) and every instance in total memory.
What this does not cover — DNS-level SSRF, the dev runtime's open loopback,
the JS host's unbounded CPU and its `wasi:cli` shims — is listed in the
[security model](../hypen-docs/content/docs/guide/wasm-module-security.mdx#what-is-not-protected).

## Design decisions

- **State in the engine, not in linear memory.** Keeping state in the module
  and sending deltas would break path-based reactivity and hide state from
  the engine. Rejected.
- **No UI export.** A module is logic only; its template is a `.hypen` file
  rendered by the engine, exactly as for in-process modules. A `view` export
  would force re-emitting UI on every change and put template machinery in
  every artifact.
- **Directed dispatch, not a broadcast bus.** Module-to-module traffic goes
  through `hypen:engine/state.dispatch(module, action)`, routed by the
  engine and checked against grants, so the dependency graph is explicit.
- **Effects for what a sandbox must not do itself.** `navigate`, `delay` and
  `emit` apply after the reducer returns; HTTP from a synchronous reducer is
  a queued request (`hypen:http/deferred`) completed as an action, so it
  works on hosts that cannot suspend a guest.
- **One `.wasm` per module.** Keeps per-module grants, independent hot
  reload and the cross-module model. Packaging several modules into one
  component is possible later as a build step.
- **Two contract versions side by side.** v0.1 (sync) is the default and
  frozen; v0.2 (Component Model async) lets a handler `await` capabilities
  inline. `DualHost` routes each component to its ABI, so apps mix them and
  nothing forces a cutover.
- **One compiled-code cache per engine**, keyed by the SHA-256 of the bytes
  only; linking (which depends on the manifest) happens per registration.

## Status and open items

*As of 2026-11-17.*

- **Async TypeScript modules (componentize-js gate): closed.** The v0.2 ABI
  is proven with Rust (`tests/fixtures/src/async-module`,
  `test_module_host_async`), but a TypeScript module cannot target it until
  componentize-js can bind a *custom* async host import and stops
  syncifying exports. Last verdict: 2026-07-04, jco 1.24.6 —
  `jco componentize` panics in `spidermonkey-embedding-splicer`
  (`bindgen.rs:713: not yet implemented`) on the async world. The CLI now
  pins jco 1.42.0, which has **not** been re-tested. How to re-test, and what
  "green" means for `hypen-cli/src/wasm/builders/ts.ts`:
  [AUTHORING_MODEL.md, "Async modules (v0.2)"](AUTHORING_MODEL.md#async-modules-v02).
- **Go / TinyGo: v0.1 only.** TinyGo has no `wasip3` target, so Go modules
  stay on `hypen:module@0.1.0` (fine: `DualHost` runs both). Go modules also
  cannot use `hypen:http/deferred` through the CLI yet: the `tinygo-module`
  world declares it, but no Go bindings or SDK helper are generated.
- **Blob storage is unimplemented** on every host (`unavailable`). `cloud`
  storage is an in-memory stand-in (not synced, not persisted).
- **v0.2 `wasi:http`.** Async modules would use `wasi:http/client@0.3.0`
  once wasmtime-wasi-http's p3 support is stable; until then they use
  `hypen:http/deferred` or p2 `wasi:http` on the native host.
- **The JS host runs v0.1 only**, synchronously (every async step happens in
  `prepare()`); storage there is localStorage / memory until jco async
  imports or JSPI allow IndexedDB. It does not bound a handler's CPU time or
  memory.
- **Platform hosts.** `HypenModuleHost` (UniFFI) is tested natively
  (`test_uniffi_host`); `hypen-host-kotlin/` is an experimental, unverified
  wrapper with stale generated bindings and no CI. No Swift host library
  exists yet. Cloudflare Workers cannot host modules (no runtime code
  generation); the browser SPA build refuses them.
- **Registry.** `ModuleRegistry` is unused (see above).
