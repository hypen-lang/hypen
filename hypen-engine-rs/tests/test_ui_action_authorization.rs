//! Authorization of client-originated UI actions.
//!
//! In Remote UI the renderer is an untrusted client. An action it sends must
//! resolve through a live node that actually carries that action binding;
//! knowing (or guessing) a handler's name is not authority to run it.

use hypen_engine::action_routing::{scoped_action_name, UI_ACTION};
use hypen_engine::dispatch::Action;
use hypen_engine::ir::{ast_to_ir_node, Component, IRNode};
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reconcile::Patch;
use hypen_engine::Engine;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

type Calls = Arc<Mutex<Vec<String>>>;
type Patches = Arc<Mutex<Vec<Patch>>>;

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

/// App (primary) shows a `save` button always and a `wipe` button only to
/// admins; the nested `Billing` module shows a `refund` button. Handlers are
/// registered the way every SDK registers them: under scoped names.
fn app(is_admin: bool) -> (Engine, Calls, Patches) {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(
        Module::new("App"),
        json!({ "isAdmin": is_admin }),
    ));
    engine.register_module(
        "billing",
        ModuleInstance::new(Module::new("billing"), json!({})),
    );
    engine.register_component(module_component(
        "Billing",
        r#"Column { Button(@actions.refund) { Text("Refund") } }"#,
    ));
    let calls: Calls = Arc::default();
    for (scope, name) in [("", "save"), ("", "wipe"), ("billing", "refund")] {
        let calls = calls.clone();
        engine.on_action(scoped_action_name(scope, name), move |_| {
            calls.lock().unwrap().push(format!("{scope}:{name}"));
        });
    }
    let patches: Patches = Arc::default();
    let sink = patches.clone();
    engine.set_render_callback(move |ps| sink.lock().unwrap().extend_from_slice(ps));
    let doc = hypen_parser::parse_document(
        r#"Column {
            Button(@actions.save) { Text("Save") }
            If(@state.isAdmin) { Button(@actions.wipe) { Text("Wipe") } }
            Billing()
        }"#,
    )
    .expect("parse");
    engine.render_ir_node(&ast_to_ir_node(&doc.components[0]));
    (engine, calls, patches)
}

/// Id of the created node carrying `@<action>` as its `action` prop.
fn node_with_action(patches: &Patches, action: &str) -> Option<String> {
    let want = Value::String(format!("@{action}"));
    patches.lock().unwrap().iter().find_map(|p| match p {
        Patch::Create { id, props, .. } if props.get("action") == Some(&want) => {
            Some(id.to_string())
        }
        _ => None,
    })
}

fn envelope(node: &str, action: &str) -> Action {
    Action::new(UI_ACTION).with_payload(json!({ "node": node, "action": action, "payload": {} }))
}

#[test]
fn a_rendered_binding_dispatches() {
    let (mut engine, calls, patches) = app(false);
    let save = node_with_action(&patches, "save").expect("save button rendered");
    let refund = node_with_action(&patches, "refund").expect("refund button rendered");
    engine.dispatch_ui_action(envelope(&save, "save")).unwrap();
    engine
        .dispatch_ui_action(envelope(&refund, "refund"))
        .unwrap();
    assert_eq!(*calls.lock().unwrap(), vec![":save", "billing:refund"]);
}

#[test]
fn a_raw_scoped_name_is_not_ui_authority() {
    let (mut engine, calls, patches) = app(false);
    assert!(
        node_with_action(&patches, "wipe").is_none(),
        "hidden for non-admins"
    );
    // Even a rendered action: the scoped form is host-internal.
    for name in [
        scoped_action_name("", "wipe"),
        scoped_action_name("billing", "refund"),
        scoped_action_name("", "save"),
    ] {
        assert!(
            engine
                .dispatch_ui_action(Action::new(name.clone()))
                .is_err(),
            "{name} accepted from a client"
        );
        // Nor smuggled inside an envelope.
        let save = node_with_action(&patches, "save").unwrap();
        assert!(engine.dispatch_ui_action(envelope(&save, &name)).is_err());
    }
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn a_bare_name_needs_a_rendered_binding() {
    let (mut engine, calls, _) = app(false);
    assert!(engine.dispatch_ui_action(Action::new("wipe")).is_err());
    assert!(engine.dispatch_ui_action(Action::new("nope")).is_err());
    assert!(calls.lock().unwrap().is_empty());
    // Legacy renderers send bare names; a rendered one resolves to its owner.
    engine.dispatch_ui_action(Action::new("save")).unwrap();
    engine.dispatch_ui_action(Action::new("refund")).unwrap();
    assert_eq!(*calls.lock().unwrap(), vec![":save", "billing:refund"]);
}

#[test]
fn framework_writes_are_never_reachable_by_name() {
    let (mut engine, _, _) = app(false);
    let written: Calls = Arc::default();
    for scope in ["", "billing"] {
        let written = written.clone();
        engine.on_action(scoped_action_name(scope, "__hypen_bind"), move |_| {
            written.lock().unwrap().push(scope.into());
        });
    }
    let write = json!({ "path": "isAdmin", "value": true });
    for name in [
        "__hypen_bind".to_string(),
        scoped_action_name("", "__hypen_bind"),
        scoped_action_name("billing", "__hypen_bind"),
    ] {
        let action = Action::new(name.clone()).with_payload(write.clone());
        assert!(engine.dispatch_ui_action(action).is_err(), "{name}");
    }
    assert!(written.lock().unwrap().is_empty());
}

#[test]
fn rendered_text_cannot_mint_a_binding() {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(
        Module::new("App"),
        json!({ "message": "@wipe" }),
    ));
    let calls: Calls = Arc::default();
    let sink = calls.clone();
    engine.on_action(scoped_action_name("", "wipe"), move |_| {
        sink.lock().unwrap().push("wipe".into())
    });
    let patches: Patches = Arc::default();
    let sink = patches.clone();
    engine.set_render_callback(move |ps| sink.lock().unwrap().extend_from_slice(ps));
    let doc =
        hypen_parser::parse_document(r#"Column { Text("@{state.message}") }"#).expect("parse");
    engine.render_ir_node(&ast_to_ir_node(&doc.components[0]));
    let text = patches
        .lock()
        .unwrap()
        .iter()
        .find_map(|p| match p {
            Patch::Create {
                id, element_type, ..
            } if &**element_type == "Text" => Some(id.to_string()),
            _ => None,
        })
        .expect("text rendered");
    assert!(engine.dispatch_ui_action(envelope(&text, "wipe")).is_err());
    assert!(engine.dispatch_ui_action(Action::new("wipe")).is_err());
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn applicator_and_argument_bindings_count() {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(Module::new("App"), json!({})));
    let calls: Calls = Arc::default();
    for name in ["tap", "drop", "pick"] {
        let sink = calls.clone();
        engine.on_action(scoped_action_name("", name), move |_| {
            sink.lock().unwrap().push(name.into())
        });
    }
    let doc = hypen_parser::parse_document(
        r#"Column {
            Text("a").onClick(@actions.tap, id: 5)
            Row { Text("Trash") }.dropZone(group: "cards", id: "trash").onDrop(@actions.drop)
            Menu(items: [{ label: "Pick", action: @actions.pick }])
        }"#,
    )
    .expect("parse");
    engine.render_ir_node(&ast_to_ir_node(&doc.components[0]));
    for name in ["tap", "drop", "pick"] {
        engine.dispatch_ui_action(Action::new(name)).unwrap();
    }
    assert_eq!(*calls.lock().unwrap(), vec!["tap", "drop", "pick"]);
}

#[test]
fn an_envelope_needs_a_node_that_carries_the_action() {
    let (mut engine, calls, patches) = app(false);
    let save = node_with_action(&patches, "save").unwrap();
    let refund = node_with_action(&patches, "refund").unwrap();
    // A live node of the right module, but `wipe` is bound nowhere on screen.
    assert!(engine.dispatch_ui_action(envelope(&save, "wipe")).is_err());
    // The trusted entry point authorises envelopes the same way.
    assert!(engine.dispatch_action(envelope(&save, "wipe")).is_err());
    // A node in another module's subtree.
    assert!(engine
        .dispatch_ui_action(envelope(&refund, "save"))
        .is_err());
    assert!(engine
        .dispatch_ui_action(envelope(&save, "refund"))
        .is_err());
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn the_binding_becomes_dispatchable_once_rendered() {
    let (mut engine, calls, patches) = app(true);
    let wipe = node_with_action(&patches, "wipe").expect("admins see it");
    engine.dispatch_ui_action(envelope(&wipe, "wipe")).unwrap();
    engine.update_state(None, json!({ "isAdmin": false }));
    assert!(engine.dispatch_ui_action(envelope(&wipe, "wipe")).is_err());
    assert_eq!(*calls.lock().unwrap(), vec![":wipe"]);
}

#[test]
fn trusted_host_dispatch_still_reaches_any_handler() {
    let (mut engine, calls, _) = app(false);
    engine
        .dispatch_action(Action::new(scoped_action_name("", "wipe")))
        .unwrap();
    engine.dispatch_action(Action::new("refund")).unwrap();
    assert_eq!(*calls.lock().unwrap(), vec![":wipe", "billing:refund"]);
}
