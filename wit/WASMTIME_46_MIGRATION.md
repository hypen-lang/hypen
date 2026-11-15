# wasmtime 37 → 46 migration notes

Status: **DONE — landed.** The host now builds and passes its full suite on
wasmtime 46 (`test_module_host` 16/16, `test_hypen_runtime` 32/32 against the
prebuilt `.wasm` fixtures, so guest ABI compatibility is verified too). The
host stays on WASI 0.2 (p2); this bump was prep so the WASI 0.3 (p3) async
surface in 46 is available when the async ABI work starts.

## The changes that landed

`hypen-engine-rs/Cargo.toml`: `wasmtime`, `wasmtime-wasi`, `wasmtime-wasi-http`
`"37"` → `"46"` (resolves to 46.0.1).

`src/module_host/wasmtime_host.rs`:

1. **wasi-http view refactor** — p2 types moved under `p2::`:
   - `use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpView};`
     → `use wasmtime_wasi_http::WasiHttpCtx;`
     + `use wasmtime_wasi_http::p2::{WasiHttpCtxView, WasiHttpView};`
   - The `WasiHttpView` impl collapses from the `ctx()` + `table()` pair to a
     single `http()` returning a view struct, which in 46 also carries a
     `hooks` field (customization points for e.g. `send_request`; the default
     is fine for us):
     ```rust
     impl WasiHttpView for HostState {
         fn http(&mut self) -> WasiHttpCtxView<'_> {
             WasiHttpCtxView {
                 ctx: &mut self.http,
                 table: &mut self.table,
                 hooks: wasmtime_wasi_http::p2::default_hooks(),
             }
         }
     }
     ```
   - `wasmtime_wasi_http::add_only_http_to_linker_sync`
     → `wasmtime_wasi_http::p2::add_only_http_to_linker_sync`.

2. **`bindgen!` `with` resource keys** — see below.

`wasmtime_wasi::p2::add_to_linker_sync` and the `WasiView` / `WasiCtxView`
imports from `wasmtime_wasi` root are unchanged on 46.

## The former blocker, root-caused: `with` key separator changed `/` → `.`

The first migration attempt hit:

> interfaces were specified in the `with` config option but are not referenced
> in the target world: [... all 12 `hypen:storage/{local,app,cloud}/{bucket,blob-*}` ...]

and was mis-diagnosed as a behaviour change in how `include`d imports interact
with resource remapping (the `used_with_opts` bookkeeping in
`wasmtime-internal-wit-bindgen`). The actual cause is much simpler: **the
`with` key format for resources changed.** Through wasmtime 37,
`"hypen:storage/local/bucket"` (slash before the resource name) matched; in 46
`lookup_keys` builds resource candidates as `<interface-id>.<resource>` — a
**dot** before the resource name (see `Name::lookup_key`, which appends
`"." + item`, and the bindgen examples:
`"example:imported-resources/logging.logger": MyLogger`). Slash-form keys are
never generated as candidates, so they sit unmatched and `finish()` reports
them as unused.

Fix (one-line-per-key): rewrite the `with` map to dot form —

```text
"hypen:storage/local/bucket"  →  "hypen:storage/local.bucket"
```

No WIT changes were needed: `world module-x { include module; ... }` works
as-is; resources reached via `include` are remapped fine once the keys are in
the 46 format. (The earlier hypothesis — restructuring `module-x` to import
storage directly — was tested and made no difference; the separator was the
whole story.)

## Verification

```bash
cd hypen-engine-rs
cargo build  --features module-loader --bin  hypen-runtime
cargo test   --features module-loader --test test_module_host    # 16/16
cargo test   --features module-loader --test test_hypen_runtime  # 32/32
cargo clippy --features module-loader --bin  hypen-runtime       # no new warnings
cd ../parser && cargo test                                       # green
cd ../hypen-cli && bun test tests/build-wasm.test.ts             # 10 pass / 4 skip
```
