//! Custom ForEach item names (`as: "opt"`) in template substitution.
//!
//! `parse_binding` deliberately recognises only `state.` / `item.` inside
//! `@{...}` — unknown prefixes must not silently become data-source
//! bindings — so a template like `"@{opt.label}"` reaches iteration with no
//! parsed item bindings. Substitution therefore detects the iteration
//! variable textually, at the one point where the custom name is known.

use hypen_engine::ir::ast_to_ir_node;
use hypen_engine::reactive::DependencyGraph;
use hypen_engine::reconcile::{reconcile_ir, InstanceTree, Patch};
use hypen_parser::parse_component;
use serde_json::json;

/// Parse, expand, and reconcile `source` against `state`; return the patches.
fn render(source: &str, state: &serde_json::Value) -> Vec<Patch> {
    let component = parse_component(source).unwrap();
    let ir = ast_to_ir_node(&component);
    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();
    reconcile_ir(&mut tree, &ir, None, state, &mut deps)
}

/// The resolved positional (`"0"`) prop of every created Text node, in order.
fn text_props(patches: &[Patch]) -> Vec<serde_json::Value> {
    patches
        .iter()
        .filter_map(|p| match p {
            Patch::Create {
                element_type,
                props,
                ..
            } if element_type == "Text" => props.get("0").cloned(),
            _ => None,
        })
        .collect()
}

#[test]
fn custom_item_name_substitutes_in_text_template() {
    let state = json!({"xs": [
        {"id": 1, "label": "Apple"},
        {"id": 2, "label": "Pear"}
    ]});
    let patches = render(
        r#"Column {
            ForEach(items: @state.xs, as: "opt") {
                Text("@{opt.label}")
            }
        }"#,
        &state,
    );
    assert_eq!(text_props(&patches), vec![json!("Apple"), json!("Pear")]);
}

#[test]
fn custom_item_name_mixed_with_state_binding() {
    let state = json!({
        "prefix": "Fruit",
        "xs": [{"label": "Apple"}, {"label": "Pear"}]
    });
    let patches = render(
        r#"Column {
            ForEach(items: @state.xs, as: "opt") {
                Text("@{state.prefix}: @{opt.label}")
            }
        }"#,
        &state,
    );
    assert_eq!(
        text_props(&patches),
        vec![json!("Fruit: Apple"), json!("Fruit: Pear")]
    );
}

#[test]
fn custom_item_name_nested_path() {
    let state = json!({"xs": [
        {"user": {"name": "Ada"}},
        {"user": {"name": "Grace"}}
    ]});
    let patches = render(
        r#"Column {
            ForEach(items: @state.xs, as: "opt") {
                Text("@{opt.user.name}")
            }
        }"#,
        &state,
    );
    assert_eq!(text_props(&patches), vec![json!("Ada"), json!("Grace")]);
}

#[test]
fn custom_item_name_pure_ref_preserves_json_type() {
    // A whole-template ref ("@{opt.count}") resolves to the item value
    // itself, not a stringified copy — matching the Value::Binding path
    // that the default "item" name takes.
    let state = json!({"xs": [{"count": 5}]});
    let patches = render(
        r#"Column {
            ForEach(items: @state.xs, as: "opt") {
                Text("@{opt.count}")
            }
        }"#,
        &state,
    );
    assert_eq!(text_props(&patches), vec![json!(5)]);
}

#[test]
fn custom_item_name_bare_ref_over_scalar_items() {
    let state = json!({"xs": ["alpha", "beta"]});
    let patches = render(
        r#"Column {
            ForEach(items: @state.xs, as: "opt") {
                Text("Value: @{opt}")
            }
        }"#,
        &state,
    );
    assert_eq!(
        text_props(&patches),
        vec![json!("Value: alpha"), json!("Value: beta")]
    );
}

#[test]
fn custom_item_name_in_expression() {
    let state = json!({"xs": [{"count": 5}, {"count": 1}]});
    let patches = render(
        r#"Column {
            ForEach(items: @state.xs, as: "opt") {
                Text("@{opt.count > 1 ? 'many' : 'one'}")
            }
        }"#,
        &state,
    );
    assert_eq!(text_props(&patches), vec![json!("many"), json!("one")]);
}

#[test]
fn custom_item_name_id_applicator_resolves_per_item_semantics() {
    // The "auto-minted option ids" case from the relationships design,
    // written with a custom `as:` name — the `@{item.x}` version lives in
    // test_reactive_semantics.rs::foreach_items_mint_ids_from_item_data.
    let state = json!({
        "options": [
            {"id": "apple", "label": "Apple"},
            {"id": "pear",  "label": "Pear"}
        ],
        "focused": "opt-apple"
    });
    let patches = render(
        r#"Column {
            ForEach(items: @state.options, as: "opt") {
                Text("@{opt.label}").role("option").id("opt-@{opt.id}")
            }
        }.role("listbox").activedescendant(@state.focused)"#,
        &state,
    );

    let option_ids: Vec<String> = patches
        .iter()
        .filter_map(|p| match p {
            Patch::Create {
                semantics: Some(s), ..
            } if s.role == Some(hypen_engine::ir::Role::OptionItem) => s.id.clone(),
            _ => None,
        })
        .collect();
    assert_eq!(option_ids, vec!["opt-apple".to_string(), "opt-pear".to_string()]);

    let listbox = patches
        .iter()
        .find_map(|p| match p {
            Patch::Create {
                semantics: Some(s), ..
            } if s.role == Some(hypen_engine::ir::Role::Listbox) => Some(s.clone()),
            _ => None,
        })
        .expect("listbox container");
    assert_eq!(listbox.active_descendant.as_deref(), Some("opt-apple"));
}

#[test]
fn default_item_name_pure_binding_unchanged() {
    let state = json!({"xs": [{"label": "Apple"}, {"label": "Pear"}]});
    let patches = render(
        r#"Column {
            ForEach(items: @state.xs) {
                Text("@{item.label}")
            }
        }"#,
        &state,
    );
    assert_eq!(text_props(&patches), vec![json!("Apple"), json!("Pear")]);
}

#[test]
fn default_item_name_template_unchanged() {
    let state = json!({"xs": [{"label": "Apple"}, {"label": "Pear"}]});
    let patches = render(
        r#"Column {
            ForEach(items: @state.xs) {
                Text("Item: @{item.label}")
            }
        }"#,
        &state,
    );
    assert_eq!(
        text_props(&patches),
        vec![json!("Item: Apple"), json!("Item: Pear")]
    );
}
