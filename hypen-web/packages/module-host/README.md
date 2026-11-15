# @hypen-space/module-host

The browser/Node **module host** for Hypen WASM Component modules — the JS
half that the engine's Rust `BridgedHost` drives
(`hypen-engine-rs/src/module_host/bridged_host.rs`). Hosts are libraries;
renderers stay pure patch consumers. This package has **no** rendering or
engine code: it loads, links, and runs `hypen:engine/module` components and
enforces their capability grants.

```
JS app
  └─► engine.wasm (WasmHostedEngine)
          └─► BridgedHost (Rust, in engine.wasm)
                  └─► JsModuleHost (this package)
                          └─► jco-instantiated module component
```

## What it contains

- **`JsModuleHost`** (`./js-module-host`) — the class registered with
  `WasmHostedEngine.setModuleHost()`. Synchronous Rust-facing surface
  (`register` / `instantiate` / `actions` / `init` / `dispatch` /
  `onActivated` / `onDeactivated` / `onDestroyed` / `destroy`) plus the
  JS-only async half, `await prepare(name[, bytes, manifest])`, which runs
  the jco pipeline: in-memory `transpile()` → `WebAssembly.compile` of the
  emitted core wasm → import of the emitted bindings via a `data:` URL (no
  disk writes, browser-portable) → instantiation against the per-module
  import map. `registerPrepared(name, bindings, manifest)` skips the
  pipeline for build-time-transpiled components (and test fakes).
- **Per-call ACL context** — sibling snapshots plus the manifest's
  `reads`/`dispatches` grants are installed around each `dispatch` /
  `onActivated` call; cross-dispatches and subscribe requests are *queued*
  (never re-entrant) and drained into the returned `ReducerOutput`.
- **Storage backends** (`./storage`) — `LocalBucket` (`hypen:storage/local`)
  auto-detects `localStorage` at import time (browser-persistent,
  base64-encoded bytes) and falls back to an in-memory Map (node, workers
  without DOM). `CloudBucket` (`hypen:storage/cloud`) is in-memory with
  monotonic per-key versions and compare-and-set.

## The capability contract: declare → grant → enforce

A module **declares** what it needs in its manifest
(`{ name, version, storage, reads, dispatches, http }` — the shape
`BridgedHost::register` sends over the wire). The host turns declarations
into **grants** and **enforces** them at two different times:

| Capability | Enforced | How |
| --- | --- | --- |
| `http` | `prepare()` (link) time | Shim withholding: `http === false` removes the `wasi:http/*` shims from the import map, and `prepare()` fails with an error naming the missing `wasi:http` imports. `true`/absent grants preview2-shim's fetch-backed http. This is the browser analogue of the native hosts' link-time gate. |
| `reads` | per call | `hypen:engine/state.read`/`subscribe` throw `{ tag: 'permission-denied', val: 'reads' }` unless the target module is granted. |
| `dispatches` | per call | `hypen:engine/state.dispatch` throws `{ tag: 'permission-denied', val: 'dispatches' }` unless granted; granted dispatches are queued into `ReducerOutput.crossDispatch`. |
| `storage` | host-provided | `hypen:storage/{local,cloud}` buckets are namespaced per `(tier, namespace)`; `local` persists across page loads when `localStorage` exists. |

The http gate is a *link-time* decision: `register()`-ing a fresh manifest
after `prepare()` does not re-link. Re-register with fresh bytes and
`prepare()` again to change link-time grants.

## Storage persistence notes

- In browsers, `local` rides `window.localStorage` under the
  `hypen-storage/` prefix (bytes base64-encoded — localStorage only holds
  strings). This is the browser counterpart of the native hosts'
  `set_storage_path`, and is what makes bridged browser modules persistent
  across reloads.
- localStorage is used *because it is synchronous* — see the limitation
  below. IndexedDB (async-only) has to wait for async imports / JSPI.
- Outside a browser the same interface is served by an in-memory Map:
  persistence lasts for the process, which is exactly what warm-restart
  tests rely on.
- `cloud` is an in-memory stand-in that pretends to sync; versions are
  monotonic per key and `compareAndSet` throws
  `{ tag: 'unavailable', val: 'version mismatch' }` on conflict.

## Known limitation: jco async ↔ the sync v0.2 host surface

The Rust `BridgedHost` calls `instantiate`/`init`/`dispatch`
**synchronously**, so every async step (jco transpile, wasm compile,
component instantiation) must happen up front in `await prepare(...)`.
Consequently all capability *imports* served during a reducer call must be
synchronous too: v0.2 modules cannot use async host imports (no IndexedDB,
no async fetch surface of their own — preview2-shim services the module's
blocking `wasi:io/poll` by parking the thread, e.g. `Atomics.wait` in node).
When jco's async imports / JSPI land, the storage backends can move to
IndexedDB and the parking hack goes away.

Also note: two `instantiate()` calls of one prepared name share a single
component instantiation (one linear memory) — same semantics as a preloaded
component. Per-instance isolation would need prepare-per-instance pooling.

## Development

```bash
bun install        # from hypen-web/ (workspace root)
bun test           # unit tests (ACL context, import-map gate, storage) — no wasm needed
bun run build      # emits dist/ (ESM + .d.ts); deps stay external
bun run typecheck
```

The heavier wasm-driven end-to-end tests (real jco transpile of the
`counter_module.wasm` / `fetcher_module.wasm` fixtures, the bridged
engine.wasm round-trip, and the in-browser run) live in
`wit-spikes/web-host`, which re-exports this package's `dist/` via thin
shims — build this package first.
