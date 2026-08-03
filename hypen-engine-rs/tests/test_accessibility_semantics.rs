//! Phase 0 accessibility: derived semantics travel from the parser, through
//! IR expansion, into the `Create` patch and onto the wire.
//!
//! See the accessibility guide (`hypen-docs/content/docs/guide/accessibility.mdx`).
//! Phase 0 derived only `role=button`
//! for `Button`; these tests pin the end-to-end carrier so later phases can
//! grow the derivation table against a known-good path.

use hypen_engine::ir::{ast_to_ir_node, Role};
use hypen_engine::reactive::DependencyGraph;
use hypen_engine::reconcile::{reconcile_ir, InstanceTree, Patch};
use hypen_parser::parse_component;
use serde_json::json;

/// Parse a single component, expand to IR, reconcile, and return the patches.
fn patches_for(source: &str) -> Vec<Patch> {
    patches_for_state(source, &json!({}))
}

/// Like `patches_for`, but reconciles against the given state (so templated
/// `@{state.x}` values resolve).
fn patches_for_state(source: &str, state: &serde_json::Value) -> Vec<Patch> {
    let component = parse_component(source).unwrap();
    let ir = ast_to_ir_node(&component);
    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();
    reconcile_ir(&mut tree, &ir, None, state, &mut deps)
}

/// Find the first `Create` patch for the given element type.
fn create_for<'a>(patches: &'a [Patch], element_type: &str) -> &'a Patch {
    patches
        .iter()
        .find(|p| matches!(p, Patch::Create { element_type: et, .. } if et == element_type))
        .unwrap_or_else(|| panic!("no Create patch for {element_type} in {patches:?}"))
}

#[test]
fn button_create_patch_carries_role_button() {
    let patches = patches_for(r#"Button("Save")"#);
    let create = create_for(&patches, "Button");

    match create {
        Patch::Create { semantics, .. } => {
            let semantics = semantics.as_ref().expect("Button Create must carry semantics");
            assert_eq!(semantics.role, Some(Role::Button));
        }
        _ => unreachable!(),
    }
}

#[test]
fn button_semantics_serialize_into_the_patch_json() {
    let patches = patches_for(r#"Button("Save")"#);
    let json = serde_json::to_string(create_for(&patches, "Button")).unwrap();

    assert!(
        json.contains(r#""semantics":{"role":"button","name":"Save"}"#),
        "Button Create patch JSON should embed role and derived name, got: {json}"
    );
}

#[test]
fn structural_elements_emit_no_semantics_on_the_wire() {
    // A Column carries nothing derivable, so the `semantics` field is skipped
    // entirely — the wire format is unchanged for non-semantic nodes.
    let patches = patches_for(r#"Column { Text("hi") }"#);

    for ty in ["Column", "Text"] {
        let json = serde_json::to_string(create_for(&patches, ty)).unwrap();
        assert!(
            !json.contains("semantics"),
            "{ty} Create patch must not include a semantics field, got: {json}"
        );
    }
}

#[test]
fn nested_button_inside_a_column_still_gets_semantics() {
    // Derivation runs per element during expansion, so a Button nested under
    // structural containers is covered too.
    let patches = patches_for(r#"Column { Button("Go") }"#);
    match create_for(&patches, "Button") {
        Patch::Create { semantics, .. } => {
            assert_eq!(
                semantics.as_ref().and_then(|s| s.role),
                Some(Role::Button)
            );
        }
        _ => unreachable!(),
    }
}

/// Pull the semantics block off a given element type's Create patch.
fn semantics_of(patches: &[Patch], element_type: &str) -> Option<hypen_engine::ir::Semantics> {
    match create_for(patches, element_type) {
        Patch::Create { semantics, .. } => semantics.clone(),
        _ => unreachable!(),
    }
}

#[test]
fn role_table_covers_the_structurally_certain_types() {
    let cases = [
        (r#"Link("Home")"#, "Link", Role::Link),
        (r#"Paragraph("hi")"#, "Paragraph", Role::Paragraph),
        (r#"Image(src: "/a.png")"#, "Image", Role::Img),
        (r#"Input(placeholder: "Name")"#, "Input", Role::Textbox),
        (r#"Slider(value: 3)"#, "Slider", Role::Slider),
        (r#"ProgressBar(value: 50)"#, "ProgressBar", Role::Progressbar),
        // A native <select> is listbox-backed, not an ARIA combobox.
        (r#"Select(value: "a")"#, "Select", Role::Listbox),
    ];

    for (src, ty, expected) in cases {
        let patches = patches_for(src);
        assert_eq!(
            semantics_of(&patches, ty).and_then(|s| s.role),
            Some(expected),
            "{ty} should derive {expected:?}"
        );
    }
}

#[test]
fn heading_carries_its_level() {
    let patches = patches_for(r#"Heading("Title", level: 3)"#);
    let s = semantics_of(&patches, "Heading").expect("Heading has semantics");
    assert_eq!(s.role, Some(Role::Heading));
    assert_eq!(s.level, Some(3));
}

#[test]
fn spinner_is_a_busy_status_and_serializes_aria_busy() {
    let patches = patches_for(r#"Spinner()"#);
    let json = serde_json::to_string(create_for(&patches, "Spinner")).unwrap();
    assert!(
        json.contains(r#""semantics":{"role":"status","busy":true}"#),
        "Spinner Create should carry status+busy, got: {json}"
    );
}

#[test]
fn accessible_name_derivation_through_the_full_pipeline() {
    // The gate fixtures from the plan, end to end (parse → expand → reconcile).
    let name_of = |src: &str| {
        let patches = patches_for(src);
        semantics_of(&patches, "Button").and_then(|s| s.name)
    };
    let missing_of = |src: &str| {
        let patches = patches_for(src);
        semantics_of(&patches, "Button").and_then(|s| s.name_missing)
    };

    // Literal label.
    assert_eq!(name_of(r#"Button("Save")"#).as_deref(), Some("Save"));
    // Text child.
    assert_eq!(name_of(r#"Button { Text("Save") }"#).as_deref(), Some("Save"));
    // Icon + text: icon excluded.
    assert_eq!(
        name_of(r#"Button { Icon("trash") Text("Delete") }"#).as_deref(),
        Some("Delete")
    );
    // Nested structural containers.
    assert_eq!(
        name_of(r#"Button { Column { Text("a") Text("b") } }"#).as_deref(),
        Some("a b")
    );

    // Icon-only → required-but-missing.
    assert_eq!(missing_of(r#"Button { Icon("trash") }"#), Some(true));
    // Templated label → deferred (resolved at reconcile later), not missing.
    assert_eq!(name_of(r#"Button("@{state.label}")"#), None);
    assert_eq!(missing_of(r#"Button("@{state.label}")"#), None);
}

#[test]
fn explicit_label_applicator_flows_through_and_is_stripped() {
    let patches = patches_for(r#"Button { Icon("trash") }.label("Delete")"#);
    let create = create_for(&patches, "Button");
    match create {
        Patch::Create { semantics, props, .. } => {
            let s = semantics.as_ref().expect("button has semantics");
            assert_eq!(s.name.as_deref(), Some("Delete"));
            assert_eq!(s.name_explicit, Some(true));
            // The consumed intent prop must not leak into the patch props.
            assert!(
                !props.contains_key("label.0"),
                "label.0 should be stripped from props, got: {props:?}"
            );
        }
        _ => unreachable!(),
    }
}

#[test]
fn hidden_applicator_marks_decorative_and_strips_prop() {
    let patches = patches_for(r#"Icon("star").hidden()"#);
    match create_for(&patches, "Icon") {
        Patch::Create { semantics, props, .. } => {
            assert_eq!(semantics.as_ref().and_then(|s| s.hidden), Some(true));
            assert!(!props.contains_key("hidden.0"), "hidden.0 should be stripped");
        }
        _ => unreachable!(),
    }
}

#[test]
fn templated_own_name_resolves_at_reconcile() {
    // Button("@{state.label}") has no statically-derivable name; it resolves
    // from the element's own resolved text prop at reconcile.
    let patches = patches_for_state(
        r#"Button("@{state.label}")"#,
        &json!({ "label": "Save changes" }),
    );
    assert_eq!(
        semantics_of(&patches, "Button").and_then(|s| s.name).as_deref(),
        Some("Save changes")
    );

    // An image's templated alt resolves the same way.
    let img = patches_for_state(
        r#"Image(src: "/a.png", alt: "@{state.cap}")"#,
        &json!({ "cap": "A sunset" }),
    );
    assert_eq!(
        semantics_of(&img, "Image").and_then(|s| s.name).as_deref(),
        Some("A sunset")
    );
}

#[test]
fn bound_checkbox_resolves_aria_checked_state() {
    // A Checkbox bound to `@state.agreed` resolves its checked state from the
    // bind-target prop at reconcile.
    let patches = patches_for_state(
        r#"Checkbox {}.bind(@state.agreed)"#,
        &json!({ "agreed": true }),
    );
    assert_eq!(
        semantics_of(&patches, "Checkbox").and_then(|s| s.checked),
        Some(true)
    );

    // A Switch resolves from its `on` bind-target prop.
    let sw = patches_for_state(
        r#"Switch {}.bind(@state.darkMode)"#,
        &json!({ "darkMode": false }),
    );
    assert_eq!(
        semantics_of(&sw, "Switch").and_then(|s| s.checked),
        Some(false)
    );
}

#[test]
fn bound_self_state_resolves_through_the_pipeline() {
    // A bound .expanded(@state.open) must resolve to a real aria value at
    // reconcile, not silently emit nothing.
    let patches = patches_for_state(
        r#"Button("Menu").expanded(@state.open)"#,
        &json!({ "open": true }),
    );
    assert_eq!(
        semantics_of(&patches, "Button").and_then(|s| s.expanded),
        Some(true)
    );
}

#[test]
fn bound_checkbox_label_resolves_through_the_pipeline() {
    let patches = patches_for_state(
        r#"Checkbox(label: "@{state.terms}")"#,
        &json!({ "terms": "Accept the terms" }),
    );
    assert_eq!(
        semantics_of(&patches, "Checkbox").and_then(|s| s.name).as_deref(),
        Some("Accept the terms")
    );
}

#[test]
fn landmark_opt_in_derives_a_role() {
    let patches = patches_for(r#"Column { Text("nav") }.landmark("navigation")"#);
    match create_for(&patches, "Column") {
        Patch::Create { semantics, .. } => {
            assert_eq!(
                semantics.as_ref().and_then(|s| s.role),
                Some(Role::Navigation)
            );
            // Note: landmark.0 is intentionally retained on props now so the
            // conformance checker can flag an unrecognised token; it is dropped
            // harmlessly by the renderer's CSS fallback.
        }
        _ => unreachable!(),
    }
}

#[test]
fn derisked_types_carry_no_semantics() {
    // List is keyed iteration (renders a flex container), Card is a generic
    // container, Icon is decorative-or-meaningful — none get an auto role.
    let card = patches_for(r#"Card { Text("body") }"#);
    assert_eq!(semantics_of(&card, "Card"), None);

    let icon = patches_for(r#"Icon("star")"#);
    assert_eq!(semantics_of(&icon, "Icon"), None);
}
