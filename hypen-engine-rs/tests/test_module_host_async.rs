//! Integration tests for the **CM-async** module host (`WasmtimeHostAsync`,
//! `hypen:module@0.2.0`). Drives the committed `async_counter_module.wasm`
//! fixture — a Rust guest whose reducer/lifecycle exports are WIT
//! `async func` and which `await`s its storage / cross-module capability
//! imports inline — proving the v0.2 async ABI end-to-end on wasmtime 46:
//!
//!   - async exports return their delta *after* suspension points, and the
//!     engine-facing `ReducerOutput` is byte-identical in shape to v0.1, so
//!     the path-diff pipeline consumes it unchanged;
//!   - awaited custom async host imports (storage get/set, cloud CAS,
//!     cross-module read/subscribe) round-trip through the component event
//!     loop;
//!   - the sync `actions` export coexists on the concurrent call path;
//!   - link-time capability denial and per-call ACLs still hold;
//!   - the epoch timeout still kills a runaway async dispatch.
//!
//! Run with: `cargo test --features module-loader --test test_module_host_async`

use std::time::{Duration, Instant};

use hypen_engine::module_host::{
    HostAction, HostError, ModuleHost, ModuleLimits, ModuleManifest, ReducerOutput,
    StorageScope, WasmtimeHostAsync,
};

const ASYNC_COUNTER: &[u8] = include_bytes!("fixtures/async_counter_module.wasm");

fn count(state: &[u8]) -> i64 {
    let v: serde_json::Value = serde_json::from_slice(state).unwrap();
    v["count"].as_i64().unwrap()
}

#[test]
fn async_reducer_loop_runs_end_to_end() {
    let mut host = WasmtimeHostAsync::new().unwrap();
    host.register("counter", ASYNC_COUNTER, ModuleManifest::all("counter"))
        .unwrap();

    let id = host.instantiate("counter").unwrap();

    // The sync `actions` export works through the concurrent call path.
    let actions = host.actions(id).unwrap();
    assert!(actions.contains(&"increment".to_string()), "actions: {actions:?}");

    // `init` awaits a storage read before returning the snapshot.
    let mut state = host.init(id, b"{}").unwrap();
    assert_eq!(count(&state), 0, "fresh module starts at 0");

    // Each dispatch awaits storage set + read-back (two suspension points)
    // and still returns the delta + one Log effect.
    for expected in 1..=3 {
        let out: ReducerOutput = host
            .dispatch(id, &state, HostAction::new("increment", b"{}".to_vec()), &[])
            .unwrap();
        state = out.state.expect("increment returns new state");
        assert_eq!(count(&state), expected);
        assert_eq!(out.effects.len(), 1, "one log effect per increment");
    }
}

#[test]
fn async_init_seeds_from_config() {
    let mut host = WasmtimeHostAsync::new().unwrap();
    host.register("counter", ASYNC_COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = host.instantiate("counter").unwrap();
    let state = host.init(id, br#"{"start": 7}"#).unwrap();
    assert_eq!(count(&state), 7, "declaration-site config seeds init");
}

#[test]
fn async_storage_persists_across_instances() {
    let mut host = WasmtimeHostAsync::new().unwrap();
    host.register("counter", ASYNC_COUNTER, ModuleManifest::all("counter"))
        .unwrap();

    let id1 = host.instantiate("counter").unwrap();
    let mut state = host.init(id1, b"{}").unwrap();
    for _ in 0..2 {
        state = host
            .dispatch(id1, &state, HostAction::new("increment", b"{}".to_vec()), &[])
            .unwrap()
            .state
            .unwrap();
    }
    assert_eq!(count(&state), 2);
    host.destroy(id1).unwrap();

    // Second instance shares the host's storage backend → the awaited
    // storage read inside `init` warm-starts at 2.
    let id2 = host.instantiate("counter").unwrap();
    let restored = host.init(id2, b"{}").unwrap();
    assert_eq!(count(&restored), 2, "warm start recovers persisted count");
}

#[test]
fn async_cloud_sync_uses_compare_and_set() {
    let mut host = WasmtimeHostAsync::new().unwrap();
    host.register("counter", ASYNC_COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = host.instantiate("counter").unwrap();
    let state = host.init(id, b"{}").unwrap();

    // Awaited cloud CAS round-trips twice: first write creates version 1,
    // the second reads `info` (awaited) and bumps to version 2.
    for _ in 0..2 {
        let out = host
            .dispatch(id, &state, HostAction::new("sync", b"{}".to_vec()), &[])
            .unwrap();
        assert!(out.state.is_none(), "sync is a no-change action");
    }
}

#[test]
fn async_cloud_scope_denied_when_not_granted() {
    let mut host = WasmtimeHostAsync::new().unwrap();
    let manifest = ModuleManifest {
        name: "counter".into(),
        storage: vec![StorageScope::Local], // no cloud grant
        ..ModuleManifest::all("counter")
    };
    host.register("counter", ASYNC_COUNTER, manifest).unwrap();
    // Link-time denial: the component imports hypen:storage/cloud@0.2.0,
    // which the linker doesn't provide without the grant.
    let err = host.instantiate("counter").unwrap_err();
    let msg = format!("{err}");
    assert!(msg.contains("cloud"), "denial names the missing scope: {msg}");
}

#[test]
fn async_cross_module_read_is_awaited_and_acl_gated() {
    let mut host = WasmtimeHostAsync::new().unwrap();
    let manifest = ModuleManifest {
        name: "watcher".into(),
        reads: vec!["counter".into()],
        ..ModuleManifest::all("watcher")
    };
    host.register("watcher", ASYNC_COUNTER, manifest).unwrap();
    let id = host.instantiate("watcher").unwrap();
    let state = host.init(id, b"{}").unwrap();

    // Awaited cross-module READ with the sibling snapshot installed.
    let siblings = vec![("counter".to_string(), br#"{"count":42}"#.to_vec())];
    let out = host
        .dispatch(id, &state, HostAction::new("pull", b"{}".to_vec()), &siblings)
        .unwrap();
    let mirrored = out.state.expect("pull mirrors the sibling's count");
    let v: serde_json::Value = serde_json::from_slice(&mirrored).unwrap();
    assert_eq!(v["seen"].as_i64(), Some(42));

    // Without a `reads` grant the same awaited read is denied at call time
    // (`ModuleManifest::all` grants storage but no cross-module reads).
    host.register("blind", ASYNC_COUNTER, ModuleManifest::all("blind"))
        .unwrap();
    let blind = host.instantiate("blind").unwrap();
    let blind_state = host.init(blind, b"{}").unwrap();
    let err = host
        .dispatch(blind, &blind_state, HostAction::new("pull", b"{}".to_vec()), &siblings)
        .unwrap_err();
    assert!(format!("{err}").contains("PermissionDenied"), "{err}");
}

#[test]
fn async_on_activated_registers_subscription() {
    let mut host = WasmtimeHostAsync::new().unwrap();
    let manifest = ModuleManifest {
        name: "watcher".into(),
        reads: vec!["counter".into()],
        ..ModuleManifest::all("watcher")
    };
    host.register("watcher", ASYNC_COUNTER, manifest).unwrap();
    let id = host.instantiate("watcher").unwrap();
    let state = host.init(id, b"{}").unwrap();

    // on-activated awaits `subscribe`; the request is folded into the
    // ReducerOutput exactly like the sync host does it.
    let out = host.on_activated(id, &state, &[]).unwrap();
    assert_eq!(out.subscribe_requests.len(), 1);
    let sub = &out.subscribe_requests[0];
    assert_eq!(sub.target, "counter");
    assert_eq!(sub.path, "count");
    assert_eq!(sub.on_change, "pull");
}

#[test]
fn async_runaway_dispatch_is_killed_by_the_timeout() {
    let limits = ModuleLimits {
        max_call: Duration::from_millis(200),
        ..ModuleLimits::default()
    };
    let mut host = WasmtimeHostAsync::with_limits(limits).unwrap();
    host.register("counter", ASYNC_COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = host.instantiate("counter").unwrap();
    let state = host.init(id, b"{}").unwrap();

    let started = Instant::now();
    let err = host
        .dispatch(id, &state, HostAction::new("spin", b"{}".to_vec()), &[])
        .unwrap_err();
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(3),
        "epoch deadline cut the spin short (took {elapsed:?})"
    );
    // The epoch reason sits in the anyhow chain (flattened by the host into
    // a Trap); the wall-clock bound above is the real proof the deadline
    // fired, so just require a trap-shaped error.
    assert!(format!("{err}").contains("trap"), "unexpected error: {err}");
}

// ── engine integration: UI action → async reducer → minimal patch ───────────

use std::sync::{Arc, Mutex};

use hypen_engine::dispatch::Action;
use hypen_engine::ir::{Element, IRNode, Props, Value};
use hypen_engine::reactive::Binding;
use hypen_engine::reconcile::Patch;
use hypen_engine::Engine;
use indexmap::indexmap;

/// The v0.2 counterpart of `ui_action_drives_wasm_module_and_rerenders`: a
/// UI action runs the CM-async reducer — which suspends twice on awaited
/// storage calls mid-dispatch — and the returned delta flows through the
/// same path-based reactive system into a minimal SetProp. The engine is
/// completely unaware which ABI produced the delta.
#[test]
fn ui_action_drives_async_wasm_module_and_rerenders() {
    let mut engine = Engine::new();
    engine.set_module_host(Box::new(WasmtimeHostAsync::new().unwrap()));

    engine
        .module_host_mut()
        .unwrap()
        .register("counter", ASYNC_COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = engine.module_host_mut().unwrap().instantiate("counter").unwrap();
    let init_bytes = engine.module_host_mut().unwrap().init(id, b"{}").unwrap();
    let init_state: serde_json::Value = serde_json::from_slice(&init_bytes).unwrap();

    engine
        .register_module_instance(
            "counter",
            id,
            vec!["increment".to_string()],
            hypen_engine::ModuleGrants::none(),
            init_state,
        )
        .unwrap();

    let patches: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&patches);
    engine.set_render_callback(move |batch: &[Patch]| {
        sink.lock().unwrap().extend_from_slice(batch);
    });

    // Initial render: a counter-scoped Text bound to @{state.count} shows 0.
    let text = Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "text".to_string() => Value::Binding(Binding::state(vec!["count".to_string()]))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: Some("counter".to_string()),
        semantics: None,
        span: None,
        expr_span: None,
    };
    let root = Element {
        element_type: "Column".to_string(),
        props: Props::new(),
        ir_children: vec![IRNode::Element(text)],
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    };
    engine.render(&root);
    {
        let captured = patches.lock().unwrap();
        let initial = captured.iter().any(|p| matches!(
            p,
            Patch::Create { props, .. }
                if props.get("text").map(|v| v == &serde_json::json!(0)).unwrap_or(false)
        ));
        assert!(initial, "initial render should show count 0: {captured:?}");
    }
    patches.lock().unwrap().clear();

    // UI action → async reducer (awaits storage set + read-back) → delta →
    // reactive re-render of exactly the bound Text.
    engine.dispatch_action(Action::new("increment")).unwrap();
    {
        let captured = patches.lock().unwrap();
        let rerendered = captured.iter().any(|p| matches!(
            p,
            Patch::SetProp { name, value, .. }
                if name == "text" && value == &serde_json::json!(1)
        ));
        assert!(rerendered, "increment should re-render count to 1: {captured:?}");
    }

    let state = engine.get_module_state("counter").unwrap();
    assert_eq!(state["count"], 1);
}

// ── D1 shape: real HTTP from inside an async reducer (manifest-gated) ───────

use std::io::{Read as IoRead, Write as IoWrite};
use std::net::TcpListener;

/// One-shot local HTTP server: accepts a single connection, returns `body`.
fn one_shot_http(body: &'static str) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let resp = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
        }
    });
    port
}

/// The constrained-data-access shape on the wasm target: an async reducer
/// does a real `wasi:http` GET (waki, p2 surface) *and* an awaited custom
/// storage import in the same pass, then returns one delta. The p2 sync
/// http host functions coexist with CM-async imports on one linker.
#[test]
fn async_reducer_fetches_over_wasi_http() {
    let port = one_shot_http("{\"rows\":[1,2,3]}");

    let limits = ModuleLimits {
        max_call: Duration::from_secs(30), // generous: real TCP in the loop
        ..ModuleLimits::default()
    };
    let mut host = WasmtimeHostAsync::with_limits(limits).unwrap();
    host.register("counter", ASYNC_COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = host.instantiate("counter").unwrap();
    let state = host.init(id, b"{}").unwrap();

    let payload = format!("{{\"url\":\"http://127.0.0.1:{port}/data\"}}");
    let out = host
        .dispatch(id, &state, HostAction::new("fetch", payload.into_bytes()), &[])
        .unwrap();
    let new_state = out.state.expect("fetch returns a delta");
    let v: serde_json::Value = serde_json::from_slice(&new_state).unwrap();
    assert_eq!(v["received"]["status"], 200, "state: {v}");
    assert_eq!(v["received"]["body"], "{\"rows\":[1,2,3]}", "state: {v}");
    assert!(v["error"].is_null(), "state: {v}");
}

/// Egress is manifest-gated on the async host too: linking is skipped
/// without the grant, so the http-importing module fails to instantiate.
#[test]
fn async_http_denied_module_fails_to_instantiate() {
    let mut host = WasmtimeHostAsync::new().unwrap();
    let manifest = ModuleManifest {
        http: false,
        ..ModuleManifest::all("counter")
    };
    host.register("counter", ASYNC_COUNTER, manifest).unwrap();
    let err = host.instantiate("counter").unwrap_err();
    assert!(format!("{err}").contains("http"), "denial names the import: {err}");
}

// ── hypen:time — the first post-pioneer stdlib capability ───────────────────

/// Real clock: an async reducer awaits `sleep-ms` mid-pass (the task
/// suspends through the component event loop while the host sleeps) and
/// stamps wall/monotonic readings into the state.
#[test]
fn async_reducer_sleeps_on_real_clock() {
    let mut host = WasmtimeHostAsync::new().unwrap();
    host.register("counter", ASYNC_COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = host.instantiate("counter").unwrap();
    let state = host.init(id, b"{}").unwrap();

    let started = Instant::now();
    let out = host
        .dispatch(id, &state, HostAction::new("tick", br#"{"ms":80}"#.to_vec()), &[])
        .unwrap();
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(80), "really slept: {elapsed:?}");

    let v: serde_json::Value = serde_json::from_slice(&out.state.unwrap()).unwrap();
    assert!(v["slept_ms"].as_u64().unwrap() >= 80, "state: {v}");
    // woke_at is wall-clock epoch ms — sanity: after 2020-01-01.
    assert!(v["woke_at"].as_u64().unwrap() > 1_577_836_800_000, "state: {v}");
}

/// Virtual clock: the same guest code becomes deterministic. `sleep-ms`
/// advances the counter without waiting, and every reading is exact — the
/// foundation for record/replay debugging of reducer runs.
#[test]
fn virtual_clock_makes_time_deterministic() {
    let mut host = WasmtimeHostAsync::new().unwrap();
    host.set_virtual_clock(1_000_000);
    host.register("counter", ASYNC_COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = host.instantiate("counter").unwrap();
    let state = host.init(id, b"{}").unwrap();

    let started = Instant::now();
    let out = host
        .dispatch(id, &state, HostAction::new("tick", br#"{"ms":250}"#.to_vec()), &[])
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(200),
        "virtual sleep must not wait in real time"
    );

    let v: serde_json::Value = serde_json::from_slice(&out.state.unwrap()).unwrap();
    assert_eq!(v["woke_at"].as_u64(), Some(1_000_250), "exact, replayable: {v}");
    assert_eq!(v["slept_ms"].as_u64(), Some(250), "state: {v}");
}

// ── persistent storage: state survives the process, not just the instance ──

/// `set_storage_path` makes local storage write-through to a JSON snapshot:
/// a second host (standing in for a second *process*) warm-starts from the
/// file. This is the desktop persistence story minus nothing.
#[test]
fn async_storage_survives_host_via_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("kv.json");

    {
        let mut host = WasmtimeHostAsync::new().unwrap();
        host.set_storage_path(&file).unwrap();
        host.register("counter", ASYNC_COUNTER, ModuleManifest::all("counter"))
            .unwrap();
        let id = host.instantiate("counter").unwrap();
        let mut state = host.init(id, b"{}").unwrap();
        for _ in 0..3 {
            state = host
                .dispatch(id, &state, HostAction::new("increment", b"{}".to_vec()), &[])
                .unwrap()
                .state
                .unwrap();
        }
        assert_eq!(count(&state), 3);
    } // host dropped — everything in memory is gone

    let mut host = WasmtimeHostAsync::new().unwrap();
    host.set_storage_path(&file).unwrap();
    host.register("counter", ASYNC_COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = host.instantiate("counter").unwrap();
    let restored = host.init(id, b"{}").unwrap();
    assert_eq!(count(&restored), 3, "state came back from disk");
}

// ── sandbox hardening (same properties as the v0.1 host) ────────────────────

/// Upper bound for "returned at about `max_call`".
const DEADLINE_SLACK: Duration = Duration::from_secs(3);

/// `hypen:time.sleep-ms` suspends the guest task on the host's runtime; a
/// sleep far past the per-call budget is cancelled at the deadline (it is
/// not capped-then-resumed, and it does not park the host thread for an
/// hour). The instance is dead afterwards.
#[test]
fn async_sleep_past_the_deadline_is_cancelled() {
    let limits = ModuleLimits {
        max_call: Duration::from_millis(300),
        ..ModuleLimits::default()
    };
    let mut host = WasmtimeHostAsync::with_limits(limits).unwrap();
    host.register("counter", ASYNC_COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = host.instantiate("counter").unwrap();
    let state = host.init(id, b"{}").unwrap();

    let started = Instant::now();
    let err = host
        .dispatch(id, &state, HostAction::new("tick", br#"{"ms":3600000}"#.to_vec()), &[])
        .unwrap_err();
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(300), "ran its budget: {elapsed:?}");
    assert!(elapsed < DEADLINE_SLACK, "cancelled at the deadline, took {elapsed:?}");
    assert!(matches!(err, HostError::Trap(_)), "{err}");
    assert!(format!("{err}").contains("wall-clock budget"), "{err}");

    let again = host.dispatch(id, &state, HostAction::new("increment", b"{}".to_vec()), &[]);
    assert!(matches!(again, Err(HostError::DeadInstance)), "{again:?}");
    assert!(matches!(host.actions(id), Err(HostError::DeadInstance)));
    host.destroy(id).unwrap();

    // A fresh instance of the same module works.
    let id2 = host.instantiate("counter").unwrap();
    let state = host.init(id2, b"{}").unwrap();
    host.dispatch(id2, &state, HostAction::new("increment", b"{}".to_vec()), &[])
        .unwrap();
}

/// The virtual clock still resumes instantly, however long the sleep.
#[test]
fn async_virtual_clock_sleep_does_not_wait() {
    let limits = ModuleLimits {
        max_call: Duration::from_secs(2),
        ..ModuleLimits::default()
    };
    let mut host = WasmtimeHostAsync::with_limits(limits).unwrap();
    let clock = host.set_virtual_clock(1_000);
    host.register("counter", ASYNC_COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = host.instantiate("counter").unwrap();
    let state = host.init(id, b"{}").unwrap();

    let started = Instant::now();
    let out = host
        .dispatch(id, &state, HostAction::new("tick", br#"{"ms":3600000}"#.to_vec()), &[])
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    let v: serde_json::Value = serde_json::from_slice(&out.state.unwrap()).unwrap();
    assert_eq!(v["slept_ms"], 3_600_000);
    assert_eq!(clock.load(std::sync::atomic::Ordering::Relaxed), 3_601_000);
}

/// `wasi:http` to a server that accepts and never answers: the async
/// reducer's fetch is cancelled at the deadline instead of hanging the host.
#[test]
fn async_http_request_to_a_silent_server_is_cancelled_at_the_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let mut held = Vec::new();
        while let Ok((stream, _)) = listener.accept() {
            held.push(stream);
        }
    });

    let limits = ModuleLimits {
        max_call: Duration::from_millis(500),
        ..ModuleLimits::default()
    };
    let mut host = WasmtimeHostAsync::with_limits(limits).unwrap();
    host.register("counter", ASYNC_COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = host.instantiate("counter").unwrap();
    let state = host.init(id, b"{}").unwrap();

    let payload = format!("{{\"url\":\"http://127.0.0.1:{port}/data\"}}");
    let started = Instant::now();
    let res = host.dispatch(id, &state, HostAction::new("fetch", payload.into_bytes()), &[]);
    let elapsed = started.elapsed();
    assert!(matches!(res, Err(HostError::Trap(_))), "{res:?}");
    assert!(elapsed >= Duration::from_millis(500), "ran its budget: {elapsed:?}");
    assert!(elapsed < DEADLINE_SLACK, "cancelled at the deadline, took {elapsed:?}");
    assert!(matches!(host.actions(id), Err(HostError::DeadInstance)));
}

/// `local` storage is private to the registered module on the async host
/// too: the same component registered under two names keeps two counts,
/// although both use the identical (tier, namespace, key).
#[test]
fn async_local_storage_is_private_to_each_module() {
    let mut host = WasmtimeHostAsync::new().unwrap();
    host.register("a", ASYNC_COUNTER, ModuleManifest::all("a")).unwrap();
    host.register("b", ASYNC_COUNTER, ModuleManifest::all("b")).unwrap();

    let a = host.instantiate("a").unwrap();
    let mut state = host.init(a, b"{}").unwrap();
    for _ in 0..3 {
        state = host
            .dispatch(a, &state, HostAction::new("increment", b"{}".to_vec()), &[])
            .unwrap()
            .state
            .unwrap();
    }
    assert_eq!(count(&state), 3);

    // Module B warm-starts from *its own* (empty) local storage.
    let b = host.instantiate("b").unwrap();
    assert_eq!(count(&host.init(b, b"{}").unwrap()), 0, "b must not see a's count");
    // ...while another instance of A sees A's persisted count.
    let a2 = host.instantiate("a").unwrap();
    assert_eq!(count(&host.init(a2, b"{}").unwrap()), 3);
}

/// Storage quotas apply on the async host: with a budget too small for the
/// counter's persisted state, the awaited `set` fails with `quota-exceeded`
/// (surfaced by the module as its error) and the instance stays alive.
#[test]
fn async_storage_writes_are_bounded_by_quota() {
    let limits = ModuleLimits {
        max_storage_value_bytes: 4,
        ..ModuleLimits::default()
    };
    let mut host = WasmtimeHostAsync::with_limits(limits).unwrap();
    host.register("counter", ASYNC_COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = host.instantiate("counter").unwrap();
    let state = host.init(id, b"{}").unwrap();
    let err = host
        .dispatch(id, &state, HostAction::new("increment", b"{}".to_vec()), &[])
        .unwrap_err();
    assert!(matches!(err, HostError::ModuleError(_)), "{err}");
    assert!(format!("{err}").contains("QuotaExceeded"), "{err}");
    // A module error is not a trap: the instance is still callable.
    host.actions(id).unwrap();
}

// ── bad paths (the v0.2 host shares the v0.1 host's implementation; these
//    pin that the shared behaviour holds through the CM-async bindings) ─────

const SYNC_COUNTER_V01: &[u8] = include_bytes!("fixtures/counter_module.wasm");

/// A component for the other ABI version is refused at `register`, naming
/// the version it targets and the one this host serves.
#[test]
fn async_register_refuses_a_v01_component_and_garbage() {
    let mut host = WasmtimeHostAsync::new().unwrap();
    let err = host
        .register("m", SYNC_COUNTER_V01, ModuleManifest::all("m"))
        .unwrap_err();
    assert!(matches!(err, HostError::Instantiate(_)), "{err}");
    let msg = format!("{err}");
    assert!(
        msg.contains("@0.1.0") && msg.contains("this host serves hypen:module@0.2.0"),
        "{msg}"
    );

    let err = host
        .register("m", b"nope", ModuleManifest::all("m"))
        .unwrap_err();
    assert!(
        format!("{err}").contains("not a WebAssembly binary"),
        "{err}"
    );
    let err = host
        .register("m", b"\0asm\x0d\0\x01\0", ModuleManifest::all("m"))
        .unwrap_err();
    assert!(
        format!("{err}").contains("does not export the hypen:module@0.2.0 world"),
        "{err}"
    );
    assert!(matches!(
        host.instantiate("m"),
        Err(HostError::UnknownModule(_))
    ));
}

#[test]
fn async_capability_denial_names_the_import_and_the_grant() {
    let mut host = WasmtimeHostAsync::new().unwrap();
    let no_cloud = ModuleManifest {
        storage: vec![],
        ..ModuleManifest::all("cart")
    };
    host.register("cart", ASYNC_COUNTER, no_cloud).unwrap();
    let msg = format!("{}", host.instantiate("cart").unwrap_err());
    assert_eq!(
        msg,
        "instantiation failed: module 'cart' imports hypen:storage/cloud@0.2.0 but its \
         manifest does not grant storage scope `cloud`"
    );

    // Several missing grants are all listed.
    host.register("cart", ASYNC_COUNTER, ModuleManifest::default())
        .unwrap();
    let msg = format!("{}", host.instantiate("cart").unwrap_err());
    assert!(
        msg.contains("does not grant storage scope `cloud`; imports wasi:http/"),
        "{msg}"
    );
    assert!(msg.ends_with("does not grant `http`"), "{msg}");
}

/// Failures name the module, the export and the cause; the instance
/// remembers what killed it; destroyed and foreign ids are dead.
#[test]
fn async_failures_and_dead_ids_match_the_sync_host() {
    let limits = ModuleLimits {
        max_call: Duration::from_millis(300),
        ..ModuleLimits::default()
    };
    let mut host = WasmtimeHostAsync::with_limits(limits).unwrap();
    host.register("m", ASYNC_COUNTER, ModuleManifest::all("m"))
        .unwrap();

    let id = host.instantiate("m").unwrap();
    let state = host.init(id, b"{}").unwrap();
    let err = host
        .dispatch(id, &state, HostAction::new("spin", Vec::new()), &[])
        .unwrap_err();
    assert!(matches!(err, HostError::Trap(_)), "{err}");
    assert_eq!(
        host.death_reason(id).as_deref(),
        Some(
            "module 'm' export `dispatch` exceeded its 300 ms CPU budget: guest code was still \
             running at the deadline"
        )
    );
    host.destroy(id).unwrap();
    assert_eq!(host.death_reason(id), None);
    assert!(matches!(host.destroy(id), Err(HostError::DeadInstance)));

    let id = host.instantiate("m").unwrap();
    let state = host.init(id, b"{}").unwrap();
    let err = host
        .dispatch(id, &state, HostAction::new("nope", Vec::new()), &[])
        .unwrap_err();
    assert_eq!(
        format!("{err}"),
        "module returned error: module 'm' export `dispatch`: unknown action: nope"
    );
    assert_eq!(host.death_reason(id), None);

    // Ids of another host (either ABI) are dead here.
    let mut other = WasmtimeHostAsync::new().unwrap();
    other
        .register("m", ASYNC_COUNTER, ModuleManifest::all("m"))
        .unwrap();
    let foreign = other.instantiate("m").unwrap();
    assert!(matches!(
        host.actions(foreign),
        Err(HostError::DeadInstance)
    ));
    assert!(matches!(
        host.destroy(foreign),
        Err(HostError::DeadInstance)
    ));
    assert!(matches!(other.actions(id), Err(HostError::DeadInstance)));
    other.actions(foreign).unwrap();

    // State bytes are not parsed by the host on the way in: what the module
    // makes of garbage is its business, and nothing traps.
    let res = host.dispatch(
        id,
        &[0xff, 0x00],
        HostAction::new("increment", Vec::new()),
        &[],
    );
    assert!(
        !matches!(res, Err(HostError::Trap(_) | HostError::DeadInstance)),
        "{res:?}"
    );
    host.actions(id).unwrap();
}

/// Re-registering does not change a live instance (v0.2).
#[test]
fn async_reregistering_does_not_change_live_instances() {
    let mut host = WasmtimeHostAsync::new().unwrap();
    host.register("m", ASYNC_COUNTER, ModuleManifest::all("m"))
        .unwrap();
    let id = host.instantiate("m").unwrap();
    let state = host.init(id, b"{}").unwrap();

    // Now the name needs a grant it doesn't have: new instances are refused…
    host.register("m", ASYNC_COUNTER, ModuleManifest::default())
        .unwrap();
    assert!(matches!(
        host.instantiate("m"),
        Err(HostError::Instantiate(_))
    ));
    // …the live one carries on.
    let out = host
        .dispatch(
            id,
            &state,
            HostAction::new("increment", b"{}".to_vec()),
            &[],
        )
        .unwrap();
    assert_eq!(count(&out.state.unwrap()), 1);
}
