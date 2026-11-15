# Authoring & Build Model — WASM modules vs. normal Hypen apps

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

## The two collisions

### 1. Command + noun (shallow)

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

### 2. Authoring API (deep)

- Normal module (`hypen-web/packages/core/src/app.ts`):
  `app.defineState({count:0}).onAction("inc", ({state}) => state.count++).ui(hypen\`…\`).build()`
  — couples **logic + UI template**, proxy-mutated state.
- WASM module (the spikes): `defineModule({initialState, actions})` —
  **logic only**, pure reducer, no `.ui()`. The `hypen:module` WIT world
  has **no view/ui export**; in every test the UI/IR was built host-side,
  never supplied by the module.

Cementing the reduced API would create a two-tier authoring experience
and quietly break the "DX doesn't regress" promise.

## The resolution

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

### What about the richer `app` API on the WASM target?

The **logic half** of `app.defineState().onAction()` maps directly onto
the WASM reducer (state + action handlers). The **`.ui()` half** is the
`.hypen` template, which simply ships alongside the `.wasm` and is loaded
by the engine — same as it is for a normal app. So the *same authoring
API* can target either deployment: the build step decides whether the
logic becomes host-code or a component, and the `.ui()` template is
emitted as a `.hypen`/IR asset either way. No reduced API required; the
spikes' `defineModule({…})` is just the not-yet-wired-up subset.

## Build surface: target, not a new noun

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

### `hypen build --target wasm` — now implemented (TypeScript)

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

### Go pipeline — now implemented

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

### Rust pipeline — now implemented

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

## The one technical gap this surfaced — now closed

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

### `--serve --ui` in the browser — now closed

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

## Nested / multi-module apps — now wired (`--app`)

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

### Per-scope action routing — now closed

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

## Engine-native effects — Navigate + Delay now handled

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

## Cross-module `subscribe` — now implemented

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

## WASI 0.3 async — spike verdict (2026-07)

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

### hypen:module@0.2.0 async ABI — promoted + proven with Rust (2026-07)

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

### Platform hosts: Kotlin/JVM library + Pulley (iOS answer) — landed (2026-07)

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

### Browser host productionized + extracted to a standalone library — landed (2026-07)

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

### stdlib phase 1: hypen:time + persistent storage — landed (2026-07)

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

### wasi:http egress gate + async fetch + browser-host read — landed (2026-07)

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

### wasmtime 37 → 46 bump — now landed (2026-07)

The prep-plan bump is in: the native host runs on wasmtime 46.0.1 (still WASI
0.2/p2 at runtime, with the p3 async surface now available in-tree for the v0.2
work). The earlier "bindgen `with`+`include` blocker" turned out to be a
red herring — 46 changed the `with` resource-key format from
`pkg:iface/name/resource` to `pkg:iface/name.resource` (dot before the
resource), so the fix was rewriting 12 keys, no WIT restructuring. Full detail
+ verification matrix: `wit/WASMTIME_46_MIGRATION.md`. All suites green
(`test_module_host` 16/16, `test_hypen_runtime` 32/32 against the prebuilt
fixtures — guest ABI unchanged).

## Config-seeded `init` — declaration-site now implemented

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

## UI (`.hypen`) hot reload — server-side now implemented

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
