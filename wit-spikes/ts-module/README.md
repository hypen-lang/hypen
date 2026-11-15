# Hypen TS-authored module spike

Proves the **"Shape 2" authoring story** end-to-end: a developer writes
their Hypen module in plain JavaScript using a friendly
`defineModule({initialState, actions: {...}})` API, builds it to a WASM
Component implementing `hypen:module`, and the result runs on the *same*
`hypen-runtime` binary that drives Rust-authored modules.

## What's here

```
src/
├── lib/define-module.mjs   # the authoring API (what a user touches)
├── counter.mjs             # an example user module
└── index.mjs               # WIT-shim that wraps the user module
                             # (in a real SDK this would be auto-generated)

scripts/build.mjs           # esbuild bundle + jco componentize
dist/ts_counter.wasm        # built artifact (gitignored; rebuild with `bun run build`)
```

## Build & run

```bash
bun install
bun run build
# → dist/ts_counter.wasm  (~14 MB; includes StarlingMonkey JS engine)

# Now drive it through the *Rust* hypen-runtime binary:
cd ../../hypen-engine-rs
cargo build --features module-loader --bin hypen-runtime
# No --actions needed: the runtime discovers them from the module's
# `actions` export.
printf 'increment\nincrement\nset {"value":42}\nreset\n' | \
  ../target/debug/hypen-runtime \
    ../wit-spikes/ts-module/dist/ts_counter.wasm
# [actions] discovered from module: ["increment", "decrement", "set", "reset"]
# ready: {"count":0,"history":[]}
# state: {"count":1,"history":["inc"]}
# state: {"count":2,"history":["inc","inc"]}
# state: {"count":42,"history":["inc","inc","set=42"]}
# state: {"count":0,"history":[]}
```

The committed fixture at
`hypen-engine-rs/tests/fixtures/ts_counter_module.wasm` is this same artifact,
verified by `runtime_drives_a_ts_authored_module_end_to_end` in
`tests/test_hypen_runtime.rs`.

## Caveats worth knowing

- **JS modules are big.** ~14 MB vs. ~65 KB for the Rust counter, because
  componentize-js bundles the entire StarlingMonkey JS engine. AOT compilation
  (`--aot`) helps performance but not size. For applications that ship many
  small modules, Rust/Go/AssemblyScript are better build targets; for
  applications that ship one module with rich logic, JS is fine.
- **Cold-start cost.** wasmtime spends ~30 seconds compiling the 14 MB
  component on first run (cranelift). Reuse the compiled component (in-memory
  or via wasmtime's cache) for hot reload.
- **Multi-file imports need a bundle step.** componentize-js takes one JS
  file; relative imports must be pre-bundled (we use esbuild). A real
  `hypen build` would hide this.

## What this validates about the architecture

- **The WIT contract is the unit of language-agnosticity.** The TS counter
  imports the same `hypen:storage/*` interfaces, exports the same five
  reducer/lifecycle functions, and is loaded by the same `WasmtimeHost`
  as the Rust modules. No JS-specific runtime path on the engine side.
- **Authoring DX survives the wasm boundary.** The user wrote plain
  `state.count += 1` — no WIT types, no manual serialization, no
  wasm-bindgen — and got working reactive state changes through the
  engine.
- **Each language's SDK is build-time codegen + a friendly wrapper**,
  not a runtime translation layer. Replace `defineModule` with `app` and
  `index.mjs` with auto-generated glue and you have a productionizable
  TS SDK.
