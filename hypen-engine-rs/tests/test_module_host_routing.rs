//! Engine-side module-host routing, driven with a mock [`ModuleHost`] so it
//! runs under default features (no wasmtime).
//!
//! Covers how `Engine::dispatch_action` layers module routing on top of the
//! UI action envelope (`__hypen_dispatch` → `__hypen_scoped:<scope>:<name>`):
//! envelopes resolve by node ownership and then reach the owning module
//! instance, the legacy `scope:action` / bare-name forms still work, and
//! closure handlers are unaffected by an installed host.

use hypen_engine::dispatch::Action;
use hypen_engine::ir::{Element, IRNode, Props, Value};
use hypen_engine::module_host::{
    HostAction, HostError, ModuleHost, ModuleInstanceId, ModuleManifest, ReducerOutput,
    SiblingState,
};
use hypen_engine::reactive::Binding;
use hypen_engine::{Engine, EngineError, Patch};
use indexmap::indexmap;
use serde_json::json;
use std::sync::{Arc, Mutex};

/// A reducer host where every instance is a counter: `increment` adds the
/// instance's step to `count`. Records `(instance, action)` for each dispatch.
struct CounterHost {
    steps: Vec<i64>,
    calls: Arc<Mutex<Vec<(u64, String)>>>,
}

impl ModuleHost for CounterHost {
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
        Ok(b"{\"count\":0}".to_vec())
    }
    fn dispatch(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        action: HostAction,
        _: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        self.calls.lock().unwrap().push((id.0, action.name.clone()));
        let mut state: serde_json::Value = serde_json::from_slice(state).unwrap();
        let count = state["count"].as_i64().unwrap_or(0);
        state["count"] = json!(count + self.steps[id.0 as usize]);
        Ok(ReducerOutput {
            state: Some(serde_json::to_vec(&state).unwrap()),
            ..Default::default()
        })
    }
    fn on_activated(
        &mut self,
        _: ModuleInstanceId,
        _: &[u8],
        _: &[SiblingState],
    ) -> Result<ReducerOutput, HostError> {
        Ok(ReducerOutput::default())
    }
    fn on_deactivated(&mut self, _: ModuleInstanceId, _: &[u8]) -> Result<ReducerOutput, HostError> {
        Ok(ReducerOutput::default())
    }
    fn on_destroyed(&mut self, _: ModuleInstanceId, _: &[u8]) -> Result<(), HostError> {
        Ok(())
    }
    fn actions(&mut self, _: ModuleInstanceId) -> Result<Vec<String>, HostError> {
        Ok(vec!["increment".into()])
    }
}

fn scoped_text(scope: &str) -> Element {
    Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "text".to_string() => Value::Binding(Binding::state(vec!["count".to_string()]))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: Some(scope.to_string()),
        semantics: None,
        span: None,
        expr_span: None,
    }
}

/// Two module instances (`a` steps by 1, `b` by 10) that both export
/// `increment`, each owning one rendered Text. Returns the engine, the host
/// call log, and the wire ids of `a`'s and `b`'s Text nodes.
fn two_counters() -> (Engine, Arc<Mutex<Vec<(u64, String)>>>, String, String) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mut engine = Engine::new();
    engine.set_module_host(Box::new(CounterHost {
        steps: vec![1, 10],
        calls: Arc::clone(&calls),
    }));
    for (i, scope) in ["a", "b"].into_iter().enumerate() {
        engine.register_module_instance(
            scope,
            ModuleInstanceId(i as u64),
            vec!["increment".to_string()],
            json!({ "count": 0 }),
        );
    }

    let created = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&created);
    engine.set_render_callback(move |patches: &[Patch]| {
        for p in patches {
            if let Patch::Create {
                id, element_type, ..
            } = p
            {
                if element_type == "Text" {
                    sink.lock().unwrap().push(id.to_string());
                }
            }
        }
    });
    engine.render(&Element {
        element_type: "Column".to_string(),
        props: Props::new(),
        ir_children: vec![
            IRNode::Element(scoped_text("a")),
            IRNode::Element(scoped_text("b")),
        ],
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    });
    let ids = created.lock().unwrap().clone();
    assert_eq!(ids.len(), 2, "expected two Text nodes, got {ids:?}");
    (engine, calls, ids[0].clone(), ids[1].clone())
}

fn envelope(node: &str, action: &str) -> Action {
    Action::new("__hypen_dispatch").with_payload(json!({ "node": node, "action": action }))
}

fn count(engine: &Engine, scope: &str) -> i64 {
    engine.get_module_state(scope).unwrap()["count"].as_i64().unwrap()
}

#[test]
fn ui_envelope_routes_to_the_module_owning_the_node() {
    let (mut engine, calls, node_a, node_b) = two_counters();

    engine.dispatch_action(envelope(&node_b, "increment")).unwrap();
    assert_eq!((count(&engine, "a"), count(&engine, "b")), (0, 10));

    engine.dispatch_action(envelope(&node_a, "increment")).unwrap();
    assert_eq!((count(&engine, "a"), count(&engine, "b")), (1, 10));

    // The module sees the bare action name, never the scoped wire name.
    assert_eq!(
        *calls.lock().unwrap(),
        vec![(1, "increment".to_string()), (0, "increment".to_string())]
    );
}

#[test]
fn ui_envelope_for_an_action_the_module_does_not_export_fails_closed() {
    let (mut engine, calls, node_a, _) = two_counters();
    let err = engine.dispatch_action(envelope(&node_a, "reset")).unwrap_err();
    assert!(matches!(err, EngineError::ActionNotFound(_)), "{err}");
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn qualified_sender_and_bare_names_still_route() {
    let (mut engine, _, node_a, _) = two_counters();

    // Explicit `scope:action` qualifier (REPL / HTTP API).
    engine.dispatch_action(Action::new("b:increment")).unwrap();
    assert_eq!(count(&engine, "b"), 10);

    // Sender node id (the reference runtime's web client).
    engine
        .dispatch_action(Action::new("increment").with_sender(node_a))
        .unwrap();
    assert_eq!(count(&engine, "a"), 1);

    // A bare name two scopes export is ambiguous, and drives neither.
    let err = engine.dispatch_action(Action::new("increment")).unwrap_err();
    assert!(matches!(err, EngineError::ModuleError(_)), "{err}");
    assert_eq!((count(&engine, "a"), count(&engine, "b")), (1, 10));
}

#[test]
fn closure_handlers_are_unaffected_by_a_module_host() {
    let (mut engine, calls, _, _) = two_counters();
    let hits = Arc::new(Mutex::new(0));
    let sink = Arc::clone(&hits);
    engine.on_action("ping", move |_| *sink.lock().unwrap() += 1);

    engine.dispatch_action(Action::new("ping")).unwrap();
    assert_eq!(*hits.lock().unwrap(), 1);
    assert!(calls.lock().unwrap().is_empty());

    let err = engine.dispatch_action(Action::new("nope")).unwrap_err();
    assert!(matches!(err, EngineError::ActionNotFound(_)), "{err}");
}

#[test]
fn rewiring_a_scope_drops_the_actions_it_no_longer_exports() {
    let (mut engine, calls, node_a, _) = two_counters();
    engine.rewire_module_instance("a", ModuleInstanceId(0), vec!["bump".to_string()]);

    // `increment` is no longer `a`'s: the envelope fails closed instead of
    // reaching the instance through a stale scoped-handler record.
    let err = engine
        .dispatch_action(envelope(&node_a, "increment"))
        .unwrap_err();
    assert!(matches!(err, EngineError::ActionNotFound(_)), "{err}");
    assert!(calls.lock().unwrap().is_empty());

    engine.dispatch_action(envelope(&node_a, "bump")).unwrap();
    assert_eq!(*calls.lock().unwrap(), vec![(0, "bump".to_string())]);
}
