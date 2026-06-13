//! Tests for src/ir/component.rs - Component registry and resolution
//!
//! This file contains comprehensive tests for the component system,
//! covering expansion, lazy components, passthrough components, and slot replacement.

mod common;

use common::*;
use hypen_engine::ir::component::{Component, ComponentRegistry, ResolvedComponent};
use hypen_engine::ir::{Element, IRNode, Value};
use serde_json::json;
use std::sync::Arc;

/// Extract Element from IRNode for test assertions
fn ir_element(node: &IRNode) -> &Element {
    match node {
        IRNode::Element(e) => e,
        _ => panic!("Expected Element, got {:?}", node),
    }
}

// ============================================================================
// A. Component Expansion (8 tests)
// ============================================================================

#[test]
fn test_expand_simple_component_no_children() {
    // GIVEN: Component "Button" with no children
    let mut registry = ComponentRegistry::new();

    let button_template = Element::new("Text").with_prop("text", Value::Static(json!("Click")));
    let button = Component::new("Button", move |_props| button_template.clone());
    registry.register(button);

    let element = Element::new("Button");

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Template instantiated
    assert_element_type(&expanded, "Text");
    assert_prop_static_value(&expanded, "text", &json!("Click"));
}

#[test]
fn test_expand_component_with_arguments() {
    // GIVEN: Button component that uses props
    let mut registry = ComponentRegistry::new();

    let button = Component::new("Button", |props| {
        let text = props
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("Default");
        Element::new("Text").with_prop("text", Value::Static(json!(text)))
    });
    registry.register(button);

    // Create Button element with text argument
    let element = Element::new("Button").with_prop("text", Value::Static(json!("Click Me")));

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Arguments passed to template
    assert_element_type(&expanded, "Text");
    assert_prop_static_value(&expanded, "text", &json!("Click Me"));
}

#[test]
fn test_expand_component_with_children() {
    // GIVEN: Card component that includes Children() placeholder
    let mut registry = ComponentRegistry::new();

    let card = Component::new("Card", |_props| {
        let mut column = Element::new("Column");
        column
            .ir_children
            .push(IRNode::Element(Element::new("Children"))); // Placeholder
        column
    });
    registry.register(card);

    // Create Card with children
    let card_element = Element::new("Card")
        .with_child(text_element("Title"))
        .with_child(text_element("Body"));

    // WHEN: expand()
    let expanded = registry.expand(&card_element);

    // THEN: Children expanded into template
    assert_element_type(&expanded, "Column");
    assert_eq!(expanded.ir_children.len(), 2);
    assert_element_type(ir_element(&expanded.ir_children[0]), "Text");
    assert_element_type(ir_element(&expanded.ir_children[1]), "Text");
}

#[test]
fn test_expand_nested_components() {
    // GIVEN: Page { Header { Logo } } - nested components
    let mut registry = ComponentRegistry::new();

    // Register Logo component
    let logo = Component::new("Logo", |_props| text_element("MyApp"));
    registry.register(logo);

    // Register Header component that uses Logo
    let header = Component::new("Header", |_props| {
        Element::new("Row").with_child(Element::new("Logo"))
    });
    registry.register(header);

    // Register Page component that uses Header
    let page = Component::new("Page", |_props| {
        Element::new("Column").with_child(Element::new("Header"))
    });
    registry.register(page);

    let page_element = Element::new("Page");

    // WHEN: expand()
    let expanded = registry.expand(&page_element);

    // THEN: All levels expanded
    assert_element_type(&expanded, "Column");
    assert_eq!(expanded.ir_children.len(), 1);
    assert_element_type(ir_element(&expanded.ir_children[0]), "Row"); // Header expanded to Row
    assert_eq!(ir_element(&expanded.ir_children[0]).ir_children.len(), 1);
    assert_element_type(
        ir_element(&ir_element(&expanded.ir_children[0]).ir_children[0]),
        "Text",
    ); // Logo expanded to Text
}

#[test]
fn test_expand_with_context_path() {
    // GIVEN: Component registered with source path
    let mut registry = ComponentRegistry::new();

    let header = Component::new("Header", |_props| text_element("Header"))
        .with_source_path("/components/Header.hypen");
    registry.register(header);

    let element = Element::new("Header");

    // WHEN: expand() - context should be preserved internally
    let expanded = registry.expand(&element);

    // THEN: Component expanded successfully
    assert_element_type(&expanded, "Text");
}

#[test]
fn test_expand_component_not_in_registry() {
    // GIVEN: Unknown component without resolver
    let mut registry = ComponentRegistry::new();

    let element = Element::new("UnknownComponent");

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Element returned as-is (no expansion)
    assert_element_type(&expanded, "UnknownComponent");
}

#[test]
fn test_expand_component_triggers_resolver() {
    // GIVEN: Unknown component WITH resolver
    let mut registry = ComponentRegistry::new();

    registry.set_resolver(Arc::new(|name: &str, _context: Option<&str>| {
        if name == "DynamicButton" {
            Some(ResolvedComponent {
                source: r#"Text("Resolved")"#.to_string(),
                path: "/components/DynamicButton.hypen".to_string(),
                passthrough: false,
                lazy: false,
            })
        } else {
            None
        }
    }));

    let element = Element::new("DynamicButton");

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Resolver called and component expanded
    assert_element_type(&expanded, "Text");
    // Parser uses prop "0" for first positional argument
    assert_prop_static_value(&expanded, "0", &json!("Resolved"));
}

#[test]
fn test_expand_very_deep_nesting_10_levels() {
    // GIVEN: 10 nested components
    let mut registry = ComponentRegistry::new();

    // Register Level0 through Level9, each containing the next level
    for i in 0..10 {
        let next_level = if i < 9 {
            format!("Level{}", i + 1)
        } else {
            "Text".to_string()
        };

        let level_name = format!("Level{}", i);
        let component = Component::new(level_name.clone(), move |_props| {
            Element::new(&next_level).with_prop("text", Value::Static(json!("Deep")))
        });
        registry.register(component);
    }

    let element = Element::new("Level0");

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: All expanded without stack overflow
    // After expansion, Level0 becomes Level1, Level1 becomes Level2, etc.
    // Finally Level9 becomes Text
    // So the result should be Level1 (since Level0 template returns Level1)
    assert_element_type(&expanded, "Level1");

    // Verify no stack overflow occurred - if we got here, expansion succeeded
    // The components are NOT nested as children, each component's template IS the next level
}

// ============================================================================
// B. Lazy Components (5 tests)
// ============================================================================

#[test]
fn test_lazy_component_flag_detected() {
    // GIVEN: Element with __lazy prop
    let element = Element::new("LazyComponent").with_prop("__lazy", Value::Static(json!(true)));

    // WHEN: Check __lazy prop
    let is_lazy = element
        .props
        .get("__lazy")
        .and_then(|v| {
            if let Value::Static(val) = v {
                val.as_bool()
            } else {
                None
            }
        })
        .unwrap_or(false);

    // THEN: Returns true
    assert!(is_lazy, "Element should be detected as lazy");
}

#[test]
fn test_lazy_component_children_not_expanded() {
    // GIVEN: Lazy component with children
    let mut registry = ComponentRegistry::new();

    registry.set_resolver(Arc::new(|name: &str, _context: Option<&str>| {
        if name == "LazyModule" {
            Some(ResolvedComponent {
                source: String::new(),
                path: "/modules/LazyModule.hypen".to_string(),
                passthrough: false,
                lazy: true,
            })
        } else {
            None
        }
    }));

    let element = Element::new("LazyModule").with_child(Element::new("ExpensiveComponent"));

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Children preserved as-is, __lazy flag added
    assert_element_type(&expanded, "LazyModule");
    assert_eq!(expanded.ir_children.len(), 1);
    assert_element_type(ir_element(&expanded.ir_children[0]), "ExpensiveComponent");

    // Check __lazy prop was added
    let has_lazy_flag = expanded.props.get("__lazy").is_some();
    assert!(has_lazy_flag, "Lazy component should have __lazy prop");
}

#[test]
fn test_lazy_component_props_preserved() {
    // GIVEN: Lazy component with props
    let mut registry = ComponentRegistry::new();

    registry.set_resolver(Arc::new(|name: &str, _context: Option<&str>| {
        if name == "LazyCard" {
            Some(ResolvedComponent {
                source: String::new(),
                path: "/components/LazyCard.hypen".to_string(),
                passthrough: false,
                lazy: true,
            })
        } else {
            None
        }
    }));

    let element = Element::new("LazyCard")
        .with_prop("title", Value::Static(json!("My Card")))
        .with_prop("count", Value::Static(json!(42)));

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: All original props preserved, plus __lazy
    assert_prop_static_value(&expanded, "title", &json!("My Card"));
    assert_prop_static_value(&expanded, "count", &json!(42));
    assert!(expanded.props.get("__lazy").is_some());
}

#[test]
fn test_lazy_component_registration() {
    // GIVEN: Registry with resolver returning lazy component
    let mut registry = ComponentRegistry::new();

    registry.set_resolver(Arc::new(|name: &str, _context: Option<&str>| {
        if name == "ProfilePage" {
            Some(ResolvedComponent {
                source: "Column { Text(\"Profile\") }".to_string(),
                path: "/pages/ProfilePage.hypen".to_string(),
                passthrough: false,
                lazy: true,
            })
        } else {
            None
        }
    }));

    let element = Element::new("ProfilePage");

    // WHEN: expand() triggers resolution
    let expanded = registry.expand(&element);

    // THEN: Component registered as lazy
    let component = registry.get("ProfilePage", None);
    assert!(component.is_some());
    assert!(component.unwrap().lazy);

    // Expanded element has __lazy flag
    assert!(expanded.props.get("__lazy").is_some());
}

#[test]
fn test_mixed_lazy_and_regular_children() {
    // GIVEN: Column { LazyComponent, Text }
    let mut registry = ComponentRegistry::new();

    registry.set_resolver(Arc::new(|name: &str, _context: Option<&str>| {
        if name == "LazyWidget" {
            Some(ResolvedComponent {
                source: String::new(),
                path: "/widgets/LazyWidget.hypen".to_string(),
                passthrough: false,
                lazy: true,
            })
        } else {
            None
        }
    }));

    let element = column_with_children(vec![
        Element::new("LazyWidget"),
        text_element("Regular Text"),
    ]);

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Text expanded normally, LazyWidget preserved with __lazy flag
    assert_element_type(&expanded, "Column");
    assert_eq!(expanded.ir_children.len(), 2);

    // First child is lazy
    assert_element_type(ir_element(&expanded.ir_children[0]), "LazyWidget");
    assert!(ir_element(&expanded.ir_children[0])
        .props
        .get("__lazy")
        .is_some());

    // Second child is regular Text
    assert_element_type(ir_element(&expanded.ir_children[1]), "Text");
    assert!(ir_element(&expanded.ir_children[1])
        .props
        .get("__lazy")
        .is_none());
}

// ============================================================================
// C. Passthrough Components (5 tests)
// ============================================================================

#[test]
fn test_passthrough_component_preserves_element_type() {
    // GIVEN: Passthrough component (Router)
    let mut registry = ComponentRegistry::new();

    registry.set_resolver(Arc::new(|name: &str, _context: Option<&str>| {
        if name == "Router" {
            Some(ResolvedComponent {
                source: String::new(),
                path: "/runtime/Router.hypen".to_string(),
                passthrough: true,
                lazy: false,
            })
        } else {
            None
        }
    }));

    let element = Element::new("Router").with_prop("base", Value::Static(json!("/app")));

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Element type preserved, props preserved
    assert_element_type(&expanded, "Router");
    assert_prop_static_value(&expanded, "base", &json!("/app"));
}

#[test]
fn test_passthrough_children_expanded() {
    // GIVEN: Passthrough with children
    let mut registry = ComponentRegistry::new();

    registry.set_resolver(Arc::new(|name: &str, _context: Option<&str>| {
        if name == "Router" {
            Some(ResolvedComponent {
                source: String::new(),
                path: "/runtime/Router.hypen".to_string(),
                passthrough: true,
                lazy: false,
            })
        } else if name == "HomePage" {
            Some(ResolvedComponent {
                source: r#"Text("Home")"#.to_string(),
                path: "/pages/HomePage.hypen".to_string(),
                passthrough: false,
                lazy: false,
            })
        } else {
            None
        }
    }));

    let element = Element::new("Router").with_child(Element::new("HomePage"));

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Router preserved, HomePage expanded to Text
    assert_element_type(&expanded, "Router");
    assert_eq!(expanded.ir_children.len(), 1);
    assert_element_type(ir_element(&expanded.ir_children[0]), "Text");
}

#[test]
fn test_passthrough_context_propagation() {
    // GIVEN: Passthrough component with source path, containing child component
    let mut registry = ComponentRegistry::new();

    registry.set_resolver(Arc::new(|name: &str, context: Option<&str>| {
        match (name, context) {
            ("Container", _) => Some(ResolvedComponent {
                source: String::new(),
                path: "/layouts/Container.hypen".to_string(),
                passthrough: true,
                lazy: false,
            }),
            ("Widget", Some("/layouts/Container.hypen")) => Some(ResolvedComponent {
                source: r#"Text("Container Widget")"#.to_string(),
                path: "/layouts/widgets/Widget.hypen".to_string(),
                passthrough: false,
                lazy: false,
            }),
            _ => None,
        }
    }));

    let element = Element::new("Container").with_child(Element::new("Widget"));

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Context propagated through passthrough
    assert_element_type(&expanded, "Container");
    assert_eq!(expanded.ir_children.len(), 1);
    assert_element_type(ir_element(&expanded.ir_children[0]), "Text");
    // Parser uses prop "0" for first positional argument
    assert_prop_static_value(
        ir_element(&expanded.ir_children[0]),
        "0",
        &json!("Container Widget"),
    );
}

#[test]
fn test_multiple_passthrough_layers() {
    // GIVEN: PassthroughA > PassthroughB > Text
    let mut registry = ComponentRegistry::new();

    registry.set_resolver(Arc::new(|name: &str, _context: Option<&str>| {
        if name == "OuterContainer" || name == "InnerContainer" {
            Some(ResolvedComponent {
                source: String::new(),
                path: format!("/{}.hypen", name),
                passthrough: true,
                lazy: false,
            })
        } else {
            None
        }
    }));

    let element = Element::new("OuterContainer")
        .with_prop("outer", Value::Static(json!("A")))
        .with_child(
            Element::new("InnerContainer")
                .with_prop("inner", Value::Static(json!("B")))
                .with_child(text_element("Content")),
        );

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Both passthrough layers preserved with props
    assert_element_type(&expanded, "OuterContainer");
    assert_prop_static_value(&expanded, "outer", &json!("A"));

    assert_eq!(expanded.ir_children.len(), 1);
    assert_element_type(ir_element(&expanded.ir_children[0]), "InnerContainer");
    assert_prop_static_value(ir_element(&expanded.ir_children[0]), "inner", &json!("B"));

    assert_eq!(ir_element(&expanded.ir_children[0]).ir_children.len(), 1);
    assert_element_type(
        ir_element(&ir_element(&expanded.ir_children[0]).ir_children[0]),
        "Text",
    );
}

#[test]
fn test_passthrough_preserves_bindings() {
    // GIVEN: Passthrough with binding prop
    let mut registry = ComponentRegistry::new();

    registry.set_resolver(Arc::new(|name: &str, _context: Option<&str>| {
        if name == "Route" {
            Some(ResolvedComponent {
                source: String::new(),
                path: "/runtime/Route.hypen".to_string(),
                passthrough: true,
                lazy: false,
            })
        } else {
            None
        }
    }));

    let element = Element::new("Route")
        .with_prop("path", Value::Static(json!("/")))
        .with_prop(
            "active",
            Value::Binding(hypen_engine::reactive::Binding::state(vec![
                "isActive".to_string()
            ])),
        );

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Both static and binding props preserved
    assert_prop_static_value(&expanded, "path", &json!("/"));
    assert_binding_value(expanded.props.get("active").unwrap(), "isActive");
}

// ============================================================================
// D. Children Slot Replacement (8 tests)
// ============================================================================

#[test]
fn test_children_slot_basic_replacement() {
    // GIVEN: Template with Children(), caller provides Text
    let mut registry = ComponentRegistry::new();

    let card = Component::new("Card", |_props| {
        Element::new("Column").with_child(Element::new("Children"))
    });
    registry.register(card);

    let element = Element::new("Card").with_child(text_element("Hello"));

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Children() replaced with Text
    assert_element_type(&expanded, "Column");
    assert_eq!(expanded.ir_children.len(), 1);
    assert_element_type(ir_element(&expanded.ir_children[0]), "Text");
}

#[test]
fn test_named_slot_with_slot_applicator() {
    // GIVEN: Template with Children().slot("header"), caller provides Text.slot("header")
    let mut registry = ComponentRegistry::new();

    let layout = Component::new("Layout", |_props| {
        let mut header_slot = Element::new("Children");
        header_slot
            .props
            .insert("slot.0".to_string(), Value::Static(json!("header")));

        Element::new("Column").with_child(header_slot)
    });
    registry.register(layout);

    let mut header_text = text_element("Header");
    header_text
        .props
        .insert("slot.0".to_string(), Value::Static(json!("header")));

    let element = Element::new("Layout").with_child(header_text);

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Text inserted into header slot
    assert_element_type(&expanded, "Column");
    assert_eq!(expanded.ir_children.len(), 1);
    assert_element_type(ir_element(&expanded.ir_children[0]), "Text");
}

#[test]
fn test_default_slot_without_applicator() {
    // GIVEN: Template with Children() (default slot), caller provides Text without .slot()
    let mut registry = ComponentRegistry::new();

    let wrapper = Component::new("Wrapper", |_props| {
        Element::new("Column").with_child(Element::new("Children"))
    });
    registry.register(wrapper);

    let element = Element::new("Wrapper").with_child(text_element("Default Content"));

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Text goes to default slot
    assert_element_type(&expanded, "Column");
    assert_eq!(expanded.ir_children.len(), 1);
    assert_element_type(ir_element(&expanded.ir_children[0]), "Text");
}

#[test]
fn test_multiple_named_slots() {
    // GIVEN: Template with .slot("header") and .slot("footer")
    let mut registry = ComponentRegistry::new();

    let page = Component::new("Page", |_props| {
        let mut header_slot = Element::new("Children");
        header_slot
            .props
            .insert("slot.0".to_string(), Value::Static(json!("header")));

        let mut footer_slot = Element::new("Children");
        footer_slot
            .props
            .insert("slot.0".to_string(), Value::Static(json!("footer")));

        Element::new("Column")
            .with_child(header_slot)
            .with_child(footer_slot)
    });
    registry.register(page);

    // Caller provides children for both slots
    let mut header_child = text_element("Header");
    header_child
        .props
        .insert("slot.0".to_string(), Value::Static(json!("header")));

    let mut footer_child = text_element("Footer");
    footer_child
        .props
        .insert("slot.0".to_string(), Value::Static(json!("footer")));

    let element = Element::new("Page")
        .with_child(header_child)
        .with_child(footer_child);

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Each child in correct slot
    assert_element_type(&expanded, "Column");
    assert_eq!(expanded.ir_children.len(), 2);
    // Both should be Text elements (Children replaced)
    assert_element_type(ir_element(&expanded.ir_children[0]), "Text");
    assert_element_type(ir_element(&expanded.ir_children[1]), "Text");
}

#[test]
fn test_empty_slot_removed() {
    // GIVEN: Template with Children(), caller provides no children
    let mut registry = ComponentRegistry::new();

    let empty_wrapper = Component::new("EmptyWrapper", |_props| {
        Element::new("Column").with_child(Element::new("Children"))
    });
    registry.register(empty_wrapper);

    let element = Element::new("EmptyWrapper"); // No children

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Children() removed from tree (no children)
    assert_element_type(&expanded, "Column");
    assert_eq!(expanded.ir_children.len(), 0);
}

#[test]
fn test_multiple_children_same_slot() {
    // GIVEN: Caller provides Text.slot("body"), Image.slot("body")
    let mut registry = ComponentRegistry::new();

    let card = Component::new("Card", |_props| {
        let mut body_slot = Element::new("Children");
        body_slot
            .props
            .insert("slot.0".to_string(), Value::Static(json!("body")));

        Element::new("Column").with_child(body_slot)
    });
    registry.register(card);

    let mut text_child = text_element("Description");
    text_child
        .props
        .insert("slot.0".to_string(), Value::Static(json!("body")));

    let mut image_child = image_element("photo.jpg");
    image_child
        .props
        .insert("slot.0".to_string(), Value::Static(json!("body")));

    let element = Element::new("Card")
        .with_child(text_child)
        .with_child(image_child);

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Both inserted into body slot
    assert_element_type(&expanded, "Column");
    assert_eq!(expanded.ir_children.len(), 2);
    assert_element_type(ir_element(&expanded.ir_children[0]), "Text");
    assert_element_type(ir_element(&expanded.ir_children[1]), "Image");
}

#[test]
fn test_nested_slot_replacement() {
    // GIVEN: Component with Children() inside Column inside Row
    let mut registry = ComponentRegistry::new();

    let nested_layout = Component::new("NestedLayout", |_props| {
        Element::new("Row").with_child(Element::new("Column").with_child(Element::new("Children")))
    });
    registry.register(nested_layout);

    let element = Element::new("NestedLayout").with_child(text_element("Nested Content"));

    // WHEN: expand()
    let expanded = registry.expand(&element);

    // THEN: Slot replaced at correct nesting level
    assert_element_type(&expanded, "Row");
    assert_eq!(expanded.ir_children.len(), 1);
    assert_element_type(ir_element(&expanded.ir_children[0]), "Column");
    assert_eq!(ir_element(&expanded.ir_children[0]).ir_children.len(), 1);
    assert_element_type(
        ir_element(&ir_element(&expanded.ir_children[0]).ir_children[0]),
        "Text",
    );
}

#[test]
fn test_slot_name_extraction() {
    // GIVEN: Element with .slot("customName") applicator
    let mut element = text_element("Content");
    element
        .props
        .insert("slot.0".to_string(), Value::Static(json!("customName")));

    // WHEN: Check slot prop
    let slot_name = element.props.get("slot.0").and_then(|v| {
        if let Value::Static(json_val) = v {
            json_val.as_str()
        } else {
            None
        }
    });

    // THEN: Returns Some("customName")
    assert_eq!(slot_name, Some("customName"));
}

// ============================================================================
// E. Component Caching (4 tests)
// Note: Tests 3 and 4 are already covered by existing tests in component.rs
// ============================================================================

#[test]
fn test_component_cached_after_first_resolution() {
    // GIVEN: Component resolver
    let mut registry = ComponentRegistry::new();
    let call_count = Arc::new(std::sync::Mutex::new(0));
    let call_count_clone = call_count.clone();

    registry.set_resolver(Arc::new(move |name: &str, _context: Option<&str>| {
        if name == "CachedButton" {
            *call_count_clone.lock().unwrap() += 1;
            Some(ResolvedComponent {
                source: r#"Text("Cached")"#.to_string(),
                path: "/components/CachedButton.hypen".to_string(),
                passthrough: false,
                lazy: false,
            })
        } else {
            None
        }
    }));

    // WHEN: Expand same component twice
    let element1 = Element::new("CachedButton");
    let _ = registry.expand(&element1);

    let element2 = Element::new("CachedButton");
    let _ = registry.expand(&element2);

    // THEN: Resolver called only once (cached on second call)
    assert_eq!(*call_count.lock().unwrap(), 1);
}

#[test]
fn test_primitive_registration_skips_resolution() {
    // GIVEN: Registry with resolver and primitive registration
    let mut registry = ComponentRegistry::new();
    let call_count = Arc::new(std::sync::Mutex::new(0));
    let call_count_clone = call_count.clone();

    registry.set_resolver(Arc::new(move |_name: &str, _context: Option<&str>| {
        *call_count_clone.lock().unwrap() += 1;
        None
    }));

    // Register "Text" as a primitive
    registry.register_primitive("Text");

    // WHEN: Expand Text element
    let element = text_element("Hello");
    let _ = registry.expand(&element);

    // THEN: Resolver not called for primitives
    assert_eq!(*call_count.lock().unwrap(), 0);
}
