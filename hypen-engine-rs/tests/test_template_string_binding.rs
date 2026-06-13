//! Tests for template string binding and expression evaluation functionality
//!
//! These tests verify that template strings like "Counter: @{state.counter}"
//! are properly tracked as dependencies and generate correct patches when state changes.
//!
//! Also tests expression evaluation with ternary operators, comparisons, etc.

use hypen_engine::{
    ir::{ast_to_ir_node, IRNode, Value},
    lifecycle::{Module, ModuleInstance},
    reactive::{DependencyGraph, Scheduler},
    reconcile::{reconcile_ir, InstanceTree, Patch},
};
use serde_json::json;

fn parse_to_element(input: &str) -> hypen_engine::Element {
    let component = hypen_parser::parse_component(input).unwrap();
    match ast_to_ir_node(&component) {
        IRNode::Element(e) => e,
        other => panic!("Expected Element, got {:?}", other),
    }
}

/// Test that template strings are correctly parsed into TemplateString values
#[test]
fn test_template_string_parsing() {
    let source = r#"Text("Counter: @{state.counter}")"#;
    let element = parse_to_element(source);

    // The first prop (prop "0") should be a TemplateString
    let prop = element.props.get("0").expect("Should have prop 0");
    match prop {
        Value::TemplateString { template, bindings } => {
            assert_eq!(template, "Counter: @{state.counter}");
            assert_eq!(bindings.len(), 1);
            assert_eq!(bindings[0].full_path(), "counter");
        }
        other => panic!("Expected TemplateString, got {:?}", other),
    }
}

/// Test that template string bindings are registered in the dependency graph
#[test]
fn test_template_string_dependency_registration() {
    let source = r#"Text("Counter: @{state.counter}")"#;
    let element = parse_to_element(source);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"counter": 0});

    let _patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );
    let node_id = tree.root().expect("Should have root");

    // The "counter" path should have the node_id as a dependent
    let affected = dependencies.get_affected_nodes("counter");
    assert!(
        affected.contains(&node_id),
        "Node should be registered as dependent on 'counter' path"
    );
}

/// Test that initial render correctly interpolates template strings
#[test]
fn test_template_string_initial_render() {
    let source = r#"Text("Counter: @{state.counter}")"#;
    let element = parse_to_element(source);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"counter": 42});

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );
    let _node_id = tree.root().expect("Should have root");

    // Check that the Create patch has the interpolated value
    let create_patch = patches.iter().find(|p| matches!(p, Patch::Create { .. }));
    assert!(create_patch.is_some(), "Should have a Create patch");

    if let Some(Patch::Create { props, .. }) = create_patch {
        let prop_value = props.get("0").expect("Should have prop 0");
        assert_eq!(
            prop_value.as_str().unwrap(),
            "Counter: 42",
            "Template string should be interpolated with state value"
        );
    }
}

/// Test that state changes trigger SetProp patches for template strings
#[test]
fn test_template_string_state_update() {
    let source = r#"Text("Counter: @{state.counter}")"#;
    let element = parse_to_element(source);

    // Create module with initial state
    let module = Module::new("TestModule");
    let initial_state = json!({"counter": 0});
    let mut instance = ModuleInstance::new(module, initial_state);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let mut scheduler = Scheduler::new();

    // Initial render
    let _patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        instance.get_state(),
        &mut dependencies,
    );
    let node_id = tree.root().expect("Should have root");
    tree.set_root(node_id);

    // Verify initial render has correct value
    let node = tree.get(node_id).unwrap();
    assert_eq!(
        node.props.get("0").and_then(|v| v.as_str()),
        Some("Counter: 0"),
        "Initial render should show Counter: 0"
    );

    // Update state
    instance.update_state(json!({"counter": 1}));

    // Mark affected nodes dirty
    let affected = dependencies.get_affected_nodes("counter");
    for &id in &affected {
        scheduler.mark_dirty(id);
    }

    // Render dirty nodes
    let update_patches =
        hypen_engine::render::render_dirty_nodes(&mut scheduler, &mut tree, Some(&instance));

    // Should have a SetProp patch with the new interpolated value
    assert!(!update_patches.is_empty(), "Should have update patches");

    let set_prop_patch = update_patches
        .iter()
        .find(|p| matches!(p, Patch::SetProp { name, .. } if name == "0"));

    assert!(
        set_prop_patch.is_some(),
        "Should have a SetProp patch for prop 0"
    );

    if let Some(Patch::SetProp { value, .. }) = set_prop_patch {
        assert_eq!(
            value.as_str().unwrap(),
            "Counter: 1",
            "SetProp should have interpolated value 'Counter: 1'"
        );
    }
}

/// Test template string with multiple bindings
#[test]
fn test_template_string_multiple_bindings() {
    let source = r#"Text("@{state.greeting}, @{state.name}!")"#;
    let element = parse_to_element(source);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"greeting": "Hello", "name": "World"});

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );
    let node_id = tree.root().expect("Should have root");

    // Both paths should have the node as a dependent
    assert!(
        dependencies
            .get_affected_nodes("greeting")
            .contains(&node_id),
        "Node should depend on 'greeting'"
    );
    assert!(
        dependencies.get_affected_nodes("name").contains(&node_id),
        "Node should depend on 'name'"
    );

    // Check interpolated value
    if let Some(Patch::Create { props, .. }) =
        patches.iter().find(|p| matches!(p, Patch::Create { .. }))
    {
        let prop_value = props.get("0").expect("Should have prop 0");
        assert_eq!(
            prop_value.as_str().unwrap(),
            "Hello, World!",
            "Multiple bindings should all be interpolated"
        );
    }
}

/// Test that non-template strings (static strings) work correctly
#[test]
fn test_static_string_not_registered_as_dependency() {
    let source = r#"Text("Hello World")"#;
    let element = parse_to_element(source);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    let _ = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );
    let node_id = tree.root().expect("Should have root");

    // Static strings should not register any dependencies
    // (The dependency graph should be empty or not have this node)
    let all_affected = dependencies.get_affected_nodes("anything");
    assert!(
        !all_affected.contains(&node_id),
        "Static string should not be registered as dependency"
    );
}

/// Test render_into scenario (lazy routes) with template strings
#[test]
fn test_template_string_in_child_tree() {
    // Build a tree that includes a template-string child
    // This tests that template strings in child subtrees track dependencies correctly
    let source = r#"Column { Text("Counter: @{state.counter}") }"#;
    let element = parse_to_element(source);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"counter": 0});

    // Create tree
    let _patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );
    let root_id = tree.root().expect("Should have root");

    // Find the child Text node (Column's child)
    let root_node = tree.get(root_id).expect("Root should exist");
    assert!(
        !root_node.children.is_empty(),
        "Column should have children"
    );
    let child_id = root_node.children[0];

    // Child should be registered as dependent on "counter"
    let affected = dependencies.get_affected_nodes("counter");
    assert!(
        affected.contains(&child_id),
        "Child node should be registered as dependent on 'counter'"
    );

    // Create module with the state
    let module = Module::new("TestModule");
    let mut instance = ModuleInstance::new(module, state);

    // Update state
    instance.update_state(json!({"counter": 5}));

    // Mark dirty and render
    let mut scheduler = Scheduler::new();
    for &id in &affected {
        scheduler.mark_dirty(id);
    }

    let update_patches =
        hypen_engine::render::render_dirty_nodes(&mut scheduler, &mut tree, Some(&instance));

    // Should have SetProp patch with interpolated value
    let set_prop = update_patches
        .iter()
        .find(|p| matches!(p, Patch::SetProp { name, .. } if name == "0"));

    assert!(set_prop.is_some(), "Should have SetProp patch for child");

    if let Some(Patch::SetProp { value, .. }) = set_prop {
        assert_eq!(
            value.as_str().unwrap(),
            "Counter: 5",
            "Child template string should be interpolated with new state"
        );
    }
}

// ============================================================================
// Expression Evaluation Tests
// ============================================================================

/// Test ternary expression in template string
#[test]
fn test_ternary_expression_evaluation() {
    let source = r#"Text("@{state.active ? 'Active' : 'Inactive'}")"#;
    let element = parse_to_element(source);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"active": true});

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // Check that the ternary expression is evaluated
    if let Some(Patch::Create { props, .. }) =
        patches.iter().find(|p| matches!(p, Patch::Create { .. }))
    {
        let prop_value = props.get("0").expect("Should have prop 0");
        assert_eq!(
            prop_value.as_str().unwrap(),
            "Active",
            "Ternary should evaluate to 'Active' when state.active is true"
        );
    } else {
        panic!("No Create patch found");
    }
}

/// Test ternary expression with false condition
#[test]
fn test_ternary_expression_false_condition() {
    let source = r#"Text("@{state.active ? 'Active' : 'Inactive'}")"#;
    let element = parse_to_element(source);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"active": false});

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    if let Some(Patch::Create { props, .. }) =
        patches.iter().find(|p| matches!(p, Patch::Create { .. }))
    {
        let prop_value = props.get("0").expect("Should have prop 0");
        assert_eq!(
            prop_value.as_str().unwrap(),
            "Inactive",
            "Ternary should evaluate to 'Inactive' when state.active is false"
        );
    }
}

/// Test ternary expression with color values (common UI pattern)
#[test]
fn test_ternary_expression_with_colors() {
    let source = r#"Column { }.backgroundColor("@{state.selected ? '#FFA7E1' : '#374151'}")"#;
    let element = parse_to_element(source);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"selected": true});

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    if let Some(Patch::Create { props, .. }) =
        patches.iter().find(|p| matches!(p, Patch::Create { .. }))
    {
        // Applicator props are named "applicatorName.argIndex" (e.g., "backgroundColor.0")
        let bg_color = props
            .get("backgroundColor.0")
            .expect("Should have backgroundColor.0");
        assert_eq!(
            bg_color.as_str().unwrap(),
            "#FFA7E1",
            "Color should be #FFA7E1 when selected is true"
        );
    }
}

/// Test comparison expression in template
#[test]
fn test_comparison_expression() {
    let source = r#"Text("@{state.count > 10 ? 'Many' : 'Few'}")"#;
    let element = parse_to_element(source);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"count": 15});

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    if let Some(Patch::Create { props, .. }) =
        patches.iter().find(|p| matches!(p, Patch::Create { .. }))
    {
        let prop_value = props.get("0").expect("Should have prop 0");
        assert_eq!(
            prop_value.as_str().unwrap(),
            "Many",
            "Should evaluate to 'Many' when count > 10"
        );
    }
}

/// Test logical AND expression
#[test]
fn test_logical_and_expression() {
    let source = r#"Text("@{state.a && state.b ? 'Both true' : 'Not both'}")"#;
    let element = parse_to_element(source);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"a": true, "b": true});

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    if let Some(Patch::Create { props, .. }) =
        patches.iter().find(|p| matches!(p, Patch::Create { .. }))
    {
        let prop_value = props.get("0").expect("Should have prop 0");
        assert_eq!(
            prop_value.as_str().unwrap(),
            "Both true",
            "Should evaluate to 'Both true' when both a and b are true"
        );
    }
}

/// Test mixed expression with text
#[test]
fn test_mixed_expression_with_text() {
    let source = r#"Text("Status: @{state.loading ? 'Loading...' : 'Ready'}")"#;
    let element = parse_to_element(source);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"loading": true});

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    if let Some(Patch::Create { props, .. }) =
        patches.iter().find(|p| matches!(p, Patch::Create { .. }))
    {
        let prop_value = props.get("0").expect("Should have prop 0");
        assert_eq!(
            prop_value.as_str().unwrap(),
            "Status: Loading...",
            "Should combine static text with expression result"
        );
    }
}

/// Test string concatenation in expression
#[test]
fn test_string_concatenation_expression() {
    let source = r#"Text("@{state.first + ' ' + state.last}")"#;
    let element = parse_to_element(source);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"first": "John", "last": "Doe"});

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    if let Some(Patch::Create { props, .. }) =
        patches.iter().find(|p| matches!(p, Patch::Create { .. }))
    {
        let prop_value = props.get("0").expect("Should have prop 0");
        assert_eq!(
            prop_value.as_str().unwrap(),
            "John Doe",
            "Should concatenate strings"
        );
    }
}

/// Test expression state update triggers re-evaluation
#[test]
fn test_expression_state_update() {
    let source = r#"Text("@{state.selected ? 'Selected' : 'Not selected'}")"#;
    let element = parse_to_element(source);

    // Create module with initial state
    let module = Module::new("TestModule");
    let initial_state = json!({"selected": false});
    let mut instance = ModuleInstance::new(module, initial_state);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let mut scheduler = Scheduler::new();

    // Initial render - should show "Not selected"
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        instance.get_state(),
        &mut dependencies,
    );
    let node_id = tree.root().expect("Should have root");
    tree.set_root(node_id);

    // Verify initial render
    if let Some(Patch::Create { props, .. }) =
        patches.iter().find(|p| matches!(p, Patch::Create { .. }))
    {
        assert_eq!(
            props.get("0").unwrap().as_str().unwrap(),
            "Not selected",
            "Initial render should show 'Not selected'"
        );
    }

    // Update state to selected = true
    instance.update_state(json!({"selected": true}));

    // Mark affected nodes dirty
    let affected = dependencies.get_affected_nodes("selected");
    for &id in &affected {
        scheduler.mark_dirty(id);
    }

    // Render dirty nodes
    let update_patches =
        hypen_engine::render::render_dirty_nodes(&mut scheduler, &mut tree, Some(&instance));

    // Should have SetProp patch with re-evaluated expression
    let set_prop = update_patches
        .iter()
        .find(|p| matches!(p, Patch::SetProp { name, .. } if name == "0"));

    assert!(
        set_prop.is_some(),
        "Should have SetProp patch after state change"
    );

    if let Some(Patch::SetProp { value, .. }) = set_prop {
        assert_eq!(
            value.as_str().unwrap(),
            "Selected",
            "Expression should re-evaluate to 'Selected' after state change"
        );
    }
}

/// Test complex nested expression
#[test]
fn test_complex_nested_expression() {
    let source =
        r#"Text("@{state.user.premium && state.user.age >= 18 ? 'VIP Adult' : 'Standard'}")"#;
    let element = parse_to_element(source);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({
        "user": {
            "premium": true,
            "age": 25
        }
    });

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    if let Some(Patch::Create { props, .. }) =
        patches.iter().find(|p| matches!(p, Patch::Create { .. }))
    {
        let prop_value = props.get("0").expect("Should have prop 0");
        assert_eq!(
            prop_value.as_str().unwrap(),
            "VIP Adult",
            "Complex expression should evaluate correctly"
        );
    }
}
