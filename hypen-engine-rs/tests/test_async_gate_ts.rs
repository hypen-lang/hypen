//! The componentize-js **async gate** — the single go/no-go signal for the
//! TS cutover to the CM-async `hypen:module@0.2.0` ABI (promotion checklist
//! step 4, `wit/WASM_ENGINE_HANDOVER.md` §5).
//!
//! What it proves when green: `jco componentize` can build a JS module
//! against the async v0.2 world such that an async export that `await`s a
//! *custom* async host import (hypen:storage) completes — no hang, no
//! syncified-export trap — on the same `WasmtimeHostAsync` that runs the
//! Rust reference module.
//!
//! Gated on `HYPEN_WASM_E2E=1` (needs bun + network for jco) and meant to be
//! re-run against each componentize-js/jco release:
//!
//! ```bash
//! HYPEN_WASM_E2E=1 cargo test --features module-loader --test test_async_gate_ts -- --nocapture
//! ```
//!
//! A **red** run is a meaningful verdict (gate closed — do NOT flip
//! `build-wasm.ts`); the failure message says where it died (componentize
//! vs. instantiate vs. the awaited dispatch). Green means start step 5.

#![cfg(feature = "module-loader")]

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use hypen_engine::module_host::{
    HostAction, ModuleHost, ModuleLimits, ModuleManifest, WasmtimeHostAsync,
};

fn gate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../wit-spikes/async-gate-ts")
}

#[test]
fn componentize_js_binds_custom_async_host_import() {
    if std::env::var("HYPEN_WASM_E2E").as_deref() != Ok("1") {
        eprintln!("skipping componentize-js async gate (set HYPEN_WASM_E2E=1 to run)");
        return;
    }
    let dir = gate_dir();

    // 1. Build: bun install (fetches jco) + jco componentize against
    //    wit-v0_2. A componentize failure is a gate verdict: closed.
    let install = Command::new("bun")
        .args(["install", "--silent"])
        .current_dir(&dir)
        .output()
        .expect("bun must be installed to run the gate");
    assert!(
        install.status.success(),
        "bun install failed:\n{}",
        String::from_utf8_lossy(&install.stderr)
    );
    let build = Command::new("bun")
        .args(["run", "build"])
        .current_dir(&dir)
        .output()
        .expect("spawn bun run build");
    assert!(
        build.status.success(),
        "GATE CLOSED at componentize: jco could not build the async world.\n\
         stdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&build.stdout),
        String::from_utf8_lossy(&build.stderr)
    );

    // 2. Drive the built component on the CM-async host under a hard
    //    deadline. StarlingMonkey components are big; the JS work itself is
    //    trivial, so 60 s of per-call budget only ever matters if the
    //    async-import machinery wedges — the gate's failure mode.
    let wasm = std::fs::read(dir.join("dist/async_gate.wasm")).expect("built component");
    let limits = ModuleLimits {
        max_call: Duration::from_secs(60),
        ..ModuleLimits::default()
    };
    let mut host = WasmtimeHostAsync::with_limits(limits).unwrap();
    host.register("gate", &wasm, ModuleManifest::all("gate"))
        .expect("GATE CLOSED at register: component rejected by wasmtime");
    let id = host
        .instantiate("gate")
        .expect("GATE CLOSED at instantiate: async world type mismatch or missing import");

    // 3. The behavioral assertion: an async export awaiting a custom async
    //    host import must complete with the awaited value.
    let state = host
        .init(id, b"{}")
        .expect("GATE CLOSED at init: awaited storage warm-start did not complete");
    let out = host
        .dispatch(id, &state, HostAction::new("increment", b"{}".to_vec()), &[])
        .expect("GATE CLOSED at dispatch: awaited set/get round-trip hung or trapped");
    let new_state = out.state.expect("increment returns a delta");
    let v: serde_json::Value = serde_json::from_slice(&new_state).unwrap();
    assert_eq!(
        v["count"].as_i64(),
        Some(1),
        "GATE CLOSED: delta did not round-trip through the awaited import"
    );

    println!("GATE OPEN: componentize-js bound a custom async host import — start the TS cutover (checklist step 5).");
}
