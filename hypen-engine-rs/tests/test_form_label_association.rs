//! Form-control ↔ label auto-association (`expand::wire_form_labels`) and
//! the reactive `.invalid` self-state field.
//!
//! An unlabeled form control (Input/TextArea/Select/Slider/Combobox) whose
//! immediately-preceding sibling is a static `Text` gets that Text wired as
//! its label — `labelledby` + minted Text `id` + spoken `name` — but only
//! inside a deterministic id namespace (parent `.id(...)` or an author id on
//! the Text itself), and only when the text passes the label-shape guard
//! (`looks_like_label`: at most 40 chars, at most 5 words, no trailing
//! sentence punctuation). Every guard here is a false-positive guard: the
//! ambiguous cases must wire *nothing*, and `FormControlMissingLabel` must
//! keep firing for them.

use hypen_engine::ir::ast_to_ir_node;
use hypen_engine::ir::{Role, Semantics};
use hypen_engine::reactive::DependencyGraph;
use hypen_engine::reconcile::{reconcile_ir, InstanceTree, Patch};
use hypen_engine::{check_accessibility, A11yRule};
use hypen_parser::parse_component;
use serde_json::json;

/// Parse, expand, and reconcile a component against `state`; return patches.
fn patches_for_state(source: &str, state: &serde_json::Value) -> Vec<Patch> {
    let component = parse_component(source).unwrap();
    let ir = ast_to_ir_node(&component);
    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();
    reconcile_ir(&mut tree, &ir, None, state, &mut deps)
}

fn patches_for(source: &str) -> Vec<Patch> {
    patches_for_state(source, &json!({}))
}

/// Semantics block off the first Create patch for `element_type`.
fn semantics_of(patches: &[Patch], element_type: &str) -> Option<Semantics> {
    patches
        .iter()
        .find_map(|p| match p {
            Patch::Create {
                element_type: et,
                semantics,
                ..
            } if et == element_type => Some(semantics.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no Create patch for {element_type} in {patches:?}"))
}

/// Conformance rules fired for a source snippet.
fn rules(source: &str) -> Vec<A11yRule> {
    let component = parse_component(source).unwrap();
    check_accessibility(&ast_to_ir_node(&component))
        .into_iter()
        .map(|d| d.rule)
        .collect()
}

// ---------------------------------------------------------------------------
// Wiring happens: the unambiguous label-then-field case.
// ---------------------------------------------------------------------------

#[test]
fn text_label_wires_to_the_following_input_under_a_parent_id() {
    let patches = patches_for(
        r#"Column {
            Text("Name")
            Input(placeholder: "Your name")
        }.id("signup")"#,
    );

    // The control speaks the label (name, non-explicit) and references the
    // Text by minted id.
    let input = semantics_of(&patches, "Input").expect("Input carries semantics");
    assert_eq!(input.role, Some(Role::Textbox));
    assert_eq!(input.name.as_deref(), Some("Name"));
    assert_eq!(
        input.name_explicit, None,
        "auto-wired name must stay non-explicit"
    );
    assert_eq!(input.labelledby.as_deref(), Some("signup-label-0"));

    // The Text became the reference anchor.
    let text = semantics_of(&patches, "Text").expect("Text gains an id anchor");
    assert_eq!(text.id.as_deref(), Some("signup-label-0"));
}

#[test]
fn each_pair_mints_its_own_id_in_document_order() {
    let patches = patches_for(
        r#"Column {
            Text("Name")
            Input(placeholder: "Your name")
            Text("Country")
            Select(value: "hr")
        }.id("signup")"#,
    );

    let input = semantics_of(&patches, "Input").unwrap();
    assert_eq!(input.labelledby.as_deref(), Some("signup-label-0"));
    assert_eq!(input.name.as_deref(), Some("Name"));

    let select = semantics_of(&patches, "Select").unwrap();
    assert_eq!(select.labelledby.as_deref(), Some("signup-label-1"));
    assert_eq!(select.name.as_deref(), Some("Country"));
}

#[test]
fn slider_and_textarea_wire_like_input() {
    let patches = patches_for(
        r#"Column {
            Text("Volume")
            Slider(value: 3)
            Text("Bio")
            TextArea(placeholder: "About you")
        }.id("prefs")"#,
    );
    assert_eq!(
        semantics_of(&patches, "Slider").unwrap().name.as_deref(),
        Some("Volume")
    );
    assert_eq!(
        semantics_of(&patches, "TextArea")
            .unwrap()
            .labelledby
            .as_deref(),
        Some("prefs-label-1")
    );
}

// ---------------------------------------------------------------------------
// Author intent always wins.
// ---------------------------------------------------------------------------

#[test]
fn author_label_wins_over_auto_association() {
    let patches = patches_for(
        r#"Column {
            Text("Name")
            Input(placeholder: "Your name").label("Full legal name")
        }.id("signup")"#,
    );

    let input = semantics_of(&patches, "Input").unwrap();
    assert_eq!(input.name.as_deref(), Some("Full legal name"));
    assert_eq!(input.name_explicit, Some(true));
    assert_eq!(
        input.labelledby, None,
        "explicit label must suppress wiring"
    );

    // The would-be label Text stays untouched: no minted id.
    assert_eq!(semantics_of(&patches, "Text"), None);
}

#[test]
fn author_labelledby_wins_over_auto_association() {
    let patches = patches_for(
        r#"Column {
            Text("Name").id("custom-label")
            Text("ignored")
            Input(placeholder: "x").labelledby("custom-label")
        }.id("signup")"#,
    );
    let input = semantics_of(&patches, "Input").unwrap();
    assert_eq!(input.labelledby.as_deref(), Some("custom-label"));
    assert_eq!(
        input.name, None,
        "author labelledby must not grow a derived name"
    );
}

// ---------------------------------------------------------------------------
// No deterministic namespace → no wiring (nondeterministic ids are worse
// than none).
// ---------------------------------------------------------------------------

#[test]
fn no_parent_id_and_no_text_id_means_no_wiring() {
    let patches = patches_for(
        r#"Column {
            Text("Name")
            Input(placeholder: "Your name")
        }"#,
    );
    let input = semantics_of(&patches, "Input").unwrap();
    assert_eq!(input.name, None);
    assert_eq!(input.labelledby, None);
    assert_eq!(
        semantics_of(&patches, "Text"),
        None,
        "no id minted for the Text"
    );
}

#[test]
fn an_author_id_on_the_text_wires_without_a_parent_id() {
    let patches = patches_for(
        r#"Column {
            Text("Name").id("name-label")
            Input(placeholder: "Your name")
        }"#,
    );
    let input = semantics_of(&patches, "Input").unwrap();
    assert_eq!(input.labelledby.as_deref(), Some("name-label"));
    assert_eq!(input.name.as_deref(), Some("Name"));
    assert_eq!(
        semantics_of(&patches, "Text").unwrap().id.as_deref(),
        Some("name-label")
    );
}

// ---------------------------------------------------------------------------
// Ambiguous cases wire nothing.
// ---------------------------------------------------------------------------

#[test]
fn templated_text_does_not_wire() {
    // The Text's value is unknown at expand — a stale auto-name is worse
    // than none.
    let patches = patches_for_state(
        r#"Column {
            Text("@{state.label}")
            Input(placeholder: "x")
        }.id("f")"#,
        &json!({ "label": "Name" }),
    );
    let input = semantics_of(&patches, "Input").unwrap();
    assert_eq!(input.name, None);
    assert_eq!(input.labelledby, None);
}

#[test]
fn a_non_text_sibling_between_label_and_control_does_not_wire() {
    // Only the *immediately preceding* sibling counts.
    let patches = patches_for(
        r#"Column {
            Text("Name")
            Spacer {}
            Input(placeholder: "x")
        }.id("f")"#,
    );
    let input = semantics_of(&patches, "Input").unwrap();
    assert_eq!(input.labelledby, None);
}

#[test]
fn a_text_with_its_own_semantic_job_does_not_wire() {
    // A hidden (decorative) Text is not a label.
    let patches = patches_for(
        r#"Column {
            Text("Name").hidden()
            Input(placeholder: "x")
        }.id("f")"#,
    );
    assert_eq!(semantics_of(&patches, "Input").unwrap().labelledby, None);

    // A Text opted into a role has another job.
    let patches = patches_for(
        r#"Column {
            Text("Name").role("option")
            Input(placeholder: "x")
        }.id("f")"#,
    );
    assert_eq!(semantics_of(&patches, "Input").unwrap().labelledby, None);
}

#[test]
fn checkbox_and_switch_are_never_auto_wired() {
    // Checkbox/Switch self-label from their own visible label text; a
    // preceding Text must not override that model.
    let patches = patches_for(
        r#"Column {
            Text("Agree to terms")
            Checkbox {}
        }.id("f")"#,
    );
    let checkbox = semantics_of(&patches, "Checkbox").unwrap();
    assert_eq!(checkbox.labelledby, None);
    assert_eq!(checkbox.name, None);
    assert_eq!(
        checkbox.name_missing,
        Some(true),
        "a bare Checkbox stays flagged"
    );
    assert_eq!(semantics_of(&patches, "Text"), None);
}

// ---------------------------------------------------------------------------
// Label-shape guard: prose meets every structural guard, so its *shape*
// (length / word count / sentence punctuation) must decline the wiring —
// leaving the control unlabeled so FormControlMissingLabel fires.
// ---------------------------------------------------------------------------

#[test]
fn instructional_prose_does_not_wire_and_the_rule_fires() {
    // The third-pass review's live misfire: sentence text before an Input
    // must not become its accessible name, and must not silence the checker.
    let src = r#"Column {
        Text("All fields are required.")
        Input(placeholder: "Full name")
    }.id("signup")"#;

    let patches = patches_for(src);
    let input = semantics_of(&patches, "Input").unwrap();
    assert_eq!(input.name, None);
    assert_eq!(input.labelledby, None);
    assert_eq!(
        semantics_of(&patches, "Text"),
        None,
        "no id minted for the prose"
    );

    assert!(rules(src).contains(&A11yRule::FormControlMissingLabel));
}

#[test]
fn sentence_punctuation_declines_wiring() {
    // Under 40 chars and under 6 words — the trailing '.' alone rejects.
    let src = r#"Column {
        Text("Enter the email address you use for work.")
        Input(placeholder: "you@work.com")
    }.id("f")"#;
    let patches = patches_for(src);
    let input = semantics_of(&patches, "Input").unwrap();
    assert_eq!(input.name, None);
    assert_eq!(input.labelledby, None);
    assert!(rules(src).contains(&A11yRule::FormControlMissingLabel));
}

#[test]
fn six_word_text_declines_wiring() {
    let src = r#"Column {
        Text("Please enter your full legal name")
        Input(placeholder: "Full name")
    }.id("f")"#;
    let input = semantics_of(&patches_for(src), "Input").unwrap();
    assert_eq!(input.name, None);
    assert_eq!(input.labelledby, None);
    assert!(rules(src).contains(&A11yRule::FormControlMissingLabel));
}

#[test]
fn short_labels_with_and_without_trailing_colon_still_wire() {
    let patches = patches_for(
        r#"Column {
            Text("Email")
            Input(placeholder: "you@example.com")
            Text("Country:")
            Select(value: "hr")
        }.id("f")"#,
    );

    let input = semantics_of(&patches, "Input").unwrap();
    assert_eq!(input.name.as_deref(), Some("Email"));
    assert_eq!(input.labelledby.as_deref(), Some("f-label-0"));

    // A trailing ':' is label-like, not sentence punctuation.
    let select = semantics_of(&patches, "Select").unwrap();
    assert_eq!(select.name.as_deref(), Some("Country:"));
    assert_eq!(select.labelledby.as_deref(), Some("f-label-1"));
}

// ---------------------------------------------------------------------------
// Conformance: FormControlMissingLabel keys off the wired name.
// ---------------------------------------------------------------------------

#[test]
fn form_control_missing_label_is_silenced_by_auto_wiring() {
    let wired = r#"Column {
        Text("Name")
        Input(placeholder: "Your name")
    }.id("signup")"#;
    assert!(
        rules(wired).is_empty(),
        "auto-wired control must produce no diagnostics, got {:?}",
        rules(wired)
    );
}

#[test]
fn form_control_missing_label_still_fires_when_nothing_wires() {
    // No deterministic namespace → not wired → still flagged.
    let unwired = r#"Column {
        Text("Name")
        Input(placeholder: "Your name")
    }"#;
    assert!(rules(unwired).contains(&A11yRule::FormControlMissingLabel));

    // No label Text at all → flagged regardless of the parent id.
    let bare = r#"Column {
        Input(placeholder: "Your name")
    }.id("signup")"#;
    assert!(rules(bare).contains(&A11yRule::FormControlMissingLabel));
}

// ---------------------------------------------------------------------------
// `.invalid` self-state: static, bound, and the SetSemantics re-emit.
// ---------------------------------------------------------------------------

#[test]
fn static_invalid_derives_and_serializes() {
    let patches = patches_for(r#"Input(placeholder: "Email").label("Email").invalid(true)"#);
    let input = semantics_of(&patches, "Input").unwrap();
    assert_eq!(input.invalid, Some(true));

    let json = serde_json::to_string(&input).unwrap();
    assert!(json.contains(r#""invalid":true"#), "got: {json}");
}

#[test]
fn bound_invalid_resolves_at_reconcile_and_re_emits_on_change() {
    let src = r#"Input(placeholder: "Email").label("Email").invalid(@state.hasError)"#;
    let component = parse_component(src).unwrap();
    let ir = ast_to_ir_node(&component);
    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();

    // Resolved at create.
    let initial = reconcile_ir(&mut tree, &ir, None, &json!({"hasError": false}), &mut deps);
    assert_eq!(
        semantics_of(&initial, "Input").unwrap().invalid,
        Some(false)
    );

    // Flip → exactly one SetSemantics carrying the full block with the new
    // validity (and the untouched label).
    let patches = reconcile_ir(&mut tree, &ir, None, &json!({"hasError": true}), &mut deps);
    let blocks: Vec<_> = patches
        .iter()
        .filter_map(|p| match p {
            Patch::SetSemantics { semantics, .. } => Some(semantics.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(blocks.len(), 1, "got {patches:?}");
    let block = blocks[0].as_ref().expect("block present");
    assert_eq!(block.invalid, Some(true));
    assert_eq!(block.name.as_deref(), Some("Email"));

    // Same value again → fixed point, no re-emit.
    let patches = reconcile_ir(&mut tree, &ir, None, &json!({"hasError": true}), &mut deps);
    assert!(
        !patches
            .iter()
            .any(|p| matches!(p, Patch::SetSemantics { .. })),
        "got {patches:?}"
    );
}
