//! Tests for src/reconcile/diff.rs - Core reconciliation algorithm
//!
//! This file contains comprehensive tests for the reconciliation system,
//! covering initial tree creation, list rendering, props diffing, and node reconciliation.

mod common;

use common::*;
use hypen_engine::ir::{Element, IRNode, Value};
use hypen_engine::reactive::{Binding, DependencyGraph};
use hypen_engine::reconcile::{diff::*, InstanceTree, Patch};
use serde_json::json;

thread_local! {
    // One expander per test thread (libtest runs each test on its own
    // thread): registrations persist across a test's successive batches,
    // exactly like a boundary's session-lifetime expander.
    static EXPANDER: std::cell::RefCell<hypen_engine::TemplateExpander> =
        std::cell::RefCell::new(hypen_engine::TemplateExpander::new());
}

/// Shadows [`hypen_engine::reconcile::diff::reconcile_ir`] (glob import):
/// reconcile, then lower template patches the way every plain-patch
/// boundary does — these tests assert the pre-template Create/Insert wire.
fn reconcile_ir(
    tree: &mut InstanceTree,
    node: &IRNode,
    parent_id: Option<hypen_engine::ir::NodeId>,
    state: &serde_json::Value,
    dependencies: &mut DependencyGraph,
) -> Vec<Patch> {
    let patches = hypen_engine::reconcile::reconcile_ir(tree, node, parent_id, state, dependencies);
    EXPANDER.with(|e| e.borrow_mut().expand(patches))
}

// ============================================================================
// A. Initial Tree Creation (6 tests)
// ============================================================================

#[test]
fn test_create_tree_single_text_node() {
    // GIVEN: Text("Hello") element
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let element = text_element("Hello");
    let state = json!({});

    // WHEN: reconcile() (initial render)
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Emits Create{Text} + Insert{root} patches
    assert_eq!(patches.len(), 2);
    assert_has_create(&patches);

    // Verify root insert patch exists
    let root_insert = patches
        .iter()
        .any(|p| matches!(p, Patch::Insert { parent_id, .. } if parent_id.as_ref() == "root"));
    assert!(root_insert, "Expected Insert patch into 'root' container");
}

#[test]
fn test_create_tree_column_with_two_children() {
    // GIVEN: Column { Text("A"), Text("B") }
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let element = column_with_children(vec![text_element("A"), text_element("B")]);
    let state = json!({});

    // WHEN: reconcile() (initial render)
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Creates 3 nodes (Column + 2 Text), correct insertion order
    // Patches: Create(Column), Insert(Column->root), Create(Text), Insert(Text->Column), Create(Text), Insert(Text->Column)
    assert_eq!(patches.len(), 6);
    assert_eq!(count_creates(&patches), 3);
    assert_eq!(count_inserts(&patches), 3);
}

#[test]
fn test_create_tree_populates_dependency_graph() {
    // GIVEN: Text with @{state.name} binding
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let element = text_element_with_binding("name");
    let state = json!({"name": "Alice"});

    // WHEN: reconcile() (initial render)
    let _patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );
    let node_id = tree.root().expect("Should have root after initial render");

    // THEN: Dependency graph has entry for "name" -> node_id
    let affected_nodes = dependencies.get_affected_nodes("name");
    assert!(
        affected_nodes.contains(&node_id),
        "Dependency graph should track binding for node"
    );
}

#[test]
fn test_create_tree_assigns_unique_ids() {
    // GIVEN: Tree with 5 nodes: Column { Text, Row { Text, Text }, Text }
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let element = column_with_children(vec![
        text_element("A"),
        row_with_children(vec![text_element("B"), text_element("C")]),
        text_element("D"),
    ]);
    let state = json!({});

    // WHEN: reconcile() (which calls create_tree internally and sets root)
    reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: All node IDs unique
    // Tree structure: Column, Text("A"), Row, Text("B"), Text("C"), Text("D")
    // That's 6 nodes total (Column + 1 Text + Row + 2 Text children of Row + 1 Text)
    let node_ids = collect_node_ids(&tree);
    let unique_count = node_ids
        .iter()
        .collect::<std::collections::HashSet<_>>()
        .len();
    assert_eq!(
        node_ids.len(),
        unique_count,
        "All node IDs should be unique"
    );
    assert_eq!(
        node_ids.len(),
        6,
        "Should have 6 nodes (Column + Text + Row + 2 Text + Text)"
    );
}

#[test]
fn test_create_tree_with_events() {
    // GIVEN: Button with onClick: @actions.submit
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let element = button_with_action("Click me", "submit");
    let state = json!({});

    // WHEN: reconcile() (initial render)
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Action is serialized in props with @ prefix
    // Note: Event handling moved to renderer level, so we check props instead of AttachEvent patches
    let create_patch = patches.iter().find(|p| matches!(p, Patch::Create { .. }));
    assert!(create_patch.is_some(), "Should have Create patch");

    if let Some(Patch::Create { props, .. }) = create_patch {
        // Check if onClick prop has @submit value
        let has_action = props
            .get("onClick")
            .map(|v| v.as_str() == Some("@submit"))
            .unwrap_or(false);
        assert!(has_action, "onClick prop should be '@submit'");
    }
}

#[test]
fn test_create_tree_patch_ordering() {
    // GIVEN: Column { Text("Hello") }
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let element = column_with_children(vec![text_element("Hello")]);
    let state = json!({});

    // WHEN: reconcile() (initial render)
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Patches in order: Create(Column), Insert(Column->root), Create(Text), Insert(Text->Column)
    assert_eq!(patches.len(), 4);

    // Verify ordering
    assert_create_patch(&patches[0], "Column");
    assert_insert_patch(&patches[1]); // Column into root
    assert_create_patch(&patches[2], "Text");
    assert_insert_patch(&patches[3]); // Text into Column
}

// ============================================================================
// B. List/Array Rendering (12 tests)
// ============================================================================

#[test]
fn test_create_list_tree_with_array_binding() {
    // GIVEN: List element with @{state.items} binding, items = [{name: "A"}, {name: "B"}]
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    // Create a List element with prop "0" as array binding
    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    // Add child template with @{item.name} binding
    list.ir_children
        .push(IRNode::Element(text_element_with_binding("item.name")));

    let state = json!({
        "items": [
            {"name": "A"},
            {"name": "B"}
        ]
    });

    // WHEN: create_tree() (which calls create_list_tree internally)
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Creates container + 2 child nodes with substituted bindings
    // Patches: Create(List), Insert(List->root), Create(Text), Insert(Text->List), Create(Text), Insert(Text->List)
    assert_eq!(
        count_creates(&patches),
        3,
        "Should create List + 2 Text nodes"
    );

    // Verify items have correct text values ("A" and "B")
    let text_creates: Vec<_> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Text" {
                    props.get("text").cloned()
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect();

    assert_eq!(text_creates.len(), 2);
    assert!(text_creates.contains(&json!("A")));
    assert!(text_creates.contains(&json!("B")));
}

#[test]
fn test_list_item_binding_replacement_simple() {
    // GIVEN: List with @{item.name} in template, one item {name: "Alice"}
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children
        .push(IRNode::Element(text_element_with_binding("item.name")));

    let state = json!({"items": [{"name": "Alice"}]});

    // WHEN: create_tree() (internally calls replace_item_bindings)
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Text node created with static value "Alice"
    let text_creates: Vec<_> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Text" {
                    props.get("text").cloned()
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect();

    assert_eq!(text_creates.len(), 1);
    assert_eq!(text_creates[0], json!("Alice"));
}

#[test]
fn test_list_item_binding_replacement_nested() {
    // GIVEN: List with @{item.profile.avatar.url} binding
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut image = Element::new("Image");
    image.props.insert(
        "src".to_string(),
        Value::Binding(Binding::item(vec![
            "profile".to_string(),
            "avatar".to_string(),
            "url".to_string(),
        ])),
    );

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["users".to_string()])),
    );
    list.ir_children.push(IRNode::Element(image));

    let state = json!({
        "users": [{
            "profile": {
                "avatar": {
                    "url": "https://example.com/avatar.jpg"
                }
            }
        }]
    });

    // WHEN: create_tree()
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Image created with resolved URL
    let image_creates: Vec<_> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Image" {
                    props.get("src").cloned()
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect();

    assert_eq!(image_creates.len(), 1);
    assert_eq!(image_creates[0], json!("https://example.com/avatar.jpg"));
}

#[test]
fn test_list_item_binding_with_index() {
    // GIVEN: List with @{item.images.0.url} (accessing array element in item)
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut image = Element::new("Image");
    image.props.insert(
        "src".to_string(),
        Value::Binding(Binding::item(vec![
            "images".to_string(),
            "0".to_string(),
            "url".to_string(),
        ])),
    );

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["products".to_string()])),
    );
    list.ir_children.push(IRNode::Element(image));

    let state = json!({
        "products": [{
            "images": [
                {"url": "first.jpg"},
                {"url": "second.jpg"}
            ]
        }]
    });

    // WHEN: create_tree()
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Image created with first image URL
    let image_creates: Vec<_> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Image" {
                    props.get("src").cloned()
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect();

    assert_eq!(image_creates.len(), 1);
    assert_eq!(image_creates[0], json!("first.jpg"));
}

#[test]
fn test_list_rendering_empty_array() {
    // GIVEN: List element with empty array
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children
        .push(IRNode::Element(text_element("Template")));

    let state = json!({"items": []});

    // WHEN: create_tree()
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Only container created, no children
    assert_eq!(
        count_creates(&patches),
        1,
        "Should only create List container"
    );
    assert_create_patch(&patches[0], "List");
}

#[test]
fn test_list_rendering_array_with_three_items() {
    // GIVEN: Array with 3 items
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children
        .push(IRNode::Element(text_element_with_binding("item.value")));

    let state = json!({
        "items": [
            {"value": "First"},
            {"value": "Second"},
            {"value": "Third"}
        ]
    });

    // WHEN: create_tree()
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: 4 nodes created (List + 3 Text) with correct values
    assert_eq!(count_creates(&patches), 4);

    let text_values: Vec<_> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Text" {
                    props.get("text").cloned()
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect();

    assert_eq!(text_values.len(), 3);
    assert!(text_values.contains(&json!("First")));
    assert!(text_values.contains(&json!("Second")));
    assert!(text_values.contains(&json!("Third")));
}

#[test]
fn test_list_reconciliation_item_added() {
    // GIVEN: List with 2 items rendered
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children
        .push(IRNode::Element(text_element_with_binding("item.value")));

    let initial_state = json!({"items": [{"value": "A"}, {"value": "B"}]});

    // Initial render
    let initial_patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &initial_state,
        &mut dependencies,
    );
    assert_eq!(count_creates(&initial_patches), 3); // List + 2 items

    // WHEN: Array grows to 3 items
    let new_state = json!({
        "items": [
            {"value": "A"},
            {"value": "B"},
            {"value": "C"}
        ]
    });

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &new_state,
        &mut dependencies,
    );

    // THEN: Remove old items and create new ones
    // Current implementation removes all and recreates (not optimized yet)
    assert!(
        count_removes(&patches) > 0 || count_creates(&patches) > 0,
        "Should have patches for added item"
    );
}

#[test]
fn test_list_reconciliation_item_removed() {
    // GIVEN: List with 3 items
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children
        .push(IRNode::Element(text_element_with_binding("item.value")));

    let initial_state = json!({
        "items": [
            {"value": "A"},
            {"value": "B"},
            {"value": "C"}
        ]
    });

    reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &initial_state,
        &mut dependencies,
    );

    // WHEN: Array shrinks to 2
    let new_state = json!({"items": [{"value": "A"}, {"value": "B"}]});
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &new_state,
        &mut dependencies,
    );

    // THEN: Remove patches generated
    assert!(
        count_removes(&patches) > 0,
        "Should have Remove patches for deleted item"
    );
}

#[test]
fn test_list_reconciliation_items_reordered() {
    // GIVEN: [A, B, C]
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children
        .push(IRNode::Element(text_element_with_binding("item.value")));

    let initial_state = json!({
        "items": [
            {"value": "A"},
            {"value": "B"},
            {"value": "C"}
        ]
    });

    reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &initial_state,
        &mut dependencies,
    );

    // WHEN: Becomes [C, B, A]
    let new_state = json!({
        "items": [
            {"value": "C"},
            {"value": "B"},
            {"value": "A"}
        ]
    });
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &new_state,
        &mut dependencies,
    );

    // THEN: Patches generated (Move patches when keyed reconciliation implemented)
    // Current implementation: removes and recreates
    assert!(
        !patches.is_empty(),
        "Should generate patches for reordering"
    );
    // Note: Keyed reconciliation not yet implemented, so we get Remove + Create instead of Move
}

#[test]
fn test_list_with_static_and_binding_content() {
    // GIVEN: List with Text element containing static string with @{item.name} pattern
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut text = Element::new("Text");
    text.props.insert(
        "text".to_string(),
        Value::Static(json!("Name: @{item.name}")),
    );

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["users".to_string()])),
    );
    list.ir_children.push(IRNode::Element(text));

    let state = json!({"users": [{"name": "Alice"}]});

    // WHEN: create_tree()
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Static parts preserved, @{item.name} substituted
    let text_creates: Vec<_> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Text" {
                    props.get("text").cloned()
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect();

    assert_eq!(text_creates.len(), 1);
    assert_eq!(text_creates[0], json!("Name: Alice"));
}

#[test]
fn test_list_item_key_extraction() {
    // GIVEN: List with items (keys should be assigned to generated children)
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children
        .push(IRNode::Element(text_element("Template")));

    let state = json!({
        "items": [
            {"id": "item-1"},
            {"id": "item-2"},
            {"id": "item-3"}
        ]
    });

    // WHEN: reconcile()
    reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Keys assigned from item.id (item-item-1, item-item-2, item-item-3)
    // Since items have id field, keys use "item-{id}" format for stable identity
    let node_ids = collect_node_ids(&tree);
    let text_nodes: Vec<_> = node_ids
        .iter()
        .filter_map(|&id| tree.get(id))
        .filter(|n| n.element_type == "Text")
        .collect();

    assert_eq!(text_nodes.len(), 3);

    // Collect all keys (order may vary depending on tree traversal)
    let keys: Vec<_> = text_nodes.iter().filter_map(|n| n.key.clone()).collect();
    assert_eq!(keys.len(), 3, "All text nodes should have keys");
    // generate_item_key auto-detects the `id` field on object items, so the
    // keys come straight from `item.id` regardless of position. With no
    // explicit `key:` annotation, that's the desired stable-identity behavior.
    assert!(keys.contains(&"item-1".to_string()));
    assert!(keys.contains(&"item-2".to_string()));
    assert!(keys.contains(&"item-3".to_string()));
}

#[test]
fn test_array_binding_detection() {
    // GIVEN: Various elements
    let list_with_binding = {
        let mut e = Element::new("List");
        e.props.insert(
            "0".to_string(),
            Value::Binding(Binding::state(vec!["items".to_string()])),
        );
        e.ir_children.push(IRNode::Element(text_element("Child"))); // Has children
        e
    };

    let text_with_binding = {
        let mut e = Element::new("Text");
        e.props.insert(
            "0".to_string(),
            Value::Binding(Binding::state(vec!["text".to_string()])),
        );
        // No children
        e
    };

    let list_with_static = {
        let mut e = Element::new("Route");
        e.props
            .insert("0".to_string(), Value::Static(json!("/home")));
        e.ir_children.push(IRNode::Element(text_element("Child")));
        e
    };

    // THEN: Correctly identifies iterable elements
    // List with binding + children = iterable
    let is_iterable1 =
        list_with_binding.props.get("0").is_some() && !list_with_binding.ir_children.is_empty();
    assert!(
        is_iterable1,
        "List with prop '0' binding and children should be iterable"
    );

    // Text with binding but no children = NOT iterable
    let is_iterable2 =
        text_with_binding.props.get("0").is_some() && !text_with_binding.ir_children.is_empty();
    assert!(
        !is_iterable2,
        "Text with prop '0' binding but no children is NOT iterable"
    );

    // Route with static value = NOT iterable (even with children)
    let is_binding = matches!(list_with_static.props.get("0"), Some(Value::Binding(_)));
    assert!(
        !is_binding,
        "Route with static prop '0' is NOT an array binding"
    );
}

// ============================================================================
// C. Props Diffing (10 tests)
// ============================================================================

#[test]
fn test_diff_props_no_changes() {
    // GIVEN: Old and new props identical
    use hypen_engine::ir::NodeId;
    use indexmap::indexmap;

    let node_id = NodeId::default();
    let old_props = indexmap! {
        "color".to_string() => json!("red"),
        "size".to_string() => json!(16),
    };
    let new_props = old_props.clone();

    // WHEN: diff_props()
    let patches = diff_props(node_id, &old_props, &new_props);

    // THEN: No SetProp patches
    assert_no_changes(&patches);
}

#[test]
fn test_diff_props_value_changed() {
    // GIVEN: Old {color: "red"}, new {color: "blue"}
    use hypen_engine::ir::NodeId;
    use indexmap::indexmap;

    let node_id = NodeId::default();
    let old_props = indexmap! {
        "color".to_string() => json!("red"),
        "size".to_string() => json!(16),
    };
    let new_props = indexmap! {
        "color".to_string() => json!("blue"),
        "size".to_string() => json!(16),
    };

    // WHEN: diff_props()
    let patches = diff_props(node_id, &old_props, &new_props);

    // THEN: SetProp{color, "blue"}
    assert_eq!(patches.len(), 1);
    assert_set_prop_patch(&patches[0], "color");
    assert_set_prop_value(&patches[0], "color", &json!("blue"));
}

#[test]
fn test_diff_props_prop_added() {
    // GIVEN: Old {}, new {fontSize: 18}
    use hypen_engine::ir::NodeId;
    use indexmap::indexmap;

    let node_id = NodeId::default();
    let old_props = indexmap! {};
    let new_props = indexmap! {
        "fontSize".to_string() => json!(18),
    };

    // WHEN: diff_props()
    let patches = diff_props(node_id, &old_props, &new_props);

    // THEN: SetProp{fontSize, 18}
    assert_eq!(patches.len(), 1);
    assert_set_prop_patch(&patches[0], "fontSize");
    assert_set_prop_value(&patches[0], "fontSize", &json!(18));
}

#[test]
fn test_diff_props_prop_removed() {
    // GIVEN: Old {padding: 16}, new {}
    use hypen_engine::ir::NodeId;
    use indexmap::indexmap;

    let node_id = NodeId::default();
    let old_props = indexmap! {
        "padding".to_string() => json!(16),
    };
    let new_props = indexmap! {};

    // WHEN: diff_props()
    let patches = diff_props(node_id, &old_props, &new_props);

    // THEN: Should emit a RemoveProp patch for the removed property
    assert_eq!(patches.len(), 1);
    match &patches[0] {
        Patch::RemoveProp { name, .. } => {
            assert_eq!(name, "padding");
        }
        _ => panic!("Expected RemoveProp patch, got {:?}", patches[0]),
    }
}

#[test]
fn test_diff_props_with_binding_evaluation() {
    // GIVEN: Element with binding that needs resolution
    use hypen_engine::ir::NodeId;
    use indexmap::indexmap;

    let node_id = NodeId::default();

    // Old props (resolved binding)
    let old_props = indexmap! {
        "name".to_string() => json!("Alice"),
    };

    // New props (binding should be evaluated to "Ian")
    let new_props = indexmap! {
        "name".to_string() => json!("Ian"),
    };

    // WHEN: diff_props()
    let patches = diff_props(node_id, &old_props, &new_props);

    // THEN: SetProp{name, "Ian"}
    assert_eq!(patches.len(), 1);
    assert_set_prop_value(&patches[0], "name", &json!("Ian"));
}

#[test]
fn test_diff_props_action_serialization() {
    // GIVEN: Prop with action value
    use hypen_engine::ir::NodeId;
    use indexmap::indexmap;

    let node_id = NodeId::default();
    let old_props = indexmap! {};
    let new_props = indexmap! {
        "onClick".to_string() => json!("@submit"), // Actions serialized with @ prefix
    };

    // WHEN: diff_props()
    let patches = diff_props(node_id, &old_props, &new_props);

    // THEN: Value serialized as "@submit"
    assert_eq!(patches.len(), 1);
    assert_set_prop_value(&patches[0], "onClick", &json!("@submit"));
}

#[test]
fn test_diff_props_all_types() {
    // GIVEN: Props with string, number, boolean, object, array
    use hypen_engine::ir::NodeId;
    use indexmap::indexmap;

    let node_id = NodeId::default();
    let old_props = indexmap! {};
    let new_props = indexmap! {
        "text".to_string() => json!("Hello"),
        "count".to_string() => json!(42),
        "enabled".to_string() => json!(true),
        "config".to_string() => json!({"width": 100, "height": 200}),
        "tags".to_string() => json!(["primary", "action"]),
    };

    // WHEN: diff_props()
    let patches = diff_props(node_id, &old_props, &new_props);

    // THEN: All types handled correctly
    assert_eq!(patches.len(), 5);
    assert_set_prop_value(&patches[0], "text", &json!("Hello"));
    assert_set_prop_value(&patches[1], "count", &json!(42));
    assert_set_prop_value(&patches[2], "enabled", &json!(true));
}

#[test]
fn test_diff_props_null_vs_undefined() {
    // GIVEN: Props with null and undefined (represented as Null in serde_json)
    use hypen_engine::ir::NodeId;
    use indexmap::indexmap;

    let node_id = NodeId::default();
    let old_props = indexmap! {
        "value".to_string() => json!(null),
    };
    let new_props = indexmap! {
        "value".to_string() => json!(null),
    };

    // WHEN: diff_props()
    let patches = diff_props(node_id, &old_props, &new_props);

    // THEN: No changes (both null)
    assert_eq!(patches.len(), 0);
}

#[test]
fn test_diff_props_binding_to_static() {
    // GIVEN: Old prop with binding (resolved to "Dynamic"), new with static "Static"
    use hypen_engine::ir::NodeId;
    use indexmap::indexmap;

    let node_id = NodeId::default();
    let old_props = indexmap! {
        "text".to_string() => json!("Dynamic"),
    };
    let new_props = indexmap! {
        "text".to_string() => json!("Static"),
    };

    // WHEN: diff_props()
    let patches = diff_props(node_id, &old_props, &new_props);

    // THEN: SetProp with static value
    assert_eq!(patches.len(), 1);
    assert_set_prop_value(&patches[0], "text", &json!("Static"));
}

#[test]
fn test_diff_props_static_to_binding() {
    // GIVEN: Old prop static "Static", new with binding (resolved to "Dynamic")
    use hypen_engine::ir::NodeId;
    use indexmap::indexmap;

    let node_id = NodeId::default();
    let old_props = indexmap! {
        "text".to_string() => json!("Static"),
    };
    let new_props = indexmap! {
        "text".to_string() => json!("Dynamic"),
    };

    // WHEN: diff_props()
    let patches = diff_props(node_id, &old_props, &new_props);

    // THEN: SetProp with evaluated binding
    assert_eq!(patches.len(), 1);
    assert_set_prop_value(&patches[0], "text", &json!("Dynamic"));
}

// ============================================================================
// D. Node Reconciliation (8 tests)
// ============================================================================

#[test]
fn test_reconcile_node_no_changes() {
    // GIVEN: Old and new elements identical
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let element = text_element("Hello");
    let state = json!({});

    // Initial render
    let initial_patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );
    assert!(!initial_patches.is_empty());

    // WHEN: reconcile with same element
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Empty patch list (no changes)
    assert_no_changes(&patches);
}

#[test]
fn test_reconcile_node_props_changed() {
    // GIVEN: Same element type, different props
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    // Initial render with color: red
    let mut initial = Element::new("Text");
    initial
        .props
        .insert("color".to_string(), Value::Static(json!("red")));
    reconcile_ir(
        &mut tree,
        &IRNode::Element(initial.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // WHEN: Reconcile with color: blue
    let mut updated = Element::new("Text");
    updated
        .props
        .insert("color".to_string(), Value::Static(json!("blue")));
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(updated.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: SetProp patches
    assert_eq!(count_set_props(&patches), 1);
    assert_set_prop_value(&patches[0], "color", &json!("blue"));
}

#[test]
fn test_reconcile_node_element_type_changed() {
    // GIVEN: Old Text, new Image
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    // Initial render with Text
    reconcile_ir(
        &mut tree,
        &IRNode::Element(text_element("Hello").clone()),
        None,
        &state,
        &mut dependencies,
    );
    let old_root = tree.root().expect("Should have root after first render");

    // WHEN: Reconcile with Image (different element type)
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(image_element("test.jpg").clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Should have Remove + Create + Insert patches
    assert!(count_removes(&patches) >= 1, "Should remove old Text node");
    assert!(count_creates(&patches) >= 1, "Should create new Image node");
    assert!(count_inserts(&patches) >= 1, "Should insert new Image node");

    // Verify the tree has a new root with correct type
    let new_root = tree.root().expect("Should have root after reconcile");
    assert_ne!(old_root, new_root, "Root node should be replaced");
    let new_root_node = tree.get(new_root).expect("New root should exist");
    assert_eq!(
        new_root_node.element_type, "Image",
        "New root should be Image"
    );
}

#[test]
fn test_reconcile_node_element_type_changed_with_subtree() {
    // GIVEN: Old Column with two Text children
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    let old_tree = column_with_children(vec![text_element("First"), text_element("Second")]);

    reconcile_ir(
        &mut tree,
        &IRNode::Element(old_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );
    let old_root = tree.root().expect("Should have root");

    // WHEN: Replace entire tree with a Button
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(button_element("Click me").clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: One Remove for the old subtree ROOT (Column) — descendants are
    // swept by the renderer, so they get no Removes of their own — plus one
    // Create for the new Button.
    assert_eq!(
        count_removes(&patches),
        1,
        "Removing the old subtree is a single root Remove, got {patches:?}"
    );
    assert!(count_creates(&patches) >= 1, "Should create new Button");

    // Verify tree structure
    let new_root = tree.root().expect("Should have new root");
    assert_ne!(old_root, new_root, "Root should be replaced");
    let new_node = tree.get(new_root).expect("New root should exist");
    assert_eq!(new_node.element_type, "Button");
    assert!(
        new_node.children.is_empty(),
        "Button should have no children"
    );
}

#[test]
fn test_reconcile_child_element_type_changed() {
    // GIVEN: Column with [Text, Text]
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    let old_tree = column_with_children(vec![text_element("First"), text_element("Second")]);

    reconcile_ir(
        &mut tree,
        &IRNode::Element(old_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );
    let root_id = tree.root().expect("Should have root");
    let old_children = tree.get(root_id).unwrap().children.clone();
    assert_eq!(old_children.len(), 2);

    // WHEN: Replace first child with Image (Column with [Image, Text])
    let new_tree = column_with_children(vec![image_element("photo.jpg"), text_element("Second")]);

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(new_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: First child should be replaced
    assert!(count_removes(&patches) >= 1, "Should remove old Text");
    assert!(count_creates(&patches) >= 1, "Should create new Image");

    // Verify tree structure
    let root = tree.get(root_id).expect("Root should still exist");
    assert_eq!(root.children.len(), 2, "Should still have 2 children");

    // First child should be Image (different from old)
    let first_child = tree
        .get(root.children[0])
        .expect("First child should exist");
    assert_eq!(
        first_child.element_type, "Image",
        "First child should be Image"
    );
    assert_ne!(
        root.children[0], old_children[0],
        "First child ID should change"
    );

    // Second child should remain Text (same element, just reconciled)
    let second_child = tree
        .get(root.children[1])
        .expect("Second child should exist");
    assert_eq!(
        second_child.element_type, "Text",
        "Second child should be Text"
    );
}

#[test]
fn test_reconcile_middle_child_element_type_changed() {
    // GIVEN: Column with [Text("A"), Text("B"), Text("C")]
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    let old_tree = column_with_children(vec![
        text_element("A"),
        text_element("B"),
        text_element("C"),
    ]);

    reconcile_ir(
        &mut tree,
        &IRNode::Element(old_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );
    let root_id = tree.root().expect("Should have root");
    let old_children = tree.get(root_id).unwrap().children.clone();

    // WHEN: Replace middle child with Button (Column with [Text, Button, Text])
    let new_tree = column_with_children(vec![
        text_element("A"),
        button_element("Click"),
        text_element("C"),
    ]);

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(new_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Middle child should be replaced
    assert!(
        count_removes(&patches) >= 1,
        "Should remove old middle Text"
    );
    assert!(count_creates(&patches) >= 1, "Should create new Button");

    // Verify tree structure - order should be preserved
    let root = tree.get(root_id).expect("Root should exist");
    assert_eq!(root.children.len(), 3, "Should still have 3 children");

    let first_child = tree.get(root.children[0]).expect("First child");
    let middle_child = tree.get(root.children[1]).expect("Middle child");
    let last_child = tree.get(root.children[2]).expect("Last child");

    assert_eq!(first_child.element_type, "Text", "First should be Text");
    assert_eq!(
        middle_child.element_type, "Button",
        "Middle should be Button"
    );
    assert_eq!(last_child.element_type, "Text", "Last should be Text");

    // Middle child ID should have changed
    assert_ne!(
        root.children[1], old_children[1],
        "Middle child should be replaced"
    );
}

#[test]
fn test_reconcile_last_child_element_type_changed() {
    // GIVEN: Column with [Text("A"), Text("B")]
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    let old_tree = column_with_children(vec![text_element("A"), text_element("B")]);

    reconcile_ir(
        &mut tree,
        &IRNode::Element(old_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );
    let root_id = tree.root().expect("Should have root");

    // WHEN: Replace last child with Image (Column with [Text, Image])
    let new_tree = column_with_children(vec![text_element("A"), image_element("photo.jpg")]);

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(new_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Last child should be replaced, no Move patch needed (no next sibling)
    assert!(count_removes(&patches) >= 1, "Should remove old last Text");
    assert!(count_creates(&patches) >= 1, "Should create new Image");

    // No Move patches should be generated for last child replacement
    let move_count = count_moves(&patches);
    assert_eq!(move_count, 0, "No Move patch needed for last child");

    // Verify tree structure
    let root = tree.get(root_id).expect("Root should exist");
    assert_eq!(root.children.len(), 2);

    let last_child = tree.get(root.children[1]).expect("Last child");
    assert_eq!(last_child.element_type, "Image");
}

#[test]
fn test_reconcile_element_type_change_clears_bindings() {
    // GIVEN: Column with Text that has a state binding
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"user": {"name": "Alice"}});

    let old_tree = column_with_children(vec![text_element_with_binding("user.name")]);

    reconcile_ir(
        &mut tree,
        &IRNode::Element(old_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );
    let root_id = tree.root().expect("Should have root");
    let old_text_id = tree.get(root_id).unwrap().children[0];

    // Verify binding was registered
    let affected_before = dependencies.get_affected_nodes("user.name");
    assert!(
        affected_before.contains(&old_text_id),
        "Old Text should have binding"
    );

    // WHEN: Replace Text with Image (no bindings)
    let new_tree = column_with_children(vec![image_element("photo.jpg")]);

    reconcile_ir(
        &mut tree,
        &IRNode::Element(new_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Old binding should be cleared
    let affected_after = dependencies.get_affected_nodes("user.name");
    assert!(
        !affected_after.contains(&old_text_id),
        "Old binding should be removed"
    );
}

#[test]
fn test_reconcile_element_type_change_registers_new_bindings() {
    // GIVEN: Column with static Image
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"user": {"avatar": "default.jpg"}});

    let old_tree = column_with_children(vec![image_element("static.jpg")]);

    reconcile_ir(
        &mut tree,
        &IRNode::Element(old_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // Verify no bindings initially
    let affected_before = dependencies.get_affected_nodes("user.avatar");
    assert!(affected_before.is_empty(), "No bindings initially");

    // WHEN: Replace Image with Text that has binding
    let new_tree = column_with_children(vec![text_element_with_binding("user.avatar")]);

    reconcile_ir(
        &mut tree,
        &IRNode::Element(new_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );
    let root_id = tree.root().expect("Should have root");
    let new_text_id = tree.get(root_id).unwrap().children[0];

    // THEN: New binding should be registered
    let affected_after = dependencies.get_affected_nodes("user.avatar");
    assert!(
        affected_after.contains(&new_text_id),
        "New Text should have binding"
    );
}

#[test]
fn test_reconcile_replace_leaf_with_subtree() {
    // GIVEN: Column with single Text child
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    let old_tree = column_with_children(vec![text_element("Simple")]);

    reconcile_ir(
        &mut tree,
        &IRNode::Element(old_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // WHEN: Replace Text with a Row containing multiple children
    let new_child = row_with_children(vec![text_element("Left"), text_element("Right")]);
    let new_tree = column_with_children(vec![new_child]);

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(new_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Should remove 1 (Text) and create 3 (Row + 2 Text)
    assert!(count_removes(&patches) >= 1, "Should remove old Text");
    assert!(
        count_creates(&patches) >= 3,
        "Should create Row + 2 children"
    );

    // Verify tree structure
    let root_id = tree.root().expect("Should have root");
    let root = tree.get(root_id).unwrap();
    assert_eq!(root.children.len(), 1);

    let row = tree.get(root.children[0]).expect("Row should exist");
    assert_eq!(row.element_type, "Row");
    assert_eq!(row.children.len(), 2, "Row should have 2 children");
}

#[test]
fn test_reconcile_multiple_type_changes_same_pass() {
    // GIVEN: Column with [Text, Text, Text]
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    let old_tree = column_with_children(vec![
        text_element("First"),
        text_element("Second"),
        text_element("Third"),
    ]);

    reconcile_ir(
        &mut tree,
        &IRNode::Element(old_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // WHEN: Replace first and third with different types
    let new_tree = column_with_children(vec![
        button_element("Click"),  // was Text
        text_element("Second"),   // unchanged
        image_element("img.jpg"), // was Text
    ]);

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(new_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Should have 2 removes and 2 creates
    assert!(count_removes(&patches) >= 2, "Should remove 2 old nodes");
    assert!(count_creates(&patches) >= 2, "Should create 2 new nodes");

    // Verify tree structure
    let root_id = tree.root().expect("Should have root");
    let root = tree.get(root_id).unwrap();
    assert_eq!(root.children.len(), 3);

    let first = tree.get(root.children[0]).unwrap();
    let second = tree.get(root.children[1]).unwrap();
    let third = tree.get(root.children[2]).unwrap();

    assert_eq!(first.element_type, "Button");
    assert_eq!(second.element_type, "Text");
    assert_eq!(third.element_type, "Image");
}

#[test]
fn test_reconcile_node_children_added() {
    // GIVEN: Old Column{}, new Column{Text}
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    // Initial render with empty Column
    reconcile_ir(
        &mut tree,
        &IRNode::Element(Element::new("Column").clone()),
        None,
        &state,
        &mut dependencies,
    );

    // WHEN: Reconcile with Column containing Text child
    let updated = column_with_children(vec![text_element("Hello")]);
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(updated.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Create + Insert for child
    assert!(count_creates(&patches) >= 1, "Should create new child");
    assert!(count_inserts(&patches) >= 1, "Should insert new child");
}

#[test]
fn test_reconcile_node_children_removed() {
    // GIVEN: Old Column{Text}, new Column{}
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    // Initial render with Column containing child
    let initial = column_with_children(vec![text_element("Hello")]);
    reconcile_ir(
        &mut tree,
        &IRNode::Element(initial.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // WHEN: Reconcile with empty Column
    let updated = Element::new("Column");
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(updated.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Remove patch for child
    assert!(count_removes(&patches) >= 1, "Should remove deleted child");
}

#[test]
fn test_reconcile_node_children_reordered() {
    // GIVEN: Old [Text("A"), Text("B")]
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    let initial = column_with_children(vec![
        keyed_text_element("A", "key-a"),
        keyed_text_element("B", "key-b"),
    ]);
    reconcile_ir(
        &mut tree,
        &IRNode::Element(initial.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // WHEN: Reorder to [Text("B"), Text("A")]
    let updated = column_with_children(vec![
        keyed_text_element("B", "key-b"),
        keyed_text_element("A", "key-a"),
    ]);
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(updated.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Patches generated (Move patches when keyed reconciliation implemented)
    // Note: Keyed reconciliation not yet fully implemented
    assert!(
        !patches.is_empty(),
        "Should generate patches for reordering"
    );
}

#[test]
fn test_reconcile_node_with_lazy_flag() {
    // GIVEN: Element with __lazy: true
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    let mut lazy_element = Element::new("LazyComponent");
    lazy_element
        .props
        .insert("__lazy".to_string(), Value::Static(json!(true)));
    // Add child component that should NOT be rendered
    lazy_element
        .ir_children
        .push(IRNode::Element(Element::new("ExpensiveChild")));

    // WHEN: create_tree() with lazy element
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(lazy_element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Children not rendered
    // Should only have Create for LazyComponent + Insert, not ExpensiveChild
    assert_eq!(
        count_creates(&patches),
        1,
        "Lazy element should not render children"
    );
    assert_create_patch(&patches[0], "LazyComponent");

    // Verify __lazy_child prop is added if there are children
    if let Patch::Create { props, .. } = &patches[0] {
        let has_lazy_child = props.contains_key("__lazy_child");
        assert!(has_lazy_child, "Lazy element should have __lazy_child prop");
    }
}

#[test]
fn test_reconcile_node_deep_tree() {
    // GIVEN: 5 levels deep, change at leaf
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    // Create deep tree: Column > Column > Column > Column > Text("Leaf")
    let initial = deep_tree(5);
    reconcile_ir(
        &mut tree,
        &IRNode::Element(initial.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // WHEN: Change leaf text
    // Build the updated tree with modified leaf
    // deep_tree(5) creates: wrap text in 5 columns
    // So we need to create text("Changed") wrapped in 5 columns
    let mut leaf = text_element("Changed");
    // Wrap it in 5 Columns to match deep_tree(5)
    for _ in 0..5 {
        leaf = column_with_children(vec![leaf]);
    }
    let updated = leaf;

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(updated.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Only leaf node updated (minimal patches)
    assert!(count_set_props(&patches) >= 1, "Should update leaf node");
    // Should not recreate the entire tree
    assert_eq!(count_creates(&patches), 0, "Should not create new nodes");
}

// ============================================================================
// E. Edge Cases (4 tests)
// ============================================================================

#[test]
fn test_create_tree_empty_element() {
    // GIVEN: Element with no props, no children
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let element = Element::new("Empty");
    let state = json!({});

    // WHEN: create_tree()
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: No crash, element created successfully
    assert_eq!(count_creates(&patches), 1);
    assert_create_patch(&patches[0], "Empty");
}

#[test]
fn test_reconcile_very_large_tree_1000_nodes() {
    use std::time::Instant;

    // GIVEN: Tree with 1000 nodes (wide tree)
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    let large_tree = wide_tree(1000);
    reconcile_ir(
        &mut tree,
        &IRNode::Element(large_tree.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // WHEN: Reconcile with small change (modify first child)
    let mut updated = wide_tree(1000);
    // Get mutable access to the first child Element inside IRNode
    if let IRNode::Element(ref mut first_child) = updated.ir_children[0] {
        first_child
            .props
            .insert("modified".to_string(), Value::Static(json!(true)));
    }

    let start = Instant::now();
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(updated.clone()),
        None,
        &state,
        &mut dependencies,
    );
    let duration = start.elapsed();

    // THEN: Completes in reasonable time (<1s)
    assert!(
        duration.as_secs() < 1,
        "Reconciliation should complete in <1s, took {:?}",
        duration
    );

    // Only first child should be updated
    assert!(
        count_set_props(&patches) >= 1,
        "Should update modified node"
    );
}

#[test]
fn test_reconcile_deeply_nested_bindings() {
    // GIVEN: @{state.a.b.c.d.e.f.g.h}
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut element = Element::new("Text");
    element.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec![
            "a".to_string(),
            "b".to_string(),
            "c".to_string(),
            "d".to_string(),
            "e".to_string(),
            "f".to_string(),
            "g".to_string(),
            "h".to_string(),
        ])),
    );

    let state = json!({
        "a": {
            "b": {
                "c": {
                    "d": {
                        "e": {
                            "f": {
                                "g": {
                                    "h": "Deep Value"
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    // WHEN: Reconcile with deeply nested binding
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Binding evaluated correctly
    let create_patch = patches.iter().find(|p| matches!(p, Patch::Create { .. }));
    assert!(create_patch.is_some());

    if let Some(Patch::Create { props, .. }) = create_patch {
        let text_value = props.get("text");
        assert_eq!(
            text_value,
            Some(&json!("Deep Value")),
            "Deeply nested binding should be resolved"
        );
    }
}

#[test]
fn test_create_tree_with_duplicate_keys() {
    // GIVEN: Two children with same key
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let element = column_with_children(vec![
        keyed_text_element("First", "duplicate-key"),
        keyed_text_element("Second", "duplicate-key"),
    ]);
    let state = json!({});

    // WHEN: reconcile()
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Both nodes created (warning logged internally, keys made unique by NodeId)
    // Current implementation doesn't enforce unique keys, just uses them for reconciliation
    assert_eq!(count_creates(&patches), 3, "Should create all nodes");

    // Verify both Text nodes have the same key
    let node_ids = collect_node_ids(&tree);
    let text_nodes: Vec<_> = node_ids
        .iter()
        .filter_map(|&id| tree.get(id))
        .filter(|n| n.element_type == "Text")
        .collect();

    assert_eq!(text_nodes.len(), 2);
    assert_eq!(
        text_nodes[0].key, text_nodes[1].key,
        "Both should have duplicate key"
    );
}

// ============================================================================
// H. Deferred remove protocol (`transition` flag on Remove)
// ============================================================================

use hypen_engine::reconcile::node_id_str;

/// A Row carrying an `.exit(...)` spec, as the Phase-1 lowering emits it.
fn exiting_row(children: Vec<Element>) -> Element {
    let mut row = Element::new("Row").with_prop(
        "__anim.exit",
        Value::Static(json!({"presets": ["fade"], "duration": 150, "curve": "easeIn"})),
    );
    for child in children {
        row = row.with_child(child);
    }
    row
}

fn expect_remove(patch: &Patch) -> (&str, bool) {
    match patch {
        Patch::Remove { id, transition } => (id.as_ref(), *transition),
        other => panic!("Expected Remove patch, got {:?}", other),
    }
}

#[test]
fn test_remove_exit_root_flagged_and_emitted_first() {
    // GIVEN: Column { Text("keep"), Row.exit { Text("inner") } } rendered
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});
    let initial = column_with_children(vec![
        text_element("keep"),
        exiting_row(vec![text_element("inner")]),
    ]);
    reconcile_ir(
        &mut tree,
        &IRNode::Element(initial),
        None,
        &state,
        &mut dependencies,
    );

    let root = tree.root().expect("root");
    let row_id = *tree.get(root).unwrap().children.get(1).expect("row child");
    let inner_id = *tree
        .get(row_id)
        .unwrap()
        .children
        .get(0)
        .expect("inner text");

    // WHEN: The Row subtree leaves (excess-children removal)
    let updated = column_with_children(vec![text_element("keep")]);
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(updated),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Flagged root Remove FIRST, then the descendant as a plain Remove
    assert_eq!(patches.len(), 2, "got {:?}", patches);
    assert_eq!(
        expect_remove(&patches[0]),
        (node_id_str(row_id).as_ref(), true)
    );
    assert_eq!(
        expect_remove(&patches[1]),
        (node_id_str(inner_id).as_ref(), false)
    );
}

#[test]
fn test_remove_parent_without_exit_wins_over_exiting_child() {
    // GIVEN: Column { Text("keep"), Row { Text.exit } } — only the CHILD
    // carries an exit spec; the removal root (Row) does not.
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});
    let exiting_text = Element::new("Text")
        .with_prop("text", Value::Static(json!("inner")))
        .with_prop(
            "__anim.exit",
            Value::Static(json!({"presets": ["fade"], "duration": 150, "curve": "easeIn"})),
        );
    let initial = column_with_children(vec![
        text_element("keep"),
        Element::new("Row").with_child(exiting_text),
    ]);
    reconcile_ir(
        &mut tree,
        &IRNode::Element(initial),
        None,
        &state,
        &mut dependencies,
    );

    let root = tree.root().expect("root");
    let row_id = *tree.get(root).unwrap().children.get(1).expect("row child");
    let inner_id = *tree
        .get(row_id)
        .unwrap()
        .children
        .get(0)
        .expect("inner text");

    // WHEN: The Row subtree leaves
    let updated = column_with_children(vec![text_element("keep")]);
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(updated),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Parent-remove-wins — a single plain Remove for the removal root.
    // The child's exit spec is never consulted because it isn't the removal
    // root, so nothing on the wire is flagged and the child gets no Remove of
    // its own (the renderer sweeps the subtree).
    assert_eq!(patches.len(), 1, "got {:?}", patches);
    assert_eq!(
        expect_remove(&patches[0]),
        (node_id_str(row_id).as_ref(), false)
    );
    assert!(
        !patches
            .iter()
            .any(|p| matches!(p, Patch::Remove { id, .. } if id.as_ref() == node_id_str(inner_id).as_ref())),
        "the exiting descendant must not surface its own Remove: {patches:?}"
    );
}

#[test]
fn test_remove_non_animated_ordering_and_wire_format_unchanged() {
    // GIVEN: Column { Text("keep"), Row { Text("a"), Text("b") } } — no
    // animation props anywhere.
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});
    let initial = column_with_children(vec![
        text_element("keep"),
        row_with_children(vec![text_element("a"), text_element("b")]),
    ]);
    reconcile_ir(
        &mut tree,
        &IRNode::Element(initial),
        None,
        &state,
        &mut dependencies,
    );

    let root = tree.root().expect("root");
    let row_id = *tree.get(root).unwrap().children.get(1).expect("row child");
    let a_id = *tree.get(row_id).unwrap().children.get(0).expect("text a");
    let b_id = *tree.get(row_id).unwrap().children.get(1).expect("text b");

    // WHEN: The Row subtree leaves
    let updated = column_with_children(vec![text_element("keep")]);
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(updated),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Exactly ONE Remove — the subtree root — and the serialized wire
    // format carries no `transition` field at all. Descendants are the
    // renderer's to sweep (same contract the keyed list teardown has always
    // used), so `a` and `b` never appear on the wire.
    assert_eq!(patches.len(), 1, "got {:?}", patches);
    assert_eq!(
        expect_remove(&patches[0]),
        (node_id_str(row_id).as_ref(), false)
    );
    for descendant in [a_id, b_id] {
        let id = node_id_str(descendant);
        assert!(
            !patches
                .iter()
                .any(|p| matches!(p, Patch::Remove { id: pid, .. } if pid == &id)),
            "descendant {id} must not get a Remove of its own: {patches:?}"
        );
    }
    let wire = serde_json::to_string(&patches).unwrap();
    assert!(
        !wire.contains("transition"),
        "non-animated removals must be wire-identical to the pre-flag protocol: {wire}"
    );
}

#[test]
fn test_replace_subtree_flags_exiting_root() {
    // GIVEN: a rendered Row.exit { Text("inner") }
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});
    reconcile_ir(
        &mut tree,
        &IRNode::Element(exiting_row(vec![text_element("inner")])),
        None,
        &state,
        &mut dependencies,
    );
    let row_id = tree.root().expect("root");
    let inner_id = *tree
        .get(row_id)
        .unwrap()
        .children
        .get(0)
        .expect("inner text");

    // WHEN: The element type changes, replacing the whole subtree
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(column_with_children(vec![])),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: The old subtree's removal leads with the flagged root
    assert_eq!(
        expect_remove(&patches[0]),
        (node_id_str(row_id).as_ref(), true)
    );
    assert_eq!(
        expect_remove(&patches[1]),
        (node_id_str(inner_id).as_ref(), false)
    );
    assert!(count_creates(&patches) >= 1, "replacement Column created");
}

#[test]
fn test_foreach_removal_flags_exiting_item_root() {
    // GIVEN: ForEach over @{state.items} whose item template carries an
    // exit spec on its root.
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let template_root = Element::new("Row")
        .with_prop(
            "__anim.exit",
            Value::Static(json!({"presets": ["fade"], "duration": 150, "curve": "easeIn"})),
        )
        .with_prop("text", Value::Binding(Binding::item(vec![])));
    let ir_node = IRNode::ForEach {
        source: Binding::state(vec!["items".to_string()]),
        item_name: "item".to_string(),
        key_path: None,
        template: vec![IRNode::Element(template_root)],
        props: hypen_engine::ir::Props::new(),
        module_scope: None,
    };
    let state = json!({"items": ["a", "b"]});
    reconcile_ir(&mut tree, &ir_node, None, &state, &mut dependencies);

    // WHEN: One item is dropped — keyed reconciliation retires exactly the
    // dropped row instead of rebuilding the whole list.
    let state = json!({"items": ["a"]});
    let patches = reconcile_ir(&mut tree, &ir_node, None, &state, &mut dependencies);

    // THEN: A single root-only Remove, carrying the exit flag. (The old
    // rebuild path emitted one flagged Remove per row plus a Create per
    // surviving row — every row played its exit while its clone played its
    // enter, the "ghost duplicate list".)
    let removes: Vec<(&str, bool)> = patches
        .iter()
        .filter_map(|p| match p {
            Patch::Remove { id, transition } => Some((id.as_ref(), *transition)),
            _ => None,
        })
        .collect();
    assert_eq!(removes.len(), 1, "got {:?}", patches);
    assert!(
        removes.iter().all(|(_, transition)| *transition),
        "the removed item root must be flagged: {:?}",
        removes
    );
    assert_eq!(
        count_creates(&patches),
        0,
        "surviving rows must not be recreated: {:?}",
        patches
    );
}

#[test]
fn test_keyed_removal_flags_exiting_item_root() {
    // GIVEN: an iterable (List) whose keyed item template carries an exit
    // spec — exercises the keyed reconciliation removal path.
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let template_root = Element::new("Row")
        .with_prop(
            "__anim.exit",
            Value::Static(json!({"presets": ["fade"], "duration": 150, "curve": "easeIn"})),
        )
        .with_prop(
            "text",
            Value::Binding(Binding::item(vec!["label".to_string()])),
        );
    let list = Element {
        element_type: "List".to_string(),
        props: hypen_engine::ir::Props::from_map(indexmap::indexmap! {
            "0".to_string() => Value::Binding(Binding::state(vec!["items".to_string()])),
        }),
        ir_children: vec![IRNode::Element(template_root)],
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    };
    let state = json!({"items": [
        {"id": 1, "label": "one"},
        {"id": 2, "label": "two"},
    ]});
    reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // WHEN: Item 2 leaves the list
    let state = json!({"items": [{"id": 1, "label": "one"}]});
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: The keyed root-only Remove is flagged
    let removes: Vec<(&str, bool)> = patches
        .iter()
        .filter_map(|p| match p {
            Patch::Remove { id, transition } => Some((id.as_ref(), *transition)),
            _ => None,
        })
        .collect();
    assert_eq!(removes.len(), 1, "got {:?}", patches);
    assert!(removes[0].1, "keyed item-root Remove must carry the flag");
}

// ============================================================================
// I. ForEach keyed reconciliation
//
// `IRNode::ForEach` used to tear down and recreate every child on ANY item
// count change. It now shares the keyed LIS reconciliation used by iterable
// elements, so a single add/remove/reorder costs a constant number of patches
// and untouched rows keep their NodeIds (and therefore their renderer-side
// state: focus, scroll, input values, media playback).
// ============================================================================

/// A `Column { ForEach(@state.items) { <template…> } }` IR node.
///
/// Nesting the ForEach under a real element is what makes the logical-vs-render
/// parent split observable: rows are LOGICAL children of the transparent
/// `__ForEach` container, but their Insert/Move patches must target the Column.
fn foreach_under_column(template: Vec<IRNode>) -> IRNode {
    let foreach = IRNode::ForEach {
        source: Binding::state(vec!["items".to_string()]),
        item_name: "item".to_string(),
        key_path: None,
        template,
        props: hypen_engine::ir::Props::new(),
        module_scope: None,
    };
    let mut column = Element::new("Column");
    column.ir_children.push(foreach);
    IRNode::Element(column)
}

/// The single-node row template: `Text("@{item.name}")`.
fn row_template() -> Vec<IRNode> {
    vec![IRNode::Element(Element::new("Text").with_prop(
        "0",
        Value::Binding(Binding::item(vec!["name".to_string()])),
    ))]
}

fn items(names: &[&str]) -> serde_json::Value {
    json!({
        "items": names
            .iter()
            .map(|n| json!({"id": n, "name": n.to_uppercase()}))
            .collect::<Vec<_>>()
    })
}

/// (ForEach container id, its row ids) for a tree whose root is the Column.
fn foreach_rows(tree: &InstanceTree) -> (hypen_engine::ir::NodeId, Vec<hypen_engine::ir::NodeId>) {
    let root = tree.root().expect("root Column");
    let foreach_id = tree.get(root).expect("Column node").children[0];
    let rows = tree
        .get(foreach_id)
        .expect("ForEach node")
        .children
        .iter()
        .copied()
        .collect();
    (foreach_id, rows)
}

#[test]
fn test_foreach_add_one_item_creates_only_the_new_row() {
    // GIVEN: a three-row keyed ForEach
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let ir = foreach_under_column(row_template());
    reconcile_ir(
        &mut tree,
        &ir,
        None,
        &items(&["a", "b", "c"]),
        &mut dependencies,
    );
    let root_id = tree.root().expect("root Column");
    let (_, before) = foreach_rows(&tree);

    // WHEN: one item is appended
    let patches = reconcile_ir(
        &mut tree,
        &ir,
        None,
        &items(&["a", "b", "c", "d"]),
        &mut dependencies,
    );

    // THEN: exactly one Create, no Removes, and the three surviving rows keep
    // their NodeIds.
    assert_eq!(count_creates(&patches), 1, "got {:?}", patches);
    assert_eq!(count_removes(&patches), 0, "got {:?}", patches);
    let (foreach_id, after) = foreach_rows(&tree);
    assert_eq!(after.len(), 4);
    assert_eq!(&after[..3], &before[..], "surviving rows must keep NodeIds");

    // …and the new row's Insert targets the RENDER parent (the Column), never
    // the transparent ForEach container.
    let insert_parents: Vec<&str> = patches
        .iter()
        .filter_map(|p| match p {
            Patch::Insert { parent_id, .. } => Some(parent_id.as_ref()),
            _ => None,
        })
        .collect();
    assert_eq!(insert_parents, vec![node_id_str(root_id).as_ref()]);
    assert_ne!(node_id_str(foreach_id), node_id_str(root_id));
}

#[test]
fn test_foreach_insert_in_middle_moves_the_new_row_into_place() {
    // GIVEN: [a, b, c]
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let ir = foreach_under_column(row_template());
    reconcile_ir(
        &mut tree,
        &ir,
        None,
        &items(&["a", "b", "c"]),
        &mut dependencies,
    );
    let root_id = tree.root().expect("root Column");
    let (_, before) = foreach_rows(&tree);

    // WHEN: an item is inserted in the middle
    let patches = reconcile_ir(
        &mut tree,
        &ir,
        None,
        &items(&["a", "x", "b", "c"]),
        &mut dependencies,
    );

    // THEN: 1 Create, 0 Removes and one Move that anchors the newly created
    // row before the old `b` (Create+Insert appends, so ordering needs the
    // Move — without it the new row would land at the end of the list).
    assert_eq!(count_creates(&patches), 1, "got {:?}", patches);
    assert_eq!(count_removes(&patches), 0, "got {:?}", patches);
    assert_eq!(count_moves(&patches), 1, "got {:?}", patches);
    let (_, after) = foreach_rows(&tree);
    assert_eq!(after.len(), 4);
    assert_eq!(after[0], before[0]);
    assert_eq!(after[2], before[1]);
    assert_eq!(after[3], before[2]);
    match patches.iter().find(|p| matches!(p, Patch::Move { .. })) {
        Some(Patch::Move {
            parent_id,
            id,
            before_id,
        }) => {
            assert_eq!(parent_id, &node_id_str(root_id), "Move targets the Column");
            assert_eq!(id, &node_id_str(after[1]));
            assert_eq!(before_id.as_deref(), Some(node_id_str(before[1]).as_ref()));
        }
        other => panic!("expected a Move patch, got {:?}", other),
    }
}

#[test]
fn test_foreach_remove_one_item_emits_a_single_remove() {
    // GIVEN: [a, b, c]
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let ir = foreach_under_column(row_template());
    reconcile_ir(
        &mut tree,
        &ir,
        None,
        &items(&["a", "b", "c"]),
        &mut dependencies,
    );
    let (_, before) = foreach_rows(&tree);

    // WHEN: the middle item is dropped
    let patches = reconcile_ir(&mut tree, &ir, None, &items(&["a", "c"]), &mut dependencies);

    // THEN: exactly one Remove, nothing recreated, survivors keep their nodes.
    assert_eq!(count_removes(&patches), 1, "got {:?}", patches);
    assert_eq!(count_creates(&patches), 0, "got {:?}", patches);
    let removed_id = match patches.iter().find(|p| matches!(p, Patch::Remove { .. })) {
        Some(Patch::Remove { id, .. }) => id.clone(),
        other => panic!("expected a Remove patch, got {:?}", other),
    };
    assert_eq!(removed_id, node_id_str(before[1]), "the dropped row is `b`");
    let (_, after) = foreach_rows(&tree);
    assert_eq!(after, vec![before[0], before[2]]);
}

#[test]
fn test_foreach_reorder_emits_moves_not_create_remove_churn() {
    // GIVEN: [a, b, c, d]
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let ir = foreach_under_column(row_template());
    reconcile_ir(
        &mut tree,
        &ir,
        None,
        &items(&["a", "b", "c", "d"]),
        &mut dependencies,
    );
    let (_, before) = foreach_rows(&tree);

    // WHEN: the list is reordered (no membership change)
    let patches = reconcile_ir(
        &mut tree,
        &ir,
        None,
        &items(&["d", "a", "b", "c"]),
        &mut dependencies,
    );

    // THEN: Moves only — no node is destroyed or rebuilt.
    assert_eq!(count_creates(&patches), 0, "got {:?}", patches);
    assert_eq!(count_removes(&patches), 0, "got {:?}", patches);
    assert!(count_moves(&patches) >= 1, "got {:?}", patches);
    let (_, after) = foreach_rows(&tree);
    assert_eq!(
        after,
        vec![before[3], before[0], before[1], before[2]],
        "rows are the same nodes in the new order"
    );
}

#[test]
fn test_foreach_full_reversal_moves_land_in_the_right_order() {
    // A reversal needs several Moves, and each Move's anchor must already be
    // in its final position — the reason the placement pass walks backwards.
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let ir = foreach_under_column(row_template());
    reconcile_ir(
        &mut tree,
        &ir,
        None,
        &items(&["a", "b", "c"]),
        &mut dependencies,
    );
    let root_id = tree.root().expect("root Column");
    let (_, before) = foreach_rows(&tree);

    let patches = reconcile_ir(
        &mut tree,
        &ir,
        None,
        &items(&["c", "b", "a"]),
        &mut dependencies,
    );

    assert_eq!(count_creates(&patches), 0, "got {:?}", patches);
    assert_eq!(count_removes(&patches), 0, "got {:?}", patches);

    // Replay the Move patches against the renderer's view of the child list
    // and check the result equals the desired order.
    let mut rendered: Vec<std::sync::Arc<str>> = before.iter().map(|&id| node_id_str(id)).collect();
    for patch in &patches {
        if let Patch::Move {
            parent_id,
            id,
            before_id,
        } = patch
        {
            assert_eq!(parent_id, &node_id_str(root_id));
            rendered.retain(|existing| existing != id);
            match before_id {
                Some(anchor) => {
                    let pos = rendered
                        .iter()
                        .position(|existing| existing == anchor)
                        .expect("Move anchor must already be placed");
                    rendered.insert(pos, id.clone());
                }
                None => rendered.push(id.clone()),
            }
        }
    }
    let expected: Vec<std::sync::Arc<str>> = vec![before[2], before[1], before[0]]
        .into_iter()
        .map(node_id_str)
        .collect();
    assert_eq!(rendered, expected, "patches: {:?}", patches);
}

#[test]
fn test_foreach_repeated_add_remove_keeps_logical_children_populated() {
    // Regression pin for the logical-vs-render parent invariant: rows must
    // stay LOGICAL children of the ForEach container. If they were hung off
    // the grandparent instead, `ForEach.children` would go empty and every
    // later reconcile would see a mismatch and rebuild the whole list forever
    // (0 Removes + N Creates, indefinitely).
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let ir = foreach_under_column(row_template());
    reconcile_ir(&mut tree, &ir, None, &items(&["a", "b"]), &mut dependencies);

    let cycles = [
        (vec!["a", "b", "c"], 1usize, 0usize),
        (vec!["a", "b"], 0, 1),
        (vec!["a", "b", "c", "d"], 2, 0),
        (vec!["a"], 0, 3),
        (vec!["a", "b"], 1, 0),
    ];

    for (names, expected_creates, expected_removes) in cycles {
        let patches = reconcile_ir(&mut tree, &ir, None, &items(&names), &mut dependencies);
        assert_eq!(
            count_creates(&patches),
            expected_creates,
            "creates for {:?}: {:?}",
            names,
            patches
        );
        assert_eq!(
            count_removes(&patches),
            expected_removes,
            "removes for {:?}: {:?}",
            names,
            patches
        );

        let (foreach_id, rows) = foreach_rows(&tree);
        assert_eq!(
            rows.len(),
            names.len(),
            "ForEach.children must stay populated after {:?}",
            names
        );
        for &row in &rows {
            assert_eq!(
                tree.get(row).expect("row node").parent,
                Some(foreach_id),
                "rows stay logical children of the ForEach container"
            );
        }
    }
}

#[test]
fn test_foreach_multi_node_template_reconciles_per_item() {
    // Templates may emit more than one node per item
    // (expected_children_count = items.len() * template.len()). Keyed
    // reconciliation disambiguates the siblings with a `#<template_idx>`
    // key suffix, so a count change still touches only the changed item.
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let template = vec![
        IRNode::Element(
            Element::new("Text")
                .with_prop("0", Value::Binding(Binding::item(vec!["name".to_string()]))),
        ),
        IRNode::Element(Element::new("Divider")),
    ];
    let ir = foreach_under_column(template);
    reconcile_ir(&mut tree, &ir, None, &items(&["a", "b"]), &mut dependencies);
    let (_, before) = foreach_rows(&tree);
    assert_eq!(before.len(), 4, "two nodes per item");

    // WHEN: one item is appended
    let patches = reconcile_ir(
        &mut tree,
        &ir,
        None,
        &items(&["a", "b", "c"]),
        &mut dependencies,
    );

    // THEN: only the new item's two nodes are created.
    assert_eq!(count_creates(&patches), 2, "got {:?}", patches);
    assert_eq!(count_removes(&patches), 0, "got {:?}", patches);
    let (_, after) = foreach_rows(&tree);
    assert_eq!(after.len(), 6);
    assert_eq!(
        &after[..4],
        &before[..],
        "existing pairs keep their NodeIds"
    );
    let element_types: Vec<String> = after
        .iter()
        .map(|&id| tree.get(id).expect("row node").element_type.clone())
        .collect();
    assert_eq!(
        element_types,
        vec!["Text", "Divider", "Text", "Divider", "Text", "Divider"],
        "per-item template order is preserved"
    );

    // …and dropping an item retires exactly that item's two nodes.
    let patches = reconcile_ir(&mut tree, &ir, None, &items(&["a", "c"]), &mut dependencies);
    assert_eq!(count_removes(&patches), 2, "got {:?}", patches);
    assert_eq!(count_creates(&patches), 0, "got {:?}", patches);
    let (_, after) = foreach_rows(&tree);
    assert_eq!(after.len(), 4);
}
