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

// ============================================================================
// Shared-Element Lowering (.sharedElement → __anim.sharedKey + __anim.shared)
// ============================================================================

#[test]
fn test_shared_element_static_key_lowering() {
    // GIVEN: .sharedElement("hero-cover") — static key, no timing args
    let element = parse_to_element(r#"Image(src: "cover.png").sharedElement("hero-cover")"#);

    // THEN: TWO props — the key (string-preserving) and the timing defaults;
    //       the applicator never becomes "sharedElement.0"
    match element.props.get("__anim.sharedKey").unwrap() {
        Value::Static(v) => assert_eq!(v, &json!("hero-cover")),
        other => panic!("Expected Static key, got {:?}", other),
    }
    assert_eq!(
        anim_spec(&element, "shared"),
        json!({"duration": 350, "curve": "spring"})
    );
    assert!(!element.props.contains_key("sharedElement.0"));
}

#[test]
fn test_shared_element_template_key_preserved_as_resolvable_value() {
    // GIVEN: a template key — identity is data, bindings are ALLOWED here
    let element = parse_to_element(r#"Image(src: "x.png").sharedElement("cover-@{item.id}")"#);

    // THEN: The key lowers as a TemplateString (resolves per render through
    //       the standard resolution machinery), not a stringified constant
    match element.props.get("__anim.sharedKey").unwrap() {
        Value::TemplateString { template, bindings } => {
            assert_eq!(template, "cover-@{item.id}");
            assert!(!bindings.is_empty(), "template key must register bindings");
        }
        other => panic!("Expected TemplateString key, got {:?}", other),
    }
    assert_eq!(
        anim_spec(&element, "shared"),
        json!({"duration": 350, "curve": "spring"})
    );

    // Pure binding keys work too
    let element = parse_to_element(r#"Image(src: "x.png").sharedElement(@state.heroKey)"#);
    assert!(matches!(
        element.props.get("__anim.sharedKey").unwrap(),
        Value::Binding(_)
    ));
}

#[test]
fn test_shared_element_timing_defaults_and_named_overrides() {
    // Defaults: {350, spring}
    let element = parse_to_element(r#"Image(src: "x.png").sharedElement("hero")"#);
    assert_eq!(
        anim_spec(&element, "shared"),
        json!({"duration": 350, "curve": "spring"})
    );

    // Named overrides
    let element =
        parse_to_element(r#"Image(src: "x.png").sharedElement("hero", curve: easeOut, duration: 500)"#);
    assert_eq!(
        anim_spec(&element, "shared"),
        json!({"duration": 500, "curve": "easeOut"})
    );
}

#[test]
fn test_shared_element_missing_key_omits_both_props_and_strips_applicator() {
    // Missing key entirely
    let element = parse_to_element(r#"Image(src: "x.png").sharedElement()"#);
    assert!(!element.props.contains_key("__anim.sharedKey"));
    assert!(!element.props.contains_key("__anim.shared"));
    assert!(!element.props.contains_key("sharedElement.0"));

    // Empty key
    let element = parse_to_element(r#"Image(src: "x.png").sharedElement("")"#);
    assert!(!element.props.contains_key("__anim.sharedKey"));
    assert!(!element.props.contains_key("__anim.shared"));
    assert!(!element.props.contains_key("sharedElement.0"));

    // Non-string-ish key
    let element = parse_to_element(r#"Image(src: "x.png").sharedElement(42)"#);
    assert!(!element.props.contains_key("__anim.sharedKey"));
    assert!(!element.props.contains_key("__anim.shared"));
    assert!(!element.props.contains_key("sharedElement.0"));
}

#[test]
fn test_shared_element_bad_curve_and_duration_degrade_to_defaults() {
    // GIVEN: invalid curve token and negative duration — warn + defaults,
    //        never a hard error; the key is unaffected
    let element = parse_to_element(
        r#"Image(src: "x.png").sharedElement("hero", curve: wobble, duration: -5)"#,
    );

    assert_eq!(
        anim_spec(&element, "shared"),
        json!({"duration": 350, "curve": "spring"})
    );
    match element.props.get("__anim.sharedKey").unwrap() {
        Value::Static(v) => assert_eq!(v, &json!("hero")),
        other => panic!("Expected Static key, got {:?}", other),
    }
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

// ============================================================================
// .states { onState(...) } Lowering — Option C named visual states
// ============================================================================
//
// The block form (`.states(@state.x) { onState(a)... }`) is not yet
// parseable inline — the trailing-applicator grammar has no children block —
// so these tests assemble the AST the way the parser's fold path represents
// it: parse `states(...) { ... }` as a component and attach it via
// `to_applicator()` (which preserves the block children).

/// Parse `base`, attach `states_src` (a `states(...) { ... }` component
/// source) as a `.states` applicator, and lower to an Element.
fn parse_states_element(base: &str, states_src: &str) -> hypen_engine::Element {
    let mut component = parse_component(base).unwrap();
    component
        .applicators
        .push(parse_component(states_src).unwrap().to_applicator());
    match hypen_engine::ast_to_ir_node(&component) {
        IRNode::Element(e) => e,
        other => panic!("Expected Element, got {:?}", other),
    }
}

/// Helper: unwrap a prop as a StateSwitch, returning (path, cases, default).
fn state_switch(
    element: &hypen_engine::Element,
    key: &str,
) -> (
    String,
    indexmap::IndexMap<String, serde_json::Value>,
    Option<serde_json::Value>,
) {
    match element.props.get(key) {
        Some(Value::StateSwitch {
            path,
            cases,
            default,
        }) => (path.clone(), cases.clone(), default.clone()),
        other => panic!("Expected StateSwitch for '{key}', got {:?}", other),
    }
}

#[test]
fn test_states_pose_lowering_with_base_defaults() {
    let element = parse_states_element(
        r#"Box().width(100).cornerRadius(4)"#,
        r#"states(@state.cardState, transition: spring, duration: 250) {
            onState(collapsed).cornerRadius(8).width(48)
            onState(expanded).cornerRadius(16).width(240)
        }"#,
    );

    // Each overridden key is a StateSwitch driven by the bound path, with
    // the node's (final) static base value as the default.
    let (path, cases, default) = state_switch(&element, "cornerRadius.0");
    assert_eq!(path, "cardState");
    assert_eq!(cases.get("collapsed"), Some(&json!(8.0)));
    assert_eq!(cases.get("expanded"), Some(&json!(16.0)));
    assert_eq!(default, Some(json!(4.0)));

    let (_, cases, default) = state_switch(&element, "width.0");
    assert_eq!(cases.get("collapsed"), Some(&json!(48.0)));
    assert_eq!(cases.get("expanded"), Some(&json!(240.0)));
    assert_eq!(default, Some(json!(100.0)));

    // No junk props from the intercepted applicator or its block.
    assert!(!element.props.contains_key("states.0"));
    assert!(!element.props.contains_key("onState.0"));
    assert!(element.ir_children.is_empty(), "onState never becomes a child");
}

#[test]
fn test_states_synthesized_transition_scoping() {
    let element = parse_states_element(
        r#"Box().width(100)"#,
        r#"states(@state.cardState, transition: spring, duration: 250, delay: 40) {
            onState(collapsed).width(48).display("none")
            onState(expanded).width(240).display("flex")
        }"#,
    );

    // Synthesized spec uses the header timing and scopes props to the
    // animatable subset of the overridden keys ("display" switches but snaps).
    match element.props.get("__anim.transition").unwrap() {
        Value::Static(spec) => assert_eq!(
            spec,
            &json!({
                "duration": 250,
                "curve": "spring",
                "delay": 40,
                "props": ["width"]
            })
        ),
        other => panic!("Expected Static __anim.transition, got {:?}", other),
    }

    // The non-animatable key still switches.
    let (_, cases, default) = state_switch(&element, "display.0");
    assert_eq!(cases.get("collapsed"), Some(&json!("none")));
    assert_eq!(default, None);
}

#[test]
fn test_states_defaults_and_no_animatable_override() {
    // Header defaults are {easeOut, 250, 0}; a pose overriding only
    // non-animatable props synthesizes NO transition spec (all snaps), but
    // the label prop still appears.
    let element = parse_states_element(
        r#"Box()"#,
        r#"states(@state.phase) {
            onState(a).display("none")
            onState(b).display("flex")
        }"#,
    );

    assert!(!element.props.contains_key("__anim.transition"));
    assert!(element.props.contains_key("__anim.states"));
}

#[test]
fn test_states_explicit_transition_wins_over_synthesized() {
    let element = parse_states_element(
        r#"Box().transition(500, linear).width(100)"#,
        r#"states(@state.cardState, transition: spring, duration: 250) {
            onState(collapsed).width(48)
            onState(expanded).width(240)
        }"#,
    );

    // The author's .transition survives untouched — no synthesized scoping.
    match element.props.get("__anim.transition").unwrap() {
        Value::Static(spec) => {
            assert_eq!(spec, &json!({"duration": 500, "curve": "linear"}))
        }
        other => panic!("Expected Static __anim.transition, got {:?}", other),
    }
    // The switch itself still applies.
    let (_, cases, _) = state_switch(&element, "width.0");
    assert_eq!(cases.get("expanded"), Some(&json!(240.0)));
}

#[test]
fn test_states_legacy_transition_string_wins_over_synthesized() {
    // The deprecated legacy form `.transition("opacity 0.3s ease")` lowers
    // to the plain "transition.0" prop, not "__anim.transition" — but it is
    // still an EXPLICIT .transition for the precedence rule. `.states` must
    // NOT synthesize a channel spec next to it: on the DOM the applicator's
    // `style.transition` shorthand and the animator's longhands would
    // clobber each other per patch order.
    let element = parse_states_element(
        r#"Box().transition("opacity 0.3s ease").opacity(1)"#,
        r#"states(@state.cardState, transition: spring, duration: 250) {
            onState(dim).opacity(0.5)
            onState(bright).opacity(1)
        }"#,
    );

    // The author's legacy passthrough survives untouched…
    match element.props.get("transition.0").unwrap() {
        Value::Static(v) => assert_eq!(v, &json!("opacity 0.3s ease")),
        other => panic!("Expected Static transition.0, got {:?}", other),
    }
    // …and no synthesized channel spec appears alongside it.
    assert!(!element.props.contains_key("__anim.transition"));

    // The switch itself (and the label prop) still apply.
    let (_, cases, default) = state_switch(&element, "opacity.0");
    assert_eq!(cases.get("dim"), Some(&json!(0.5)));
    assert_eq!(default, Some(json!(1.0)));
    assert!(element.props.contains_key("__anim.states"));
}

#[test]
fn test_states_label_prop() {
    let element = parse_states_element(
        r#"Box()"#,
        r#"states(@state.cardState) {
            onState(collapsed).width(48)
            onState(expanded).width(240)
        }"#,
    );

    // "__anim.states" is a StateSwitch over the labels themselves:
    // {"label": <label>} per case, default null — renderers see the active
    // pose flip as an ordinary SetProp.
    let (path, cases, default) = state_switch(&element, "__anim.states");
    assert_eq!(path, "cardState");
    assert_eq!(cases.get("collapsed"), Some(&json!({"label": "collapsed"})));
    assert_eq!(cases.get("expanded"), Some(&json!({"label": "expanded"})));
    assert_eq!(default, Some(json!(null)));
}

#[test]
fn test_states_tw_inside_pose() {
    // .tw works per-state: the expanded Tailwind props become switch cases.
    let element = parse_states_element(
        r#"Box()"#,
        r#"states(@state.cardState) {
            onState(collapsed).width(48)
            onState(expanded).width(240).tw("shadow-lg")
        }"#,
    );

    let (_, cases, default) = state_switch(&element, "boxShadow.0");
    assert!(cases.get("collapsed").is_none());
    assert!(cases.get("expanded").is_some(), "shadow-lg expands per-state");
    assert_eq!(default, None);
}

#[test]
fn test_states_pose_exclusions_warn_and_ignore() {
    // Anim applicators, .bind, and on[A-Z]* event applicators are excluded
    // from poses; pose props with bindings are dropped too.
    let element = parse_states_element(
        r#"Box()"#,
        r#"states(@state.cardState) {
            onState(collapsed)
                .opacity(0.5)
                .transition(200)
                .animate(pulse)
                .bind(@state.x)
                .onClick(@actions.tap)
                .fontSize(@state.size)
            onState(expanded).opacity(1)
        }"#,
    );

    // Only the static, allowed prop switched.
    let (_, cases, _) = state_switch(&element, "opacity.0");
    assert_eq!(cases.get("collapsed"), Some(&json!(0.5)));
    assert_eq!(cases.get("expanded"), Some(&json!(1.0)));

    for key in [
        "__anim.animate",
        "transition.0",
        "bind",
        "value",
        "onClick.0",
        "fontSize.0",
    ] {
        assert!(
            !element.props.contains_key(key),
            "excluded pose applicator leaked prop '{key}'"
        );
    }
    // The synthesized transition exists (opacity is animatable) and is NOT
    // hijacked by the pose's excluded .transition.
    match element.props.get("__anim.transition").unwrap() {
        Value::Static(spec) => {
            assert_eq!(spec["duration"], json!(250));
            assert_eq!(spec["props"], json!(["opacity"]));
        }
        other => panic!("Expected Static __anim.transition, got {:?}", other),
    }
}

#[test]
fn test_states_duplicate_labels_last_wins() {
    let element = parse_states_element(
        r#"Box()"#,
        r#"states(@state.cardState) {
            onState(collapsed).width(48)
            onState(collapsed).width(64)
        }"#,
    );

    let (_, cases, _) = state_switch(&element, "width.0");
    assert_eq!(cases.get("collapsed"), Some(&json!(64.0)));
}

#[test]
fn test_states_invalid_entries_ignored_valid_kept() {
    // Non-onState children, onState without a label, and onState with
    // children are each warned + ignored; the valid entry still applies.
    let element = parse_states_element(
        r#"Box()"#,
        r#"states(@state.cardState) {
            Text("not a pose")
            onState().width(10)
            onState(nested) { Text("no children allowed") }
            onState(collapsed).width(48)
        }"#,
    );

    let (_, cases, _) = state_switch(&element, "width.0");
    assert_eq!(cases.len(), 1);
    assert_eq!(cases.get("collapsed"), Some(&json!(48.0)));

    let (_, label_cases, _) = state_switch(&element, "__anim.states");
    assert_eq!(label_cases.len(), 1);
}

#[test]
fn test_states_non_reference_first_arg_ignores_whole_applicator() {
    for bad_header in [
        r#"states("collapsed") { onState(a).width(10) }"#,
        r#"states(42) { onState(a).width(10) }"#,
        r#"states(transition: spring) { onState(a).width(10) }"#,
        r#"states(@item.phase) { onState(a).width(10) }"#,
    ] {
        let element = parse_states_element(r#"Box().width(100)"#, bad_header);

        // Base prop untouched, nothing synthesized, no junk props.
        match element.props.get("width.0").unwrap() {
            Value::Static(v) => assert_eq!(v, &json!(100.0)),
            other => panic!("Expected untouched Static base, got {:?}", other),
        }
        assert!(!element.props.contains_key("__anim.states"));
        assert!(!element.props.contains_key("__anim.transition"));
        assert!(!element.props.contains_key("states.0"));
    }
}

#[test]
fn test_states_applies_after_later_applicators() {
    // .states is deferred to the end of applicator processing: a base value
    // written AFTER it in the chain is still captured as the switch default.
    let mut component = parse_component(r#"Box()"#).unwrap();
    let states = parse_component(
        r#"states(@state.cardState) {
            onState(collapsed).cornerRadius(8)
        }"#,
    )
    .unwrap()
    .to_applicator();
    component.applicators.insert(0, states);
    // Append .cornerRadius(4) after the .states applicator.
    let later = parse_component(r#"Box().cornerRadius(4)"#).unwrap();
    component.applicators.extend(later.applicators);

    let element = match hypen_engine::ast_to_ir_node(&component) {
        IRNode::Element(e) => e,
        other => panic!("Expected Element, got {:?}", other),
    };

    let (_, cases, default) = state_switch(&element, "cornerRadius.0");
    assert_eq!(cases.get("collapsed"), Some(&json!(8.0)));
    assert_eq!(
        default,
        Some(json!(4.0)),
        "deferred .states must capture the final base value as default"
    );
}

#[test]
fn test_states_quoted_and_bare_labels_equivalent() {
    let element = parse_states_element(
        r#"Box()"#,
        r#"states(@state.phase) {
            onState("loading").opacity(0.4)
            onState(done).opacity(1)
        }"#,
    );

    let (_, cases, _) = state_switch(&element, "opacity.0");
    assert_eq!(cases.get("loading"), Some(&json!(0.4)));
    assert_eq!(cases.get("done"), Some(&json!(1.0)));
}

// ============================================================================
// .onAnimationComplete — Option F completion events (engine: zero changes)
// ============================================================================

#[test]
fn test_on_animation_complete_flows_as_ordinary_event_prop() {
    // Pins that the anim interception does NOT swallow .onAnimationComplete:
    // it lowers through the generic applicator path like every on[A-Z]*
    // event applicator — renderers dispatch it, the engine never touches it.
    let element = parse_to_element(
        r#"Icon(name: "check").animate(pulse).onAnimationComplete(@actions.animationDone)"#,
    );

    match element.props.get("onAnimationComplete.0").unwrap() {
        Value::Action(name) => assert_eq!(name, "animationDone"),
        other => panic!("Expected Action prop, got {:?}", other),
    }
    // The sibling .animate still lowered to its channel.
    assert!(element.props.contains_key("__anim.animate"));
    assert!(!element.props.contains_key("__anim.onAnimationComplete"));
}

// ============================================================================
// .scrub / .settle — Option G scrub bindings
// ============================================================================
//
// Scrub interpolates between two of the node's `.states` poses. The pair is
// deferred to the SAME end-phase as `.states` (strictly after it, since
// cross-validation reads the collected pose labels), lowers to four static
// wire props ("__anim.scrub", "__anim.scrubSettle", "__anim.scrubBind",
// "__anim.scrubPoses" — the materialized [from, to] endpoint values),
// and any hard violation warns once and omits ALL FOUR — the node degrades
// to plain .states behavior. The applicators are always stripped: they
// never become scrub.<idx>/settle.<idx> props.

/// A two-pose sheet `.states` block (closed/open over translateY).
const SHEET_STATES: &str = r#"
    .states(@state.sheetPhase) {
        onState(closed).translateY(400)
        onState(open).translateY(0)
    }"#;

/// Parse `Box().translateY(400)<scrub_settle><states>` inline.
fn parse_scrub_element(scrub_settle: &str, states: &str) -> hypen_engine::Element {
    parse_to_element(&format!("Box().translateY(400){scrub_settle}{states}"))
}

/// Helper: unwrap a prop as Static JSON.
fn static_prop<'a>(element: &'a hypen_engine::Element, key: &str) -> &'a serde_json::Value {
    match element.props.get(key) {
        Some(Value::Static(v)) => v,
        other => panic!("Expected Static prop '{key}', got {:?}", other),
    }
}

/// Assert the omit-all contract: none of the three scrub wire props, and no
/// stripped-applicator leakage either.
fn assert_no_scrub_props(element: &hypen_engine::Element) {
    for key in [
        "__anim.scrub",
        "__anim.scrubSettle",
        "__anim.scrubBind",
        "__anim.scrubPoses",
        "scrub.0",
        "scrub.from",
        "scrub.over",
        "settle.0",
        "settle.curve",
        "settle.bind",
    ] {
        assert!(
            !element.props.contains_key(key),
            "scrub-related prop '{key}' must be absent; props: {:?}",
            element.props.keys().collect::<Vec<_>>()
        );
    }
}

#[test]
fn test_scrub_happy_path_all_three_props() {
    let element = parse_scrub_element(
        r#"
        .scrub(from: closed, to: open, source: gesture, axis: y, over: [0, 400], rubberBand: 0.4)
        .settle(curve: spring, duration: 300, bind: @state.sheetPhase)"#,
        SHEET_STATES,
    );

    assert_eq!(
        static_prop(&element, "__anim.scrub"),
        &json!({
            "from": "closed",
            "to": "open",
            "source": "gesture",
            "axis": "y",
            "over": [0, 400],
            "rubberBand": 0.4
        })
    );
    assert_eq!(
        static_prop(&element, "__anim.scrubSettle"),
        &json!({"curve": "spring", "duration": 300})
    );
    // Dotted state path string, module-scope semantics identical to .bind.
    assert_eq!(static_prop(&element, "__anim.scrubBind"), &json!("sheetPhase"));

    // Materialized pose endpoints: [fromValue, toValue] per overridden key.
    assert_eq!(
        static_prop(&element, "__anim.scrubPoses"),
        &json!({ "translateY.0": [400.0, 0.0] })
    );

    // The applicators are stripped — never scrub.<idx>/settle.<idx> props.
    for key in ["scrub.0", "scrub.from", "settle.0", "settle.curve", "settle.bind"] {
        assert!(!element.props.contains_key(key), "leaked '{key}'");
    }
}

#[test]
fn test_scrub_defaults_filled() {
    let element = parse_scrub_element(
        r#"
        .scrub(from: closed, to: open, over: [0, 400])
        .settle(bind: @state.sheetPhase)"#,
        SHEET_STATES,
    );

    // source: gesture, axis: y, rubberBand: 0.4 / curve: spring, duration: 300.
    assert_eq!(
        static_prop(&element, "__anim.scrub"),
        &json!({
            "from": "closed",
            "to": "open",
            "source": "gesture",
            "axis": "y",
            "over": [0, 400],
            "rubberBand": 0.4
        })
    );
    assert_eq!(
        static_prop(&element, "__anim.scrubSettle"),
        &json!({"curve": "spring", "duration": 300})
    );
    assert_eq!(static_prop(&element, "__anim.scrubBind"), &json!("sheetPhase"));
}

#[test]
fn test_scrub_scroll_source_with_of() {
    let element = parse_scrub_element(
        r#"
        .scrub(from: closed, to: open, source: scroll, axis: y, over: [0, 120], of: "header")
        .settle(bind: @state.sheetPhase)"#,
        SHEET_STATES,
    );

    assert_eq!(
        static_prop(&element, "__anim.scrub"),
        &json!({
            "from": "closed",
            "to": "open",
            "source": "scroll",
            "axis": "y",
            "over": [0, 120],
            "rubberBand": 0.4,
            "of": "header"
        })
    );
}

#[test]
fn test_scrub_of_with_gesture_source_warned_and_dropped() {
    // `of:` names a scroll container — meaningless for gesture. The scrub
    // itself still lowers; only the `of` key is dropped.
    let element = parse_scrub_element(
        r#"
        .scrub(from: closed, to: open, source: gesture, over: [0, 400], of: "header")
        .settle(bind: @state.sheetPhase)"#,
        SHEET_STATES,
    );

    let spec = static_prop(&element, "__anim.scrub");
    assert!(spec.get("of").is_none(), "of must be dropped with gesture: {spec}");
    assert_eq!(spec["source"], json!("gesture"));
}

#[test]
fn test_scrub_missing_states_block_omits_all() {
    let element = parse_scrub_element(
        r#"
        .scrub(from: closed, to: open, over: [0, 400])
        .settle(bind: @state.sheetPhase)"#,
        "",
    );

    assert_no_scrub_props(&element);
    // The base prop is untouched.
    assert_eq!(static_prop(&element, "translateY.0"), &json!(400.0));
}

#[test]
fn test_scrub_unknown_pose_label_omits_all() {
    for scrub in [
        // from: unknown label
        r#".scrub(from: hidden, to: open, over: [0, 400])"#,
        // to: unknown label
        r#".scrub(from: closed, to: fullscreen, over: [0, 400])"#,
    ] {
        let element = parse_scrub_element(
            &format!("{scrub}\n.settle(bind: @state.sheetPhase)"),
            SHEET_STATES,
        );

        assert_no_scrub_props(&element);
        // The states machinery is untouched by the degradation.
        assert!(element.props.contains_key("__anim.states"));
        assert!(
            matches!(element.props.get("translateY.0"), Some(Value::StateSwitch { .. })),
            "pose switch must survive scrub degradation"
        );
    }
}

#[test]
fn test_scrub_missing_settle_omits_all() {
    let element = parse_scrub_element(
        r#".scrub(from: closed, to: open, over: [0, 400])"#,
        SHEET_STATES,
    );
    assert_no_scrub_props(&element);
}

#[test]
fn test_scrub_settle_without_valid_bind_omits_all() {
    for settle in [
        // no bind at all
        r#".settle(curve: spring, duration: 300)"#,
        // bind must be a @state.* reference, not a plain string
        r#".settle(bind: "sheetPhase")"#,
        // item bindings are not state
        r#".settle(bind: @item.phase)"#,
        // numbers are right out
        r#".settle(bind: 42)"#,
    ] {
        let element = parse_scrub_element(
            &format!(".scrub(from: closed, to: open, over: [0, 400])\n{settle}"),
            SHEET_STATES,
        );
        assert_no_scrub_props(&element);
    }
}

#[test]
fn test_scrub_missing_over_omits_all() {
    let element = parse_scrub_element(
        r#"
        .scrub(from: closed, to: open)
        .settle(bind: @state.sheetPhase)"#,
        SHEET_STATES,
    );
    assert_no_scrub_props(&element);
}

#[test]
fn test_scrub_bad_over_shapes_omit_all() {
    for over in [
        "over: 400",             // not a list
        "over: [0]",             // one element
        "over: [0, 100, 200]",   // three elements
        r#"over: ["a", "b"]"#,   // non-numbers
        "over: [100, 100]",      // equal endpoints — zero-length range
    ] {
        let element = parse_scrub_element(
            &format!(
                ".scrub(from: closed, to: open, {over})\n.settle(bind: @state.sheetPhase)"
            ),
            SHEET_STATES,
        );
        assert_no_scrub_props(&element);
    }
}

#[test]
fn test_scrub_over_is_directed_descending_ranges_lower() {
    // `over` is [inputAtProgress0, inputAtProgress1] — direction matters.
    // An upward-opening sheet ([0, -400]) and a reversed range ([400, 0])
    // both lower verbatim.
    for over in ["[0, -400]", "[400, 0]"] {
        let element = parse_scrub_element(
            &format!(
                ".scrub(from: closed, to: open, over: {over})\n.settle(bind: @state.sheetPhase)"
            ),
            SHEET_STATES,
        );
        let spec = static_prop(&element, "__anim.scrub");
        let expected: serde_json::Value = serde_json::from_str(over).unwrap();
        assert_eq!(spec["over"], expected, "over: {over}");
    }
}

#[test]
fn test_scrub_poses_fall_back_to_static_base_and_skip_one_ended_keys() {
    // `opacity` is overridden only by the `open` (to) pose but has a static
    // base default — the from endpoint falls back to the base. `color` is
    // overridden only by the `open` pose with NO base default — resolvable
    // on one end only, warned and excluded. `translateY` resolves from both
    // poses directly.
    let element = parse_to_element(
        r##"Box().translateY(400).opacity(0.5)
            .scrub(from: closed, to: open, over: [0, 400])
            .settle(bind: @state.sheetPhase)
            .states(@state.sheetPhase) {
                onState(closed).translateY(400)
                onState(open).translateY(0).opacity(1).color("#ff0000")
            }"##,
    );

    assert_eq!(
        static_prop(&element, "__anim.scrubPoses"),
        &json!({
            "translateY.0": [400.0, 0.0],
            "opacity.0": [0.5, 1.0]
        })
    );
    // The one-ended key's pose switch itself is untouched — it still flips,
    // it just snaps under scrub.
    assert!(
        matches!(element.props.get("color.0"), Some(Value::StateSwitch { .. })),
        "color.0 pose switch must survive"
    );
}

#[test]
fn test_scrub_poses_ignore_keys_of_uninvolved_poses() {
    // A key overridden ONLY by a pose that is neither from nor to does not
    // appear in the endpoint map.
    let element = parse_to_element(
        r#"Box().translateY(400)
            .scrub(from: closed, to: open, over: [0, 400])
            .settle(bind: @state.sheetPhase)
            .states(@state.sheetPhase) {
                onState(closed).translateY(400)
                onState(open).translateY(0)
                onState(peek).translateY(200).opacity(0.5)
            }"#,
    );

    assert_eq!(
        static_prop(&element, "__anim.scrubPoses"),
        &json!({ "translateY.0": [400.0, 0.0] })
    );
}

#[test]
fn test_scrub_rubber_band_clamp_and_reject() {
    // Out-of-range numbers clamp into 0..=1 (with a warning)…
    for (given, expected) in [("1.5", json!(1)), ("-0.5", json!(0)), ("0.9", json!(0.9))] {
        let element = parse_scrub_element(
            &format!(
                ".scrub(from: closed, to: open, over: [0, 400], rubberBand: {given})\n.settle(bind: @state.sheetPhase)"
            ),
            SHEET_STATES,
        );
        assert_eq!(
            static_prop(&element, "__anim.scrub")["rubberBand"],
            expected,
            "rubberBand: {given}"
        );
    }

    // …while non-numbers are rejected back to the 0.4 default. Neither is a
    // hard failure: the scrub still lowers.
    let element = parse_scrub_element(
        r#"
        .scrub(from: closed, to: open, over: [0, 400], rubberBand: "lots")
        .settle(bind: @state.sheetPhase)"#,
        SHEET_STATES,
    );
    assert_eq!(
        static_prop(&element, "__anim.scrub")["rubberBand"],
        json!(0.4)
    );
}

#[test]
fn test_scrub_unknown_source_and_axis_degrade_to_defaults() {
    // Unknown closed-vocabulary tokens warn and keep the default — degrade,
    // not a hard failure.
    let element = parse_scrub_element(
        r#"
        .scrub(from: closed, to: open, source: mouse, axis: z, over: [0, 400])
        .settle(bind: @state.sheetPhase)"#,
        SHEET_STATES,
    );

    let spec = static_prop(&element, "__anim.scrub");
    assert_eq!(spec["source"], json!("gesture"));
    assert_eq!(spec["axis"], json!("y"));
}

#[test]
fn test_settle_without_scrub_warned_and_ignored() {
    let element = parse_scrub_element(
        r#".settle(curve: spring, duration: 300, bind: @state.sheetPhase)"#,
        SHEET_STATES,
    );

    assert_no_scrub_props(&element);
    // The states machinery is untouched.
    assert!(element.props.contains_key("__anim.states"));
}

#[test]
fn test_scrub_coexists_with_synthesized_states_transition() {
    // The node's synthesized __anim.transition (Option C) is unchanged by
    // scrub: same spec with or without the .scrub/.settle pair.
    let with_scrub = parse_scrub_element(
        r#"
        .scrub(from: closed, to: open, over: [0, 400])
        .settle(bind: @state.sheetPhase)"#,
        SHEET_STATES,
    );
    let without_scrub = parse_scrub_element("", SHEET_STATES);

    let expected = json!({
        "duration": 250,
        "curve": "easeOut",
        "props": ["translateY"]
    });
    assert_eq!(static_prop(&with_scrub, "__anim.transition"), &expected);
    assert_eq!(static_prop(&without_scrub, "__anim.transition"), &expected);

    // And the states label switch is identical too.
    let (path, cases, default) = state_switch(&with_scrub, "__anim.states");
    assert_eq!(path, "sheetPhase");
    assert_eq!(cases.len(), 2);
    assert_eq!(default, Some(json!(null)));
}

#[test]
fn test_scrub_excluded_inside_states_pose() {
    // .scrub/.settle are animation applicators — excluded from onState poses
    // like the rest (warn + drop), never leaking pose props.
    let element = parse_to_element(
        r#"Box()
            .states(@state.sheetPhase) {
                onState(closed).translateY(400).scrub(from: closed, to: open, over: [0, 400])
                onState(open).translateY(0).settle(bind: @state.sheetPhase)
            }"#,
    );

    assert_no_scrub_props(&element);
    let (_, cases, _) = state_switch(&element, "translateY.0");
    assert_eq!(cases.get("closed"), Some(&json!(400.0)));
    assert_eq!(cases.get("open"), Some(&json!(0.0)));
}

// ============================================================================
// Video v2: playback bind + Scrubber primitive
// ============================================================================

#[test]
fn test_video_bind_lowers_to_playback_prop() {
    // .bind on Video targets the playback struct, not the form "value"
    // channel — hypen-docs/content/docs/guide/components.mdx §Playback control.
    let element = parse_to_element(r#"Video(src: "a.mp4").bind(@state.playback)"#);

    assert_eq!(element.element_type, "Video");
    match element.props.get("playback").unwrap() {
        Value::Binding(b) => assert_eq!(b.full_path(), "playback"),
        other => panic!("Expected Binding for playback prop, got {:?}", other),
    }
    match element.props.get("bind").unwrap() {
        Value::Static(v) => assert_eq!(v, &json!("playback")),
        other => panic!("Expected Static bind path, got {:?}", other),
    }
    assert!(
        !element.props.contains_key("value"),
        "Video bind must not lower to the form 'value' channel"
    );
}

#[test]
fn test_scrubber_is_a_primitive_with_slot_prop() {
    // Scrubber parses as a primitive (not an unknown component) and the
    // .slot marker lowers to the slot.0 prop renderers key on.
    let element = parse_to_element(r#"Scrubber().slot("controls")"#);

    assert_eq!(element.element_type, "Scrubber");
    match element.props.get("slot.0").unwrap() {
        Value::Static(v) => assert_eq!(v, &json!("controls")),
        other => panic!("Expected Static slot name, got {:?}", other),
    }
}
