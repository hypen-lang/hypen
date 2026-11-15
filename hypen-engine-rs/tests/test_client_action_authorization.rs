//! Who may trigger an action: the two engine entries side by side.
//!
//! `Engine::dispatch_action` is the **same-trust-domain** entry (an in-process
//! renderer, host code replaying a resolved action). It accepts three inbound
//! forms and authorises none of them against the rendered tree beyond node
//! *ownership* — the `legacy_entry_*` tests pin exactly what that lets
//! through, because every one of them is a hole the moment the caller is a
//! Remote UI client on someone else's device.
//!
//! `Engine::dispatch_client_action` / `resolve_client_action` is the entry for
//! input that crossed a trust boundary. The `client_entry_*` tests are the
//! same scenarios, refused: only a `__hypen_dispatch` envelope whose live,
//! attached node itself carries the action binding gets through.

use hypen_engine::action_routing::{scoped_action_name, UI_ACTION};
use hypen_engine::dispatch::Action;
use hypen_engine::ir::{ast_to_ir_node, Component, IRNode};
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reconcile::Patch;
use hypen_engine::{Engine, EngineError};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

type Calls = Arc<Mutex<Vec<(String, Option<Value>)>>>;
type Patches = Arc<Mutex<Vec<Patch>>>;

fn render(engine: &mut Engine, source: &str) {
    let doc = hypen_parser::parse_document(source).expect("parse");
    engine.render_ir_node(&ast_to_ir_node(doc.components.first().expect("component")));
}

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

/// Register a recording handler per `(scope, action)`, the way an SDK does.
fn handlers(engine: &mut Engine, calls: &Calls, list: &[(&str, &str)]) {
    for &(scope, name) in list {
        let calls = calls.clone();
        let tag = format!("{scope}:{name}");
        engine.on_action(scoped_action_name(scope, name), move |a| {
            calls.lock().unwrap().push((tag.clone(), a.payload.clone()));
        });
    }
}

fn envelope(node: &str, action: &str, payload: Value) -> Action {
    Action::new(UI_ACTION).with_payload(json!({
        "node": node,
        "action": action,
        "payload": payload,
    }))
}

/// Wire id of the first created node of `element_type` whose props mention
/// `needle` (a label, a placeholder…).
fn node(patches: &Patches, element_type: &str, needle: &str) -> String {
    patches
        .lock()
        .unwrap()
        .iter()
        .find_map(|p| match p {
            Patch::Create {
                id,
                element_type: t,
                props,
                ..
            } if t == element_type
                && serde_json::to_string(&**props)
                    .unwrap_or_default()
                    .contains(needle) =>
            {
                Some(id.to_string())
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("no {element_type} mentioning {needle:?} was created"))
}

fn has_node(patches: &Patches, element_type: &str, needle: &str) -> bool {
    patches.lock().unwrap().iter().any(|p| {
        matches!(p, Patch::Create { element_type: t, props, .. }
            if t == element_type
                && serde_json::to_string(&**props).unwrap_or_default().contains(needle))
    })
}

fn tags(calls: &Calls) -> Vec<String> {
    calls.lock().unwrap().iter().map(|c| c.0.clone()).collect()
}

fn refused(result: Result<(), EngineError>) -> bool {
    matches!(result, Err(EngineError::ActionNotFound(_)))
}

const APP: &str = r#"
Column {
    Button("Save").onClick(@actions.save)
    Input(placeholder: "Name").bind(@state.name)
    Text("Hello @{state.name}")
    If(@state.isAdmin) {
        Button("Wipe").onClick(@actions.wipe)
    }
    Card()
    Router {
        Route(path: "/a") { Button("OnlyA").onClick(@actions.onlyA) }
        Route(path: "/b") { Text("b") }
    }
}
"#;

const CARD: &str = r#"
module Card {
    Column {
        Button("Open").onClick(@actions.open)
    }
}
"#;

/// A primary module and a nested `Card` module.
///
/// - `save`, `open` are bound on live nodes;
/// - `wipe` is bound only inside `If(@state.isAdmin)` — not rendered;
/// - `onlyA` is bound only on route `/a`;
/// - `purge` (card) and `audit` (primary) are registered handlers that no
///   node binds at all.
fn app() -> (Engine, Calls, Patches) {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(
        Module::new("App"),
        json!({ "location": "/a", "isAdmin": false, "name": "" }),
    ));
    engine.register_component(module_component("Card", CARD));
    engine.register_module("card", ModuleInstance::new(Module::new("Card"), json!({})));
    let calls: Calls = Arc::default();
    handlers(
        &mut engine,
        &calls,
        &[
            ("", "save"),
            ("", "wipe"),
            ("", "onlyA"),
            ("", "audit"),
            ("", "__hypen_bind"),
            ("card", "open"),
            ("card", "purge"),
            ("card", "__hypen_bind"),
        ],
    );
    let patches: Patches = Arc::default();
    let sink = patches.clone();
    engine.set_render_callback(move |ps| sink.lock().unwrap().extend_from_slice(ps));
    render(&mut engine, APP);
    (engine, calls, patches)
}

/// A single-module app: the shape where a bare reserved name is unambiguous.
fn single() -> (Engine, Calls, Patches) {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(
        Module::new("App"),
        json!({ "isAdmin": false, "name": "", "rows": [{ "id": 1, "label": "@wipe" }] }),
    ));
    let calls: Calls = Arc::default();
    handlers(
        &mut engine,
        &calls,
        &[("", "save"), ("", "wipe"), ("", "__hypen_bind")],
    );
    let patches: Patches = Arc::default();
    let sink = patches.clone();
    engine.set_render_callback(move |ps| sink.lock().unwrap().extend_from_slice(ps));
    render(
        &mut engine,
        r#"
        Column {
            Button("Save").onClick(@actions.save)
            Input(placeholder: "Name").bind(@state.name)
            Text("@{state.name}")
            ForEach(items: @state.rows, key: "id") {
                Text(@item.label)
            }
        }
        "#,
    );
    (engine, calls, patches)
}

// ── The same-trust-domain entry: what `dispatch_action` lets through ───────

#[test]
fn legacy_entry_dispatches_a_raw_scoped_name_no_node_binds() {
    let (mut engine, calls, _) = app();
    // `purge` is registered by Card and bound nowhere; `wipe` is behind a
    // false `If`. A pre-scoped name reaches both with an arbitrary payload.
    engine
        .dispatch_action(
            Action::new(scoped_action_name("card", "purge")).with_payload(json!({ "all": true })),
        )
        .unwrap();
    engine
        .dispatch_action(Action::new(scoped_action_name("", "wipe")))
        .unwrap();
    assert_eq!(tags(&calls), vec!["card:purge", ":wipe"]);
    assert_eq!(calls.lock().unwrap()[0].1, Some(json!({ "all": true })));
}

#[test]
fn legacy_entry_dispatches_a_bare_name_one_scope_handles() {
    let (mut engine, calls, patches) = app();
    assert!(
        !has_node(&patches, "Button", "Wipe"),
        "never rendered for this session"
    );
    engine.dispatch_action(Action::new("wipe")).unwrap();
    engine.dispatch_action(Action::new("purge")).unwrap();
    assert_eq!(tags(&calls), vec![":wipe", "card:purge"]);
}

#[test]
fn legacy_entry_takes_a_bare_reserved_write_in_a_single_module_app() {
    let (mut engine, calls, _) = single();
    // No node, no `.bind` declaration consulted: the SDK's bind handler is
    // handed a path the template never made writable.
    engine
        .dispatch_action(
            Action::new("__hypen_bind").with_payload(json!({ "path": "isAdmin", "value": true })),
        )
        .unwrap();
    assert_eq!(
        *calls.lock().unwrap(),
        vec![(
            ":__hypen_bind".to_string(),
            Some(json!({ "path": "isAdmin", "value": true }))
        )]
    );
}

#[test]
fn legacy_entry_envelope_checks_ownership_not_the_binding() {
    let (mut engine, calls, patches) = app();
    let save = node(&patches, "Button", "Save");
    let open = node(&patches, "Button", "Open");
    // Any live node of a scope names any handler of that scope.
    engine
        .dispatch_action(envelope(&save, "wipe", json!({})))
        .unwrap();
    engine
        .dispatch_action(envelope(&save, "audit", json!({})))
        .unwrap();
    engine
        .dispatch_action(envelope(&open, "purge", json!({})))
        .unwrap();
    assert_eq!(tags(&calls), vec![":wipe", ":audit", "card:purge"]);
    // What it does hold: the scope comes from the node, never the name.
    assert!(refused(engine.dispatch_action(envelope(
        &save,
        "purge",
        json!({})
    ))));
    assert!(refused(engine.dispatch_action(envelope(
        &open,
        "save",
        json!({})
    ))));
}

#[test]
fn legacy_entry_reaches_a_detached_routes_action_by_name_but_not_by_node() {
    let (mut engine, calls, patches) = app();
    let only_a = node(&patches, "Button", "OnlyA");
    engine.update_state(None, json!({ "location": "/b" }));
    assert!(patches
        .lock()
        .unwrap()
        .iter()
        .any(|p| matches!(p, Patch::Detach { .. })));
    // The envelope is inert on the cached subtree…
    assert!(refused(engine.dispatch_action(envelope(
        &only_a,
        "onlyA",
        json!({})
    ))));
    // …the bare and pre-scoped names are not.
    engine.dispatch_action(Action::new("onlyA")).unwrap();
    engine
        .dispatch_action(Action::new(scoped_action_name("", "onlyA")))
        .unwrap();
    assert_eq!(tags(&calls), vec![":onlyA", ":onlyA"]);
}

// ── The client entry ──────────────────────────────────────────────────────

#[test]
fn client_entry_dispatches_an_action_bound_on_the_live_node() {
    let (mut engine, calls, patches) = app();
    let save = node(&patches, "Button", "Save");
    let open = node(&patches, "Button", "Open");
    engine
        .dispatch_client_action(envelope(&save, "save", json!({ "n": 1 })))
        .unwrap();
    engine
        .dispatch_client_action(envelope(&open, "open", json!({})))
        .unwrap();
    assert_eq!(tags(&calls), vec![":save", "card:open"]);
    assert_eq!(calls.lock().unwrap()[0].1, Some(json!({ "n": 1 })));

    // The resolved action is ordinary trusted input for `dispatch_action`
    // (how a server replays one client's action into other sessions).
    let resolved = engine
        .resolve_client_action(envelope(&open, "open", json!({})))
        .unwrap();
    assert_eq!(resolved.name, scoped_action_name("card", "open"));
    assert_eq!(resolved.sender.as_deref(), Some(open.as_str()));
    engine.dispatch_action(resolved).unwrap();
    assert_eq!(calls.lock().unwrap().len(), 3);
}

#[test]
fn client_entry_refuses_scoped_and_bare_names_even_for_bound_actions() {
    let (mut engine, calls, _) = app();
    for name in [
        "save".to_string(),
        "wipe".to_string(),
        "purge".to_string(),
        scoped_action_name("", "save"),
        scoped_action_name("card", "open"),
        scoped_action_name("card", "purge"),
        "__hypen_bind".to_string(),
        "router.push".to_string(),
    ] {
        let action = Action::new(name.clone()).with_payload(json!({ "path": "name", "to": "/b" }));
        assert!(
            refused(engine.dispatch_client_action(action.clone())),
            "{name}"
        );
        assert!(engine.resolve_client_action(action).is_err(), "{name}");
    }
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn client_entry_refuses_an_action_the_addressed_node_does_not_carry() {
    let (mut engine, calls, patches) = app();
    let save = node(&patches, "Button", "Save");
    let open = node(&patches, "Button", "Open");
    let column = node(&patches, "Column", "");
    for (target, action) in [
        (&save, "wipe"),   // bound only behind a false If
        (&save, "audit"),  // registered, bound nowhere
        (&save, "onlyA"),  // bound on another live node
        (&column, "save"), // an ancestor of the carrier is not the carrier
        (&open, "purge"),  // same for the nested module
        (&save, "open"),   // another module's action
        (&save, "purge"),
        (&open, "save"),
    ] {
        assert!(
            refused(engine.dispatch_client_action(envelope(target, action, json!({})))),
            "{action}"
        );
    }
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn client_entry_follows_the_rendered_tree() {
    let (mut engine, calls, patches) = app();
    let only_a = node(&patches, "Button", "OnlyA");

    // The admin button appears: its node now carries the binding.
    engine.update_state(None, json!({ "isAdmin": true }));
    let wipe = node(&patches, "Button", "Wipe");
    engine
        .dispatch_client_action(envelope(&wipe, "wipe", json!({})))
        .unwrap();
    // …and disappears again: the id is stale.
    engine.update_state(None, json!({ "isAdmin": false }));
    assert!(refused(engine.dispatch_client_action(envelope(
        &wipe,
        "wipe",
        json!({})
    ))));

    // A router-cached (detached) subtree is inert until it is re-attached.
    engine.update_state(None, json!({ "location": "/b" }));
    assert!(refused(engine.dispatch_client_action(envelope(
        &only_a,
        "onlyA",
        json!({})
    ))));
    engine.update_state(None, json!({ "location": "/a" }));
    engine
        .dispatch_client_action(envelope(&only_a, "onlyA", json!({})))
        .unwrap();
    assert_eq!(tags(&calls), vec![":wipe", ":onlyA"]);
}

#[test]
fn client_entry_authorises_reserved_writes_by_the_nodes_declaration() {
    let (mut engine, calls, patches) = single();
    let input = node(&patches, "Input", "Name");
    let save = node(&patches, "Button", "Save");

    engine
        .dispatch_client_action(envelope(
            &input,
            "__hypen_bind",
            json!({ "path": "name", "value": "x" }),
        ))
        .unwrap();
    assert_eq!(tags(&calls), vec![":__hypen_bind"]);

    for (target, action, payload) in [
        // a path the node did not declare
        (
            &input,
            "__hypen_bind",
            json!({ "path": "isAdmin", "value": true }),
        ),
        // a node with no `.bind`
        (
            &save,
            "__hypen_bind",
            json!({ "path": "name", "value": "x" }),
        ),
        (
            &input,
            "__hypen_reorder",
            json!({ "path": "name", "from": 0, "to": 1 }),
        ),
        (
            &input,
            "__hypen_pin",
            json!({ "path": "name.0", "x": 0, "y": 0 }),
        ),
        // not protocol: no other reserved name is a client action
        (&input, "__hypen_anything", json!({})),
        (&input, UI_ACTION, json!({})),
        (&input, "__hypen_scoped::save", json!({})),
    ] {
        assert!(
            refused(engine.dispatch_client_action(envelope(target, action, payload))),
            "{action}"
        );
    }
    assert_eq!(calls.lock().unwrap().len(), 1);
}

#[test]
fn client_entry_never_takes_rendered_data_for_a_binding() {
    let (mut engine, calls, patches) = single();
    // State a user controls, rendered as text that *looks* like a reference.
    engine.update_state(None, json!({ "name": "@actions.wipe" }));
    let text = node(&patches, "Text", "");
    // The row renders `@wipe` verbatim (a prototype-instantiated list row).
    let row = patches
        .lock()
        .unwrap()
        .iter()
        .find_map(|p| match p {
            Patch::Instantiate { nodes, subs, .. }
                if subs.iter().any(|s| s.2 == json!("@wipe")) =>
            {
                Some(nodes[0].to_string())
            }
            _ => None,
        })
        .expect("the row was instantiated with the item label");
    for target in [&text, &row] {
        assert!(refused(engine.dispatch_client_action(envelope(
            target,
            "wipe",
            json!({})
        ))));
    }
    engine.update_state(None, json!({ "name": "@wipe" }));
    assert!(refused(engine.dispatch_client_action(envelope(
        &text,
        "wipe",
        json!({})
    ))));
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn client_entry_accepts_a_bound_router_action_and_an_exit_completion() {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(
        Module::new("App"),
        json!({ "show": true }),
    ));
    let calls: Calls = Arc::default();
    handlers(&mut engine, &calls, &[("", "done"), ("", "other")]);
    // The SDK's ManagedRouter registers `router.*` under their bare names.
    let nav = calls.clone();
    engine.on_action("router.push", move |a| {
        nav.lock()
            .unwrap()
            .push(("router.push".into(), a.payload.clone()));
    });
    let patches: Patches = Arc::default();
    let sink = patches.clone();
    engine.set_render_callback(move |ps| sink.lock().unwrap().extend_from_slice(ps));
    render(
        &mut engine,
        r#"
        Column {
            Button("Go").onClick(@router.push, to: "/b")
            Button("Stay").onClick(@actions.other)
            If(@state.show) {
                Row { Text("bye") }.exit(fade).onAnimationComplete(@actions.done)
            }
        }
        "#,
    );
    let go = node(&patches, "Button", "Go");
    let stay = node(&patches, "Button", "Stay");
    let row = node(&patches, "Row", "");

    engine
        .dispatch_client_action(envelope(&go, "router.push", json!({ "to": "/b" })))
        .unwrap();
    assert!(refused(engine.dispatch_client_action(envelope(
        &stay,
        "router.push",
        json!({ "to": "/admin" })
    ))));

    // The exit root is gone when its completion arrives; its tombstone
    // stands in, for exactly the action it carried.
    engine.update_state(None, json!({ "show": false }));
    assert!(refused(engine.dispatch_client_action(envelope(
        &row,
        "other",
        json!({})
    ))));
    engine
        .dispatch_client_action(envelope(&row, "done", json!({ "animation": "exit" })))
        .unwrap();
    assert_eq!(tags(&calls), vec!["router.push", ":done"]);
}

#[test]
fn client_entry_recognises_every_way_a_template_declares_an_action() {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(
        Module::new("App"),
        json!({ "tasks": [{ "id": 1, "title": "a" }, { "id": 2, "title": "b" }] }),
    ));
    let names = [
        "applied",
        "named",
        "positional",
        "quoted",
        "withArgs",
        "sorted",
        "dropped",
        "settled",
        "rowTap",
    ];
    let calls: Calls = Arc::default();
    let list: Vec<(&str, &str)> = names.iter().map(|n| ("", *n)).collect();
    handlers(&mut engine, &calls, &list);
    let patches: Patches = Arc::default();
    let sink = patches.clone();
    engine.set_render_callback(move |ps| sink.lock().unwrap().extend_from_slice(ps));
    render(
        &mut engine,
        r#"
        Column {
            Button("A").onClick(@actions.applied)
            Button(onClick: @actions.named) { Text("B") }
            Button(@actions.positional)
            Button("@actions.quoted") { Text("D") }
            Button("E").onClick(@actions.withArgs, id: 7)
            Column {
                ForEach(items: @state.tasks, key: "id") {
                    Text("@{item.title}").draggable().onClick(@actions.rowTap, id: @item.id)
                }
            }
                .sortable(axis: y)
                .bind(@state.tasks)
                .onSort(@actions.sorted)
            Row { Text("Trash") }.dropZone(group: "cards", id: "trash").onDrop(@actions.dropped)
            Stack { Text("F") }.enter(fade).onAnimationComplete(@actions.settled)
        }
        "#,
    );
    // Every node the engine reported, by wire id, with the actions its
    // resolved props advertise to a renderer (`"@name"`).
    let mut found = Vec::new();
    let advertised = |props: &Value, id: &str, found: &mut Vec<(String, String)>| {
        for name in names {
            let text = props.to_string();
            if text.contains(&format!("\"@{name}\""))
                || text.contains(&format!("\"@actions.{name}\""))
            {
                found.push((id.to_string(), name.to_string()));
            }
        }
    };
    for patch in patches.lock().unwrap().iter() {
        if let Patch::Create { id, props, .. } = patch {
            advertised(&serde_json::to_value(&**props).unwrap(), id, &mut found);
        }
    }
    for name in names.iter().filter(|n| **n != "rowTap") {
        let (id, _) = found
            .iter()
            .find(|(_, n)| n == name)
            .unwrap_or_else(|| panic!("no node advertises {name}"));
        engine
            .dispatch_client_action(envelope(id, name, json!({})))
            .unwrap_or_else(|e| panic!("{name}: {e}"));
    }
    // List rows: whichever way they were created, each row carries `rowTap`.
    let rows: Vec<String> = patches
        .lock()
        .unwrap()
        .iter()
        .filter_map(|p| match p {
            Patch::Instantiate { nodes, .. } => Some(nodes[0].to_string()),
            Patch::Create {
                id,
                element_type,
                props,
                ..
            } if element_type == "Text"
                && serde_json::to_string(&**props).unwrap().contains("rowTap") =>
            {
                Some(id.to_string())
            }
            _ => None,
        })
        .collect();
    assert_eq!(rows.len(), 2, "two rows");
    for row in &rows {
        engine
            .dispatch_client_action(envelope(row, "rowTap", json!({})))
            .unwrap();
        assert!(refused(engine.dispatch_client_action(envelope(
            row,
            "sorted",
            json!({})
        ))));
    }
    assert_eq!(calls.lock().unwrap().len(), names.len() + 1);
}

// ── Hosted modules ride on the same routing ───────────────────────────────

mod hosted {
    use super::*;
    use hypen_engine::ir::{Element, Props, Value as Prop};
    use hypen_engine::module_host::{
        HostAction, HostError, ModuleHost, ModuleInstanceId, ModuleManifest, ReducerOutput,
        SiblingState,
    };
    use hypen_engine::ModuleGrants;
    use indexmap::indexmap;

    struct Recorder(Arc<Mutex<Vec<String>>>);

    impl ModuleHost for Recorder {
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
            _: ModuleInstanceId,
            _: &[u8],
            action: HostAction,
            _: &[SiblingState],
        ) -> Result<ReducerOutput, HostError> {
            self.0.lock().unwrap().push(action.name);
            Ok(ReducerOutput::default())
        }
        fn on_activated(
            &mut self,
            _: ModuleInstanceId,
            _: &[u8],
            _: &[SiblingState],
        ) -> Result<ReducerOutput, HostError> {
            Ok(ReducerOutput::default())
        }
        fn on_deactivated(
            &mut self,
            _: ModuleInstanceId,
            _: &[u8],
        ) -> Result<ReducerOutput, HostError> {
            Ok(ReducerOutput::default())
        }
        fn on_destroyed(&mut self, _: ModuleInstanceId, _: &[u8]) -> Result<(), HostError> {
            Ok(())
        }
        fn actions(&mut self, _: ModuleInstanceId) -> Result<Vec<String>, HostError> {
            Ok(vec!["open".into(), "purge".into()])
        }
    }

    #[test]
    fn a_hosted_modules_unbound_action_is_reachable_by_name_only_on_the_legacy_entry() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut engine = Engine::new();
        engine.set_module_host(Box::new(Recorder(log.clone())));
        engine
            .register_module_instance(
                "vault",
                ModuleInstanceId(0),
                vec!["open".to_string(), "purge".to_string()],
                ModuleGrants::none(),
                json!({}),
            )
            .unwrap();
        let patches: Patches = Arc::default();
        let sink = patches.clone();
        engine.set_render_callback(move |ps| sink.lock().unwrap().extend_from_slice(ps));
        engine.render(&Element {
            element_type: "Button".to_string(),
            props: Props::from_map(indexmap! {
                "onClick".to_string() => Prop::Action("open".to_string())
            }),
            ir_children: Vec::new(),
            key: None,
            module_scope: Some("vault".to_string()),
            semantics: None,
            span: None,
            expr_span: None,
        });
        let button = node(&patches, "Button", "open");

        // Client entry: only the bound action, only through its node.
        assert!(refused(engine.dispatch_client_action(Action::new("purge"))));
        assert!(refused(engine.dispatch_client_action(Action::new(
            scoped_action_name("vault", "purge")
        ))));
        assert!(refused(engine.dispatch_client_action(envelope(
            &button,
            "purge",
            json!({})
        ))));
        assert!(log.lock().unwrap().is_empty());
        engine
            .dispatch_client_action(envelope(&button, "open", json!({})))
            .unwrap();
        assert_eq!(*log.lock().unwrap(), vec!["open"]);

        // Legacy entry: every one of those forms drives the reducer.
        engine.dispatch_action(Action::new("purge")).unwrap();
        engine
            .dispatch_action(Action::new(scoped_action_name("vault", "purge")))
            .unwrap();
        engine
            .dispatch_action(envelope(&button, "purge", json!({})))
            .unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            vec!["open", "purge", "purge", "purge"]
        );
    }
}
