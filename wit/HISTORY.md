# WASM module hosting: historical notes

> **Historical, and may be inaccurate.** This file archives the design and
> handover notes written while WASM module hosting was being built (mid 2026),
> before it was ported into this repository. They are kept for the design
> rationale and the record of decisions. Test counts, file paths (for example
> `wasmtime_host.rs`, `hypen_runtime.rs`, `WasmHostedEngine`, `wit-spikes/`,
> `pkg-bridged`), defaults (grant-all manifests) and routing rules
> (`Scope:action`) described below are superseded. For what is true today read
> [README.md](README.md), [ENGINE_INTEGRATION.md](ENGINE_INTEGRATION.md) and
> [AUTHORING_MODEL.md](AUTHORING_MODEL.md).

Contents:

- [Handover note from the original branch (WASM_ENGINE_HANDOVER.md)](#handover-note-from-the-original-branch-wasm_engine_handovermd)
- [Engine integration design, pre-implementation (ENGINE_INTEGRATION.md)](#engine-integration-design-pre-implementation-engine_integrationmd)
- [Authoring model and implementation log (AUTHORING_MODEL.md)](#authoring-model-and-implementation-log-authoring_modelmd)
- [v0.2 design notes (V0_2_NOTES.md)](#v02-design-notes-v0_2_notesmd)
- [wasmtime 37 to 46 migration (WASMTIME_46_MIGRATION.md)](#wasmtime-37-to-46-migration-wasmtime_46_migrationmd)

---

## Handover note from the original branch (WASM_ENGINE_HANDOVER.md)


Everything you need to resume the "make Hypen fully WASMable" work cold.

- **Branch:** `claude/wasm-engine-handover-knljuf` (pushed; supersedes
  `claude/wasm-engine-support-QQX3k`, which it contains).
- **Tree state:** green. Roadmap §5 steps 1–4 are landed on this branch: the
  wasmtime 46 bump, the real `hypen:module@0.2.0` async WIT (`/wit-v0_2`), the
  Rust reference module + `WasmtimeHostAsync` proof, and the componentize-js
  gate (instrumented; first verdict CLOSED at jco 1.24.6). Only the TS cutover
  (step 5) remains, blocked on that gate turning green.
- **Companion docs (read these for depth):**
  - `wit/AUTHORING_MODEL.md` — the design thesis + a running log of every landed feature.
  - `wit/V0_2_NOTES.md` — v0.2 design decisions, incl. the **async ABI draft** (§5).
  - `wit/WASMTIME_46_MIGRATION.md` — the wasmtime 37→46 bump: what worked, the blocker.

### 1. The model in one paragraph

A Hypen **module** is a stateful logic controller with two deployment targets from
the *same* authoring code: **in-process** (`hypen dev` / RemoteServer, full
Node/Go/JVM — use this for anything needing a DB driver, async, or a real library)
and **wasm** (`hypen build --target wasm` → sandboxed `.wasm` components, for
portable / offline / sandboxed-third-party logic). UI stays declarative `.hypen`,
rendered by the engine, in both. The wasm module is a **pure reducer** (`state, action
-> state-delta + effects`) plus capability imports (storage, cross-module state) and
Elm-style effect descriptors (navigate/delay) — see `wit/hypen-module.wit`.

### 2. What's landed (all verified + on the branch)

**Build pipeline — `hypen build --target wasm`** (`hypen-cli/src/build-wasm.ts`)
- TS (esbuild bundle → `jco componentize`), Go (`tinygo -target=wasip2`, app-mode +
  wit-mode), Rust (`cargo build --target wasm32-wasip2`). Emits `<Module>.wasm` +
  `<Module>.hypen` + `app.json`, runnable via `hypen-runtime --app`.
- Stateless sub-components (UI-only, no wasm instance).
- **Multi-module Rust** — crate-per-component; falls back to single-crate. (`a8d75fd`)
- Config-seeded `init`: TS/Go shims shallow-merge declaration-site config over
  `initialState`.
- Cross-module `context.getModule`/`getGlobalState`/`emit`/`on` wired to
  `hypen:engine/state` (sync surfaces), componentized against world `module-x`. (`832ba7e`)

**Reference runtime — `hypen-runtime`** (`hypen-engine-rs/src/bin/hypen_runtime/`, a
binary crate directory: `main.rs` is the table of contents — `cli`, `manifest`,
`usage_plan`, `app` (the `Runtime`), `patches`, `effects`, `timers`, `reload`, `server`,
`repl`, `error`)
- Modes: `--serve` (HTTP), `--app app.json` (multi-module), `--ui` (declarative UI), REPL.
- Manifest-driven **ACLs** (app.json `reads`/`dispatches`/`storage`), enforced by the host.
  app.json is parsed into a validated model: names must be engine-addressable and unique
  per (lowercased) scope, `ui`/`wasm` paths must resolve *inside the manifest directory*,
  `reads`/`dispatches` must name stateful modules of the same manifest.
- **Single-module mode is least-privilege too**: `local` storage only unless granted with
  `--grant-http` / `--grant-storage app,cloud` / `--grant-all`. An ungranted import fails
  at instantiation with a hint naming the flag (or the app.json field).
- Navigate/Delay **effects** (outbox + one timer thread over a min-heap; at most 1024
  pending timers per module).
- **`--serve` admission policy**: `Host` must be a loopback name with the server's port
  (DNS rebinding), a present `Origin` must be the server's own or one passed with
  `--allow-origin` (no wildcard CORS), POST bodies must be `application/json` and ≤ 1 MiB.
  Errors are `{ "error": { "code", "message", "hint"? } }` with a real status code.
- **Exact patch attribution**: a render is delivered to exactly one consumer — the
  `/dispatch` response that caused it, or the SSE stream (hot reload, timers). `GET /patches`
  is a snapshot of the current tree (bounded by the tree, not by history).
- **Crash recovery**: a trapped / timed-out instance fails its dispatch with
  `module_crashed`; the next action re-instantiates the module and re-runs `init` with its
  original config (its state is lost, logged loudly). `--call-timeout-ms` sets the per-call
  budget.
- Config-seeded `init` (declaration-site) + **usage-site config**: `Counter(start: 5)`
  in a parent seeds that instance; **per-usage instantiation** — distinct configs →
  distinct scopes (`counter`, `counter__a`), via template rewriting to synthetic
  component names (no engine change); **`key:` disambiguator** for identical configs. (`6d5bb00`)
- Server-side `.hypen` **hot reload** + **SSE browser push** (`GET /events`).

**Engine / host** (`hypen-engine-rs/src/module_host/`, `src/engine.rs`)
- `ModuleHost` trait; `WasmtimeHost` (native), `BridgedHost` (browser JS-delegated).
- Resource limits (`ModuleLimits`): per-call wall-clock deadline covering guest CPU (epoch
  interruption) *and* time blocked in host calls (async stores + `tokio::time::timeout`; a
  trapped/timed-out instance is dead), a total memory budget per instance, storage quotas.
- Storage isolation: `local` keys are partitioned by registered module name; `app`/`cloud`
  are shared between modules holding the grant.
- Cross-module `read`/`dispatch`/`subscribe` (`hypen:engine/state`), ACL-gated;
  `dispatch_depth` cycle guard; subscriptions folded from `dispatch` **and** `on_activated`.
- JS-bridged subscribe on `BridgedHost` — native path fully tested, and the wasm32
  build is now UNBLOCKED (the old `getrandom` toolchain issue no longer reproduces
  post-wasmtime-46 dep moves): `wasm-pack build --target nodejs --out-dir pkg-bridged
  --dev -- --features module-loader-bridged` builds, and the web-host spike's
  `node src/bridged-test.mjs` (spike since removed; ported into `@hypen-space/module-host`) passes end-to-end (engine.wasm → BridgedHost →
  JsModuleHost). The browser JS host now lives as a **standalone library** —
  `@hypen-space/module-host` (`hypen-web/packages/module-host`, TS, 33 unit tests):
  cross-module `read`/`dispatch`/`subscribe` with native-parity per-call ACLs, a
  runtime jco transpile pipeline (async `prepare()` transpiles registered bytes
  in-memory; Rust-facing calls stay sync), and the browser http gate (per-module
  import map — `http: false` withholds the wasi:http shims at link time; the
  `ManifestWire` carries the grant). The wit-spike re-exports the package's dist,
  so the spike harness proves the shipped library. Hosts are libraries; renderers
  stay pure patch consumers.
- **`wasi:http` egress is a manifest capability** (declare→grant→enforce, like storage):
  `ModuleManifest.http` / app.json `"http": false` skip the http linker at register
  time, so an importing module fails to instantiate — the pre-A5 security gate.
  Enforced on both hosts. Manifests are **deny-by-default**: an absent `http` is denied,
  absent `storage` is `local` only, absent `reads`/`dispatches` are none — grant with an
  explicit `"http": true` / `"storage": ["app", "cloud"]`.
- **Async modules can do real HTTP** (the constrained-data-access shape): the async
  host links the p2 `wasi:http` surface (async host implementation, driven by the host's
  own runtime; coexists with CM-async imports), and the async reference module's
  `fetch` action does a live GET + an awaited storage write in one reducer pass —
  `async_reducer_fetches_over_wasi_http`.
- **v0.1/v0.2 coexistence strategy: DualHost** (in `hypen-runtime`). No sync→async
  wrapping and no hard cutover needed: each registered component is sniffed and routed
  to its own native host; one `--app` mixes ABIs freely, and Go can stay on `@0.1.0`
  indefinitely while TS/Rust move.
- **Stdlib phase 1 (2026-07)**: `hypen:time@0.2.0` — first post-pioneer capability
  package (sync reads, CM-async `sleep-ms`, host-swappable **virtual clock** for
  deterministic replay; implicitly granted, virtualizable-not-deniable). Persistent
  storage: shared `module_host/kv.rs` backend with an atomic JSON snapshot flushed once per module call
  (`set_storage_path` on both hosts, `hypen-runtime --data-dir`, restart-survival
  proven end-to-end), cloud CAS intentionally still in-memory. Browser: the bridged
  host's `storage.mjs` auto-selects localStorage when present (sync like the v0.1
  imports; IndexedDB waits on jco async/JSPI). Growth policy: new stdlib packages
  target 0.2 only; 0.1 is frozen.

**Parser** (`parser/`)
- Identifiers may now contain digits (`Button2`, `H1`, `col2:`). (`15f843c`)

**Verification (all green):** `parser` 121/121 · `test_hypen_runtime` 32/32 ·
`test_module_host` 16/16 · `hypen-cli` build-wasm 10 pass / 4 skip. The real
jco/tinygo/cargo wasm builds are `HYPEN_WASM_E2E=1`-gated (disk-capped in CI sandboxes).

### 3. What's blocked (external / upstream — not effort)

- **Native async on the wasm target (the big one).** `onAction(async ({state}) =>
  await …)` compiling to wasm is the write-once unlock, but **gated on componentize-js /
  StarlingMonkey** shipping polished WASI-0.3 P3 authoring: today JS can `await`
  built-in `wasi:http` but **cannot bind a custom async host import**, and ComponentizeJS
  "syncifies" exports. Roadmap as of the 2026-05-27 wasmCloud call; **not shipped**.
  Watch componentize-js/jco release notes. Full analysis: the `wasi03-async-spike`
  workflow verdict (summarized in `AUTHORING_MODEL.md` → "WASI 0.3 async — spike verdict").
- ~~**wasmtime 37 → 46 bump.**~~ **LANDED.** The "bindgen blocker" was a `with`
  resource-key format change (`/resource` → `.resource`), not an include/world issue —
  see the rewritten `wit/WASMTIME_46_MIGRATION.md`. Host builds + full suite green on
  46.0.1; p3 async surface now available for the v0.2 work.
- ~~**Bridged-subscribe compile verify**~~ — RESOLVED (2026-07): the `getrandom`
  wasm32 issue no longer reproduces; the bridged wasm32 build compiles and the
  end-to-end bridged test passes in node. Kept here so nobody re-diagnoses it.

### 4. Deferred (in our control, but marginal)

- ~~**Hot-reload synthetic-scope regeneration**~~ — **DONE.** The `--app` watcher keeps
  pristine sources, re-runs `plan_per_usage` on every `.hypen` edit, and live-mints newly
  planned synthetic scopes (register + config-seeded init + activate) before re-rendering.
  Verified by `ui_hot_reload_mints_new_usage_scope_live`. Removed usages keep their
  instances until restart (harmless).

### 5. The async roadmap — the promotion checklist

This is the forward path. Do it **in order**, only starting the TS cutover when the gate clears:

1. ~~**Land the wasmtime 37→46 bump**~~ — **DONE.** The snag was the `with` key
   separator change (`/` → `.` before resource names), fixed in place; host stays on
   WASI 0.2/p2; `test_module_host` + `test_hypen_runtime` green on 46.0.1.
2. ~~**Draft → real WIT**~~ — **DONE.** `/wit-v0_2` (`hypen:module@0.2.0`, async storage +
   engine/state @0.2.0; blobs collapsed to `stream<u8>` blob-buckets; wasi:http deliberately
   NOT in the world — modules will use `wasi:http/client@0.3.0` host-side when wasmtime's p3
   http stabilizes). `@0.1.0` stays the default world. See `V0_2_NOTES.md` §5 addendum.
3. ~~**Prove with a Rust reference module**~~ — **DONE.** `hypen-engine-rs/tests/fixtures/src/async-module` +
   `WasmtimeHostAsync` (`module_host/wasmtime_host_async.rs`) + `test_module_host_async`
   (8/8): async exports awaiting custom async host imports (storage/CAS/cross-module),
   delta lands post-suspension in the unchanged `reducer-output` shape, ACLs + link-time
   denial + epoch timeout all hold. Sync host + fixtures untouched.
4. ~~**Instrument the gate**~~ — **DONE (and the gate is CLOSED).**
   A JS gate module + `test_async_gate_ts` (E2E-gated; both since removed from the repo): componentizes a JS module
   whose async exports `await` a custom async host import against `wit-v0_2`, then drives it
   on `WasmtimeHostAsync` under a deadline — behavioral, so a syncified-export hang also
   fails. First run (2026-07-04, jco 1.24.6): **closed at componentize** —
   `spidermonkey-embedding-splicer/src/bindgen.rs:713: not yet implemented` (`todo!()` on the
   async world). Re-run per jco release using the recipe and verdict log in
   `V0_2_NOTES.md` §5 ("componentize-js async gate").
5. **Flip TS** — only when (4) passes: in `build-wasm.ts` drop `--disable http`, enable
   async-export codegen, keep `--world-name module-x`; verify the real import list with
   `wasm-tools` (StarlingMonkey injects extra imports). The `onAction(async …)` body compiles
   unchanged — no author rewrites.
6. **Go stays on wasip2/0.1** — TinyGo has no wasip3 before ~2027; don't block TS on it.
   Single-source write-once holds for TS+Rust until Go catches up.

### 6. Build / test / verify

```bash
# Engine + native hosts (`module-loader` = the library hosts; `runtime-bin` =
# module-loader + the hypen-runtime binary's HTTP server / file watcher)
cd hypen-engine-rs
cargo build --features runtime-bin --bin hypen-runtime
cargo test  --features runtime-bin --bin hypen-runtime            # runtime unit tests (fake host, no wasm)
cargo test  --features runtime-bin --test test_hypen_runtime --test test_hypen_runtime_hardening
cargo test  --features module-loader --test test_module_host --test test_module_host_async
cargo clippy --features runtime-bin --all-targets

# Parser
cd parser && cargo test

# CLI (build-wasm codegen/detection is always-on; real wasm builds are gated)
cd hypen-cli && bun test tests/build-wasm.test.ts
HYPEN_WASM_E2E=1 bun test tests/build-wasm.test.ts   # real jco/tinygo/cargo builds

# Run a wasm app end-to-end (module files must sit next to app.json)
./target/debug/hypen-runtime --app path/to/app.json --serve 8080
# …or a single module; capabilities are opt-in
./target/debug/hypen-runtime counter.wasm --ui counter.hypen --grant-storage cloud --serve 8080
```

### 7. Environment gotchas (for CI sandboxes)

- **Disk is quota-capped (~39 GB).** A full wasmtime build + parallel targets will blow it.
  `cargo clean` frees the ~20 GB deps cache before a wasmtime version change; heavy parallel
  worktree builds are infeasible.
- **`.wasm` test fixtures are gitignored** — `git add -f` them (see `hypen-engine-rs/tests/fixtures/README.md`
  for the source dirs under `tests/fixtures/src/` and the rebuild commands).
- **jco / tinygo / cargo-wasm builds** are `HYPEN_WASM_E2E=1`-gated and often absent in
  sandboxes; codegen + detection are unit-tested without them.
- **wasm32 host build** (`module-loader-bridged`) — previously hit a transitive
  `getrandom` issue; resolved as of 2026-07 (builds clean with the stock toolchain,
  `rustup target add wasm32-unknown-unknown` + wasm-pack via `bun install -g wasm-pack`).

### 8. Where things live

| Area | Path |
|------|------|
| WASM build pipeline (TS/Go/Rust) | `hypen-cli/src/build-wasm.ts` |
| Reference runtime (`--serve`/`--app`/`--ui`) | `hypen-engine-rs/src/bin/hypen_runtime/` (`main.rs` lists the modules) |
| Native host (wasmtime) | `hypen-engine-rs/src/module_host/wasmtime_host.rs` |
| Browser host (JS-delegated) | `hypen-engine-rs/src/module_host/bridged_host.rs` |
| `ModuleHost` trait, effects, subscribe | `hypen-engine-rs/src/module_host/mod.rs`, `src/engine.rs` |
| WIT contract | `wit/hypen-module.wit`, `wit/deps/` (vendored into `hypen-cli/wit{,-tinygo}/`) |
| Module fixtures | `hypen-engine-rs/tests/fixtures/` (sources in `tests/fixtures/src/`) |
| Design + status | `wit/AUTHORING_MODEL.md`, `wit/V0_2_NOTES.md`, `wit/WASMTIME_46_MIGRATION.md` |

---

## Engine integration design, pre-implementation (ENGINE_INTEGRATION.md)


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
>   JS shim (jco-based) via wasm-bindgen. Proven by the web-host spike's
>   `bridged-test.mjs` (spike since removed; the JS host and its bridged
>   test now live in `@hypen-space/module-host`). The bridge is part of
>   the one JS engine class: server builds of `WasmEngine`
>   (`js,device-broker,module-loader-bridged`) gain `setModuleHost` /
>   `registerHostedModule` / `dispatchModuleAction`, so hosted modules run
>   next to in-process JS modules in the same engine — same `ModuleHost`
>   trait, different impl, no embedded runtime in wasm
>   (`hypen-web/packages/module-host/tests/e2e-engine.test.ts`).
>
> Packaged for end users via the **`hypen-runtime` binary**
> (`src/bin/hypen_runtime/`, gated behind `runtime-bin`): a tiny CLI
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
> (Rust, TypeScript, Go — `hypen-engine-rs/tests/fixtures/src/{stub,ts,go}-module/`). The same
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
> the web-host spike's `bridged-test.mjs` (which passes `null` for
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

### Context

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

### The core abstraction: `ModuleHost`

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

### State ownership

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

### Module discovery & registry

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

### Module manifests

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

### Lifecycle integration

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

### Action dispatch — concrete changes

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

### Cross-module state

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

### Effect performance

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

### Capability provisioning

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

### Errors, fuel, safety

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

### Native loader sketch

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

### Web loader sketch

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

Same shape as the (since removed) web-host spike's `run.mjs`, just with a stable
bridge contract; the productionized version is `@hypen-space/module-host`.

### Hot reload

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

### Integration points — file by file

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

### Phasing

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
- Capability impls in JS (productionize the web-host spike — done as
  `@hypen-space/module-host`;
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

### Open questions

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

### What this design rejects

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

---

## Authoring model and implementation log (AUTHORING_MODEL.md)


How the WASM-module path relates to the existing ("normal") Hypen app
model, and how to avoid the collisions between them. Written after mapping
the current `hypen-cli`, `@hypen-space/core`, and `@hypen-space/cf`
surfaces against the WASM-module work in `/wit` + `hypen-runtime`.

Status: **decision doc — now implemented.** The build surface
(`hypen build --target wasm`) is wired in `hypen-cli` for TypeScript, Go, and
Rust. TS and Go are write-once from the high-level authoring API (the same
`app.defineState()` / `core.NewApp()` code targets either the in-process
server or wasm); Rust is wit-authored (its idiomatic component path).
Stateless components work across all three (see "Build surface" below).

### The two collisions

#### 1. Command + noun (shallow)

- `hypen build` today (`hypen-cli/src/dev-bun.ts`) bundles a TS app into a
  **browser SPA** (`dist/main.js` + `index.html`). Takes no positional.
- The WASM path wants to "compile a thing to `.wasm`" — the *opposite*
  artifact. Overloading `hypen build <x>` would make one verb mean two
  artifacts.
- **"module"** already means host-language code
  (`app.defineState().onAction().ui().build()` → `HypenModuleDefinition`)
  that's discovered and dynamically imported, running **in-process**. The
  WASM "module" is a sandboxed `.wasm` the engine loads — same word,
  inverse architecture.
- **"component"** is *also* taken: in the DSL it's a UI element
  (`Text`, `Column` → `ComponentSpecification`, `register_component`).

So **both candidate nouns are already overloaded.** Introducing a new
`hypen module …` or `hypen component …` noun would worsen the confusion.

#### 2. Authoring API (deep)

- Normal module (`hypen-web/packages/core/src/app.ts`):
  `app.defineState({count:0}).onAction("inc", ({state}) => state.count++).ui(hypen\`…\`).build()`
  — couples **logic + UI template**, proxy-mutated state.
- WASM module (the spikes): `defineModule({initialState, actions})` —
  **logic only**, pure reducer, no `.ui()`. The `hypen:module` WIT world
  has **no view/ui export**; in every test the UI/IR was built host-side,
  never supplied by the module.

Cementing the reduced API would create a two-tier authoring experience
and quietly break the "DX doesn't regress" promise.

### The resolution

**A "module" is the stateful-logic controller — one concept, two
deployment targets.** Host-code (normal) or `.wasm` (portable / offline /
sandboxed-third-party). The only thing that differs between targets is
*where the logic runs*, which is exactly the choice the WASM work exists
to offer.

**UI stays declarative `.hypen`, rendered by the engine — in both
targets.** This is not a compromise; it's Hypen's existing separation of
declarative UI from stateful logic. `.ui(hypen\`…\`)` in `app.ts` merely
*co-locates* the template with the logic for convenience. Architecturally
the template is data the engine parses, reconciles, and binds:
`@{state.x}` against the module's state, `@actions.x` to the module's
dispatch.

Therefore **logic-only WASM modules are correct, not second-class.** A
portable Hypen app is:

```
module.wasm   — the stateful logic (init / dispatch / lifecycle / actions)
ui.hypen      — the declarative UI template
engine        — parses ui.hypen, renders, binds to module.wasm's state,
                routes actions to module.wasm's dispatch
```

We deliberately do **not** add a `view`/`render` export to the module
world. Pushing UI into the sandboxed logic artifact would:
- violate the UI/logic separation that the rest of Hypen relies on,
- force the React-style "re-emit UI on every state change" model that
  Hypen's reconcile-from-declarative-template design avoids,
- bloat every module artifact with template machinery.

#### What about the richer `app` API on the WASM target?

The **logic half** of `app.defineState().onAction()` maps directly onto
the WASM reducer (state + action handlers). The **`.ui()` half** is the
`.hypen` template, which simply ships alongside the `.wasm` and is loaded
by the engine — same as it is for a normal app. So the *same authoring
API* can target either deployment: the build step decides whether the
logic becomes host-code or a component, and the `.ui()` template is
emitted as a `.hypen`/IR asset either way. No reduced API required; the
spikes' `defineModule({…})` is just the not-yet-wired-up subset.

### Build surface: target, not a new noun

Disambiguate by **build target**, not by inventing an overloaded noun:

```
hypen build                       # default target: browser SPA bundle (unchanged)
hypen build --target wasm         # portable target: module.wasm + ui assets
```

- Keeps one verb, one mental model ("build my app"), with the *artifact
  shape* selected by `--target` — the same pattern as `GOOS`/`--target`
  elsewhere.
- `--target wasm` runs the per-language componentize pipeline
  (cargo+wit-bindgen / jco / tinygo; the per-language build commands are in
  `hypen-engine-rs/tests/fixtures/README.md`) for
  the logic, and emits the `.hypen` UI as a sibling asset.
- Leaves room for future targets (`--target cf`, `--target ios`) without
  more nouns.

(Final flag spelling is a product call; the load-bearing decision is
*target-based disambiguation*, not a `hypen module`/`hypen component`
noun.)

#### `hypen build --target wasm` — now implemented (TypeScript)

Wired in `hypen-cli` (`src/build-wasm.ts`, dispatched from `bin/hypen.ts`).
For each **stateful** component it discovers (the same
`discoverComponents` + `loadDiscoveredComponents` the dev server uses):

1. **Codegen** a generic WIT shim that adapts the module's
   `HypenModuleDefinition` (the output of
   `app.defineState().onAction().build()`) to the `hypen:module` reducer ABI
   — `init` / `dispatch` / lifecycle / `actions`. The author writes no WIT.
   Handlers mutate `state` in place exactly as in `@hypen-space/core`; the
   shim serializes the result. Async handlers, cross-module `context`, and
   data sources fail loudly (not yet bridged across the wasm boundary).
2. **Bundle** shim + user module + `@hypen-space/core` into one ESM file with
   esbuild, stubbing node built-ins (`fs`/`path`/…) that live in lazy core
   paths a reducer never runs, so the bundle targets WASI.
3. **Componentize** the bundle with `jco componentize … --world-name module`
   into a Component carrying the StarlingMonkey JS engine.

Output lands in `dist/wasm/`: `<Module>.wasm` + `<Module>.hypen` per module,
plus an `app.json` manifest — **directly runnable** by
`hypen-runtime --app dist/wasm/app.json`. The canonical WIT is vendored into
the CLI package (`hypen-cli/wit/`) so the published CLI is self-contained;
`jco` is resolved from the project's `node_modules` or fetched via
`bunx`/`npx`.

Verified end-to-end: a `Counter` authored with the real `app` API builds to
a valid component (`wasm-tools validate`) and dispatches through the engine
with minimal reactive `SetProp` patches. Unit-tested in
`hypen-cli/tests/build-wasm.test.ts` (shim codegen always-on; full
build gated behind `HYPEN_WASM_E2E=1`).

**Stateless sub-components are wired.** A component with a `.hypen` but no
companion module (a `Header()` / `Card()` building block) is emitted as a
UI-only asset; its `app.json` entry omits `wasm`. The `--app` loader
registers its template with the component resolver — so the entry composes
it by name — but creates no wasm instance or state scope. Stateless
components inherit the enclosing module's scope when rendered, exactly as in
the in-process model. Verified by
`app_renders_a_stateless_component_with_no_wasm` (runtime) and the
build-wasm e2e (CLI emits `Header.hypen` + a `wasm`-less manifest entry).

#### Go pipeline — now implemented

`hypen build --target wasm` detects a Go project (`go.mod`) and builds each
stateful component with the TinyGo pipeline: `wit-bindgen-go generate`
(bindings into `internal/bindings/`, once) then
`tinygo build -target=wasip2 -wit-world tinygo-module` per component. The CLI
vendors the TinyGo WIT (`hypen-cli/wit-tinygo/` — the `tinygo-module` world +
WASI 0.2.0 deps) so the build is self-contained; `tinygo` and
`wit-bindgen-go` must be on PATH.

Go components come in two shapes, auto-detected by package declaration:

- **app-mode (full parity)** — a `src/components/<Name>/` package (e.g.
  `package counter`) exporting `func Module() *core.ModuleDefinition` built
  with the high-level `core.NewApp(State{}).OnAction(...).Build()` authoring
  API. The CLI generates a Go WIT shim (the analogue of the TS shim) that
  adapts the definition to the reducer ABI: an action runs against an
  `ObservableState` rebuilt from the incoming JSON, and the snapshot is
  serialized back — identical behavior to a normal (RemoteServer) Go module.
- **wit-mode (advanced)** — `package main` implementing the `hypen:module`
  exports directly (the shape of the `hypen-engine-rs/tests/fixtures/src/go-module` fixture); built as-is.

**The parity this required.** `github.com/hypen-lang/hypen/hypen-golang` embeds a wazero
WASM runtime (`wasm_engine.go`/`portable.go`) and `net/http`
(`resolver.go`), none of which compile under TinyGo. Those three files are
now `//go:build !tinygo` (purely additive — normal builds are unchanged), and
`portable_tinygo.go` provides pure-Go implementations of the canonical
portable path/diff helpers (faithful ports of
`hypen-engine-rs/src/portable/{path,diff}.rs`) plus loud stubs for the
router/url/session helpers a pure reducer never reaches. So the **same**
`core.NewApp` code a developer writes for the RemoteServer target now also
compiles to a wasm component — true write-once parity with TS.

Verified end-to-end: a Go `Counter` authored with `core.NewApp().OnAction()`
builds to a valid component (`wasm-tools validate`) and dispatches through the
engine with minimal reactive patches (`count` 0→1→2→1). The standard
hypen-golang `go build ./...` + `go test ./...` still pass (build tags don't
touch normal builds). Unit-tested (language detection + Go mode
classification, always-on) and gated e2e (`HYPEN_WASM_E2E=1`, real tinygo
builds of both modes) in `hypen-cli/tests/build-wasm.test.ts`.

#### Rust pipeline — now implemented

`hypen build --target wasm` detects a Rust project (`Cargo.toml`), provisions
`wit/` from the CLI (so the conventional
`wit_bindgen::generate!({ world: "module", path: "wit" })` resolves), runs
`cargo build --release --target wasm32-wasip2` — Rust ≥1.82 emits a Component
natively, no wrapping — and copies the crate output to the entry's `.wasm`.
The crate (one `Cargo.toml`) is the single stateful entry module; every other
`src/components/<Name>/` `.hypen` is a stateless building block.

Rust is **wit-authored only**, and deliberately so: writing the module
against the WIT (`impl Guest`) is Rust's idiomatic component path, and there
is no `hypen init rust` convention. There is no app-mode shim because the
high-level `hypen-server` authoring API depends on `hypen-engine`, which
`compile_error!`s on any wasm build without the `js`/`wasi` feature and would
compile the whole engine into every module — so a `core.NewApp`-style shim
isn't practical for Rust. (TS and Go both have a friendly-API app-mode; Rust's
audience reaches for wit-bindgen directly.)

Verified end-to-end: a wit-authored Rust `Counter` builds to a valid ~50 KB
component (`wasm-tools validate`) and dispatches through the engine with
minimal reactive patches (`count` 0→1→2→1). Unit-tested (language detection +
`collectRustComponents`, always-on) and gated e2e (`HYPEN_WASM_E2E=1`, real
cargo build) in `hypen-cli/tests/build-wasm.test.ts`.

**Multi-module Rust — now implemented.** `collectRustComponents` auto-detects the
layout: any `src/components/<Name>/` with its own `Cargo.toml` is a stateful
module crate (built to `<Name>.wasm`), so a Cargo workspace with a crate per
module yields multiple stateful Rust components; a dir with only a `.hypen` stays
stateless. With no per-component `Cargo.toml` it falls back to the legacy
single-crate layout (root `Cargo.toml` = the entry module). `buildRustModule`
builds each module's own crate (checking both the crate-local and workspace-root
`target/`), and the WIT is provisioned into each crate dir. Detection is
unit-tested (`wasm-rust-multi` fixture); the real multi-crate build is
`HYPEN_WASM_E2E`-gated.

**Follow-ups:** Declaration-site config-seeded `init` is wired end-to-end — the
runtime passes config (see "Config-seeded `init`" below) and the CLI's generated
TS/Go shims shallow-merge it over `initialState`.

### The one technical gap this surfaced — now closed

The spikes proved the **logic** loop (state in, state out, reactive
re-render when the IR is built host-side). The missing piece was loading
a real `.hypen` UI file, parsing it to IR, and rendering it against a
WASM module's state. **That is now implemented** in `hypen-runtime`:

> `hypen-runtime app.wasm --ui app.hypen [--serve PORT]` — parses the
> declarative UI (`hypen_parser::parse_document` → `ast_to_ir_node`),
> renders it bound to the module's state, re-renders on dispatch. REPL
> prints the patches; `--serve` exposes them at `GET /patches`.

Proven by `ui_renders_declarative_template_against_wasm_module` in
`tests/test_hypen_runtime.rs` against `tests/fixtures/counter_ui.hypen`:

```
module counter {
    Column {
        Text("Count: @{state.count}")
        Button("@actions.increment") { Text("+1") }
    }
}
```

driving the logic-only `counter_module.wasm`. `@{state.count}` binds to
the wasm module's state; `increment` runs the wasm reducer and the engine
emits a **minimal SetProp patch** (`Count: 1` → `Count: 2`) on just the
bound Text node — not a re-create. End-to-end validation of "logic-only
module + declarative UI + engine renders."

Note: the `.hypen`'s `module <name>` must match the runtime scope
(`--scope`, default = the .wasm file stem) so bindings resolve against the
module's state slot.

#### `--serve --ui` in the browser — now closed

`--serve --ui` now renders a **live, clickable page** in the browser.
`POST /dispatch` returns the patch *delta* (`{state, patches:[…]}`); the
embedded client (`src/bin/hypen_runtime/client.html`) has a vanilla DOM
patch-applier that builds the tree from `GET /patches`, wires Button
clicks (via the `action` prop) to `/dispatch`, and applies each delta in
place. Proven in a real headless browser by
the web-host spike's `scripts/test-serve-ui.mjs` (spike since removed from the
repo): load → `#app` shows
`Count: 0` (from wasm state), click "+1" → `Count: 1` → `Count: 2`.
(The embedded applier is a minimal demo renderer; production would use
the full `@hypen-space/web` DOM renderer, which consumes the same patch
format.)

### Nested / multi-module apps — now wired (`--app`)

Real apps compose many modules — e.g. `module App { Router { Route("/") {
HomePage() BottomNav() } } }` referencing modules defined elsewhere
(exactly how `examples/social/components/App/component.hypen` works). This
now runs on the wasm target:

```
hypen-runtime --app app.json [--serve PORT]
```

`app.json` lists an `entry` module + `modules: [{name, wasm, ui}]`. The
runtime registers + instantiates each `.wasm` under its (lowercased) name
as the state scope, installs a **component resolver** mapping each name to
its `.hypen` source, and renders the entry. The engine's existing
component resolution + module-scope propagation (`ast_to_ir_node` tags
`module X` declarations) composes the tree — **each referenced module
renders bound to its own wasm instance's state.**

Proven by `app_composes_a_nested_module_with_its_own_scope` in
`tests/test_hypen_runtime.rs` (`tests/fixtures/app/`): an `App` entry whose
template references `Counter()` renders both "App scope count: 0" and
"Counter scope count: 0"; dispatching `increment` advances only the nested
Counter's state ("Counter scope count: 1") while App's stays put — two
independent wasm instances, two scopes, one composed tree.

The design choice from before is settled in favor of **one `.wasm` per
module** (the manifest is a list of components): no WIT change, keeps
per-module capability manifests + independent hot reload + the cross-module
`hypen:engine/state` model. Bundling several modules into one component
stays a future *build-time packaging* option (via wasm component
composition) that doesn't change this loading model.

#### Per-scope action routing — now closed

Routing is keyed by **`(scope, action)`**, not by bare action name, so two
modules exporting the same action name (e.g. two `Counter()`s, each with
`increment`) no longer collide. Who may name a scope depends on who is asking:

1. **Renderer input** (`Engine::dispatch_action`) is client-controlled and is
   resolved by the UI-envelope rules only: a `__hypen_dispatch` envelope
   carries the dispatching node's id and the engine derives the scope from
   *node ownership*; a bare name routes only when exactly one scope handles
   it (otherwise the dispatch errors with guidance instead of guessing).
   There is no `scope:action` qualifier on this path.
2. **Trusted host code** (REPL, timers resuming a `Delay`, server glue) names
   the scope explicitly with `Engine::dispatch_module_action(scope, name,
   payload)`. The reference runtime maps its operator conveniences onto these
   two: `Counter:increment` in the REPL / dev HTTP API goes through the
   trusted call, and a `sender` node id becomes a `__hypen_dispatch` envelope.
   The browser `dispatchAction(name, payload, scope?)` uses the trusted call
   when `scope` is given.
3. **Module follow-ups** (`emit`, cross-module dispatch, subscription
   `on_change`) are never routed by name string: `emit` stays in the emitting
   scope, and the others go to the scope the engine checked a grant for.

Proven by `qualified_actions_route_to_their_own_module_scope` and
`serve_app_routes_dispatch_by_sender_node_scope` in
`tests/test_hypen_runtime.rs`, and by `tests/test_module_host_routing.rs` /
`tests/test_module_host_cascade.rs` engine-side.

**`--app` loader — closed gaps.** Both former limitations are now resolved:

- *Hot reload* works in `--app` mode. The server watches every module's
  `.wasm` and, on change, swaps that scope's instance while preserving engine
  state (the fresh instance is woken via `on_activated`, not re-`init`-ed).
  Several scopes backed by the same file (two `Counter()`s) all reload from a
  single change. Verified by `app_hot_reload_preserves_state`.
- *`/state` and `/dispatch` report every scope* under a `states` map (the
  entry scope stays at `state` for back-compat), so a client sees sibling
  state, not just the entry's. Verified by `serve_app_state_reports_all_scopes`.

### Engine-native effects — Navigate + Delay now handled

`Effect::Navigate` and `Effect::Delay` were previously logged / warn-dropped by
`Engine::perform_effect`. The engine can't perform them itself (navigation
needs a router, delay needs a timer), so it now hands them to a host-installed
`EffectHandler` (`Engine::set_effect_handler`); with none installed, the prior
log-only behavior is preserved. `Log` stays engine-native; HTTP remains a
direct `wasi:http` import, not an effect.

`hypen-runtime` installs a handler that collects effects into an outbox drained
after each dispatch: **Navigate** surfaces the path in the `/dispatch` response
(`navigate: [...]`), and **Delay** spawns a timer that re-dispatches `then` to
the originating scope after `ms` — the Elm-style debounce/retry primitive
(chained effects from the delayed dispatch are drained too). Verified by
`navigate_effect_is_surfaced_in_dispatch_response` and
`delay_effect_reschedules_the_then_action` (fixture `hypen-engine-rs/tests/fixtures/src/effects-module`).

### Cross-module `subscribe` — now implemented

A module can observe a sibling's state and be re-invoked when it changes:
`subscribe(module, path, on-change)` in `hypen:engine/state`. The host records
it (gated by the `reads` grant — you may only observe what you may read) and
drains it into `ReducerOutput.subscribe_requests`, exactly like
`cross_dispatch`. The engine registers `(subscriber, target, path, on_change)`;
when the *target*'s dispatch produces a state diff that touches the watched
path (same path, a descendant, or an ancestor — see `paths_overlap`), it
re-dispatches `on_change` to the subscriber. A subscription fires on
*subsequent* changes, never the one that created it.

The three couplings the scoping flagged are handled:
- **Cycles and fan-out** — follow-ups drain from a FIFO work queue bounded by
  a depth cap (`MAX_CASCADE_DEPTH = 32`) and a per-dispatch reducer-invocation
  budget (`Engine::module_dispatch_budget`, default 1024). Hitting either is
  reported as an error once the queue has drained; it never hangs the host.
- **Lifecycle** — a scope's *own* subscriptions are cleared on
  `register_module_instance` / `rewire_module_instance` (hot reload), so a
  stale subscription can't fire on a replaced instance; `destroy_module`
  clears them in both directions (as subscriber and as target).
- **Registration site** — subscriptions register from the `dispatch` output the
  engine folds **and** from `on_activated`. The lifecycle path is now folded:
  `ModuleHost::on_activated` receives the sibling states, installs the ACL
  context, and drains the guest's subscribe/cross-dispatch queues, which the
  engine folds through the same depth-guarded path as a normal dispatch
  (`Engine::activate_module` → `fold_lifecycle_output`). So a module can wire its
  cross-module subscriptions once, on activation, instead of from an explicit
  action. (`init`-time output is still not folded — seed subscriptions from
  `on_activated`.)

Verified by `cross_module_subscribe_fires_on_sibling_change`,
`subscriptions_are_dropped_on_rewire`, and
`on_activated_subscribe_tracks_sibling_without_watch` (fixture
`hypen-engine-rs/tests/fixtures/src/xmod-module`: action `watch` and, equivalently, an `on_activated`
that both call `subscribe("counter", "count", "pull")`). The native
`WasmtimeHost` implements it end-to-end; the browser `BridgedHost` bridges the
subscribe requests to the JS host (decoding `subscribe_requests` and forwarding
them on the JS module-host shim, round-tripped in the since-removed web-host spike; the bridged shim now lives in
`@hypen-space/module-host` (`hypen-web/packages/module-host`)), though
the wasm32 host build itself is currently blocked by an unrelated toolchain
issue in a transitive dep.

**Friendly TS API now wired to the sync surfaces.** The generated `--target wasm`
shim's `context.getModule(id).getState()` / `getGlobalState()[id]` map to
`hypen:engine/state.read`, `context.emit` to `ReducerOutput.emit`, and
`context.on(module, path, onChange)` to `state.subscribe` (`onChange` is an
action name — the reducer ABI is stateless, so a live JS callback can't survive
across dispatches). The TS componentize step targets `--world-name module-x`
(base `module` + the state import; superset, no wasi:http, so `--disable http`
stays valid). Cross-module *writes* (`setState`) and async cross-module calls
stay unbridged until the WASI 0.3 async work. Codegen-verified in
`hypen-cli/tests/build-wasm.test.ts`; the jco→runtime e2e is `HYPEN_WASM_E2E`-gated.

### WASI 0.3 async — spike verdict (2026-07)

A research spike (jco/StarlingMonkey/wasmtime/TinyGo/WIT) assessed adopting native
WASI 0.3 async (`async func`, `stream<T>`, `future<T>`, Wasmtime 43+/jco 1.20+) so
the *same* `onAction(async ({state}) => await …)` compiles to both the in-process
and the wasm target — the write-once promise. **Verdict: not yet — keep the
effect-descriptor / sync-reducer model as the shipping interim; do the cheap prep
now, but do not cut TS over.**

- **The gate (unmet):** jco's StarlingMonkey can `await` *built-in* `wasi:http` on
  the 0.2 poll model, but it **cannot bind a custom async host import** (e.g. an
  async `hypen:storage`) from JS, and on the native P3 path JS promises don't yet
  drive component-model-async subtasks (the call hangs with an empty body). TS is
  Hypen's primary wasm path, so this is the whole decision. It's an explicit
  Q2-2026 componentize-js goal, not yet shipped polished.
- **Cheap/irrelevant fears:** the wasmtime **37 → 43+ (46.x) bump is LOW risk** —
  the host stays on WASI 0.2/p2; the only real edit is the wasi-http view refactor
  (`ctx()/table()` → a single `http() -> WasiHttpCtxView`, `add_only_http_to_linker_sync`
  under `wasmtime_wasi_http::p2::`). **TinyGo** has no wasip3 before ~2027, but was
  never on the critical path (async must land TS-first). **Rust is the happy path.**

**Prep plan (do now, decoupled from the TS cutover):** bump the wasmtime crates
(keep p2); draft `hypen:module@0.2.0` as a *parallel* async world (async
dispatch/lifecycle, async storage/state, `stream<u8>` blobs, import
`wasi:http/handler@0.3.0` directly, slim `effect` to host-only orchestration)
while keeping `@0.1.0` as the default; prove the async ABI shape with a **Rust**
reference module on the native async host; and instrument the gate — a smoke test
that componentizes a TS module which `await`s a *custom* async host import and
asserts it doesn't hang, re-run against each jco release. Flip
`build-wasm.ts` (drop `--disable http`, enable async-export codegen) only when
that gate passes. Full findings + risk register: workflow `wasi03-async-spike`.

#### hypen:module@0.2.0 async ABI — promoted + proven with Rust (2026-07)

WASI 0.3.0 shipped upstream, so the prep-plan's next two steps landed in one
go: the §5 draft from `V0_2_NOTES.md` is now a real package root at
`/wit-v0_2` (async reducer/lifecycle exports; async `hypen:storage@0.2.0` +
`hypen:engine/state@0.2.0`; blobs collapsed to `stream<u8>` blob-buckets;
wasi:http deliberately left out of the world, same stance as v0.1), and the
ABI is **proven end-to-end on the native host**: `hypen-engine-rs/tests/fixtures/src/async-module`
(wit-bindgen 0.57, plain `cargo build --target wasm32-wasip2`) awaits
storage warm-start/set/read-back, cloud CAS, and cross-module read/subscribe
*inline* in its reducers, and `WasmtimeHostAsync` drives it through
`Store::run_concurrent` + `block_on` behind the unchanged sync `ModuleHost`
trait — `test_module_host_async` 8/8, with ACLs, link-time scope denial, and
the epoch timeout all carried over. The engine's path-diff pipeline is
untouched: deltas arrive after suspension points in the same
`reducer-output` shape. **The TS cutover gate is now instrumented and
CLOSED**: a JS gate module + the E2E-gated `test_async_gate_ts` (both since
removed from the repo; re-test recipe in `V0_2_NOTES.md` §5)
drive a jco-componentized JS module (async exports awaiting a custom async
host import) on `WasmtimeHostAsync` under a deadline; the first run
(jco 1.24.6) died at componentize — the spidermonkey-embedding-splicer hits
`bindgen.rs:713 todo!()` on async worlds. Re-run per jco release; green
means flip `build-wasm.ts` (step 5). Full detail: `V0_2_NOTES.md` §5
addendum ("componentize-js async gate", with the verdict log).

#### Platform hosts: Kotlin/JVM library + Pulley (iOS answer) — landed (2026-07)

The mobile/desktop host story went from "not started" to two concrete
artifacts:

- **`DualHost` is a library type now** (`module_host/dual.rs`, promoted out
  of the `hypen-runtime` binary): the v0.1/v0.2 ABI-sniffing mux that every
  platform embedding should hold. `with_options(limits, strategy, data_dir)`
  is the full construction surface; the runtime binary consumes it.
- **`ExecStrategy::Interpreter` (Pulley) answers the iOS question**: modules
  compile to Pulley bytecode and interpret — zero executable pages, no JIT
  entitlement. The full reducer+storage loop and the epoch timeout pass under
  it (`interpreter_strategy_*` tests), so iOS can load modules DYNAMICALLY —
  no AOT-at-app-build compromise needed. The knob exists on both hosts and
  through every embedding surface.
- **UniFFI `HypenModuleHost`** (`uniffi/module_host.rs`): the FFI object
  Kotlin/Swift host libraries call — JSON-string convention, camelCase
  ReducerOutput wire (same shape as the JS host), config
  `{maxMemoryBytes, maxCallMs, interpreter, dataDir}`. Proven natively by
  `test_uniffi_host.rs` (both ABIs, persistence, interpreter, http denial).
- **`hypen-host-kotlin/`** — the standalone Android/JVM host library
  (renderers stay pure patch consumers): generated bindings + idiomatic
  `HypenHost`/`ModuleGrants`/`HostConfig` wrapper. Five JVM integration
  tests load the real `.so` via JNA and drive the real fixtures — the exact
  code path an Android app takes. Android-device delta: cross-compile the
  cdylib for the NDK targets (no code changes expected). The Swift twin
  (`hypen-host-swift`) follows the same recipe with `interpreter: true`.
- Consolidation note: `hypen-kotlin` (SDK, untouched) and this library each
  carry a copy of the generated `uniffi.hypen_engine` namespace; an app
  needing both in one process wants them consolidated into one shared
  artifact.

#### Browser host productionized + extracted to a standalone library — landed (2026-07)

Hosts are libraries now; renderers stay pure patch consumers. Four changes,
verified by an independent full-regression pass (all 7 surfaces green):

- **wasm32 bridged build unblocked** — the old `getrandom` toolchain issue no
  longer reproduces post-wasmtime-46. `pkg-bridged` builds via wasm-pack and
  the bridged E2E (`node src/bridged-test.mjs`: engine.wasm → `BridgedHost` →
  `JsModuleHost`, increments + subscribe round-trip) passes.
- **Runtime jco transpile pipeline** — `register` keeps the real component
  bytes; async `prepare()` transpiles them in-memory (`transpile()` from
  @bytecodealliance/jco, emitted bindings imported via a data: URL — no disk,
  browser-portable), then the Rust-facing surface stays fully sync. The
  pre-transpiled-stub hack is gone.
- **Browser http egress gate** — `ManifestWire` now carries `http` (from
  `grants_http()`; absent = granted for old engines), and the JS host builds
  the per-module import map at prepare/link time: `http: false` withholds the
  wasi:http/* shims and fails with an error naming the missing imports;
  granted modules get preview2-shim's fetch-backed http. Proven both ways
  against the real fetcher fixture (`scripts/test-http-gate.mjs`). Gotcha
  captured there: preview2-shim parks the main thread with `Atomics.wait`
  during the module's blocking poll, so test HTTP servers must live in a
  `worker_thread` or they deadlock.
- **`@hypen-space/module-host`** (`hypen-web/packages/module-host`) — the
  standalone TS library: `JsModuleHost` (register/prepare/instantiate/
  dispatch/lifecycle), per-call ACL context, transpile pipeline, http-gated
  import-map builder, storage backends (localStorage auto-detect + memory).
  33 bun unit tests; the wit-spike now thin-re-exports the package's dist, so
  the spike harness keeps proving the same code the library ships. The
  hypen-web workspace suite (1104 tests) stays green with the package added.

#### stdlib phase 1: hypen:time + persistent storage — landed (2026-07)

The capability spine (declare→grant→enforce, proven on storage/state/http)
now starts growing into an actual stdlib:

- **`hypen:time@0.2.0`** — the first post-pioneer package (`wit-v0_2/deps/
  hypen-time/time.wit`, mirrored in the CLI copy). Sync `now-ms` /
  `monotonic-ms`, CM-async `sleep-ms`. Imported by the v0.2 `module` world;
  implicitly granted like `local` storage but **virtualizable**: the host
  can swap in a counter clock (`WasmtimeHostAsync::set_virtual_clock`)
  where reads are exact and `sleep-ms` advances without waiting — the
  foundation for deterministic record/replay of reducer runs.
  `virtual_clock_makes_time_deterministic` asserts exact timestamps;
  `async_reducer_sleeps_on_real_clock` proves the task suspends through
  the component event loop for real. A real sleep suspends on the host's runtime
  and is cancelled — the call fails and the instance dies — if it outlives
  the per-call budget.
  v0.1 stays frozen — stdlib growth happens on 0.2 only.
- **Persistent storage on the native hosts** — the shared `KvBackend`
  (extracted to `module_host/kv.rs`, both hosts now use it) takes an
  optional snapshot path: `set_storage_path` loads what a previous process
  wrote, and `local`/`app` mutations are flushed atomically (tmp+rename
  JSON, values base64) once at the end of each module call. `local` data
  is partitioned by registered module name (module-private); `app` is
  shared between modules holding the grant; writes are quota-checked. `cloud` is deliberately NOT persisted — it simulates
  a sync service and stays memory until a real one exists.
  `hypen-runtime --data-dir DIR` wires it (`DIR/storage.json`, one backend for both ABI hosts);
  `data_dir_persists_state_across_runtime_restarts` kills the process and
  proves the next one warm-starts from disk.
- **Browser persistence for the bridged host** — `web-host/src/storage.mjs`
  (what `JsModuleHost` uses) now auto-selects a localStorage-backed store
  when the global exists (base64 bytes, `hypen-storage/` prefix), Map
  fallback in node. localStorage because it's sync like the v0.1 imports;
  IndexedDB waits for jco async/JSPI. `scripts/test-localstore.mjs` covers
  the branch under a shim; the playwright test still proves the demo
  page's reload warm-start in real Chromium.

#### wasi:http egress gate + async fetch + browser-host read — landed (2026-07)

Three follow-ups to the async promotion, one commit series:

- **Egress is now a manifest capability.** `ModuleManifest.http` (app.json
  `"http": false`) gates the `wasi:http` linker on BOTH hosts at register
  time — an importing module fails to instantiate, so "can this module reach
  the network?" is answerable from the manifest alone, exactly like storage.
  Manifests are deny-by-default (an absent `http` is denied, absent `storage`
  is `local` only — grant with `"http": true`); this is the security
  prerequisite for the eventual TS async cutover (which re-enables http for
  JS modules). Tests: `http_denied_module_fails_to_instantiate`,
  `http_denial_does_not_affect_non_importers`,
  `async_http_denied_module_fails_to_instantiate`,
  `app_manifest_http_false_denies_egress_at_boot`.
- **Async modules fetch for real** — the constrained-data-access shape on the
  wasm target: `WasmtimeHostAsync` links the p2 `wasi:http` surface (it
  coexists with CM-async imports; the sync wrappers run on their own tokio
  via `in_tokio`, so the host still needs no ambient runtime), and the async
  reference module's `fetch` action does a live GET (waki) *plus* an awaited
  storage write in one reducer pass — `async_reducer_fetches_over_wasi_http`.
- **Browser JS host grew native-parity cross-module `read`/`dispatch`**
  (then the web-host spike's `js-module-host.mjs`, now
  `hypen-web/packages/module-host/src/js-module-host.ts`): a per-call context installs
  sibling snapshots + manifest ACLs before each dispatch/on-activated and
  drains queued cross-dispatches/subscribes after, replacing the old
  throw-stubs. `subscribe` is now gated on the `reads` grant like the native
  host. (The wasm32 engine-build verify remains blocked on the `getrandom`
  toolchain issue.)

#### HTTP: blocking vs deferred

A module has two ways to make an HTTP request. Both need the manifest's
`http: true`; they differ in *who waits*.

| | Blocking — `wasi:http` | Deferred — `hypen:http/deferred` |
|---|---|---|
| Shape | the reducer calls its language's HTTP client and gets the response inline | the reducer calls `send(request, then, tag)` and returns; the response arrives later as the action `then` |
| Native host (wasmtime: `hypen-runtime`, Kotlin/Swift embeds) | works — the guest is suspended while the host does the I/O | works |
| Browser / JS host (jco) | **does not work**: a synchronous reducer cannot be suspended, the call traps | works |
| TypeScript-authored modules | unavailable (the TS build disables `wasi:http`) | the way to do HTTP: `context.http.send` / `get` (the CLI's per-module world lists the import for modules granted `http`) |
| Engine while the request is in flight | held for the whole exchange (bounded by the per-call deadline, 5 s by default) | free — only the two reducer runs hold it |
| Longest request | the per-call deadline | the request's own budget (default 30 s, max 120 s) |
| Response handling | whatever the client library does (streaming, any size the module can hold) | whole body, at most 4 MiB, as text or base64 in the action payload |
| Redirects | the guest's client issues each hop itself | followed by the host (up to 5) |

Rule of thumb: use **deferred** for anything that must run in a browser host
or from TypeScript, and for anything slow; use **blocking** when the module
only ever runs on a native host and wants the response inline (or streamed).

**The completion payload** is the contract of the deferred form (normative
text: the header of `wit/deps/hypen-http/http.wit`):

```jsonc
{ "ok": true,  "status": 404, "headers": { "content-type": "text/plain" },
  "body": "not found", "bodyEncoding": "utf8", "tag": "user-42" }
{ "ok": false, "error": { "kind": "timeout", "message": "…" }, "tag": "user-42" }
```

`ok: true` means an HTTP response was read, whatever its status; `ok: false`
means there is none, and `error.kind` says why (`network`, `timeout`,
`denied`, `too-large`, `invalid-response`). Header names are lowercased and
repeats joined with `", "`. `bodyEncoding` is `"utf8"` when the bytes are
valid UTF-8, else `"base64"`. Every accepted `send` gets exactly one
completion — a request refused after it was queued (a redirect to a host
outside the allowlist, the in-flight cap) completes as `denied` — so a
handler can always pair requests and answers by `tag`. A completion handler
is an ordinary reducer and may queue the next request.

```rust
// Rust guest (world `module-x`)
"load" => {
    http::send(&Request { method: "GET".into(), url, headers: vec![], body: None,
                          timeout_ms: None }, "loaded", Some("profile"))
        .map_err(|e| format!("{e:?}"))?;   // refused synchronously: bad URL, host not allowed, …
    state["loading"] = json!(true);
}
"loaded" => {
    let done: Value = serde_json::from_slice(&action.payload)?;
    state["loading"] = json!(false);
    if done["ok"] == true && done["status"] == 200 { state["profile"] = done["body"].clone(); }
    else { state["error"] = json!(done["error"]["kind"].as_str().unwrap_or("http status")); }
}
```

**The allowlist.** `httpHosts` in the manifest (`app.json`, or
`--grant-http-host` in single-module mode) limits `http` to hosts matching
one of its patterns: an exact host (`api.example.com`), a wildcard for
subdomains (`*.example.com` — any depth, not `example.com` itself), either
with a port (`localhost:8080`; no port = any port), or an IP literal. Absent
or empty = any host. It is enforced

1. by the host at `send` — the guest gets `permission-denied` naming the host;
2. by the engine when it folds the reducer's output, whatever the host did
   (`FailureCause::HttpDenied { host }`, code `httpDenied`);
3. by the embedder on every redirect hop (the request then completes as
   `denied`);
4. on the native host, for blocking `wasi:http` requests too (the request
   fails with `HTTP-request-denied`). A JS host's own `wasi:http` shim is
   only as strict as that shim: where it matters, grant `http` only to
   modules that use the deferred form.

URLs are parsed once, by the engine, with a deliberately strict grammar
(ASCII only, no `user:pass@`, no numeric-host spellings other than a dotted
quad), and the embedder connects to that parse — so the host that was checked
is the host that is contacted.

Implementation map: `hypen-engine-rs/src/module_host/http.rs` (types, bounds,
allowlist, payload), `module_host/wasmtime/deferred_http.rs` (native `send`
+ the `wasi:http` hook), `hosted/http.rs` (admission, requests in flight,
`Engine::complete_http_request`), `bin/hypen_runtime/http.rs` (the reference
client and worker pool). Tests: `test_module_host_http.rs`,
`test_hypen_runtime_http.rs`, `src/hosted/http_tests.rs`.

#### wasmtime 37 → 46 bump — now landed (2026-07)

The prep-plan bump is in: the native host runs on wasmtime 46.0.1 (still WASI
0.2/p2 at runtime, with the p3 async surface now available in-tree for the v0.2
work). The earlier "bindgen `with`+`include` blocker" turned out to be a
red herring — 46 changed the `with` resource-key format from
`pkg:iface/name/resource` to `pkg:iface/name.resource` (dot before the
resource), so the fix was rewriting 12 keys, no WIT restructuring. Full detail
+ verification matrix: `wit/WASMTIME_46_MIGRATION.md`. All suites green
(`test_module_host` 16/16, `test_hypen_runtime` 32/32 against the prebuilt
fixtures — guest ABI unchanged).

### Config-seeded `init` — declaration-site now implemented

`boot`/`boot_app` parse each module's `.hypen` **before** calling `init` and
pass the declaration-site args of a `module X(args)` root as JSON config:
`module Seeded(start: 7)` boots the reducer with `init({"start":7})` instead of
`{}`. Two runtime helpers (`parser_value_to_json`, `module_config_bytes`) turn
parser AST args into config JSON, emitting integral numbers as ints (`7`, not
`7.0`) so a `start: 7` arg round-trips as an integer. Verified end-to-end by
`config_seeds_init_from_module_declaration_args` (fixture
`hypen-engine-rs/tests/fixtures/src/seeded-module`, `init` decodes `config.start` → `{"count":7}`).

The CLI's generated shims complete the story on the authoring side: the TS shim
(`shimSource`) and Go shim (`goShimSource`) both shallow-merge the incoming
config over the module's static `initialState` in `init` — `module X(start: 5)`
overrides `start`, an empty/absent config leaves `initialState` untouched. The
Go merge happens at the JSON layer so `InitialState`'s Go type (struct or map)
doesn't matter. Covered by the always-on shim-codegen tests in
`hypen-cli/tests/build-wasm.test.ts`.

**Usage-site config** — a parent's `Counter(start: 5)` reference — is wired,
including **distinct config per usage** (`Counter(start: 5)` and
`Counter(start: 9)` in one tree → two independent instances). It's a runtime-only
change (`usage_plan::plan` in `src/bin/hypen_runtime/usage_plan.rs`); the engine is untouched.

Mechanism: before instantiating, `boot_app` scans every template for
argument-bearing references to a stateful module. Each *distinct* effective
config (the module's declaration-site default merged with a reference's args)
gets its own instance. The first needed config takes the base scope (the module's
own name) — the default when the module is the entry / referenced arg-less /
unreferenced, else the first configured reference, so the common single-config
case stays at the clean base scope (`counter`). Each additional distinct config
gets a synthetic scope: its references are renamed (splicing the parser's
`name_range`) to a synthetic component `Counter__a`, and a synthetic source (the
base template with its root `module` declaration renamed) is registered so the
engine's existing declaration-name→scope rule scopes it separately. The runtime
instantiates one wasm per scope, init'd with that config. Verified by
`usage_site_config_seeds_referenced_module_init` (single reference → base scope)
and `per_usage_configs_instantiate_distinct_module_instances`
(`Counter(start: 5)` + `Counter(start: 9)` → `counter` = 5 and `counter__a` = 9,
each independently dispatchable).

**Identical config, forced distinct** — now wired via a `key:` disambiguator:
`Counter(start: 5, key: "a")` and `Counter(start: 5, key: "b")` get two instances
despite identical config. `key` is stripped from the config before `init`
(`split_usage_key`) and folded into the scope-distinctness key (`distinct_key`),
so both still seed from `{"start":5}`. Verified by
`per_usage_key_disambiguates_identical_config_instances`.

Still open / limits (documented):
- ~~**Synthetic scopes are fixed at boot**~~ — **closed (2026-07).** The
  `.hypen` watcher now keeps the pristine sources separately (`UiReplan.raw`),
  re-runs `plan_per_usage` on every template edit, and **live-mints** any
  newly-planned synthetic scope (register + init with the usage-site config +
  `on_activated` wake) before swapping in the rewritten templates and
  re-rendering. Verified by `ui_hot_reload_mints_new_usage_scope_live`:
  adding `Seeded(start: 5)` to a running app materializes `seeded__a` at
  count 5, no restart. Remaining wrinkle: instances whose usage was *removed*
  stay alive until restart (harmless — nothing references them).
- **Synthetic scope naming** — synthetic names use letter suffixes (`__a`,
  `__b`, …). This originally dodged a parser limitation (identifiers couldn't
  contain digits), now fixed — so the letters are just a stylistic choice and
  could become `__1`/`__2` if preferred.

### UI (`.hypen`) hot reload — server-side now implemented

Editing a module's `.hypen` while `--serve`/`--serve --app` is running
re-renders the entry **server-side** and **pushes the delta to the browser**.
The `--app` UI sources are an `Arc<Mutex<HashMap>>` shared between the component
resolver (reads under lock) and a `.hypen` file watcher; on a template change
the watcher rewrites the changed module's source, calls
`Engine::clear_resolved_components`, re-parses the entry, and reconciles —
appending the delta to the same log `GET /patches` returns. The `.wasm` watcher
gained `UiReloadTarget`s alongside its `ReloadTarget`s; single-module `--ui` is
covered too. Verified by `ui_hot_reload_rerenders_entry_template_server_side`.

The push channel is **Server-Sent Events** at `GET /events`. Each connected
client parks a subscriber (`LiveStream.subscribers`); the render callback
broadcasts every *out-of-band* render — a hot-reload re-render, a delayed
effect's re-dispatch — as one `data:` frame, so the embedded demo client applies
it live via `EventSource` with no manual refresh. Dispatch-triggered re-renders
are **not** streamed: the `/dispatch` HTTP response already carries that delta,
and an `in_dispatch` flag (set around the engine dispatch) makes the render
callback skip broadcasting it, so a live client can't double-apply. `tiny_http`
one-shot `respond` can't hold a stream open, so `/events` uses `into_writer` to
own the raw socket on a dedicated thread. Verified by
`ui_hot_reload_pushes_rerender_over_sse` (raw SSE socket → edit `.hypen` → the
pushed `data:` frame carries the added Text).

Still open:
- **Production renderer** — the embedded client is a minimal demo applier; a
  production app would consume the same SSE frames through the full
  `@hypen-space/web` DOM renderer.

---

## v0.2 design notes (V0_2_NOTES.md)


Captures decisions made during the v0.1 spike that we want to act on in v0.2
but don't want to rush into v0.1. Append to this as more questions surface.

### 1. Adopt `wasi:http` directly  ✓ Landed in v1.0

**Status: implemented.** Modules use `wasi:http/outgoing-handler` directly
through their language's idiomatic client (Rust `waki`/`reqwest`, Go
`net/http`, JS `fetch`). `WasmtimeHost` wires `wasi:http` into the linker via
`wasmtime-wasi-http`. There is no Hypen-shaped HTTP API.

Proved end-to-end by `module_uses_wasi_http_for_real_http_round_trip` in
`hypen-engine-rs/tests/test_module_host.rs`: the fetcher fixture calls
`waki::Client::new().get(url).send()`, which compiles to wasi:http imports,
which wasmtime-wasi-http handles by issuing a real HTTP request to a local
TcpListener. The engine never sees the URL — only the resulting state
delta.

The original "effect descriptor for fetch" idea was scaffolding that would
have been ripped out for v0.2 anyway, so it's gone from v1.0 entirely. The
`Effect` enum in `hypen:module` now carries only `delay` / `navigate` / `log`
— things that genuinely don't have a WASI equivalent.

**Open questions still:**
- Preview 2 `wasi:http`'s pollable-based async is awkward for streaming
  bodies. Preview 3 fixes it. If preview 3 slips, decide whether to ship
  preview-2 ergonomics or wait.
- Per-host origin policy. Web enforces CORS, native doesn't. Should modules
  be able to declare an intended origin-policy at manifest level for
  cross-platform consistency?

### 2. Re-examine `hypen:storage` vs. `wasi:keyvalue` / `wasi:filesystem`

**Decision deferred to v0.2.** Today `hypen:storage` is custom because the
*scoping model* — particularly `cloud` with `compare-and-set` + sync
semantics — isn't covered by anything stable in WASI.

**Trigger to revisit:** if `wasi:keyvalue` adds versioning + scope or
`wasi:filesystem` lands a clean OPFS-shaped abstraction, switch. Custom
Hypen interfaces should only exist where the WASI standard genuinely
doesn't cover the use case.

**Smaller pieces to fix in v0.2 regardless:**
- Storage operations are sync in v0.1. Real backends (IndexedDB, OPFS,
  CloudKit, network sync) are all async. Either return `future<...>` types
  once preview 3 lands, or accept sync semantics and require host-side
  blocking adapters. Lean toward the former.

### 3. State shape: `json = list<u8>` -> structured `value` variant

**Decision:** keep `json` alias in v0.1 for simplicity; switch to a
structured `variant value { null, bool, integer, float, text, list, object }`
in v0.2 once the perf cost of per-action JSON parsing on the host side
becomes measurable.

**No breaking change to the module world** — `type json = value` then
becomes the migration. Module authors don't see it; only host parsing
behaviour changes.

### 4. Module SDK templates

**Decision:** v0.1 has no SDK package; users hand-write the
`wit_bindgen::generate!` invocation. For v0.2, ship per-language SDK
crates / packages that:

- Pre-bake the `generate!` macro / equivalent against the canonical wit/.
- Bundle a small `#![no_std]` allocator path for Rust so module size drops
  from ~66 KB to single-digit KB.
- For TS: a `defineState(...).onAction(...)` API that compiles down to the
  reducer ABI via build-time lowering. Users don't see WASM at all.

**Why this is in v0.2 and not v0.1:** premature SDKs encode v0.1 decisions
that may shift. Wait until the host-side implementation forces design
clarity, then ship SDKs that match.

### 5. Async dispatch ABI — `hypen:module@0.2.0` (WASI 0.3 draft)

**Status: PROMOTED — the real WIT lives at `/wit-v0_2` and the ABI is proven
end-to-end on the native host** (see the addendum at the end of this section).
The section below is kept as the original design rationale. From the `wasi03-async-spike` verdict:
adopting native WASI 0.3 async (`async func`, `stream<T>`, `future<T>`;
Wasmtime 43+/jco 1.20+) is the write-once unlock — the *same*
`onAction(async ({state}) => await …)` compiles to both the in-process and the
wasm target — **but the TS cutover is gated** on componentize-js/StarlingMonkey
shipping polished P3 authoring (today JS can `await` built-in `wasi:http` but
**cannot bind a custom async host import**, and ComponentizeJS "syncifies"
exports). So this world is drafted now to be ready; ship it only when that gate
passes. Rust is the happy path and can prove the shape first. See also
`WASMTIME_46_MIGRATION.md` for the runtime bump (blocked on a `bindgen!` snag).

**The design move:** async `dispatch` collapses the Elm-style effect round-trip
for anything the module can do itself (HTTP, storage, a `delay` sleep), leaving
`reducer-output.effect` for only what a sandboxed module must *not* do directly
and that must apply transactionally *after* the reducer returns — router control
(`navigate`) and the post-reducer action bus (`emit`). `reducer-output` survives
unchanged in shape, so the engine's path-diff/reactivity pipeline
(`portable/diff.rs`) is untouched — it just receives the delta after suspension
points.

Sketch (illustrative — promote to a real `.wit` package when the gate clears):

```wit
package hypen:module@0.2.0;

world module {
    // State-producing exports become async so a handler can `await` capabilities
    // (storage, http, cross-module) inline and then return the delta — exactly
    // the in-process `onAction(async ({state}) => await …)` body, no descriptors.
    export init:           async func(config: json) -> result<json, string>;
    export dispatch:       async func(state: json, action: action) -> result<reducer-output, string>;
    export on-activated:   async func(state: json) -> result<reducer-output, string>;
    export on-deactivated: async func(state: json) -> result<reducer-output, string>;
    export on-destroyed:   async func(state: json) -> result<_, string>;
    export actions:        func() -> list<string>;   // pure metadata, stays sync

    // Module-owned async I/O: imported directly, manifest-gated (like storage).
    import wasi:http/handler@0.3.0;   // async client, stream<u8> bodies
    import hypen:storage/local@0.2.0; // ops become async func; blobs use stream<u8>
    import hypen:storage/app@0.2.0;
    import hypen:storage/cloud@0.2.0;
}

// Superset that adds cross-module state; its read/dispatch/subscribe also become
// `async func` (a sibling reducer is now async, so dispatch must await it).
world module-x { include module; import hypen:engine/state@0.2.0; }
```

`reducer-output` keeps `state` + `emit`; `effect` slims to `navigate` (+ optional
`delay`/`log` for determinism/zero-import portability). HTTP is imported directly
(`wasi:http/handler@0.3.0`) rather than wrapped in a bespoke `hypen:http`, matching
the existing "standard WASI surface is between module and runtime" stance, and
gated the same way storage is (a manifest grant).

**Promotion checklist (do in order when the gate clears):** ~~land the wasmtime
37→46 bump~~ (done) → ~~prove this ABI with a Rust reference module on the
native async host~~ (done) → add the componentize-js smoke test (TS module
`await`s a custom async host import, asserts no hang) → only then flip
`build-wasm.ts` (drop `--disable http`, async-export codegen) and cut TS over.

#### Promotion addendum — what actually landed (2026-07)

WASI 0.3.0 shipped (2026-06-11; wasmtime 46 hosts CM-async under the
default `component-model-async` feature), so the draft above was promoted:

- **`/wit-v0_2/`** — the real package root (`hypen:module@0.2.0` +
  `hypen:storage@0.2.0` + `hypen:engine@0.2.0` in `deps/`). A separate root
  because one WIT directory cannot hold two versions of the same package;
  `/wit` (v0.1) stays the default world.
- **Deviations from the sketch, both deliberate:** (1) `wasi:http` is NOT in
  the world — same stance as v0.1 (standard WASI surface is between module
  and runtime); async modules will use `wasi:http/client@0.3.0` (the p3
  outgoing path — `handler` in the sketch was the inbound side) once
  wasmtime-wasi-http's p3 surface stabilizes (experimental/semver-exempt in
  46). (2) the blob triple collapsed into a `blob-bucket` with `stream<u8>`
  get/put; hosts stub it while the wasmtime stream APIs mature. `effect`
  keeps `delay`/`navigate`/`log` for determinism + zero-import portability.
- **Reference module** — `hypen-engine-rs/tests/fixtures/src/async-module` (Rust, wit-bindgen 0.57,
  plain `cargo build --target wasm32-wasip2`): async `init` awaits a storage
  warm-start read; `dispatch` awaits set + read-back; cloud CAS, cross-module
  read, and `subscribe` from `on-activated` are all awaited inline.
- **Native async host** — `WasmtimeHostAsync`
  (`hypen-engine-rs/src/module_host/wasmtime_host_async.rs`): same sync
  `ModuleHost` surface, each call pumps `Store::run_concurrent` on the
  host's current-thread tokio runtime under the per-call timeout. WIT `async func` needs no bindgen options; the sync
  `actions` export is lifted with `exports: { "actions": async | store }`;
  instantiation goes through `instantiate_async`. Manifest ACLs, link-time
  scope denial, and the epoch timeout all carry over.
- **Proof: `test_module_host_async` 8/8** — deltas arrive after suspension
  points in the v0.1 `ReducerOutput` shape (path-diff pipeline untouched),
  warm-start persists across instances, CAS versions advance, per-call ACLs
  gate awaited reads, a runaway async dispatch still traps on the epoch
  deadline.

#### componentize-js async gate (checklist step 4)

**What it checks.** Whether `jco componentize` (componentize-js /
StarlingMonkey) can build a JS module against the CM-async
`/wit-v0_2` `module` world such that an `async` export that `await`s a
*custom* async host import completes. That is the capability
componentize-js has historically lacked: it can await built-in `wasi:http`
but not bind a custom async import, and it syncifies exports. The gate is
**behavioral**: componentize succeeding is not enough, because a
syncified export can still hang at the sync-lowered import, so the built
component must be driven on `WasmtimeHostAsync` under a hard deadline.
Green = start the TS cutover (step 5: drop `--disable http` in
`hypen-cli/src/build-wasm.ts`, enable async-export codegen); red = do not
flip.

**Last verdict: CLOSED.** 2026-07-04, jco 1.24.6: `jco componentize`
panics before codegen with `spidermonkey-embedding-splicer/src/bindgen.rs:713:
not yet implemented` (a `todo!()` hit while splicing bindings for the
`async func` world). Watch that file upstream. Only the TS cutover itself
(step 5) remains, and it stays blocked until a jco release passes.

**How to re-test.** The gate module (formerly the `async-gate-ts` spike) and its
runner (`hypen-engine-rs/tests/test_async_gate_ts.rs`, `HYPEN_WASM_E2E=1`)
were removed from the repo with the rest of the spikes; recreate them from
git history (the commit that removed the WIT spikes directory) or from this
recipe:

1. A single-file `module.mjs` implementing the v0.2 `module` world: import
   `{ Bucket } from "hypen:storage/local@0.2.0"`; `async init` does
   `await Bucket.open("persistent", "gate")` + `await bucket.get("count")`
   (default `{"count":0}`); `async dispatch` for `increment` computes
   `count + 1`, then `await bucket.set("count", …)` and returns the
   `await bucket.get("count")` echo as `state`; `onActivated` /
   `onDeactivated` return `{ state: undefined, effects: [], emit: [] }`;
   `onDestroyed` is empty; sync `actions()` returns `["increment"]`.
2. Build with the latest jco (`bun add -d @bytecodealliance/jco@latest`):
   `jco componentize module.mjs --wit <repo>/wit-v0_2 --world-name module
   -o async_gate.wasm --disable clocks --disable random --disable http`
   (do NOT prune the storage imports, they are the object under test).
   A componentize failure is itself a "closed" verdict.
3. Drive it natively (`--features module-loader`): `WasmtimeHostAsync`
   with `ModuleLimits { max_call: 60s, .. }`, `register("gate", …,
   ModuleManifest::all("gate"))`, `instantiate`, `init(b"{}")`, then
   `dispatch(increment)`; open only if the returned state is `{"count":1}`.
   Failing at register/instantiate/init/dispatch, or hitting the deadline,
   means closed.

Append each run to the verdict above (date, jco version, where it died).

---

## wasmtime 37 to 46 migration (WASMTIME_46_MIGRATION.md)


Status: **DONE — landed.** The host now builds and passes its full suite on
wasmtime 46 (`test_module_host` 16/16, `test_hypen_runtime` 32/32 against the
prebuilt `.wasm` fixtures, so guest ABI compatibility is verified too). The
host stays on WASI 0.2 (p2); this bump was prep so the WASI 0.3 (p3) async
surface in 46 is available when the async ABI work starts.

### The changes that landed

`hypen-engine-rs/Cargo.toml`: `wasmtime`, `wasmtime-wasi`, `wasmtime-wasi-http`
`"37"` → `"46"` (resolves to 46.0.1).

`src/module_host/wasmtime_host.rs`:

1. **wasi-http view refactor** — p2 types moved under `p2::`:
   - `use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpView};`
     → `use wasmtime_wasi_http::WasiHttpCtx;`
     + `use wasmtime_wasi_http::p2::{WasiHttpCtxView, WasiHttpView};`
   - The `WasiHttpView` impl collapses from the `ctx()` + `table()` pair to a
     single `http()` returning a view struct, which in 46 also carries a
     `hooks` field (customization points for e.g. `send_request`; the default
     is fine for us):
     ```rust
     impl WasiHttpView for HostState {
         fn http(&mut self) -> WasiHttpCtxView<'_> {
             WasiHttpCtxView {
                 ctx: &mut self.http,
                 table: &mut self.table,
                 hooks: wasmtime_wasi_http::p2::default_hooks(),
             }
         }
     }
     ```
   - `wasmtime_wasi_http::add_only_http_to_linker_sync`
     → `wasmtime_wasi_http::p2::add_only_http_to_linker_sync`.

2. **`bindgen!` `with` resource keys** — see below.

`wasmtime_wasi::p2::add_to_linker_sync` and the `WasiView` / `WasiCtxView`
imports from `wasmtime_wasi` root are unchanged on 46.

### The former blocker, root-caused: `with` key separator changed `/` → `.`

The first migration attempt hit:

> interfaces were specified in the `with` config option but are not referenced
> in the target world: [... all 12 `hypen:storage/{local,app,cloud}/{bucket,blob-*}` ...]

and was mis-diagnosed as a behaviour change in how `include`d imports interact
with resource remapping (the `used_with_opts` bookkeeping in
`wasmtime-internal-wit-bindgen`). The actual cause is much simpler: **the
`with` key format for resources changed.** Through wasmtime 37,
`"hypen:storage/local/bucket"` (slash before the resource name) matched; in 46
`lookup_keys` builds resource candidates as `<interface-id>.<resource>` — a
**dot** before the resource name (see `Name::lookup_key`, which appends
`"." + item`, and the bindgen examples:
`"example:imported-resources/logging.logger": MyLogger`). Slash-form keys are
never generated as candidates, so they sit unmatched and `finish()` reports
them as unused.

Fix (one-line-per-key): rewrite the `with` map to dot form —

```text
"hypen:storage/local/bucket"  →  "hypen:storage/local.bucket"
```

No WIT changes were needed: `world module-x { include module; ... }` works
as-is; resources reached via `include` are remapped fine once the keys are in
the 46 format. (The earlier hypothesis — restructuring `module-x` to import
storage directly — was tested and made no difference; the separator was the
whole story.)

### Verification

```bash
cd hypen-engine-rs
# (the binary and its test now live behind `runtime-bin` = module-loader + bin-only deps)
cargo build  --features runtime-bin   --bin  hypen-runtime
cargo test   --features module-loader --test test_module_host    # 16/16
cargo test   --features runtime-bin   --test test_hypen_runtime  # 32/32
cargo clippy --features runtime-bin   --bin  hypen-runtime       # no new warnings
cd ../parser && cargo test                                       # green
cd ../hypen-cli && bun test tests/build-wasm.test.ts             # 10 pass / 4 skip
```
