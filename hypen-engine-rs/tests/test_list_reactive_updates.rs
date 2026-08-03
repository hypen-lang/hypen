//! Tests for List component reactive updates
//!
//! This file tests that List elements properly re-render when their
//! underlying array binding changes. This is critical for cart pages,
//! todo lists, and other dynamic lists.

use hypen_engine::{
    ir::{Element, IRNode, Value},
    lifecycle::{Module, ModuleInstance},
    reactive::{Binding, DependencyGraph, Scheduler},
    reconcile::{reconcile_ir, InstanceTree, Patch},
    render::render_dirty_nodes_with_deps,
};
use serde_json::json;

/// Helper to create a Text element with a binding
fn text_element_with_binding(path: &str) -> Element {
    let parts: Vec<String> = path.split('.').map(|s| s.to_string()).collect();
    let mut element = Element::new("Text");
    element
        .props
        .insert("0".to_string(), Value::Binding(Binding::state(parts)));
    element
}

/// Helper to count Create patches
fn count_creates(patches: &[Patch]) -> usize {
    patches
        .iter()
        .filter(|p| matches!(p, Patch::Create { .. }))
        .count()
}

/// Helper to count Remove patches
fn count_removes(patches: &[Patch]) -> usize {
    patches
        .iter()
        .filter(|p| matches!(p, Patch::Remove { .. }))
        .count()
}

#[test]
fn test_list_registers_dependency_on_array_binding() {
    // GIVEN: A List element with an array binding
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children
        .push(IRNode::Element(text_element_with_binding("item.name")));

    let state = json!({"items": [{"name": "A"}, {"name": "B"}]});

    // WHEN: We create the tree
    let _initial_patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );
    let list_node_id = tree.root().expect("Should have root");

    // THEN: The List node should be registered as depending on "items"
    let affected = dependencies.get_affected_nodes("items");
    assert!(
        affected.contains(&list_node_id),
        "List node should be registered as depending on 'items' binding"
    );
}

#[test]
fn test_list_stores_element_template_for_rerender() {
    // GIVEN: A List element with children template
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children
        .push(IRNode::Element(text_element_with_binding("item.name")));

    let state = json!({"items": [{"name": "A"}]});

    // WHEN: We create the tree
    let _initial_patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );
    let list_node_id = tree.root().expect("Should have root");

    // THEN: The List node should have the element_template stored
    let node = tree.get(list_node_id).unwrap();
    assert!(
        node.element_template.is_some(),
        "List node should have element_template stored for re-rendering"
    );

    // And the template should have the original children
    let template = node.element_template.as_ref().unwrap();
    assert_eq!(
        template.ir_children.len(),
        1,
        "Template should preserve original children"
    );
}

#[test]
fn test_list_rerenders_when_array_changes() {
    // GIVEN: A List element rendered with 2 items
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let mut scheduler = Scheduler::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children
        .push(IRNode::Element(text_element_with_binding("item.name")));

    let initial_state = json!({"items": [{"name": "A"}, {"name": "B"}]});

    // Create module instance
    let module = Module::new("TestModule");
    let mut instance = ModuleInstance::new(module, initial_state);

    let initial_patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        instance.get_state(),
        &mut dependencies,
    );
    let list_node_id = tree.root().expect("Should have root");

    // Verify initial render created 3 nodes (List + 2 Text)
    let initial_creates = count_creates(&initial_patches);
    assert_eq!(
        initial_creates, 3,
        "Initial render should create List + 2 Text nodes"
    );

    // WHEN: The array changes to 3 items
    let new_state = json!({"items": [{"name": "A"}, {"name": "B"}, {"name": "C"}]});
    instance.update_state(new_state);

    // Mark the list node as dirty (simulating what happens when state changes)
    scheduler.mark_dirty(list_node_id);

    // Render dirty nodes
    let update_patches = render_dirty_nodes_with_deps(
        &mut scheduler,
        &mut tree,
        Some(&instance),
        &mut dependencies,
    );

    // THEN: With keyed reconciliation, existing items are reused
    // Adding C to [A, B] should only create 1 new node
    let removes = count_removes(&update_patches);
    let creates = count_creates(&update_patches);

    // Keyed reconciliation: items with matching keys are reused
    // Only the new item (C) needs to be created
    assert_eq!(
        removes, 0,
        "Should NOT remove existing items with matching keys: got {} removes",
        removes
    );
    assert_eq!(
        creates, 1,
        "Should only create the new item C: got {} creates",
        creates
    );
}

#[test]
fn test_list_clears_when_array_becomes_empty() {
    // GIVEN: A List element rendered with 2 items
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let mut scheduler = Scheduler::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["cart".to_string()])),
    );
    list.ir_children
        .push(IRNode::Element(text_element_with_binding("item.title")));

    let initial_state = json!({
        "cart": [
            {"id": 1, "title": "Product A"},
            {"id": 2, "title": "Product B"}
        ]
    });

    let module = Module::new("TestModule");
    let mut instance = ModuleInstance::new(module, initial_state);

    let _initial_patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        instance.get_state(),
        &mut dependencies,
    );
    let list_node_id = tree.root().expect("Should have root");

    // Verify initial children
    let initial_children = tree.get(list_node_id).unwrap().children.len();
    assert_eq!(initial_children, 2, "Should have 2 children initially");

    // WHEN: Cart becomes empty
    instance.update_state(json!({"cart": []}));
    scheduler.mark_dirty(list_node_id);

    let update_patches = render_dirty_nodes_with_deps(
        &mut scheduler,
        &mut tree,
        Some(&instance),
        &mut dependencies,
    );

    // THEN: Should have Remove patches for all children
    let removes = count_removes(&update_patches);
    assert_eq!(removes, 2, "Should remove all 2 children when cart empties");

    // And the list node should have no children
    let final_children = tree.get(list_node_id).unwrap().children.len();
    assert_eq!(
        final_children, 0,
        "List should have no children after clearing"
    );
}

#[test]
fn test_list_renders_when_array_populates_from_empty() {
    // GIVEN: A List element rendered with empty array
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let mut scheduler = Scheduler::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["cart".to_string()])),
    );
    list.ir_children
        .push(IRNode::Element(text_element_with_binding("item.title")));

    let initial_state = json!({"cart": []});

    let module = Module::new("TestModule");
    let mut instance = ModuleInstance::new(module, initial_state);

    let _initial_patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        instance.get_state(),
        &mut dependencies,
    );
    let list_node_id = tree.root().expect("Should have root");

    // Verify no children initially
    let initial_children = tree.get(list_node_id).unwrap().children.len();
    assert_eq!(initial_children, 0, "Should have 0 children initially");

    // WHEN: Items are added to cart
    instance.update_state(json!({
        "cart": [
            {"id": 1, "title": "Product A"},
            {"id": 2, "title": "Product B"}
        ]
    }));
    scheduler.mark_dirty(list_node_id);

    let update_patches = render_dirty_nodes_with_deps(
        &mut scheduler,
        &mut tree,
        Some(&instance),
        &mut dependencies,
    );

    // THEN: Should have Create patches for new children
    let creates = count_creates(&update_patches);
    assert_eq!(creates, 2, "Should create 2 new children when items added");

    // And the list node should have children
    let final_children = tree.get(list_node_id).unwrap().children.len();
    assert_eq!(
        final_children, 2,
        "List should have 2 children after adding items"
    );
}

#[test]
fn test_list_item_bindings_are_replaced_with_values() {
    // GIVEN: A List with item bindings
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );

    // Child template with @{item.name} pattern in a static string
    let mut text = Element::new("Text");
    text.props
        .insert("0".to_string(), Value::Static(json!("@{item.name}")));
    list.ir_children.push(IRNode::Element(text));

    let state = json!({"items": [{"name": "Alice"}, {"name": "Bob"}]});

    // WHEN: We create the tree
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: The Text nodes should have the actual values, not "@{item.name}"
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
                    return Some(props.get("0").cloned());
                }
            }
            None
        })
        .flatten()
        .collect();

    assert_eq!(text_creates.len(), 2, "Should have 2 Text creates");
    assert!(
        text_creates.contains(&json!("Alice")),
        "Should contain 'Alice'"
    );
    assert!(text_creates.contains(&json!("Bob")), "Should contain 'Bob'");
}

#[test]
fn test_list_nested_item_bindings() {
    // GIVEN: A List with nested item bindings like @{item.user.name}
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );

    let mut text = Element::new("Text");
    text.props
        .insert("0".to_string(), Value::Static(json!("@{item.user.name}")));
    list.ir_children.push(IRNode::Element(text));

    let state = json!({
        "items": [
            {"user": {"name": "Alice", "email": "alice@example.com"}},
            {"user": {"name": "Bob", "email": "bob@example.com"}}
        ]
    });

    // WHEN: We create the tree
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: The Text nodes should have the nested values
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
                    return Some(props.get("0").cloned());
                }
            }
            None
        })
        .flatten()
        .collect();

    assert_eq!(text_creates.len(), 2, "Should have 2 Text creates");
    assert!(
        text_creates.contains(&json!("Alice")),
        "Should contain 'Alice'"
    );
    assert!(text_creates.contains(&json!("Bob")), "Should contain 'Bob'");
}

// =============================================================================
// EXPRESSION EVALUATION WITH ITEM BINDINGS
// =============================================================================
// These tests verify that expressions like @{item.selected ? '2px' : '1px'}
// are properly evaluated after item values have been substituted.

#[test]
fn test_list_item_ternary_expression_boolean_true() {
    // GIVEN: A List with a ternary expression using item binding
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );

    // Child template with ternary expression
    let mut box_elem = Element::new("Box");
    box_elem.props.insert(
        "borderWidth".to_string(),
        Value::Static(json!("@{item.selected ? '2px' : '1px'}")),
    );
    list.ir_children.push(IRNode::Element(box_elem));

    let state = json!({
        "items": [
            {"id": 1, "selected": true},
            {"id": 2, "selected": false}
        ]
    });

    // WHEN: We create the tree
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: The Box elements should have evaluated border widths
    let box_creates: Vec<_> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Box" {
                    return Some(props.get("borderWidth").cloned());
                }
            }
            None
        })
        .flatten()
        .collect();

    assert_eq!(box_creates.len(), 2, "Should have 2 Box creates");
    assert!(
        box_creates.contains(&json!("2px")),
        "Selected item should have '2px' border: {:?}",
        box_creates
    );
    assert!(
        box_creates.contains(&json!("1px")),
        "Unselected item should have '1px' border: {:?}",
        box_creates
    );
}

#[test]
fn test_list_item_ternary_expression_with_colors() {
    // GIVEN: A List with a ternary expression for background colors
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );

    let mut box_elem = Element::new("Box");
    box_elem.props.insert(
        "backgroundColor".to_string(),
        Value::Static(json!("@{item.active ? '#FFA7E1' : '#374151'}")),
    );
    list.ir_children.push(IRNode::Element(box_elem));

    let state = json!({
        "items": [
            {"name": "Active", "active": true},
            {"name": "Inactive", "active": false}
        ]
    });

    // WHEN: We create the tree
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: The Box elements should have evaluated colors
    let colors: Vec<_> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Box" {
                    return Some(props.get("backgroundColor").cloned());
                }
            }
            None
        })
        .flatten()
        .collect();

    assert_eq!(colors.len(), 2, "Should have 2 Box creates");
    assert!(
        colors.contains(&json!("#FFA7E1")),
        "Active item should have pink background: {:?}",
        colors
    );
    assert!(
        colors.contains(&json!("#374151")),
        "Inactive item should have gray background: {:?}",
        colors
    );
}

#[test]
fn test_list_item_ternary_with_nested_path() {
    // GIVEN: A List with a ternary expression using nested item path
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["users".to_string()])),
    );

    let mut text = Element::new("Text");
    text.props.insert(
        "0".to_string(),
        Value::Static(json!(
            "@{item.profile.verified ? 'Verified ✓' : 'Unverified'}"
        )),
    );
    list.ir_children.push(IRNode::Element(text));

    let state = json!({
        "users": [
            {"name": "Alice", "profile": {"verified": true}},
            {"name": "Bob", "profile": {"verified": false}}
        ]
    });

    // WHEN: We create the tree
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: The Text elements should have evaluated values
    let texts: Vec<_> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Text" {
                    return Some(props.get("0").cloned());
                }
            }
            None
        })
        .flatten()
        .collect();

    assert_eq!(texts.len(), 2, "Should have 2 Text creates");
    assert!(
        texts.contains(&json!("Verified ✓")),
        "Verified user should show 'Verified ✓': {:?}",
        texts
    );
    assert!(
        texts.contains(&json!("Unverified")),
        "Unverified user should show 'Unverified': {:?}",
        texts
    );
}

#[test]
fn test_list_item_numeric_comparison_expression() {
    // GIVEN: A List with a numeric comparison in ternary
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["products".to_string()])),
    );

    let mut text = Element::new("Text");
    text.props.insert(
        "0".to_string(),
        Value::Static(json!("@{item.stock > 10 ? 'In Stock' : 'Low Stock'}")),
    );
    list.ir_children.push(IRNode::Element(text));

    let state = json!({
        "products": [
            {"name": "Widget", "stock": 50},
            {"name": "Gadget", "stock": 5}
        ]
    });

    // WHEN: We create the tree
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: The Text elements should have evaluated stock status
    let texts: Vec<_> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Text" {
                    return Some(props.get("0").cloned());
                }
            }
            None
        })
        .flatten()
        .collect();

    assert_eq!(texts.len(), 2, "Should have 2 Text creates");
    assert!(
        texts.contains(&json!("In Stock")),
        "High stock should show 'In Stock': {:?}",
        texts
    );
    assert!(
        texts.contains(&json!("Low Stock")),
        "Low stock should show 'Low Stock': {:?}",
        texts
    );
}

#[test]
fn test_list_item_logical_or_fallback_expression() {
    // GIVEN: A List with a logical OR fallback expression
    // Note: The ?? operator is not supported by exprimo, so we use || instead
    // This tests fallback behavior for empty/falsy values
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );

    let mut text = Element::new("Text");
    // Use logical OR for fallback - if nickname is empty string, use name
    text.props.insert(
        "0".to_string(),
        Value::Static(json!("@{item.hasNickname ? item.nickname : item.name}")),
    );
    list.ir_children.push(IRNode::Element(text));

    let state = json!({
        "items": [
            {"name": "Alice", "nickname": "Ally", "hasNickname": true},
            {"name": "Bob", "nickname": "", "hasNickname": false}
        ]
    });

    // WHEN: We create the tree
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: The Text elements should use nickname when hasNickname is true, name otherwise
    let texts: Vec<_> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Text" {
                    return Some(props.get("0").cloned());
                }
            }
            None
        })
        .flatten()
        .collect();

    assert_eq!(texts.len(), 2, "Should have 2 Text creates");
    assert!(
        texts.contains(&json!("Ally")),
        "Should show nickname when hasNickname is true: {:?}",
        texts
    );
    assert!(
        texts.contains(&json!("Bob")),
        "Should show name when hasNickname is false: {:?}",
        texts
    );
}

#[test]
fn test_list_item_expression_with_string_concatenation() {
    // GIVEN: A List with string concatenation in expression
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );

    let mut text = Element::new("Text");
    text.props.insert(
        "0".to_string(),
        Value::Static(json!("@{item.firstName + ' ' + item.lastName}")),
    );
    list.ir_children.push(IRNode::Element(text));

    let state = json!({
        "items": [
            {"firstName": "John", "lastName": "Doe"},
            {"firstName": "Jane", "lastName": "Smith"}
        ]
    });

    // WHEN: We create the tree
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: The Text elements should have concatenated names
    let texts: Vec<_> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Text" {
                    return Some(props.get("0").cloned());
                }
            }
            None
        })
        .flatten()
        .collect();

    assert_eq!(texts.len(), 2, "Should have 2 Text creates");
    assert!(
        texts.contains(&json!("John Doe")),
        "Should concatenate first and last name: {:?}",
        texts
    );
    assert!(
        texts.contains(&json!("Jane Smith")),
        "Should concatenate first and last name: {:?}",
        texts
    );
}

#[test]
fn test_list_item_expression_without_expression_not_evaluated() {
    // GIVEN: A List where item binding result contains no expression markers
    // This tests that we don't accidentally break simple string replacements
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );

    let mut text = Element::new("Text");
    text.props
        .insert("0".to_string(), Value::Static(json!("Hello @{item.name}!")));
    list.ir_children.push(IRNode::Element(text));

    let state = json!({
        "items": [
            {"name": "World"},
            {"name": "Universe"}
        ]
    });

    // WHEN: We create the tree
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Simple interpolation should still work
    let texts: Vec<_> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Text" {
                    return Some(props.get("0").cloned());
                }
            }
            None
        })
        .flatten()
        .collect();

    assert_eq!(texts.len(), 2, "Should have 2 Text creates");
    assert!(
        texts.contains(&json!("Hello World!")),
        "Simple interpolation should work: {:?}",
        texts
    );
    assert!(
        texts.contains(&json!("Hello Universe!")),
        "Simple interpolation should work: {:?}",
        texts
    );
}

#[test]
fn test_list_item_multiple_expressions_in_same_prop() {
    // GIVEN: A List with multiple expressions in the same property
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );

    let mut box_elem = Element::new("Box");
    // Two separate expressions in the same string - this tests complex template handling
    box_elem.props.insert(
        "style".to_string(),
        Value::Static(json!(
            "width: @{item.expanded ? '100%' : '50%'}; height: @{item.tall ? '200px' : '100px'}"
        )),
    );
    list.ir_children.push(IRNode::Element(box_elem));

    let state = json!({
        "items": [
            {"expanded": true, "tall": true},
            {"expanded": false, "tall": false}
        ]
    });

    // WHEN: We create the tree
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Both expressions in the style should be evaluated
    let styles: Vec<_> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Box" {
                    return Some(props.get("style").cloned());
                }
            }
            None
        })
        .flatten()
        .collect();

    assert_eq!(styles.len(), 2, "Should have 2 Box creates");
    assert!(
        styles.contains(&json!("width: 100%; height: 200px")),
        "Expanded+tall item should have full size: {:?}",
        styles
    );
    assert!(
        styles.contains(&json!("width: 50%; height: 100px")),
        "Collapsed+short item should have half size: {:?}",
        styles
    );
}

#[test]
fn test_list_item_template_string_with_expression() {
    // GIVEN: A List with a TemplateString value (as the parser creates)
    // containing an expression with item bindings
    // This simulates: .borderColor("@{item.selected ? '#FFA7E1' : '#374151'}")
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["options".to_string()])),
    );

    // Child template with TemplateString (what the parser creates)
    let mut row = Element::new("Row");
    row.props.insert(
        "borderColor".to_string(),
        Value::TemplateString {
            template: "@{item.selected ? '#FFA7E1' : '#374151'}".to_string(),
            bindings: vec![Binding::item(vec!["selected".to_string()])],
        },
    );
    row.props.insert(
        "borderWidth".to_string(),
        Value::TemplateString {
            template: "@{item.selected ? '2px' : '1px'}".to_string(),
            bindings: vec![Binding::item(vec!["selected".to_string()])],
        },
    );
    list.ir_children.push(IRNode::Element(row));

    let state = json!({
        "options": [
            {"id": "opt1", "label": "Option 1", "selected": true},
            {"id": "opt2", "label": "Option 2", "selected": false}
        ]
    });

    // WHEN: We create the tree
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(list.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: The Row elements should have evaluated border properties
    let row_creates: Vec<_> = patches
        .iter()
        .filter_map(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                if element_type == "Row" {
                    return Some((
                        props.get("borderColor").cloned(),
                        props.get("borderWidth").cloned(),
                    ));
                }
            }
            None
        })
        .collect();

    assert_eq!(row_creates.len(), 2, "Should have 2 Row creates");

    // Check that we have both the selected (pink, 2px) and unselected (gray, 1px) variants
    let has_selected = row_creates
        .iter()
        .any(|(color, width)| color == &Some(json!("#FFA7E1")) && width == &Some(json!("2px")));
    let has_unselected = row_creates
        .iter()
        .any(|(color, width)| color == &Some(json!("#374151")) && width == &Some(json!("1px")));

    assert!(
        has_selected,
        "Selected item should have pink border and 2px width: {:?}",
        row_creates
    );
    assert!(
        has_unselected,
        "Unselected item should have gray border and 1px width: {:?}",
        row_creates
    );
}

// ===========================================================================
// DSL-driven regression tests for the ForEach rebuild orphaning bug.
//
// Before the fix at diff.rs:946, every state-driven re-render of a
// `List(@state.xyz) { ... }` parsed via `convert_list` (i.e. the real
// production path — not the direct-Element List used by the tests above)
// emitted N fresh Creates with ZERO Removes, because the ForEach rebuild
// arm used `create_ir_node_tree_impl` (which collapses logical = render
// parent) instead of `create_ir_node_tree_full` (which preserves the
// split). That orphaned iteration items under the grandparent and left
// `ForEach.children` empty, so every subsequent reconcile saw a length
// mismatch and rebuilt again from nothing.
//
// These tests drive the full `parse_component → ast_to_ir_node → render →
// update_state[_sparse]` pipeline and assert on the resulting patch
// stream, which is what exposes the bug.
// ===========================================================================

use hypen_engine::ast_to_ir_node;
use hypen_engine::Engine;
use std::sync::{Arc, Mutex};

fn count_set_props(patches: &[Patch]) -> usize {
    patches
        .iter()
        .filter(|p| matches!(p, Patch::SetProp { .. }))
        .count()
}

fn collect_patches_into() -> (
    Arc<Mutex<Vec<Patch>>>,
    impl Fn(&[Patch]) + Send + Sync + 'static,
) {
    let patches: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
    let capture = Arc::clone(&patches);
    let callback = move |ps: &[Patch]| {
        capture.lock().unwrap().extend_from_slice(ps);
    };
    (patches, callback)
}

#[test]
fn test_dsl_list_sparse_update_emits_minimal_delta() {
    // Reproduces the calorie-counter AddFood flow: mount with empty state,
    // onActivated populates the array (length change → rebuild branch),
    // then a later mutation to a single item must go through the positional
    // branch and emit a minimal delta.

    let mut engine = Engine::new();
    let instance = ModuleInstance::new(Module::new("App"), json!({"foods": []}));
    engine.set_module(instance);

    let (patches, callback) = collect_patches_into();
    engine.set_render_callback(callback);

    let source = r#"Column {
        List(@state.foods) {
            Text("@{item.name}")
        }
    }"#;
    let doc = hypen_parser::parse_component(source).unwrap();
    let ir = ast_to_ir_node(&doc);
    engine.render_ir_node(&ir);

    // First update: 0 → 3 items. This is the length-change rebuild that
    // used to orphan children under the grandparent.
    engine.update_state(
        None,
        json!({"foods": [
            {"id": "1", "name": "A"},
            {"id": "2", "name": "B"},
            {"id": "3", "name": "C"}
        ]}),
    );
    patches.lock().unwrap().clear();

    // Second update: flip one leaf via sparse patch. Length unchanged, so
    // the ForEach reconcile must take the positional branch — which means
    // `F.children` must have been correctly populated by the previous
    // rebuild. With the bug, F.children was empty and every reconcile
    // hit the rebuild branch, emitting 3 Creates and 0 Removes per call.
    engine.update_state_sparse(
        None,
        &["foods.0.name".to_string()],
        &json!({"foods.0.name": "A2"}),
    );

    let captured = patches.lock().unwrap();
    let creates = count_creates(&captured);
    let removes = count_removes(&captured);
    let set_props = count_set_props(&captured);

    assert_eq!(
        creates, 0,
        "Sparse update to one list item should NOT create new nodes. \
         Got {creates} creates, {set_props} setProps, {removes} removes. \
         Patches: {captured:#?}"
    );
    assert_eq!(
        removes, 0,
        "Sparse update to one list item should NOT remove nodes. Got {removes} removes."
    );
    assert!(
        set_props >= 1,
        "Expected at least one SetProp reflecting the new name. Got {set_props}."
    );
}

#[test]
fn test_dsl_list_length_change_preserves_foreach_children() {
    // After a length change, `ForEach.children` must be correctly repopulated
    // with the iteration items (as logical children of the ForEach, not the
    // grandparent). The original bug left F.children empty, so subsequent
    // reconciles always saw a length mismatch and emitted 0 Removes + N
    // Creates indefinitely.
    //
    // We verify indirectly by doing TWO successive length changes and
    // asserting the second one still reconciles against the recorded rows:
    // exactly the dropped rows are removed and the survivors are reused. With
    // the bug, F.children was empty and this emitted 0 removes + N creates.

    let mut engine = Engine::new();
    let instance = ModuleInstance::new(
        Module::new("App"),
        json!({"foods": [
            {"id": "1", "name": "A"},
            {"id": "2", "name": "B"},
            {"id": "3", "name": "C"}
        ]}),
    );
    engine.set_module(instance);

    let (patches, callback) = collect_patches_into();
    engine.set_render_callback(callback);

    let source = r#"Column {
        List(@state.foods) {
            Text("@{item.name}")
        }
    }"#;
    let doc = hypen_parser::parse_component(source).unwrap();
    let ir = ast_to_ir_node(&doc);
    engine.render_ir_node(&ir);

    // First update: 3 → 4 items. New items land under the ForEach logically,
    // so F.children = [4 rows].
    patches.lock().unwrap().clear();
    engine.update_state(
        None,
        json!({"foods": [
            {"id": "1", "name": "A"},
            {"id": "2", "name": "B"},
            {"id": "3", "name": "C"},
            {"id": "4", "name": "D"}
        ]}),
    );

    // Second update: 4 → 2 items. With F.children correctly populated, keyed
    // reconciliation retires exactly the two dropped rows and reuses A and B.
    // With the bug, F.children was empty and this emitted 0 Removes.
    patches.lock().unwrap().clear();
    engine.update_state(
        None,
        json!({"foods": [
            {"id": "1", "name": "A"},
            {"id": "2", "name": "B"}
        ]}),
    );

    let captured = patches.lock().unwrap();
    let creates = count_creates(&captured);
    let removes = count_removes(&captured);

    assert_eq!(
        removes, 2,
        "Shrinking 4 → 2 items must emit exactly 2 Remove patches (C and D). \
         Got {removes} removes, {creates} creates. Patches: {captured:#?}"
    );
    assert_eq!(
        creates, 0,
        "Surviving rows A and B must be reused, not recreated. \
         Got {creates} creates. Patches: {captured:#?}"
    );
}

#[test]
fn test_dsl_list_sparse_update_under_named_module_scope() {
    // The calorie-counter scenario: AddFood is a named module registered
    // under scope "addfood", and its template wraps the List in
    // `module AddFood { … }`. State updates route through
    // `engine.update_state_sparse(Some("addfood"), …)`.

    let mut engine = Engine::new();

    // Primary module — the engine requires one.
    let app = ModuleInstance::new(Module::new("App"), json!({"page": "add"}));
    engine.set_module(app);

    // Named module whose state drives the List. Start empty so the first
    // update becomes a length-change rebuild — that's the code path the
    // calorie-counter hits when onActivated populates `state.foods` for
    // the first time.
    let add_food = ModuleInstance::new(Module::new("AddFood"), json!({"foods": []}));
    engine.register_module("addfood", add_food);

    let (patches, callback) = collect_patches_into();
    engine.set_render_callback(callback);

    // Template wraps the List in `module AddFood { … }` so the IR
    // expansion stamps module_scope="addfood" on the ForEach and its
    // children.
    let source = r#"module AddFood {
        Column {
            List(@state.foods) {
                Text("@{item.name}")
            }
        }
    }"#;
    let doc = hypen_parser::parse_component(source).unwrap();
    let ir = ast_to_ir_node(&doc);
    engine.render_ir_node(&ir);

    // First scoped update: populate foods (0 → 3). Length change →
    // rebuild branch. With the bug, this orphaned children under the
    // grandparent.
    engine.update_state(
        Some("addfood"),
        json!({"foods": [
            {"id": "1", "name": "A"},
            {"id": "2", "name": "B"},
            {"id": "3", "name": "C"}
        ]}),
    );
    patches.lock().unwrap().clear();

    // Sparse update on the scoped module. Length unchanged → positional
    // branch must fire and the patch stream must be minimal. Requires
    // ForEach.children to have been correctly repopulated by the
    // preceding rebuild.
    engine.update_state_sparse(
        Some("addfood"),
        &["foods.1.name".to_string()],
        &json!({"foods.1.name": "B2"}),
    );

    let captured = patches.lock().unwrap();
    let creates = count_creates(&captured);
    let removes = count_removes(&captured);
    let set_props = count_set_props(&captured);

    assert_eq!(
        creates, 0,
        "Scoped sparse update must not create new nodes. \
         Got {creates} creates, {set_props} setProps, {removes} removes. \
         Patches: {captured:#?}"
    );
    assert_eq!(
        removes, 0,
        "Scoped sparse update must not remove nodes. Got {removes} removes."
    );
    assert!(
        set_props >= 1,
        "Expected at least one SetProp reflecting foods.1.name = 'B2'. Got {set_props}."
    );
}
