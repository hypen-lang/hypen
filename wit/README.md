# Hypen WIT Specs

WebAssembly Interface Types (WIT) defining the contract between **Hypen
modules** (WASM Component guests) and **Hypen hosts** (engine + platform).

These are the cross-language, cross-platform interfaces that make a single
`.wasm` module run on web (via jco), iOS (WasmKit / AOT), Android (wasmtime),
desktop, and server.

Status: **v0.1.0 strawman.** Not wired into any consumer yet — these files
exist to anchor design discussion and codegen targets.

## Layout

```
wit/
├── hypen-module.wit              package hypen:module@0.1.0
└── deps/
    ├── hypen-storage/
    │   └── storage.wit           package hypen:storage@0.1.0
    ├── hypen-engine/
    │   └── state.wit             package hypen:engine@0.1.0  (cross-module state)
    └── hypen-http/
        └── http.wit              package hypen:http@0.1.0    (deferred HTTP)
```

### One source of truth

`wit/` (v0.1) and [`wit-v0_2/`](../wit-v0_2/) (v0.2) are canonical — the
engine's `bindgen!` and the fixture modules read them directly. The CLI
package vendors copies (`hypen-cli/wit/`, `hypen-cli/wit-v0_2/`, and
`hypen-cli/wit-tinygo/`, which adds TinyGo's `tinygo-module` world and the
WASI 0.2.0 deps it needs) because the published package has no repo root.
Never edit those copies: edit `wit/` or `wit-v0_2/`, run
`scripts/sync-wit.sh` to regenerate them, and if the contract changed,
rebuild the engine's `.wasm` fixtures
(`hypen-engine-rs/tests/fixtures/README.md`). `scripts/sync-wit.sh --check`
fails on drift; CI (Rust › Format) and `hypen-cli/tests/wit-sync.test.ts`
run it. The TinyGo-only parts of `wit-tinygo/` are listed in the script's
`TINYGO_OWNED` table and `hypen-cli/wit-tinygo/README.md`.

`hypen-module.wit` is the root package: what every Hypen module *exports*
(reducer ABI + lifecycle) and which capabilities it *imports*.

`deps/hypen-storage/storage.wit` is the storage capability — three sister
interfaces, one per visibility scope (`local` / `app` / `cloud`), each with
KV + blob.

Validated end-to-end:

- `wasm-tools component wit wit/` — parses, resolves, round-trips, encodes
  to a 7.2 KB binary component descriptor; `wasm-tools validate` accepts it.
- `wit-bindgen rust wit/ --world module --generate-all` — generates ~6.9k
  lines of Rust bindings.
- A stub Rust module implementing `Guest` against the generated bindings
  compiles cleanly to a **66 KB WASM Component** for `wasm32-wasip2`.
  Inspecting the resulting binary with `wasm-tools component wit`
  shows the expected 5 reducer/lifecycle exports plus only the storage
  imports actually called (tree-shaking works).
- `wit-bindgen go wit/ --world module` and `wit-bindgen c wit/ --world module`
  both succeed, producing per-scope Go packages
  (`hypen_storage_local` / `_app` / `_cloud`) and a C header + canonical-ABI
  object file. Capability-as-interface scoping survives codegen across
  three guest languages.

## HTTP: deferred requests (`hypen:http/deferred`)

A reducer is synchronous, so it cannot wait for a response. `hypen:http` lets
it *queue* one instead — the same "do X, then dispatch Y" pattern as the
`delay` effect:

```wit
send: func(req: request, then: string, tag: option<string>) -> result<_, error>;
```

`send` returns as soon as the request is queued. The host performs it after
the reducer returns and dispatches the module's own action `then` with the
outcome as its JSON payload (`tag` is echoed back):

```jsonc
// a response was read — any status; 404 and 500 are completed exchanges
{ "ok": true, "status": 200, "headers": { "content-type": "text/plain" },
  "body": "…", "bodyEncoding": "utf8" /* or "base64" */, "tag": "t-1" }
// no response
{ "ok": false, "error": { "kind": "timeout", "message": "…" }, "tag": "t-1" }
```

`error.kind` is one of `network`, `timeout`, `denied`, `too-large`,
`invalid-response`. Every request `send` accepted gets exactly one completion
(unless the module is destroyed or reloaded first). The normative text —
payload, header rules, bounds — is the comment block at the top of
[`deps/hypen-http/http.wit`](deps/hypen-http/http.wit).

**Grant.** The manifest's `http: true` (the same switch as blocking
`wasi:http`); importing the interface without it is a link-time denial.
`httpHosts` optionally narrows the grant to a list of host patterns —
`api.example.com`, `*.example.com` (subdomains, not the apex),
either with `:port`, or an IP literal; empty or absent means any host. The
scheme is always `http` or `https`. The allowlist is checked when a request
is queued (`permission-denied` names the host), again by the engine before
any embedder sees the request, and by the embedder on every redirect hop. On
the native host it also applies to blocking `wasi:http` requests.

| Bound | Value |
|---|---|
| requests queued per reducer call | 16 |
| requests in flight per module | 32 (`Engine::set_module_http_in_flight_limit`) |
| URL | 8 KiB, ASCII, no credentials |
| request headers | 64, 16 KiB of names + values; `host`, `content-length`, `connection`, `transfer-encoding`, `keep-alive`, `upgrade`, `te`, `trailer`, `expect`, `proxy-*` refused |
| request body | 1 MiB |
| `then`, `tag` | 256 bytes each |
| time budget | default 30 s, capped at 120 s |
| response body | 4 MiB (`too-large` beyond) |
| redirects followed | 5 |

It is declared in the `module-x` world of both contract versions
(`hypen:http@0.1.0` / `@0.2.0`; `send` is a plain sync func in both). When to
use it rather than `wasi:http`: [AUTHORING_MODEL.md, "HTTP: blocking vs
deferred"](AUTHORING_MODEL.md#http-blocking-vs-deferred).

## Scope model

Capability grants happen at the *interface* level, not as runtime parameters.
A module that imports `hypen:storage/app` without a manifest grant fails to
instantiate — denial is a link-time fact, not a runtime check.

| Interface              | Visibility                  | Granted by default? |
|------------------------|-----------------------------|---------------------|
| `hypen:storage/local`  | This module, this device    | Yes                 |
| `hypen:storage/app`    | All modules in this app     | No (manifest opt-in)|
| `hypen:storage/cloud`  | User's devices (synced)     | No (manifest opt-in)|

Module-private isolation for `local` is enforced by the host: every key is
transparently prefixed with the module name before reaching the platform
store. A module cannot escape its scope because the scope is bound at
instantiation, not in the call signature.

## Platform backend mapping

| (scope, tier)           | iOS                                  | Android                          | Web                                    |
|-------------------------|--------------------------------------|----------------------------------|----------------------------------------|
| local + persistent      | `Library/<bundle>/<module>/`         | `filesDir/<module>/`             | IndexedDB scoped to `${origin}#${module}` |
| local + cache           | `Caches/<module>/`                   | `cacheDir/<module>/`             | Cache API                              |
| local + secure          | Keychain w/ module access group      | EncryptedSharedPreferences       | IDB + WebCrypto                        |
| app + persistent        | `Library/Application Support/shared/`| `filesDir/shared/`               | IDB shared bucket                      |
| cloud + persistent      | `NSUbiquitousKeyValueStore` / CloudKit | Auto Backup + DataStore        | Hypen sync service                     |
| * + temp                | `tmp/`                               | `cacheDir/.session/`             | sessionStorage / in-memory             |

## Roadmap

- **v0.1** (this file): storage scopes, cross-module state, direct
  `wasi:http` imports, JSON state.
- **v0.2**: structured `value` variant for state (replaces `json` alias)
  once per-action JSON parsing shows up on profiles, Component Model
  preview 3 async for streaming HTTP bodies.
- **v0.3**: `hypen:permissions`, `hypen:keychain`, capability composition once
  WIT lands interface inheritance.
