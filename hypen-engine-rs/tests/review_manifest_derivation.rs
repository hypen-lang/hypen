//! Adversarial review of the derivation behind `Engine::mcp_manifest()`.
//!
//! Every test here **fails on purpose**. Each asserts the invariant the code's
//! own doc comments claim — "nothing is externally reachable that a developer
//! did not declare", "the manifest cannot advertise a capability the guard
//! would then refuse" — and each currently gets the opposite. They are left in
//! the tree so the gap is a failing assertion rather than a paragraph in a
//! report. Delete a test only together with its fix.
//!
//! Distinct from `review_mcp_manifest_findings.rs`, which pins the schema and
//! addressing findings; this file attacks the *tables the schemas are derived
//! from* — how a template's declarations are keyed, scoped, torn down, and
//! read back.

use hypen_engine::dispatch::Action;
use hypen_engine::ir::{ast_to_ir_node, Component, IRNode};
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::Engine;
use serde_json::json;

fn render(engine: &mut Engine, source: &str) {
    let doc = hypen_parser::parse_document(source).expect("parse");
    engine.render_ir_node(&ast_to_ir_node(doc.components.first().expect("component")));
}

/// A component the registry expands, optionally carrying a module scope — the
/// shape `ComponentRegistry::resolve` builds from a discovered `.hyp` file.
fn component(name: &str, source: &str, is_module: bool) -> Component {
    let doc = hypen_parser::parse_document(source).expect("parse");
    let IRNode::Element(element) = ast_to_ir_node(doc.components.first().expect("component")) else {
        panic!("a component root is always an element");
    };
    let mut c = Component::new(name, move |_props| element.clone());
    if is_module {
        c.is_module = true;
        c.module_name = Some(name.to_lowercase());
    }
    c
}

/// FINDING A — destroying a module leaves its whole framework surface live.
///
/// `unregister_module` retains on `(scope, template)` with `scope ==
/// Some(name)`, so it only ever reaches declarations a `module X { … }`
/// wrapper filed under a named scope. A template written without that wrapper
/// — a plain component tree, which is the documented shape for the declarative
/// half of the language — files everything under `None`, and nothing removes
/// it. After destroy the routes are still declared, so `hypen.navigate` and
/// `hypen.back` are still listed and still dispatch; the binds are still
/// declared, so `hypen.set_input` still resolves a field and still reaches
/// `__hypen_bind`. The manifest publishes all three as tools while
/// simultaneously reporting, in `degraded`, that no module is installed.
#[test]
fn finding_a_destroying_a_module_takes_its_scopeless_declarations_with_it() {
    let mut engine = Engine::new();
    render(
        &mut engine,
        r#"
        Column {
            Router { Route(path: "/admin") { Text("admin") } }
            Input(placeholder: "Name").bind(@state.name)
        }
        "#,
    );
    engine.set_module(ModuleInstance::new(
        Module::new("App").with_actions(vec!["wipe".to_string()]),
        json!({ "name": "" }),
    ));
    for internal in ["wipe", "router.push", "router.back", "__hypen_bind"] {
        engine.on_action(internal, |_| {});
    }

    engine.unregister_module("App");

    // The module action goes, as documented. The framework verbs do not.
    assert!(
        engine
            .dispatch_external(
                Action::new("hypen.navigate").with_payload(json!({ "to": "/admin" }))
            )
            .is_err(),
        "navigation into a destroyed module still dispatches"
    );
    assert!(
        engine
            .dispatch_external(
                Action::new("hypen.set_input")
                    .with_payload(json!({ "field": "name", "value": "written" }))
            )
            .is_err(),
        "a destroyed module's state is still writable through set_input"
    );
    assert!(
        engine.mcp_manifest().tools.is_empty(),
        "tools published against a module that no longer exists: {:?}",
        engine.mcp_manifest().tools.iter().map(|t| &t.name).collect::<Vec<_>>()
    );
}

/// FINDING B — one render, two module scopes, one scope charged for both.
///
/// `absorb_declarations` keys routes and binds by each *node's* own
/// `module_scope`, but keys state refs and call sites by `template_scope`,
/// which is the FIRST scope the tree happens to contain. Compose two
/// module-backed components on one screen — the ordinary shape of a dashboard
/// — and every path the second module renders is filed against the first
/// module's state.
///
/// Both directions are wrong, and the leaking one is the manifest's: `label`
/// is a path `Side` renders, so it becomes readable **on `Dash`**, where it
/// names a secret `Dash` never put on screen. The manifest then publishes
/// `hypen://state/dash/label` as a resource and an agent reads the secret by
/// following a URI the engine handed it. Meanwhile `side.label`, the path that
/// really is on the user's screen, reads nothing.
#[test]
fn finding_b_a_second_module_on_the_screen_does_not_widen_the_first() {
    let mut engine = Engine::new();
    engine.register_component(component(
        "Dash",
        r#"module Dash { Text("@{state.headline}") }"#,
        true,
    ));
    engine.register_component(component(
        "Side",
        r#"module Side { Text("@{state.label}") }"#,
        true,
    ));
    engine.register_module(
        "dash",
        ModuleInstance::new(
            Module::new("Dash"),
            json!({ "headline": "Today", "label": "sk-live-DASH-SECRET" }),
        ),
    );
    engine.register_module(
        "side",
        ModuleInstance::new(Module::new("Side"), json!({ "label": "Menu" })),
    );

    render(&mut engine, r#"Column { Dash Side }"#);

    assert_eq!(
        engine.get_state(Some("dash"), Some("label")),
        None,
        "a path only Side renders unlocked the same field name in Dash's state"
    );
    assert_eq!(
        engine.get_state(Some("side"), Some("label")),
        Some(json!("Menu")),
        "the path Side actually renders is not on its own read surface"
    );
    assert!(
        !engine
            .mcp_manifest()
            .resources
            .iter()
            .any(|r| r.uri == "hypen://state/dash/label"),
        "the manifest publishes a URI for a value Dash never renders"
    );
}

/// FINDING C — every published resource reads nothing in the default web app.
///
/// `packages/core/src/app.ts` installs an unnamed module as
/// `setModule("AnonymousModule", …)`, so the primary module's name matches no
/// template scope. `state_address` then falls through to `core.modules`, finds
/// the **auto-registered placeholder** `absorb_declarations`' sibling created
/// for scope `app`, and treats a hollow `{}` as a module that holds state. The
/// manifest publishes one resource per declared path, addressed at the
/// placeholder; every one of them reads `None`, and `degraded` is empty.
///
/// `state_address` must not accept a scope whose only module is a placeholder,
/// and `get_state(None, …)` must reach a primary module whose name does not
/// happen to match the template's `module X { }` spelling.
#[test]
fn finding_c_an_anonymous_primary_module_still_has_a_read_surface() {
    let mut engine = Engine::new();
    render(
        &mut engine,
        r#"
        module App {
            Column {
                Text("Total: @{state.total}")
                Input(placeholder: "Coupon").bind(@state.coupon)
            }
        }
        "#,
    );
    engine.set_module(ModuleInstance::new(
        Module::new("AnonymousModule"),
        json!({ "total": 4780, "coupon": "", "_token": "secret" }),
    ));
    engine.on_action("__hypen_bind", |_| {});

    let manifest = engine.mcp_manifest();
    assert!(!manifest.resources.is_empty(), "nothing was published at all");
    for resource in &manifest.resources {
        let module = resource.meta["dev.hypen/module"].as_str();
        let path = resource.meta["dev.hypen/statePath"].as_str().expect("path");
        assert!(
            engine.get_state(module, Some(path)).is_some(),
            "advertised resource {} reads nothing, and nothing is in `degraded`: {:?}",
            resource.uri,
            manifest.degraded
        );
    }
    assert_eq!(engine.get_state(None, Some("total")), Some(json!(4780)));
}

/// FINDING D — an un-declared capability stays reachable forever.
///
/// `template_id` hashes the node *before* expansion, deliberately, so that
/// re-registering a component does not fork one template into two identities.
/// The other half of that choice was never written: `absorb_declarations` only
/// **inserts** the tables the new expansion declares and never clears one it
/// stopped declaring. Delete a `Route` and a `.bind()` from a component, reload
/// it, re-render the byte-identical root — and the route is still navigable and
/// the field is still writable, for the life of the process.
///
/// This is the `hypen dev` hot-reload loop, and it fails the rule the surface
/// exists to hold in the one direction that matters: the developer un-declared
/// it and it is still externally reachable.
#[test]
fn finding_d_re_registering_a_component_retires_what_it_stopped_declaring() {
    let mut engine = Engine::new();
    engine.register_component(component(
        "Nav",
        r#"
        Column {
            Router { Route(path: "/admin") { Text("admin") } }
            Input(placeholder: "Key").bind(@state.apiKey)
        }
        "#,
        false,
    ));
    engine.set_module(ModuleInstance::new(Module::new("App"), json!({ "apiKey": "" })));
    for internal in ["router.push", "router.back", "__hypen_bind"] {
        engine.on_action(internal, |_| {});
    }
    render(&mut engine, r#"Column { Nav }"#);

    // The developer deletes both declarations; the root template is unchanged.
    engine.register_component(component("Nav", r#"Column { Text("nothing here") }"#, false));
    render(&mut engine, r#"Column { Nav }"#);

    assert!(
        engine.list_routes().is_empty(),
        "a deleted route is still declared: {:?}",
        engine.list_routes().iter().map(|r| &r.path).collect::<Vec<_>>()
    );
    assert!(
        engine
            .dispatch_external(
                Action::new("hypen.set_input")
                    .with_payload(json!({ "field": "apiKey", "value": "leak" }))
            )
            .is_err(),
        "a deleted .bind() is still an external write primitive"
    );
}

/// FINDING E — a declared leaf unlocks its whole parent object.
///
/// `is_readable` accepts a path when the declared path is a prefix of it *or*
/// it is a prefix of the declared path, and its comment justifies the second
/// arm with "a caller could reconstruct it path by path anyway". That is
/// exactly what a caller cannot do: `user.ssn` on its own is refused, and the
/// whole-tree read correctly projects down to `{user: {name}}`. Only the
/// explicit parent path is admitted — and it returns the object entire.
///
/// So a template that renders nothing but `@{state.user.name}` puts every
/// sibling field of `user` on the external read surface, and the manifest
/// hands an agent the `user.name` resource that makes the parent obvious.
#[test]
fn finding_e_a_declared_leaf_does_not_unlock_its_siblings() {
    let mut engine = Engine::new();
    render(&mut engine, r#"module Acct { Text("Hi @{state.user.name}") }"#);
    engine.set_module(ModuleInstance::new(
        Module::new("Acct"),
        json!({
            "user": {
                "name": "Ada",
                "ssn": "078-05-1120",
                "authToken": "sk-live-DEADBEEF"
            }
        }),
    ));

    // The gate agrees the siblings are undeclared when named directly.
    assert_eq!(engine.get_state(None, Some("user.ssn")), None);
    assert_eq!(engine.get_state(None, Some("user.authToken")), None);

    assert_eq!(
        engine.get_state(None, Some("user")),
        Some(json!({ "name": "Ada" })),
        "reading the parent returns fields the template never rendered"
    );
}

/// FINDING F — two call-site shapes the schema describes wrongly.
///
/// `call_args` reads every sibling prop under the applicator prefix as an
/// argument of the action, but the renderer that actually builds the dispatch
/// payload (`hypen-web/packages/web/src/dom/applicators/events.ts`,
/// `extractActionDetails`) does not:
///
/// * a positional payload object — `.onClick(@actions.foo, { id: "123" })` —
///   arrives on key `"1"` and is **flattened** into the payload, so the real
///   argument is `id`; the schema publishes an argument literally named `1`;
/// * the `animate:` named argument is a transaction-animation stamp that the
///   renderer strips and that "must never reach a module handler's payload";
///   the schema publishes it as part of the action's callable signature.
///
/// Both are advisory schemas, so nothing is refused — an agent simply sends a
/// payload no call site in the app has ever produced.
#[test]
fn finding_f_the_schema_matches_the_payload_the_app_itself_sends() {
    let mut engine = Engine::new();
    render(
        &mut engine,
        r#"
        module App {
            Column {
                Button("A").onClick(@actions.foo, { id: "123", qty: 2 })
                Button("B").onClick(@actions.bar, animate: spring, note: "x")
            }
        }
        "#,
    );
    engine.set_module(ModuleInstance::new(
        Module::new("App").with_actions(vec!["foo".to_string(), "bar".to_string()]),
        json!({}),
    ));
    for a in ["foo", "bar"] {
        engine.on_action(a, |_| {});
    }

    let manifest = engine.mcp_manifest();
    let schema = |name: &str| {
        manifest
            .tools
            .iter()
            .find(|t| t.name == name)
            .unwrap_or_else(|| panic!("no tool {name}"))
            .input_schema["properties"]
            .clone()
    };

    assert_eq!(
        schema("foo"),
        json!({ "id": { "type": "string" }, "qty": { "type": "number" } }),
        "a positional payload object is published under its index, not its keys"
    );
    assert_eq!(
        schema("bar"),
        json!({ "note": { "type": "string" } }),
        "the framework's `animate:` stamp is published as a callable argument"
    );
}
