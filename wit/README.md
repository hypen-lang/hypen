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
    └── hypen-storage/
        └── storage.wit           package hypen:storage@0.1.0
```

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
