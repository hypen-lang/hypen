//! The app's private-action marker and the external `sender` stamp.
//!
//! Two small guarantees the guard makes on top of the declaration rule:
//!
//! - `_name` is the app's own escape hatch from expose-all. It still fires
//!   from the rendered tree; it is never listed to, or dispatchable by, an
//!   external caller. `__name` stays the framework's floor underneath it.
//! - Every dispatch that comes through the guard carries
//!   `sender == "external"`, so a handler can tell an agent from a click.

use std::sync::{Arc, Mutex};

use hypen_engine::agent::EXTERNAL_SENDER;
use hypen_engine::dispatch::Action;
use hypen_engine::ir::ast_to_ir_node;
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::Engine;
use serde_json::json;

fn render(engine: &mut Engine, source: &str) {
    let doc = hypen_parser::parse_document(source).expect("parse");
    engine.render_ir_node(&ast_to_ir_node(doc.components.first().expect("component")));
}

/// Render, install the primary module, record every dispatch's sender.
fn app(actions: &[&str]) -> (Engine, Arc<Mutex<Vec<(String, Option<String>)>>>) {
    let mut engine = Engine::new();
    render(
        &mut engine,
        r#"
        module Account {
            Column {
                Text("@{state.email}")
                Button("@actions.save") { Text("Save") }
                Button("@actions._deleteAccount") { Text("Delete") }
            }
        }
        "#,
    );
    let module =
        Module::new("Account").with_actions(actions.iter().map(|a| a.to_string()).collect());
    engine.set_module(ModuleInstance::new(module, json!({ "email": "a@b.c" })));

    let seen: Arc<Mutex<Vec<(String, Option<String>)>>> = Arc::new(Mutex::new(Vec::new()));
    for a in actions {
        let seen = Arc::clone(&seen);
        engine.on_action(a.to_string(), move |action: &Action| {
            seen.lock()
                .unwrap()
                .push((action.name.clone(), action.sender.clone()));
        });
    }
    (engine, seen)
}

#[test]
fn a_private_action_is_not_listed() {
    let (engine, _) = app(&["save", "_deleteAccount"]);
    let names: Vec<String> = engine.list_actions().into_iter().map(|a| a.name).collect();
    assert!(names.contains(&"save".to_string()), "got {names:?}");
    assert!(
        !names.iter().any(|n| n.starts_with('_')),
        "a `_`-prefixed action must never be advertised: {names:?}"
    );
    // The manifest reads the same listing, so it agrees.
    let manifest = engine.mcp_manifest();
    assert!(
        !manifest.tools.iter().any(|t| t.name.contains("deleteAccount")),
        "manifest leaked the private action"
    );
}

#[test]
fn a_private_action_is_refused_externally_but_still_dispatches_from_the_tree() {
    let (mut engine, seen) = app(&["save", "_deleteAccount"]);

    // External: refused, and the handler never ran.
    assert!(engine
        .dispatch_external(Action::new("_deleteAccount"))
        .is_err());
    assert!(seen.lock().unwrap().is_empty());

    // The renderer's path is untouched: a click on the button still works.
    engine.dispatch_action(Action::new("_deleteAccount")).unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(seen.lock().unwrap()[0].1, None, "a click carries no sender");
}

#[test]
fn the_framework_floor_is_still_underneath_the_private_marker() {
    let (mut engine, _) = app(&["save", "__hypen_bind"]);
    // Declaring the framework's own name as a module action changes nothing:
    // it is reserved before it is private, and it is refused either way.
    assert!(engine
        .dispatch_external(Action::new("__hypen_bind").with_payload(json!({"path":"email","value":"x"})))
        .is_err());
    assert!(!engine.list_actions().iter().any(|a| a.name == "__hypen_bind"));
}

#[test]
fn an_external_dispatch_is_stamped_with_its_provenance() {
    let (mut engine, seen) = app(&["save"]);

    engine.dispatch_external(Action::new("save")).unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, "save");
    assert_eq!(
        seen[0].1.as_deref(),
        Some(EXTERNAL_SENDER),
        "a guarded dispatch must announce itself to the handler"
    );
}

#[test]
fn a_transport_may_be_more_specific_about_the_sender() {
    let (mut engine, seen) = app(&["save"]);
    engine
        .dispatch_external(Action::new("save").with_sender("external:mcp"))
        .unwrap();
    assert_eq!(seen.lock().unwrap()[0].1.as_deref(), Some("external:mcp"));
}
