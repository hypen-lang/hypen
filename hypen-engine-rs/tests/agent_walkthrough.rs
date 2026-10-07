//! One agent, one app, end to end — through the external surface only.
//!
//! Every other test on this surface asserts a single invariant in isolation.
//! This one plays the whole session: read the manifest, navigate, fill a
//! field, dispatch an action with an argument, read the result back, and get
//! refused six ways. It exists to answer a question no unit test does — *what
//! does an agent actually receive, and can it act on that alone* — so it
//! prints the manifest and every refusal verbatim under `--nocapture`.
//!
//! The test is deliberately allowed to touch the engine only where a real host
//! would. `Engine::mcp_manifest`, `dispatch_external` and `get_state` are the
//! agent's whole vocabulary. `render_ir_node`, `set_module`, `on_action` and
//! `update_state` are the *host's* half of the loop — the SDK mounting the app
//! and applying what a handler decided — and are used here only to stand a
//! real app up and to close the loop a JS module handler would close.
//!
//! Which is itself a finding worth keeping visible: the engine dispatches, it
//! does not execute. `router.push` moves nothing until a router applies a
//! location, and `__hypen_bind` writes nothing until a handler writes it. So
//! the "host" closures below are not test scaffolding around the behaviour —
//! they are the behaviour that the engine genuinely does not have.

use std::sync::{Arc, Mutex};

use hypen_engine::agent::{BACK, NAVIGATE, SET_INPUT};
use hypen_engine::dispatch::Action;
use hypen_engine::ir::ast_to_ir_node;
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::{Engine, EngineError, Patch};
use serde_json::json;

/// A shop with the whole surface in one template: three routes (one
/// parameterised), two actions — `addToCart` carrying a call-site `sku`,
/// `saveSettings` carrying none — two binds of different value types, five
/// rendered state paths, and `authToken`, which the template never mentions.
///
/// One root child under the `module` wrapper on purpose: a module body with
/// several top-level children lowers to its first child only.
const SHOP: &str = r#"
module Shop {
    Column {
        Router {
            Route(path: "/catalog") {
                Column {
                    Text("Welcome, @{state.user.name}")
                    Text("Cart total: @{state.cart.total}")
                    Input(placeholder: "Search catalog").bind(@state.query)
                    Button("Add").onClick(@actions.addToCart, sku: "widget-1")
                }
            }
            Route(path: "/settings") {
                Column {
                    Text("Signed in as @{state.user.name}")
                    Switch(label: "Email me").bind(@state.notify)
                    Button("Save").onClick(@actions.saveSettings)
                }
            }
            Route(path: "/order/:orderId") {
                Text("Order status: @{state.order.status}")
            }
        }
    }
}
"#;

/// What the host observed on the engine's behalf: every patch batch, and every
/// payload that reached a framework handler.
#[derive(Default)]
struct Host {
    patches: Mutex<Vec<Patch>>,
    navigations: Mutex<Vec<serde_json::Value>>,
    binds: Mutex<Vec<serde_json::Value>>,
    dispatched: Mutex<Vec<(String, Option<serde_json::Value>)>>,
}

impl Host {
    fn last_bind(&self) -> serde_json::Value {
        self.binds.lock().unwrap().last().cloned().expect("a bind reached __hypen_bind")
    }
    fn created(&self) -> Vec<String> {
        self.patches
            .lock()
            .unwrap()
            .iter()
            .filter_map(|p| match p {
                Patch::Create { element_type, .. } => Some(element_type.clone()),
                _ => None,
            })
            .collect()
    }
    fn clear_patches(&self) {
        self.patches.lock().unwrap().clear();
    }
}

/// Mount the app exactly as an SDK does: install the module, render the
/// template, then install a handler per declared action and one per framework
/// internal. Handlers only *record* — the engine hands them a payload and
/// never waits for them, so recording is all a handler can honestly do from
/// inside a `Fn(&Action)`.
fn mount() -> (Engine, Arc<Host>) {
    let host = Arc::new(Host::default());
    let mut engine = Engine::new();

    let module = Module::new("Shop").with_actions(vec![
        "addToCart".to_string(),
        "saveSettings".to_string(),
    ]);
    engine.set_module(ModuleInstance::new(
        module,
        json!({
            "location": "/catalog",
            "user": { "name": "Ada" },
            "cart": { "total": 4780 },
            "order": { "status": "shipped" },
            "query": "",
            "notify": false,
            "authToken": "sk-live-DO-NOT-LEAK"
        }),
    ));

    let doc = hypen_parser::parse_document(SHOP).expect("parse");
    engine.render_ir_node(&ast_to_ir_node(doc.components.first().expect("component")));

    for name in ["addToCart", "saveSettings"] {
        let host = host.clone();
        let name = name.to_string();
        engine.on_action(name.clone(), move |action| {
            host.dispatched
                .lock()
                .unwrap()
                .push((name.clone(), action.payload.clone()));
        });
    }

    // The framework's own handlers, registered straight on the dispatcher the
    // way every SDK registers them — never through `register_module`, which is
    // why they never enter the external allowlist.
    let h = host.clone();
    engine.on_action("router.push", move |a| {
        h.navigations.lock().unwrap().push(a.payload.clone().unwrap_or(json!(null)));
    });
    let h = host.clone();
    engine.on_action("router.back", move |_| {
        h.navigations.lock().unwrap().push(json!("back"));
    });
    let h = host.clone();
    engine.on_action(hypen_engine::BIND_ACTION, move |a| {
        h.binds.lock().unwrap().push(a.payload.clone().unwrap_or(json!(null)));
    });
    // `router.replace` exists on the dispatcher — the point of the refusal
    // below is that the guard stops it, not that no handler is listening.
    let h = host.clone();
    engine.on_action("router.replace", move |a| {
        h.navigations.lock().unwrap().push(a.payload.clone().unwrap_or(json!(null)));
    });

    let h = host.clone();
    engine.set_render_callback(move |patches| {
        h.patches.lock().unwrap().extend_from_slice(patches);
    });

    (engine, host)
}

/// Refuse and say so, in the words the agent would actually be handed.
fn refused(engine: &mut Engine, label: &str, action: Action) -> EngineError {
    let err = engine
        .dispatch_external(action)
        .expect_err(&format!("{label} must be refused"));
    println!("  REFUSED  {label}\n           {err}");
    err
}

#[test]
fn an_agent_drives_the_app_through_the_declared_surface_only() {
    let (mut engine, host) = mount();

    // ── 1. Read the manifest ───────────────────────────────────────────────
    let manifest = engine.mcp_manifest();
    println!("\n════ MANIFEST (what an agent receives) ════════════════════════");
    println!("{}", serde_json::to_string_pretty(&manifest).expect("serialize"));
    println!("═══════════════════════════════════════════════════════════════\n");

    let tool = |name: &str| manifest.tools.iter().find(|t| t.name == name);
    assert!(tool("hypen_navigate").is_some(), "navigation must be published");
    assert!(tool("hypen_set_input").is_some(), "the form surface must be published");
    assert!(tool("addToCart").is_some(), "a declared action must be published");
    assert!(tool("saveSettings").is_some());
    assert!(
        !manifest.tools.iter().any(|t| t.name.contains("bind") || t.name.starts_with("router")),
        "no framework internal may be published: {:?}",
        manifest.tools.iter().map(|t| &t.name).collect::<Vec<_>>()
    );
    // The call-site argument is the only reason a bare action name is callable.
    assert_eq!(
        tool("addToCart").unwrap().input_schema["properties"]["sku"],
        json!({"type": "string"}),
        "the sku argument must be published with the type its call site fixes"
    );
    assert!(
        !manifest.resources.iter().any(|r| r.uri.contains("authToken")),
        "the secret must not be advertised: {:?}",
        manifest.resources.iter().map(|r| &r.uri).collect::<Vec<_>>()
    );
    let advertised: Vec<&str> = manifest.resources.iter().map(|r| r.uri.as_str()).collect();
    assert!(advertised.contains(&"hypen://state/shop/user.name"), "{advertised:?}");
    assert!(advertised.contains(&"hypen://state/shop/query"), "{advertised:?}");

    // ── 2. Navigate to a declared route ────────────────────────────────────
    host.clear_patches();
    engine
        .dispatch_external(Action::new(NAVIGATE).with_payload(json!({"to": "/settings"})))
        .expect("a declared route must be navigable");
    assert_eq!(
        *host.navigations.lock().unwrap(),
        vec![json!({"to": "/settings"})],
        "the target must reach router.push untouched"
    );
    // The engine dispatched; it did not move. A router applies the location,
    // and only then does the route body render.
    engine.update_state(None, json!({"location": "/settings"}));
    assert!(
        host.created().iter().any(|t| t == "Switch"),
        "the /settings body must have rendered; created {:?}",
        host.created()
    );

    // ── 3. Set a declared input ────────────────────────────────────────────
    engine
        .dispatch_external(
            Action::new(SET_INPUT).with_payload(json!({"field": "query", "value": "mouse"})),
        )
        .expect("a declared field must be writable");
    assert_eq!(
        host.last_bind(),
        json!({"module": null, "path": "query", "value": "mouse"}),
        "set_input must lower to exactly the payload a user typing would produce"
    );
    // Close the loop the SDK's bind handler closes.
    engine.update_state(None, json!({"query": "mouse"}));

    // ── 4. Dispatch a module action with an argument ───────────────────────
    engine
        .dispatch_external(Action::new("addToCart").with_payload(json!({"sku": "widget-9"})))
        .expect("a declared action must dispatch");
    assert_eq!(
        *host.dispatched.lock().unwrap(),
        vec![("addToCart".to_string(), Some(json!({"sku": "widget-9"})))],
        "the argument must reach the handler unchanged"
    );

    // ── 5. Read back what the agent is allowed to read ─────────────────────
    //
    // Addressed the way the manifest says to: `_meta` carries the module
    // argument and the path, because the primary module is addressed by
    // *absence* and no URI segment can spell that.
    let query_resource = manifest
        .resources
        .iter()
        .find(|r| r.uri == "hypen://state/shop/query")
        .expect("the field the agent just wrote must be readable");
    let module_arg = query_resource.meta["dev.hypen/module"].as_str();
    let state_path = query_resource.meta["dev.hypen/statePath"].as_str().expect("statePath");
    assert_eq!(
        engine.get_state(module_arg, Some(state_path)),
        Some(json!("mouse")),
        "the manifest's own read address must serve the resource it published"
    );
    // The URI segment is a *name*, not that address. A host resolving
    // `resources/read` by parsing the URI — the obvious implementation, and the
    // only one the URI shape suggests — gets nothing for every primary-module
    // resource. Printed, not asserted: `review_mcp_manifest_findings.rs`
    // holds the failing assertion that demands the fix.
    let by_uri_segment = engine.get_state(Some("shop"), Some("query"));
    println!("  NOTE  resource uri 'hypen://state/shop/query' read by its own segment -> {by_uri_segment:?}");
    println!("        (the working address is _meta[\"dev.hypen/module\"] = {module_arg:?})");

    assert_eq!(engine.get_state(None, Some("query")), Some(json!("mouse")));
    assert_eq!(engine.get_state(None, Some("user.name")), Some(json!("Ada")));
    assert_eq!(engine.get_state(None, Some("cart.total")), Some(json!(4780)));
    let whole = engine.get_state(None, None).expect("a whole read is projected, not refused");
    println!("\n════ WHOLE-TREE READ (projected to declared paths) ════════════");
    println!("{}", serde_json::to_string_pretty(&whole).expect("serialize"));
    println!("═══════════════════════════════════════════════════════════════\n");
    assert_eq!(whole["query"], json!("mouse"));
    assert!(
        whole.get("authToken").is_none(),
        "the whole-tree read leaked the secret: {whole}"
    );
    assert!(
        whole.get("location").is_none(),
        "a synthesized Router location is not a developer declaration: {whole}"
    );

    // ── 6. Six refusals ────────────────────────────────────────────────────
    println!("════ REFUSALS (verbatim, as an agent would see them) ══════════");
    let before_binds = host.binds.lock().unwrap().len();
    let before_navs = host.navigations.lock().unwrap().len();

    let e = refused(
        &mut engine,
        "__hypen_bind by name",
        Action::new(hypen_engine::BIND_ACTION)
            .with_payload(json!({"path": "authToken", "value": "stolen"})),
    );
    assert!(matches!(e, EngineError::ActionNotFound(_)));

    let e = refused(
        &mut engine,
        "router.replace",
        Action::new("router.replace").with_payload(json!({"to": "/settings"})),
    );
    // Reserved names are genuinely unreachable — no handler is exposed under
    // them at all — so this is ActionNotFound, not a refusal with a reason.
    assert!(matches!(e, EngineError::ActionNotFound(_)));

    let e = refused(
        &mut engine,
        "undeclared route /admin",
        Action::new(NAVIGATE).with_payload(json!({"to": "/admin"})),
    );
    assert!(matches!(e, EngineError::NotDeclared(_)));

    let e = refused(
        &mut engine,
        "undeclared set_input field 'authToken'",
        Action::new(SET_INPUT).with_payload(json!({"field": "authToken", "value": "stolen"})),
    );
    assert!(matches!(e, EngineError::NotDeclared(_)));

    let e = refused(
        &mut engine,
        "wrong-typed set_input value (notify declares 'on', a boolean)",
        Action::new(SET_INPUT).with_payload(json!({"field": "notify", "value": {"role": "admin"}})),
    );
    assert!(matches!(e, EngineError::StateError(_)));

    println!("  REFUSED  read of the secret: get_state(None, \"authToken\")");
    println!("           -> None (indistinguishable from 'no such path', by design)");
    assert_eq!(engine.get_state(None, Some("authToken")), None);
    println!("═══════════════════════════════════════════════════════════════\n");

    assert_eq!(
        host.binds.lock().unwrap().len(),
        before_binds,
        "a refused call must not have reached __hypen_bind"
    );
    assert_eq!(
        host.navigations.lock().unwrap().len(),
        before_navs,
        "a refused call must not have reached the router"
    );

    // `back` takes no target and stays reachable throughout.
    engine.dispatch_external(Action::new(BACK)).expect("back");
    assert_eq!(host.navigations.lock().unwrap().last(), Some(&json!("back")));

    // ── 7. Where an agent is left guessing ─────────────────────────────────
    //
    // Not defects in the guard — the guard is doing exactly what it says. They
    // are the places where what the manifest *says* runs out before what an
    // agent needs to *decide*, and they are asserted so a fix has to come past
    // this test rather than past a paragraph in a report.
    println!("════ WHAT THE MANIFEST DOES NOT SAY ═══════════════════════════");

    // (a) There is no "where am I". A Router's location binding is synthesized
    // by `ir::expand`, so treating it as a declaration would publish
    // `state.location` for an app whose developer never wrote it — but nothing
    // publishes it deliberately either, so an agent that navigates has no way
    // to confirm it arrived.
    assert!(
        !manifest.resources.iter().any(|r| r.uri.ends_with("/location")),
        "no resource reports the current route"
    );
    assert_eq!(engine.get_state(None, Some("location")), None);
    println!("  - current route: unreadable. `hypen_navigate` is fire-and-forget and");
    println!("    nothing on the surface confirms which screen the app is on.");

    // (b) A `:param` route publishes its pattern and nothing else — `params`
    // exists on `AgentRoute` but no manifest field carries it — and the guard
    // accepts the pattern *verbatim*, so an agent that copies the string it was
    // given navigates to a literal ":orderId".
    engine
        .dispatch_external(Action::new(NAVIGATE).with_payload(json!({"to": "/order/:orderId"})))
        .expect("the raw pattern is accepted as a target");
    engine
        .dispatch_external(Action::new(NAVIGATE).with_payload(json!({"to": "/order/42"})))
        .expect("and so is a concrete path");
    let navigate = tool("hypen_navigate").unwrap();
    assert!(
        !serde_json::to_string(&navigate.input_schema).unwrap().contains("orderId")
            && !serde_json::to_string(&navigate.meta).unwrap().contains("params"),
        "nothing names the route's parameters: {:?}",
        navigate.input_schema
    );
    println!("  - route params: '/order/:orderId' is published as an opaque string.");
    println!("    Both '/order/:orderId' and '/order/42' dispatch, so copying the");
    println!("    pattern verbatim silently navigates to a literal ':orderId'.");
    println!("═══════════════════════════════════════════════════════════════\n");
}
