# Hypen Go-authored module spike

Same job as `wit-spikes/ts-module/`: prove a Hypen module written in
a third language (Go) compiles to a WASM Component implementing
`hypen:module` and runs on the *same* `hypen-runtime` binary that drives
the Rust and TS modules.

## What's here

```
main.go                          # the user-facing module code (a counter)
go.mod
wit/                             # vendored copy of /wit + WASI 0.2.0 WITs
├── world.wit                    # adds a `tinygo-module` world (see below)
└── deps/
    ├── hypen-storage/           # from /wit
    ├── hypen-engine/            # from /wit
    └── {cli,io,clocks,filesystem,random,sockets}/   # WASI 0.2.0
internal/bindings/               # wit-bindgen-go output (regenerate via `make bindings`)
app.wasm                         # built artifact (gitignored)
```

## Build & run

```bash
# One-time: install wit-bindgen-go and tinygo (>= 0.36 for Go 1.24).
go install go.bytecodealliance.org/cmd/wit-bindgen-go@latest

# Generate bindings (only when WIT changes).
wit-bindgen-go generate --world module --out internal/bindings ./wit

# Build the module.
tinygo build -target=wasip2 -wit-package wit -wit-world tinygo-module \
              -o app.wasm main.go
# → app.wasm  (~1 MB)

# Run through the Rust hypen-runtime:
cd ../../hypen-engine-rs
cargo build --features module-loader --bin hypen-runtime
# No --actions needed: the runtime discovers them from the module's
# `actions` export.
printf 'increment\nincrement\ndecrement\nreset\n' | \
  ../target/debug/hypen-runtime \
    ../wit-spikes/go-module/app.wasm
# [actions] discovered from module: ["increment", "decrement", "reset"]
# ready: {"count":0,"history":[]}
# state: {"count":1,"history":["inc"]}
# state: {"count":2,"history":["inc","inc"]}
# state: {"count":1,"history":["inc","inc","dec"]}
# state: {"count":0,"history":[]}
```

The committed fixture at
`hypen-engine-rs/tests/fixtures/go_counter_module.wasm` is this same artifact,
verified by `runtime_drives_a_go_authored_module_end_to_end` in
`tests/test_hypen_runtime.rs`.

## Why the `tinygo-module` world exists

The canonical `hypen:module` world declares only the reducer/lifecycle
exports + `hypen:storage/*` imports. But TinyGo's `wasip2` target compiles
Go's runtime alongside the user code, and the runtime references `os.*`
which lowers to `wasi:cli/environment`, `wasi:filesystem`, `wasi:clocks`,
etc. The `wasm-tools component new` step that wraps the core module rejects
the build because those imports aren't in the declared `module` world.

The fix is a local `tinygo-module` world (`wit/world.wit`) that includes
`module` *plus* the wasi:* imports TinyGo brings in. The resulting
component still satisfies the `hypen:module` contract — every host that
provides our reducer/lifecycle calling protocol (i.e. our `WasmtimeHost`)
will accept it, because the wasi:* imports are already in any wasmtime-wasi
linker.

Other languages may need similar local extension worlds; the WIT design
intentionally tolerates this because real toolchains differ in how much
runtime they pull in.

## Size and tradeoff

~1 MB for the Go counter, vs:
- ~65 KB (Rust counter, no runtime)
- ~14 MB (TS counter, StarlingMonkey JS engine bundled)

Go falls cleanly between Rust and JS: TinyGo's runtime is small but
non-zero. A real-world Go module with `net/http` and complex stdlib usage
will run larger.

## What this validates

- **WIT contract works across three source languages.** Same engine,
  same hypen-runtime binary, same state shape, three different compilers.
- **The "your app is the module" story is genuinely polyglot.** A team
  with Go expertise can ship a Hypen app today; a team with Rust or TS
  expertise can ship the same shape; no language is privileged on the
  host side.
- **The toolchain friction is local, not architectural.** Each language's
  build pipeline has quirks (TS needs esbuild bundling for componentize-js;
  Go needs the wasi-bringing-up adapter world). These are SDK polish
  problems, not WIT-contract problems.
