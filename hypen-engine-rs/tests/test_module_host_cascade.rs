//! Engine-side folding of hosted-module reducer outputs, driven with a
//! scriptable mock [`ModuleHost`] (default features — no wasmtime).
//!
//! Covers the security and correctness contract of the fold:
//! - follow-ups (`emit`, cross-dispatch, subscription `on_change`) are never
//!   string-routed, and the engine re-checks the `reads` / `dispatches` grants;
//! - the instance table and the `"*"` action wildcard;
//! - the cascade work queue: FIFO, depth cap, invocation budget, and "a failed
//!   follow-up never blocks the rest";
//! - engine state == the state the reducer returned;
//! - sibling snapshots limited to `reads`, served from a cache that tracks
//!   every state write;
//! - teardown leaves no routes or subscriptions behind.

use hypen_engine::dispatch::Action;
use hypen_engine::engine::{MAX_CASCADE_DEPTH, MAX_SUBSCRIPTIONS_PER_MODULE};
use hypen_engine::ir::{Element, IRNode, Props, Value as Prop};
use hypen_engine::module_host::{
    Effect, HostAction, HostError, ModuleHost, ModuleInstanceId, ModuleManifest, ReducerOutput,
    SiblingState, SubscribeRequest,
};
use hypen_engine::reactive::Binding;
use hypen_engine::{Engine, EngineError, ModuleGrants, Patch};
use indexmap::indexmap;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

// ── mock host ────────────────────────────────────────────────────────────────

const ACTIVATED: &str = "@activated";
const DEACTIVATED: &str = "@deactivated";
const DESTROYED: &str = "@destroyed";

/// What one reducer call saw.
#[derive(Debug, Clone, PartialEq)]
struct Call {
    id: u64,
    action: String,
    state: Value,
    siblings: Vec<(String, Value)>,
}

type Reducer = Box<dyn FnMut(&Call) -> Result<ReducerOutput, HostError> + Send>;
type Log = Arc<Mutex<Vec<Call>>>;

/// A host whose instances are closures. Lifecycle hooks reach the same closure
/// under the pseudo-action names above. An instance with no closure returns an
/// empty output.
struct ScriptHost {
    reducers: HashMap<u64, Reducer>,
    log: Log,
}

impl ScriptHost {
    fn run(
        &mut self,
        id: ModuleInstanceId,
        action: &str,
        state: &[u8],
        siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        let call = Call {
            id: id.0,
            action: action.to_string(),
            state: serde_json::from_slice(state).expect("engine passes valid JSON state"),
            siblings: siblings
                .iter()
                .map(|(name, bytes)| (name.clone(), serde_json::from_slice(bytes).unwrap()))
                .collect(),
        };
        self.log.lock().unwrap().push(call.clone());
        match self.reducers.get_mut(&id.0) {
            Some(reducer) => reducer(&call),
            None => Ok(ReducerOutput::default()),
        }
    }
}

impl ModuleHost for ScriptHost {
    fn register(&mut self, _: &str, _: &[u8], _: ModuleManifest) -> Result<(), HostError> {
        Ok(())
    }
    fn instantiate(&mut self, _: &str) -> Result<ModuleInstanceId, HostError> {
        Ok(ModuleInstanceId(0))
    }
    fn destroy(&mut self, _: ModuleInstanceId) -> Result<(), HostError> {
        Ok(())
    }
    fn init(&mut self, _: ModuleInstanceId, _: &[u8]) -> Result<Vec<u8>, HostError> {
        Ok(b"{}".to_vec())
    }
    fn dispatch(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        action: HostAction,
        siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        self.run(id, &action.name, state, siblings)
    }
    fn on_activated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        self.run(id, ACTIVATED, state, siblings)
    }
    fn on_deactivated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
    ) -> Result<ReducerOutput, HostError> {
        self.run(id, DEACTIVATED, state, &[])
    }
    fn on_destroyed(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<(), HostError> {
        self.run(id, DESTROYED, state, &[]).map(|_| ())
    }
    fn actions(&mut self, _: ModuleInstanceId) -> Result<Vec<String>, HostError> {
        Ok(Vec::new())
    }
}

/// One hosted scope of a test engine.
struct Spec {
    scope: &'static str,
    actions: &'static [&'static str],
    grants: ModuleGrants,
    state: Value,
    reducer: Option<Reducer>,
}

fn spec(scope: &'static str, actions: &'static [&'static str]) -> Spec {
    Spec {
        scope,
        actions,
        grants: ModuleGrants::none(),
        state: json!({}),
        reducer: None,
    }
}

impl Spec {
    fn grants(mut self, reads: &[&str], dispatches: &[&str]) -> Self {
        self.grants = ModuleGrants::new(reads.iter().copied(), dispatches.iter().copied());
        self
    }
    fn state(mut self, state: Value) -> Self {
        self.state = state;
        self
    }
    fn reducer(
        mut self,
        f: impl FnMut(&Call) -> Result<ReducerOutput, HostError> + Send + 'static,
    ) -> Self {
        self.reducer = Some(Box::new(f));
        self
    }
}

/// Build an engine hosting `specs`; instance ids are the spec indices.
fn engine_with(specs: Vec<Spec>) -> (Engine, Log) {
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let mut reducers = HashMap::new();
    let mut wiring = Vec::new();
    for (index, spec) in specs.into_iter().enumerate() {
        if let Some(reducer) = spec.reducer {
            reducers.insert(index as u64, reducer);
        }
        wiring.push((index as u64, spec.scope, spec.actions, spec.grants, spec.state));
    }
    let mut engine = Engine::new();
    engine.set_module_host(Box::new(ScriptHost {
        reducers,
        log: Arc::clone(&log),
    }));
    for (id, scope, actions, grants, state) in wiring {
        engine
            .register_module_instance(
                scope,
                ModuleInstanceId(id),
                actions.iter().map(|a| a.to_string()).collect(),
                grants,
                state,
            )
            .unwrap();
    }
    (engine, log)
}

fn action(name: &str) -> HostAction {
    HostAction::new(name, b"null".to_vec())
}

fn with_state(state: Value) -> ReducerOutput {
    ReducerOutput {
        state: Some(serde_json::to_vec(&state).unwrap()),
        ..Default::default()
    }
}

fn emit(names: &[&str]) -> ReducerOutput {
    ReducerOutput {
        emit: names.iter().map(|n| action(n)).collect(),
        ..Default::default()
    }
}

fn cross(target: &str, name: &str) -> ReducerOutput {
    ReducerOutput {
        cross_dispatch: vec![(target.to_string(), action(name))],
        ..Default::default()
    }
}

fn subscribe(target: &str, path: &str, on_change: &str) -> SubscribeRequest {
    SubscribeRequest {
        target: target.into(),
        path: path.into(),
        on_change: on_change.into(),
    }
}

/// `(instance id, action)` of every reducer call so far.
fn calls(log: &Log) -> Vec<(u64, String)> {
    log.lock()
        .unwrap()
        .iter()
        .map(|c| (c.id, c.action.clone()))
        .collect()
}

fn module_error(result: Result<(), EngineError>) -> String {
    match result {
        Err(EngineError::ModuleError(message)) => message,
        other => panic!("expected a ModuleError, got {other:?}"),
    }
}

/// Bumps `n` in its state on every call.
fn counter() -> impl FnMut(&Call) -> Result<ReducerOutput, HostError> + Send + 'static {
    |call: &Call| {
        let n = call.state["n"].as_i64().unwrap_or(0);
        Ok(with_state(json!({ "n": n + 1 })))
    }
}

// ── D1: follow-ups are never string-routed; grants are re-checked ────────────

#[test]
fn emit_with_a_scope_qualifier_is_not_rerouted_to_a_sibling() {
    // `a` has no grants at all, yet names another module's action.
    let (mut engine, log) = engine_with(vec![
        spec("a", &["go"]).reducer(|_| Ok(emit(&["b:x", "x"]))),
        spec("b", &["x"]).reducer(counter()),
    ]);
    let message = module_error(engine.dispatch_module_action("a", "go", Value::Null));
    assert!(message.contains("b:x"), "{message}");
    assert_eq!(calls(&log), vec![(0, "go".into())], "b must never run");
    assert_eq!(engine.get_module_state("b").unwrap(), &json!({}));
}

#[test]
fn emit_cannot_forge_renderer_envelopes() {
    let envelope = json!({ "node": "1", "action": "x" });
    let (mut engine, log) = engine_with(vec![
        spec("a", &["go"]).reducer(move |_| {
            Ok(ReducerOutput {
                emit: vec![
                    HostAction::new("__hypen_dispatch", serde_json::to_vec(&envelope).unwrap()),
                    action("__hypen_scoped:b:x"),
                ],
                ..Default::default()
            })
        }),
        spec("b", &["x"]).reducer(counter()),
    ]);
    let message = module_error(engine.dispatch_module_action("a", "go", Value::Null));
    assert!(message.contains("2 failure(s)"), "{message}");
    assert_eq!(calls(&log), vec![(0, "go".into())]);
}

#[test]
fn emit_stays_in_the_emitting_scope_even_when_a_sibling_shares_the_name() {
    let (mut engine, log) = engine_with(vec![
        spec("a", &["go", "x"]).reducer(|call| {
            Ok(if call.action == "go" { emit(&["x"]) } else { ReducerOutput::default() })
        }),
        spec("b", &["x"]).reducer(counter()),
    ]);
    engine.dispatch_module_action("a", "go", Value::Null).unwrap();
    assert_eq!(calls(&log), vec![(0, "go".into()), (0, "x".into())]);
}

#[test]
fn cross_dispatch_without_a_grant_is_refused_by_the_engine() {
    // The mock host enforces nothing — like the JS-bridged host, which leaves
    // the check to JS. The engine must refuse on its own.
    let (mut engine, log) = engine_with(vec![
        spec("a", &["go"]).reducer(|_| Ok(cross("b", "x"))),
        spec("b", &["x"]).reducer(counter()),
    ]);
    let message = module_error(engine.dispatch_module_action("a", "go", Value::Null));
    assert!(message.contains("no `dispatches` grant"), "{message}");
    assert_eq!(calls(&log), vec![(0, "go".into())]);
}

#[test]
fn cross_dispatch_with_a_grant_reaches_exactly_the_granted_target() {
    let (mut engine, log) = engine_with(vec![
        spec("a", &["go"])
            .grants(&[], &["B"]) // grants compare case-insensitively
            .reducer(|_| Ok(cross("B", "x"))),
        spec("b", &["x"]).reducer(counter()),
        spec("c", &["x"]).reducer(counter()),
    ]);
    engine.dispatch_module_action("a", "go", Value::Null).unwrap();
    assert_eq!(calls(&log), vec![(0, "go".into()), (1, "x".into())]);
    assert_eq!(engine.get_module_state("b").unwrap(), &json!({ "n": 1 }));
}

#[test]
fn cross_dispatch_cannot_smuggle_a_qualifier_in_the_action_name() {
    // `a` may dispatch to `b` only, and tries to reach `c` through the name.
    let (mut engine, log) = engine_with(vec![
        spec("a", &["go"]).grants(&[], &["b"]).reducer(|_| {
            Ok(ReducerOutput {
                cross_dispatch: vec![
                    ("b".into(), action("c:x")),
                    ("b".into(), action("__hypen_scoped:c:x")),
                    ("b:c".into(), action("x")),
                ],
                ..Default::default()
            })
        }),
        spec("b", &["x"]).reducer(counter()),
        spec("c", &["x"]).reducer(counter()),
    ]);
    let message = module_error(engine.dispatch_module_action("a", "go", Value::Null));
    assert!(message.contains("3 failure(s)"), "{message}");
    assert_eq!(calls(&log), vec![(0, "go".into())]);
}

#[test]
fn subscribe_needs_the_reads_grant_and_notifies_only_the_subscriber() {
    let (mut engine, log) = engine_with(vec![
        // No reads grant on `t`.
        spec("nosy", &["watch", "changed"]).reducer(|call| {
            Ok(match call.action.as_str() {
                "watch" => ReducerOutput {
                    subscribe_requests: vec![subscribe("t", "", "changed")],
                    ..Default::default()
                },
                _ => ReducerOutput::default(),
            })
        }),
        // Granted, but names an action it does not own as `on_change`.
        spec("sly", &["watch"]).grants(&["t"], &[]).reducer(|_| {
            Ok(ReducerOutput {
                subscribe_requests: vec![subscribe("t", "", "t:bump")],
                ..Default::default()
            })
        }),
        spec("ok", &["watch", "changed"]).grants(&["t"], &[]).reducer(|call| {
            Ok(match call.action.as_str() {
                "watch" => ReducerOutput {
                    subscribe_requests: vec![subscribe("T", "n", "changed")],
                    ..Default::default()
                },
                _ => ReducerOutput::default(),
            })
        }),
        spec("t", &["bump"]).reducer(counter()),
    ]);
    let refused = module_error(engine.dispatch_module_action("nosy", "watch", Value::Null));
    assert!(refused.contains("no `reads` grant"), "{refused}");
    let refused = module_error(engine.dispatch_module_action("sly", "watch", Value::Null));
    assert!(refused.contains("on_change"), "{refused}");
    engine.dispatch_module_action("ok", "watch", Value::Null).unwrap();

    log.lock().unwrap().clear();
    engine.dispatch_module_action("t", "bump", Value::Null).unwrap();
    assert_eq!(calls(&log), vec![(3, "bump".into()), (2, "changed".into())]);
}

// ── D2: instance table + wildcard ────────────────────────────────────────────

#[test]
fn a_module_exporting_no_actions_still_has_an_instance_and_a_lifecycle() {
    let (mut engine, log) = engine_with(vec![spec("quiet", &[])
        .reducer(|call| Ok(with_state(json!({ "last": call.action }))))]);
    assert_eq!(engine.module_instance_id("Quiet"), Some(ModuleInstanceId(0)));

    engine.activate_module("quiet").unwrap();
    assert_eq!(engine.get_module_state("quiet").unwrap(), &json!({ "last": ACTIVATED }));
    engine.deactivate_module("quiet").unwrap();
    assert_eq!(engine.get_module_state("quiet").unwrap(), &json!({ "last": DEACTIVATED }));

    // Hot reload can find — and replace — the old instance.
    engine
        .rewire_module_instance("quiet", ModuleInstanceId(7), vec![], ModuleGrants::none())
        .unwrap();
    assert_eq!(engine.module_instance_id("quiet"), Some(ModuleInstanceId(7)));

    engine.destroy_module("quiet").unwrap();
    assert_eq!(
        calls(&log),
        vec![
            (0, ACTIVATED.to_string()),
            (0, DEACTIVATED.to_string()),
            (7, DESTROYED.to_string()),
        ]
    );
    assert_eq!(engine.module_instance_id("quiet"), None);
}

#[test]
fn wildcard_scope_accepts_any_action_name() {
    let (mut engine, log) = engine_with(vec![
        spec("any", &["*"]).reducer(|call| {
            Ok(if call.action == "first" { emit(&["made-up"]) } else { ReducerOutput::default() })
        }),
        spec("strict", &["only"]),
    ]);
    // Trusted API, a follow-up emit, a scoped wire name, and a bare name the
    // wildcard scope is the sole candidate for.
    engine.dispatch_module_action("any", "first", Value::Null).unwrap();
    engine
        .dispatch_action(Action::new("__hypen_scoped:any:whatever"))
        .unwrap();
    engine.dispatch_action(Action::new("bare")).unwrap();
    assert_eq!(
        calls(&log),
        vec![
            (0, "first".into()),
            (0, "made-up".into()),
            (0, "whatever".into()),
            (0, "bare".into()),
        ]
    );

    // An explicitly exported name still wins over the wildcard for bare names.
    engine.dispatch_action(Action::new("only")).unwrap();
    assert_eq!(calls(&log).last().unwrap(), &(1, "only".to_string()));

    // The wildcard never covers reserved engine names, and a non-wildcard
    // scope still fails closed.
    for reserved in ["__hypen_bind", "__hypen_dispatch"] {
        let err = engine
            .dispatch_module_action("any", reserved, Value::Null)
            .unwrap_err();
        assert!(matches!(err, EngineError::ActionNotFound(_)), "{err}");
    }
    let err = engine
        .dispatch_action(Action::new("__hypen_scoped:strict:whatever"))
        .unwrap_err();
    assert!(matches!(err, EngineError::ActionNotFound(_)), "{err}");
    assert_eq!(calls(&log).len(), 5);
}

#[test]
fn wildcard_scope_resolves_ui_envelopes_by_node_ownership() {
    let (mut engine, log) = engine_with(vec![spec("any", &["*"]), spec("other", &["*"])]);
    let ids = render_texts(&mut engine, &[("any", "n"), ("other", "n")]);

    let envelope = |node: &str, name: &str| {
        Action::new("__hypen_dispatch").with_payload(json!({ "node": node, "action": name }))
    };
    engine.dispatch_action(envelope(&ids[1], "tap")).unwrap();
    engine.dispatch_action(envelope(&ids[0], "tap")).unwrap();
    assert_eq!(calls(&log), vec![(1, "tap".into()), (0, "tap".into())]);

    // Two wildcard scopes: a bare name has no single owner.
    let err = engine.dispatch_action(Action::new("tap")).unwrap_err();
    assert!(matches!(err, EngineError::ActionNotFound(_)), "{err}");
    assert_eq!(calls(&log).len(), 2);
}

#[test]
fn malformed_scopes_actions_and_states_are_rejected_at_registration() {
    let (mut engine, _) = engine_with(vec![]);
    let mut register = |scope: &str, actions: &[&str], state: Value| {
        engine.register_module_instance(
            scope,
            ModuleInstanceId(0),
            actions.iter().map(|a| a.to_string()).collect(),
            ModuleGrants::none(),
            state,
        )
    };
    assert!(register("a:b", &["x"], json!({})).is_err());
    assert!(register("", &["x"], json!({})).is_err());
    // A `:` in an action name could alias another scope's handler record.
    assert!(register("a", &["b:x"], json!({})).is_err());
    assert!(register("a", &["__hypen_dispatch"], json!({})).is_err());
    assert!(register("a", &["x"], json!([1, 2])).is_err());
    assert!(register("a", &["x"], json!({})).is_ok());
    assert!(engine
        .rewire_module_instance("missing", ModuleInstanceId(1), vec![], ModuleGrants::none())
        .is_err());
}

// ── D3: cascade queue, caps, error semantics ─────────────────────────────────

#[test]
fn a_reducer_that_emits_two_actions_to_itself_stops_at_the_budget() {
    let (mut engine, log) =
        engine_with(vec![spec("a", &["go"]).reducer(|_| Ok(emit(&["go", "go"])))]);
    assert_eq!(engine.module_dispatch_budget(), 1024);

    let message = module_error(engine.dispatch_module_action("a", "go", Value::Null));
    assert!(message.contains("budget (1024) exhausted"), "{message}");
    assert_eq!(calls(&log).len(), 1024);

    log.lock().unwrap().clear();
    engine.set_module_dispatch_budget(10);
    module_error(engine.dispatch_module_action("a", "go", Value::Null));
    assert_eq!(calls(&log).len(), 10);
}

#[test]
fn a_ping_pong_cycle_stops_at_the_depth_cap() {
    let (mut engine, log) = engine_with(vec![
        spec("a", &["ping"]).grants(&[], &["b"]).reducer(|_| Ok(cross("b", "pong"))),
        spec("b", &["pong"]).grants(&[], &["a"]).reducer(|_| Ok(cross("a", "ping"))),
    ]);
    let message = module_error(engine.dispatch_module_action("a", "ping", Value::Null));
    assert!(message.contains("depth cap"), "{message}");
    assert_eq!(calls(&log).len(), MAX_CASCADE_DEPTH as usize);
}

#[test]
fn follow_ups_run_breadth_first_in_emission_order() {
    let (mut engine, log) = engine_with(vec![
        spec("a", &["go", "e1", "e2", "e1a"]).grants(&[], &["b"]).reducer(|call| {
            Ok(match call.action.as_str() {
                "go" => ReducerOutput {
                    emit: vec![action("e1"), action("e2")],
                    cross_dispatch: vec![("b".into(), action("x"))],
                    ..Default::default()
                },
                "e1" => emit(&["e1a"]),
                _ => ReducerOutput::default(),
            })
        }),
        spec("b", &["x"]),
    ]);
    engine.dispatch_module_action("a", "go", Value::Null).unwrap();
    assert_eq!(
        calls(&log),
        vec![
            (0, "go".into()),
            (0, "e1".into()),
            (0, "e2".into()),
            (1, "x".into()),
            (0, "e1a".into()),
        ]
    );
}

#[test]
fn a_failed_follow_up_blocks_neither_siblings_nor_subscriptions() {
    let watcher = |fail: bool| {
        move |call: &Call| match call.action.as_str() {
            "changed" if fail => Err(HostError::Trap("boom".into())),
            "changed" => Ok(with_state(json!({ "seen": call.siblings[0].1["n"] }))),
            _ => Ok(ReducerOutput {
                subscribe_requests: vec![subscribe("src", "n", "changed")],
                ..Default::default()
            }),
        }
    };
    let (mut engine, log) = engine_with(vec![
        spec("src", &["bump", "bad", "late", "noted"]).grants(&["w2"], &[]).reducer(|call| {
            Ok(match call.action.as_str() {
                // State change + a subscription + a failing emit, an unknown
                // emit, and a good emit — all in one output.
                "bump" => ReducerOutput {
                    state: Some(br#"{"n":1}"#.to_vec()),
                    emit: vec![action("bad"), action("nope"), action("late")],
                    subscribe_requests: vec![subscribe("w2", "seen", "noted")],
                    ..Default::default()
                },
                "bad" => return Err(HostError::ModuleError("bad failed".into())),
                _ => ReducerOutput::default(),
            })
        }),
        spec("w1", &["watch", "changed"]).grants(&["src"], &[]).reducer(watcher(true)),
        spec("w2", &["watch", "changed"]).grants(&["src"], &[]).reducer(watcher(false)),
    ]);
    engine.dispatch_module_action("w1", "watch", Value::Null).unwrap();
    engine.dispatch_module_action("w2", "watch", Value::Null).unwrap();
    log.lock().unwrap().clear();

    let message = module_error(engine.dispatch_module_action("src", "bump", Value::Null));
    assert!(message.contains("3 failure(s)"), "{message}");
    for expected in ["bad failed", "'nope' refused", "boom"] {
        assert!(message.contains(expected), "missing {expected:?} in {message}");
    }

    // Everything that could run did, in queue order; `src`'s own subscription
    // on `w2.seen` was registered by the same output and fired when `w2`
    // recorded what it saw.
    assert_eq!(
        calls(&log),
        vec![
            (0, "bump".into()),
            (0, "bad".into()),
            (0, "late".into()),
            (1, "changed".into()),
            (2, "changed".into()),
            (0, "noted".into()),
        ]
    );
    // The root's state stays applied, and the healthy subscriber saw it.
    assert_eq!(engine.get_module_state("src").unwrap(), &json!({ "n": 1 }));
    assert_eq!(engine.get_module_state("w2").unwrap(), &json!({ "seen": 1 }));
}

#[test]
fn a_failing_root_action_applies_nothing() {
    let effects = Arc::new(Mutex::new(0));
    let sink = Arc::clone(&effects);
    let (mut engine, log) = engine_with(vec![spec("a", &["trap", "array", "garbage", "x"])
        .state(json!({ "keep": true }))
        .reducer(|call| {
            let invalid = |state: &[u8]| ReducerOutput {
                state: Some(state.to_vec()),
                effects: vec![Effect::Navigate("/nope".into())],
                emit: vec![action("x")],
                ..Default::default()
            };
            match call.action.as_str() {
                "trap" => Err(HostError::Trap("unreachable".into())),
                "array" => Ok(invalid(b"[1,2,3]")),
                "garbage" => Ok(invalid(b"{not json")),
                _ => Ok(ReducerOutput::default()),
            }
        })]);
    engine.set_effect_handler(move |_, _| *sink.lock().unwrap() += 1);

    let err = engine.dispatch_module_action("a", "trap", Value::Null).unwrap_err();
    assert!(matches!(err, EngineError::ModuleError(_)), "{err}");
    for bad in ["array", "garbage"] {
        let err = engine.dispatch_module_action("a", bad, Value::Null).unwrap_err();
        assert!(matches!(err, EngineError::StateError(_)), "{bad}: {err}");
    }
    let err = engine.dispatch_module_action("a", "unknown", Value::Null).unwrap_err();
    assert!(matches!(err, EngineError::ActionNotFound(_)), "{err}");
    let err = engine.dispatch_module_action("ghost", "x", Value::Null).unwrap_err();
    assert!(matches!(err, EngineError::ActionNotFound(_)), "{err}");

    assert_eq!(engine.get_module_state("a").unwrap(), &json!({ "keep": true }));
    assert_eq!(*effects.lock().unwrap(), 0, "no effect of a rejected output runs");
    assert_eq!(
        calls(&log),
        vec![(0, "trap".into()), (0, "array".into()), (0, "garbage".into())],
        "no follow-up of a rejected output runs"
    );
}

#[test]
fn lifecycle_outputs_fold_through_the_same_cascade() {
    let (mut engine, log) = engine_with(vec![
        spec("a", &["boot"]).grants(&[], &["b"]).reducer(|call| {
            Ok(match call.action.as_str() {
                ACTIVATED => ReducerOutput {
                    state: Some(br#"{"active":true}"#.to_vec()),
                    emit: vec![action("boot"), action("b:x")],
                    ..Default::default()
                },
                DEACTIVATED => ReducerOutput {
                    state: Some(br#"{"active":false}"#.to_vec()),
                    cross_dispatch: vec![("b".into(), action("x"))],
                    ..Default::default()
                },
                _ => ReducerOutput::default(),
            })
        }),
        spec("b", &["x"]).reducer(counter()),
    ]);
    // Same rules as a dispatch: the smuggled emit is refused and reported,
    // the legitimate one runs.
    let message = module_error(engine.activate_module("a"));
    assert!(message.contains("b:x"), "{message}");
    assert_eq!(calls(&log), vec![(0, ACTIVATED.into()), (0, "boot".into())]);
    assert_eq!(engine.get_module_state("a").unwrap(), &json!({ "active": true }));

    engine.deactivate_module("a").unwrap();
    assert_eq!(engine.get_module_state("a").unwrap(), &json!({ "active": false }));
    assert_eq!(engine.get_module_state("b").unwrap(), &json!({ "n": 1 }));

    // Unknown scopes are a no-op, as before.
    engine.activate_module("ghost").unwrap();
    engine.deactivate_module("ghost").unwrap();
}

// ── D4: engine state == the reducer's returned state ─────────────────────────

/// Drive `initial -> returned` through a reducer and return the engine's copy.
fn state_after(initial: Value, returned: Value) -> Value {
    let next = returned.clone();
    let (mut engine, log) = engine_with(vec![spec("m", &["set", "echo"])
        .state(initial)
        .reducer(move |call| {
            Ok(if call.action == "set" { with_state(next.clone()) } else { ReducerOutput::default() })
        })]);
    engine.dispatch_module_action("m", "set", Value::Null).unwrap();
    // The next dispatch is fed exactly that state, too.
    engine.dispatch_module_action("m", "echo", Value::Null).unwrap();
    assert_eq!(log.lock().unwrap()[1].state, returned, "state fed to the next dispatch");
    engine.get_module_state("m").unwrap().clone()
}

#[test]
fn engine_state_equals_the_state_the_reducer_returned() {
    let cases = [
        // (name, initial, returned)
        ("key deletion", json!({ "a": 1, "b": 2 }), json!({ "a": 1 })),
        (
            "nested deletion",
            json!({ "user": { "name": "x", "tmp": { "deep": [1] } } }),
            json!({ "user": { "name": "x" } }),
        ),
        ("array shrink", json!({ "items": [1, 2, 3, 4] }), json!({ "items": [1] })),
        (
            "nested array shrink",
            json!({ "rows": [{ "tags": ["a", "b"] }, { "tags": ["c"] }] }),
            json!({ "rows": [{ "tags": [] }] }),
        ),
        ("array to empty", json!({ "items": [1, 2] }), json!({ "items": [] })),
        (
            "key containing a dot",
            json!({ "a": { "b": 1 } }),
            json!({ "a": { "b": 1 }, "a.b": 2, "x.y.z": { "k.": [1] } }),
        ),
        (
            "dotted key changed and removed",
            json!({ "a.b": 1, "c.d": 2, "nested": { "e.f": 3, "": 0 } }),
            json!({ "a.b": 9, "nested": { "": 1 } }),
        ),
        ("empty object", json!({ "a": 1, "b": { "c": 2 } }), json!({})),
        ("from empty object", json!({}), json!({ "a": null, "b": [] })),
        (
            "type changes",
            json!({ "a": { "x": 1 }, "b": [1], "c": 1, "d": null }),
            json!({ "a": [1], "b": { "0": 1 }, "c": "1", "d": {} }),
        ),
        ("explicit null stays a key", json!({ "a": 1 }), json!({ "a": null })),
    ];
    for (name, initial, returned) in cases {
        assert_eq!(state_after(initial, returned.clone()), returned, "case: {name}");
    }
}

fn text_bound_to(scope: &str, path: &[&str]) -> Element {
    Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "text".to_string() =>
                Prop::Binding(Binding::state(path.iter().map(|s| s.to_string()).collect()))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: Some(scope.to_string()),
        semantics: None,
        span: None,
        expr_span: None,
    }
}

/// Render one Text per `(scope, top-level state key)` and return their node
/// ids in order. Leaves the render callback collecting nothing.
fn render_texts(engine: &mut Engine, bound: &[(&str, &str)]) -> Vec<String> {
    let created = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&created);
    engine.set_render_callback(move |patches: &[Patch]| {
        for patch in patches {
            if let Patch::Create { id, element_type, .. } = patch {
                if element_type == "Text" {
                    sink.lock().unwrap().push(id.to_string());
                }
            }
        }
    });
    engine.render(&Element {
        element_type: "Column".to_string(),
        props: Props::new(),
        ir_children: bound
            .iter()
            .map(|(scope, key)| IRNode::Element(text_bound_to(scope, &[key])))
            .collect(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    });
    engine.set_render_callback(|_| {});
    let ids = created.lock().unwrap().clone();
    assert_eq!(ids.len(), bound.len());
    ids
}

#[test]
fn replacing_state_only_dirties_the_bindings_on_changed_paths() {
    let (mut engine, _) = engine_with(vec![spec("m", &["edit", "drop", "dotted"])
        .state(json!({ "title": "t", "count": 0, "gone": "g", "cfg": { "x": 1 } }))
        .reducer(|call| {
            let mut state = call.state.clone();
            match call.action.as_str() {
                "edit" => state["count"] = json!(1),
                "drop" => {
                    state.as_object_mut().unwrap().remove("gone");
                }
                _ => state["cfg"]["a.b"] = json!(true),
            }
            Ok(with_state(state))
        })]);
    let ids = render_texts(
        &mut engine,
        &[("m", "title"), ("m", "count"), ("m", "gone"), ("m", "cfg")],
    );
    let touched = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&touched);
    engine.set_render_callback(move |patches: &[Patch]| {
        for patch in patches {
            if let Patch::SetProp { id, .. } | Patch::RemoveProp { id, .. } = patch {
                sink.lock().unwrap().push(id.to_string());
            }
        }
    });
    let touched_by = |engine: &mut Engine, action: &str| {
        touched.lock().unwrap().clear();
        engine.dispatch_module_action("m", action, Value::Null).unwrap();
        touched.lock().unwrap().clone()
    };

    assert_eq!(touched_by(&mut engine, "edit"), vec![ids[1].clone()]);
    // A deleted key re-renders its binding (and nothing else).
    assert_eq!(touched_by(&mut engine, "drop"), vec![ids[2].clone()]);
    // A dotted key has no path of its own: its parent is invalidated instead.
    assert_eq!(touched_by(&mut engine, "dotted"), vec![ids[3].clone()]);
    assert_eq!(
        engine.get_module_state("m").unwrap(),
        &json!({ "title": "t", "count": 1, "cfg": { "x": 1, "a.b": true } })
    );
}

// ── D5: sibling snapshots ────────────────────────────────────────────────────

#[test]
fn a_module_is_handed_only_the_siblings_its_reads_grant_names() {
    let (mut engine, log) = engine_with(vec![
        spec("a", &["go"]).grants(&["B", "ghost", "a"], &["c"]),
        spec("b", &["x"]).state(json!({ "secret": "b" })),
        spec("c", &["x"]).state(json!({ "secret": "c" })),
        spec("d", &["go"]),
    ]);
    engine.dispatch_module_action("a", "go", Value::Null).unwrap();
    engine.dispatch_module_action("d", "go", Value::Null).unwrap();
    engine.activate_module("a").unwrap();
    engine.deactivate_module("a").unwrap();

    let log = log.lock().unwrap();
    let granted = vec![("b".to_string(), json!({ "secret": "b" }))];
    // `dispatches` is not a read grant; unknown names and itself are skipped.
    assert_eq!(log[0].siblings, granted);
    assert!(log[1].siblings.is_empty(), "no grant, no snapshots");
    assert_eq!(log[2].siblings, granted, "on_activated gets the same view");
    assert!(log[3].siblings.is_empty());
}

#[test]
fn cached_snapshots_track_every_kind_of_state_write() {
    let (mut engine, log) = engine_with(vec![
        spec("a", &["go"]).grants(&["b"], &[]).state(json!({ "own": 0 })),
        spec("b", &["bump"]).state(json!({ "n": 0 })).reducer(counter()),
    ]);
    let seen = |engine: &mut Engine| {
        engine.dispatch_module_action("a", "go", Value::Null).unwrap();
        let call = log.lock().unwrap().last().unwrap().clone();
        (call.state, call.siblings[0].1.clone())
    };
    assert_eq!(seen(&mut engine), (json!({ "own": 0 }), json!({ "n": 0 })));
    // Unchanged state is served again (from the cache) identically.
    assert_eq!(seen(&mut engine), (json!({ "own": 0 }), json!({ "n": 0 })));

    // A reducer fold on the sibling.
    engine.dispatch_module_action("b", "bump", Value::Null).unwrap();
    assert_eq!(seen(&mut engine).1, json!({ "n": 1 }));

    // Engine state APIs that bypass the module host entirely.
    engine.update_state(Some("b"), json!({ "n": 5 }));
    engine.update_state(Some("a"), json!({ "own": 1 }));
    assert_eq!(seen(&mut engine), (json!({ "own": 1 }), json!({ "n": 5 })));
    engine.update_state_sparse(Some("b"), &["n".to_string()], &json!({ "n": 6 }));
    assert_eq!(seen(&mut engine).1, json!({ "n": 6 }));

    // Re-registering the sibling's module slot.
    engine
        .register_module_instance(
            "b",
            ModuleInstanceId(1),
            vec!["bump".into()],
            ModuleGrants::none(),
            json!({ "n": 100 }),
        )
        .unwrap();
    assert_eq!(seen(&mut engine).1, json!({ "n": 100 }));
}

// ── D7: teardown ─────────────────────────────────────────────────────────────

/// `watcher` subscribes to `target` (whole state) on `watch`.
fn watcher_spec(scope: &'static str, target: &'static str) -> Spec {
    spec(scope, &["watch", "changed", "bump"])
        .grants(&[target], &[])
        .reducer(move |call| {
            Ok(match call.action.as_str() {
                "watch" => ReducerOutput {
                    subscribe_requests: vec![subscribe(target, "", "changed")],
                    ..Default::default()
                },
                "bump" => with_state(json!({ "n": call.state["n"].as_i64().unwrap_or(0) + 1 })),
                _ => ReducerOutput::default(),
            })
        })
}

#[test]
fn destroying_a_module_leaves_no_routes_or_subscriptions() {
    // a <-> b watch each other.
    let (mut engine, log) = engine_with(vec![watcher_spec("a", "b"), watcher_spec("b", "a")]);
    let ids = render_texts(&mut engine, &[("a", "n")]);
    engine.dispatch_module_action("a", "watch", Value::Null).unwrap();
    engine.dispatch_module_action("b", "watch", Value::Null).unwrap();
    engine.dispatch_module_action("a", "bump", Value::Null).unwrap();
    assert_eq!(calls(&log).last().unwrap(), &(1, "changed".to_string()));

    engine.destroy_module("A").unwrap();
    assert_eq!(calls(&log).last().unwrap(), &(0, DESTROYED.to_string()));
    log.lock().unwrap().clear();

    // No instance, no state, no route of any form into the dead instance.
    assert_eq!(engine.module_instance_id("a"), None);
    assert!(engine.get_module_state("a").is_none());
    let attempts = [
        engine.dispatch_module_action("a", "bump", Value::Null),
        engine.dispatch_action(Action::new("__hypen_scoped:a:bump")),
        engine.dispatch_action(
            Action::new("__hypen_dispatch")
                .with_payload(json!({ "node": ids[0], "action": "bump" })),
        ),
    ];
    for attempt in attempts {
        assert!(matches!(attempt, Err(EngineError::ActionNotFound(_))), "{attempt:?}");
    }
    engine.activate_module("a").unwrap(); // lifecycle calls are a no-op
    // `bump` now has a single owner again, and it is not the dead instance.
    engine.dispatch_action(Action::new("bump")).unwrap();
    // a's subscription on b is gone: b changing notifies nobody.
    assert_eq!(calls(&log), vec![(1, "bump".into())]);
    engine.destroy_module("a").unwrap(); // idempotent

    // b's subscription on `a` is gone too: a fresh module under the same name
    // does not inherit the old one's observers.
    engine
        .register_module_instance(
            "a",
            ModuleInstanceId(0),
            vec!["bump".into()],
            ModuleGrants::none(),
            json!({}),
        )
        .unwrap();
    log.lock().unwrap().clear();
    engine.dispatch_module_action("a", "bump", Value::Null).unwrap();
    assert_eq!(calls(&log), vec![(0, "bump".into())]);
}

#[test]
fn destroy_tears_down_even_when_the_hook_fails() {
    let (mut engine, _) = engine_with(vec![spec("a", &["x"]).reducer(|call| {
        if call.action == DESTROYED {
            Err(HostError::Trap("teardown trapped".into()))
        } else {
            Ok(ReducerOutput::default())
        }
    })]);
    let message = module_error(engine.destroy_module("a"));
    assert!(message.contains("teardown trapped"), "{message}");
    assert_eq!(engine.module_instance_id("a"), None);
    assert!(engine.dispatch_module_action("a", "x", Value::Null).is_err());
}

#[test]
fn rewiring_drops_the_scopes_own_subscriptions_but_keeps_its_observers() {
    let (mut engine, log) = engine_with(vec![
        watcher_spec("a", "b"),
        watcher_spec("b", "a"),
        // Instance 2 stands in for `a`'s reloaded build.
        spec("spare", &[]).reducer(counter()),
    ]);
    engine.dispatch_module_action("a", "watch", Value::Null).unwrap();
    engine.dispatch_module_action("b", "watch", Value::Null).unwrap();

    // Hot-reload `a` onto the new instance; its state slot is preserved.
    engine
        .rewire_module_instance(
            "a",
            ModuleInstanceId(2),
            vec!["changed".into(), "bump".into()],
            ModuleGrants::new(["b"], [] as [&str; 0]),
        )
        .unwrap();
    log.lock().unwrap().clear();

    // The old instance's subscription on b is gone: nothing reaches the new
    // instance through it.
    engine.dispatch_module_action("b", "bump", Value::Null).unwrap();
    assert_eq!(calls(&log), vec![(1, "bump".into())]);

    // b never reloaded and still observes `a`: that subscription is b's,
    // authorized by b's `reads` grant, keyed by scope name, and runs in b.
    log.lock().unwrap().clear();
    engine.dispatch_module_action("a", "bump", Value::Null).unwrap();
    assert_eq!(calls(&log), vec![(2, "bump".into()), (1, "changed".into())]);
}

#[test]
fn subscriptions_per_module_are_bounded_and_idempotent() {
    let (mut engine, log) = engine_with(vec![
        spec("a", &["flood", "again", "changed"]).grants(&["b"], &[]).reducer(|call| {
            let count = if call.action == "flood" { MAX_SUBSCRIPTIONS_PER_MODULE + 44 } else { 3 };
            Ok(match call.action.as_str() {
                "flood" | "again" => ReducerOutput {
                    subscribe_requests: (0..count)
                        .map(|i| subscribe("b", &format!("p{i}"), "changed"))
                        .collect(),
                    ..Default::default()
                },
                _ => ReducerOutput::default(),
            })
        }),
        spec("b", &["set"]).reducer(|_| Ok(with_state(json!({ "p0": 1, "p300": 1, "p299": 1 })))),
    ]);
    let message = module_error(engine.dispatch_module_action("a", "flood", Value::Null));
    assert!(message.contains("44 failure(s)"), "{message}");
    assert!(message.contains("subscription limit (256)"), "{message}");
    // Re-subscribing to paths already held replaces them: no growth, no error.
    engine.dispatch_module_action("a", "again", Value::Null).unwrap();

    // Only held paths fire, once each (p0 held; p299/p300 were refused).
    log.lock().unwrap().clear();
    engine.dispatch_module_action("b", "set", Value::Null).unwrap();
    assert_eq!(calls(&log), vec![(1, "set".into()), (0, "changed".into())]);
}

// ── D8: host state writes notify hosted subscribers ──────────────────────────

/// `w` subscribes to `paths` of `t` on `watch`; `t` is written only by the host
/// (`update_state` / `update_state_sparse`), never by a reducer.
fn host_written(paths: &'static [&'static str]) -> (Engine, Log) {
    let (mut engine, log) = engine_with(vec![
        spec("w", &["watch", "changed"]).grants(&["t"], &[]).reducer(move |call| {
            Ok(match call.action.as_str() {
                "watch" => ReducerOutput {
                    subscribe_requests: paths.iter().map(|p| subscribe("t", p, "changed")).collect(),
                    ..Default::default()
                },
                _ => ReducerOutput::default(),
            })
        }),
        spec("t", &["set"])
            .state(json!({ "user": { "name": "a", "age": 1 }, "items": [{ "t": 1 }], "n": 0 })),
    ]);
    engine.dispatch_module_action("w", "watch", Value::Null).unwrap();
    log.lock().unwrap().clear();
    (engine, log)
}

fn notified(log: &Log) -> usize {
    let n = calls(log).iter().filter(|(id, a)| *id == 0 && a == "changed").count();
    log.lock().unwrap().clear();
    n
}

#[test]
fn a_host_update_on_a_watched_path_notifies_the_subscriber_once() {
    let (mut engine, log) = host_written(&["n"]);
    engine.update_state(Some("T"), json!({ "n": 1 }));
    assert_eq!(calls(&log), vec![(0, "changed".into())]);
    // The subscriber saw the already-written state through its `reads` grant.
    assert_eq!(log.lock().unwrap()[0].siblings[0].1["n"], json!(1));
    assert_eq!(engine.get_module_state("t").unwrap()["n"], json!(1));
    log.lock().unwrap().clear();

    // A no-op write (same value) changes nothing and notifies nobody.
    engine.update_state(Some("t"), json!({ "n": 1 }));
    assert_eq!(notified(&log), 0);
}

#[test]
fn a_host_update_on_an_unrelated_path_does_not_notify() {
    let (mut engine, log) = host_written(&["n"]);
    engine.update_state(Some("t"), json!({ "user": { "name": "b" } }));
    engine.update_state_sparse(Some("t"), &["items.0.t".to_string()], &json!({ "items.0.t": 9 }));
    assert_eq!(engine.get_module_state("t").unwrap()["user"]["name"], json!("b"));
    assert_eq!(notified(&log), 0);
    // Writes to other scopes and to the primary slot never match either.
    engine.update_state(Some("w"), json!({ "n": 5 }));
    engine.update_state(None, json!({ "n": 5 }));
    assert_eq!(notified(&log), 0);
}

#[test]
fn a_sparse_host_update_notifies_the_subscriber() {
    let (mut engine, log) = host_written(&["user.name"]);
    engine.update_state_sparse(
        Some("t"),
        &["user.name".to_string(), "n".to_string()],
        &json!({ "user.name": "b", "n": 3 }),
    );
    assert_eq!(notified(&log), 1);
    // Only the listed paths count: a value under an unlisted key is ignored.
    engine.update_state_sparse(Some("t"), &["n".to_string()], &json!({ "n": 4, "user.name": "c" }));
    assert_eq!(notified(&log), 0);
    // Unchanged value: nothing.
    engine.update_state_sparse(Some("t"), &["user.name".to_string()], &json!({ "user.name": "b" }));
    assert_eq!(notified(&log), 0);
}

#[test]
fn host_updates_match_nested_and_overlapping_paths_like_the_fold() {
    // Watches: an ancestor of the written leaf, a descendant of a replaced
    // value, a sibling leaf, and an array element.
    let (mut engine, log) = host_written(&["user"]);
    engine.update_state(Some("t"), json!({ "user": { "age": 2 } }));
    assert_eq!(notified(&log), 1, "ancestor watch sees a descendant change");

    let (mut engine, log) = host_written(&["user.name"]);
    engine.update_state(Some("t"), json!({ "user": { "age": 2 } }));
    assert_eq!(notified(&log), 0, "sibling leaf: the merge keeps user.name");
    engine.update_state_sparse(Some("t"), &["user".to_string()], &json!({ "user": { "name": "z" } }));
    assert_eq!(notified(&log), 1, "a write at an ancestor that changes the leaf");

    let (mut engine, log) = host_written(&["items.0.t"]);
    engine.update_state(Some("t"), json!({ "items": [{ "t": 1 }, { "t": 2 }] }));
    assert_eq!(notified(&log), 0, "an appended element leaves items.0 alone");
    engine.update_state(Some("t"), json!({ "items": [] }));
    assert_eq!(notified(&log), 1, "a shrunk array reports the array itself");

    let (mut engine, log) = host_written(&[""]);
    engine.update_state(Some("t"), json!({ "brand_new": true }));
    assert_eq!(notified(&log), 1, "a whole-state watch sees any change");

    // Two held subscriptions that both match notify once each, as in a fold.
    let (mut engine, log) = host_written(&["user", "user.name"]);
    engine.update_state(Some("t"), json!({ "user": { "name": "q" } }));
    assert_eq!(notified(&log), 2);
}

#[test]
fn host_updates_without_subscriptions_never_call_the_host() {
    let (mut engine, log) = engine_with(vec![
        spec("a", &["x"]).grants(&["b"], &[]).reducer(counter()),
        spec("b", &["x"]).reducer(counter()),
    ]);
    engine.update_state(Some("b"), json!({ "n": 1 }));
    engine.update_state_sparse(Some("b"), &["n".to_string()], &json!({ "n": 2 }));
    engine.update_state(Some("a"), json!({ "n": 1 }));
    assert!(calls(&log).is_empty());
    assert_eq!(engine.get_module_state("b").unwrap()["n"], json!(2));
}

#[test]
fn a_reducer_fold_is_not_double_notified_and_host_writes_keep_cascade_rules() {
    // `t`'s reducer writes the watched path; the fold notifies, exactly once.
    let (mut engine, log) = engine_with(vec![
        spec("w", &["watch", "changed"]).grants(&["t"], &[]).reducer(|call| {
            Ok(match call.action.as_str() {
                "watch" => ReducerOutput {
                    subscribe_requests: vec![subscribe("t", "n", "changed")],
                    ..Default::default()
                },
                // The notification itself writes `w`'s state and fails a
                // follow-up: the host write still stands, the failure is
                // logged, not returned.
                _ => ReducerOutput {
                    emit: vec![action("missing")],
                    ..with_state(json!({ "seen": call.siblings[0].1["n"].clone() }))
                },
            })
        }),
        spec("t", &["bump"]).grants(&[], &[]).reducer(counter()),
    ]);
    engine.dispatch_module_action("w", "watch", Value::Null).unwrap();
    log.lock().unwrap().clear();

    let message = module_error(engine.dispatch_module_action("t", "bump", Value::Null));
    assert!(message.contains("missing"), "{message}");
    assert_eq!(calls(&log), vec![(1, "bump".into()), (0, "changed".into())]);
    log.lock().unwrap().clear();

    engine.update_state(Some("t"), json!({ "n": 10 }));
    assert_eq!(calls(&log), vec![(0, "changed".into())]);
    assert_eq!(engine.get_module_state("t").unwrap()["n"], json!(10));
    assert_eq!(engine.get_module_state("w").unwrap()["seen"], json!(10));

    // The engine is not left mid-cascade: a regular dispatch still runs.
    log.lock().unwrap().clear();
    engine.dispatch_module_action("t", "bump", Value::Null).unwrap_err();
    assert_eq!(calls(&log), vec![(1, "bump".into()), (0, "changed".into())]);
}
