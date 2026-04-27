//! Tests for src/ir/expand.rs - AST to IR conversion
//!
//! Tests conversion from parser output to engine intermediate representation

use hypen_engine::ir::{IRNode, Value};
use hypen_parser::parse_component;
use serde_json::json;

mod common;

/// Helper: parse → ast_to_ir_node → unwrap Element
fn parse_to_element(input: &str) -> hypen_engine::Element {
    let component = parse_component(input).unwrap();
    match hypen_engine::ast_to_ir_node(&component) {
        IRNode::Element(e) => e,
        other => panic!("Expected Element, got {:?}", other),
    }
}

// ============================================================================
// Value Conversion for All Types (7 tests)
// ============================================================================

#[test]
fn test_convert_string_value() {
    // GIVEN: Parser string value
    let element = parse_to_element(r#"Text("Hello World")"#);

    // THEN: String becomes Static value
    assert_eq!(element.element_type, "Text");
    match element.props.get("0").unwrap() {
        Value::Static(v) => assert_eq!(v, &json!("Hello World")),
        _ => panic!("Expected Static value"),
    }
}

#[test]
fn test_convert_number_value() {
    // GIVEN: Parser number value
    let element = parse_to_element(r#"Box(width: 100, height: 50.5)"#);

    // THEN: Numbers become Static values
    assert_eq!(element.element_type, "Box");
    match element.props.get("width").unwrap() {
        Value::Static(v) => assert_eq!(v, &json!(100.0)),
        _ => panic!("Expected Static value"),
    }
    match element.props.get("height").unwrap() {
        Value::Static(v) => assert_eq!(v, &json!(50.5)),
        _ => panic!("Expected Static value"),
    }
}

#[test]
fn test_convert_boolean_value() {
    // GIVEN: Parser boolean value
    let element = parse_to_element(r#"Input(enabled: true, readonly: false)"#);

    // THEN: Booleans become Static values
    match element.props.get("enabled").unwrap() {
        Value::Static(v) => assert_eq!(v, &json!(true)),
        _ => panic!("Expected Static value"),
    }
    match element.props.get("readonly").unwrap() {
        Value::Static(v) => assert_eq!(v, &json!(false)),
        _ => panic!("Expected Static value"),
    }
}

#[test]
fn test_convert_list_value() {
    // GIVEN: Parser list value
    let element = parse_to_element(r#"Box(tags: ["primary", "action"])"#);

    // THEN: List becomes Static JSON array
    match element.props.get("tags").unwrap() {
        Value::Static(v) => {
            assert_eq!(v, &json!(["primary", "action"]));
        }
        _ => panic!("Expected Static value"),
    }
}

#[test]
fn test_convert_map_value() {
    // GIVEN: Parser map value
    let element = parse_to_element(r#"Box(config: {width: 100, height: 200})"#);

    // THEN: Map becomes Static JSON object
    match element.props.get("config").unwrap() {
        Value::Static(v) => {
            assert_eq!(v["width"], json!(100.0));
            assert_eq!(v["height"], json!(200.0));
        }
        _ => panic!("Expected Static value"),
    }
}

#[test]
fn test_convert_binding_value() {
    // GIVEN: Parser string with binding syntax
    let element = parse_to_element(r#"Text("@{state.user.name}")"#);

    // THEN: Becomes Binding value
    match element.props.get("0").unwrap() {
        Value::Binding(binding) => {
            assert_eq!(binding.path, vec!["user", "name"]);
            assert_eq!(binding.full_path(), "user.name");
        }
        _ => panic!("Expected Binding value"),
    }
}

#[test]
fn test_convert_action_value() {
    // GIVEN: Parser string with action syntax
    let element = parse_to_element(r#"Button(onClick: "@actions.submit") { Text("Submit") }"#);

    // THEN: Becomes Action value (strips @actions. prefix)
    match element.props.get("onClick").unwrap() {
        Value::Action(action) => {
            assert_eq!(action, "submit");
        }
        _ => panic!("Expected Action value"),
    }
}

// ============================================================================
// Binding Parsing Edge Cases (4 tests)
// ============================================================================

#[test]
fn test_invalid_binding_becomes_template_string() {
    // GIVEN: Expression syntax (ternary) that can't be a simple binding
    // This will be evaluated at runtime by exprimo as an expression
    let element = parse_to_element(r#"Text("@{state.active ? 'yes' : 'no'}")"#);

    // THEN: Expression becomes a TemplateString that will be evaluated at runtime
    match element.props.get("0").unwrap() {
        Value::TemplateString { template, bindings } => {
            assert_eq!(template, "@{state.active ? 'yes' : 'no'}");
            assert!(!bindings.is_empty(), "Should extract state.active binding");
        }
        v => panic!("Expected TemplateString value for expression, got {:?}", v),
    }
}

#[test]
fn test_data_source_binding_in_template() {
    // GIVEN: "@{user.name}" in template syntax — this is NOT a data source binding.
    // Data source bindings use the parser's explicit @provider.path syntax,
    // not the @{...} template syntax. @{user.name} falls through to TemplateString,
    // with dependency tracking via extract_data_source_bindings_from_expression.
    let element = parse_to_element(r#"Text("@{user.name}")"#);

    // THEN: Should be a TemplateString (not a Binding) with data source binding for dependency tracking
    match element.props.get("0").unwrap() {
        Value::TemplateString { template, bindings } => {
            assert_eq!(template, "@{user.name}");
            // Should have extracted a data source binding for dependency tracking
            assert_eq!(bindings.len(), 1);
            assert!(bindings[0].is_data_source());
            assert_eq!(bindings[0].provider(), Some("user"));
            assert_eq!(bindings[0].path, vec!["name"]);
        }
        v => panic!("Expected TemplateString, got {:?}", v),
    }
}

#[test]
fn test_reference_with_state_prefix() {
    // GIVEN: Reference value with state prefix
    let element = parse_to_element(r#"Text(text: @state.message)"#);

    // THEN: Becomes Binding value
    match element.props.get("text").unwrap() {
        Value::Binding(binding) => {
            assert_eq!(binding.path, vec!["message"]);
        }
        _ => panic!("Expected Binding value"),
    }
}

#[test]
fn test_reference_with_actions_prefix() {
    // GIVEN: Reference value with actions prefix
    let element = parse_to_element(r#"Button(onClick: @actions.increment)"#);

    // THEN: Becomes Action value
    match element.props.get("onClick").unwrap() {
        Value::Action(action) => {
            assert_eq!(action, "increment");
        }
        _ => panic!("Expected Action value"),
    }
}

#[test]
fn test_binding_in_list_preserved_as_string() {
    // GIVEN: List with binding inside
    let element = parse_to_element(r#"Box(items: ["@{state.first}", "static"])"#);

    // THEN: Binding in list preserved as string representation (strips "state." prefix)
    match element.props.get("items").unwrap() {
        Value::Static(v) => {
            // List items with bindings are converted to their string representation
            assert!(v.is_array());
            // Note: Binding path "state.first" becomes "@{first}" in string representation
            assert_eq!(v[0], json!("@{first}"));
            assert_eq!(v[1], json!("static"));
        }
        _ => panic!("Expected Static value"),
    }
}

// ============================================================================
// Key Extraction and Generation (4 tests)
// ============================================================================

#[test]
fn test_key_from_first_positional_string() {
    let element = parse_to_element(r#"Text("Item1")"#);
    assert_eq!(element.key, Some("\"Item1\"".to_string()));
}

#[test]
fn test_no_key_for_named_argument() {
    let element = parse_to_element(r#"Box(width: 100, height: 200)"#);
    assert_eq!(element.key, None);
}

#[test]
fn test_no_key_for_number_positional() {
    let element = parse_to_element(r#"Box(100)"#);
    assert_eq!(element.key, None);
}

#[test]
fn test_key_extraction_with_multiple_positional() {
    let element = parse_to_element(r#"Text("Key", 100, true)"#);
    assert_eq!(element.key, Some("\"Key\"".to_string()));
    assert_eq!(element.props.len(), 3);
}

// ============================================================================
// Additional Edge Cases
// ============================================================================

#[test]
fn test_applicators_become_namespaced_props() {
    let element = parse_to_element(r#"Text("Styled").fontSize(18).color("blue")"#);

    assert!(element.props.contains_key("fontSize.0"));
    assert!(element.props.contains_key("color.0"));

    match element.props.get("fontSize.0").unwrap() {
        Value::Static(v) => assert_eq!(v, &json!(18.0)),
        _ => panic!("Expected Static value"),
    }
    match element.props.get("color.0").unwrap() {
        Value::Static(v) => assert_eq!(v, &json!("blue")),
        _ => panic!("Expected Static value"),
    }
}

#[test]
fn test_nested_children_conversion() {
    let element = parse_to_element(
        r#"
        Column {
            Row {
                Text("A")
                Text("B")
            }
            Text("C")
        }
    "#,
    );

    assert_eq!(element.element_type, "Column");
    assert_eq!(element.ir_children.len(), 2);
    match &element.ir_children[0] {
        IRNode::Element(row) => {
            assert_eq!(row.element_type, "Row");
            assert_eq!(row.ir_children.len(), 2);
        }
        _ => panic!("Expected Element"),
    }
    assert!(matches!(&element.ir_children[1], IRNode::Element(e) if e.element_type == "Text"));
}

#[test]
fn test_action_actions_prefix_syntax() {
    let element = parse_to_element(r#"Button(onClick: "@actions.submit")"#);

    match element.props.get("onClick").unwrap() {
        Value::Action(action) => {
            assert_eq!(action, "submit");
        }
        _ => panic!("Expected Action value"),
    }
}

#[test]
fn test_empty_component() {
    let element = parse_to_element(r#"Divider()"#);

    assert_eq!(element.element_type, "Divider");
    assert_eq!(element.props.len(), 0);
    assert_eq!(element.ir_children.len(), 0);
    assert_eq!(element.key, None);
}
