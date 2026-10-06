//! The read projection for `ForEach` rows on the agent surface.
//!
//! A per-row action — `addToCart` declared once per product — is only useful
//! to an external caller who can name a row. The rows are on the user's
//! screen, but only the fields the template renders are, so the read surface
//! serves the collection **projected** to those fields: `products` reads as
//! every row with its `title` and `sku`, `products.3.sku` reads as that one
//! value, and `products.3.internal_cost` — never rendered — reads as nothing.
//!
//! Every test renders a template, installs the module, and reads the way an
//! MCP host would: through `get_state` and `mcp_manifest`.

use hypen_engine::ir::ast_to_ir_node;
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::Engine;
use serde_json::json;

fn render(engine: &mut Engine, source: &str) {
    let doc = hypen_parser::parse_document(source).expect("parse");
    engine.render_ir_node(&ast_to_ir_node(doc.components.first().expect("component")));
}

/// Render, install the primary module, register its handlers — the order
/// every SDK uses.
fn app(source: &str, name: &str, actions: &[&str], state: serde_json::Value) -> Engine {
    let mut engine = Engine::new();
    render(&mut engine, source);
    let module = Module::new(name).with_actions(actions.iter().map(|a| a.to_string()).collect());
    engine.set_module(ModuleInstance::new(module, state));
    for a in actions {
        engine.on_action(a.to_string(), |_| {});
    }
    engine
}

fn products() -> serde_json::Value {
    json!([
        {"sku": "SHIRT-BLUE", "title": "Blue shirt", "internal_cost": 3.5,
         "variants": [{"size": "M", "stock": 4}, {"size": "L", "stock": 0}]},
        {"sku": "HAT-RED", "title": "Red hat", "internal_cost": 1.25,
         "variants": [{"size": "one", "stock": 9}]}
    ])
}

fn shop_state() -> serde_json::Value {
    json!({
        "products": products(),
        "_token": "secret",
        "cartCount": 0
    })
}

/// The canonical spelling: the reserved `item` name.
const SHOP_ITEM: &str = r#"
module Shop {
    Column {
        Text("Items: @{state.cartCount}")
        List(@state.products) {
            Column {
                Text("@{item.title}")
                Button("Add").onClick(@actions.addToCart, sku: @item.sku)
            }
        }
    }
}
"#;

/// The same template with a custom `as:` name — the spelling that lowers a
/// row reference to a data-source-shaped binding rather than an item one.
const SHOP_PRODUCT: &str = r#"
module Shop {
    Column {
        Text("Items: @{state.cartCount}")
        List(@state.products, as: product) {
            Column {
                Text("@{product.title}")
                Button("Add").onClick(@actions.addToCart, sku: @product.sku)
            }
        }
    }
}
"#;

fn shop(source: &str) -> Engine {
    app(source, "Shop", &["addToCart"], shop_state())
}

#[test]
fn the_collection_reads_as_its_rows_projected_to_the_rendered_fields() {
    let engine = shop(SHOP_ITEM);

    // Every row, in order, carrying the title the user sees and the sku the
    // row's button sends — and nothing else.
    assert_eq!(
        engine.get_state(None, Some("products")),
        Some(json!([
            {"title": "Blue shirt", "sku": "SHIRT-BLUE"},
            {"title": "Red hat", "sku": "HAT-RED"}
        ]))
    );

    // The whole-module read is projected the same way, beside the scalars
    // the template renders directly.
    assert_eq!(
        engine.get_state(None, None),
        Some(json!({
            "cartCount": 0,
            "products": [
                {"title": "Blue shirt", "sku": "SHIRT-BLUE"},
                {"title": "Red hat", "sku": "HAT-RED"}
            ]
        }))
    );
}

#[test]
fn a_row_is_addressable_by_index_and_only_its_rendered_fields_are() {
    let engine = shop(SHOP_ITEM);

    // Index addressing is the aiming primitive for a per-row action.
    assert_eq!(
        engine.get_state(None, Some("products.1")),
        Some(json!({"title": "Red hat", "sku": "HAT-RED"}))
    );
    assert_eq!(
        engine.get_state(None, Some("products.1.sku")),
        Some(json!("HAT-RED"))
    );

    // An unrendered row field is stripped from the whole-collection read
    // above, and refused when asked for directly.
    assert_eq!(
        engine.get_state(None, Some("products.0.internal_cost")),
        None
    );
    // Rendered-looking but not in the row: the same answer.
    assert_eq!(engine.get_state(None, Some("products.0.variants")), None);
    // Past the end reads as nothing — indistinguishable from a refusal, on
    // purpose.
    assert_eq!(engine.get_state(None, Some("products.9")), None);
    assert_eq!(engine.get_state(None, Some("products.9.sku")), None);
    // A wildcard is not something a caller can ask for.
    assert_eq!(engine.get_state(None, Some("products.*.sku")), None);
    assert_eq!(engine.get_state(None, Some("products.*")), None);
    // A non-numeric segment where the row index goes is not a row.
    assert_eq!(engine.get_state(None, Some("products.sku")), None);
}

#[test]
fn an_empty_collection_reads_as_empty_rather_than_refused() {
    let engine = app(
        SHOP_ITEM,
        "Shop",
        &["addToCart"],
        json!({"products": [], "cartCount": 0}),
    );
    // The list is declared and rendering nothing; that is an answer, and
    // the manifest publishes the collection on the strength of it.
    assert_eq!(engine.get_state(None, Some("products")), Some(json!([])));
    assert_eq!(engine.get_state(None, Some("products.0")), None);
    assert!(engine
        .mcp_manifest()
        .resources
        .iter()
        .any(|r| r.uri == "hypen://state/shop/products"));
}

#[test]
fn an_unrendered_top_level_path_is_still_refused() {
    let engine = shop(SHOP_ITEM);
    assert_eq!(engine.get_state(None, Some("_token")), None);
    assert!(engine
        .get_state(None, None)
        .expect("whole read")
        .get("_token")
        .is_none());
}

#[test]
fn a_row_field_never_becomes_a_top_level_path() {
    let engine = shop(SHOP_ITEM);
    // `@item.sku` is declared as `products.*.sku`, never as `sku`.
    assert_eq!(engine.get_state(None, Some("sku")), None);
    assert_eq!(engine.get_state(None, Some("title")), None);

    let mut with_top_level_sku = shop(SHOP_ITEM);
    with_top_level_sku.update_state(None, json!({"sku": "TOP-LEVEL"}));
    assert_eq!(
        with_top_level_sku.get_state(None, Some("sku")),
        None,
        "a top-level field that happens to share a row field's name is not rendered"
    );
}

#[test]
fn a_custom_item_name_yields_the_same_surface_as_the_reserved_one() {
    // The trap: `@product.sku` does not lower to an item binding, so a walk
    // gated on `is_item()` would declare nothing here and the two spellings
    // of one template would have different read surfaces.
    let canonical = shop(SHOP_ITEM);
    let custom = shop(SHOP_PRODUCT);

    for path in [
        None,
        Some("products"),
        Some("products.0"),
        Some("products.1.sku"),
    ] {
        assert_eq!(
            custom.get_state(None, path),
            canonical.get_state(None, path),
            "read of {path:?} differs between `as: product` and `item`"
        );
    }
    assert_eq!(
        custom.get_state(None, Some("products")),
        Some(json!([
            {"title": "Blue shirt", "sku": "SHIRT-BLUE"},
            {"title": "Red hat", "sku": "HAT-RED"}
        ]))
    );
    assert_eq!(
        custom.get_state(None, Some("products.0.internal_cost")),
        None
    );
}

#[test]
fn a_nested_for_each_projects_through_the_parent_row_and_declares_no_top_level_path() {
    let engine = app(
        r#"
        module Shop {
            List(@state.products, as: product) {
                Column {
                    Text("@{product.title}")
                    List(@item.variants, as: v) { Text("@{v.size}") }
                }
            }
        }
        "#,
        "Shop",
        &[],
        shop_state(),
    );

    // The inner loop's rows are the parent row's `variants`, projected to
    // `size`; `stock` was never rendered.
    assert_eq!(
        engine.get_state(None, Some("products")),
        Some(json!([
            {"title": "Blue shirt", "variants": [{"size": "M"}, {"size": "L"}]},
            {"title": "Red hat", "variants": [{"size": "one"}]}
        ]))
    );
    assert_eq!(
        engine.get_state(None, Some("products.0.variants.1.size")),
        Some(json!("L"))
    );
    assert_eq!(
        engine.get_state(None, Some("products.0.variants.1.stock")),
        None
    );

    // Nothing about the nested loop is a path of its own: `variants` is a
    // field of a row, not of the module.
    let mut with_phantom = app(
        r#"
        module Shop {
            List(@state.products, as: product) {
                List(@item.variants, as: v) { Text("@{v.size}") }
            }
        }
        "#,
        "Shop",
        &[],
        shop_state(),
    );
    with_phantom.update_state(None, json!({"variants": [{"size": "PHANTOM"}]}));
    assert_eq!(with_phantom.get_state(None, Some("variants")), None);
    assert_eq!(with_phantom.get_state(None, Some("size")), None);
    assert!(with_phantom
        .get_state(None, None)
        .expect("whole read")
        .get("variants")
        .is_none());
}

#[test]
fn a_data_source_for_each_declares_nothing() {
    let mut engine = app(
        r#"
        module Feed {
            Column {
                Text("@{state.title}")
                List(@spacetime.messages, as: m) {
                    Text("@{m.body}")
                    Button("Reply").onClick(@actions.reply, id: @m.id)
                    List(@m.replies, as: r) { Text("@{r.body}") }
                }
            }
        }
        "#,
        "Feed",
        &["reply"],
        json!({"title": "Feed", "messages": [{"body": "x", "id": 1}], "body": "b"}),
    );
    engine.set_context("spacetime", json!({"messages": [{"body": "hi", "id": 7}]}));

    // A provider's rows are not module state, so no wildcard path is minted
    // for them — and none of the row names surfaces as a module path either,
    // even where the module happens to hold a field of that name.
    for path in [
        "messages",
        "messages.0",
        "messages.0.body",
        "body",
        "id",
        "replies",
    ] {
        assert_eq!(engine.get_state(None, Some(path)), None, "{path}");
    }
    assert_eq!(engine.get_state(None, None), Some(json!({"title": "Feed"})));

    let manifest = engine.mcp_manifest();
    let paths: Vec<&str> = manifest
        .resources
        .iter()
        .map(|r| r.meta["dev.hypen/statePath"].as_str().expect("path"))
        .collect();
    assert_eq!(paths, vec!["title"]);
}

#[test]
fn the_manifest_publishes_one_resource_per_collection_naming_its_row_fields() {
    let engine = shop(SHOP_PRODUCT);
    let manifest = engine.mcp_manifest();

    let rows: Vec<&hypen_engine::agent::McpResource> = manifest
        .resources
        .iter()
        .filter(|r| r.uri.starts_with("hypen://state/shop/products"))
        .collect();
    assert_eq!(
        rows.len(),
        1,
        "one resource for the collection, not one per row field: {rows:?}"
    );
    let resource = rows[0];
    assert_eq!(resource.uri, "hypen://state/shop/products");
    assert_eq!(resource.meta["dev.hypen/statePath"], json!("products"));
    // Declared refs are kept sorted, so the fields list alphabetically.
    assert_eq!(
        resource.meta["dev.hypen/rowFields"],
        json!(["sku", "title"])
    );
    for field in ["title", "sku"] {
        assert!(
            resource.description.contains(field),
            "description must name '{field}' so an agent knows it is there before reading: {}",
            resource.description
        );
    }
    assert!(
        !resource.description.contains("internal_cost"),
        "{}",
        resource.description
    );

    // No wildcard leaks into the published surface anywhere.
    for r in &manifest.resources {
        assert!(!r.uri.contains('*'), "{}", r.uri);
        assert!(!r.name.contains('*'), "{}", r.name);
    }

    // Reading the resource by its own URI's module and path works, through
    // the projection.
    let module = resource
        .uri
        .trim_start_matches("hypen://state/")
        .split('/')
        .next()
        .unwrap();
    assert_eq!(
        engine.get_state(Some(module), Some("products")),
        Some(json!([
            {"title": "Blue shirt", "sku": "SHIRT-BLUE"},
            {"title": "Red hat", "sku": "HAT-RED"}
        ]))
    );
}

#[test]
fn the_per_row_tool_names_its_row_argument_and_where_to_read_rows() {
    for source in [SHOP_ITEM, SHOP_PRODUCT] {
        let engine = shop(source);
        let manifest = engine.mcp_manifest();
        let add = manifest
            .tools
            .iter()
            .find(|t| t.name == "addToCart")
            .expect("addToCart tool");

        assert!(
            add.input_schema["properties"].get("sku").is_some(),
            "schema must name the row argument: {}",
            add.input_schema
        );
        assert_eq!(add.meta["dev.hypen/perRow"], json!(true));
        assert_eq!(add.meta["dev.hypen/rows"], json!(["products"]));
        assert!(
            add.description.contains("'products'"),
            "the description must say where the rows are: {}",
            add.description
        );
    }
}
