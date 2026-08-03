//! Test file to verify the common test utilities module works

mod common;

use common::*;
use hypen_engine::ir::IRNode;
use serde_json::json;

/// Extract Element from IRNode for test assertions
fn ir_element(node: &IRNode) -> &hypen_engine::ir::Element {
    match node {
        IRNode::Element(e) => e,
        _ => panic!("Expected Element, got {:?}", node),
    }
}

#[test]
fn test_text_element_fixture() {
    // GIVEN: Create a text element
    let elem = text_element("Hello");

    // THEN: It has the correct structure
    assert_element_type(&elem, "Text");
    assert_has_prop(&elem, "text");
}

#[test]
fn test_column_fixture() {
    // GIVEN: Create a column with children
    let elem = column_with_children(vec![text_element("A"), text_element("B")]);

    // THEN: It has 2 children
    assert_element_type(&elem, "Column");
    assert_has_children(&elem, 2);
}

#[test]
fn test_nested_tree_fixture() {
    // GIVEN: Create nested tree
    let tree = nested_tree();

    // THEN: Root is Column with 3 children
    assert_element_type(&tree, "Column");
    assert_has_children(&tree, 3);

    // AND: Second child is a Row with 2 children
    assert_element_type(ir_element(&tree.ir_children[1]), "Row");
    assert_has_children(ir_element(&tree.ir_children[1]), 2);
}

#[test]
fn test_deep_tree_fixture() {
    // GIVEN: Create a deep tree with 10 levels
    let tree = deep_tree(10);

    // THEN: Root is a Column
    assert_element_type(&tree, "Column");

    // AND: It has exactly 1 child (nested structure)
    assert_has_children(&tree, 1);
}

#[test]
fn test_wide_tree_fixture() {
    // GIVEN: Create a wide tree with 100 children
    let tree = wide_tree(100);

    // THEN: Root has 100 children
    assert_element_type(&tree, "Column");
    assert_has_children(&tree, 100);
}

#[test]
fn test_module_fixtures() {
    // GIVEN: Create various module instances
    let user_mod = user_module();
    let counter_mod = counter_module();
    let list_mod = list_module();

    // THEN: They have the expected state
    assert_json_path(user_mod.get_state(), "user.name");
    assert_json_path(counter_mod.get_state(), "count");
    assert_json_path(list_mod.get_state(), "items");
}

#[test]
fn test_path_helpers() {
    // GIVEN: Various paths
    // WHEN/THEN: Split works correctly
    assert_eq!(split_path("user.name"), vec!["user", "name"]);

    // AND: Prefix checking works
    assert!(is_path_prefix("user", "user.name"));
    assert!(!is_path_prefix("user.name", "user"));

    // AND: Parent path works
    assert_eq!(
        parent_path("user.profile.name"),
        Some("user.profile".to_string())
    );
    assert_eq!(parent_path("user"), None);
}

#[test]
fn test_patch_matchers() {
    use hypen_engine::reconcile::Patch;

    // GIVEN: Various patch types
    let create_patch = Patch::Create {
        id: "node-1".to_string(),
        element_type: "Text".to_string(),
        props: std::sync::Arc::new(indexmap::indexmap! {}),
        semantics: None,
    };

    let set_prop_patch = Patch::SetProp {
        id: "node-2".to_string(),
        name: "color".to_string(),
        value: json!("red"),
    };

    // WHEN/THEN: Matchers work correctly
    assert_create_patch(&create_patch, "Text");
    assert_set_prop_patch(&set_prop_patch, "color");

    // AND: Count functions work
    let patches = vec![create_patch.clone(), set_prop_patch.clone()];
    assert_eq!(count_creates(&patches), 1);
    assert_eq!(count_set_props(&patches), 1);
}

#[test]
fn test_value_matchers() {
    use hypen_engine::ir::Value;
    use hypen_engine::reactive::Binding;

    // GIVEN: Different value types
    let static_val = Value::Static(json!("Hello"));
    let binding_val = Value::Binding(Binding::state(vec!["user".to_string(), "name".to_string()]));
    let action_val = Value::Action("signIn".to_string());

    // WHEN/THEN: Matchers work correctly
    assert_static_value(&static_val, &json!("Hello"));
    assert_binding_value(&binding_val, "user.name");
    assert_action_value(&action_val, "signIn");
}
