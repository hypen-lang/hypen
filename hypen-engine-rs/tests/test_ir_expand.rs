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

// ============================================================================
// Animation Applicator Lowering (.transition/.enter/.exit/.layout → __anim.*)
// ============================================================================

/// Helper: fetch a lowered "__anim.<channel>" spec as JSON.
fn anim_spec(element: &hypen_engine::Element, channel: &str) -> serde_json::Value {
    match element.props.get(&format!("__anim.{channel}")).unwrap() {
        Value::Static(v) => v.clone(),
        other => panic!("Expected Static __anim.{channel}, got {:?}", other),
    }
}

#[test]
fn test_transition_positional_lowering() {
    // GIVEN: .transition(200, easeOut) — number→duration(ms), token→curve
    let element = parse_to_element(r#"Text("Hi").transition(200, easeOut)"#);

    // THEN: One "__anim.transition" prop, no "transition.0" leftover
    assert_eq!(
        anim_spec(&element, "transition"),
        json!({"duration": 200, "curve": "easeOut"})
    );
    assert!(!element.props.contains_key("transition.0"));
}

#[test]
fn test_transition_named_lowering_with_scoped_props() {
    let element = parse_to_element(
        r#"Text("Hi").transition(duration: 300, curve: spring, delay: 50, props: [opacity, translateY])"#,
    );

    assert_eq!(
        anim_spec(&element, "transition"),
        json!({
            "duration": 300,
            "curve": "spring",
            "delay": 50,
            "props": ["opacity", "translateY"]
        })
    );
}

#[test]
fn test_transition_props_whitelist_filtering() {
    // GIVEN: props list mixing animatable and non-animatable names
    let element =
        parse_to_element(r#"Text("Hi").transition(props: [opacity, tw, display, fontSize])"#);

    // THEN: Non-animatable entries dropped
    assert_eq!(
        anim_spec(&element, "transition")["props"],
        json!(["opacity", "fontSize"])
    );
}

#[test]
fn test_transition_unknown_token_falls_back_to_defaults() {
    let element = parse_to_element(r#"Text("Hi").transition(wobble)"#);

    assert_eq!(
        anim_spec(&element, "transition"),
        json!({"duration": 200, "curve": "easeOut"})
    );
}

#[test]
fn test_transition_binding_args_rejected() {
    // GIVEN: bindings in animation arguments — warn + ignore, keep defaults
    let element = parse_to_element(r#"Text("Hi").transition(@state.speed, curve: @state.curve)"#);

    assert_eq!(
        anim_spec(&element, "transition"),
        json!({"duration": 200, "curve": "easeOut"})
    );
}

#[test]
fn test_transition_legacy_string_passthrough() {
    // GIVEN: legacy web-only CSS shorthand (single positional string with
    // whitespace) — falls through to the generic path unchanged
    let element = parse_to_element(r#"Text("Hi").transition("opacity 0.3s ease")"#);

    assert!(!element.props.contains_key("__anim.transition"));
    match element.props.get("transition.0").unwrap() {
        Value::Static(v) => assert_eq!(v, &json!("opacity 0.3s ease")),
        _ => panic!("Expected Static value"),
    }
}

#[test]
fn test_transition_single_curve_token_is_new_path() {
    // Pins the legacy discriminator: .transition(easeOut) has no whitespace
    // → new path, not legacy passthrough
    let element = parse_to_element(r#"Text("Hi").transition(easeOut)"#);

    assert!(!element.props.contains_key("transition.0"));
    assert_eq!(
        anim_spec(&element, "transition"),
        json!({"duration": 200, "curve": "easeOut"})
    );
}

#[test]
fn test_enter_presets_compose() {
    let element = parse_to_element(
        r#"Row { Text("Saved!") }.enter(slide, fade, from: bottom, duration: 200, curve: easeOut)"#,
    );

    assert_eq!(
        anim_spec(&element, "enter"),
        json!({
            "presets": ["slide", "fade"],
            "from": "bottom",
            "duration": 200,
            "curve": "easeOut"
        })
    );
    assert!(!element.props.contains_key("enter.0"));
}

#[test]
fn test_exit_defaults() {
    let element = parse_to_element(r#"Row { Text("Bye") }.exit(fade, duration: 150)"#);

    assert_eq!(
        anim_spec(&element, "exit"),
        json!({"presets": ["fade"], "duration": 150, "curve": "easeIn"})
    );
}

#[test]
fn test_exit_slide_direction() {
    let element = parse_to_element(r#"Row { Text("Bye") }.exit(slide, to: trailing)"#);

    assert_eq!(
        anim_spec(&element, "exit"),
        json!({"presets": ["slide"], "to": "trailing", "duration": 150, "curve": "easeIn"})
    );
}

#[test]
fn test_layout_lowering() {
    // .layout(spring) and bare .layout() both hit the {300, spring} defaults
    let element = parse_to_element(r#"Row { Text("A") }.layout(spring)"#);
    assert_eq!(
        anim_spec(&element, "layout"),
        json!({"duration": 300, "curve": "spring"})
    );

    let element = parse_to_element(r#"Row { Text("A") }.layout()"#);
    assert_eq!(
        anim_spec(&element, "layout"),
        json!({"duration": 300, "curve": "spring"})
    );
    assert!(!element.props.contains_key("layout.0"));
}

#[test]
fn test_anim_applicators_stack_per_channel() {
    let element = parse_to_element(
        r#"Row { Text("T") }.enter(fade).exit(fade).layout(spring).transition(200).animate(pulse)"#,
    );

    assert!(element.props.contains_key("__anim.enter"));
    assert!(element.props.contains_key("__anim.exit"));
    assert!(element.props.contains_key("__anim.layout"));
    assert!(element.props.contains_key("__anim.transition"));
    assert!(element.props.contains_key("__anim.animate"));
}

#[test]
fn test_animate_preset_defaults() {
    // GIVEN: .animate(spin) — bare preset, everything else defaulted
    let element = parse_to_element(r#"Icon("loader").animate(spin)"#);

    // THEN: One "__anim.animate" prop with spin's defaults, no "animate.0"
    assert_eq!(
        anim_spec(&element, "animate"),
        json!({"preset": "spin", "duration": 800, "repeat": "loop", "curve": "linear"})
    );
    assert!(!element.props.contains_key("animate.0"));

    let element = parse_to_element(r#"Text("Hi").animate(pulse)"#);
    assert_eq!(
        anim_spec(&element, "animate"),
        json!({"preset": "pulse", "duration": 1200, "repeat": "loop", "curve": "easeInOut"})
    );

    let element = parse_to_element(r#"Row { Text("...") }.animate(shimmer)"#);
    assert_eq!(
        anim_spec(&element, "animate"),
        json!({"preset": "shimmer", "duration": 1500, "repeat": "loop", "curve": "linear"})
    );

    let element = parse_to_element(r#"Row { Text("!") }.animate(shake)"#);
    assert_eq!(
        anim_spec(&element, "animate"),
        json!({"preset": "shake", "duration": 400, "repeat": 1, "curve": "easeInOut"})
    );
}

#[test]
fn test_animate_named_overrides() {
    let element = parse_to_element(
        r#"Text("Hi").animate(pulse, duration: 800, repeat: 3, curve: easeInOut, delay: 100)"#,
    );

    assert_eq!(
        anim_spec(&element, "animate"),
        json!({
            "preset": "pulse",
            "duration": 800,
            "repeat": 3,
            "curve": "easeInOut",
            "delay": 100
        })
    );
}

#[test]
fn test_animate_repeat_loop_token() {
    // shake defaults to repeat: 1; the loop token overrides it
    let element = parse_to_element(r#"Text("Hi").animate(shake, repeat: loop)"#);

    assert_eq!(
        anim_spec(&element, "animate"),
        json!({"preset": "shake", "duration": 400, "repeat": "loop", "curve": "easeInOut"})
    );
}

#[test]
fn test_animate_unknown_preset_omits_channel() {
    // GIVEN: an unknown preset — warn + omit the channel ENTIRELY; the
    // interception still consumes the applicator (no "animate.0" leftover)
    let element = parse_to_element(r#"Text("Hi").animate(wobble)"#);

    assert!(!element.props.contains_key("__anim.animate"));
    assert!(!element.props.contains_key("animate.0"));
}

#[test]
fn test_animate_binding_args_rejected() {
    // Binding as preset — channel omitted entirely
    let element = parse_to_element(r#"Text("Hi").animate(@state.preset)"#);
    assert!(!element.props.contains_key("__anim.animate"));
    assert!(!element.props.contains_key("animate.0"));

    // Bindings in modifiers — warn + ignore, keep preset defaults
    let element =
        parse_to_element(r#"Text("Hi").animate(spin, duration: @state.speed, repeat: @state.n)"#);
    assert_eq!(
        anim_spec(&element, "animate"),
        json!({"preset": "spin", "duration": 800, "repeat": "loop", "curve": "linear"})
    );
}

#[test]
fn test_animate_delay_only_when_given() {
    let element = parse_to_element(r#"Text("Hi").animate(spin)"#);
    assert!(anim_spec(&element, "animate").get("delay").is_none());

    let element = parse_to_element(r#"Text("Hi").animate(shake, delay: 100)"#);
    assert_eq!(anim_spec(&element, "animate")["delay"], json!(100));
}

#[test]
fn test_variant_map_non_collision_with_anim() {
    // GIVEN: a variant-map applicator alongside an animation applicator
    let element =
        parse_to_element(r#"Text("Hi").padding({ default: 8, md: 16 }).transition(200, easeOut)"#);

    // THEN: variant-map lowering still applies to .padding, and the anim
    // interception (which runs first) did not swallow it
    match element.props.get("padding.0").unwrap() {
        Value::Static(v) => assert_eq!(v, &json!(8.0)),
        _ => panic!("Expected Static value"),
    }
    match element.props.get("padding@md.0").unwrap() {
        Value::Static(v) => assert_eq!(v, &json!(16.0)),
        _ => panic!("Expected Static value"),
    }
    assert!(element.props.contains_key("__anim.transition"));
}

#[test]
fn test_anim_lowering_inside_foreach_template() {
    // .enter/.exit on a ForEach item template lowers on the template element
    let component = parse_component(
        r#"
        ForEach(items: @state.items) {
            Row { Text("@{item.title}") }
                .enter(fade)
                .exit(slide, to: trailing)
        }
    "#,
    )
    .unwrap();

    match hypen_engine::ast_to_ir_node(&component) {
        IRNode::ForEach { template, .. } => match &template[0] {
            IRNode::Element(row) => {
                assert!(row.props.contains_key("__anim.enter"));
                assert!(row.props.contains_key("__anim.exit"));
            }
            other => panic!("Expected Element template, got {:?}", other),
        },
        other => panic!("Expected ForEach, got {:?}", other),
    }
}
