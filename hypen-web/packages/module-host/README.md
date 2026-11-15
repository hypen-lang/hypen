# @hypen-space/module-host

The browser/Node/Bun **module host** for Hypen WASM Component modules — the JS
half that the engine's Rust `BridgedHost` drives
(`hypen-engine-rs/src/module_host/bridged_host.rs`). Hosts are libraries;
renderers stay pure patch consumers. This package has **no** rendering or
engine code: it loads, links, and runs `hypen:module` components and enforces
their capability grants.

```
JS app
  └─► engine.wasm (WasmEngine, server build)
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
// `engine` is the server build's WasmEngine (`@hypen-space/server`'s wasm-node:
// built with `module-loader-bridged`). Hosted modules run in the same engine
// as ordinary in-process modules.
engine.setModuleHost(host);
engine.registerHostedModule("counter", "counter", manifest, config);
// scope ─────────────────────┘          └── the name it was prepare()d under
```

### `new JsModuleHost(options?)`

| Option | Default | Meaning |
| --- | --- | --- |
| `storage` | `LocalStorageBackend` over `globalThis.localStorage` if usable, else a fresh `MemoryStorageBackend` | Backend for the `local` and `app` scopes. Decided per host, at construction. |
| `cloudStorage` | fresh `MemoryStorageBackend` | Backend for `cloud` (see the limitation below). |
| `quotas` | `{ maxValueBytes: 1 MiB, maxPartitionBytes: 5 MiB }` | Storage quotas (`DEFAULT_STORAGE_QUOTAS`), same meaning as the native host's (see [Storage](#storage)). `maxBytesPerModulePerScope` is a deprecated alias of `maxPartitionBytes`. |
| `now` | `Date.now` | Clock for `entry-info.modified-ms`. |
| `onPrepare` | — | `(info: PrepareInfo) => void`, called after every successful `prepare()`: `loadedVia` (`"blob"` / `"data"`), component / bindings / core-wasm sizes, and per-step `timings` (transpile, compile, import, instantiate, total). |

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
  `host.engineState` (this host's `hypen:engine/state` import) and
  `host.deferredHttp` (its `hypen:http/deferred` import).

### One component, many hosts

`prepare()` does two things: the expensive, host-independent part (jco
bindgen + `WebAssembly.compile`) and the cheap, host-specific part (linking
against this host's storage and instantiating). They are also available
separately, so a server can do the first once and the second per session:

```ts
import { JsModuleHost, prepareComponent } from "@hypen-space/module-host";

const prepared = await prepareComponent("pricing", bytes);   // once
// per session / per user:
const host = new JsModuleHost({ storage: thatUsersBackend });
await host.instantiatePrepared("pricing", prepared, manifest);
```

Each `instantiatePrepared` creates a fresh component instance (its own linear
memory) linked against that host's storage and ACL context, gated by
`manifest` exactly like `prepare()`. It resolves to the new bindings, which
`registerPrepared` accepts if an earlier set has to be put back. This is how
`@hypen-space/server` runs hosted modules: one prepared component per module,
one host per session.

A guest trap (`WebAssembly.RuntimeError`, or a stack overflow) leaves a
component instance in an unknown state, so the host marks it dead: every
later call on an instance id that uses those bindings throws `dead instance
<id>: module '<name>' trapped: …`, and `host.deathReason(id)` returns the
reason (`null` while usable). An export that returns `Err(...)` is not a trap
and kills nothing. Replace the bindings (`instantiatePrepared` / `prepare`)
and `instantiate` again to recover.

### Other exports

`prepareComponent` (and the `PreparedComponent` type), `buildImportMap`, `normalizeManifest`, `HostStorage`, `createStorageImports`,
`MemoryStorageBackend`, `LocalStorageBackend`, `defaultStorageBackend`,
`DEFAULT_STORAGE_QUOTAS`, `MAX_NAMESPACE_BYTES`, `MAX_OPEN_BUCKETS`,
`entryCost`, `STORAGE_SCOPES`, `LS_PREFIX`, and the types
(`JsModuleHostOptions`, `PrepareInfo`, `LoadedVia`, `ModuleManifest`,
`NormalizedManifest`, `StorageBackend`, `StorageLike`, `StorageScope`,
`StorageQuotas`, `StorageQuotaOptions`, `StorageError`, `BucketEntryInfo`,
`ReducerOutput`, …). Subpath exports:
`./js-module-host`, `./storage`, `./types`, `./http` (the deferred-HTTP
grammar and limits).

## The capability contract: declare → grant → enforce

A module **declares** what it needs in its manifest
(`{ name, version, storage, reads, dispatches, http, httpHosts }` — the shape
`BridgedHost::register` sends). Every field is **deny-by-default**: omitted
`storage` = `local` only, omitted `http` = no egress, omitted
`reads`/`dispatches` = none (`normalizeManifest`). `httpHosts` narrows
`http` and is the one strict field: an entry that is not a valid host
pattern, or an allowlist without `http: true`, makes `normalizeManifest`
(and so `register()` / `prepare()`) throw — dropping a bad entry would
silently widen the grant to every host.

| Capability | Enforced | How |
| --- | --- | --- |
| `hypen:storage/local` | always linked | Module-private: keys live under the registered module name. |
| `hypen:storage/app` | `prepare()` (link) time | Linked only if `storage` lists `"app"`; otherwise a component importing it fails `prepare()` with an error naming the interface. Shared by the app's modules. |
| `hypen:storage/cloud` | `prepare()` (link) time | Linked only if `storage` lists `"cloud"`. User-scoped, shared by the app's modules. |
| `http` | `prepare()` (link) time | Only `http: true` links `hypen:http/deferred` and preview2-shim's `wasi:http/*`; otherwise a component importing either fails `prepare()` naming the missing imports. |
| `httpHosts` | per request | With an allowlist, `hypen:http/deferred.send` throws `{ tag: 'permission-denied', val: "host 'x:443' is not in the manifest's `httpHosts` allowlist" }` for any other host, and blocking `wasi:http` requests to one fail with `HTTP-request-denied`. |
| `reads` | per call | `hypen:engine/state.read`/`subscribe` throw `{ tag: 'permission-denied', val: 'reads' }` unless the target is granted. |
| `dispatches` | per call | `hypen:engine/state.dispatch` throws `{ tag: 'permission-denied', val: 'dispatches' }` unless granted; granted dispatches are queued into `ReducerOutput.crossDispatch` (never re-entrant). |

Link-time grants are fixed at `prepare()`: re-`register()`-ing with empty
bytes only refreshes the per-call grants. Register fresh bytes and `prepare()`
again to change link-time grants. `wasi:filesystem` is always linked as an
**empty** filesystem (no preopened directories — the native host's empty
`WasiCtx`), so TinyGo and componentize-js modules, whose runtimes import it
unconditionally, load but cannot reach any file. Never linked:
`wasi:sockets`.

## HTTP: deferred (`hypen:http/deferred`) and blocking (`wasi:http`)

Both are behind the manifest's `http` grant.

**Deferred** is the portable one. `send(request, then, tag)` performs
nothing: the host validates the request, checks it against `httpHosts`,
and queues it. The queue is open for `dispatch`, `onActivated` and
`onDeactivated` (the calls that return a reducer output) and comes back as
`ReducerOutput.httpRequests`:

```ts
const out = host.dispatch(id, state, action, siblings);
out.httpRequests; // [{ request: { method, url, headers, body, timeoutMs }, then, tag }]
```

Behind the engine, that is all there is to it: the engine admits each
request, hands it to the embedder's effect handler, and
`engine.completeHttpRequest(id, result)` dispatches `then` with the
response (`@hypen-space/server` does this for you). An embedder that drives
a `JsModuleHost` directly — a browser page — performs the requests itself
and dispatches `then` with `httpCompletionPayload(outcome, tag)` as the
payload (see [Deferred HTTP in the browser](#deferred-http-in-the-browser)).

`send` gives the guest the same answers as the native host
(`permission-denied` / `invalid-request` / `limit-exceeded`, same wording):
`src/http.ts` is a port of the engine's
`hypen-engine-rs/src/module_host/http.rs` — bounds, the strict URL grammar,
host patterns — pinned to it by `tests/http-parity.test.ts`. The pieces are
exported for embedders: `parseHttpUrl`, `joinHttpUrl`, `parseHostPattern`,
`hostPatternMatches`, `httpGrantOf`, `checkHttpGrant`,
`validateQueuedHttpRequest`, `effectiveTimeoutMs`, `httpCompletionPayload`
and the `MAX_HTTP_*` limits. (`packages/core/src/http.ts` and
`hypen-cli/src/wasm/http-grammar.ts` are generated copies of that file:
`bun scripts/sync-http-grammar.ts`.)

| Limit | Value |
| --- | --- |
| Requests per guest call | 16 |
| URL | 8 KiB, ASCII, `http(s)://`, no userinfo |
| Request headers | 64, 16 KiB in total; host-owned headers refused |
| Request body | 1 MiB |
| `then`, `tag` | 256 bytes each |
| Timeout | default 30 s, capped at 120 s, `0` refused |

**Blocking** `wasi:http` is preview2-shim's: it works where the shim can
park the thread (Node, Bun) and not in a browser (below). With `httpHosts`
set, the host checks every blocking request's authority against the
allowlist before handing it to the shim.

## Storage

- Composite keys are length-prefixed per component (scope, owner module,
  tier, namespace, key), so `/` or `:` in a namespace, key or module name
  cannot collide with another bucket.
- Quotas — the native `KvBackend` rule (`hypen-engine-rs/src/module_host/kv.rs`),
  byte for byte:
  - the budget (`maxPartitionBytes`, 5 MiB) is per **partition**: one per
    module for `local`, **one shared by all modules** for `app`, one for
    `cloud`;
  - an entry costs its value bytes + the UTF-8 bytes of its native entry key
    `<tier>/<namespace byte length>:<namespace><key>` (`entryCost()`), e.g.
    `("persistent", "n", "k1")` costs 16 + value;
  - a value over `maxValueBytes` (1 MiB) fails with
    `quota-exceeded(value − cap)`; a write taking the partition over budget
    fails with `quota-exceeded(new total − budget)`, checked after the
    compare-and-set version check; a rewrite that does not grow the entry is
    always allowed (so a module can shrink under a lowered budget).
  `tests/e2e-storage-parity.test.ts` drives the native tests' own
  `limits_module.wasm` and gets the native answers (e.g. `quota-exceeded:548`).
  Quota checks scan the partition's metadata on each write — fine for
  localStorage-sized data.
- Bucket handles (native parity): `open` with a namespace over 4 KiB of UTF-8
  fails with `unavailable("namespace of N bytes exceeds the 4096-byte limit")`;
  at most 256 handles may be open at once per prepared module (all scopes),
  then `unavailable("too many open buckets (limit 256); drop unused handles")`.
  jco releases a handle when the guest drops it (`Symbol.dispose`).
- `keys(prefix, limit)` returns keys in UTF-8 byte order (the native
  `BTreeMap` order), at most `limit`.
- Backend exceptions surface as the WIT `backend(message)` error — notably
  the **browser's own localStorage quota** (see [Browser](#browser)).
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

## Browser

Verified in headless Chromium 153 (Playwright) by `bun run test:browser`
(`tests/browser/run.ts`): the built `dist/` bundled with `Bun.build`
(`target: "browser"`), served from a local static server, real
`localStorage`, real CSP headers.

### Bundling: jco-transpile's own wasm assets

`prepare()` runs jco's bindgen, which is itself a WASM component. On the
first `prepare()` `@bytecodealliance/jco-transpile/component` fetches and
compiles its vendored core modules from

```js
new URL('../vendor/js-component-bindgen-component.core.wasm', import.meta.url) // + core2/3/4
```

i.e. relative to **wherever the bundler put jco's code**. Your build must
serve those four files (`node_modules/@bytecodealliance/jco-transpile/vendor/js-component-bindgen-component.core{,2,3,4}.wasm`,
5.4 MiB raw / 1.9 MiB gzip) at `../vendor/` relative to the JS chunk that
contains jco, with `Content-Type: application/wasm` (Chromium's
`compileStreaming` rejects anything else).

- **Bun (`Bun.build`) — verified:** Bun does *not* rewrite or emit
  `new URL(…, import.meta.url)` assets; it leaves the literal. Copy the four
  files to `<outdir>/../vendor/` (what the harness does: bundle in
  `out/app/`, wasm in `out/vendor/`).
- esbuild behaves like Bun (no asset emission). Vite and webpack 5 recognise
  the `new URL('…', import.meta.url)` pattern and emit the files themselves
  (not verified here).
- If the files are missing, `prepare()` fails with `jco transpile failed for
  module 'x': jco's own bindgen wasm could not be loaded (Failed to execute
  'compile' on 'WebAssembly': HTTP status code is not ok). The bundler must
  serve …/js-component-bindgen-component.core*.wasm at '../vendor/' …`.
- Import `@hypen-space/module-host` from an ESM bundle; jco and
  preview2-shim are imported lazily on the first `prepare()` (keep code
  splitting on to keep them out of your initial chunk). preview2-shim's
  `browser` build is picked by the bundler's export conditions.

### Content-Security-Policy

`prepare()` compiles WebAssembly at runtime (jco's bindgen and each
module's core wasm) and imports the generated bindings from an in-memory
module: a **Blob URL** first (revoked after import), else a `data:` URL
(Node, whose ESM loader rejects `blob:`; or a CSP without `blob:`). Needed:

```
script-src 'self' 'wasm-unsafe-eval' blob:
```

Observed in Chromium (`connect-src`/`default-src` must also allow fetching
jco's vendor wasm and your components — `'self'` when you host them):

| `script-src` (or `default-src`) | Result |
| --- | --- |
| no CSP | works, Blob URL |
| `'self' 'wasm-unsafe-eval' blob:` | works, Blob URL |
| `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:` | works, Blob URL |
| `'self' 'wasm-unsafe-eval' data:` | works via the `data:` fallback; Chromium logs **one** CSP violation per page for the first `blob:` attempt (later `prepare()`s go straight to `data:`) |
| `'self' 'wasm-unsafe-eval'` | fails: `could not import the transpiled module bindings: the page's Content-Security-Policy blocked both blob: and data: module scripts (directive script-src-elem of policy "…"). Add \`blob:\` (preferred) or \`data:\` to script-src …` |
| `'self' blob: data:` | fails: `jco transpile failed for module 'x': the page's Content-Security-Policy (script-src 'self' blob: data:) blocks WebAssembly compilation. Add 'wasm-unsafe-eval' to script-src …` |
| `'self'` / `default-src 'self'` | fails with the same message, plus `; the generated bindings are then imported from a blob: URL, so also add blob: (or data:)` |

`'unsafe-eval'` also permits the WebAssembly compile but not the `blob:` /
`data:` import; prefer the narrower `'wasm-unsafe-eval'`.

### Sizes and timings (measured)

- Bundle (`Bun.build --minify`, splitting): the host + preview2-shim browser
  build + jco bindgen glue is **≈ 307 KiB JS raw / 68 KiB gzip** (jco's glue
  is 269 KiB / 52 KiB of that), plus jco's vendor wasm **5.4 MiB raw /
  1.9 MiB gzip**, fetched on the first `prepare()` only.
- First `prepare()` in a fresh page (Chromium, localhost — includes jco's own
  wasm fetch + compile, excludes downloading your component):

  | Component | Size (gzip) | First `prepare()` | Next `prepare()` in the same page |
  | --- | --- | --- | --- |
  | `counter_module.wasm` (Rust) | 65 KiB (26 KiB) | ≈ 0.7–1.6 s (≈ 90 % jco init) | ≈ 0.1–0.25 s |
  | `go_counter_module.wasm` (TinyGo) | 1.0 MiB (350 KiB) | ≈ 2.0 s | — |
  | `ts_counter_module.wasm` (componentize-js) | 13.4 MiB (4.3 MiB) | ≈ 3.1 s (transpile 3.0 s, compile 0.1 s) | — |

  **TS-authored (componentize-js) modules work in the browser** and prepare
  in ~3 s on a desktop-class machine; the real cost is the **4.3 MiB gzip
  download per module** (the embedded StarlingMonkey JS engine), plus the
  memory of a 14 MB module. Workable for a desktop app shell, heavy for
  mobile or for many modules. Rust modules are ~200× smaller.
  (Run `HYPEN_BROWSER_PERF=1 bun run test:browser` to re-measure.)

### Deferred HTTP in the browser

`hypen:http/deferred` works in a browser: the reducer only queues, so
nothing has to wait inside the synchronous call. The page is the embedder —
it performs each queued request and dispatches the action the request named:

```ts
import { effectiveTimeoutMs, httpCompletionPayload, type HttpOutcome } from "@hypen-space/module-host";

const out = host.dispatch(id, state, action, []);
for (const queued of out.httpRequests) {
  const { request } = queued;
  let outcome: HttpOutcome;
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body ?? undefined,
      redirect: "error",
      signal: AbortSignal.timeout(effectiveTimeoutMs(request.timeoutMs)),
    });
    outcome = { ok: true, status: response.status, headers: [...response.headers], body: new Uint8Array(await response.arrayBuffer()) };
  } catch (e) {
    outcome = { ok: false, error: { kind: e.name === "TimeoutError" ? "timeout" : "network", message: String(e.message) } };
  }
  const payload = new TextEncoder().encode(JSON.stringify(httpCompletionPayload(outcome, queued.tag)));
  host.dispatch(id, state, { name: queued.then, payload }, []);
}
```

What a page must know:

- **CORS applies.** The target must allow the page's origin, and a
  `connect-src` directive in the page's CSP must allow the target.
- **Redirects cannot be checked.** A page cannot see where a redirect
  leads before following it (`redirect: "manual"` yields an opaque
  response), so it cannot re-check `httpHosts` per hop the way a server
  does. Use `redirect: "error"` whenever the module has an allowlist.
- **Cap the response yourself** (`MAX_HTTP_RESPONSE_BODY_BYTES`, 4 MiB):
  `httpCompletionPayload` turns a larger body into a `too-large` failure,
  but only after you have read it — stream and stop early for untrusted
  endpoints.
- Without the grant, `prepare()` fails naming `hypen:http/deferred`, as on
  every host.

The harness proves it against `deferred_http_module.wasm` in Chromium.

### Blocking `wasi:http` cannot complete in the browser

`http: true` also links preview2-shim's browser `wasi:http`, and a blocking
request **is sent** (`fetch`, CORS applies). But the reducer call is
synchronous and the browser shim's `wasi:io/poll` can only wait
asynchronously (it returns a Promise from `Pollable.block()`), so a module
that blocks on the response gets nothing and traps (Rust/`waki`: panics
`incoming response available`). The host rethrows the trap as `module 'x'
trapped (…). It holds the http grant, and in a browser wasi:http cannot
complete inside a synchronous reducer call … Use deferred HTTP instead …`.
A module that must run in a browser uses `hypen:http/deferred`; a module
built on a `wasi:http` client library needs a Node/Bun or native host.
Denial (`http` not `true`) works as everywhere: `prepare()` fails naming
the `wasi:http/*` imports.

### localStorage capacity

The default `local`/`app` backend stores values base64-encoded in
`localStorage`. Chromium allows ≈ 5 M UTF-16 characters per **origin**,
shared by every module, both scopes and anything else the app keeps there:
about **3.5 MiB of module values in total**. So in a browser the browser's
quota usually answers before the host's 5 MiB partition budget, as
`backend("QuotaExceededError: …")` rather than `quota-exceeded` (the host's
own quota still answers with the native payload when it is lower, e.g. a
1 MiB budget → `quota-exceeded(76)` in the harness). Inject a different
`storage` backend if you need more.

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
bun test           # unit + end-to-end tests (Bun)
bun run build      # emits dist/ (ESM + .d.ts); deps stay external
bun run typecheck
bun run test:browser   # build, then the real-browser harness (≈ 30 s)
```

End-to-end tests (`tests/e2e-*.test.ts`) drive the prebuilt component fixtures
in `hypen-engine-rs/tests/fixtures` (`counter_module.wasm`,
`fetcher_module.wasm`, `limits_module.wasm`, `go_counter_module.wasm`,
`ts_counter_module.wasm`) through the real pipeline, and skip if they are
absent.

`test:browser` (`tests/browser/run.ts`, also `bun run
test:browser:module-host` from `hypen-web/`) needs `playwright-core` (a
workspace devDependency; it never downloads browsers) or a global
`playwright`, a Chromium it can launch (`PLAYWRIGHT_BROWSERS_PATH`; in CI e.g.
`bunx playwright-core install --with-deps chromium-headless-shell` matching
the playwright-core version), and the fixtures. Without a browser it prints
`SKIP test:browser — …` and exits 0; set `HYPEN_BROWSER_TEST_REQUIRED=1` to
make that a failure. It is not part of `bun test`.
`tests/e2e-engine.test.ts` drives this host from the engine itself: the server
build of the engine that `@hypen-space/server` ships
(`../server/wasm-node`, rebuilt by `hypen-engine-rs/build-wasm.sh` with
`--features js,device-broker,module-loader-bridged`), hosted and in-process
modules in one `WasmEngine`.
