# hypen-cli/wit-tinygo — partly generated, do not edit the generated parts

The `hypen:module@0.1.0` WIT package as TinyGo builds need it (`hypen build
--target wasm` for Go, and the engine's `go_counter_module.wasm` fixture).
Maintained by [`scripts/sync-wit.sh`](../../scripts/sync-wit.sh); the
authoritative split is the table at the top of that script.

**Generated from [`/wit`](../../wit/) — edit `/wit`, then run `scripts/sync-wit.sh`:**

- `world.wit` above the `TINYGO-ONLY BELOW` marker line — byte-for-byte
  `/wit/hypen-module.wit`.
- `deps/hypen-engine/`, `deps/hypen-storage/`, `deps/hypen-http/` (every
  package in `/wit/deps/`).

**TinyGo-owned — edit here; the script keeps them verbatim:**

- `world.wit` from the marker down: the `tinygo-module` world (`include
  module` + the `wasi:cli`/`io`/`clocks`/`filesystem`/`random@0.2.0` imports
  TinyGo's `wasip2` runtime always brings in, + `hypen:http/deferred@0.1.0`
  for modules that queue HTTP requests). `wasm-tools component new`
  rejects imports the world doesn't declare, so plain `module` can't be used.
  Declaring an import does not make a component import it: a TinyGo
  component carries only the imports its code references (the committed
  `go_counter_module.wasm` was built against this world and imports neither
  `hypen:storage/*` nor `wasi:cli/exit`), so the `http` grant is needed only
  by Go modules that actually call `hypen:http/deferred.send`.
- `deps/{cli,clocks,filesystem,io,random,sockets}/` — the WASI 0.2.0 packages
  those imports resolve against; `tinygo -wit-package` needs them vendored.
- this README.

`scripts/sync-wit.sh --check` (CI and `hypen-cli/tests/wit-sync.test.ts`)
fails if the generated parts drift from `/wit`.
