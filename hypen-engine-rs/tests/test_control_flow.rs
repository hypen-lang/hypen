// Tests for first-class control flow components: ForEach, When, If

use hypen_engine::ir::{ast_to_ir_node, ConditionalBranch, Element, IRNode, Props, Value};
use hypen_engine::reactive::{Binding, DependencyGraph};
use hypen_engine::reconcile::{reconcile_ir, InstanceTree, Patch};
use hypen_parser::parse_component;
use serde_json::json;

// ============================================================================
// Patch Verification Tests - Control flow nodes should NOT appear in patches
// ============================================================================

#[test]
fn test_foreach_patches_exclude_container() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({
        "items": [
            {"id": "1", "name": "Item 1"},
            {"id": "2", "name": "Item 2"}
        ]
    });

    let ir_node = IRNode::ForEach {
        source: Binding::state(vec!["items".to_string()]),
        item_name: "item".to_string(),
        key_path: Some("id".to_string()),
        template: vec![IRNode::Element(Element::new("Text"))],
        props: Props::new(),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));

    // Verify NO patches reference __ForEach
    for patch in &patches {
        if let Patch::Create { element_type, .. } = patch {
            assert_ne!(
                element_type, "__ForEach",
                "Patches should not contain __ForEach"
            );
        }
    }

    // Should have Create patches only for the actual Text elements
    let create_patches: Vec<_> = patches
        .iter()
        .filter(|p| matches!(p, Patch::Create { .. }))
        .collect();
    assert_eq!(
        create_patches.len(),
        2,
        "Should have 2 Create patches for Text elements"
    );
}

#[test]
fn test_conditional_patches_exclude_container() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "status": "loading" });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["status".to_string()])),
        branches: vec![ConditionalBranch::new(
            Value::Static(json!("loading")),
            vec![IRNode::Element(Element::new("Spinner"))],
        )],
        fallback: Some(vec![IRNode::Element(Element::new("Content"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));

    // Verify NO patches reference __Conditional
    for patch in &patches {
        if let Patch::Create { element_type, .. } = patch {
            assert_ne!(
                element_type, "__Conditional",
                "Patches should not contain __Conditional"
            );
        }
    }

    // Should have Create patch only for the Spinner (matched branch)
    let create_patches: Vec<_> = patches
        .iter()
        .filter(|p| matches!(p, Patch::Create { .. }))
        .collect();
    assert_eq!(
        create_patches.len(),
        1,
        "Should have 1 Create patch for Spinner"
    );
}

// ============================================================================
// ForEach Tests
// ============================================================================

#[test]
fn test_foreach_basic_parsing() {
    let input = r#"
        ForEach(items: @state.todos, as: "todo", key: "id") {
            Text(@item.name)
        }
    "#;

    let component = parse_component(input).unwrap();
    let ir_node = ast_to_ir_node(&component);

    match ir_node {
        IRNode::ForEach {
            source,
            item_name,
            key_path,
            template,
            ..
        } => {
            assert!(source.is_state(), "Source should be a state binding");
            assert_eq!(source.path, vec!["todos"]);
            assert_eq!(item_name, "todo");
            assert_eq!(key_path, Some("id".to_string()));
            assert_eq!(template.len(), 1);
        }
        _ => panic!("Expected ForEach IRNode, got {:?}", ir_node),
    }
}

#[test]
fn test_foreach_positional_syntax() {
    let input = r#"
        ForEach(@state.items) {
            Text(@item.name)
        }
    "#;

    let component = parse_component(input).unwrap();
    let ir_node = ast_to_ir_node(&component);

    match ir_node {
        IRNode::ForEach {
            source,
            item_name,
            key_path,
            ..
        } => {
            assert!(source.is_state(), "Source should be a state binding");
            assert_eq!(source.path, vec!["items"]);
            assert_eq!(item_name, "item"); // default
            assert_eq!(key_path, None);
        }
        _ => panic!("Expected ForEach IRNode, got {:?}", ir_node),
    }
}

#[test]
fn test_foreach_creates_container() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({
        "items": [
            {"id": "1", "name": "Item 1"},
            {"id": "2", "name": "Item 2"}
        ]
    });

    let ir_node = IRNode::ForEach {
        source: Binding::state(vec!["items".to_string()]),
        item_name: "item".to_string(),
        key_path: Some("id".to_string()),
        template: vec![IRNode::Element(Element::new("Text").with_prop(
            "0",
            Value::Binding(Binding::item(vec!["name".to_string()])),
        ))],
        props: Props::new(),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    // Should have created container + 2 children
    let container = tree.get(node_id).unwrap();
    assert_eq!(container.element_type, "__ForEach");
    assert_eq!(container.children.len(), 2);

    // Check that dependency was registered
    let affected = deps.get_affected_nodes("items");
    assert!(affected.contains(&node_id));
}

#[test]
fn test_foreach_empty_array() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({
        "items": []
    });

    let ir_node = IRNode::ForEach {
        source: Binding::state(vec!["items".to_string()]),
        item_name: "item".to_string(),
        key_path: None,
        template: vec![IRNode::Element(Element::new("Text"))],
        props: Props::new(),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    assert_eq!(container.children.len(), 0);
}

#[test]
fn test_foreach_nested() {
    let input = r#"
        ForEach(items: @state.categories, as: "category", key: "id") {
            Column {
                Text(@item.name)
                ForEach(items: @item.products, as: "product") {
                    Text(@item.title)
                }
            }
        }
    "#;

    let component = parse_component(input).unwrap();
    let ir_node = ast_to_ir_node(&component);

    match ir_node {
        IRNode::ForEach { template, .. } => {
            assert_eq!(template.len(), 1);
            // The Column should contain a nested ForEach
            match &template[0] {
                IRNode::Element(element) => {
                    assert_eq!(element.element_type, "Column");
                    assert_eq!(element.ir_children.len(), 2);
                }
                _ => panic!("Expected Element in template"),
            }
        }
        _ => panic!("Expected ForEach IRNode"),
    }
}

// ============================================================================
// When Tests
// ============================================================================

#[test]
fn test_when_basic_parsing() {
    let input = r#"
        When(value: @state.status) {
            Case(match: "loading") {
                Text("Loading...")
            }
            Case(match: "ready") {
                Text("Ready!")
            }
            Else {
                Text("Unknown")
            }
        }
    "#;

    let component = parse_component(input).unwrap();
    let ir_node = ast_to_ir_node(&component);

    match ir_node {
        IRNode::Conditional {
            value,
            branches,
            fallback,
            module_scope: None,
        } => {
            match value {
                Value::Binding(b) => {
                    assert!(b.is_state());
                    assert_eq!(b.path, vec!["status"]);
                }
                _ => panic!("Expected binding value"),
            }
            assert_eq!(branches.len(), 2);
            assert!(fallback.is_some());
        }
        _ => panic!("Expected Conditional IRNode, got {:?}", ir_node),
    }
}

#[test]
fn test_when_renders_matching_branch() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({
        "status": "loading"
    });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["status".to_string()])),
        branches: vec![
            ConditionalBranch::new(
                Value::Static(json!("loading")),
                vec![IRNode::Element(Element::new("Spinner"))],
            ),
            ConditionalBranch::new(
                Value::Static(json!("ready")),
                vec![IRNode::Element(Element::new("Content"))],
            ),
        ],
        fallback: Some(vec![IRNode::Element(Element::new("Error"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    assert_eq!(container.element_type, "__Conditional");
    assert_eq!(container.children.len(), 1);

    // Verify the Spinner was rendered (loading branch)
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "Spinner");
}

#[test]
fn test_when_renders_fallback() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({
        "status": "unknown_status"
    });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["status".to_string()])),
        branches: vec![ConditionalBranch::new(
            Value::Static(json!("loading")),
            vec![IRNode::Element(Element::new("Spinner"))],
        )],
        fallback: Some(vec![IRNode::Element(Element::new("Fallback"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    assert_eq!(container.children.len(), 1);

    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "Fallback");
}

#[test]
fn test_when_no_match_no_fallback() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({
        "status": "unknown"
    });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["status".to_string()])),
        branches: vec![ConditionalBranch::new(
            Value::Static(json!("loading")),
            vec![IRNode::Element(Element::new("Spinner"))],
        )],
        fallback: None,
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    assert_eq!(container.children.len(), 0);
}

// ============================================================================
// If Tests
// ============================================================================

#[test]
fn test_if_basic_parsing() {
    let input = r#"
        If(condition: @state.isLoggedIn) {
            Text("Welcome!")
            Else {
                Text("Please log in")
            }
        }
    "#;

    let component = parse_component(input).unwrap();
    let ir_node = ast_to_ir_node(&component);

    match ir_node {
        IRNode::Conditional {
            value,
            branches,
            fallback,
            module_scope: None,
        } => {
            match value {
                Value::Binding(b) => {
                    assert!(b.is_state());
                    assert_eq!(b.path, vec!["isLoggedIn"]);
                }
                _ => panic!("Expected binding value"),
            }
            // If creates one branch for true
            assert_eq!(branches.len(), 1);
            match &branches[0].pattern {
                Value::Static(v) => assert_eq!(*v, json!(true)),
                _ => panic!("Expected static true pattern"),
            }
            // Else becomes fallback
            assert!(fallback.is_some());
        }
        _ => panic!("Expected Conditional IRNode, got {:?}", ir_node),
    }
}

#[test]
fn test_if_true_condition() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({
        "isVisible": true
    });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["isVisible".to_string()])),
        branches: vec![ConditionalBranch::new(
            Value::Static(json!(true)),
            vec![IRNode::Element(Element::new("Content"))],
        )],
        fallback: Some(vec![IRNode::Element(Element::new("Hidden"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "Content");
}

#[test]
fn test_if_false_condition() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({
        "isVisible": false
    });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["isVisible".to_string()])),
        branches: vec![ConditionalBranch::new(
            Value::Static(json!(true)),
            vec![IRNode::Element(Element::new("Content"))],
        )],
        fallback: Some(vec![IRNode::Element(Element::new("Hidden"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "Hidden");
}

// ============================================================================
// Legacy List Pattern Tests
// ============================================================================

#[test]
fn test_list_creates_wrapper_with_foreach_child() {
    // List(@state.items) { Text(@item.name) }
    // should create a List wrapper Element with a ForEach IR child
    let input = r#"
        List(@state.todos) {
            Text(@item.name)
        }
    "#;

    let component = parse_component(input).unwrap();
    let ir_node = ast_to_ir_node(&component);

    match &ir_node {
        IRNode::Element(element) => {
            assert_eq!(
                element.element_type, "List",
                "Wrapper should be a List element"
            );
            assert_eq!(
                element.ir_children.len(),
                1,
                "Should have one ForEach IR child"
            );
            match &element.ir_children[0] {
                IRNode::ForEach {
                    source, item_name, ..
                } => {
                    assert!(source.is_state());
                    assert_eq!(source.path, vec!["todos"]);
                    assert_eq!(item_name, "item");
                }
                _ => panic!(
                    "Expected ForEach IR child, got {:?}",
                    element.ir_children[0]
                ),
            }
        }
        _ => panic!(
            "Expected Element(List) with ForEach child, got {:?}",
            ir_node
        ),
    }
}

// ============================================================================
// Reconciliation Tests
// ============================================================================

#[test]
fn test_foreach_reconciliation_add_items() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    // Initial state with 2 items
    let initial_state = json!({
        "items": [
            {"id": "1", "name": "Item 1"},
            {"id": "2", "name": "Item 2"}
        ]
    });

    let ir_node = IRNode::ForEach {
        source: Binding::state(vec!["items".to_string()]),
        item_name: "item".to_string(),
        key_path: Some("id".to_string()),
        template: vec![IRNode::Element(Element::new("Text"))],
        props: Props::new(),
        module_scope: None,
    };

    patches.extend(reconcile_ir(
        &mut tree,
        &ir_node,
        None,
        &initial_state,
        &mut deps,
    ));
    let node_id = tree.root().expect("Should have root");

    // Now update with 3 items
    let new_state = json!({
        "items": [
            {"id": "1", "name": "Item 1"},
            {"id": "2", "name": "Item 2"},
            {"id": "3", "name": "Item 3"}
        ]
    });

    let mut update_patches = Vec::new();
    update_patches.extend(reconcile_ir(
        &mut tree, &ir_node, None, &new_state, &mut deps,
    ));

    // Should have generated create patches for the new item
    let container = tree.get(node_id).unwrap();
    assert_eq!(container.children.len(), 3);
}

#[test]
fn test_conditional_reconciliation_branch_change() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    // Initial state: loading
    let initial_state = json!({ "status": "loading" });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["status".to_string()])),
        branches: vec![
            ConditionalBranch::new(
                Value::Static(json!("loading")),
                vec![IRNode::Element(Element::new("Spinner"))],
            ),
            ConditionalBranch::new(
                Value::Static(json!("ready")),
                vec![IRNode::Element(Element::new("Content"))],
            ),
        ],
        fallback: None,
        module_scope: None,
    };

    patches.extend(reconcile_ir(
        &mut tree,
        &ir_node,
        None,
        &initial_state,
        &mut deps,
    ));
    let node_id = tree.root().expect("Should have root");

    // Verify initial render
    let container = tree.get(node_id).unwrap();
    let initial_child = tree.get(container.children[0]).unwrap();
    assert_eq!(initial_child.element_type, "Spinner");

    // Update to ready state
    let new_state = json!({ "status": "ready" });

    let mut update_patches = Vec::new();
    update_patches.extend(reconcile_ir(
        &mut tree, &ir_node, None, &new_state, &mut deps,
    ));

    // Should have removed Spinner and created Content
    let container = tree.get(node_id).unwrap();
    assert_eq!(container.children.len(), 1);
    let new_child = tree.get(container.children[0]).unwrap();
    assert_eq!(new_child.element_type, "Content");
}

// ============================================================================
// Integration Tests
// ============================================================================

#[test]
fn test_complex_nested_control_flow() {
    let input = r#"
        Column {
            If(condition: @state.isLoading) {
                Text("Loading...")
                Else {
                    ForEach(items: @state.users, as: "user", key: "id") {
                        Row {
                            Text(@item.name)
                            When(value: @item.role) {
                                Case(match: "admin") {
                                    Text("Admin Badge")
                                }
                                Case(match: "user") {
                                    Text("User Badge")
                                }
                            }
                        }
                    }
                }
            }
        }
    "#;

    let component = parse_component(input).unwrap();
    let ir_node = ast_to_ir_node(&component);

    // The Column should be an Element
    match ir_node {
        IRNode::Element(element) => {
            assert_eq!(element.element_type, "Column");
            assert_eq!(element.ir_children.len(), 1);
        }
        _ => panic!("Expected Element for Column, got {:?}", ir_node),
    }
}

#[test]
fn test_foreach_with_props() {
    // Test ForEach with additional styling props passed as named arguments
    // Note: Applicators after braces are not supported by the parser, so we pass props inline
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({
        "items": [{"id": "1", "name": "Item 1"}]
    });

    // Create ForEach with additional props
    let mut props = Props::new();
    props.insert("padding.0".to_string(), Value::Static(json!(16)));
    props.insert("gap.0".to_string(), Value::Static(json!(8)));

    let ir_node = IRNode::ForEach {
        source: Binding::state(vec!["items".to_string()]),
        item_name: "item".to_string(),
        key_path: None,
        template: vec![IRNode::Element(Element::new("Text"))],
        props,
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    // Verify props are stored on the container
    let container = tree.get(node_id).unwrap();
    assert!(container.props.contains_key("padding.0"));
    assert!(container.props.contains_key("gap.0"));
    assert_eq!(container.props.get("padding.0"), Some(&json!(16)));
    assert_eq!(container.props.get("gap.0"), Some(&json!(8)));
}

// ============================================================================
// Expression Pattern Matching Tests
// ============================================================================

#[test]
fn test_when_expression_greater_than() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "count": 150 });

    // Use expression patterns for range matching
    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["count".to_string()])),
        branches: vec![
            ConditionalBranch::new(
                Value::TemplateString {
                    template: "@{value > 100}".to_string(),
                    bindings: vec![],
                },
                vec![IRNode::Element(Element::new("Large"))],
            ),
            ConditionalBranch::new(
                Value::TemplateString {
                    template: "@{value > 10}".to_string(),
                    bindings: vec![],
                },
                vec![IRNode::Element(Element::new("Medium"))],
            ),
        ],
        fallback: Some(vec![IRNode::Element(Element::new("Small"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    assert_eq!(container.children.len(), 1);
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "Large");
}

#[test]
fn test_when_expression_medium_range() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "count": 50 });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["count".to_string()])),
        branches: vec![
            ConditionalBranch::new(
                Value::TemplateString {
                    template: "@{value > 100}".to_string(),
                    bindings: vec![],
                },
                vec![IRNode::Element(Element::new("Large"))],
            ),
            ConditionalBranch::new(
                Value::TemplateString {
                    template: "@{value > 10}".to_string(),
                    bindings: vec![],
                },
                vec![IRNode::Element(Element::new("Medium"))],
            ),
        ],
        fallback: Some(vec![IRNode::Element(Element::new("Small"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "Medium");
}

#[test]
fn test_when_expression_fallback() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "count": 5 });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["count".to_string()])),
        branches: vec![
            ConditionalBranch::new(
                Value::TemplateString {
                    template: "@{value > 100}".to_string(),
                    bindings: vec![],
                },
                vec![IRNode::Element(Element::new("Large"))],
            ),
            ConditionalBranch::new(
                Value::TemplateString {
                    template: "@{value > 10}".to_string(),
                    bindings: vec![],
                },
                vec![IRNode::Element(Element::new("Medium"))],
            ),
        ],
        fallback: Some(vec![IRNode::Element(Element::new("Small"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "Small");
}

#[test]
fn test_when_expression_string_equality() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "role": "admin" });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["role".to_string()])),
        branches: vec![
            ConditionalBranch::new(
                Value::TemplateString {
                    template: "@{value == 'admin'}".to_string(),
                    bindings: vec![],
                },
                vec![IRNode::Element(Element::new("AdminPanel"))],
            ),
            ConditionalBranch::new(
                Value::TemplateString {
                    template: "@{value == 'user'}".to_string(),
                    bindings: vec![],
                },
                vec![IRNode::Element(Element::new("UserDashboard"))],
            ),
        ],
        fallback: Some(vec![IRNode::Element(Element::new("GuestView"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "AdminPanel");
}

#[test]
fn test_when_expression_logical_and() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    // value is an object with multiple properties
    let state = json!({
        "user": {
            "isAdmin": true,
            "isActive": true
        }
    });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["user".to_string()])),
        branches: vec![ConditionalBranch::new(
            Value::TemplateString {
                template: "@{value.isAdmin && value.isActive}".to_string(),
                bindings: vec![],
            },
            vec![IRNode::Element(Element::new("ActiveAdmin"))],
        )],
        fallback: Some(vec![IRNode::Element(Element::new("Regular"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "ActiveAdmin");
}

#[test]
fn test_when_mixed_static_and_expression() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "status": "loading" });

    // Mix static matches with expression patterns
    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["status".to_string()])),
        branches: vec![
            // Static match first
            ConditionalBranch::new(
                Value::Static(json!("loading")),
                vec![IRNode::Element(Element::new("Spinner"))],
            ),
            // Expression match
            ConditionalBranch::new(
                Value::TemplateString {
                    template: "@{value == 'error'}".to_string(),
                    bindings: vec![],
                },
                vec![IRNode::Element(Element::new("ErrorView"))],
            ),
        ],
        fallback: Some(vec![IRNode::Element(Element::new("Content"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    // Should match the static "loading" first
    assert_eq!(child.element_type, "Spinner");
}

// ============================================================================
// Wildcard Pattern Matching Tests
// ============================================================================

#[test]
fn test_when_wildcard_underscore() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "value": "any_string_here" });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["value".to_string()])),
        branches: vec![
            ConditionalBranch::new(
                Value::Static(json!("specific")),
                vec![IRNode::Element(Element::new("Specific"))],
            ),
            ConditionalBranch::new(
                Value::Static(json!("_")),
                vec![IRNode::Element(Element::new("Wildcard"))],
            ),
        ],
        fallback: None,
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "Wildcard");
}

#[test]
fn test_when_wildcard_asterisk() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "count": 42 });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["count".to_string()])),
        branches: vec![
            ConditionalBranch::new(
                Value::Static(json!(100)),
                vec![IRNode::Element(Element::new("Hundred"))],
            ),
            ConditionalBranch::new(
                Value::Static(json!("*")),
                vec![IRNode::Element(Element::new("AnyValue"))],
            ),
        ],
        fallback: None,
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "AnyValue");
}

#[test]
fn test_when_wildcard_matches_null() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "value": null });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["value".to_string()])),
        branches: vec![ConditionalBranch::new(
            Value::Static(json!("_")),
            vec![IRNode::Element(Element::new("CatchAll"))],
        )],
        fallback: None,
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "CatchAll");
}

// ============================================================================
// Multiple Values Pattern Matching Tests
// ============================================================================

#[test]
fn test_when_multiple_values_matches_first() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "status": "loading" });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["status".to_string()])),
        branches: vec![
            ConditionalBranch::new(
                Value::Static(json!(["loading", "pending", "fetching"])),
                vec![IRNode::Element(Element::new("InProgress"))],
            ),
            ConditionalBranch::new(
                Value::Static(json!(["success", "complete"])),
                vec![IRNode::Element(Element::new("Done"))],
            ),
        ],
        fallback: Some(vec![IRNode::Element(Element::new("Other"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "InProgress");
}

#[test]
fn test_when_multiple_values_matches_middle() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "status": "pending" });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["status".to_string()])),
        branches: vec![ConditionalBranch::new(
            Value::Static(json!(["loading", "pending", "fetching"])),
            vec![IRNode::Element(Element::new("InProgress"))],
        )],
        fallback: Some(vec![IRNode::Element(Element::new("Other"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "InProgress");
}

#[test]
fn test_when_multiple_values_no_match() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "status": "error" });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["status".to_string()])),
        branches: vec![
            ConditionalBranch::new(
                Value::Static(json!(["loading", "pending"])),
                vec![IRNode::Element(Element::new("InProgress"))],
            ),
            ConditionalBranch::new(
                Value::Static(json!(["success", "complete"])),
                vec![IRNode::Element(Element::new("Done"))],
            ),
        ],
        fallback: Some(vec![IRNode::Element(Element::new("ErrorView"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "ErrorView");
}

#[test]
fn test_when_multiple_numeric_values() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "code": 404 });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["code".to_string()])),
        branches: vec![
            ConditionalBranch::new(
                Value::Static(json!([200, 201, 204])),
                vec![IRNode::Element(Element::new("Success"))],
            ),
            ConditionalBranch::new(
                Value::Static(json!([400, 401, 403, 404])),
                vec![IRNode::Element(Element::new("ClientError"))],
            ),
            ConditionalBranch::new(
                Value::Static(json!([500, 502, 503])),
                vec![IRNode::Element(Element::new("ServerError"))],
            ),
        ],
        fallback: Some(vec![IRNode::Element(Element::new("Unknown"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "ClientError");
}

// ============================================================================
// Exact Value Matching Tests (ensuring existing functionality works)
// ============================================================================

#[test]
fn test_when_exact_number_match() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "count": 42 });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["count".to_string()])),
        branches: vec![ConditionalBranch::new(
            Value::Static(json!(42)),
            vec![IRNode::Element(Element::new("TheAnswer"))],
        )],
        fallback: Some(vec![IRNode::Element(Element::new("Other"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "TheAnswer");
}

#[test]
fn test_when_exact_null_match() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "user": null });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["user".to_string()])),
        branches: vec![ConditionalBranch::new(
            Value::Static(serde_json::Value::Null),
            vec![IRNode::Element(Element::new("NoUser"))],
        )],
        fallback: Some(vec![IRNode::Element(Element::new("HasUser"))]),
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "NoUser");
}

#[test]
fn test_when_exact_boolean_match() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "isEnabled": true });

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["isEnabled".to_string()])),
        branches: vec![
            ConditionalBranch::new(
                Value::Static(json!(true)),
                vec![IRNode::Element(Element::new("Enabled"))],
            ),
            ConditionalBranch::new(
                Value::Static(json!(false)),
                vec![IRNode::Element(Element::new("Disabled"))],
            ),
        ],
        fallback: None,
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    assert_eq!(child.element_type, "Enabled");
}

// ============================================================================
// Combined Pattern Matching Tests
// ============================================================================

#[test]
fn test_when_combined_patterns() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let state = json!({ "score": 85 });

    // Combine different pattern types in one When
    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["score".to_string()])),
        branches: vec![
            // Exact match
            ConditionalBranch::new(
                Value::Static(json!(100)),
                vec![IRNode::Element(Element::new("Perfect"))],
            ),
            // Range match
            ConditionalBranch::new(
                Value::Static(json!("90..99")),
                vec![IRNode::Element(Element::new("GradeA"))],
            ),
            // Expression pattern
            ConditionalBranch::new(
                Value::TemplateString {
                    template: "@{value >= 70}".to_string(),
                    bindings: vec![],
                },
                vec![IRNode::Element(Element::new("Passing"))],
            ),
            // Wildcard for anything else
            ConditionalBranch::new(
                Value::Static(json!("_")),
                vec![IRNode::Element(Element::new("Failing"))],
            ),
        ],
        fallback: None,
        module_scope: None,
    };

    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    let child = tree.get(container.children[0]).unwrap();
    // 85 doesn't match 100 or 90-99, but matches >= 70
    assert_eq!(child.element_type, "Passing");
}

// ============================================================================
// Conditional reconciliation: branch diffing tests
// ============================================================================

/// When switching from a branch with 1 child to a branch with 2 children,
/// the shared prefix (first child) should be reconciled (diffed), and only
/// the second child should be freshly created.
#[test]
fn test_conditional_reconciliation_grow_children() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["mode".to_string()])),
        branches: vec![
            // "simple" branch: 1 child
            ConditionalBranch::new(
                Value::Static(json!("simple")),
                vec![IRNode::Element(Element::new("Header"))],
            ),
            // "detailed" branch: 2 children, first is the same type
            ConditionalBranch::new(
                Value::Static(json!("detailed")),
                vec![
                    IRNode::Element(Element::new("Header")),
                    IRNode::Element(Element::new("Details")),
                ],
            ),
        ],
        fallback: None,
        module_scope: None,
    };

    // Initial render in "simple" mode
    let state = json!({ "mode": "simple" });
    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    assert_eq!(container.children.len(), 1);
    let header_id = container.children[0];
    assert_eq!(tree.get(header_id).unwrap().element_type, "Header");

    // Switch to "detailed" mode
    let new_state = json!({ "mode": "detailed" });
    let mut update_patches = Vec::new();
    update_patches.extend(reconcile_ir(
        &mut tree, &ir_node, None, &new_state, &mut deps,
    ));

    let container = tree.get(node_id).unwrap();
    assert_eq!(container.children.len(), 2, "Should now have 2 children");

    // First child should have been reconciled (same type = reused), not recreated
    let first_child = tree.get(container.children[0]).unwrap();
    assert_eq!(first_child.element_type, "Header");

    let second_child = tree.get(container.children[1]).unwrap();
    assert_eq!(second_child.element_type, "Details");

    // There should be a Create patch for Details but NOT a Remove+Create for Header
    let remove_patches: Vec<_> = update_patches
        .iter()
        .filter(|p| matches!(p, Patch::Remove { .. }))
        .collect();
    assert_eq!(
        remove_patches.len(),
        0,
        "No nodes should be removed when growing"
    );

    let create_patches: Vec<_> = update_patches
        .iter()
        .filter(|p| matches!(p, Patch::Create { .. }))
        .collect();
    assert_eq!(
        create_patches.len(),
        1,
        "Only the new Details child should be created"
    );
}

/// When switching from a branch with 2 children to a branch with 1,
/// the first child should be reconciled and the surplus removed.
#[test]
fn test_conditional_reconciliation_shrink_children() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["mode".to_string()])),
        branches: vec![
            ConditionalBranch::new(
                Value::Static(json!("detailed")),
                vec![
                    IRNode::Element(Element::new("Header")),
                    IRNode::Element(Element::new("Details")),
                ],
            ),
            ConditionalBranch::new(
                Value::Static(json!("simple")),
                vec![IRNode::Element(Element::new("Header"))],
            ),
        ],
        fallback: None,
        module_scope: None,
    };

    // Initial render with 2 children
    let state = json!({ "mode": "detailed" });
    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    assert_eq!(container.children.len(), 2);

    // Switch to "simple" mode
    let new_state = json!({ "mode": "simple" });
    let mut update_patches = Vec::new();
    update_patches.extend(reconcile_ir(
        &mut tree, &ir_node, None, &new_state, &mut deps,
    ));

    let container = tree.get(node_id).unwrap();
    assert_eq!(container.children.len(), 1, "Should now have 1 child");
    assert_eq!(
        tree.get(container.children[0]).unwrap().element_type,
        "Header"
    );

    // Exactly one Remove patch for the removed Details node
    let remove_patches: Vec<_> = update_patches
        .iter()
        .filter(|p| matches!(p, Patch::Remove { .. }))
        .collect();
    assert!(
        !remove_patches.is_empty(),
        "Details child should be removed"
    );
}

/// Switching to an empty branch (no match, no fallback) removes all children.
#[test]
fn test_conditional_reconciliation_to_no_match() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["status".to_string()])),
        branches: vec![ConditionalBranch::new(
            Value::Static(json!("active")),
            vec![
                IRNode::Element(Element::new("Header")),
                IRNode::Element(Element::new("Content")),
            ],
        )],
        fallback: None,
        module_scope: None,
    };

    let state = json!({ "status": "active" });
    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");
    assert_eq!(tree.get(node_id).unwrap().children.len(), 2);

    // Switch to unmatched value
    let new_state = json!({ "status": "unknown" });
    let mut update_patches = Vec::new();
    update_patches.extend(reconcile_ir(
        &mut tree, &ir_node, None, &new_state, &mut deps,
    ));

    assert_eq!(
        tree.get(node_id).unwrap().children.len(),
        0,
        "All children should be removed"
    );
}

/// Tab-switch scenario: three branches sharing the same wrapper structure.
/// Switching tabs should reconcile the shared Column wrapper, only replacing
/// the inner content, rather than tearing down the whole subtree.
#[test]
fn test_conditional_reconciliation_tab_switch_reuses_structure() {
    let mut tree = InstanceTree::new();
    let mut patches = Vec::new();
    let mut deps = DependencyGraph::new();

    // Build three "tab" branches: each is a Column wrapping different content
    let make_tab = |label: &str| -> Vec<IRNode> {
        let inner = Element::new("Column").with_child(Element::new(label));
        vec![IRNode::Element(inner)]
    };

    let ir_node = IRNode::Conditional {
        value: Value::Binding(Binding::state(vec!["tab".to_string()])),
        branches: vec![
            ConditionalBranch::new(Value::Static(json!("home")), make_tab("HomeContent")),
            ConditionalBranch::new(
                Value::Static(json!("settings")),
                make_tab("SettingsContent"),
            ),
            ConditionalBranch::new(Value::Static(json!("profile")), make_tab("ProfileContent")),
        ],
        fallback: None,
        module_scope: None,
    };

    // Render "home" tab
    let state = json!({ "tab": "home" });
    patches.extend(reconcile_ir(&mut tree, &ir_node, None, &state, &mut deps));
    let node_id = tree.root().expect("Should have root");

    let container = tree.get(node_id).unwrap();
    assert_eq!(container.children.len(), 1);
    let column_id = container.children[0];
    assert_eq!(tree.get(column_id).unwrap().element_type, "Column");

    // Switch to "settings" tab
    let new_state = json!({ "tab": "settings" });
    let mut update_patches = Vec::new();
    update_patches.extend(reconcile_ir(
        &mut tree, &ir_node, None, &new_state, &mut deps,
    ));

    // The Column should be reconciled (same type), not removed+recreated
    let container = tree.get(node_id).unwrap();
    assert_eq!(container.children.len(), 1);

    // Column is still there and reused (same slot)
    let column_after = tree.get(container.children[0]).unwrap();
    assert_eq!(column_after.element_type, "Column");

    // No Remove patches for the Column itself - it was diffed
    let column_id_str = format!("{:?}", column_id);
    let remove_patches: Vec<_> = update_patches
        .iter()
        .filter(|p| {
            if let Patch::Remove { id } = p {
                *id == column_id_str
            } else {
                false
            }
        })
        .collect();
    assert_eq!(
        remove_patches.len(),
        0,
        "Column should be reused via reconciliation, not removed"
    );
}
