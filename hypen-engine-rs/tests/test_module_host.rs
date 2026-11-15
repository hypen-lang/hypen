//! Integration tests for the native WASM module loader (`module-loader`
//! feature). Drives the committed `counter_module.wasm` fixture through the
//! `WasmtimeHost` end-to-end.
//!
//! Run with: `cargo test --features module-loader --test test_module_host`

#![cfg(feature = "module-loader")]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hypen_engine::dispatch::Action;
use hypen_engine::ir::{Element, IRNode, Props, Value};
use hypen_engine::module_host::{
    ExecStrategy, HostAction, ModuleHost, ModuleLimits, ModuleManifest, ReducerOutput,
    StorageScope, WasmtimeHost,
};
use hypen_engine::reactive::Binding;
use hypen_engine::reconcile::Patch;
use hypen_engine::{Engine, ModuleGrants};
use indexmap::indexmap;

const COUNTER: &[u8] = include_bytes!("fixtures/counter_module.wasm");
const LIMITS: &[u8] = include_bytes!("fixtures/limits_module.wasm");
const MIRROR: &[u8] = include_bytes!("fixtures/mirror_module.wasm");

fn count(state: &[u8]) -> i64 {
    let v: serde_json::Value = serde_json::from_slice(state).unwrap();
    v["count"].as_i64().unwrap()
}

#[test]
fn reducer_loop_runs_end_to_end() {
    let mut host = WasmtimeHost::new().unwrap();
    host.register("counter", COUNTER, ModuleManifest::all("counter"))
        .unwrap();

    let id = host.instantiate("counter").unwrap();
    let mut state = host.init(id, b"{}").unwrap();
    assert_eq!(count(&state), 0, "fresh module starts at 0");

    for expected in 1..=3 {
        let out: ReducerOutput = host
            .dispatch(id, &state, HostAction::new("increment", b"{}".to_vec()), &[])
            .unwrap();
        state = out.state.expect("increment returns new state");
        assert_eq!(count(&state), expected);
        // The module emits exactly one Log effect per increment.
        assert_eq!(out.effects.len(), 1, "one log effect per increment");
    }

    assert_eq!(count(&state), 3);
}

#[test]
fn storage_persists_across_instances() {
    let mut host = WasmtimeHost::new().unwrap();
    host.register("counter", COUNTER, ModuleManifest::all("counter"))
        .unwrap();

    // First instance: increment to 2, which writes through to local storage.
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

    // Second instance shares the host's storage backend → init reads back 2.
    let id2 = host.instantiate("counter").unwrap();
    let restored = host.init(id2, b"{}").unwrap();
    assert_eq!(count(&restored), 2, "warm start recovers persisted count");
}

#[test]
fn cloud_sync_uses_compare_and_set() {
    let mut host = WasmtimeHost::new().unwrap();
    host.register("counter", COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = host.instantiate("counter").unwrap();
    let mut state = host.init(id, b"{}").unwrap();
    state = host
        .dispatch(id, &state, HostAction::new("increment", b"{}".to_vec()), &[])
        .unwrap()
        .state
        .unwrap();

    // `sync` pushes to cloud via compare-and-set; it doesn't change local state.
    let out = host
        .dispatch(id, &state, HostAction::new("sync", b"{}".to_vec()), &[])
        .unwrap();
    assert!(out.state.is_none(), "sync does not mutate local state");
}

#[test]
fn lifecycle_hooks_are_callable() {
    let mut host = WasmtimeHost::new().unwrap();
    host.register("counter", COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = host.instantiate("counter").unwrap();
    let state = host.init(id, b"{}").unwrap();

    // The counter no-ops these, but they must round-trip without trapping.
    host.on_activated(id, &state, &[]).unwrap();
    host.on_deactivated(id, &state).unwrap();
    host.on_destroyed(id, &state).unwrap();
    host.destroy(id).unwrap();
}

// ── end-to-end: UI action → WASM reducer → reactive re-render ────────────────

fn scoped_text_binding(path: &str, scope: &str) -> Element {
    let parts: Vec<String> = path.split('.').map(|s| s.to_string()).collect();
    Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "text".to_string() => Value::Binding(Binding::state(parts))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: Some(scope.to_string()),
        semantics: None,
        span: None,
        expr_span: None,
    }
}

fn scoped_column(children: Vec<Element>) -> Element {
    Element {
        element_type: "Column".to_string(),
        props: Props::new(),
        ir_children: children.into_iter().map(IRNode::Element).collect(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }
}

fn patch_capture() -> (Arc<Mutex<Vec<Patch>>>, impl Fn(&[Patch])) {
    let store = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&store);
    (store, move |patches: &[Patch]| {
        sink.lock().unwrap().extend_from_slice(patches);
    })
}

fn create_texts(patches: &[Patch]) -> Vec<String> {
    patches
        .iter()
        .filter_map(|p| match p {
            Patch::Create { props, .. } => props
                .get("text")
                .or_else(|| props.get("0"))
                .map(value_to_string),
            _ => None,
        })
        .collect()
}

fn setprop_texts(patches: &[Patch]) -> Vec<String> {
    patches
        .iter()
        .filter_map(|p| match p {
            Patch::SetProp { name, value, .. } if name == "text" => Some(value_to_string(value)),
            _ => None,
        })
        .collect()
}

fn value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// The headline proof: a UI action dispatched into the engine runs the WASM
/// module's reducer, and the returned state delta flows through the engine's
/// path-based reactive system to emit a minimal patch — no DX lost.
#[test]
fn ui_action_drives_wasm_module_and_rerenders() {
    let mut engine = Engine::new();
    engine.set_module_host(Box::new(WasmtimeHost::new().unwrap()));

    engine
        .module_host_mut()
        .unwrap()
        .register("counter", COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = engine.module_host_mut().unwrap().instantiate("counter").unwrap();
    let init_bytes = engine.module_host_mut().unwrap().init(id, b"{}").unwrap();
    let init_state: serde_json::Value = serde_json::from_slice(&init_bytes).unwrap();

    engine
        .register_module_instance(
            "counter",
            id,
            vec!["increment".to_string()],
            ModuleGrants::none(),
            init_state,
        )
        .unwrap();

    let (patches, callback) = patch_capture();
    engine.set_render_callback(callback);

    // Initial render: a counter-scoped Text bound to @{state.count} shows 0.
    let root = scoped_column(vec![scoped_text_binding("count", "counter")]);
    engine.render(&root);
    {
        let captured = patches.lock().unwrap();
        let texts = create_texts(&captured);
        assert!(
            texts.contains(&"0".to_string()),
            "initial render should show count 0, got {texts:?}"
        );
    }
    patches.lock().unwrap().clear();

    // Dispatch a UI action → WASM reducer increments → reactive re-render.
    engine.dispatch_action(Action::new("increment")).unwrap();
    {
        let captured = patches.lock().unwrap();
        let texts = setprop_texts(&captured);
        assert!(
            texts.contains(&"1".to_string()),
            "increment should re-render count to 1, got {texts:?}"
        );
    }

    // And the engine's canonical state reflects the module's reducer output.
    let state = engine.get_module_state("counter").unwrap();
    assert_eq!(state["count"], 1);
}

#[test]
fn cloud_scope_denied_when_not_granted() {
    // Manifest grants only local (no cloud). The counter imports
    // hypen:storage/cloud, so instantiation must fail at link time.
    let mut host = WasmtimeHost::new().unwrap();
    let manifest = ModuleManifest {
        name: "counter".into(),
        version: "1.0.0".into(),
        storage: vec![StorageScope::Local], // cloud deliberately withheld
        reads: vec![],
        dispatches: vec![],
        http: true,
    };
    host.register("counter", COUNTER, manifest).unwrap();

    let result = host.instantiate("counter");
    assert!(
        result.is_err(),
        "instantiation must fail when an imported scope isn't granted"
    );
}

// ── cross-module state (hypen:engine/state) ──────────────────────────────────

/// Build an engine hosting both the counter and the mirror module. The mirror
/// is granted read+dispatch access to "counter". Returns the engine and the
/// counter's instance id (mirror actions are wired too).
fn engine_with_counter_and_mirror() -> Engine {
    let mut engine = Engine::new();
    engine.set_module_host(Box::new(WasmtimeHost::new().unwrap()));

    // counter: trusted sibling.
    engine
        .module_host_mut()
        .unwrap()
        .register("counter", COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    // mirror: granted read + dispatch to "counter".
    let mirror_manifest = ModuleManifest {
        name: "mirror".into(),
        version: "1.0.0".into(),
        storage: vec![],
        reads: vec!["counter".into()],
        dispatches: vec!["counter".into()],
        http: true,
    };
    engine
        .module_host_mut()
        .unwrap()
        .register("mirror", MIRROR, mirror_manifest)
        .unwrap();

    let cid = engine.module_host_mut().unwrap().instantiate("counter").unwrap();
    let cstate: serde_json::Value =
        serde_json::from_slice(&engine.module_host_mut().unwrap().init(cid, b"{}").unwrap()).unwrap();
    let mid = engine.module_host_mut().unwrap().instantiate("mirror").unwrap();
    let mstate: serde_json::Value =
        serde_json::from_slice(&engine.module_host_mut().unwrap().init(mid, b"{}").unwrap()).unwrap();

    engine
        .register_module_instance(
            "counter",
            cid,
            vec!["increment".to_string()],
            ModuleGrants::none(),
            cstate,
        )
        .unwrap();
    engine
        .register_module_instance(
            "mirror",
            mid,
            vec!["pull".to_string(), "bump".to_string(), "watch".to_string()],
            ModuleGrants::new(["counter"], ["counter"]),
            mstate,
        )
        .unwrap();
    engine
}

#[test]
fn cross_module_read_sees_sibling_state() {
    let mut engine = engine_with_counter_and_mirror();

    // Advance the counter to 2.
    engine.dispatch_action(Action::new("increment")).unwrap();
    engine.dispatch_action(Action::new("increment")).unwrap();
    assert_eq!(engine.get_module_state("counter").unwrap()["count"], 2);

    // mirror "pull" reads the counter's state and mirrors its count into `seen`.
    engine.dispatch_action(Action::new("pull")).unwrap();
    assert_eq!(
        engine.get_module_state("mirror").unwrap()["seen"],
        2,
        "mirror should read the counter's current count via hypen:engine/state"
    );
}

#[test]
fn cross_module_dispatch_drives_sibling() {
    let mut engine = engine_with_counter_and_mirror();
    assert_eq!(engine.get_module_state("counter").unwrap()["count"], 0);

    // mirror "bump" dispatches "increment" to the counter.
    engine.dispatch_action(Action::new("bump")).unwrap();
    assert_eq!(
        engine.get_module_state("counter").unwrap()["count"],
        1,
        "mirror's directed dispatch should run the counter's reducer"
    );
}

/// Cross-module subscribe: after `mirror` subscribes to `counter.count`, every
/// change to it automatically re-dispatches mirror's `pull` — so `seen` tracks
/// the counter with no polling. The subscription does not fire for the change
/// that created it.
#[test]
fn cross_module_subscribe_fires_on_sibling_change() {
    let mut engine = engine_with_counter_and_mirror();

    // mirror "watch" subscribes to counter.count (on-change = "pull").
    engine.dispatch_action(Action::new("watch")).unwrap();
    assert_eq!(
        engine.get_module_state("mirror").unwrap()["seen"], 0,
        "subscription must not fire on the dispatch that registered it"
    );

    // Each increment changes counter.count → fires mirror's pull → mirror
    // reads the fresh count into `seen`.
    engine.dispatch_action(Action::new("increment")).unwrap();
    assert_eq!(
        engine.get_module_state("mirror").unwrap()["seen"], 1,
        "sibling change should re-dispatch the subscribed on-change action"
    );
    engine.dispatch_action(Action::new("increment")).unwrap();
    assert_eq!(engine.get_module_state("mirror").unwrap()["seen"], 2);
}

/// Lifecycle fold: activating the mirror runs its `on_activated`, which
/// subscribes to `counter.count` — so a later counter change re-dispatches
/// mirror's `pull` and updates `seen`, with **no explicit "watch" action ever
/// dispatched**. Proves `on_activated`'s ReducerOutput (its subscribe request)
/// is folded by the engine rather than dropped.
#[test]
fn on_activated_subscribe_tracks_sibling_without_watch() {
    let mut engine = engine_with_counter_and_mirror();

    // Activation folds the mirror's on_activated output -> registers the
    // subscription. No "watch" dispatch involved.
    engine.activate_module("mirror").unwrap();
    assert_eq!(
        engine.get_module_state("mirror").unwrap()["seen"], 0,
        "activation alone must not change seen (subscription hasn't fired yet)"
    );

    // Each counter change now fires the auto-registered subscription -> mirror
    // pulls the fresh count into `seen`, no polling and no explicit watch.
    engine.dispatch_action(Action::new("increment")).unwrap();
    assert_eq!(
        engine.get_module_state("mirror").unwrap()["seen"], 1,
        "on_activated subscription should track the counter without an explicit watch"
    );
    engine.dispatch_action(Action::new("increment")).unwrap();
    assert_eq!(engine.get_module_state("mirror").unwrap()["seen"], 2);
}

/// A subscriber's subscriptions are dropped when it is re-wired (hot reload /
/// teardown) — a stale subscription must not keep firing on the new instance.
#[test]
fn subscriptions_are_dropped_on_rewire() {
    let mut engine = engine_with_counter_and_mirror();
    engine.dispatch_action(Action::new("watch")).unwrap();
    engine.dispatch_action(Action::new("increment")).unwrap();
    assert_eq!(engine.get_module_state("mirror").unwrap()["seen"], 1);

    // Re-wire mirror to a fresh instance (as hot reload does). Its old
    // subscription is cleared; it hasn't re-subscribed.
    let new_mid = engine.module_host_mut().unwrap().instantiate("mirror").unwrap();
    engine
        .rewire_module_instance(
            "mirror",
            new_mid,
            vec!["pull".into(), "bump".into(), "watch".into()],
            ModuleGrants::new(["counter"], ["counter"]),
        )
        .unwrap();

    // A further counter change no longer fires the dropped subscription.
    engine.dispatch_action(Action::new("increment")).unwrap();
    assert_eq!(
        engine.get_module_state("mirror").unwrap()["seen"], 1,
        "a rewired subscriber's old subscription must not fire"
    );
}

#[test]
fn cross_module_read_denied_without_grant() {
    // mirror registered with NO reads grant → its "pull" hits a
    // permission-denied from the host and surfaces as a module error.
    let mut engine = Engine::new();
    engine.set_module_host(Box::new(WasmtimeHost::new().unwrap()));
    engine
        .module_host_mut()
        .unwrap()
        .register("counter", COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let ungranted = ModuleManifest {
        name: "mirror".into(),
        version: "1.0.0".into(),
        storage: vec![],
        reads: vec![], // no read grant
        dispatches: vec![],
        http: true,
    };
    engine
        .module_host_mut()
        .unwrap()
        .register("mirror", MIRROR, ungranted)
        .unwrap();

    let cid = engine.module_host_mut().unwrap().instantiate("counter").unwrap();
    let cstate: serde_json::Value =
        serde_json::from_slice(&engine.module_host_mut().unwrap().init(cid, b"{}").unwrap()).unwrap();
    let mid = engine.module_host_mut().unwrap().instantiate("mirror").unwrap();
    let mstate: serde_json::Value =
        serde_json::from_slice(&engine.module_host_mut().unwrap().init(mid, b"{}").unwrap()).unwrap();
    engine
        .register_module_instance(
            "counter",
            cid,
            vec!["increment".to_string()],
            ModuleGrants::none(),
            cstate,
        )
        .unwrap();
    engine
        .register_module_instance(
            "mirror",
            mid,
            vec!["pull".to_string()],
            ModuleGrants::none(),
            mstate,
        )
        .unwrap();

    let result = engine.dispatch_action(Action::new("pull"));
    assert!(
        result.is_err(),
        "cross-module read without a manifest grant must be denied"
    );
}

// ── wasi:http: module makes a real HTTP request itself ──────────────────────

use std::sync::atomic::{AtomicUsize, Ordering};

const FETCHER: &[u8] = include_bytes!("fixtures/fetcher_module.wasm");

static SERVER_HITS: AtomicUsize = AtomicUsize::new(0);

/// Spin up a tiny one-shot HTTP server on 127.0.0.1, return its port.
/// Serves the given body once, then closes. Records hits in SERVER_HITS.
fn one_shot_http(body: &'static str) -> u16 {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            // Drain the request (best-effort; we don't need to parse it).
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);

            SERVER_HITS.fetch_add(1, Ordering::SeqCst);

            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });
    port
}

/// The headline proof of the wasi:http architecture: the module itself
/// makes the HTTP request (via `waki`, which compiles down to
/// `wasi:http/outgoing-handler` imports). The engine sees only the
/// resulting state delta — no Hypen-shaped fetch API anywhere.
#[test]
fn module_uses_wasi_http_for_real_http_round_trip() {
    SERVER_HITS.store(0, Ordering::SeqCst);
    let port = one_shot_http(r#"{"greeting":"hello"}"#);

    let mut engine = Engine::new();
    engine.set_module_host(Box::new(WasmtimeHost::new().unwrap()));
    engine
        .module_host_mut()
        .unwrap()
        .register("fetcher", FETCHER, ModuleManifest::all("fetcher"))
        .unwrap();
    let id = engine.module_host_mut().unwrap().instantiate("fetcher").unwrap();
    let init_state: serde_json::Value =
        serde_json::from_slice(&engine.module_host_mut().unwrap().init(id, b"{}").unwrap()).unwrap();
    engine
        .register_module_instance(
            "fetcher",
            id,
            vec!["fetch".to_string()],
            ModuleGrants::none(),
            init_state,
        )
        .unwrap();

    let url = format!("http://127.0.0.1:{port}/");
    engine
        .dispatch_action(Action::new("fetch").with_payload(serde_json::json!({ "url": url })))
        .unwrap();

    assert_eq!(SERVER_HITS.load(Ordering::SeqCst), 1, "server saw the request");
    let state = engine.get_module_state("fetcher").unwrap();
    assert_eq!(state["received"]["status"], 200);
    assert_eq!(state["received"]["body"], r#"{"greeting":"hello"}"#);
    assert!(state["error"].is_null());
}

// ── resource limits (epoch timeout + memory cap) ─────────────────────────────

/// A tight limit budget still lets a normal, fast, small dispatch through —
/// limits guard against abuse without penalizing well-behaved modules.
#[test]
fn limits_do_not_hurt_a_well_behaved_dispatch() {
    let mut host = WasmtimeHost::with_limits(ModuleLimits {
        max_memory_bytes: 64 * 1024 * 1024,
        max_call: Duration::from_millis(500),
    })
    .unwrap();
    host.register("m", LIMITS, ModuleManifest::all("m")).unwrap();
    let id = host.instantiate("m").unwrap();
    host.init(id, b"{}").unwrap();

    let out = host
        .dispatch(id, b"{\"count\":0}", HostAction::new("noop", b"{}".to_vec()), &[])
        .expect("a fast, small dispatch must succeed under limits");
    assert!(out.state.is_some());
}

/// An infinite-loop reducer is trapped by the epoch deadline instead of
/// hanging the host — the core untrusted-module safety property.
#[test]
fn runaway_dispatch_is_killed_by_the_timeout() {
    let mut host = WasmtimeHost::with_limits(ModuleLimits {
        max_memory_bytes: 256 * 1024 * 1024,
        max_call: Duration::from_millis(150),
    })
    .unwrap();
    host.register("m", LIMITS, ModuleManifest::all("m")).unwrap();
    let id = host.instantiate("m").unwrap();

    let start = Instant::now();
    let res = host.dispatch(id, b"{}", HostAction::new("hang", b"{}".to_vec()), &[]);
    let elapsed = start.elapsed();

    assert!(res.is_err(), "an infinite loop must be trapped, got {res:?}");
    // Trapped promptly — bounded by the deadline, not left to run forever.
    assert!(
        elapsed < Duration::from_secs(3),
        "timeout should fire quickly, took {elapsed:?}"
    );
}

/// A reducer that allocates far past the memory cap is denied at `memory.grow`
/// (which aborts/traps the module) rather than exhausting host RAM.
#[test]
fn oversized_allocation_is_denied_by_the_memory_cap() {
    let mut host = WasmtimeHost::with_limits(ModuleLimits {
        max_memory_bytes: 32 * 1024 * 1024,
        max_call: Duration::from_secs(5),
    })
    .unwrap();
    host.register("m", LIMITS, ModuleManifest::all("m")).unwrap();
    let id = host.instantiate("m").unwrap();

    let res = host.dispatch(id, b"{}", HostAction::new("oom", b"{}".to_vec()), &[]);
    assert!(res.is_err(), "runaway allocation must be denied, got {res:?}");
}

// ── wasi:http egress gate (manifest capability) ──────────────────────────────

/// Egress is now a manifest grant enforced at link time, like storage: a
/// module that imports `wasi:http` with `"http": false` fails to
/// instantiate, so "can this module reach the network?" is answerable from
/// the manifest alone.
#[test]
fn http_denied_module_fails_to_instantiate() {
    let mut host = WasmtimeHost::new().unwrap();
    let manifest = ModuleManifest {
        http: false,
        ..ModuleManifest::all("fetcher")
    };
    host.register("fetcher", FETCHER, manifest).unwrap();
    let err = host.instantiate("fetcher").unwrap_err();
    let msg = format!("{err}");
    assert!(
        msg.contains("wasi:http") || msg.contains("http"),
        "denial names the missing import: {msg}"
    );
}

/// The gate only bites importers: a module that never imports `wasi:http`
/// instantiates fine without the grant.
#[test]
fn http_denial_does_not_affect_non_importers() {
    let mut host = WasmtimeHost::new().unwrap();
    let manifest = ModuleManifest {
        http: false,
        ..ModuleManifest::all("counter")
    };
    host.register("counter", COUNTER, manifest).unwrap();
    let id = host.instantiate("counter").unwrap();
    let state = host.init(id, b"{}").unwrap();
    assert_eq!(count(&state), 0);
}

// ── persistent storage (shared KvBackend write-through) ─────────────────────

/// Same file-backed persistence on the sync v0.1 host: two hosts sharing a
/// snapshot path stand in for two runs of the same process.
#[test]
fn storage_survives_host_via_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("kv.json");

    {
        let mut host = WasmtimeHost::new().unwrap();
        host.set_storage_path(&file).unwrap();
        host.register("counter", COUNTER, ModuleManifest::all("counter"))
            .unwrap();
        let id = host.instantiate("counter").unwrap();
        let mut state = host.init(id, b"{}").unwrap();
        for _ in 0..2 {
            state = host
                .dispatch(id, &state, HostAction::new("increment", b"{}".to_vec()), &[])
                .unwrap()
                .state
                .unwrap();
        }
        assert_eq!(count(&state), 2);
    }

    let mut host = WasmtimeHost::new().unwrap();
    host.set_storage_path(&file).unwrap();
    host.register("counter", COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = host.instantiate("counter").unwrap();
    let restored = host.init(id, b"{}").unwrap();
    assert_eq!(count(&restored), 2, "state came back from disk");
}

// ── ExecStrategy::Interpreter (Pulley) — the iOS no-JIT path ────────────────

/// The full reducer + storage loop under the Pulley interpreter: modules are
/// compiled to Pulley bytecode and interpreted — no executable pages are
/// ever mapped, which is what iOS requires. Same fixture, same semantics.
#[test]
fn interpreter_strategy_runs_the_reducer_loop() {
    let mut host =
        WasmtimeHost::with_options(ModuleLimits::default(), ExecStrategy::Interpreter).unwrap();
    host.register("counter", COUNTER, ModuleManifest::all("counter"))
        .unwrap();
    let id = host.instantiate("counter").unwrap();
    let mut state = host.init(id, b"{}").unwrap();
    for expected in 1..=3 {
        state = host
            .dispatch(id, &state, HostAction::new("increment", b"{}".to_vec()), &[])
            .unwrap()
            .state
            .unwrap();
        assert_eq!(count(&state), expected);
    }
}

/// Epoch timeouts still bite under the interpreter — a runaway reducer is
/// killed the same way as under JIT.
#[test]
fn interpreter_strategy_enforces_the_timeout() {
    let limits = ModuleLimits {
        max_call: Duration::from_millis(300),
        ..ModuleLimits::default()
    };
    let mut host = WasmtimeHost::with_options(limits, ExecStrategy::Interpreter).unwrap();
    host.register("limits", LIMITS, ModuleManifest::all("limits"))
        .unwrap();
    let id = host.instantiate("limits").unwrap();
    let state = host.init(id, b"{}").unwrap();
    let started = Instant::now();
    let res = host.dispatch(id, &state, HostAction::new("hang", b"{}".to_vec()), &[]);
    assert!(res.is_err(), "an infinite loop must be trapped, got {res:?}");
    assert!(started.elapsed() < Duration::from_secs(5), "killed promptly");
}
