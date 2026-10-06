//! `.onAnimationComplete` for EXIT animations (Option F, `{animation: "exit"}`).
//!
//! An exit plays AFTER the engine emitted `Remove { transition: true }` for
//! the subtree root, so the renderer's completion — a node-addressed
//! `__hypen_dispatch` envelope naming the exiting root's own id — arrives for
//! a node the engine no longer has. The engine leaves an *exit tombstone* for
//! exactly that root, and UI routing consults it so the completion reaches
//! the module that owned the node. Everything else about removed nodes stays
//! inert; most of this file pins that narrowness.

use hypen_engine::action_routing::{scoped_action_name, UI_ACTION};
use hypen_engine::dispatch::Action;
use hypen_engine::ir::{ast_to_ir_node, Component, IRNode};
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reconcile::{Patch, MAX_EXIT_TOMBSTONES};
use hypen_engine::Engine;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

type Calls = Arc<Mutex<Vec<(String, Option<Value>)>>>;
type Patches = Arc<Mutex<Vec<Patch>>>;

fn render(engine: &mut Engine, source: &str) {
    let doc = hypen_parser::parse_document(source).expect("parse");
    engine.render_ir_node(&ast_to_ir_node(doc.components.first().expect("component")));
}

/// A module component, the shape `ComponentRegistry::resolve` builds from a
/// discovered `module X { … }` file.
fn module_component(name: &str, source: &str) -> Component {
    let doc = hypen_parser::parse_document(source).expect("parse");
    let IRNode::Element(element) = ast_to_ir_node(doc.components.first().expect("component"))
    else {
        panic!("a component root is always an element");
    };
    let mut c = Component::new(name, move |_props| element.clone());
    c.is_module = true;
    c.module_name = Some(name.to_lowercase());
    c
}

/// Record every patch batch, and register a recording handler for each
/// `(scope, action)` the way an SDK registers scoped handlers.
fn harness(engine: &mut Engine, handlers: &[(&str, &str)]) -> (Calls, Patches) {
    let calls: Calls = Arc::default();
    for &(scope, name) in handlers {
        let calls = calls.clone();
        let tag = format!("{scope}:{name}");
        engine.on_action(scoped_action_name(scope, name), move |a| {
            calls.lock().unwrap().push((tag.clone(), a.payload.clone()));
        });
    }
    let patches: Patches = Arc::default();
    let sink = patches.clone();
    engine.set_render_callback(move |ps| sink.lock().unwrap().extend_from_slice(ps));
    (calls, patches)
}

fn envelope(node: &str, action: &str) -> Action {
    Action::new(UI_ACTION).with_payload(json!({
        "node": node,
        "action": action,
        "payload": { "animation": "exit" },
    }))
}

fn is_stale(result: Result<(), hypen_engine::EngineError>) -> bool {
    matches!(result, Err(e) if e.to_string().contains("stale UI action target"))
}

/// Ids of `Remove { transition: true }` roots, in emission order.
fn transition_roots(patches: &Patches) -> Vec<String> {
    patches
        .lock()
        .unwrap()
        .iter()
        .filter_map(|p| match p {
            Patch::Remove {
                id,
                transition: true,
            } => Some(id.to_string()),
            _ => None,
        })
        .collect()
}

/// Ids of plain `Remove`s, in emission order.
fn plain_removes(patches: &Patches) -> Vec<String> {
    patches
        .lock()
        .unwrap()
        .iter()
        .filter_map(|p| match p {
            Patch::Remove {
                id,
                transition: false,
            } => Some(id.to_string()),
            _ => None,
        })
        .collect()
}

fn created(patches: &Patches, element_type: &str) -> Vec<String> {
    patches
        .lock()
        .unwrap()
        .iter()
        .filter_map(|p| match p {
            Patch::Create {
                id,
                element_type: t,
                ..
            } if t == element_type => Some(id.to_string()),
            _ => None,
        })
        .collect()
}

const PRIMARY: &str = r#"
Column {
    If(@state.show) {
        Row {
            Text("bye").exit(fade).onAnimationComplete(@actions.done)
        }
            .exit(fade, duration: 200)
            .onAnimationComplete(@actions.done, source: "row")
    }
    If(@state.plain) {
        Stack { Text("no exit") }.onAnimationComplete(@actions.done)
    }
}
"#;

fn primary_engine() -> (Engine, Calls, Patches) {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(
        Module::new("App"),
        json!({ "show": true, "plain": true }),
    ));
    let (calls, patches) = harness(&mut engine, &[("", "done"), ("", "other")]);
    render(&mut engine, PRIMARY);
    (engine, calls, patches)
}

#[test]
fn exit_completion_on_a_removed_primary_root_routes_to_the_primary_module() {
    let (mut engine, calls, patches) = primary_engine();
    let row = created(&patches, "Row")[0].clone();
    patches.lock().unwrap().clear();

    engine.update_state(None, json!({ "show": false }));
    assert_eq!(transition_roots(&patches), vec![row.clone()]);

    engine.dispatch_action(envelope(&row, "done")).unwrap();
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, ":done");
    assert_eq!(calls[0].1, Some(json!({ "animation": "exit" })));
}

#[test]
fn only_the_exit_roots_own_completion_action_is_honoured() {
    let (mut engine, calls, patches) = primary_engine();
    let row = created(&patches, "Row")[0].clone();
    engine.update_state(None, json!({ "show": false }));

    // A different action — even one with a registered handler — is stale.
    assert!(is_stale(engine.dispatch_action(envelope(&row, "other"))));
    // Framework writes never ride a tombstone.
    for reserved in ["__hypen_bind", "__hypen_reorder", "__hypen_pin"] {
        assert!(engine.dispatch_action(envelope(&row, reserved)).is_err());
    }
    // A tombstone is never a `fromNode` (transfer source).
    let mut action = envelope(&row, "done");
    let live = created(&patches, "Column")[0].clone();
    action.payload.as_mut().unwrap()["node"] = json!(live);
    action.payload.as_mut().unwrap()["fromNode"] = json!(row);
    assert!(is_stale(engine.dispatch_action(action)));
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn plain_removals_and_descendants_of_the_exit_root_stay_inert() {
    let (mut engine, calls, patches) = primary_engine();
    let stack = created(&patches, "Stack")[0].clone();
    let texts = created(&patches, "Text");
    patches.lock().unwrap().clear();

    // The Stack carries `.onAnimationComplete` but no `.exit`: a plain Remove.
    engine.update_state(None, json!({ "plain": false }));
    assert!(transition_roots(&patches).is_empty());
    assert_eq!(plain_removes(&patches), vec![stack.clone()]);
    assert!(is_stale(engine.dispatch_action(envelope(&stack, "done"))));

    // The Row's Text has its own exit + completion, but parent-remove-wins:
    // only the Row is a transition root, so only the Row is tombstoned.
    patches.lock().unwrap().clear();
    engine.update_state(None, json!({ "show": false }));
    let descendant = &texts[0];
    assert!(plain_removes(&patches).contains(descendant));
    assert!(is_stale(
        engine.dispatch_action(envelope(descendant, "done"))
    ));
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn exit_completion_on_a_removed_nested_module_root_routes_to_that_module() {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(Module::new("App"), json!({})));
    engine.register_component(module_component(
        "Card",
        r#"
        module Card {
            Column {
                If(@state.open) {
                    Row { Text("card") }
                        .exit(fade)
                        .onAnimationComplete(@actions.done)
                }
            }
        }
        "#,
    ));
    engine.register_module(
        "card",
        ModuleInstance::new(Module::new("Card"), json!({ "open": true })),
    );
    // Both owners handle `done`: the scope decides, not the name.
    let (calls, patches) = harness(&mut engine, &[("", "done"), ("card", "done")]);
    render(&mut engine, r#"Column { Card() }"#);
    let row = created(&patches, "Row")[0].clone();
    patches.lock().unwrap().clear();

    engine.update_state(Some("card"), json!({ "open": false }));
    assert_eq!(transition_roots(&patches), vec![row.clone()]);

    engine.dispatch_action(envelope(&row, "done")).unwrap();
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .map(|c| c.0.as_str())
            .collect::<Vec<_>>(),
        vec!["card:done"]
    );

    // The agent surface gains nothing: envelopes are framework-reserved.
    assert!(engine.dispatch_external(envelope(&row, "done")).is_err());

    // Once the owning module is destroyed the completion is stale again.
    engine.unregister_module("card");
    assert!(is_stale(engine.dispatch_action(envelope(&row, "done"))));
    assert_eq!(calls.lock().unwrap().len(), 1);
}

#[test]
fn a_detached_router_cache_subtree_is_not_tombstoned() {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(
        Module::new("App"),
        json!({ "location": "/a" }),
    ));
    let (calls, patches) = harness(&mut engine, &[("", "done")]);
    render(
        &mut engine,
        r#"
        Column {
            Router {
                Route(path: "/a") {
                    Row { Text("a") }.exit(fade).onAnimationComplete(@actions.done)
                }
                Route(path: "/b") { Text("b") }
            }
        }
        "#,
    );
    let row = created(&patches, "Row")[0].clone();
    patches.lock().unwrap().clear();

    engine.update_state(None, json!({ "location": "/b" }));
    let detached = patches
        .lock()
        .unwrap()
        .iter()
        .any(|p| matches!(p, Patch::Detach { id } if **id == *row));
    assert!(detached, "route /a is cached, not removed");
    assert!(transition_roots(&patches).is_empty());
    assert!(is_stale(engine.dispatch_action(envelope(&row, "done"))));
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn the_tombstone_store_is_bounded_oldest_first() {
    let extra = 5;
    let items: Vec<Value> = (0..MAX_EXIT_TOMBSTONES + extra)
        .map(|i| json!({ "id": i }))
        .collect();
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(
        Module::new("App"),
        json!({ "items": items }),
    ));
    let (calls, patches) = harness(&mut engine, &[("", "done")]);
    render(
        &mut engine,
        r#"
        Column {
            ForEach(items: @state.items, key: "id") {
                Row { Text("@{item.id}") }.exit(fade).onAnimationComplete(@actions.done)
            }
        }
        "#,
    );
    patches.lock().unwrap().clear();

    engine.update_state(None, json!({ "items": [] }));
    let roots = transition_roots(&patches);
    assert_eq!(roots.len(), MAX_EXIT_TOMBSTONES + extra);

    for evicted in &roots[..extra] {
        assert!(is_stale(engine.dispatch_action(envelope(evicted, "done"))));
    }
    for kept in &roots[extra..] {
        engine.dispatch_action(envelope(kept, "done")).unwrap();
    }
    assert_eq!(calls.lock().unwrap().len(), MAX_EXIT_TOMBSTONES);
}

#[test]
fn a_new_primary_module_forgets_tombstones() {
    let (mut engine, calls, patches) = primary_engine();
    let row = created(&patches, "Row")[0].clone();
    engine.update_state(None, json!({ "show": false }));

    engine.set_module(ModuleInstance::new(Module::new("App"), json!({})));
    assert!(is_stale(engine.dispatch_action(envelope(&row, "done"))));

    assert!(calls.lock().unwrap().is_empty());
}
