# WASM Engine Support — Handover

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

## 1. The model in one paragraph

A Hypen **module** is a stateful logic controller with two deployment targets from
the *same* authoring code: **in-process** (`hypen dev` / RemoteServer, full
Node/Go/JVM — use this for anything needing a DB driver, async, or a real library)
and **wasm** (`hypen build --target wasm` → sandboxed `.wasm` components, for
portable / offline / sandboxed-third-party logic). UI stays declarative `.hypen`,
rendered by the engine, in both. The wasm module is a **pure reducer** (`state, action
-> state-delta + effects`) plus capability imports (storage, cross-module state) and
Elm-style effect descriptors (navigate/delay) — see `wit/hypen-module.wit`.

## 2. What's landed (all verified + on the branch)

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

## 3. What's blocked (external / upstream — not effort)

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

## 4. Deferred (in our control, but marginal)

- ~~**Hot-reload synthetic-scope regeneration**~~ — **DONE.** The `--app` watcher keeps
  pristine sources, re-runs `plan_per_usage` on every `.hypen` edit, and live-mints newly
  planned synthetic scopes (register + config-seeded init + activate) before re-rendering.
  Verified by `ui_hot_reload_mints_new_usage_scope_live`. Removed usages keep their
  instances until restart (harmless).

## 5. The async roadmap — the promotion checklist

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

## 6. Build / test / verify

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

## 7. Environment gotchas (for CI sandboxes)

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

## 8. Where things live

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
