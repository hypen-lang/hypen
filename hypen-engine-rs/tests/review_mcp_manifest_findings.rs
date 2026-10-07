//! Adversarial-review findings against `Engine::mcp_manifest()`.
//!
//! Regression cases from adversarial review, including safe per-row discovery.
//! They are left in the tree so the gaps are visible rather than described in
//! a report nobody re-reads. Delete a test only together with its fix.
//!
//! The lens throughout is the client: an LLM agent that has the handshake in
//! context and nothing else, trying to finish a task on turn one.

use hypen_engine::dispatch::Action;
use hypen_engine::ir::ast_to_ir_node;
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::Engine;
use serde_json::json;

fn render(engine: &mut Engine, source: &str) {
    let doc = hypen_parser::parse_document(source).expect("parse");
    engine.render_ir_node(&ast_to_ir_node(doc.components.first().expect("component")));
}

/// Render, install the primary module, register its handlers — the order every
/// SDK uses.
fn app(source: &str, name: &str, actions: &[&str], state: serde_json::Value) -> Engine {
    let mut engine = Engine::new();
    render(&mut engine, source);
    let module = Module::new(name).with_actions(actions.iter().map(|a| a.to_string()).collect());
    engine.set_module(ModuleInstance::new(module, state));
    for a in actions {
        engine.on_action(a.to_string(), |_| {});
    }
    for internal in ["router.push", "router.back", "__hypen_bind"] {
        engine.on_action(internal, |_| {});
    }
    engine
}

const SHOP: &str = r#"
module Shop {
    Column {
        Text("Hi @{state.user.name}")
        Router {
            Route(path: "/catalog") {
                List(@state.products, as: product) {
                    Column {
                        Text("@{product.title}")
                        Button("Add").onClick(@actions.addToCart, sku: @product.sku)
                    }
                }
            }
            Route(path: "/cart") {
                Column {
                    Text("Items: @{state.cartCount}")
                    Input(placeholder: "Coupon code").bind(@state.coupon)
                }
            }
        }
    }
}
"#;

fn shop() -> Engine {
    app(
        SHOP,
        "Shop",
        &["addToCart"],
        json!({
            "user": {"name": "Ada"},
            "products": [
                {"sku": "SHIRT-BLUE", "title": "Blue shirt"},
                {"sku": "HAT-RED", "title": "Red hat"}
            ],
            "cartCount": 0,
            "coupon": ""
        }),
    )
}

/// FINDING 1 — the `to` enum is tighter than the guard for a wildcard route.
///
/// `route_params` only counts `:name` segments, so `/docs/*` reports no params
/// and `navigate_schema` enumerates it. `match_path` however admits every path
/// beneath it. An MCP client validates `inputSchema` locally, so it refuses to
/// send exactly the navigations the engine accepts — the failure mode
/// `agent_manifest`'s "schemas are permissive on purpose" section exists to
/// prevent, reached through the one pattern shape the params check misses.
#[test]
fn wildcard_route_enum_refuses_a_navigation_the_guard_allows() {
    let mut engine = app(
        r#"
        module Docs {
            Router {
                Route(path: "/home") { Text("home") }
                Route(path: "/docs/*") { Text("docs") }
            }
        }
        "#,
        "Docs",
        &[],
        json!({}),
    );

    // The guard accepts any path under the wildcard.
    assert!(engine
        .dispatch_external(Action::new("hypen.navigate").with_payload(json!({"to": "/docs/intro"})))
        .is_ok());

    let manifest = engine.mcp_manifest();
    let to = &manifest
        .tools
        .iter()
        .find(|t| t.name == "hypen_navigate")
        .expect("navigate tool")
        .input_schema["properties"]["to"];

    // So the enum must not be published: a closed list cannot describe an open
    // pattern, and publishing one removes calls that work.
    assert!(
        to.get("enum").is_none(),
        "a wildcard route makes the enum a lie: {to}"
    );
}

/// FINDING 2 — the per-scope bound un-declares a route that is still declared.
///
/// `MAX_TEMPLATES_PER_SCOPE` evicts the oldest template's entries, and
/// `list_routes` is what `check_navigate_target` bounds navigation by. Past 64
/// route-declaring templates in one scope, a route the developer wrote is no
/// longer navigable and no longer listed — the surface silently shrinks under
/// a running app rather than under a code change.
#[test]
fn an_evicted_route_stops_being_navigable() {
    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(Module::new("App"), json!({})));
    engine.on_action("router.push", |_| {});
    for i in 0..70 {
        render(
            &mut engine,
            &format!(r#"module App {{ Router {{ Route(path: "/r{i}") {{ Text("x") }} }} }}"#),
        );
    }

    assert!(
        engine
            .dispatch_external(Action::new("hypen.navigate").with_payload(json!({"to": "/r0"})))
            .is_ok(),
        "a declared route stopped dispatching because 64 later templates rendered"
    );
}

/// FINDING 3 — the same bound re-opens the shell-clobbering bug it was added
/// beside.
///
/// A `ManagedRouter` shell mounts once and each screen renders its own body
/// template under the same scope. `IndexMap::insert` keeps an existing key's
/// position, so nothing a re-render does refreshes recency — the eviction is
/// insertion-order FIFO, not the LRU its comment describes. At screen 65 the
/// shell's entry is the oldest and goes, and the header the user is looking at
/// stops being readable.
#[test]
fn a_mounted_shell_keeps_its_read_surface_across_many_screens() {
    const SHELL: &str = r#"
        module App {
            Column {
                Text("@{state.user.name}")
                Router { Route(path: "/s") { Text("s") } }
            }
        }
    "#;

    let mut engine = Engine::new();
    engine.set_module(ModuleInstance::new(
        Module::new("App"),
        json!({"user": {"name": "Ada"}, "t": 0}),
    ));
    render(&mut engine, SHELL);
    for i in 0..70 {
        render(
            &mut engine,
            &format!(r#"module App {{ Text("screen {i}: @{{state.t}}") }}"#),
        );
    }

    assert_eq!(
        engine.get_state(None, Some("user.name")),
        Some(json!("Ada")),
        "the shell is still mounted and still rendering this path"
    );
}

/// Resource URIs are opaque identifiers; the manifest metadata carries the
/// guarded read address, including null for the primary module.
#[test]
fn the_published_resource_metadata_is_a_working_read_address() {
    let engine = shop();
    let manifest = engine.mcp_manifest();
    let resource = manifest
        .resources
        .iter()
        .find(|r| r.uri == "hypen://state/shop/cartCount")
        .expect("cartCount resource");
    assert_eq!(
        engine.get_state(
            resource.meta["dev.hypen/module"].as_str(),
            resource.meta["dev.hypen/statePath"].as_str(),
        ),
        Some(json!(0)),
    );
}

/// FINDING 5 — a per-row action is advertised with no way to aim it.
///
/// `addToCart` is declared once per row over `@state.products`, and the agent
/// is told exactly that. But `extract_state_refs` skips a `ForEach` source, so
/// `products` is not on the read surface and the row keys cannot be
/// enumerated; and because the developer named the item `product` rather than
/// the reserved `item`, `@product.sku` lowers to an interpolated string that
/// `call_args` drops, so `sku` is not even named in the schema. The one tool
/// on the catalogue screen is therefore uncallable in any useful way, while
/// the rows themselves are on the user's screen — the very test the read
/// surface claims to apply.
#[test]
fn a_per_row_action_can_be_aimed_at_a_row() {
    let engine = shop();
    let manifest = engine.mcp_manifest();
    let add = manifest
        .tools
        .iter()
        .find(|t| t.name == "addToCart")
        .expect("addToCart tool");

    // Either the row argument is described...
    let names_the_argument = add.input_schema["properties"].get("sku").is_some();
    // ...or the collection it indexes is readable. Neither holds.
    let rows_are_readable = engine.get_state(None, Some("products")).is_some();

    assert!(
        names_the_argument && rows_are_readable,
        "row argument named: {names_the_argument}, rows readable: {rows_are_readable} — \
         schema was {}",
        add.input_schema
    );
}

/// FINDING 6 — two modules binding one path collapse to one writable field.
///
/// The manifest publishes `hypen://state/profile/name` and
/// `hypen://state/company/name` as two distinct readable values, then offers a
/// single `hypen_set_input` branch `field: "name"`. Which module a write lands
/// in is decided by whatever handler is registered for `__hypen_bind`, because
/// `ExternalTarget::Bind` carries no scope at all — `BoundInput.module_scope`
/// is known at declaration time and dropped by both the schema and the guard.
/// So one of the two declared fields is unreachable, and the caller is not
/// told which.
#[test]
fn set_input_can_address_every_declared_field() {
    let mut engine = Engine::new();
    render(
        &mut engine,
        r#"module Profile { Input(placeholder: "Your name").bind(@state.name) }"#,
    );
    render(
        &mut engine,
        r#"module Company { Input(placeholder: "Company name").bind(@state.name) }"#,
    );
    engine.set_module(ModuleInstance::new(
        Module::new("Profile"),
        json!({"name": ""}),
    ));
    engine.register_module(
        "company",
        ModuleInstance::new(Module::new("Company"), json!({"name": ""})),
    );

    let manifest = engine.mcp_manifest();
    let branches = manifest
        .tools
        .iter()
        .find(|t| t.name == "hypen_set_input")
        .expect("set_input tool")
        .input_schema["oneOf"]
        .as_array()
        .expect("oneOf")
        .len();

    assert_eq!(
        branches,
        engine.list_bindings().len(),
        "two declared fields, one addressable branch"
    );
}

#[test]
fn row_resources_project_display_and_public_action_fields_only() {
    let engine = app(
        r#"module Shop {
        List(@state.products, as: product) {
            Text("@{product.title}")
            Button("Add").onClick(@actions.add, sku: @product.sku, token: @state.token)
            Button("Internal").onClick(@actions._internal, secret: @product.secret)
        }
    }"#,
        "Shop",
        &["add", "_internal"],
        json!({
            "token": "private", "products": [
                {"title": "Hat", "sku": "HAT", "secret": "hidden", "cost": 12},
                {"title": "Shirt", "sku": "SHIRT", "secret": "hidden", "cost": 10}
            ]
        }),
    );
    let rows = json!([{"title": "Hat", "sku": "HAT"}, {"title": "Shirt", "sku": "SHIRT"}]);
    assert_eq!(engine.get_state(None, Some("products")), Some(rows.clone()));
    assert_eq!(
        engine.get_state(None, None),
        Some(json!({"products": rows}))
    );
    assert_eq!(
        engine.get_state(None, Some("products.0")),
        Some(json!({"title":"Hat", "sku":"HAT"}))
    );
    assert_eq!(
        engine.get_state(None, Some("products.0.sku")),
        Some(json!("HAT"))
    );
    for path in ["products.0.secret", "products.1.cost", "token"] {
        assert_eq!(engine.get_state(None, Some(path)), None, "{path}");
    }
    let manifest = engine.mcp_manifest();
    let resource = manifest
        .resources
        .iter()
        .find(|r| r.uri == "hypen://state/shop/products")
        .expect("row collection resource");
    assert_eq!(
        engine.get_state(
            resource.meta["dev.hypen/module"].as_str(),
            resource.meta["dev.hypen/statePath"].as_str()
        ),
        Some(rows)
    );
    let add = manifest.tools.iter().find(|t| t.name == "add").unwrap();
    assert!(add.input_schema["properties"].get("sku").is_some());
    assert!(!manifest.tools.iter().any(|t| t.name == "_internal"));
}

#[test]
fn row_projection_preserves_nested_arrays_and_lexical_aliases() {
    let engine = app(
        r#"module Shop {
        List(@state.groups, as: group) {
            Text("@{group.title}")
            List(@group.products, as: product) {
                Text("@{product.name}")
                Button("Add").onClick(@actions.add, sku: @product.sku, group: @group.id)
            }
        }
    }"#,
        "Shop",
        &["add"],
        json!({"groups": [
            {"title":"A", "id":"g1", "secret":"x", "products":[{"name":"Hat", "sku":"h", "cost":12}]},
            {"title":"B", "id":"g2", "products":[]}
        ]}),
    );
    assert_eq!(
        engine.get_state(None, Some("groups")),
        Some(json!([
            {"title":"A", "id":"g1", "products":[{"name":"Hat", "sku":"h"}]},
            {"title":"B", "id":"g2", "products":[]}
        ]))
    );
    assert_eq!(
        engine.get_state(None, Some("groups.0.products.0.cost")),
        None
    );
}

#[test]
fn nested_item_alias_shadows_outer_item_without_widening_reads() {
    let engine = app(
        r#"module Shop {
        List(@state.groups) {
            List(@item.products) { Text("@{item.title}") }
        }
    }"#,
        "Shop",
        &[],
        json!({"groups":[{"title":"private outer", "products":[{"title":"public", "secret":true}]}]}),
    );
    assert_eq!(
        engine.get_state(None, Some("groups")),
        Some(json!([{"products":[{"title":"public"}]}]))
    );
}

#[test]
fn empty_row_collection_is_discoverable_before_data_arrives() {
    let mut engine = app(
        r#"module Shop { List(@state.products) { Text("@{item.title}") } }"#,
        "Shop",
        &[],
        json!({"products":[]}),
    );
    assert_eq!(engine.get_state(None, Some("products")), Some(json!([])));
    let before = engine.mcp_manifest();
    assert!(before
        .resources
        .iter()
        .any(|r| r.uri == "hypen://state/shop/products"));
    engine.update_state(None, json!({"products":[{"title":"Hat", "secret":true}]}));
    assert_eq!(
        engine.get_state(None, Some("products")),
        Some(json!([{"title":"Hat"}]))
    );
    assert_eq!(
        before.resources.len(),
        engine.mcp_manifest().resources.len()
    );
}

#[test]
fn iteration_alone_or_a_provider_source_does_not_grant_state_reads() {
    for template in [
        r#"module Shop { List(@state.products) { Text("constant") } }"#,
        r#"module Shop { List(@state.products, as: product) { Text("@{'product.secret'}") } }"#,
        r#"module Shop { List(@provider.products, as: product) { Text("@{product.title}") } }"#,
        r#"module Shop { List(@state.products) { Button("Private").onClick(@actions._secret, id: @item.id) } }"#,
    ] {
        let engine = app(
            template,
            "Shop",
            &["_secret"],
            json!({"products":[{"id":"secret", "title":"private"}]}),
        );
        assert_eq!(engine.get_state(None, Some("products")), None, "{template}");
    }
}

#[test]
fn named_module_row_reads_do_not_cross_scopes() {
    let mut engine = Engine::new();
    for name in ["First", "Second"] {
        engine.register_module(
            name.to_string(),
            ModuleInstance::new(
                Module::new(name),
                json!({
                    "rows":[{"title":name, "secret":name}]
                }),
            ),
        );
    }
    render(
        &mut engine,
        r#"module First { List(@state.rows) { Text("@{item.title}") } }"#,
    );
    render(&mut engine, r#"module Second { Text("constant") }"#);
    assert_eq!(
        engine.get_state(Some("first"), Some("rows")),
        Some(json!([{"title":"First"}]))
    );
    assert_eq!(engine.get_state(Some("second"), Some("rows")), None);
}

#[test]
fn row_wildcards_never_admit_numeric_object_keys_after_type_changes() {
    let mut engine = app(
        r#"module Shop { List(@state.products) { Text("@{item.title}") } }"#,
        "Shop",
        &[],
        json!({"products":[]}),
    );
    engine.update_state(
        None,
        json!({"products":{"0":{"title":"not a row", "secret":true}}}),
    );
    for path in ["products", "products.0", "products.0.title"] {
        assert_eq!(engine.get_state(None, Some(path)), None, "{path}");
    }
}

#[test]
fn a_row_binding_in_another_module_cannot_grant_reads_in_that_module() {
    let mut engine = Engine::new();
    for name in ["First", "Second"] {
        engine.register_module(
            name.to_string(),
            ModuleInstance::new(
                Module::new(name),
                json!({
                    "rows":[{"title":name, "secret":name}]
                }),
            ),
        );
    }
    render(
        &mut engine,
        r#"module First {
        List(@state.rows) { module Second { Text("@{item.secret}") } }
    }"#,
    );
    assert_eq!(engine.get_state(Some("second"), Some("rows")), None);
}

#[test]
fn iteration_container_action_arguments_do_not_expose_state_secrets() {
    let engine = app(
        r#"module Shop {
        ForEach(items: @state.products) { Text("@{item.title}") }
            .onClick(@actions.add, token: @state.token)
    }"#,
        "Shop",
        &["add"],
        json!({"token":"secret", "products":[{"title":"Hat"}]}),
    );
    assert_eq!(engine.get_state(None, Some("token")), None);
}
