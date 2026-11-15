# Test fixtures

Prebuilt WASM Components used by the module-host tests, plus the small
multi-module app manifests (`app*/`) and `counter_ui.hypen` that the
`hypen-runtime` CLI tests drive. The source for every `.wasm` lives under
[`src/`](src/); this file says which source builds which fixture and how to
rebuild it.

| Fixture | Source | Used by |
|---------|--------|---------|
| `counter_module.wasm` | `src/stub-module` (Rust, `/wit` `module`) | `test_module_host.rs`, `test_module_host_async.rs`, `test_hypen_runtime.rs`, `app/`, `app_acl/`, `app_async/`, `app_stateless/` |
| `seeded_module.wasm` | `src/seeded-module` (Rust, `/wit` `module`) | `test_hypen_runtime.rs` |
| `effects_module.wasm` | `src/effects-module` (Rust, `/wit` `module`) | `test_hypen_runtime.rs` |
| `limits_module.wasm` | `src/limits-module` (Rust, `/wit` `module`) | `test_module_host.rs` |
| `mirror_module.wasm` | `src/xmod-module` (Rust, `/wit` `module-x`) | `test_module_host.rs`, `app_acl/` |
| `fetcher_module.wasm` | `src/fetcher-module` (Rust, `/wit` `module-x` + `wasi:http` via `waki`) | `test_module_host.rs`, `test_uniffi_host.rs`, `test_hypen_runtime.rs` |
| `deferred_http_module.wasm` | `src/deferred-http-module` (Rust, `/wit` `module-x` + `hypen:http/deferred`) | `test_module_host_http.rs`, `test_hypen_runtime_http.rs` (which copies it into a temp app dir for its `--app` case) |
| `deferred_http_async_module.wasm` | `src/deferred-http-async-module` (Rust, `/wit-v0_2` CM-async `module-x` + `hypen:http/deferred`) | `test_module_host_http.rs` |
| `async_counter_module.wasm` | `src/async-module` (Rust, `/wit-v0_2` CM-async `module`) | `test_module_host_async.rs`, `test_hypen_runtime.rs`, `app_async/` |
| `ts_counter_module.wasm` | `src/ts-module` (JS, `jco componentize`) | `test_hypen_runtime.rs` |
| `go_counter_module.wasm` | `src/go-module` (Go, TinyGo `wasip2`) | `test_hypen_runtime.rs` |

## Rebuilding

`*.wasm` is gitignored repo-wide, so after copying a rebuilt fixture into
this directory you must stage it with **`git add -f`**:

```bash
git add -f hypen-engine-rs/tests/fixtures/<fixture>.wasm
```

All commands below are run from the repository root. Rebuild whenever the
module source or the WIT it targets (`/wit`, `/wit-v0_2`) changes.

### Copies inside the app fixtures

`hypen-runtime --app` only loads files that live inside the manifest's
directory (a `wasm` / `ui` path that resolves outside it is rejected), so
each `app*/` fixture carries its own copy of the modules it lists. After
rebuilding a fixture, refresh those copies too:

```bash
cd hypen-engine-rs/tests/fixtures
cp counter_module.wasm app/ && cp counter_module.wasm app_stateless/
cp counter_module.wasm mirror_module.wasm fetcher_module.wasm app_acl/
cp counter_module.wasm async_counter_module.wasm app_async/
git add -f app*/*.wasm
```

### Rust fixtures

Each Rust crate under `src/` is a standalone leaf crate: it has its own
empty `[workspace]` table (so it is not part of the root Cargo workspace)
and a committed `Cargo.lock`. The `wit_bindgen::generate!` macro reads the
canonical WIT straight from the repo root (`path: "../../../../../wit"`, or
`wit-v0_2` for the async module), so there is no copied WIT to keep in
sync. Requires `rustup target add wasm32-wasip2`.

General shape (`<crate>` is the source dir, `<lib>` the crate name with `-`
replaced by `_`):

```bash
(cd hypen-engine-rs/tests/fixtures/src/<crate> && cargo build --target wasm32-wasip2 --release)
cp hypen-engine-rs/tests/fixtures/src/<crate>/target/wasm32-wasip2/release/<lib>.wasm \
   hypen-engine-rs/tests/fixtures/<fixture>.wasm
git add -f hypen-engine-rs/tests/fixtures/<fixture>.wasm
```

| Source crate | Built artifact | Copy to |
|--------------|----------------|---------|
| `src/stub-module` | `hypen_stub_module.wasm` | `counter_module.wasm` |
| `src/seeded-module` | `hypen_seeded_module.wasm` | `seeded_module.wasm` |
| `src/effects-module` | `hypen_effects_module.wasm` | `effects_module.wasm` |
| `src/limits-module` | `hypen_limits_module.wasm` | `limits_module.wasm` |
| `src/xmod-module` | `hypen_xmod_module.wasm` | `mirror_module.wasm` |
| `src/fetcher-module` | `hypen_fetcher_module.wasm` | `fetcher_module.wasm` |
| `src/deferred-http-module` | `hypen_deferred_http_module.wasm` | `deferred_http_module.wasm` |
| `src/deferred-http-async-module` | `hypen_deferred_http_async_module.wasm` | `deferred_http_async_module.wasm` |
| `src/async-module` | `hypen_async_module.wasm` | `async_counter_module.wasm` |

For example, the counter:

```bash
(cd hypen-engine-rs/tests/fixtures/src/stub-module && cargo build --target wasm32-wasip2 --release)
cp hypen-engine-rs/tests/fixtures/src/stub-module/target/wasm32-wasip2/release/hypen_stub_module.wasm \
   hypen-engine-rs/tests/fixtures/counter_module.wasm
git add -f hypen-engine-rs/tests/fixtures/counter_module.wasm
```

What each module does:

- **stub-module** — toy counter. `increment` → `state.count += 1`, persists
  to `hypen:storage/local`, emits a `Log` effect; `sync` → pushes state to
  `hypen:storage/cloud` via `compare-and-set`.
- **seeded-module** — counter whose `init(config)` seeds `state.count` from
  a `start` field, so `module Seeded(start: 7)` boots at `{"count":7}`
  (`config_seeds_init_from_module_declaration_args`).
- **effects-module** — emits engine-native effects (`Navigate`, `Delay`) to
  exercise host effect handling.
- **deferred-http-module** — queues HTTP requests through
  `hypen:http/deferred` instead of blocking (`module-x` world; needs the
  `http` grant, and nothing else). `get` queues one request from its payload
  (`url`, optional `method` / `headers` / `body` / `timeoutMs` / `tag`) with
  `then: "fetched"`; `fetched` records the completion (`last`, `log`,
  `completions`) and, if the `get` named a `next` URL, queues that from the
  completion handler; `flood` queues `count` requests (the per-call bound);
  `bad` sends one malformed request per `case`; `init({"probe": url})` tries
  `send` where nothing can be queued. A refused `send` is recorded in
  `state.sendError`, so tests read exactly what the guest was told. It is the
  only fixture that imports the interface — the others predate it and were
  **not** rebuilt (an import a component does not use is not in its binary).
- **deferred-http-async-module** — the same capability from a
  `hypen:module@0.2.0` module, minimal (`get`, `fetched`): `send` is a sync
  func in the async world too, and the completion reaches an `async`
  reducer.
- **limits-module** — deliberately misbehaves to verify the sandbox
  (`module-x` world; imports `hypen:storage/app`, so it needs the `app`
  grant): spins / grows memory (epoch timeout, total-memory cap), `block`
  and `init("block")` block in a host call (wall-clock deadline), `trap`
  panics, `raw-state` returns non-UTF-8 state bytes,
  `kv-set` / `kv-fill` / `kv-get` (storage quotas),
  `kv-keys` / `kv-info` / `kv-clear` (the rest of the bucket surface),
  `kv-leak` (opens bucket handles without dropping them — handle bound),
  `blob-open` (blob storage is unavailable),
  `flood-dispatch` / `flood-subscribe` (cross-module request bounds).
- **xmod-module** — cross-module fixture (`module-x` world): `pull` reads
  the sibling `counter`'s state, `bump` dispatches to it, `watch` /
  `on-activated` subscribe to it.
- **fetcher-module** — `wasi:http` from inside a module via the idiomatic
  `waki` client; `fetch` writes `{status, body}` (or `{error}`) into state.
- **async-module** — the `hypen:module@0.2.0` CM-async reference module
  (WASI 0.3): async exports that `await` storage warm start, set +
  read-back, cloud CAS, cross-module `read`, `subscribe` from
  `on-activated`, plus a `spin` action for the timeout test.

### `ts_counter_module.wasm` (JavaScript)

`src/ts-module` is a JS counter written against a small
`defineModule({ initialState, actions })` API (`src/lib/define-module.mjs`,
`src/counter.mjs`) plus a hand-written WIT shim (`src/index.mjs`).
`scripts/build.mjs` bundles it with esbuild and runs
`jco componentize --wit <repo>/wit --world-name module` (clocks/random/http
disabled). Needs bun (or node) and network access for the npm install.

```bash
(cd hypen-engine-rs/tests/fixtures/src/ts-module && bun install && bun run build)
cp hypen-engine-rs/tests/fixtures/src/ts-module/dist/ts_counter.wasm \
   hypen-engine-rs/tests/fixtures/ts_counter_module.wasm
git add -f hypen-engine-rs/tests/fixtures/ts_counter_module.wasm
```

The output is ~14 MB because componentize-js embeds the StarlingMonkey JS
engine; the first wasmtime compile of it is slow (tens of seconds).

### `go_counter_module.wasm` (Go)

`src/go-module` holds only `main.go` + `go.mod`. TinyGo's `wasip2` runtime
pulls in `wasi:cli` / `wasi:io` / `wasi:clocks` / `wasi:filesystem` /
`wasi:random` imports, so it builds against the **`tinygo-module`** world
(`module` + those WASI 0.2.0 imports) rather than plain `module`. That WIT
package (`/wit` plus the vendored WASI 0.2.0 deps) is maintained by the
CLI at [`hypen-cli/wit-tinygo/`](../../../hypen-cli/wit-tinygo/); it is not
duplicated here (the old spike's vendored `wit/` copy was an older snapshot
of it). Requires TinyGo (>= 0.36 for Go 1.24) and
`go install go.bytecodealliance.org/cmd/wit-bindgen-go@latest`.

```bash
(cd hypen-engine-rs/tests/fixtures/src/go-module && \
  wit-bindgen-go generate --world module --out internal/bindings ../../../../../hypen-cli/wit-tinygo && \
  go mod tidy && \
  tinygo build -target=wasip2 -wit-package ../../../../../hypen-cli/wit-tinygo \
    -wit-world tinygo-module -o app.wasm main.go)
cp hypen-engine-rs/tests/fixtures/src/go-module/app.wasm \
   hypen-engine-rs/tests/fixtures/go_counter_module.wasm
git add -f hypen-engine-rs/tests/fixtures/go_counter_module.wasm
```

`internal/bindings/`, `go.sum` and `app.wasm` are generated and gitignored.
`wit-tinygo/world.wit` is `/wit`'s `hypen-module.wit` plus the
`tinygo-module` world appended; keep it in sync with `/wit` when the
contract changes (it is owned by `hypen-cli`, whose `hypen build` uses it
for Go modules).

## Lockfiles and build output

`.gitignore` in this directory re-includes `src/*/Cargo.lock` (the engine's
`.gitignore` ignores `Cargo.lock`) and ignores each source dir's `target/`,
`node_modules/`, `dist/`, and the Go-generated files.
