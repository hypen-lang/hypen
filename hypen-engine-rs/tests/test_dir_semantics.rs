//! `.dir("rtl" | "ltr" | "auto")` — text direction on the semantics block.
//!
//! The token is validated at derive: only the three valid values emit
//! `Semantics.dir` (an unknown token derives nothing — a wrong direction is
//! worse than none) and the `UnknownDirToken` conformance rule surfaces the
//! typo instead. Same false-positive guard as `UnknownRoleToken`: only a
//! static string token is checked.

use hypen_engine::ir::{ast_to_ir_node, IRNode, Semantics};
use hypen_engine::{check_accessibility, A11yRule};
use hypen_parser::parse_component;

/// Parse a single-element component and return its derived semantics block.
fn semantics_of(src: &str) -> Option<Semantics> {
    let component = parse_component(src).unwrap();
    match ast_to_ir_node(&component) {
        IRNode::Element(element) => element.semantics,
        other => panic!("expected a single element, got {other:?}"),
    }
}

fn rules(src: &str) -> Vec<A11yRule> {
    let component = parse_component(src).unwrap();
    check_accessibility(&ast_to_ir_node(&component))
        .into_iter()
        .map(|d| d.rule)
        .collect()
}

#[test]
fn dir_applicator_derives_the_direction() {
    let s = semantics_of(r#"Text("שלום").dir("rtl")"#).expect(".dir must keep the block");
    assert_eq!(s.dir.as_deref(), Some("rtl"));

    let s = semantics_of(r#"Text("hi").dir("ltr")"#).unwrap();
    assert_eq!(s.dir.as_deref(), Some("ltr"));

    let s = semantics_of(r#"Text("@{state.msg}").dir("auto")"#).unwrap();
    assert_eq!(s.dir.as_deref(), Some("auto"));
}

#[test]
fn dir_token_is_normalised_to_lowercase() {
    let s = semantics_of(r#"Text("hi").dir("RTL")"#).unwrap();
    assert_eq!(s.dir.as_deref(), Some("rtl"));
}

#[test]
fn dir_serializes_on_the_wire() {
    let s = semantics_of(r#"Text("שלום").dir("rtl")"#).unwrap();
    assert_eq!(serde_json::to_string(&s).unwrap(), r#"{"dir":"rtl"}"#);
}

#[test]
fn dir_combines_with_other_derived_semantics() {
    let s = semantics_of(r#"Button("שמור").dir("rtl")"#).unwrap();
    assert_eq!(s.dir.as_deref(), Some("rtl"));
    assert_eq!(s.name.as_deref(), Some("שמור"));
}

#[test]
fn unknown_dir_token_is_ignored_not_emitted() {
    // "rlt" is a typo: no direction derives (the block may not even exist
    // when nothing else is derivable) — never a confident wrong value.
    assert_eq!(
        semantics_of(r#"Text("hi").dir("rlt")"#).and_then(|s| s.dir),
        None
    );
}

#[test]
fn unknown_dir_token_fires_the_conformance_rule() {
    assert!(rules(r#"Text("hi").dir("rlt")"#).contains(&A11yRule::UnknownDirToken));
}

#[test]
fn valid_dir_tokens_stay_silent_in_conformance() {
    // The false-positive guard: correct code must not be flagged.
    for token in ["rtl", "ltr", "auto", "RTL"] {
        let src = format!(r#"Text("hi").dir("{token}")"#);
        assert!(
            !rules(&src).contains(&A11yRule::UnknownDirToken),
            ".dir(\"{token}\") must not be flagged"
        );
    }
    // And an element with no .dir at all is silent too.
    assert!(!rules(r#"Text("hi")"#).contains(&A11yRule::UnknownDirToken));
}

#[test]
fn bound_dir_is_skipped_by_the_conformance_rule() {
    // A bound value can't be validated at IR time — it must not be flagged.
    assert!(!rules(r#"Text("hi").dir(@state.direction)"#).contains(&A11yRule::UnknownDirToken));
}
