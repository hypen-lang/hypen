//! Tests for src/reconcile/tree.rs - Instance tree and binding evaluation
//!
//! This file contains comprehensive tests for the instance tree operations,
//! parent-child relationships, props resolution, and binding evaluation.

mod common;

use common::*;
use hypen_engine::ir::{Element, Value};
use hypen_engine::reactive::Binding;
use hypen_engine::reconcile::tree::InstanceTree;
use serde_json::json;

// ============================================================================
// A. Tree Operations (8 tests)
// ============================================================================

#[test]
fn test_instance_tree_new_is_empty() {
    // GIVEN: New tree
    let tree = InstanceTree::new();

    // WHEN: Check root and iterate nodes
    // THEN: Root is None, no nodes
    assert!(tree.root().is_none());

    let node_count = tree.iter().count();
    assert_eq!(node_count, 0, "New tree should have no nodes");
}

#[test]
fn test_create_node_assigns_unique_id() {
    // GIVEN: Tree and two elements
    let mut tree = InstanceTree::new();
    let element1 = text_element("First");
    let element2 = text_element("Second");
    let state = json!({});

    // WHEN: create_node() twice
    let id1 = tree.create_node(&element1, &state);
    let id2 = tree.create_node(&element2, &state);

    // THEN: Different IDs assigned
    assert_ne!(id1, id2, "Each node should have unique ID");
}

#[test]
fn test_create_node_stores_element() {
    // GIVEN: Text element
    let mut tree = InstanceTree::new();
    let element = text_element("Hello");
    let state = json!({});

    // WHEN: create_node()
    let id = tree.create_node(&element, &state);

    // THEN: Node retrievable by ID
    let node = tree.get(id);
    assert!(node.is_some());
    assert_eq!(node.unwrap().element_type, "Text");
}

#[test]
fn test_get_node_returns_reference() {
    // GIVEN: Node created
    let mut tree = InstanceTree::new();
    let element = column_with_children(vec![]);
    let state = json!({});
    let id = tree.create_node(&element, &state);

    // WHEN: get()
    let node_ref = tree.get(id);

    // THEN: Returns Some(&Node)
    assert!(node_ref.is_some());
    assert_eq!(node_ref.unwrap().element_type, "Column");
}

#[test]
fn test_get_mut_node_allows_modification() {
    // GIVEN: Node created
    let mut tree = InstanceTree::new();
    let element = text_element("Original");
    let state = json!({});
    let id = tree.create_node(&element, &state);

    // WHEN: get_mut() and modify element_type (just for testing)
    if let Some(node) = tree.get_mut(id) {
        node.element_type = "ModifiedText".to_string();
    }

    // THEN: Changes persisted
    let node = tree.get(id).unwrap();
    assert_eq!(node.element_type, "ModifiedText");
}

#[test]
fn test_remove_node_deletes_from_tree() {
    // GIVEN: Node in tree
    let mut tree = InstanceTree::new();
    let element = text_element("To Remove");
    let state = json!({});
    let id = tree.create_node(&element, &state);

    assert!(tree.get(id).is_some());

    // WHEN: remove()
    let removed = tree.remove(id);

    // THEN: get() returns None, remove() returned the node
    assert!(removed.is_some());
    assert!(tree.get(id).is_none());
}

#[test]
fn test_clear_removes_all_nodes() {
    // GIVEN: Tree with 10 nodes
    let mut tree = InstanceTree::new();
    let state = json!({});

    for i in 0..10 {
        let element = text_element(&format!("Node {}", i));
        tree.create_node(&element, &state);
    }

    assert_eq!(tree.iter().count(), 10);

    // WHEN: clear()
    tree.clear();

    // THEN: All nodes removed
    assert_eq!(tree.iter().count(), 0);
    assert!(tree.root().is_none());
}

#[test]
fn test_set_root_and_get_root() {
    // GIVEN: Node ID
    let mut tree = InstanceTree::new();
    let element = column_with_children(vec![]);
    let state = json!({});
    let root_id = tree.create_node(&element, &state);

    // WHEN: set_root()
    tree.set_root(root_id);

    // THEN: root() returns correct ID
    assert_eq!(tree.root(), Some(root_id));
}

// ============================================================================
// B. Parent-Child Relationships (6 tests)
// ============================================================================

#[test]
fn test_add_child_appends_to_end() {
    // GIVEN: Parent with no children
    let mut tree = InstanceTree::new();
    let state = json!({});

    let parent_id = tree.create_node(&column_with_children(vec![]), &state);
    let child_id = tree.create_node(&text_element("Child"), &state);

    // WHEN: add_child(parent, child, None)
    tree.add_child(parent_id, child_id, None);

    // THEN: Child in parent.children, position 0
    let parent = tree.get(parent_id).unwrap();
    assert_eq!(parent.children.len(), 1);
    assert_eq!(parent.children[0], child_id);
}

#[test]
fn test_add_child_with_before_position() {
    // GIVEN: Parent with [A, C]
    let mut tree = InstanceTree::new();
    let state = json!({});

    let parent_id = tree.create_node(&column_with_children(vec![]), &state);
    let child_a = tree.create_node(&text_element("A"), &state);
    let child_c = tree.create_node(&text_element("C"), &state);

    tree.add_child(parent_id, child_a, None);
    tree.add_child(parent_id, child_c, None);

    // WHEN: add_child(parent, B, Some(C))
    let child_b = tree.create_node(&text_element("B"), &state);
    tree.add_child(parent_id, child_b, Some(child_c));

    // THEN: Children are [A, B, C]
    let parent = tree.get(parent_id).unwrap();
    assert_eq!(parent.children.len(), 3);
    assert_eq!(parent.children[0], child_a);
    assert_eq!(parent.children[1], child_b);
    assert_eq!(parent.children[2], child_c);
}

#[test]
fn test_add_child_updates_parent_reference() {
    // GIVEN: Child node
    let mut tree = InstanceTree::new();
    let state = json!({});

    let parent_id = tree.create_node(&column_with_children(vec![]), &state);
    let child_id = tree.create_node(&text_element("Child"), &state);

    // Verify child has no parent initially
    assert!(tree.get(child_id).unwrap().parent.is_none());

    // WHEN: add_child(parent, child)
    tree.add_child(parent_id, child_id, None);

    // THEN: child.parent == Some(parent_id)
    let child = tree.get(child_id).unwrap();
    assert_eq!(child.parent, Some(parent_id));
}

#[test]
fn test_remove_child_from_parent() {
    // GIVEN: Parent with [A, B, C]
    let mut tree = InstanceTree::new();
    let state = json!({});

    let parent_id = tree.create_node(&column_with_children(vec![]), &state);
    let child_a = tree.create_node(&text_element("A"), &state);
    let child_b = tree.create_node(&text_element("B"), &state);
    let child_c = tree.create_node(&text_element("C"), &state);

    tree.add_child(parent_id, child_a, None);
    tree.add_child(parent_id, child_b, None);
    tree.add_child(parent_id, child_c, None);

    // WHEN: remove_child(parent, B)
    tree.remove_child(parent_id, child_b);

    // THEN: Children are [A, C]
    let parent = tree.get(parent_id).unwrap();
    assert_eq!(parent.children.len(), 2);
    assert_eq!(parent.children[0], child_a);
    assert_eq!(parent.children[1], child_c);
}

#[test]
fn test_remove_child_clears_parent_reference() {
    // GIVEN: Child with parent
    let mut tree = InstanceTree::new();
    let state = json!({});

    let parent_id = tree.create_node(&column_with_children(vec![]), &state);
    let child_id = tree.create_node(&text_element("Child"), &state);

    tree.add_child(parent_id, child_id, None);
    assert!(tree.get(child_id).unwrap().parent.is_some());

    // WHEN: remove_child()
    tree.remove_child(parent_id, child_id);

    // THEN: child.parent == None
    let child = tree.get(child_id).unwrap();
    assert!(child.parent.is_none());
}

#[test]
fn test_add_multiple_children_preserves_order() {
    // GIVEN: Parent
    let mut tree = InstanceTree::new();
    let state = json!({});

    let parent_id = tree.create_node(&column_with_children(vec![]), &state);

    // WHEN: add_child() 5 times
    let mut child_ids = Vec::new();
    for i in 0..5 {
        let child_id = tree.create_node(&text_element(&format!("Child {}", i)), &state);
        tree.add_child(parent_id, child_id, None);
        child_ids.push(child_id);
    }

    // THEN: Children in insertion order
    let parent = tree.get(parent_id).unwrap();
    assert_eq!(parent.children.len(), 5);
    for (i, &expected_id) in child_ids.iter().enumerate() {
        assert_eq!(parent.children[i], expected_id);
    }
}

// ============================================================================
// C. Props Resolution (6 tests)
// ============================================================================

#[test]
fn test_resolve_props_static_value_passthrough() {
    // GIVEN: Element with static prop
    let mut tree = InstanceTree::new();
    let element = Element::new("Text").with_prop("text", Value::Static(json!("Static")));
    let state = json!({});

    // WHEN: create_node (which calls resolve_props internally)
    let id = tree.create_node(&element, &state);

    // THEN: Props unchanged
    let node = tree.get(id).unwrap();
    assert_eq!(node.props.get("text"), Some(&json!("Static")));
}

#[test]
fn test_resolve_props_simple_binding() {
    // GIVEN: Element with binding, state has the value
    let mut tree = InstanceTree::new();
    let element = Element::new("Text").with_prop(
        "name",
        Value::Binding(Binding::state(vec!["user".to_string()])),
    );
    let state = json!({"user": "Ian"});

    // WHEN: create_node
    let id = tree.create_node(&element, &state);

    // THEN: Binding resolved
    let node = tree.get(id).unwrap();
    assert_eq!(node.props.get("name"), Some(&json!("Ian")));
}

#[test]
fn test_resolve_props_nested_binding() {
    // GIVEN: Element with nested binding
    let mut tree = InstanceTree::new();
    let element = Element::new("Text").with_prop(
        "text",
        Value::Binding(Binding::state(vec![
            "user".to_string(),
            "profile".to_string(),
            "name".to_string(),
        ])),
    );
    let state = json!({
        "user": {
            "profile": {
                "name": "Alice"
            }
        }
    });

    // WHEN: create_node
    let id = tree.create_node(&element, &state);

    // THEN: Nested path resolved
    let node = tree.get(id).unwrap();
    assert_eq!(node.props.get("text"), Some(&json!("Alice")));
}

#[test]
fn test_resolve_props_action_serialization() {
    // GIVEN: Element with action
    let mut tree = InstanceTree::new();
    let element = Element::new("Button").with_prop("onClick", Value::Action("submit".to_string()));
    let state = json!({});

    // WHEN: create_node
    let id = tree.create_node(&element, &state);

    // THEN: Action serialized with @ prefix
    let node = tree.get(id).unwrap();
    assert_eq!(node.props.get("onClick"), Some(&json!("@submit")));
}

#[test]
fn test_resolve_props_multiple_bindings() {
    // GIVEN: Element with multiple bindings
    let mut tree = InstanceTree::new();
    let mut element = Element::new("Text");
    element.props.insert(
        "firstName".to_string(),
        Value::Binding(Binding::state(vec!["first".to_string()])),
    );
    element.props.insert(
        "lastName".to_string(),
        Value::Binding(Binding::state(vec!["last".to_string()])),
    );

    let state = json!({"first": "John", "last": "Doe"});

    // WHEN: create_node
    let id = tree.create_node(&element, &state);

    // THEN: Both resolved
    let node = tree.get(id).unwrap();
    assert_eq!(node.props.get("firstName"), Some(&json!("John")));
    assert_eq!(node.props.get("lastName"), Some(&json!("Doe")));
}

#[test]
fn test_resolve_props_with_missing_binding() {
    // GIVEN: Binding references nonexistent state path
    let mut tree = InstanceTree::new();
    let element = Element::new("Text").with_prop(
        "missing",
        Value::Binding(Binding::state(vec!["nonexistent".to_string()])),
    );
    let state = json!({"other": "value"});

    // WHEN: create_node
    let id = tree.create_node(&element, &state);

    // THEN: Returns null for missing path
    let node = tree.get(id).unwrap();
    assert_eq!(node.props.get("missing"), Some(&json!(null)));
}

// ============================================================================
// D. Binding Evaluation (5 tests)
// Note: evaluate_binding is private, so we test it indirectly through node creation
// There's also an existing test in tree.rs:test_evaluate_binding
// ============================================================================

#[test]
fn test_binding_evaluation_simple_path() {
    // GIVEN: Binding "name", state {name: "Ian"}
    let mut tree = InstanceTree::new();
    let element = Element::new("Text").with_prop(
        "text",
        Value::Binding(Binding::state(vec!["name".to_string()])),
    );
    let state = json!({"name": "Ian"});

    // WHEN: create_node (evaluates binding internally)
    let id = tree.create_node(&element, &state);

    // THEN: Resolved to "Ian"
    let node = tree.get(id).unwrap();
    assert_eq!(node.props.get("text"), Some(&json!("Ian")));
}

#[test]
fn test_binding_evaluation_nested_path() {
    // GIVEN: Binding "user.profile.age"
    let mut tree = InstanceTree::new();
    let element = Element::new("Text").with_prop(
        "age",
        Value::Binding(Binding::state(vec![
            "user".to_string(),
            "profile".to_string(),
            "age".to_string(),
        ])),
    );
    let state = json!({
        "user": {
            "profile": {
                "age": 30
            }
        }
    });

    // WHEN: create_node
    let id = tree.create_node(&element, &state);

    // THEN: Resolved to 30
    let node = tree.get(id).unwrap();
    assert_eq!(node.props.get("age"), Some(&json!(30)));
}

#[test]
fn test_binding_evaluation_missing_path() {
    // GIVEN: Binding "nonexistent"
    let mut tree = InstanceTree::new();
    let element = Element::new("Text").with_prop(
        "text",
        Value::Binding(Binding::state(vec!["nonexistent".to_string()])),
    );
    let state = json!({"other": "value"});

    // WHEN: create_node
    let id = tree.create_node(&element, &state);

    // THEN: Returns null
    let node = tree.get(id).unwrap();
    assert_eq!(node.props.get("text"), Some(&json!(null)));
}

#[test]
fn test_binding_evaluation_array_index() {
    // GIVEN: Binding "items.0", state {items: [10, 20]}
    // Note: serde_json's .get() with string "0" doesn't work on arrays
    // Arrays need numeric indices. This test documents current behavior.
    let mut tree = InstanceTree::new();
    let element = Element::new("Text").with_prop(
        "value",
        Value::Binding(Binding::state(vec!["items".to_string(), "0".to_string()])),
    );
    let state = json!({"items": [10, 20]});

    // WHEN: create_node
    let id = tree.create_node(&element, &state);

    // THEN: Currently returns null (string "0" doesn't work on array)
    // TODO: This is a limitation - array index access needs to parse "0" as number
    let node = tree.get(id).unwrap();
    assert_eq!(node.props.get("value"), Some(&json!(null)));

    // However, if we use a different state structure with "0" as object key, it works:
    let element2 = Element::new("Text").with_prop(
        "value",
        Value::Binding(Binding::state(vec![
            "items".to_string(),
            "first".to_string(),
        ])),
    );
    let state2 = json!({"items": {"first": 10, "second": 20}});
    let id2 = tree.create_node(&element2, &state2);
    let node2 = tree.get(id2).unwrap();
    assert_eq!(node2.props.get("value"), Some(&json!(10)));
}

#[test]
fn test_update_props_re_evaluates_bindings() {
    // GIVEN: Node with binding, state changes
    let mut tree = InstanceTree::new();
    let element = Element::new("Text").with_prop(
        "count",
        Value::Binding(Binding::state(vec!["count".to_string()])),
    );
    let initial_state = json!({"count": 5});

    let id = tree.create_node(&element, &initial_state);

    // Verify initial value
    assert_eq!(tree.get(id).unwrap().props.get("count"), Some(&json!(5)));

    // WHEN: Update state and call update_props
    let new_state = json!({"count": 10});
    if let Some(node) = tree.get_mut(id) {
        node.update_props(&new_state);
    }

    // THEN: Props re-evaluated with new state
    let node = tree.get(id).unwrap();
    assert_eq!(node.props.get("count"), Some(&json!(10)));
}

#[test]
fn test_refresh_dynamic_props_touches_only_bound_props() {
    use hypen_engine::reconcile::tree::PropDelta;

    // GIVEN: a node with many static props and one binding
    let mut element = Element::new("Text").with_prop(
        "count",
        Value::Binding(Binding::state(vec!["count".to_string()])),
    );
    for i in 0..10 {
        element = element.with_prop(format!("style{i}"), Value::Static(json!(i)));
    }
    element = element.with_prop("onClick", Value::Action("tap".to_string()));
    let mut tree = InstanceTree::new();
    let id = tree.create_node(&element, &json!({"count": 5}));

    // WHEN: the bound state changes
    let deltas = tree
        .get_mut(id)
        .unwrap()
        .refresh_dynamic_props(&json!({"count": 6}), None)
        .expect("in-place refresh");

    // THEN: exactly the binding is reported, and every prop (static ones
    //       included) still reads correctly from the node
    assert_eq!(deltas, vec![PropDelta::Set("count".to_string(), json!(6))]);
    let node = tree.get(id).unwrap();
    assert_eq!(node.props.get("count"), Some(&json!(6)));
    assert_eq!(node.props.get("style3"), Some(&json!(3)));
    assert_eq!(node.props.get("onClick"), Some(&json!("@tap")));
    assert_eq!(node.props.len(), 12);

    // AND: an unchanged state reports nothing
    let deltas = tree
        .get_mut(id)
        .unwrap()
        .refresh_dynamic_props(&json!({"count": 6}), None)
        .expect("in-place refresh");
    assert!(deltas.is_empty());
}

#[test]
fn test_refresh_dynamic_props_handles_absent_switches() {
    use hypen_engine::reconcile::tree::PropDelta;

    // GIVEN: a `.states`-style switch with no default: present only when
    //        the state matches a case
    let mut cases = indexmap::IndexMap::new();
    cases.insert("on".to_string(), json!(1.0));
    let element = Element::new("Box").with_prop(
        "opacity",
        Value::StateSwitch {
            path: "pose".to_string(),
            cases,
            default: None,
        },
    );
    let mut tree = InstanceTree::new();
    let id = tree.create_node(&element, &json!({"pose": "on"}));
    assert_eq!(
        tree.get(id).unwrap().props.get("opacity"),
        Some(&json!(1.0))
    );

    // WHEN: the switch stops matching → the prop is removed in place
    let deltas = tree
        .get_mut(id)
        .unwrap()
        .refresh_dynamic_props(&json!({"pose": "off"}), None)
        .expect("in-place refresh");
    assert_eq!(deltas, vec![PropDelta::Removed("opacity".to_string())]);
    assert!(!tree.get(id).unwrap().props.contains_key("opacity"));

    // WHEN: it matches again → the in-place path declines (the key must
    //       return to its raw position) and leaves the node untouched
    let refreshed = tree
        .get_mut(id)
        .unwrap()
        .refresh_dynamic_props(&json!({"pose": "on"}), None);
    assert!(refreshed.is_none());
    assert!(!tree.get(id).unwrap().props.contains_key("opacity"));
}
