# @hypen-space/module-host

The browser/Node/Bun **module host** for Hypen WASM Component modules — the JS
half that the engine's Rust `BridgedHost` drives
(`hypen-engine-rs/src/module_host/bridged_host.rs`). Hosts are libraries;
renderers stay pure patch consumers. This package has **no** rendering or
engine code: it loads, links, and runs `hypen:module` components and enforces
their capability grants.

```
JS app
  └─► engine.wasm (WasmHostedEngine)
          └─► BridgedHost (Rust, in engine.wasm)
                  └─► JsModuleHost (this package)
                          └─► jco-instantiated module component
```

## Usage

```ts
import { JsModuleHost } from "@hypen-space/module-host";

const host = new JsModuleHost();            // options below
await host.prepare("counter", componentBytes, {
  name: "counter", version: "1.0.0",
  storage: ["cloud"],                        // local is implicit
  reads: [], dispatches: [], http: false,
});
engine.setModuleHost(host);                  // WasmHostedEngine (module-loader-bridged build)
engine.registerAndInstantiate("counter", new Uint8Array(0), manifest, null, config);
```

### `new JsModuleHost(options?)`

| Option | Default | Meaning |
| --- | --- | --- |
| `storage` | `LocalStorageBackend` over `globalThis.localStorage` if usable, else a fresh `MemoryStorageBackend` | Backend for the `local` and `app` scopes. Decided per host, at construction. |
| `cloudStorage` | fresh `MemoryStorageBackend` | Backend for `cloud` (see the limitation below). |
| `quotas` | `{ maxValueBytes: 1 MiB, maxBytesPerModulePerScope: 5 MiB }` | Storage quotas (`DEFAULT_STORAGE_QUOTAS`). |
| `now` | `Date.now` | Clock for `entry-info.modified-ms`. |

A backend is any synchronous `StorageBackend` (`get` / `set` / `delete` /
`keys`). Every host has its own storage policy object and its own per-call ACL
context — nothing is shared between `JsModuleHost` instances except, by
nature, a shared `localStorage`.

### Instance surface

- Rust-facing, **synchronous** (the `bridged_host.rs` contract): `register`,
  `instantiate`, `actions`, `init`, `dispatch`, `onActivated`,
  `onDeactivated`, `onDestroyed`, `destroy`.
- JS-only: `await prepare(name[, bytes, manifest])` — in-memory jco bindgen
  → `WebAssembly.compile` of the emitted core wasm → import of the bindings
  (Blob URL, `data:` fallback) → instantiation against the manifest-gated
  import map. `registerPrepared(name, bindings, manifest)` skips the pipeline
  (build-time-transpiled components, test fakes); `await
  importMapFor(name, requiredImports?)` returns the gated import map for such
  flows.
- `host.storage` (`HostStorage`: backends, quotas, `usage()`, `dump()`) and
  `host.engineState` (this host's `hypen:engine/state` import).

### Other exports

`buildImportMap`, `normalizeManifest`, `HostStorage`, `createStorageImports`,
`MemoryStorageBackend`, `LocalStorageBackend`, `defaultStorageBackend`,
`DEFAULT_STORAGE_QUOTAS`, `STORAGE_SCOPES`, `LS_PREFIX`, and the types
(`JsModuleHostOptions`, `ModuleManifest`, `NormalizedManifest`,
`StorageBackend`, `StorageLike`, `StorageScope`, `StorageQuotas`,
`StorageError`, `BucketEntryInfo`, `ReducerOutput`, …). Subpath exports:
`./js-module-host`, `./storage`, `./types`.

## The capability contract: declare → grant → enforce

A module **declares** what it needs in its manifest
(`{ name, version, storage, reads, dispatches, http }` — the shape
`BridgedHost::register` sends). Every field is **deny-by-default**: omitted
`storage` = `local` only, omitted `http` = no egress, omitted
`reads`/`dispatches` = none (`normalizeManifest`).

| Capability | Enforced | How |
| --- | --- | --- |
| `hypen:storage/local` | always linked | Module-private: keys live under the registered module name. |
| `hypen:storage/app` | `prepare()` (link) time | Linked only if `storage` lists `"app"`; otherwise a component importing it fails `prepare()` with an error naming the interface. Shared by the app's modules. |
| `hypen:storage/cloud` | `prepare()` (link) time | Linked only if `storage` lists `"cloud"`. User-scoped, shared by the app's modules. |
| `http` | `prepare()` (link) time | Only `http: true` links preview2-shim's `wasi:http/*`; otherwise a component importing them fails `prepare()` naming the missing imports. |
| `reads` | per call | `hypen:engine/state.read`/`subscribe` throw `{ tag: 'permission-denied', val: 'reads' }` unless the target is granted. |
| `dispatches` | per call | `hypen:engine/state.dispatch` throws `{ tag: 'permission-denied', val: 'dispatches' }` unless granted; granted dispatches are queued into `ReducerOutput.crossDispatch` (never re-entrant). |

Link-time grants are fixed at `prepare()`: re-`register()`-ing with empty
bytes only refreshes the per-call grants. Register fresh bytes and `prepare()`
again to change link-time grants. Never linked: `wasi:filesystem`,
`wasi:sockets`.

## Storage

- Composite keys are length-prefixed per component (scope, owner module,
  tier, namespace, key), so `/` or `:` in a namespace, key or module name
  cannot collide with another bucket.
- Quotas (native-host defaults): a value over 1 MiB, or a write that would
  take a module over 5 MiB in one scope (value bytes + UTF-8 key bytes), fails
  with the WIT `quota-exceeded(bytes-over)` error. In the shared `app`/`cloud`
  scopes an entry is charged to the module that last wrote it. Quota checks
  scan the scope's metadata on each write — fine for localStorage-sized data.
- Backend exceptions (e.g. the browser's own localStorage quota) surface as
  the WIT `backend(message)` error.
- `info()` returns real sizes and modified times; `version` on `cloud` only.
- Blob resources (`blob-bucket` / `blob-handle` / `blob-writer`) are stubs
  failing with `unavailable`, as in the native hosts.
- The tier is part of the key but has no behavioural effect yet (`temp` is
  not mapped to `sessionStorage`, `secure` is not encrypted).
- In browsers the default backend is `localStorage` under the
  `hypen-storage:v1/` prefix (bytes base64-encoded). It is used *because it
  is synchronous* — IndexedDB has to wait for async imports / JSPI.

### Limitation: `cloud` is an in-memory stand-in

**Nothing is synced across devices.** `cloud` data lives in the host's
`cloudStorage` backend — by default in memory, gone on reload. Versions are
real and monotonic per key, `modifiedMs` is the local write time, and
`compareAndSet` follows the WIT exactly (`expected === undefined` = key must
not exist; otherwise the version must match; returns the new version;
mismatch throws `{ tag: 'unavailable', val: 'version mismatch' }`), so module
code behaves the same once a real sync backend exists. A persistent
`cloudStorage` backend can be injected, but it is still local-only.

## Content-Security-Policy

`prepare()` imports the generated bindings from an in-memory module: a
**Blob URL** (revoked right after import) where supported, otherwise a
`data:` URL (Node, whose ESM loader rejects `blob:`). Under a CSP, allow
`blob:` in `script-src` (or `data:` if you cannot allow `blob:`). The
generated bindings are a single self-contained JS file; the core wasm is
compiled with `WebAssembly.compile` (needs `'wasm-unsafe-eval'` under a
strict CSP), and jco's bindgen loads its own vendored wasm via `fetch` of
URLs relative to `@bytecodealliance/jco-transpile` (bundlers must emit them
as assets).

## Runtime notes

- Dependencies: `@bytecodealliance/jco-transpile` (only its browser-portable
  `./component` bindgen entry is loaded) and `@bytecodealliance/preview2-shim`
  0.31.x (the shim generation that bindgen targets). Both are loaded lazily on
  the first `prepare()`.
- Bun: works directly (the `bun` export condition serves `src/`); the 0.31
  shim's Node build runs under Bun, no test preload or aliasing needed.
- Node: ≥ 20. The shim services a module's blocking `wasi:io/poll` by parking
  the thread (`Atomics.wait`), so a server a module calls over `wasi:http`
  must not live on the same thread.

## Known limitation: jco async ↔ the sync host surface

The Rust `BridgedHost` calls `instantiate`/`init`/`dispatch`
**synchronously**, so every async step (bindgen, wasm compile, component
instantiation) happens up front in `await prepare(...)`, and every capability
import served during a reducer call is synchronous too (no IndexedDB, no
async fetch). When jco's async imports / JSPI land, storage can move to
IndexedDB.

Two `instantiate()` calls of one prepared name share a single component
instantiation (one linear memory) — same semantics as a preloaded component.

## Development

```bash
bun install        # from hypen-web/ (workspace root)
bun test           # unit + end-to-end tests
bun run build      # emits dist/ (ESM + .d.ts); deps stay external
bun run typecheck
```

End-to-end tests (`tests/e2e-*.test.ts`) drive the prebuilt component fixtures
in `hypen-engine-rs/tests/fixtures` (`counter_module.wasm`,
`fetcher_module.wasm`) through the real pipeline, and skip if they are absent.
`tests/e2e-bridged.test.ts` additionally needs a bridged engine build and
skips without it:

```bash
cd hypen-engine-rs && wasm-pack build --target nodejs \
  --out-dir pkg-bridged --features module-loader-bridged
```
