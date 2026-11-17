# Authoring and building WASM modules

How a module compiled to a WebAssembly Component relates to an ordinary Hypen
module, how each language is built, and the two ways a module makes HTTP
requests. Contract: [README.md](README.md). Architecture:
[ENGINE_INTEGRATION.md](ENGINE_INTEGRATION.md). User guide:
[WASM Modules](../hypen-docs/content/docs/guide/wasm-modules.mdx). CLI
internals: [`hypen-cli/CLAUDE.md`](../hypen-cli/CLAUDE.md) ("Wasm Build").

## One concept, two targets

A **module** is the stateful controller behind a template, whatever it is
compiled to. The same TypeScript or Go module definition
(`app.defineState().onAction().build()`, `core.NewApp(...).OnAction(...).Build()`)
runs in-process on a server **or** is compiled to a component by
`hypen build --target wasm`; only where the logic runs differs. The UI is
always a declarative `.hypen` template rendered by the engine: a component
exports logic only, and its template ships beside it. That is why the
contract has no `view` export.

The build is selected by **target**, not by a new noun ("module" and
"component" both already mean something in Hypen):

```bash
hypen build                    # browser SPA / server bundle (unchanged)
hypen build --target wasm      # per-module <Name>.wasm + <Name>.hypen + app.json + hypen-modules.json in dist/wasm/
hypen pack                     # dist/pack/: an npm-publishable module package
hypen add <package>            # install a package into an app, with consent and a lock entry
```

`dist/wasm/app.json` runs directly with `hypen-runtime --app dist/wasm/app.json`;
`hypen-modules.json` describes the output as a package (what each module
requests, its ABI and SHA-256).

## Languages

| Language | Shape | Pipeline (`hypen-cli/src/wasm/builders/`) | Contract |
|----------|-------|-------------------------------------------|----------|
| TypeScript | the ordinary `app` API; a generated shim adapts it to the reducer ABI (`shims/module-shim.ts`) | esbuild bundle (Node built-ins stubbed) → `jco componentize` against a per-module world that imports only the granted capabilities | v0.1 |
| Go | **app-mode**: a package exporting `Module()` built with `core.NewApp`; a generated Go shim adapts it. **wit-mode**: `package main` implementing the exports directly | `wit-bindgen-go generate` → `tinygo build -target=wasip2 -wit-world tinygo-module` | v0.1 |
| Rust | wit-authored: a `cdylib` implementing `Guest` with `wit_bindgen::generate!` (Rust's idiomatic component path) | the CLI provisions the crate's `wit/`, then `cargo build --release --target wasm32-wasip2`; one crate per module directory, or a single root crate | v0.1 or v0.2 (`[package.metadata.hypen] abi`) |

What the TypeScript and Go shims do not bridge yet, and fail loudly on:
async handlers, cross-module writes (`setState` on another module), removing
a `context.on` subscription, router reads / history, data sources. Router
`push` / `replace` / `navigate` become the `navigate` effect;
`context.getModule(...).getState()` / `dispatch()` and `context.on(...)` map
to `hypen:engine/state`.

Sizes to expect: a Rust counter is about 65 KB; a TinyGo one about 1 MB
(the Go runtime); a TypeScript one about 14 MB (componentize-js embeds the
StarlingMonkey JS engine), which costs startup time and memory per instance.

Go parity needed the SDK to compile under TinyGo: the files that embed the
wazero engine and `net/http` are `//go:build !tinygo`, and
`portable_tinygo.go` provides pure-Go ports of the canonical path/diff
helpers.

## Configuration of `init`

`init(config)` receives JSON config:

- **Declaration site**: the arguments of a `module Counter(start: 5)` root.
- **Use site** (`hypen-runtime` only): `Counter(start: 9)` in a parent
  template. Each distinct effective config becomes its own instance under a
  synthetic scope (`counter`, `counter__a`, …; `key:` forces distinct
  instances for identical config). The runtime does this by rewriting
  templates with the parser's name spans; the engine is unaware of it.
- On `@hypen-space/server`, config comes from `wasmModule({ config })`, not
  from use-site arguments.

The TypeScript and Go shims shallow-merge config over the module's
`initialState`.

## HTTP: blocking vs deferred

A module has two ways to make an HTTP request. Both need the manifest's
`http: true`; they differ in *who waits*.

| | Blocking — `wasi:http` | Deferred — `hypen:http/deferred` |
|---|---|---|
| Shape | the reducer calls its language's HTTP client and gets the response inline | the reducer calls `send(request, then, tag)` and returns; the response arrives later as the action `then` |
| Native host (wasmtime: `hypen-runtime`, UniFFI embedders) | works — the guest is suspended while the host does the I/O | works |
| JS host (Node, Bun, browser) | Node/Bun: works, holding the thread; **browser: does not work** (a synchronous reducer cannot be suspended, the call traps) | works |
| TypeScript-authored modules | unavailable (the TS build disables `wasi:http`) | the way to do HTTP: `context.http.send` / `get` |
| Go modules (CLI build) | the Go HTTP stack under TinyGo | not yet (no bindings or helper generated) |
| Engine while the request is in flight | held for the whole exchange (bounded by the per-call deadline, 5 s by default on the native host) | free — only the two reducer runs hold it |
| Longest request | the per-call deadline | the request's own budget (default 30 s, max 120 s) |
| Response handling | whatever the client library does (streaming, any size the module can hold) | whole body, at most 4 MiB, as text or base64 in the action payload |
| Redirects | the guest's client issues each hop itself | followed by the host (up to 5), each hop re-checked |
| Server policy (`@hypen-space/server`: private-network rule, `onHttpRequest`) | not applied | applied |

Rule of thumb: use **deferred**, unless a module only ever runs on a native
host and wants the response inline or streamed.

The completion payload (normative text: the header of
[`deps/hypen-http/http.wit`](deps/hypen-http/http.wit)):

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
handler can pair requests and answers by `tag`. A completion handler is an
ordinary reducer and may queue the next request.

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

**The allowlist.** `httpHosts` limits `http` to hosts matching one of its
patterns: an exact host (`api.example.com`), a wildcard for subdomains
(`*.example.com` — any depth, not `example.com` itself), either with a port
(`localhost:8080`; no port = any port), or an IP literal. Absent or empty =
any host. It is enforced by the host at `send` (`permission-denied` naming
the host), by the engine when it folds the reducer's output, by the embedder
on every redirect hop, and on the native host and the JS host for blocking
`wasi:http` requests too. URLs are parsed once, by the engine, with a strict
grammar (ASCII only, no `user:pass@`, IPv4 only as a dotted quad), and the
embedder connects to that parse.

Implementation map: `hypen-engine-rs/src/module_host/http.rs` (types,
bounds, allowlist, payload), `module_host/wasmtime/deferred_http.rs` (native
`send` and the `wasi:http` hook), `hosted/http.rs` (admission, requests in
flight, `Engine::complete_http_request`), `bin/hypen_runtime/http.rs` (the
reference client), `hypen-web/packages/module-host/src/http.ts` (the
TypeScript port) and `hypen-web/packages/server/src/hosted/http.ts` (the
server's client and policy). Tests: `test_module_host_http.rs`,
`test_hypen_runtime_http.rs`, `src/hosted/http_tests.rs`,
`hypen-web/packages/module-host/tests/{deferred-http,http-parity}.test.ts`,
`hypen-web/tests/hosted-modules-http.test.ts`.

## Async modules (v0.2)

`hypen:module@0.2.0` (`/wit-v0_2`) makes the state-producing exports
`async func`, so a handler can `await` storage, cross-module calls and
`hypen:time.sleep-ms` inline and then return its delta — the same body an
in-process `onAction(async …)` has. `reducer-output` is unchanged, so the
engine's pipeline is unaffected. `effect` keeps `navigate`, `delay` and
`log` for what must apply after the reducer and for zero-import portability.

Rust can target it today (`abi = "0.2"`; reference module
`hypen-engine-rs/tests/fixtures/src/async-module`, driven by
`test_module_host_async`). Go cannot (TinyGo has no `wasip3`). TypeScript is
blocked on componentize-js (status and dates in
[ENGINE_INTEGRATION.md, "Status and open items"](ENGINE_INTEGRATION.md#status-and-open-items)).

**The componentize-js gate** checks whether `jco componentize` can build a
JS module against the v0.2 `module` world such that an `async` export that
`await`s a *custom* async host import completes. Componentizing successfully
is not enough — a syncified export can still hang at the import — so the
built component must be driven on the native async host under a deadline.
To re-test (the former gate module and its Rust runner were removed with the
WIT spikes; see [HISTORY.md](HISTORY.md#v02-design-notes-v0_2_notesmd) and
git history):

1. Write a single-file `module.mjs` implementing the v0.2 `module` world:
   import `{ Bucket } from "hypen:storage/local@0.2.0"`; `async init` does
   `await Bucket.open("persistent", "gate")` and `await bucket.get("count")`
   (default `{"count":0}`); `async dispatch` for `increment` computes
   `count + 1`, `await bucket.set("count", …)`, and returns the
   `await bucket.get("count")` echo as `state`; `onActivated` /
   `onDeactivated` return `{ state: undefined, effects: [], emit: [] }`;
   `onDestroyed` is empty; sync `actions()` returns `["increment"]`.
2. Build with the jco under test:
   `jco componentize module.mjs --wit <repo>/wit-v0_2 --world-name module -o async_gate.wasm --disable clocks --disable random --disable http`
   (do not prune the storage imports: they are what is tested). A
   componentize failure is itself a "closed" verdict.
3. Drive it natively (`--features module-loader`): `WasmtimeHostAsync` with
   `ModuleLimits { max_call: Duration::from_secs(60), ..Default::default() }`,
   `register("gate", &bytes, ModuleManifest::all("gate"))`, `instantiate`,
   `init(b"{}")`, then `dispatch` `increment`. The gate is open only if the
   returned state is `{"count":1}`; failing at any step or hitting the
   deadline means closed.

Green means: in `hypen-cli/src/wasm/builders/ts.ts` stop disabling `http` /
`fetch-event`, enable async-export codegen, keep the per-module world, check
the real import list with `wasm-tools component wit` (StarlingMonkey adds
imports), and let the build pick v0.2 for TypeScript modules. Authors'
`onAction(async …)` bodies need no change. Record each run (date, jco
version, where it failed) in "Status and open items".
