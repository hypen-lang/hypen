/// Tests for reconcile dependency tracking bug
///
/// These tests verify that dependencies are correctly tracked not just during
/// initial creation, but also during reconciliation.
use hypen_engine::{
    ir::{Element, IRNode, Value},
    reactive::{Binding, DependencyGraph},
    reconcile::{reconcile_ir, InstanceTree},
};
use serde_json::json;

#[test]
fn test_reconcile_tracks_dependencies_on_first_render() {
    // GIVEN: Element with binding
    let mut element = Element::new("Text");
    element.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec!["count".to_string()])),
    );

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"count": 0});

    // WHEN: First render (tree is empty)
    reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Dependencies should be tracked
    let affected = dependencies.get_affected_nodes("count");
    assert!(
        !affected.is_empty(),
        "BUG: First render should track dependencies"
    );
}

#[test]
fn test_reconcile_tracks_dependencies_on_second_render() {
    // GIVEN: Element with binding, rendered once
    let mut element = Element::new("Text");
    element.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec!["count".to_string()])),
    );

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"count": 0});

    // First render
    reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // WHEN: Clear dependencies and render again (simulating Engine.render())
    dependencies.clear();
    reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Dependencies should be tracked again
    let affected = dependencies.get_affected_nodes("count");
    assert!(
        !affected.is_empty(),
        "BUG: Second render should re-track dependencies after clear"
    );
}

#[test]
fn test_reconcile_tracks_dependencies_with_prop_changes() {
    // GIVEN: Element with binding
    let mut element = Element::new("Text");
    element.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec!["message".to_string()])),
    );

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    // First render with state1
    let state1 = json!({"message": "Hello"});
    reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state1,
        &mut dependencies,
    );

    // WHEN: Clear dependencies and reconcile with new state
    dependencies.clear();
    let state2 = json!({"message": "World"});
    reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state2,
        &mut dependencies,
    );

    // THEN: Dependencies should still be tracked
    let affected = dependencies.get_affected_nodes("message");
    assert!(
        !affected.is_empty(),
        "BUG: Reconcile with prop changes should re-track dependencies"
    );
}

#[test]
fn test_reconcile_tracks_multiple_bindings_on_rerender() {
    // GIVEN: Element with multiple bindings
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

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({
        "user": {"name": "Alice"},
        "theme": {"color": "blue"}
    });

    // First render
    reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // WHEN: Clear and re-render
    dependencies.clear();
    reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    // THEN: Both dependencies should be tracked
    let affected_user = dependencies.get_affected_nodes("user.name");
    assert!(
        !affected_user.is_empty(),
        "BUG: Should re-track user.name dependency"
    );

    let affected_theme = dependencies.get_affected_nodes("theme.color");
    assert!(
        !affected_theme.is_empty(),
        "BUG: Should re-track theme.color dependency"
    );
}
