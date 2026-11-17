# `hypen:module` — the WASM module contract

WebAssembly Interface Types (WIT) defining the contract between a **Hypen
module compiled to a WebAssembly Component** (the guest) and a **Hypen host**
(the engine plus a platform module host). A module built against it — from
Rust, Go (TinyGo) or TypeScript (componentize-js) — runs unchanged on every
host listed below.

User documentation: the
[WASM Modules guide](../hypen-docs/content/docs/guide/wasm-modules.mdx) and the
[security model](../hypen-docs/content/docs/guide/wasm-module-security.mdx).
How the engine and the hosts run modules:
[ENGINE_INTEGRATION.md](ENGINE_INTEGRATION.md). How a module is authored and
built: [AUTHORING_MODEL.md](AUTHORING_MODEL.md). Old design and handover notes:
[HISTORY.md](HISTORY.md) (historical, may be inaccurate).

## The contract in one paragraph

A module is a **pure reducer** plus capability imports. The engine owns the
module's state: it passes the state (JSON bytes) into every call and takes the
new state back from the result, so a module has no hidden state between calls.
It exports `init(config) -> state`, `dispatch(state, action) -> reducer-output`,
the lifecycle calls `on-activated` / `on-deactivated` / `on-destroyed`, and
`actions()` (the action names it handles, used to wire routing). A
`reducer-output` carries the new state, effects the host performs after the
call (`navigate`, `delay`, `log`) and follow-up actions (`emit`). Everything
else a module can reach is an **import**, and every import beyond `local`
storage (and, in v0.2, the clock) needs a grant in the module's manifest.

## Layout and versions

```
wit/                           hypen:module@0.1.0 — synchronous; the default
├── hypen-module.wit           worlds `module` and `module-x`
└── deps/
    ├── hypen-storage/storage.wit   hypen:storage@0.1.0  (local / app / cloud)
    ├── hypen-engine/state.wit      hypen:engine@0.1.0   (cross-module read / dispatch / subscribe)
    └── hypen-http/http.wit         hypen:http@0.1.0     (deferred HTTP)

wit-v0_2/                      hypen:module@0.2.0 — Component Model async (WASI 0.3)
├── hypen-module.wit           same worlds; state-producing exports are `async func`
└── deps/
    ├── hypen-storage/storage.wit   hypen:storage@0.2.0  (async ops, stream<u8> blob buckets)
    ├── hypen-engine/state.wit      hypen:engine@0.2.0
    ├── hypen-http/http.wit         hypen:http@0.2.0     (`send` stays a sync func)
    └── hypen-time/time.wit         hypen:time@0.2.0     (now-ms, monotonic-ms, async sleep-ms)
```

Two directories because one WIT package root cannot hold two versions of the
same package. **v0.1 is the default and frozen**: new capability packages are
added to v0.2 only. The native host runs both ABIs side by side (`DualHost`
sniffs each component); the JS module host runs v0.1 only.

| World | Exports | Imports |
|-------|---------|---------|
| `module` | `init`, `dispatch`, `on-activated`, `on-deactivated`, `on-destroyed`, `actions` | `hypen:storage/{local,app,cloud}` (v0.2 adds `hypen:time/clock`) |
| `module-x` | as `module` | `module` + `hypen:engine/state` + `hypen:http/deferred` |
| `tinygo-module` (vendored copy only, see below) | as `module` | `module` + `hypen:http/deferred` + the `wasi:cli` / `wasi:io` / … imports TinyGo's runtime brings in |

An import the guest never calls is not in its binary, so a module built
against `module-x` that does not use HTTP is not affected by the `http` grant.
Blocking `wasi:http` is deliberately **not** part of the contract: a module
may import it through its language's HTTP client, under the same `http`
grant.

### Capabilities and grants

| Interface | Grant (manifest field) | Checked |
|-----------|------------------------|---------|
| `hypen:storage/local` | always granted; partitioned by module name | — |
| `hypen:storage/app`, `/cloud` | `storage: ["app", "cloud"]` | link time (an ungranted import fails instantiation, naming the import and the grant) |
| `hypen:engine/state` `read` / `subscribe` | `reads: [module]` | every call (`permission-denied`) |
| `hypen:engine/state` `dispatch` | `dispatches: [module]` | every call, and again by the engine when it folds the output |
| `hypen:http/deferred`, `wasi:http` | `http: true`, narrowed by `httpHosts: [pattern]` | link time; the allowlist per request and per redirect hop |
| `hypen:time/clock` (v0.2) | always granted; hosts may substitute a virtual clock | — |

Manifests are **deny by default**: an absent field grants nothing. The
manifest is whatever the embedder registers the module with (the
`hypen.json` `wasm.modules` / `wasm.packages` grants, a `RemoteServer`
`wasmModule({ grants })`, a `hypen-runtime` `app.json` entry or `--grant-*`
flags, a UniFFI `HypenModuleHost` grants object). A package's
`hypen-modules.json` lists what modules *request*; it never grants anything.

### Deferred HTTP (`hypen:http/deferred`)

A synchronous reducer cannot wait for a response, so it queues one:
`send(request, then, tag)` returns at once; the host performs the request
after the reducer returns and dispatches the module's own action `then` with
the outcome as a JSON payload:

```jsonc
{ "ok": true, "status": 200, "headers": { "content-type": "text/plain" },
  "body": "…", "bodyEncoding": "utf8" /* or "base64" */, "tag": "t-1" }
{ "ok": false, "error": { "kind": "timeout", "message": "…" }, "tag": "t-1" }
```

`error.kind` is `network`, `timeout`, `denied`, `too-large` or
`invalid-response`; any HTTP status is `ok: true`. Every request `send`
accepted gets exactly one completion unless the module is destroyed or
reloaded first. The normative text (payload, header rules, bounds) is the
comment block at the top of [`deps/hypen-http/http.wit`](deps/hypen-http/http.wit);
when to use it rather than `wasi:http` is in
[AUTHORING_MODEL.md, "HTTP: blocking vs deferred"](AUTHORING_MODEL.md#http-blocking-vs-deferred).

| Bound | Value |
|---|---|
| requests queued per reducer call | 16 |
| requests in flight per module | 32 (`Engine::set_module_http_in_flight_limit`) |
| URL | 8 KiB, ASCII, `http`/`https`, no credentials |
| request headers | 64, 16 KiB of names + values; `host`, `content-length`, `connection`, `transfer-encoding`, `keep-alive`, `upgrade`, `te`, `trailer`, `expect`, `proxy-*` refused |
| request body | 1 MiB |
| `then`, `tag` | 256 bytes each |
| time budget | default 30 s, capped at 120 s |
| response body | 4 MiB (`too-large` beyond) |
| redirects followed | 5 |

`httpHosts` patterns: `api.example.com`, `*.example.com` (subdomains at any
depth, not the apex), either with `:port`, or an IP literal; empty or absent
means any host. The grammar lives in one place per language
(`hypen-engine-rs/src/module_host/http.rs`; its TypeScript port
`hypen-web/packages/module-host/src/http.ts`, copied into the CLI and checked
by a sync test).

## One source of truth: `scripts/sync-wit.sh`

`wit/` and `wit-v0_2/` are canonical: the engine's `bindgen!` and the fixture
modules read them directly. The CLI package vendors copies because the
published `@hypen-space/cli` has no repo root:

| Generated copy | From |
|----------------|------|
| `hypen-cli/wit/` | `wit/` |
| `hypen-cli/wit-v0_2/` | `wit-v0_2/` |
| `hypen-cli/wit-tinygo/` | `wit/` plus the TinyGo-owned `tinygo-module` world and WASI 0.2.0 deps (listed in the script's `TINYGO_OWNED` table and `hypen-cli/wit-tinygo/README.md`) |

Never edit the copies. After changing the contract:

```bash
scripts/sync-wit.sh            # regenerate the vendored copies
scripts/sync-wit.sh --check    # what CI runs (Rust › Format, and hypen-cli/tests/wit-sync.test.ts): exit 1 on drift
```

Then rebuild the engine's fixture components (below) if the change affects
them. Only `*.wit` files are mirrored; the Markdown here is not.

## Where the hosts live

| Host | Code | Runs |
|------|------|------|
| Engine side (routing, grants, cascade, deferred HTTP admission) | `hypen-engine-rs/src/hosted/` | every embedding |
| Native wasmtime host (`module-loader` feature) | `hypen-engine-rs/src/module_host/wasmtime/`, `dual.rs` | v0.1 and v0.2; Pulley interpreter option for targets without JIT |
| `hypen-runtime` reference binary (`runtime-bin` feature) | `hypen-engine-rs/src/bin/hypen_runtime/` | `.wasm` + `.hypen` apps from the command line, REPL or `--serve` |
| JS module host | `hypen-web/packages/module-host` (`@hypen-space/module-host`) | v0.1, in Node, Bun and browsers (jco transpile) |
| TypeScript server integration | `hypen-web/packages/server/src/hosted/` | hosted modules next to TS modules in `RemoteServer` / `hypen dev` |
| UniFFI module host | `hypen-engine-rs/src/uniffi/module_host.rs` (`HypenModuleHost`) | Kotlin / Swift embedders |
| Kotlin host library | `hypen-host-kotlin/` | **experimental, unverified**: stale generated bindings, no CI |

Build side: `hypen-cli/src/wasm/` (`hypen build --target wasm`, packages) and
`hypen-cli/src/modules/` (`hypen add` / `remove` / `modules` / `pack`).

## Fixtures

Prebuilt components used by the tests live in
`hypen-engine-rs/tests/fixtures/`, with their sources under `src/`.
[`hypen-engine-rs/tests/fixtures/README.md`](../hypen-engine-rs/tests/fixtures/README.md)
says which source builds which fixture and gives the rebuild commands (Rust:
`cargo build --target wasm32-wasip2 --release` per crate; JS: `jco
componentize`; Go: TinyGo `wasip2`). `*.wasm` is gitignored, so stage a
rebuilt fixture with `git add -f`, and refresh the copies inside the `app*/`
fixture directories.
