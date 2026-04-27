//! Direct tests for render_dirty_nodes to verify patch generation

use hypen_engine::{
    ir::{Element, Value},
    lifecycle::{Module, ModuleInstance},
    reactive::{Binding, Scheduler},
    reconcile::InstanceTree,
    render::render_dirty_nodes,
};
use serde_json::json;

#[test]
fn test_render_dirty_nodes_generates_patches_for_changed_binding() {
    // GIVEN: Tree with a node that has a binding
    let mut tree = InstanceTree::new();
    let mut element = Element::new("Text");
    element.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec!["count".to_string()])),
    );

    // Create node with initial state
    let initial_state = json!({"count": 0});
    let node_id = tree.create_node(&element, &initial_state);
    tree.set_root(node_id);

    // Create module with updated state
    let module_meta = Module::new("TestModule");
    let updated_state = json!({"count": 1});
    let module = ModuleInstance::new(module_meta, updated_state);

    // Mark node as dirty
    let mut scheduler = Scheduler::new();
    scheduler.mark_dirty(node_id);

    // WHEN: Render dirty nodes
    let patches = render_dirty_nodes(&mut scheduler, &mut tree, Some(&module));

    // THEN: Should generate patches
    assert!(
        !patches.is_empty(),
        "Should generate patches when binding value changes"
    );

    // Should have a SetProp patch
    assert!(
        patches
            .iter()
            .any(|p| matches!(p, hypen_engine::reconcile::Patch::SetProp { .. })),
        "Should have SetProp patch for changed text"
    );
}

#[test]
fn test_render_dirty_nodes_no_patches_when_value_unchanged() {
    // GIVEN: Tree with node, state hasn't changed
    let mut tree = InstanceTree::new();
    let mut element = Element::new("Text");
    element.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec!["message".to_string()])),
    );

    let state = json!({"message": "Hello"});
    let node_id = tree.create_node(&element, &state);

    // Module with same state
    let module_meta = Module::new("TestModule");
    let module = ModuleInstance::new(module_meta, state);

    // Mark as dirty
    let mut scheduler = Scheduler::new();
    scheduler.mark_dirty(node_id);

    // WHEN: Render dirty
    let patches = render_dirty_nodes(&mut scheduler, &mut tree, Some(&module));

    // THEN: No patches (value didn't change)
    assert!(
        patches.is_empty(),
        "Should not generate patches when value is unchanged"
    );
}

#[test]
fn test_render_dirty_nodes_multiple_props_change() {
    // GIVEN: Node with multiple bindings
    let mut tree = InstanceTree::new();
    let mut element = Element::new("Text");
    element.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec!["user".to_string(), "name".to_string()])),
    );
    element.props.insert(
        "color".to_string(),
        Value::Binding(Binding::state(vec![
            "theme".to_string(),
            "color".to_string(),
        ])),
    );

    let initial = json!({
        "user": {"name": "Alice"},
        "theme": {"color": "blue"}
    });
    let node_id = tree.create_node(&element, &initial);

    // Updated state
    let updated = json!({
        "user": {"name": "Bob"},
        "theme": {"color": "red"}
    });
    let module_meta = Module::new("TestModule");
    let module = ModuleInstance::new(module_meta, updated);

    let mut scheduler = Scheduler::new();
    scheduler.mark_dirty(node_id);

    // WHEN: Render dirty
    let patches = render_dirty_nodes(&mut scheduler, &mut tree, Some(&module));

    // THEN: Should have 2 SetProp patches
    let set_prop_count = patches
        .iter()
        .filter(|p| matches!(p, hypen_engine::reconcile::Patch::SetProp { .. }))
        .count();
    assert_eq!(
        set_prop_count, 2,
        "Should generate SetProp patch for each changed prop"
    );
}
