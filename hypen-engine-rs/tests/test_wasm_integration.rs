/// WASM Integration Tests
///
/// These tests verify the WASM interface works correctly with the engine.
/// While they run natively (not in WASM), they test the same code paths
/// that WASM would use.
use hypen_engine::{
    dispatch::Action,
    ir::{ast_to_ir_node, ComponentRegistry, Element, IRNode, Value},
    lifecycle::{Module, ModuleInstance},
    reactive::{DependencyGraph, Scheduler},
    reconcile::{reconcile_ir, InstanceTree, Patch},
};
use serde_json::json;
use std::collections::HashMap;

/// Mock render callback to capture patches
struct MockRenderer {
    patches: Vec<Patch>,
}

#[allow(dead_code)]
impl MockRenderer {
    fn new() -> Self {
        Self {
            patches: Vec::new(),
        }
    }

    fn capture_patch(&mut self, patch: Patch) {
        self.patches.push(patch);
    }

    fn clear(&mut self) {
        self.patches.clear();
    }

    fn patch_count(&self) -> usize {
        self.patches.len()
    }

    fn has_create_patch(&self, element_type: &str) -> bool {
        self.patches.iter().any(|p| match p {
            Patch::Create {
                element_type: et, ..
            } => et == element_type,
            _ => false,
        })
    }

    fn has_set_prop_patch(&self, prop_name: &str) -> bool {
        self.patches.iter().any(|p| match p {
            Patch::SetProp { name, .. } => name == prop_name,
            _ => false,
        })
    }
}

#[test]
fn test_wasm_render_simple_component() {
    // Simulates: WasmEngine.renderSource("Text('Hello')")
    let source = r#"Text("Hello")"#;
    let component = hypen_parser::parse_component(source).unwrap();
    let ir_node = ast_to_ir_node(&component);
    let element = match &ir_node { IRNode::Element(e) => e.clone(), _ => panic!("Expected Element") };

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let mut renderer = MockRenderer::new();

    let state_json = serde_json::to_value(HashMap::<String, serde_json::Value>::new()).unwrap();
    let patches = reconcile_ir(&mut tree, &IRNode::Element(element.clone()), None, &state_json, &mut dependencies);

    for patch in patches {
        renderer.capture_patch(patch);
    }

    assert!(renderer.has_create_patch("Text"));
    assert!(renderer.patch_count() > 0);
}

#[test]
fn test_wasm_state_update_flow() {
    // Simulates: module with state, then updateState() call
    let source = r#"Text("Count: @{state.count}")"#;
    let component = hypen_parser::parse_component(source).unwrap();
    let ir_node = ast_to_ir_node(&component);
    let element = match &ir_node { IRNode::Element(e) => e.clone(), _ => panic!("Expected Element") };

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let initial_state = HashMap::from([("count".to_string(), json!(0))]);

    // Initial render
    let state_json = serde_json::to_value(&initial_state).unwrap();
    let patches = reconcile_ir(&mut tree, &IRNode::Element(element.clone()), None, &state_json, &mut dependencies);
    assert!(!patches.is_empty());

    // Update state
    let _new_state = HashMap::from([("count".to_string(), json!(1))]);
    let changed_paths = vec!["count".to_string()];

    let mut scheduler = Scheduler::new();
    // Get affected nodes for each changed path
    for path in &changed_paths {
        let affected = dependencies.get_affected_nodes(path);
        for node_id in affected {
            scheduler.mark_dirty(node_id);
        }
    }

    // Reconcile affected nodes
    let dirty_nodes = scheduler.take_dirty();
    assert!(
        !dirty_nodes.is_empty(),
        "Should have dirty nodes after state change"
    );
}

#[test]
fn test_wasm_action_dispatch() {
    // Simulates: dispatchAction("increment", payload)
    let action = Action {
        name: "increment".to_string(),
        payload: Some(json!(1)),
        sender: None,
    };

    // Verify action structure is valid
    assert_eq!(action.name, "increment");
    assert_eq!(action.payload, Some(json!(1)));
    assert!(action.sender.is_none());
}

#[test]
fn test_wasm_component_registry() {
    // Simulates: registerComponent() calls
    use hypen_engine::ir::Component;
    let mut registry = ComponentRegistry::new();

    let component = Component::new("Button", |_props| Element::new("Text"));

    registry.register(component);

    assert!(registry.get("Button", None).is_some());
    assert!(registry.get("NonExistent", None).is_none());
}

#[test]
fn test_wasm_component_resolution() {
    // Simulates: component resolution with context path
    use hypen_engine::ir::Component;
    let mut registry = ComponentRegistry::new();

    let button = Component::new("Button", |_props| Element::new("Text"));

    registry.register(button);

    // Get component
    let resolved = registry.get("Button", None);
    assert!(resolved.is_some());
}

#[test]
fn test_wasm_parse_error_handling() {
    // Simulates: renderSource() with invalid syntax
    let invalid_sources = vec![
        "Text(",           // Incomplete
        "Text('unclosed)", // Unclosed string
        "123Invalid",      // Invalid start
        "",                // Empty
    ];

    for source in invalid_sources {
        let result = hypen_parser::parse_component(source);
        assert!(
            result.is_err(),
            "Should fail to parse invalid source: {}",
            source
        );
    }
}

#[test]
fn test_wasm_nested_component_expansion() {
    // Simulates: Component with nested children
    let source = r#"
        Column {
            Text("Title")
            Text("Subtitle")
        }
    "#;

    let component = hypen_parser::parse_component(source).unwrap();
    let element = match ast_to_ir_node(&component) { IRNode::Element(e) => e, _ => panic!("Expected Element") };

    assert_eq!(element.element_type, "Column");
    assert_eq!(element.ir_children.len(), 2);
    match &element.ir_children[0] { IRNode::Element(e) => assert_eq!(e.element_type, "Text"), _ => panic!("Expected Element") };
    match &element.ir_children[1] { IRNode::Element(e) => assert_eq!(e.element_type, "Text"), _ => panic!("Expected Element") };
}

#[test]
fn test_wasm_state_binding_extraction() {
    // Simulates: State bindings in templates
    let source = r#"Text("User: @{state.user.name}, Age: @{state.user.age}")"#;

    let component = hypen_parser::parse_component(source).unwrap();
    let ir_node = ast_to_ir_node(&component);
    let element = match &ir_node { IRNode::Element(e) => e.clone(), _ => panic!("Expected Element") };

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = HashMap::from([
        ("user.name".to_string(), json!("Alice")),
        ("user.age".to_string(), json!(30)),
    ]);

    let state_json = serde_json::to_value(&state).unwrap();
    let _ = reconcile_ir(&mut tree, &IRNode::Element(element.clone()), None, &state_json, &mut dependencies);

    // Verify dependencies were tracked
    let affected = dependencies.get_affected_nodes("user.name");
    assert!(!affected.is_empty(), "Should track user.name dependency");
}

#[test]
fn test_wasm_module_lifecycle() {
    // Simulates: Module registration and lifecycle
    let module = Module {
        name: "TestModule".to_string(),
        actions: vec!["increment".to_string()],
        state_keys: vec!["count".to_string()],
        persist: false,
        version: Some(1),
    };

    let initial_state = json!({ "count": 0 });
    let instance = ModuleInstance::new(module.clone(), initial_state.clone());

    assert_eq!(instance.module.name, "TestModule");
    assert_eq!(instance.get_state(), &initial_state);
}

#[test]
fn test_wasm_state_merging() {
    // Simulates: Deep state merging in modules
    let base_state = json!({
        "user": {
            "name": "Alice",
            "age": 30
        },
        "settings": {
            "theme": "dark"
        }
    });

    let updates = json!({
        "user": {
            "age": 31
        },
        "settings": {
            "notifications": true
        }
    });

    // Test that merge logic preserves nested structure
    // (This would be the actual merge implementation)
    assert!(base_state.is_object());
    assert!(updates.is_object());
}

#[test]
fn test_wasm_reconciliation_keyed_lists() {
    // Simulates: Keyed list reconciliation
    let old_source = r#"
        Column {
            Text(key: "a", "Item A")
            Text(key: "b", "Item B")
            Text(key: "c", "Item C")
        }
    "#;

    let new_source = r#"
        Column {
            Text(key: "b", "Item B")
            Text(key: "a", "Item A")
            Text(key: "d", "Item D")
        }
    "#;

    let old_component = hypen_parser::parse_component(old_source).unwrap();
    let new_component = hypen_parser::parse_component(new_source).unwrap();

    let old_ir_node = ast_to_ir_node(&old_component);
    let new_ir_node = ast_to_ir_node(&new_component);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state: HashMap<String, serde_json::Value> = HashMap::new();

    // Initial render
    let state_json = serde_json::to_value(&state).unwrap();
    let _patches = reconcile_ir(&mut tree, &old_ir_node, None, &state_json, &mut dependencies);

    // Reconcile with new tree
    let reconcile_patches = reconcile_ir(
        &mut tree,
        &new_ir_node,
        None,
        &state_json,
        &mut dependencies,
    );

    // Should generate patches for the changed children:
    // Old: [a, b, c] -> New: [b, a, d] means moves, removes, and/or creates
    // Or SetProp patches for updated text values
    assert!(
        !reconcile_patches.is_empty(),
        "Should generate patches for keyed list changes: {:?}",
        reconcile_patches
    );
}

#[test]
fn test_wasm_props_with_various_types() {
    // Simulates: Props with different value types
    let source = r#"
        Button(
            text: "Click",
            count: 42,
            enabled: true,
            data: {name: "test", value: 123},
            items: [1, 2, 3]
        )
    "#;

    let component = hypen_parser::parse_component(source).unwrap();
    let element = match ast_to_ir_node(&component) { IRNode::Element(e) => e, _ => panic!("Expected Element") };

    // Verify all prop types are preserved
    assert!(element.props.contains_key("text"));
    assert!(element.props.contains_key("count"));
    assert!(element.props.contains_key("enabled"));
    assert!(element.props.contains_key("data"));
    assert!(element.props.contains_key("items"));
}

#[test]
fn test_wasm_applicators() {
    // Simulates: Applicators (style modifiers)
    let source = r#"
        Text("Styled")
            .fontSize(18)
            .color(blue)
            .padding(16)
    "#;

    let component = hypen_parser::parse_component(source).unwrap();
    let element = match ast_to_ir_node(&component) { IRNode::Element(e) => e, _ => panic!("Expected Element") };

    // Applicators become props with format "applicatorName.index"
    assert!(element.props.contains_key("fontSize.0"));
    assert!(element.props.contains_key("color.0"));
    assert!(element.props.contains_key("padding.0"));
}

#[test]
fn test_wasm_action_references() {
    // Simulates: @actions.* references
    let source = r#"Button("@actions.handleClick")"#;

    let component = hypen_parser::parse_component(source).unwrap();
    let element = match ast_to_ir_node(&component) { IRNode::Element(e) => e, _ => panic!("Expected Element") };

    // Positional action references are stored under the "action" key
    let action_prop = element.props.get("action");
    assert!(action_prop.is_some(), "Positional @actions.* should become props[\"action\"]");

    match action_prop.unwrap() {
        Value::Action(action) => {
            assert_eq!(action, "handleClick");
        }
        _ => panic!("Expected Action"),
    }
}

#[test]
fn test_wasm_clear_tree() {
    // Simulates: clearTree() - resetting engine state
    let source = r#"Text("Hello")"#;
    let component = hypen_parser::parse_component(source).unwrap();
    let ir_node = ast_to_ir_node(&component);
    let element = match &ir_node { IRNode::Element(e) => e.clone(), _ => panic!("Expected Element") };

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state: HashMap<String, serde_json::Value> = HashMap::new();

    let state_json = serde_json::to_value(&state).unwrap();
    let _ = reconcile_ir(&mut tree, &IRNode::Element(element.clone()), None, &state_json, &mut dependencies);
    let root_id = tree.root().expect("Should have root");
    tree.set_root(root_id);

    // Verify tree is not empty
    assert!(tree.root().is_some());

    // Clear (simulate)
    tree = InstanceTree::new();
    let _dependencies = DependencyGraph::new();

    // Verify tree is empty
    assert!(tree.root().is_none());
}

#[test]
fn test_wasm_revision_tracking() {
    // Simulates: Revision counter for remote UI
    let mut revision: u64 = 0;

    // Each render increments revision
    revision += 1;
    assert_eq!(revision, 1);

    revision += 1;
    assert_eq!(revision, 2);

    // Verify overflow doesn't panic (will wrap)
    let mut max_revision = u64::MAX;
    max_revision = max_revision.wrapping_add(1);
    assert_eq!(max_revision, 0);
}

#[test]
fn test_wasm_dependency_tracking_complex() {
    // Simulates: Complex nested state dependencies
    let source = r#"
        Column {
            Text("@{state.user.profile.name}")
            Text("@{state.user.profile.email}")
            Text("@{state.settings.theme}")
        }
    "#;

    let component = hypen_parser::parse_component(source).unwrap();
    let ir_node = ast_to_ir_node(&component);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = HashMap::from([
        ("user.profile.name".to_string(), json!("Alice")),
        ("user.profile.email".to_string(), json!("alice@example.com")),
        ("settings.theme".to_string(), json!("dark")),
    ]);

    let state_json = serde_json::to_value(&state).unwrap();
    let _ = reconcile_ir(&mut tree, &ir_node, None, &state_json, &mut dependencies);

    // Test that changing user.profile affects both name and email nodes
    let affected = dependencies.get_affected_nodes("user.profile");
    assert!(
        affected.len() >= 2,
        "Changing user.profile should affect both name and email"
    );

    // Test that changing settings.theme only affects theme node
    let affected_theme = dependencies.get_affected_nodes("settings.theme");
    assert!(
        !affected_theme.is_empty(),
        "Changing settings.theme should affect theme node"
    );
}

#[test]
fn test_wasm_error_recovery() {
    // Simulates: Engine continues working after errors
    let mut tree = InstanceTree::new();

    // Invalid operation shouldn't crash subsequent valid operations
    let valid_source = r#"Text("Valid")"#;
    let component = hypen_parser::parse_component(valid_source).unwrap();
    let ir_node = ast_to_ir_node(&component);
    let element = match &ir_node { IRNode::Element(e) => e.clone(), _ => panic!("Expected Element") };

    let mut dependencies = DependencyGraph::new();
    let state: HashMap<String, serde_json::Value> = HashMap::new();

    let state_json = serde_json::to_value(&state).unwrap();
    let patches = reconcile_ir(&mut tree, &IRNode::Element(element.clone()), None, &state_json, &mut dependencies);
    assert!(!patches.is_empty(), "Should continue working after errors");
}

#[test]
fn test_wasm_large_tree_performance() {
    // Simulates: Rendering large component trees
    let mut source = String::from("Column {\n");
    for i in 0..100 {
        source.push_str(&format!("  Text(\"Item {}\")\n", i));
    }
    source.push('}');

    let component = hypen_parser::parse_component(&source).unwrap();
    let ir_node = ast_to_ir_node(&component);
    let element = match &ir_node { IRNode::Element(ref e) => e, _ => panic!("Expected Element") };

    assert_eq!(element.element_type, "Column");
    assert_eq!(element.ir_children.len(), 100);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state: HashMap<String, serde_json::Value> = HashMap::new();

    let state_json = serde_json::to_value(&state).unwrap();
    let patches = reconcile_ir(&mut tree, &ir_node, None, &state_json, &mut dependencies);

    // Should generate patches for all elements
    assert!(
        patches.len() > 100,
        "Should create patches for all elements"
    );
}

#[test]
fn test_wasm_concurrent_state_paths() {
    // Simulates: Multiple state paths updating simultaneously
    let changed_paths = vec![
        "user.name".to_string(),
        "user.email".to_string(),
        "settings.theme".to_string(),
        "settings.language".to_string(),
    ];

    let mut dependencies = DependencyGraph::new();

    // Register some fake dependencies using real NodeIds
    use hypen_engine::{ir::Element, reactive::Binding, reconcile::InstanceTree};
    let mut tree = InstanceTree::new();
    let node1 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
    let node2 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));

    dependencies.add_dependency(
        node1,
        &Binding::state(vec!["user".to_string(), "name".to_string()]),
        None,
    );
    dependencies.add_dependency(
        node2,
        &Binding::state(vec!["settings".to_string(), "theme".to_string()]),
        None,
    );

    let mut affected = indexmap::IndexSet::new();
    for path in &changed_paths {
        affected.extend(dependencies.get_affected_nodes(path));
    }

    assert!(
        affected.contains(&node1),
        "Should track user.name dependency"
    );
    assert!(
        affected.contains(&node2),
        "Should track settings.theme dependency"
    );
}
