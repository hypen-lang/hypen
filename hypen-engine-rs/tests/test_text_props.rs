//! Test that Text elements have their text content in props

use hypen_engine::ir::{ast_to_ir_node, IRNode};
use hypen_engine::reactive::DependencyGraph;
use hypen_engine::reconcile::{reconcile_ir, InstanceTree, Patch};
use hypen_parser::parse_component;
use serde_json::json;

#[test]
fn test_text_element_has_props_from_parser() {
    // Parse a simple Text component
    let source = r#"Text("Hello World")"#;
    let component = parse_component(source).expect("Should parse");

    // Check parser output
    println!("Parser output:");
    println!("  name: {}", component.name);
    println!("  arguments: {:?}", component.arguments);

    // Convert to IR
    let element = match ast_to_ir_node(&component) {
        IRNode::Element(e) => e,
        other => panic!("Expected Element, got {:?}", other),
    };

    println!("IR Element:");
    println!("  element_type: {}", element.element_type);
    println!("  props: {:?}", element.props);

    // Check that prop "0" contains the text
    assert!(
        element.props.contains_key("0"),
        "Element should have prop '0'"
    );
}

#[test]
fn test_text_element_patches_include_props() {
    // Parse a simple Text component
    let source = r#"Text("Hello World")"#;
    let component = parse_component(source).expect("Should parse");
    let element = match ast_to_ir_node(&component) {
        IRNode::Element(e) => e,
        other => panic!("Expected Element, got {:?}", other),
    };

    // Create tree and collect patches
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(element.clone()),
        None,
        &state,
        &mut dependencies,
    );

    println!("Patches:");
    for patch in &patches {
        println!("  {:?}", patch);
    }

    // Find the Create patch
    let create_patch = patches.iter().find(|p| matches!(p, Patch::Create { .. }));
    assert!(create_patch.is_some(), "Should have a Create patch");

    if let Some(Patch::Create { props, .. }) = create_patch {
        println!("Create patch props: {:?}", props);
        assert!(props.contains_key("0"), "Create patch should have prop '0'");
        assert_eq!(
            props.get("0"),
            Some(&json!("Hello World")),
            "Prop '0' should be 'Hello World'"
        );
    }
}

#[test]
fn test_column_with_text_children() {
    let source = r#"
        Column {
            Text("First")
            Text("Second")
        }
    "#;

    let component = parse_component(source).expect("Should parse");
    let ir_node = ast_to_ir_node(&component);

    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    let patches = reconcile_ir(&mut tree, &ir_node, None, &state, &mut dependencies);

    println!("All patches:");
    for (i, patch) in patches.iter().enumerate() {
        match patch {
            Patch::Create {
                id,
                element_type,
                props,
            } => {
                println!(
                    "  [{}] Create: id={}, type={}, props={:?}",
                    i, id, element_type, props
                );
            }
            Patch::Insert { parent_id, id, .. } => {
                println!("  [{}] Insert: parent={}, id={}", i, parent_id, id);
            }
            _ => println!("  [{}] {:?}", i, patch),
        }
    }

    // Count Text creates with props
    let text_creates: Vec<_> = patches
        .iter()
        .filter(|p| {
            if let Patch::Create {
                element_type,
                props,
                ..
            } = p
            {
                element_type == "Text" && props.contains_key("0")
            } else {
                false
            }
        })
        .collect();

    assert_eq!(
        text_creates.len(),
        2,
        "Should have 2 Text creates with prop '0'"
    );
}
