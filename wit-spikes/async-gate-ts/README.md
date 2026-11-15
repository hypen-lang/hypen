# The componentize-js async gate

The **single go/no-go signal for the TS cutover** to the CM-async
`hypen:module@0.2.0` ABI (promotion checklist step 4 in
`wit/WASM_ENGINE_HANDOVER.md` §5).

`src/module.mjs` implements the async v0.2 `module` world directly: async
exports that `await` a *custom* async host import (`hypen:storage/local@0.2.0`
bucket set/get). That's the exact capability componentize-js/StarlingMonkey
has historically lacked — it can await built-in `wasi:http`, but not bind a
custom async host import, and it syncifies exports.

The gate is **behavioral**: `jco componentize` may succeed and the component
may still hang at the sync-lowered import. So the runner —
`hypen-engine-rs/tests/test_async_gate_ts.rs` — builds this module and drives
it on `WasmtimeHostAsync` under a hard deadline; it passes only when the
awaited round-trip completes with the right value.

## Running

```bash
cd hypen-engine-rs
HYPEN_WASM_E2E=1 cargo test --features module-loader --test test_async_gate_ts -- --nocapture
```

Re-run against each componentize-js / jco release — bump jco first so the
committed lockfile doesn't pin the old verdict:

```bash
cd wit-spikes/async-gate-ts && bun update @bytecodealliance/jco
```

**Red = gate closed, do not flip `build-wasm.ts`. Green = start checklist
step 5** (drop `--disable http`, enable async-export codegen, cut TS over).
Log every run in the verdict table below, with the jco version.

## Verdict log

| Date | jco | Result |
|------|-----|--------|
| 2026-07-04 | 1.24.6 | **CLOSED** — `jco componentize` panics before codegen: `spidermonkey-embedding-splicer/src/bindgen.rs:713: not yet implemented` (a `todo!()` hit while splicing bindings for the `async func` world). Watch that file upstream. |
