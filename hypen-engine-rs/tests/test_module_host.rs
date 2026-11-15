//! Integration tests for the native WASM module loader (`module-loader`
//! feature). Drives the committed `counter_module.wasm` fixture through the
//! `WasmtimeHost` end-to-end.
//!
//! Run with: `cargo test --features module-loader --test test_module_host`

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hypen_engine::dispatch::Action;
use hypen_engine::ir::{Element, IRNode, Props, Value};
use hypen_engine::module_host::{
    ExecStrategy, HostAction, HostError, ModuleHost, ModuleInstanceId, ModuleLimits,
    ModuleManifest, ReducerOutput, StorageScope, WasmtimeHost,
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
        ..Default::default()
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
        ..Default::default()
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
        ..Default::default()
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

// ── sandbox hardening: deadline covers host calls ───────────────────────────

/// Upper bound for "returned at about `max_call`": generous enough for a
/// loaded CI box, far below the hour-long sleep / never-answering server
/// the guest is actually parked on.
const DEADLINE_SLACK: Duration = Duration::from_secs(3);

fn deadline_host(max_call: Duration) -> WasmtimeHost {
    WasmtimeHost::with_limits(ModuleLimits {
        max_call,
        ..ModuleLimits::default()
    })
    .unwrap()
}

/// A guest parked in a host call (`wasi:io` poll on a day-long timer) never
/// re-enters guest code, so epoch interruption alone can't stop it. The
/// wall-clock deadline must cancel the call — and leave the instance dead.
#[test]
fn dispatch_blocked_in_a_host_call_is_cancelled_at_the_deadline() {
    let mut host = deadline_host(Duration::from_millis(300));
    host.register("m", LIMITS, ModuleManifest::all("m")).unwrap();
    let id = host.instantiate("m").unwrap();
    let state = host.init(id, b"{}").unwrap();

    let started = Instant::now();
    let err = host
        .dispatch(id, &state, HostAction::new("block", Vec::new()), &[])
        .unwrap_err();
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(300), "ran its budget: {elapsed:?}");
    assert!(elapsed < DEADLINE_SLACK, "cancelled at the deadline, took {elapsed:?}");
    assert!(matches!(err, HostError::Trap(_)), "timeout surfaces as a trap: {err}");
    assert!(format!("{err}").contains("wall-clock budget"), "{err}");

    // The store is gone: every later call reports a dead instance rather
    // than touching it.
    let again = host.dispatch(id, &state, HostAction::new("noop", Vec::new()), &[]);
    assert!(matches!(again, Err(HostError::DeadInstance)), "{again:?}");
    assert!(matches!(host.actions(id), Err(HostError::DeadInstance)));
    assert!(matches!(host.on_destroyed(id, &state), Err(HostError::DeadInstance)));
    // Destroying a dead instance releases its slot.
    host.destroy(id).unwrap();
    assert!(matches!(host.destroy(id), Err(HostError::DeadInstance)));

    // Other instances of the same module are unaffected.
    let id2 = host.instantiate("m").unwrap();
    host.init(id2, b"{}").unwrap();
    host.dispatch(id2, b"{}", HostAction::new("noop", Vec::new()), &[])
        .unwrap();
}

/// The deadline covers every entry point, not just `dispatch`: `init`
/// blocking in a host call is cancelled the same way.
#[test]
fn init_blocked_in_a_host_call_is_cancelled_at_the_deadline() {
    let mut host = deadline_host(Duration::from_millis(300));
    host.register("m", LIMITS, ModuleManifest::all("m")).unwrap();
    let id = host.instantiate("m").unwrap();

    let started = Instant::now();
    let err = host.init(id, b"block").unwrap_err();
    let elapsed = started.elapsed();
    assert!(elapsed < DEADLINE_SLACK, "cancelled at the deadline, took {elapsed:?}");
    assert!(matches!(err, HostError::Trap(_)), "{err}");
    assert!(matches!(host.init(id, b"{}"), Err(HostError::DeadInstance)));
}

/// Same under the Pulley interpreter (the iOS configuration).
#[test]
fn interpreter_strategy_cancels_a_blocked_host_call() {
    let limits = ModuleLimits {
        max_call: Duration::from_millis(300),
        ..ModuleLimits::default()
    };
    let mut host = WasmtimeHost::with_options(limits, ExecStrategy::Interpreter).unwrap();
    host.register("m", LIMITS, ModuleManifest::all("m")).unwrap();
    let id = host.instantiate("m").unwrap();
    let started = Instant::now();
    let res = host.dispatch(id, b"{}", HostAction::new("block", Vec::new()), &[]);
    assert!(matches!(res, Err(HostError::Trap(_))), "{res:?}");
    assert!(started.elapsed() < DEADLINE_SLACK);
}

/// A TCP server that accepts connections and then never answers. Returns
/// its port; the listener thread holds every accepted socket open.
fn black_hole_http() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let mut held = Vec::new();
        while let Ok((stream, _)) = listener.accept() {
            held.push(stream);
        }
    });
    port
}

/// `wasi:http` to a server that never answers: the guest waits on the
/// response pollable forever, so the wall-clock deadline has to end the call.
#[test]
fn http_request_to_a_silent_server_is_cancelled_at_the_deadline() {
    let port = black_hole_http();
    let mut host = deadline_host(Duration::from_millis(500));
    host.register("fetcher", FETCHER, ModuleManifest::all("fetcher"))
        .unwrap();
    let id = host.instantiate("fetcher").unwrap();
    let state = host.init(id, b"{}").unwrap();

    let payload = format!("{{\"url\":\"http://127.0.0.1:{port}/\"}}");
    let started = Instant::now();
    let res = host.dispatch(id, &state, HostAction::new("fetch", payload.into_bytes()), &[]);
    let elapsed = started.elapsed();
    assert!(matches!(res, Err(HostError::Trap(_))), "{res:?}");
    assert!(elapsed >= Duration::from_millis(500), "ran its budget: {elapsed:?}");
    assert!(elapsed < DEADLINE_SLACK, "cancelled at the deadline, took {elapsed:?}");
    assert!(matches!(host.actions(id), Err(HostError::DeadInstance)));
}

/// A trap (here: allocation past the memory budget) also kills the instance.
#[test]
fn a_trapped_instance_is_dead() {
    let mut host = WasmtimeHost::with_limits(ModuleLimits {
        max_memory_bytes: 32 * 1024 * 1024,
        ..ModuleLimits::default()
    })
    .unwrap();
    host.register("m", LIMITS, ModuleManifest::all("m")).unwrap();
    let id = host.instantiate("m").unwrap();
    let res = host.dispatch(id, b"{}", HostAction::new("oom", Vec::new()), &[]);
    assert!(matches!(res, Err(HostError::Trap(_))), "{res:?}");
    let again = host.dispatch(id, b"{}", HostAction::new("noop", Vec::new()), &[]);
    assert!(matches!(again, Err(HostError::DeadInstance)), "{again:?}");
}

/// A module-level `Err(..)` from an export is *not* a trap: the instance
/// stays usable.
#[test]
fn a_module_error_leaves_the_instance_alive() {
    let mut host = WasmtimeHost::new().unwrap();
    host.register("m", LIMITS, ModuleManifest::all("m")).unwrap();
    let id = host.instantiate("m").unwrap();
    let res = host.dispatch(id, b"{}", HostAction::new("no-such-action", Vec::new()), &[]);
    assert!(matches!(res, Err(HostError::ModuleError(_))), "{res:?}");
    host.dispatch(id, b"{}", HostAction::new("noop", Vec::new()), &[])
        .unwrap();
}

// ── sandbox hardening: storage isolation + quotas ───────────────────────────

/// Join probe-action fields with the unit separator the limits fixture
/// splits on (so namespaces / keys can contain anything else verbatim).
fn probe(fields: &[&str]) -> Vec<u8> {
    fields.join("\u{1f}").into_bytes()
}

/// Run a probe action and return the text the fixture reports as its state.
fn probe_call(host: &mut dyn ModuleHost, id: ModuleInstanceId, action: &str, fields: &[&str]) -> String {
    let out = host
        .dispatch(id, b"{}", HostAction::new(action, probe(fields)), &[])
        .unwrap_or_else(|e| panic!("{action} {fields:?}: {e}"));
    String::from_utf8(out.state.expect("probe replies via state")).unwrap()
}

fn probe_instance(host: &mut dyn ModuleHost, name: &str, manifest: ModuleManifest) -> ModuleInstanceId {
    host.register(name, LIMITS, manifest).unwrap();
    let id = host.instantiate(name).unwrap();
    host.init(id, b"{}").unwrap();
    id
}

/// `local` storage is private to the registered module: module B, using the
/// exact same (tier, namespace, key), neither sees nor clobbers A's entry.
#[test]
fn local_storage_is_private_to_each_module() {
    let mut host = WasmtimeHost::new().unwrap();
    let a = probe_instance(&mut host, "a", ModuleManifest::all("a"));
    let b = probe_instance(&mut host, "b", ModuleManifest::all("b"));

    assert_eq!(probe_call(&mut host, a, "kv-set", &["local", "prefs", "token", "secret-a"]), "ok");
    assert_eq!(probe_call(&mut host, b, "kv-get", &["local", "prefs", "token"]), "none");

    assert_eq!(probe_call(&mut host, b, "kv-set", &["local", "prefs", "token", "secret-b"]), "ok");
    assert_eq!(probe_call(&mut host, a, "kv-get", &["local", "prefs", "token"]), "some:secret-a");
    assert_eq!(probe_call(&mut host, b, "kv-get", &["local", "prefs", "token"]), "some:secret-b");

    // A second instance of module A shares A's partition (storage is per
    // module, not per instance).
    let a2 = host.instantiate("a").unwrap();
    assert_eq!(probe_call(&mut host, a2, "kv-get", &["local", "prefs", "token"]), "some:secret-a");
}

/// A module can't forge another module's partition through its own
/// namespace / key strings, whatever separators it tries.
#[test]
fn local_storage_cannot_be_escaped_through_namespace_or_key() {
    let mut host = WasmtimeHost::new().unwrap();
    let victim = probe_instance(&mut host, "victim", ModuleManifest::all("victim"));
    let evil = probe_instance(&mut host, "evil", ModuleManifest::all("evil"));
    assert_eq!(probe_call(&mut host, victim, "kv-set", &["local", "ns", "k", "v"]), "ok");

    for (ns, key) in [
        ("victim/ns", "k"),
        ("../victim/ns", "k"),
        ("victim", "ns/k"),
        ("", "victim/persistent/ns/k"),
        ("Local/Persistent/ns", "k"),
        ("2:ns", "k"),
    ] {
        assert_eq!(probe_call(&mut host, evil, "kv-get", &["local", ns, key]), "none", "{ns:?} {key:?}");
    }
}

/// `(namespace, key)` pairs that concatenate to the same string are
/// distinct entries: ("a/b", "c") is not ("a", "b/c").
#[test]
fn namespace_and_key_do_not_collide() {
    let mut host = WasmtimeHost::new().unwrap();
    let m = probe_instance(&mut host, "m", ModuleManifest::all("m"));

    assert_eq!(probe_call(&mut host, m, "kv-set", &["local", "a/b", "c", "first"]), "ok");
    assert_eq!(probe_call(&mut host, m, "kv-get", &["local", "a", "b/c"]), "none");
    assert_eq!(probe_call(&mut host, m, "kv-set", &["local", "a", "b/c", "second"]), "ok");
    assert_eq!(probe_call(&mut host, m, "kv-get", &["local", "a/b", "c"]), "some:first");
    assert_eq!(probe_call(&mut host, m, "kv-get", &["local", "a", "b/c"]), "some:second");

    // Same for an empty namespace vs. a key that looks like "ns + key".
    assert_eq!(probe_call(&mut host, m, "kv-set", &["local", "", "xy", "third"]), "ok");
    assert_eq!(probe_call(&mut host, m, "kv-get", &["local", "x", "y"]), "none");
}

/// `app` storage is the deliberately shared scope: modules holding the grant
/// see each other's entries; a module without it can't even instantiate
/// (link-time denial), and `app` never aliases `local`.
#[test]
fn app_storage_is_shared_only_between_granted_modules() {
    let mut host = WasmtimeHost::new().unwrap();
    let a = probe_instance(&mut host, "a", ModuleManifest::all("a"));
    let b = probe_instance(&mut host, "b", ModuleManifest::all("b"));

    assert_eq!(probe_call(&mut host, a, "kv-set", &["app", "shared", "theme", "dark"]), "ok");
    assert_eq!(probe_call(&mut host, b, "kv-get", &["app", "shared", "theme"]), "some:dark");
    // The app entry is not visible through `local`, for either module.
    assert_eq!(probe_call(&mut host, a, "kv-get", &["local", "shared", "theme"]), "none");
    assert_eq!(probe_call(&mut host, b, "kv-get", &["local", "shared", "theme"]), "none");

    // No `app` grant → the fixture's `hypen:storage/app` import is unlinked.
    let ungranted = ModuleManifest {
        storage: vec![],
        ..ModuleManifest::all("c")
    };
    host.register("c", LIMITS, ungranted).unwrap();
    let err = host.instantiate("c").unwrap_err();
    assert!(matches!(err, HostError::Instantiate(_)), "{err}");
    assert!(format!("{err}").contains("hypen:storage/app"), "names the import: {err}");
}

/// Writes are bounded: a value over `max_storage_value_bytes`, or a write
/// that would take the scope over `max_storage_bytes`, gets the WIT's
/// `quota-exceeded(<bytes over>)` — and the budget is per module for `local`.
#[test]
fn storage_writes_are_bounded_by_quota() {
    let mut host = WasmtimeHost::with_limits(ModuleLimits {
        max_storage_value_bytes: 1000,
        max_storage_bytes: 2500,
        ..ModuleLimits::default()
    })
    .unwrap();
    let a = probe_instance(&mut host, "a", ModuleManifest::all("a"));
    let b = probe_instance(&mut host, "b", ModuleManifest::all("b"));

    // Per-value cap.
    assert_eq!(probe_call(&mut host, a, "kv-fill", &["local", "n", "big", "1001"]), "quota-exceeded:1");
    assert_eq!(probe_call(&mut host, a, "kv-get", &["local", "n", "big"]), "none");

    // Per-scope budget: two 1000-byte values fit, the third does not.
    assert_eq!(probe_call(&mut host, a, "kv-fill", &["local", "n", "k1", "1000"]), "ok");
    assert_eq!(probe_call(&mut host, a, "kv-fill", &["local", "n", "k2", "1000"]), "ok");
    let refused = probe_call(&mut host, a, "kv-fill", &["local", "n", "k3", "1000"]);
    assert!(refused.starts_with("quota-exceeded:"), "{refused}");
    assert_eq!(probe_call(&mut host, a, "kv-get", &["local", "n", "k3"]), "none");
    // Overwriting an existing entry in place stays within budget.
    assert_eq!(probe_call(&mut host, a, "kv-fill", &["local", "n", "k1", "900"]), "ok");

    // Module B has its own local budget; the shared `app` scope has its own.
    assert_eq!(probe_call(&mut host, b, "kv-fill", &["local", "n", "k1", "1000"]), "ok");
    assert_eq!(probe_call(&mut host, a, "kv-fill", &["app", "n", "k1", "1000"]), "ok");
}

/// With the default limits a 1 MiB value is the largest that fits.
#[test]
fn default_quota_caps_values_at_one_mebibyte() {
    let mut host = WasmtimeHost::new().unwrap();
    let m = probe_instance(&mut host, "m", ModuleManifest::all("m"));
    assert_eq!(probe_call(&mut host, m, "kv-fill", &["local", "n", "k", "1048576"]), "ok");
    assert_eq!(probe_call(&mut host, m, "kv-fill", &["local", "n", "k2", "1048577"]), "quota-exceeded:1");
}

/// Storage hits disk once per module call (not once per write), in a format
/// that is not the old one; a file in the old format is refused, not wiped.
#[test]
fn storage_file_is_flushed_per_call_and_old_formats_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("kv.json");
    {
        let mut host = WasmtimeHost::new().unwrap();
        host.set_storage_path(&file).unwrap();
        let m = probe_instance(&mut host, "m", ModuleManifest::all("m"));
        assert!(!file.exists(), "nothing written before a module call stores something");
        assert_eq!(probe_call(&mut host, m, "kv-set", &["local", "ns", "k", "hello"]), "ok");
        let text = std::fs::read_to_string(&file).unwrap();
        // "hello" base64-encoded, under the owning module's partition.
        assert!(text.contains("aGVsbG8="), "{text}");
        assert!(text.contains(r#""owner":"m""#), "{text}");
    }
    {
        let mut host = WasmtimeHost::new().unwrap();
        host.set_storage_path(&file).unwrap();
        let m = probe_instance(&mut host, "m", ModuleManifest::all("m"));
        assert_eq!(probe_call(&mut host, m, "kv-get", &["local", "ns", "k"]), "some:hello");
        let other = probe_instance(&mut host, "other", ModuleManifest::all("other"));
        assert_eq!(probe_call(&mut host, other, "kv-get", &["local", "ns", "k"]), "none");
    }

    let old = dir.path().join("old.json");
    let old_body = r#"{"format":1,"plain":{"Local/Persistent/ns/k":[104,105]}}"#;
    std::fs::write(&old, old_body).unwrap();
    let mut host = WasmtimeHost::new().unwrap();
    let err = host.set_storage_path(&old).unwrap_err();
    assert!(format!("{err}").contains("format 1"), "{err}");
    assert_eq!(std::fs::read_to_string(&old).unwrap(), old_body, "left untouched");
}

// ── sandbox hardening: cross-module request bounds ──────────────────────────

/// One call may queue at most 256 cross-module dispatches / subscriptions,
/// and no single request may exceed 1 MiB; requests past that are refused
/// with an error instead of growing host memory.
#[test]
fn cross_module_requests_are_bounded_per_call() {
    let mut host = WasmtimeHost::new().unwrap();
    let manifest = ModuleManifest {
        reads: vec!["peer".into()],
        dispatches: vec!["peer".into()],
        ..ModuleManifest::all("m")
    };
    let id = probe_instance(&mut host, "m", manifest);

    let out = host
        .dispatch(id, b"{}", HostAction::new("flood-dispatch", probe(&["peer", "300", "8"])), &[])
        .unwrap();
    let reply = String::from_utf8(out.state.unwrap()).unwrap();
    assert!(reply.starts_with("256/300 "), "{reply}");
    assert!(reply.contains("too many dispatch requests"), "{reply}");
    assert_eq!(out.cross_dispatch.len(), 256);

    // The bound is per call: the next call starts from an empty queue.
    let out = host
        .dispatch(id, b"{}", HostAction::new("flood-dispatch", probe(&["peer", "3", "8"])), &[])
        .unwrap();
    assert_eq!(out.cross_dispatch.len(), 3);

    // Oversized payload: refused outright.
    let out = host
        .dispatch(id, b"{}", HostAction::new("flood-dispatch", probe(&["peer", "1", "1048577"])), &[])
        .unwrap();
    let reply = String::from_utf8(out.state.unwrap()).unwrap();
    assert!(reply.starts_with("0/1 "), "{reply}");
    assert!(out.cross_dispatch.is_empty());

    let out = host
        .dispatch(id, b"{}", HostAction::new("flood-subscribe", probe(&["peer", "300"])), &[])
        .unwrap();
    let reply = String::from_utf8(out.state.unwrap()).unwrap();
    assert!(reply.starts_with("256/300 "), "{reply}");
    assert_eq!(out.subscribe_requests.len(), 256);
}

// ── deny-by-default manifests ───────────────────────────────────────────────

/// A manifest that omits a capability does not grant it: `{}` (and
/// `Default`) mean local-only storage, no cross-module access, no HTTP.
#[test]
fn manifest_is_deny_by_default() {
    for manifest in [
        serde_json::from_str::<ModuleManifest>(r#"{"name": "m"}"#).unwrap(),
        serde_json::from_str::<ModuleManifest>("{}").unwrap(),
        ModuleManifest::default(),
    ] {
        assert!(!manifest.grants_http());
        assert!(manifest.grants_storage(StorageScope::Local));
        assert!(!manifest.grants_storage(StorageScope::App));
        assert!(!manifest.grants_storage(StorageScope::Cloud));
        assert!(manifest.reads.is_empty());
        assert!(manifest.dispatches.is_empty());
    }
    let granted: ModuleManifest =
        serde_json::from_str(r#"{"name": "m", "storage": ["app"], "http": true}"#).unwrap();
    assert!(granted.grants_http());
    assert!(granted.grants_storage(StorageScope::App));
    assert!(!granted.grants_storage(StorageScope::Cloud));

    // Enforced at link time: an http-importing module registered with a
    // manifest that merely omits `http` cannot instantiate.
    let mut host = WasmtimeHost::new().unwrap();
    let omitted: ModuleManifest = serde_json::from_str(r#"{"name": "fetcher"}"#).unwrap();
    host.register("fetcher", FETCHER, omitted).unwrap();
    let err = host.instantiate("fetcher").unwrap_err();
    assert!(format!("{err}").contains("http"), "{err}");
}

// ── DualHost: one core for both ABIs ────────────────────────────────────────

#[cfg(target_os = "linux")]
fn epoch_ticker_threads() -> usize {
    let mut n = 0;
    for entry in std::fs::read_dir("/proc/self/task").unwrap() {
        let comm = std::fs::read_to_string(entry.unwrap().path().join("comm")).unwrap_or_default();
        // Linux truncates thread names to 15 bytes.
        if comm.trim() == "hypen-module-ep" {
            n += 1;
        }
    }
    n
}

/// A `DualHost` runs both ABI hosts on one epoch-ticker thread, and
/// dropping it stops that thread. (Runs in its own process-wide check, so
/// it tolerates tickers owned by tests running in parallel by measuring a
/// burst of its own hosts.)
#[cfg(target_os = "linux")]
#[test]
fn dual_host_shares_one_epoch_ticker_and_stops_it_on_drop() {
    use hypen_engine::module_host::DualHost;

    const N: usize = 40;
    let before = epoch_ticker_threads();
    let hosts: Vec<DualHost> = (0..N).map(|_| DualHost::new().unwrap()).collect();
    let during = epoch_ticker_threads();
    drop(hosts);
    // Other tests create and drop at most a handful of hosts concurrently;
    // two tickers per DualHost would show up as ~2N here.
    assert!(
        during >= N && during < before + N + N / 2,
        "one ticker per DualHost: before={before} during={during}"
    );
    // Drop joins the ticker, so they are gone immediately.
    let after = epoch_ticker_threads();
    assert!(after + N <= during + N / 2, "tickers stopped on drop: during={during} after={after}");
}

/// `DualHost` puts both ABI hosts on one storage backend: the `app` scope is
/// shared between a v0.1 and a v0.2 module of the same app, `local` stays
/// private per module name, and one snapshot file holds both.
#[test]
fn dual_host_shares_storage_across_abis() {
    use hypen_engine::module_host::{detect_abi, DualHost, ModuleAbi};
    const ASYNC_COUNTER: &[u8] = include_bytes!("fixtures/async_counter_module.wasm");
    assert_eq!(detect_abi(LIMITS), ModuleAbi::V1Sync);
    assert_eq!(detect_abi(ASYNC_COUNTER), ModuleAbi::V2Async);

    let dir = tempfile::tempdir().unwrap();
    let mut host = DualHost::with_options(Default::default(), Default::default(), Some(dir.path())).unwrap();
    let probe_id = probe_instance(&mut host, "probe", ModuleManifest::all("probe"));
    host.register("acounter", ASYNC_COUNTER, ModuleManifest::all("acounter"))
        .unwrap();
    let async_id = host.instantiate("acounter").unwrap();
    let state = host.init(async_id, b"{}").unwrap();
    host.dispatch(async_id, &state, HostAction::new("increment", b"{}".to_vec()), &[])
        .unwrap();

    // The v0.2 module persisted its count under (persistent, "counter",
    // "count") in *its* local partition; the v0.1 probe can't see it there.
    assert_eq!(probe_call(&mut host, probe_id, "kv-get", &["local", "counter", "count"]), "none");
    assert_eq!(probe_call(&mut host, probe_id, "kv-set", &["app", "shared", "k", "v"]), "ok");

    let text = std::fs::read_to_string(dir.path().join("storage.json")).unwrap();
    assert!(text.contains(r#""owner":"acounter""#), "{text}");
    assert!(text.contains(r#""scope":"app""#), "{text}");
}

// ── bad paths: registration ─────────────────────────────────────────────────

const ASYNC_COUNTER_V02: &[u8] = include_bytes!("fixtures/async_counter_module.wasm");

fn register_error(bytes: &[u8]) -> String {
    let mut host = WasmtimeHost::new().unwrap();
    let err = host
        .register("m", bytes, ModuleManifest::all("m"))
        .unwrap_err();
    assert!(matches!(err, HostError::Instantiate(_)), "{err}");
    // Nothing was registered under the name.
    assert!(matches!(
        host.instantiate("m"),
        Err(HostError::UnknownModule(_))
    ));
    format!("{err}")
}

/// `register` says *what* is wrong with bytes it refuses, and names the
/// module: not wasm at all, a core module, a truncated binary, a component
/// of some other world, a component for the other ABI version.
#[test]
fn register_says_why_bytes_are_not_a_module() {
    for garbage in [&b""[..], b"\0as", b"hello, not wasm", b"{\"json\": true}"] {
        let msg = register_error(garbage);
        assert!(
            msg.contains("module 'm'") && msg.contains("not a WebAssembly binary"),
            "{msg}"
        );
    }

    // `(module)`: the 8-byte core-module header.
    let msg = register_error(b"\0asm\x01\0\0\0");
    assert!(
        msg.contains("core WebAssembly module, not a component"),
        "{msg}"
    );

    // A component header followed by garbage / a real component cut short.
    let msg = register_error(b"\0asm\x0d\0\x01\0\xff\xff\xff\xff");
    assert!(msg.contains("not a valid WebAssembly component"), "{msg}");
    let msg = register_error(&COUNTER[..COUNTER.len() / 2]);
    assert!(msg.contains("not a valid WebAssembly component"), "{msg}");

    // `(component)`: valid, but exports nothing of the world.
    let msg = register_error(b"\0asm\x0d\0\x01\0");
    assert!(
        msg.contains("does not export the hypen:module@0.1.0 world"),
        "{msg}"
    );

    // A v0.2 component on the v0.1 host.
    let msg = register_error(ASYNC_COUNTER_V02);
    assert!(
        msg.contains("@0.2.0") && msg.contains("this host serves hypen:module@0.1.0"),
        "{msg}"
    );
}

#[test]
fn instantiating_an_unregistered_name_is_unknown_module() {
    let mut host = WasmtimeHost::new().unwrap();
    let err = host.instantiate("ghost").unwrap_err();
    assert!(
        matches!(&err, HostError::UnknownModule(name) if name == "ghost"),
        "{err}"
    );
}

/// A capability denial names every ungranted import and the manifest grant
/// that would allow it.
#[test]
fn capability_denial_names_the_import_and_the_grant() {
    let mut host = WasmtimeHost::new().unwrap();
    host.register("cart", COUNTER, ModuleManifest::default())
        .unwrap();
    let msg = format!("{}", host.instantiate("cart").unwrap_err());
    assert_eq!(
        msg,
        "instantiation failed: module 'cart' imports hypen:storage/cloud@0.1.0 but its \
         manifest does not grant storage scope `cloud`"
    );

    const FETCHER: &[u8] = include_bytes!("fixtures/fetcher_module.wasm");
    host.register("net", FETCHER, ModuleManifest::default())
        .unwrap();
    let msg = format!("{}", host.instantiate("net").unwrap_err());
    assert!(msg.contains("module 'net' imports wasi:http/"), "{msg}");
    assert!(
        msg.contains("but its manifest does not grant `http`"),
        "{msg}"
    );
}

/// Re-registering a name (hot reload) affects later `instantiate` calls
/// only: a live instance keeps the code *and* the manifest it was created
/// with. A failed re-registration leaves the previous one in place.
#[test]
fn reregistering_does_not_change_live_instances() {
    let mut host = WasmtimeHost::new().unwrap();
    let granted = ModuleManifest {
        dispatches: vec!["peer".into()],
        ..ModuleManifest::all("m")
    };
    let old = probe_instance(&mut host, "m", granted);
    assert_eq!(
        probe_call(&mut host, old, "flood-dispatch", &["peer", "1", "1"]),
        "1/1"
    );

    // Same name, different code, and a manifest without the `peer` grant.
    host.register("m", COUNTER, ModuleManifest::all("m"))
        .unwrap();
    let new = host.instantiate("m").unwrap();
    assert_eq!(host.actions(new).unwrap(), ["increment", "sync"]);

    // The old instance still runs the old code under the old grants.
    assert!(host
        .actions(old)
        .unwrap()
        .contains(&"flood-dispatch".to_string()));
    assert_eq!(
        probe_call(&mut host, old, "flood-dispatch", &["peer", "1", "1"]),
        "1/1"
    );

    // A rejected re-registration changes nothing.
    assert!(host
        .register("m", b"junk", ModuleManifest::all("m"))
        .is_err());
    let again = host.instantiate("m").unwrap();
    assert_eq!(host.actions(again).unwrap(), ["increment", "sync"]);
}

/// `DualHost`: a name re-registered under the other ABI resolves to the new
/// module only; the instance created from the old registration keeps
/// running until destroyed.
#[test]
fn dual_host_reregistering_under_the_other_abi_replaces_the_name() {
    use hypen_engine::module_host::DualHost;
    let mut host = DualHost::new().unwrap();
    host.register("m", COUNTER, ModuleManifest::all("m"))
        .unwrap();
    let v1 = host.instantiate("m").unwrap();
    let state = host.init(v1, b"{}").unwrap();

    host.register("m", ASYNC_COUNTER_V02, ModuleManifest::all("m"))
        .unwrap();
    let v2 = host.instantiate("m").unwrap();
    assert!(
        host.actions(v2).unwrap().contains(&"spin".to_string()),
        "the v0.2 module"
    );
    // The v0.1 host no longer knows the name…
    assert!(matches!(
        host.hosts_mut().0.instantiate("m"),
        Err(HostError::UnknownModule(_))
    ));
    // …but its live instance is unaffected.
    let out = host
        .dispatch(v1, &state, HostAction::new("increment", Vec::new()), &[])
        .unwrap();
    assert_eq!(count(&out.state.unwrap()), 1);

    // A failed registration keeps the current one.
    assert!(host
        .register("m", b"junk", ModuleManifest::all("m"))
        .is_err());
    host.instantiate("m").unwrap();
}

// ── bad paths: instance ids ─────────────────────────────────────────────────

fn assert_dead(host: &mut dyn ModuleHost, id: ModuleInstanceId) {
    let action = || HostAction::new("noop", Vec::new());
    assert!(matches!(host.init(id, b"{}"), Err(HostError::DeadInstance)));
    assert!(matches!(
        host.dispatch(id, b"{}", action(), &[]),
        Err(HostError::DeadInstance)
    ));
    assert!(matches!(
        host.on_activated(id, b"{}", &[]),
        Err(HostError::DeadInstance)
    ));
    assert!(matches!(
        host.on_deactivated(id, b"{}"),
        Err(HostError::DeadInstance)
    ));
    assert!(matches!(
        host.on_destroyed(id, b"{}"),
        Err(HostError::DeadInstance)
    ));
    assert!(matches!(host.actions(id), Err(HostError::DeadInstance)));
}

/// Every method answers `DeadInstance` for an id that was destroyed, never
/// issued, or issued by another host — an id never addresses someone else's
/// instance.
#[test]
fn destroyed_unknown_and_foreign_ids_are_dead() {
    let mut host = WasmtimeHost::new().unwrap();
    let id = probe_instance(&mut host, "m", ModuleManifest::all("m"));
    let survivor = host.instantiate("m").unwrap();
    host.destroy(id).unwrap();
    assert_dead(&mut host, id);
    assert!(matches!(host.destroy(id), Err(HostError::DeadInstance)));
    assert_eq!(host.death_reason(id), None, "destroyed, not killed");

    for bogus in [0, 1, u64::MAX, id.0 ^ (1 << 63), 1 << 63] {
        let bogus = ModuleInstanceId(bogus);
        assert_dead(&mut host, bogus);
        assert!(matches!(host.destroy(bogus), Err(HostError::DeadInstance)));
    }

    // Another host's live id is not valid here, and vice versa.
    let mut other = WasmtimeHost::new().unwrap();
    let foreign = probe_instance(&mut other, "m", ModuleManifest::all("m"));
    assert_dead(&mut host, foreign);
    assert!(matches!(
        host.destroy(foreign),
        Err(HostError::DeadInstance)
    ));
    assert_dead(&mut other, survivor);
    // Both are still alive where they belong.
    host.actions(survivor).unwrap();
    other.actions(foreign).unwrap();
}

/// `DualHost` routes an id to the host that issued it; ids of one ABI's
/// host are not valid for the other.
#[test]
fn dual_host_ids_only_reach_their_own_host() {
    use hypen_engine::module_host::DualHost;
    let mut host = DualHost::new().unwrap();
    let v1 = probe_instance(&mut host, "probe", ModuleManifest::all("probe"));
    host.register("a", ASYNC_COUNTER_V02, ModuleManifest::all("a"))
        .unwrap();
    let v2 = host.instantiate("a").unwrap();
    assert_ne!(v1, v2);
    for flipped in [
        ModuleInstanceId(v1.0 ^ (1 << 63)),
        ModuleInstanceId(v2.0 ^ (1 << 63)),
    ] {
        assert_dead(&mut host, flipped);
    }
    host.destroy(v2).unwrap();
    assert_dead(&mut host, v2);
    host.actions(v1).unwrap();
}

// ── bad paths: what a failed call reports ───────────────────────────────────

/// Each way a call can fail says which module and export it was and what
/// happened — and the instance remembers what killed it.
#[test]
fn failures_name_the_module_the_export_and_the_cause() {
    let mut host = WasmtimeHost::with_limits(ModuleLimits {
        max_call: Duration::from_millis(300),
        max_memory_bytes: 32 * 1024 * 1024,
        ..ModuleLimits::default()
    })
    .unwrap();
    host.register("m", LIMITS, ModuleManifest::all("m"))
        .unwrap();
    let mut kill = |action: &str| {
        let id = host.instantiate("m").unwrap();
        assert_eq!(host.death_reason(id), None);
        let err = host
            .dispatch(id, b"{}", HostAction::new(action, Vec::new()), &[])
            .unwrap_err();
        assert!(matches!(err, HostError::Trap(_)), "{action}: {err}");
        let reason = host
            .death_reason(id)
            .expect("killed instances remember why");
        assert_eq!(format!("{err}"), format!("module trapped: {reason}"));
        assert!(matches!(host.actions(id), Err(HostError::DeadInstance)));
        reason
    };

    assert_eq!(
        kill("trap"),
        "module 'm' export `dispatch` trapped: wasm `unreachable` instruction executed"
    );
    assert_eq!(
        kill("hang"),
        "module 'm' export `dispatch` exceeded its 300 ms CPU budget: guest code was still \
         running at the deadline"
    );
    assert_eq!(
        kill("block"),
        "module 'm' export `dispatch` exceeded its 300 ms wall-clock budget while blocked in a \
         host call"
    );
    let oom = kill("oom");
    assert!(
        oom.starts_with("module 'm' export `dispatch` hit its 33554432-byte memory limit"),
        "{oom}"
    );

    // Other exports are named too.
    let id = host.instantiate("m").unwrap();
    let err = host.init(id, b"block").unwrap_err();
    assert!(
        format!("{err}").contains("module 'm' export `init` exceeded"),
        "{err}"
    );

    // A module-level error is not a death.
    let id = host.instantiate("m").unwrap();
    let err = host
        .dispatch(id, b"{}", HostAction::new("nope", Vec::new()), &[])
        .unwrap_err();
    assert_eq!(
        format!("{err}"),
        "module returned error: module 'm' export `dispatch`: unknown action: nope"
    );
    assert_eq!(host.death_reason(id), None);
    host.actions(id).unwrap();
}

/// The host never parses module state: bytes that are not UTF-8 (let alone
/// JSON) pass through in both directions untouched.
#[test]
fn state_bytes_pass_through_unparsed() {
    let mut host = WasmtimeHost::new().unwrap();
    let id = probe_instance(&mut host, "m", ModuleManifest::all("m"));
    let out = host
        .dispatch(id, b"{}", HostAction::new("raw-state", Vec::new()), &[])
        .unwrap();
    assert_eq!(out.state.as_deref(), Some(&[0xff, 0x00, 0xfe, b'{'][..]));

    // `noop` echoes the state it was given; so do the lifecycle hooks accept it.
    let weird = [0u8, 0xff, 0xc0, 0x80, b'"'];
    let out = host
        .dispatch(id, &weird, HostAction::new("noop", vec![0xff]), &[])
        .unwrap();
    assert_eq!(out.state.as_deref(), Some(&weird[..]));
    host.on_activated(id, &weird, &[("peer".into(), vec![0xff])])
        .unwrap();
    host.on_deactivated(id, &weird).unwrap();
    host.on_destroyed(id, &weird).unwrap();
    // A non-UTF-8 action name can't exist (`String`), and an empty one is
    // just an unknown action.
    let err = host
        .dispatch(id, b"", HostAction::new("", Vec::new()), &[])
        .unwrap_err();
    assert!(matches!(err, HostError::ModuleError(_)), "{err}");
}

/// Dropping a host right after a call was cancelled in a host call — and
/// with other instances still live — returns promptly.
#[test]
fn dropping_a_host_after_a_cancelled_call_does_not_hang() {
    let mut host = deadline_host(Duration::from_millis(200));
    host.register("m", LIMITS, ModuleManifest::all("m"))
        .unwrap();
    let blocked = host.instantiate("m").unwrap();
    let _live = host.instantiate("m").unwrap();
    assert!(host
        .dispatch(blocked, b"{}", HostAction::new("block", Vec::new()), &[])
        .is_err());
    let started = Instant::now();
    drop(host);
    assert!(
        started.elapsed() < DEADLINE_SLACK,
        "drop took {:?}",
        started.elapsed()
    );
}

// ── bad paths: storage ──────────────────────────────────────────────────────

/// `keys`, `info` and `clear` work over the real backend (they used to be
/// stubs in the v0.1 host: `clear` reported success without clearing).
#[test]
fn bucket_keys_info_and_clear_are_real() {
    let mut host = WasmtimeHost::new().unwrap();
    let a = probe_instance(&mut host, "a", ModuleManifest::all("a"));
    let b = probe_instance(&mut host, "b", ModuleManifest::all("b"));
    for key in ["user/2", "user/1", "theme"] {
        assert_eq!(
            probe_call(&mut host, a, "kv-set", &["local", "prefs", key, "v"]),
            "ok"
        );
    }
    assert_eq!(
        probe_call(&mut host, a, "kv-set", &["local", "other", "user/9", "v"]),
        "ok"
    );
    assert_eq!(
        probe_call(&mut host, b, "kv-set", &["local", "prefs", "user/7", "v"]),
        "ok"
    );
    assert_eq!(
        probe_call(&mut host, a, "kv-set", &["app", "prefs", "shared", "value"]),
        "ok"
    );

    assert_eq!(
        probe_call(&mut host, a, "kv-keys", &["local", "prefs", "", "10"]),
        "theme,user/1,user/2"
    );
    assert_eq!(
        probe_call(&mut host, a, "kv-keys", &["local", "prefs", "user/", "10"]),
        "user/1,user/2"
    );
    assert_eq!(
        probe_call(&mut host, a, "kv-keys", &["local", "prefs", "user/", "1"]),
        "user/1"
    );
    assert_eq!(
        probe_call(&mut host, a, "kv-keys", &["local", "prefs", "nope", "10"]),
        ""
    );
    assert_eq!(
        probe_call(&mut host, b, "kv-keys", &["local", "prefs", "", "10"]),
        "user/7"
    );
    assert_eq!(
        probe_call(&mut host, b, "kv-keys", &["app", "prefs", "", "10"]),
        "shared"
    );

    assert_eq!(
        probe_call(&mut host, a, "kv-info", &["local", "prefs", "theme"]),
        "size:1,version:none"
    );
    assert_eq!(
        probe_call(&mut host, b, "kv-info", &["app", "prefs", "shared"]),
        "size:5,version:none"
    );
    assert_eq!(
        probe_call(&mut host, a, "kv-info", &["local", "prefs", "missing"]),
        "none"
    );

    // `clear` empties exactly that bucket.
    assert_eq!(
        probe_call(&mut host, a, "kv-clear", &["local", "prefs"]),
        "ok"
    );
    assert_eq!(
        probe_call(&mut host, a, "kv-keys", &["local", "prefs", "", "10"]),
        ""
    );
    assert_eq!(
        probe_call(&mut host, a, "kv-get", &["local", "prefs", "theme"]),
        "none"
    );
    assert_eq!(
        probe_call(&mut host, a, "kv-keys", &["local", "other", "", "10"]),
        "user/9"
    );
    assert_eq!(
        probe_call(&mut host, b, "kv-keys", &["local", "prefs", "", "10"]),
        "user/7"
    );
    assert_eq!(
        probe_call(&mut host, a, "kv-get", &["app", "prefs", "shared"]),
        "some:value"
    );
}

/// Clearing frees the bucket's quota.
#[test]
fn clear_frees_quota() {
    let mut host = WasmtimeHost::with_limits(ModuleLimits {
        max_storage_bytes: 300,
        ..ModuleLimits::default()
    })
    .unwrap();
    let id = probe_instance(&mut host, "m", ModuleManifest::all("m"));
    assert_eq!(
        probe_call(&mut host, id, "kv-fill", &["local", "ns", "a", "200"]),
        "ok"
    );
    let refused = probe_call(&mut host, id, "kv-fill", &["local", "ns", "b", "200"]);
    assert!(refused.starts_with("quota-exceeded:"), "{refused}");
    assert_eq!(
        probe_call(&mut host, id, "kv-clear", &["local", "ns"]),
        "ok"
    );
    assert_eq!(
        probe_call(&mut host, id, "kv-fill", &["local", "ns", "b", "200"]),
        "ok"
    );
}

/// Blob storage is not implemented and says so, instead of posing as an
/// empty store.
#[test]
fn blob_storage_reports_unavailable() {
    let mut host = WasmtimeHost::new().unwrap();
    let id = probe_instance(&mut host, "m", ModuleManifest::all("m"));
    let reply = probe_call(&mut host, id, "blob-open", &[]);
    assert!(
        reply.contains("Unavailable") && reply.contains("not implemented"),
        "{reply}"
    );
}

/// A guest that opens bucket handles in a loop and never drops them is cut
/// off at a fixed number (each handle pins host memory); the bound is per
/// instance, and the instance itself keeps working.
#[test]
fn open_bucket_handles_are_bounded() {
    let mut host = WasmtimeHost::new().unwrap();
    let id = probe_instance(&mut host, "m", ModuleManifest::all("m"));
    let reply = probe_call(&mut host, id, "kv-leak", &["1000"]);
    assert!(reply.starts_with("256/1000 "), "{reply}");
    assert!(reply.contains("too many open buckets"), "{reply}");
    // The leaked handles stay with the instance: it is now at its limit…
    let reply = probe_call(&mut host, id, "kv-set", &["local", "ns", "k", "v"]);
    assert!(reply.contains("too many open buckets"), "{reply}");
    // …while a fresh instance of the same module is not.
    let fresh = host.instantiate("m").unwrap();
    assert_eq!(
        probe_call(&mut host, fresh, "kv-set", &["local", "ns", "k", "v"]),
        "ok"
    );

    // An absurd namespace is refused rather than pinned host-side.
    let huge = "n".repeat(64 * 1024);
    let reply = probe_call(&mut host, fresh, "kv-set", &["local", &huge, "k", "v"]);
    assert!(
        reply.contains("namespace") && reply.contains("limit"),
        "{reply}"
    );
}

/// If the snapshot can't be written when a call ends, the call's result is
/// still returned and storage keeps serving from memory; the failure names
/// the file, is observable through `flush_storage`, and the next flush
/// retries once the path is writable again.
#[test]
fn a_failed_storage_flush_does_not_lose_the_call_result() {
    let dir = tempfile::tempdir().unwrap();
    let sub = dir.path().join("data");
    let file = sub.join("kv.json");
    let mut host = WasmtimeHost::new().unwrap();
    host.set_storage_path(&file).unwrap();
    let id = probe_instance(&mut host, "m", ModuleManifest::all("m"));
    host.flush_storage().unwrap();

    // Break the path: the directory becomes a plain file.
    std::fs::remove_dir_all(&sub).unwrap();
    std::fs::write(&sub, b"in the way").unwrap();

    assert_eq!(
        probe_call(&mut host, id, "kv-set", &["local", "ns", "k", "kept"]),
        "ok"
    );
    assert_eq!(
        probe_call(&mut host, id, "kv-get", &["local", "ns", "k"]),
        "some:kept"
    );
    let err = host.flush_storage().unwrap_err();
    assert!(matches!(err, HostError::Runtime(_)), "{err}");
    assert!(
        format!("{err}").contains("kv.json"),
        "names the file: {err}"
    );

    // Repair it: the pending write lands.
    std::fs::remove_file(&sub).unwrap();
    std::fs::create_dir_all(&sub).unwrap();
    host.flush_storage().unwrap();
    assert!(
        std::fs::read_to_string(&file).unwrap().contains("a2VwdA=="),
        "\"kept\" persisted"
    );
}

/// A storage file that is corrupt, or that a different format wrote, stops
/// the host from starting on it — with the path in the error and the file
/// left as it was.
#[test]
fn a_corrupt_storage_file_is_an_error_at_startup() {
    use hypen_engine::module_host::DualHost;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("storage.json");
    for body in [
        "",
        "not json",
        "{\"format\":2,\"partitions\":7}",
        "{\"format\":99,\"partitions\":[]}",
    ] {
        std::fs::write(&file, body).unwrap();
        let err = match DualHost::with_options(
            Default::default(),
            Default::default(),
            Some(dir.path()),
        ) {
            Ok(_) => panic!("started on a corrupt storage file: {body:?}"),
            Err(e) => e,
        };
        assert!(matches!(err, HostError::Runtime(_)), "{err}");
        assert!(format!("{err}").contains("storage.json"), "{err}");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            body,
            "left untouched"
        );

        let mut host = WasmtimeHost::new().unwrap();
        assert!(host.set_storage_path(&file).is_err(), "{body:?}");
    }
}

// ── storage: modification times ─────────────────────────────────────────────

/// v0.1 `info` reports when an entry was last written, by the host clock:
/// under the virtual clock the stamps are exact, an overwrite restamps, and
/// the stamp survives the process through the storage file.
#[test]
fn info_reports_modified_ms_from_the_host_clock() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("kv.json");
    {
        let mut host = WasmtimeHost::new().unwrap();
        host.set_storage_path(&file).unwrap();
        let clock = host.set_virtual_clock(1_700_000_000_000);
        let m = probe_instance(&mut host, "m", ModuleManifest::all("m"));

        assert_eq!(probe_call(&mut host, m, "kv-modified", &["local", "ns", "k"]), "none");
        assert_eq!(probe_call(&mut host, m, "kv-set", &["local", "ns", "k", "v1"]), "ok");
        assert_eq!(
            probe_call(&mut host, m, "kv-modified", &["local", "ns", "k"]),
            "1700000000000"
        );
        clock.store(1_700_000_005_000, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(probe_call(&mut host, m, "kv-set", &["app", "ns", "shared", "x"]), "ok");
        // Reading does not restamp; the first entry keeps its time.
        assert_eq!(probe_call(&mut host, m, "kv-get", &["local", "ns", "k"]), "some:v1");
        assert_eq!(
            probe_call(&mut host, m, "kv-modified", &["local", "ns", "k"]),
            "1700000000000"
        );
        assert_eq!(probe_call(&mut host, m, "kv-set", &["local", "ns", "k", "v2"]), "ok");
        assert_eq!(
            probe_call(&mut host, m, "kv-modified", &["local", "ns", "k"]),
            "1700000005000"
        );
    }
    // A second host (a later process) reads the persisted stamps, whatever
    // its own clock says.
    let mut host = WasmtimeHost::new().unwrap();
    host.set_storage_path(&file).unwrap();
    host.set_virtual_clock(5);
    let m = probe_instance(&mut host, "m", ModuleManifest::all("m"));
    assert_eq!(
        probe_call(&mut host, m, "kv-modified", &["local", "ns", "k"]),
        "1700000005000"
    );
    assert_eq!(
        probe_call(&mut host, m, "kv-modified", &["app", "ns", "shared"]),
        "1700000005000"
    );
}

/// On the real clock a fresh write is stamped with the current wall time.
#[test]
fn modified_ms_defaults_to_the_wall_clock() {
    let now_ms = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    };
    let mut host = WasmtimeHost::new().unwrap();
    let m = probe_instance(&mut host, "m", ModuleManifest::all("m"));
    let before = now_ms();
    assert_eq!(probe_call(&mut host, m, "kv-set", &["local", "ns", "k", "v"]), "ok");
    let stamp: u128 = probe_call(&mut host, m, "kv-modified", &["local", "ns", "k"])
        .parse()
        .unwrap();
    assert!((before..=now_ms()).contains(&stamp), "{before} <= {stamp}");
}

/// A storage file in the previous format (no modification times) still
/// loads: its entries read `modified-ms` 0 until rewritten, and the first
/// module call that stores something rewrites the file in the current format.
#[test]
fn a_previous_format_storage_file_is_migrated() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("kv.json");
    // "hello" under module m, namespace "ns", key "k", as format 2 wrote it.
    let v2 = r#"{"format":2,"partitions":[{"scope":"local","owner":"m","entries":{"persistent/2:nsk":"aGVsbG8="}}]}"#;
    std::fs::write(&file, v2).unwrap();

    let mut host = WasmtimeHost::new().unwrap();
    host.set_storage_path(&file).unwrap();
    host.set_virtual_clock(42);
    let m = probe_instance(&mut host, "m", ModuleManifest::all("m"));
    assert_eq!(probe_call(&mut host, m, "kv-get", &["local", "ns", "k"]), "some:hello");
    assert_eq!(probe_call(&mut host, m, "kv-modified", &["local", "ns", "k"]), "0");
    assert_eq!(probe_call(&mut host, m, "kv-set", &["local", "ns", "k2", "x"]), "ok");
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.starts_with(r#"{"format":3,"#), "{text}");
    assert!(text.contains(r#""persistent/2:nsk":{"v":"aGVsbG8=","m":0}"#), "{text}");
    assert!(text.contains(r#""m":42"#), "{text}");
}

// ── liveness and link denials as data ───────────────────────────────────────

/// `instance_status` tells live, dead (with what killed it) and gone apart
/// without calling the guest — on the plain host and through `DualHost`.
#[test]
fn instance_status_reports_liveness_without_a_guest_call() {
    use hypen_engine::module_host::{DualHost, InstanceStatus};

    fn check(host: &mut dyn ModuleHost) {
        let id = probe_instance(host, "m", ModuleManifest::all("m"));
        let bystander = probe_instance(host, "other", ModuleManifest::all("other"));
        assert_eq!(host.instance_status(id), InstanceStatus::Live);
        assert!(!host.instance_status(id).is_dead());

        // A module-level error is not a death.
        assert!(matches!(
            host.dispatch(id, b"{}", HostAction::new("kv-set", Vec::new()), &[]),
            Err(HostError::ModuleError(_))
        ));
        assert_eq!(host.instance_status(id), InstanceStatus::Live);

        assert!(matches!(
            host.dispatch(id, b"{}", HostAction::new("trap", Vec::new()), &[]),
            Err(HostError::Trap(_))
        ));
        match host.instance_status(id) {
            InstanceStatus::Dead { reason: Some(reason) } => {
                assert!(reason.contains("module 'm' export `dispatch` trapped"), "{reason}");
            }
            other => panic!("expected Dead with a reason, got {other:?}"),
        }
        assert!(host.instance_status(id).is_dead());
        assert_eq!(host.instance_status(bystander), InstanceStatus::Live);

        host.destroy(id).unwrap();
        assert_eq!(host.instance_status(id), InstanceStatus::Gone);
        assert_eq!(
            host.instance_status(ModuleInstanceId(u64::MAX >> 1)),
            InstanceStatus::Gone,
            "never issued"
        );
    }

    check(&mut WasmtimeHost::new().unwrap());
    let mut dual = DualHost::new().unwrap();
    check(&mut dual);
    // An async-host instance through the mux.
    dual.register("a", ASYNC_COUNTER_V02, ModuleManifest::all("a")).unwrap();
    let a = dual.instantiate("a").unwrap();
    let state = dual.init(a, b"{}").unwrap();
    assert_eq!(dual.instance_status(a), InstanceStatus::Live);
    let limits_hit = dual.dispatch(a, &state, HostAction::new("nope", Vec::new()), &[]);
    assert!(matches!(limits_hit, Err(HostError::ModuleError(_))));
    assert_eq!(dual.instance_status(a), InstanceStatus::Live);
    dual.destroy(a).unwrap();
    assert_eq!(dual.instance_status(a), InstanceStatus::Gone);
}

/// The link-time denial is available as data: which import, which manifest
/// grant — every one of them, not only the first.
#[test]
fn denied_capabilities_lists_every_missing_grant() {
    use hypen_engine::module_host::{DeniedCapability, DualHost, ManifestGrant};
    const FETCHER: &[u8] = include_bytes!("fixtures/fetcher_module.wasm");

    fn check(host: &mut dyn ModuleHost) {
        host.register("cart", COUNTER, ModuleManifest::default()).unwrap();
        assert_eq!(
            host.denied_capabilities("cart"),
            vec![DeniedCapability {
                import: "hypen:storage/cloud@0.1.0".into(),
                grant: ManifestGrant::Storage(StorageScope::Cloud),
            }]
        );
        assert!(matches!(host.instantiate("cart"), Err(HostError::Instantiate(_))));

        // Storage granted, network not.
        let storage_only = ModuleManifest {
            storage: vec![StorageScope::App, StorageScope::Cloud],
            ..ModuleManifest::default()
        };
        host.register("net", FETCHER, storage_only).unwrap();
        let denied = host.denied_capabilities("net");
        let grants: Vec<ManifestGrant> = denied.iter().map(|d| d.grant).collect();
        assert_eq!(grants, [ManifestGrant::Http], "{denied:?}");
        assert!(denied[0].import.starts_with("wasi:http/"), "{denied:?}");

        // Nothing granted: every missing grant is listed, each once.
        host.register("net", FETCHER, ModuleManifest::default()).unwrap();
        let grants: Vec<ManifestGrant> =
            host.denied_capabilities("net").iter().map(|d| d.grant).collect();
        assert!(grants.contains(&ManifestGrant::Http), "{grants:?}");
        let mut unique = grants.clone();
        unique.dedup();
        assert_eq!(unique.len(), grants.len(), "{grants:?}");

        // A linkable module and an unknown name deny nothing.
        host.register("cart", COUNTER, ModuleManifest::all("cart")).unwrap();
        assert!(host.denied_capabilities("cart").is_empty());
        assert!(host.denied_capabilities("nobody").is_empty());
    }

    check(&mut WasmtimeHost::new().unwrap());
    check(&mut DualHost::new().unwrap());
}

// ── compilation: once per component, optionally cached on disk ──────────────

/// The same bytes registered under several names — and re-registered — are
/// compiled once; different bytes are compiled separately; and both hosts
/// of a `DualHost` share the table.
#[test]
fn a_component_is_compiled_once_however_often_it_is_registered() {
    use hypen_engine::module_host::DualHost;

    let mut host = DualHost::new().unwrap();
    assert_eq!(host.compile_stats().compiled, 0);
    for name in ["counter", "counter__a", "counter__b"] {
        host.register(name, COUNTER, ModuleManifest::all(name)).unwrap();
    }
    let stats = host.compile_stats();
    assert_eq!((stats.compiled, stats.reused), (1, 2), "{stats:?}");
    // Each name is still its own module, with its own grants and instances.
    let a = host.instantiate("counter__a").unwrap();
    let b = host.instantiate("counter__b").unwrap();
    let state = host.init(a, b"{}").unwrap();
    let out = host
        .dispatch(a, &state, HostAction::new("increment", b"{}".to_vec()), &[])
        .unwrap();
    assert_eq!(count(&out.state.unwrap()), 1);
    assert_eq!(count(&host.init(b, b"{}").unwrap()), 0, "its own local storage");

    // A hot reload of unchanged bytes, under a different manifest.
    host.register("counter", COUNTER, ModuleManifest::default()).unwrap();
    assert_eq!(host.compile_stats().compiled, 1);
    assert!(!host.denied_capabilities("counter").is_empty());

    // Different bytes are a different component — also on the other ABI.
    host.register("mirror", MIRROR, ModuleManifest::all("mirror")).unwrap();
    host.register("async", ASYNC_COUNTER_V02, ModuleManifest::all("async")).unwrap();
    host.register("async2", ASYNC_COUNTER_V02, ModuleManifest::all("async2")).unwrap();
    let stats = host.compile_stats();
    assert_eq!((stats.compiled, stats.reused), (3, 4), "{stats:?}");
    assert_eq!((stats.disk_hits, stats.disk_misses), (0, 0), "no disk cache configured");

    // Bytes that do not compile are not remembered as compiled.
    assert!(host.register("bad", b"\0asm\x0d\0\x01\0garbage", ModuleManifest::default()).is_err());
    assert_eq!(host.compile_stats().compiled, 3);
}

/// Compiled code is kept only while a registration or instance uses it: once
/// every name has moved to other bytes and the old instances are gone, the
/// old component is forgotten (and would be compiled again).
#[test]
fn compiled_code_is_released_when_nothing_uses_it() {
    let mut host = WasmtimeHost::new().unwrap();
    host.register("m", COUNTER, ModuleManifest::all("m")).unwrap();
    let id = host.instantiate("m").unwrap();
    host.register("m", MIRROR, ModuleManifest::all("m")).unwrap();
    // The live instance still runs the old code, so it is still there.
    host.register("again", COUNTER, ModuleManifest::all("again")).unwrap();
    assert_eq!(host.compile_stats().compiled, 2);
    host.register("again", MIRROR, ModuleManifest::all("again")).unwrap();
    host.destroy(id).unwrap();
    // No registration and no instance of COUNTER is left.
    host.register("back", COUNTER, ModuleManifest::all("back")).unwrap();
    assert_eq!(host.compile_stats().compiled, 3);
}

/// `ComponentCompiler` compiles off to the side (another thread, no `&mut`
/// host); the registration that follows reuses the result.
#[test]
fn precompiling_on_another_thread_spares_register_the_compilation() {
    use hypen_engine::module_host::DualHost;

    let mut host = DualHost::new().unwrap();
    let compiler = host.compiler();
    let precompiled = std::thread::spawn(move || compiler.precompile("counter", COUNTER))
        .join()
        .unwrap()
        .unwrap();
    assert_eq!(host.compile_stats().compiled, 1);
    host.register("counter", COUNTER, ModuleManifest::all("counter")).unwrap();
    let stats = host.compile_stats();
    assert_eq!((stats.compiled, stats.reused), (1, 1), "{stats:?}");
    drop(precompiled);
    let id = host.instantiate("counter").unwrap();
    assert_eq!(count(&host.init(id, b"{}").unwrap()), 0);

    // Bad bytes fail in `precompile`, naming the label.
    let err = host.compiler().precompile("broken", b"not wasm").unwrap_err();
    assert!(matches!(err, HostError::Instantiate(_)), "{err}");
    assert!(err.to_string().contains("module 'broken' cannot be registered"), "{err}");
    // The compiler outlives the host it came from without keeping it usable.
    let compiler = host.compiler();
    drop(host);
    assert!(compiler.precompile("late", COUNTER).is_ok());
}

/// With a cache directory, a second host (a later process) loads the
/// compiled component from disk instead of compiling; a host with another
/// engine configuration does not share the entry; a corrupted entry is
/// recompiled, never trusted.
#[test]
fn the_disk_cache_spares_a_later_host_the_compilation() {
    use hypen_engine::module_host::{DualHost, HostConfig};

    let dir = tempfile::tempdir().unwrap();
    let cache_dir = dir.path().join("cache");
    let mut config = HostConfig::default();
    config.cache_dir = Some(cache_dir.clone());

    let run = |config: &HostConfig| {
        let mut host = DualHost::with_config(config).unwrap();
        host.register("counter", COUNTER, ModuleManifest::all("counter")).unwrap();
        let id = host.instantiate("counter").unwrap();
        let state = host.init(id, b"{}").unwrap();
        let out = host
            .dispatch(id, &state, HostAction::new("increment", b"{}".to_vec()), &[])
            .unwrap();
        assert_eq!(count(&out.state.unwrap()), 1);
        host.compile_stats()
    };

    let cold = run(&config);
    assert_eq!((cold.disk_hits, cold.disk_misses), (0, 1), "{cold:?}");
    let warm = run(&config);
    assert_eq!((warm.disk_hits, warm.disk_misses), (1, 0), "{warm:?}");

    // Another engine configuration (the interpreter) has its own entries.
    let mut interpreted = config.clone();
    interpreted.strategy = ExecStrategy::Interpreter;
    let other = run(&interpreted);
    assert_eq!((other.disk_hits, other.disk_misses), (0, 1), "{other:?}");
    assert_eq!(run(&interpreted).disk_hits, 1);

    // Corrupt every cached artifact: the next host must not load any.
    fn files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                files(&path, out);
            } else {
                out.push(path);
            }
        }
    }
    let mut cached = Vec::new();
    files(&cache_dir, &mut cached);
    assert!(!cached.is_empty(), "the cache wrote something");
    for path in &cached {
        std::fs::write(path, b"this is not a compiled component").unwrap();
    }
    let recompiled = run(&config);
    assert_eq!(recompiled.disk_hits, 0, "{recompiled:?}");
}

/// A cache directory that cannot be trusted or used is an error at host
/// construction, naming the directory — never a silent fallback to loading
/// from it.
#[test]
fn an_unusable_cache_directory_fails_host_construction() {
    use hypen_engine::module_host::{DualHost, HostConfig};

    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("not-a-dir");
    std::fs::write(&file, "x").unwrap();
    let mut config = HostConfig::default();
    config.cache_dir = Some(file);
    let err = match DualHost::with_config(&config) {
        Ok(_) => panic!("a file was accepted as the cache directory"),
        Err(e) => e,
    };
    assert!(matches!(err, HostError::Runtime(_)), "{err}");
    assert!(err.to_string().contains("not-a-dir"), "{err}");
    assert!(err.to_string().contains("is not a directory"), "{err}");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let shared = dir.path().join("shared");
        std::fs::create_dir(&shared).unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
        config.cache_dir = Some(shared);
        let err = match WasmtimeHost::with_config(&config) {
            Ok(_) => panic!("a world-writable cache directory was accepted"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("writable by other users"), "{err}");
    }
}

/// Startup cost of a large component (the ~14 MB TS fixture, which embeds a
/// JS engine), phase by phase. Not a test — a measurement:
///
/// ```text
/// cargo test [--release] --features module-loader --test test_module_host \
///     startup_timing -- --ignored --nocapture
/// ```
#[test]
#[ignore = "measurement; run explicitly with --ignored --nocapture"]
fn startup_timing() {
    use hypen_engine::module_host::{DualHost, HostConfig};

    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/ts_counter_module.wasm"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let limits = ModuleLimits {
        max_call: Duration::from_secs(600),
        ..ModuleLimits::default()
    };
    let ms = |d: Duration| format!("{:>9.1} ms", d.as_secs_f64() * 1e3);

    for strategy in [ExecStrategy::Jit, ExecStrategy::Interpreter] {
        for (label, cached) in [("no disk cache", false), ("disk cache, cold", true), ("disk cache, warm", true)] {
            let mut config = HostConfig::default();
            config.limits = limits;
            config.strategy = strategy;
            if cached {
                config.cache_dir = Some(dir.path().join(format!("{strategy:?}")));
            }
            let mut host = DualHost::with_config(&config).unwrap();

            let t = Instant::now();
            host.register("ts", &bytes, ModuleManifest::all("ts")).unwrap();
            let register = t.elapsed();
            let t = Instant::now();
            host.register("ts__b", &bytes, ModuleManifest::all("ts__b")).unwrap();
            let register_again = t.elapsed();
            let t = Instant::now();
            let id = host.instantiate("ts").unwrap();
            let instantiate = t.elapsed();
            let t = Instant::now();
            let state = host.init(id, b"{}").unwrap();
            let init = t.elapsed();
            let t = Instant::now();
            host.dispatch(id, &state, HostAction::new("increment", b"{}".to_vec()), &[])
                .unwrap();
            let dispatch = t.elapsed();
            println!(
                "{strategy:?} / {label:<17} register {}  2nd name {}  instantiate {}  init {}  dispatch {}",
                ms(register), ms(register_again), ms(instantiate), ms(init), ms(dispatch)
            );
        }
    }
}
