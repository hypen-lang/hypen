//! Integration tests for Children() slot functionality
//! Moved from src/ir/children_slots_test.rs to tests/.

use hypen_engine::ir::{Component, ComponentRegistry, Element, IRNode, Value};

/// Helper to create a simple text element
fn text(content: &str) -> Element {
    let mut el = Element::new("Text");
    el.props
        .insert("0".to_string(), Value::Static(serde_json::json!(content)));
    el
}

/// Helper to unwrap an IRNode::Element reference
fn unwrap_el(node: &IRNode) -> &Element {
    match node {
        IRNode::Element(e) => e,
        other => panic!("Expected Element, got {:?}", other),
    }
}

#[test]
fn test_simple_children_slot() {
    // Create a component that has a Children() placeholder
    let component = Component::new("Card", |_props| {
        Element::new("Container")
            .with_child(text("Card Header"))
            .with_child(Element::new("Children"))
            .with_child(text("Card Footer"))
    });

    let mut registry = ComponentRegistry::new();
    registry.register(component);

    // Create an instance with actual children
    let card_instance = Element::new("Card")
        .with_child(text("Child 1"))
        .with_child(text("Child 2"));

    // Expand the component
    let expanded = registry.expand(&card_instance);

    // Should have: header, child1, child2, footer
    assert_eq!(expanded.element_type, "Container");
    assert_eq!(expanded.ir_children.len(), 4);

    // Verify order
    assert_eq!(unwrap_el(&expanded.ir_children[0]).element_type, "Text"); // header
    assert_eq!(unwrap_el(&expanded.ir_children[1]).element_type, "Text"); // child 1
    assert_eq!(unwrap_el(&expanded.ir_children[2]).element_type, "Text"); // child 2
    assert_eq!(unwrap_el(&expanded.ir_children[3]).element_type, "Text"); // footer
}

#[test]
fn test_named_slot() {
    // Component with header and body slots
    let component = Component::new("Dialog", |_props| {
        let mut header_slot = Element::new("Children");
        header_slot.props.insert(
            "slot.0".to_string(),
            Value::Static(serde_json::json!("header")),
        );
        let header = Element::new("Container").with_child(
            // Can't use with_child because it wraps in IRNode::Element,
            // but we need to set props on the Children element first
            {
                let mut el = Element::new("Children");
                el.props.insert(
                    "slot.0".to_string(),
                    Value::Static(serde_json::json!("header")),
                );
                el
            },
        );

        let body = Element::new("Container").with_child({
            let mut el = Element::new("Children");
            el.props.insert(
                "slot.0".to_string(),
                Value::Static(serde_json::json!("body")),
            );
            el
        });

        Element::new("Column").with_child(header).with_child(body)
    });

    let mut registry = ComponentRegistry::new();
    registry.register(component);

    // Create instance with slotted children using .slot() applicator
    let mut header_child = text("Dialog Title");
    header_child.props.insert(
        "slot.0".to_string(),
        Value::Static(serde_json::json!("header")),
    );

    let mut body_child = text("Dialog Content");
    body_child.props.insert(
        "slot.0".to_string(),
        Value::Static(serde_json::json!("body")),
    );

    let mut dialog = Element::new("Dialog");
    dialog.ir_children.push(IRNode::Element(header_child));
    dialog.ir_children.push(IRNode::Element(body_child));

    let expanded = registry.expand(&dialog);

    // Verify structure
    assert_eq!(expanded.element_type, "Column");
    assert_eq!(expanded.ir_children.len(), 2); // header container, body container

    // Check header slot received header child
    let header_container = unwrap_el(&expanded.ir_children[0]);
    assert_eq!(header_container.ir_children.len(), 1);
    assert_eq!(
        unwrap_el(&header_container.ir_children[0]).element_type,
        "Text"
    );

    // Check body slot received body child
    let body_container = unwrap_el(&expanded.ir_children[1]);
    assert_eq!(body_container.ir_children.len(), 1);
    assert_eq!(
        unwrap_el(&body_container.ir_children[0]).element_type,
        "Text"
    );
}

#[test]
fn test_default_slot_without_applicator() {
    // Component with both named and default slots
    let component = Component::new("Panel", |_props| {
        let header = Element::new("Container").with_child({
            let mut el = Element::new("Children");
            el.props.insert(
                "slot.0".to_string(),
                Value::Static(serde_json::json!("header")),
            );
            el
        });

        let body = Element::new("Container").with_child(Element::new("Children")); // default slot

        Element::new("Column").with_child(header).with_child(body)
    });

    let mut registry = ComponentRegistry::new();
    registry.register(component);

    let mut header_child = text("Panel Header");
    header_child.props.insert(
        "slot.0".to_string(),
        Value::Static(serde_json::json!("header")),
    );

    let mut panel = Element::new("Panel");
    panel.ir_children.push(IRNode::Element(header_child));
    panel
        .ir_children
        .push(IRNode::Element(text("Default Content 1")));
    panel
        .ir_children
        .push(IRNode::Element(text("Default Content 2")));

    let expanded = registry.expand(&panel);

    // Header should have 1 child
    let header_container = unwrap_el(&expanded.ir_children[0]);
    assert_eq!(header_container.ir_children.len(), 1);

    // Default slot should have 2 children
    let body_container = unwrap_el(&expanded.ir_children[1]);
    assert_eq!(body_container.ir_children.len(), 2);
}

#[test]
fn test_nested_children_slots() {
    // Outer component with Children slot
    let outer = Component::new("Outer", |_props| {
        Element::new("Container")
            .with_child(text("Outer Start"))
            .with_child(Element::new("Inner").with_child(Element::new("Children")))
            .with_child(text("Outer End"))
    });

    // Inner component also with Children slot
    let inner = Component::new("Inner", |_props| {
        Element::new("Container")
            .with_child(text("Inner Start"))
            .with_child(Element::new("Children"))
            .with_child(text("Inner End"))
    });

    let mut registry = ComponentRegistry::new();
    registry.register(outer);
    registry.register(inner);

    // Create nested usage
    let outer_instance = Element::new("Outer").with_child(text("Actual Content"));

    let expanded = registry.expand(&outer_instance);

    // Should have: Outer Start, Inner (with nested structure), Outer End
    assert_eq!(expanded.ir_children.len(), 3);
    assert_eq!(unwrap_el(&expanded.ir_children[0]).element_type, "Text"); // Outer Start
    assert_eq!(
        unwrap_el(&expanded.ir_children[1]).element_type,
        "Container"
    ); // Inner expanded
    assert_eq!(unwrap_el(&expanded.ir_children[2]).element_type, "Text"); // Outer End

    // Check Inner expanded correctly
    let inner_expanded = unwrap_el(&expanded.ir_children[1]);
    assert_eq!(inner_expanded.ir_children.len(), 3);
    assert_eq!(
        unwrap_el(&inner_expanded.ir_children[0]).element_type,
        "Text"
    ); // Inner Start
    assert_eq!(
        unwrap_el(&inner_expanded.ir_children[1]).element_type,
        "Text"
    ); // Actual Content
    assert_eq!(
        unwrap_el(&inner_expanded.ir_children[2]).element_type,
        "Text"
    ); // Inner End
}

#[test]
fn test_multiple_children_of_same_slot() {
    let component = Component::new("Section", |_props| {
        let actions_row = Element::new("Row").with_child({
            let mut el = Element::new("Children");
            el.props.insert(
                "slot.0".to_string(),
                Value::Static(serde_json::json!("actions")),
            );
            el
        });

        Element::new("Column").with_child(actions_row)
    });

    let mut registry = ComponentRegistry::new();
    registry.register(component);

    let mut action1 = Element::new("Button").with_child(text("Action 1"));
    action1.props.insert(
        "slot.0".to_string(),
        Value::Static(serde_json::json!("actions")),
    );

    let mut action2 = Element::new("Button").with_child(text("Action 2"));
    action2.props.insert(
        "slot.0".to_string(),
        Value::Static(serde_json::json!("actions")),
    );

    let mut section = Element::new("Section");
    section.ir_children.push(IRNode::Element(action1));
    section.ir_children.push(IRNode::Element(action2));

    let expanded = registry.expand(&section);

    // Actions row should have both buttons
    let column = &expanded;
    let actions_row = unwrap_el(&column.ir_children[0]);
    assert_eq!(actions_row.ir_children.len(), 2);
    assert_eq!(
        unwrap_el(&actions_row.ir_children[0]).element_type,
        "Button"
    );
    assert_eq!(
        unwrap_el(&actions_row.ir_children[1]).element_type,
        "Button"
    );
}

#[test]
fn test_empty_children_slot() {
    let component = Component::new("Optional", |_props| {
        Element::new("Container")
            .with_child(text("Before"))
            .with_child(Element::new("Children"))
            .with_child(text("After"))
    });

    let mut registry = ComponentRegistry::new();
    registry.register(component);

    // Create instance with NO children
    let instance = Element::new("Optional");

    let expanded = registry.expand(&instance);

    // Should just have before and after, no children in between
    assert_eq!(expanded.ir_children.len(), 2);
    assert_eq!(unwrap_el(&expanded.ir_children[0]).element_type, "Text"); // Before
    assert_eq!(unwrap_el(&expanded.ir_children[1]).element_type, "Text"); // After
}

#[test]
fn test_children_slot_deep_in_tree() {
    // Component with Children slot nested deep in the tree
    let component = Component::new("DeepCard", |_props| {
        Element::new("Container").with_child(
            Element::new("Column").with_child(
                Element::new("Row")
                    .with_child(Element::new("Container").with_child(Element::new("Children"))),
            ),
        )
    });

    let mut registry = ComponentRegistry::new();
    registry.register(component);

    let instance = Element::new("DeepCard").with_child(text("Deep Child"));

    let expanded = registry.expand(&instance);

    // Navigate deep into the tree
    let col = unwrap_el(&expanded.ir_children[0]);
    let row = unwrap_el(&col.ir_children[0]);
    let container = unwrap_el(&row.ir_children[0]);
    let deep_child = unwrap_el(&container.ir_children[0]);
    assert_eq!(deep_child.element_type, "Text");
}
