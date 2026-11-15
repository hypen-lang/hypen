# Hypen WIT v0.2 Design Notes

Captures decisions made during the v0.1 spike that we want to act on in v0.2
but don't want to rush into v0.1. Append to this as more questions surface.

## 1. Adopt `wasi:http` directly  ✓ Landed in v1.0

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

## 2. Re-examine `hypen:storage` vs. `wasi:keyvalue` / `wasi:filesystem`

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

## 3. State shape: `json = list<u8>` -> structured `value` variant

**Decision:** keep `json` alias in v0.1 for simplicity; switch to a
structured `variant value { null, bool, integer, float, text, list, object }`
in v0.2 once the perf cost of per-action JSON parsing on the host side
becomes measurable.

**No breaking change to the module world** — `type json = value` then
becomes the migration. Module authors don't see it; only host parsing
behaviour changes.

## 4. Module SDK templates

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

## 5. Async dispatch ABI — `hypen:module@0.2.0` (WASI 0.3 draft)

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

### Promotion addendum — what actually landed (2026-07)

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
- **Reference module** — `wit-spikes/async-module` (Rust, wit-bindgen 0.57,
  plain `cargo build --target wasm32-wasip2`): async `init` awaits a storage
  warm-start read; `dispatch` awaits set + read-back; cloud CAS, cross-module
  read, and `subscribe` from `on-activated` are all awaited inline.
- **Native async host** — `WasmtimeHostAsync`
  (`hypen-engine-rs/src/module_host/wasmtime_host_async.rs`): same sync
  `ModuleHost` surface, each call pumps `Store::run_concurrent` under
  `futures_executor::block_on` (no tokio needed until tokio-backed p3
  imports are linked). WIT `async func` needs no bindgen options; the sync
  `actions` export is lifted with `exports: { "actions": async | store }`;
  instantiation goes through `instantiate_async`. Manifest ACLs, link-time
  scope denial, and the epoch timeout all carry over.
- **Proof: `test_module_host_async` 8/8** — deltas arrive after suspension
  points in the v0.1 `ReducerOutput` shape (path-diff pipeline untouched),
  warm-start persists across instances, CAS versions advance, per-call ACLs
  gate awaited reads, a runaway async dispatch still traps on the epoch
  deadline.

The gate smoke test is now instrumented too (checklist step 4):
`wit-spikes/async-gate-ts` + `hypen-engine-rs/tests/test_async_gate_ts.rs`,
behavioral (drives the componentized JS module on `WasmtimeHostAsync` under a
deadline, so a syncified-export hang also fails). First verdict (2026-07-04,
jco 1.24.6): **gate closed at componentize** — the spidermonkey-embedding-
splicer hits a `todo!()` (`bindgen.rs:713: not yet implemented`) on the async
world. Only the TS cutover itself (step 5) remains, and it stays blocked
until a jco release turns that test green.
