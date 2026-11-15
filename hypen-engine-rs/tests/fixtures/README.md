# Test fixtures

## `counter_module.wasm`

A WASM Component implementing the `hypen:module` world (`/wit`). Toy counter:

- `increment` → `state.count += 1`, persists to `hypen:storage/local`, emits a
  `Log` effect.
- `sync` → pushes state to `hypen:storage/cloud` via `compare-and-set`.

Used by `tests/test_module_host.rs` to exercise the native `WasmtimeHost`.

### Regenerating

Source lives in `/wit-spikes/stub-module`. After changing the WIT or the
module source, rebuild and recopy:

```bash
cd wit-spikes/stub-module
cargo build --target wasm32-wasip2 --release
cp target/wasm32-wasip2/release/hypen_stub_module.wasm \
   ../../hypen-engine-rs/tests/fixtures/counter_module.wasm
```

Requires the `wasm32-wasip2` target (`rustup target add wasm32-wasip2`).

## `seeded_module.wasm`

A counter whose `init(config)` seeds `state.count` from a `start` field, so a
declaration-site `module Seeded(start: 7)` boots at `{"count":7}` instead of
`{"count":0}`. Used by `tests/test_hypen_runtime.rs`
(`config_seeds_init_from_module_declaration_args`) to prove config-seeded init.

### Regenerating

Source lives in `/wit-spikes/seeded-module`:

```bash
cd wit-spikes/seeded-module
cargo build --release --target wasm32-wasip2
cp target/wasm32-wasip2/release/hypen_seeded_module.wasm \
   ../../hypen-engine-rs/tests/fixtures/seeded_module.wasm
```

## `async_counter_module.wasm`

The `hypen:module@0.2.0` **CM-async** reference module (WASI 0.3): reducer +
lifecycle exports are WIT `async func`, and the guest `await`s its capability
imports inline — local-storage warm start in `init`, set + read-back in
`increment`, cloud `compare-and-set` in `sync`, cross-module `read` in `pull`,
`subscribe` from `on-activated` — plus a `spin` action for the timeout test.
Used by `tests/test_module_host_async.rs` to prove the v0.2 async ABI against
`WasmtimeHostAsync`.

### Regenerating

Source lives in `/wit-spikes/async-module` (targets `/wit-v0_2`):

```bash
cd wit-spikes/async-module
cargo build --target wasm32-wasip2 --release
cp target/wasm32-wasip2/release/hypen_async_module.wasm \
   ../../hypen-engine-rs/tests/fixtures/async_counter_module.wasm
```
