/// Tests for create_tree dependency tracking
///
/// These tests verify that dependencies are correctly tracked when creating
/// a tree from elements with bindings.
use hypen_engine::{
    ir::{Element, IRNode, Value},
    reactive::{Binding, DependencyGraph},
    reconcile::{reconcile_ir, InstanceTree, Patch},
};
use serde_json::json;

#[test]
fn test_create_tree_tracks_single_binding() {
    // GIVEN: Element with a single binding
    let mut element = Element::new("Text");
    element.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec!["count".to_string()])),
    );

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"count": 42});

    // WHEN: Create tree
    let _ = reconcile_ir(&mut tree, &IRNode::Element(element.clone()), None, &state, &mut dependencies);
    let node_id = tree.root().expect("Should have root");

    // THEN: Dependency should be tracked
    let affected = dependencies.get_affected_nodes("count");
    assert!(
        !affected.is_empty(),
        "Should track dependency for 'count' binding"
    );
    assert!(
        affected.contains(&node_id),
        "Should track the created node as dependent on 'count'"
    );
}

#[test]
fn test_create_tree_tracks_multiple_bindings_same_node() {
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
            "textColor".to_string(),
        ])),
    );

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({
        "user": {"name": "Alice"},
        "theme": {"textColor": "blue"}
    });

    // WHEN: Create tree
    let _ = reconcile_ir(&mut tree, &IRNode::Element(element.clone()), None, &state, &mut dependencies);
    let node_id = tree.root().expect("Should have root");

    // THEN: Both dependencies should be tracked
    let affected_user = dependencies.get_affected_nodes("user.name");
    assert!(
        affected_user.contains(&node_id),
        "Should track dependency for 'user.name'"
    );

    let affected_theme = dependencies.get_affected_nodes("theme.textColor");
    assert!(
        affected_theme.contains(&node_id),
        "Should track dependency for 'theme.textColor'"
    );
}

#[test]
fn test_create_tree_tracks_nested_children_separately() {
    // GIVEN: Parent with child, both have bindings
    let mut parent = Element::new("Column");
    parent.props.insert(
        "width".to_string(),
        Value::Binding(Binding::state(vec![
            "layout".to_string(),
            "width".to_string(),
        ])),
    );

    let mut child = Element::new("Text");
    child.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec!["user".to_string(), "name".to_string()])),
    );
    parent.ir_children.push(IRNode::Element(child));

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({
        "layout": {"width": 100},
        "user": {"name": "Bob"}
    });

    // WHEN: Create tree
    let _ = reconcile_ir(&mut tree, &IRNode::Element(parent.clone()), None, &state, &mut dependencies);
    let parent_id = tree.root().expect("Should have root");

    // THEN: Parent depends on layout.width
    let affected_layout = dependencies.get_affected_nodes("layout.width");
    assert!(
        affected_layout.contains(&parent_id),
        "Parent should depend on 'layout.width'"
    );

    // AND: Some node depends on user.name (the child)
    let affected_user = dependencies.get_affected_nodes("user.name");
    assert!(
        !affected_user.is_empty(),
        "Child should depend on 'user.name'"
    );
    assert!(
        affected_user.len() == 1,
        "Should have exactly one node depending on user.name"
    );
}

#[test]
fn test_create_tree_prefix_tracking() {
    // GIVEN: Element with nested path binding
    let mut element = Element::new("Text");
    element.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec![
            "user".to_string(),
            "profile".to_string(),
            "name".to_string(),
        ])),
    );

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"user": {"profile": {"name": "Charlie"}}});

    // WHEN: Create tree
    let _ = reconcile_ir(&mut tree, &IRNode::Element(element.clone()), None, &state, &mut dependencies);
    let node_id = tree.root().expect("Should have root");

    // THEN: Should track full path
    let affected_full = dependencies.get_affected_nodes("user.profile.name");
    assert!(
        affected_full.contains(&node_id),
        "Should track full path 'user.profile.name'"
    );

    // AND: Should be affected by parent path changes
    let affected_parent = dependencies.get_affected_nodes("user");
    assert!(
        affected_parent.contains(&node_id),
        "Should be affected when parent 'user' changes"
    );

    let affected_middle = dependencies.get_affected_nodes("user.profile");
    assert!(
        affected_middle.contains(&node_id),
        "Should be affected when middle path 'user.profile' changes"
    );
}

#[test]
fn test_create_tree_generates_correct_patches() {
    // GIVEN: Simple element with binding
    let mut element = Element::new("Text");
    element.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec!["message".to_string()])),
    );

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"message": "Hello World"});

    // WHEN: Create tree
    let patches = reconcile_ir(&mut tree, &IRNode::Element(element.clone()), None, &state, &mut dependencies);

    // THEN: Should generate Create and InsertRoot patches
    assert!(
        patches.len() >= 2,
        "Should generate at least Create and InsertRoot patches"
    );

    // Check for Create patch
    let has_create = patches.iter().any(|p| matches!(p, Patch::Create { .. }));
    assert!(has_create, "Should generate Create patch");

    // Check for InsertRoot patch
    let has_insert_root = patches.iter().any(|p| matches!(p, Patch::Insert { .. }));
    assert!(has_insert_root, "Should generate Insert patch");
}

#[test]
fn test_create_tree_resolves_bindings_to_values() {
    // GIVEN: Element with binding
    let mut element = Element::new("Text");
    element.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec!["greeting".to_string()])),
    );

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"greeting": "Hello, Test!"});

    // WHEN: Create tree
    let _ = reconcile_ir(&mut tree, &IRNode::Element(element.clone()), None, &state, &mut dependencies);
    let node_id = tree.root().expect("Should have root");

    // THEN: Node should have resolved prop value
    let node = tree.get(node_id).expect("Node should exist");
    let text_prop = node.props.get("text").expect("Should have 'text' prop");

    assert_eq!(
        text_prop,
        &json!("Hello, Test!"),
        "Binding should be resolved to actual state value"
    );
}

#[test]
fn test_create_tree_mixed_static_and_bindings() {
    // GIVEN: Element with mix of static props and bindings
    let mut element = Element::new("Text");
    element.props.insert(
        "text".to_string(),
        Value::Binding(Binding::state(vec!["dynamic".to_string()])),
    );
    element
        .props
        .insert("fontSize".to_string(), Value::Static(json!(16)));
    element
        .props
        .insert("color".to_string(), Value::Static(json!("blue")));

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({"dynamic": "Dynamic Text"});

    // WHEN: Create tree
    let _ = reconcile_ir(&mut tree, &IRNode::Element(element.clone()), None, &state, &mut dependencies);
    let node_id = tree.root().expect("Should have root");

    // THEN: Should only track binding, not static props
    let affected = dependencies.get_affected_nodes("dynamic");
    assert!(
        affected.contains(&node_id),
        "Should track 'dynamic' binding"
    );

    // AND: Node should have all props resolved
    let node = tree.get(node_id).unwrap();
    assert_eq!(node.props.get("text"), Some(&json!("Dynamic Text")));
    assert_eq!(node.props.get("fontSize"), Some(&json!(16)));
    assert_eq!(node.props.get("color"), Some(&json!("blue")));
}

#[test]
fn test_create_tree_no_bindings_no_dependencies() {
    // GIVEN: Element with only static props
    let mut element = Element::new("Text");
    element
        .props
        .insert("text".to_string(), Value::Static(json!("Static")));
    element
        .props
        .insert("color".to_string(), Value::Static(json!("red")));

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    // WHEN: Create tree
    let _ = reconcile_ir(&mut tree, &IRNode::Element(element.clone()), None, &state, &mut dependencies);

    // THEN: Should have no dependencies tracked
    let affected = dependencies.get_affected_nodes("anything");
    assert!(
        affected.is_empty(),
        "Should not track any dependencies for static-only element"
    );
}
