//! Vocabulary extensions: `.liveRegion(...)`, the `listitem` role, and
//! child-template accessible-name hoisting (`__a11yName`).
//!
//! - `.liveRegion("polite" | "assertive")` derives `Semantics.live`
//!   (engine-validated; unknown tokens derive nothing).
//! - A `.role("list")` container makes its direct, role-less element
//!   children `listitem`s — the same conservative shape as the Tabs wiring.
//! - `Button { Text("@{state.x}") }`: the child's template is hoisted onto
//!   the parent as a synthetic `__a11yName` prop so the name resolves at
//!   create and re-emits via `Patch::SetSemantics` when the binding dirties.
//!   The carrier prop is engine-internal: it stays on the `InstanceNode` but
//!   is stripped from every emitted patch (no Create prop, no SetProp).

use hypen_engine::ir::ast_to_ir_node;
use hypen_engine::ir::Semantics;
use hypen_engine::reactive::DependencyGraph;
use hypen_engine::reconcile::{reconcile_ir, InstanceTree, Patch};
use hypen_engine::{Element, IRNode};
use hypen_parser::parse_component;
use serde_json::json;

/// Parse `source` and expand it to an `Element`.
fn expand(source: &str) -> Element {
    let component = parse_component(source).unwrap();
    match ast_to_ir_node(&component) {
        IRNode::Element(e) => e,
        other => panic!("expected Element, got {other:?}"),
    }
}

/// Initial reconcile of `source` against `state`; returns the live tree,
/// deps, expanded IR, and first-paint patches.
fn setup(
    source: &str,
    state: &serde_json::Value,
) -> (InstanceTree, DependencyGraph, hypen_engine::IRNode, Vec<Patch>) {
    let component = parse_component(source).unwrap();
    let ir = ast_to_ir_node(&component);
    let mut tree = InstanceTree::new();
    let mut deps = DependencyGraph::new();
    let patches = reconcile_ir(&mut tree, &ir, None, state, &mut deps);
    (tree, deps, ir, patches)
}

/// Re-reconcile the same IR against a new state, returning the patches.
fn update(
    tree: &mut InstanceTree,
    deps: &mut DependencyGraph,
    ir: &hypen_engine::IRNode,
    state: &serde_json::Value,
) -> Vec<Patch> {
    reconcile_ir(tree, ir, None, state, deps)
}

/// The semantics block of the first Create patch for `element_type`.
fn create_semantics(patches: &[Patch], element_type: &str) -> Option<Semantics> {
    patches.iter().find_map(|p| match p {
        Patch::Create {
            element_type: et,
            semantics,
            ..
        } if et == element_type => semantics.clone(),
        _ => None,
    })
}

/// All SetSemantics blocks in a patch batch, in order.
fn set_semantics(patches: &[Patch]) -> Vec<Option<Semantics>> {
    patches
        .iter()
        .filter_map(|p| match p {
            Patch::SetSemantics { semantics, .. } => Some(semantics.clone()),
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// .liveRegion(...)
// ---------------------------------------------------------------------------

#[test]
fn live_region_derives_the_two_valid_tokens() {
    let polite = expand(r#"Column {}.liveRegion("polite")"#);
    assert_eq!(
        polite.semantics.as_ref().and_then(|s| s.live.as_deref()),
        Some("polite")
    );

    let assertive = expand(r#"Column {}.liveRegion("assertive")"#);
    assert_eq!(
        assertive.semantics.as_ref().and_then(|s| s.live.as_deref()),
        Some("assertive")
    );
}

#[test]
fn live_region_token_is_normalised_to_lowercase() {
    let el = expand(r#"Column {}.liveRegion("Polite")"#);
    assert_eq!(
        el.semantics.as_ref().and_then(|s| s.live.as_deref()),
        Some("polite")
    );
}

#[test]
fn unknown_live_region_token_derives_nothing() {
    // "rude" is not an announcement mode — no live rather than a wrong one.
    let el = expand(r#"Column {}.liveRegion("rude")"#);
    assert_eq!(el.semantics.as_ref().and_then(|s| s.live.clone()), None);
}

#[test]
fn live_serializes_on_the_wire() {
    let el = expand(r#"Column {}.liveRegion("polite")"#);
    assert_eq!(
        serde_json::to_string(&el.semantics.unwrap()).unwrap(),
        r#"{"live":"polite"}"#
    );
}

#[test]
fn spinner_busy_status_is_unchanged_by_live_vocabulary() {
    // Spinner keeps its auto-derived status+busy; no live token is invented.
    let el = expand("Spinner {}");
    let s = el.semantics.unwrap();
    assert_eq!(serde_json::to_string(&s).unwrap(), r#"{"role":"status","busy":true}"#);
}

// ---------------------------------------------------------------------------
// listitem
// ---------------------------------------------------------------------------

#[test]
fn list_role_container_derives_listitem_on_direct_roleless_children() {
    let el = expand(
        r#"Column {
            Text("Alpha")
            Text("Beta")
        }.role("list")"#,
    );
    let roles: Vec<Option<String>> = el
        .ir_children
        .iter()
        .map(|c| {
            c.as_element()
                .and_then(|e| e.semantics.as_ref())
                .and_then(|s| s.role)
                .map(|r| serde_json::to_value(r).unwrap().as_str().unwrap().to_string())
        })
        .collect();
    assert_eq!(
        roles,
        vec![Some("listitem".to_string()), Some("listitem".to_string())]
    );
}

#[test]
fn children_with_their_own_role_are_not_listitems() {
    // A structural role (Button) and an opted-in role (option) both mean the
    // child has a different job — never overwritten.
    let el = expand(
        r#"Column {
            Button("Act")
            Text("Pick me").role("option")
        }.role("list")"#,
    );
    let role_token = |i: usize| {
        el.ir_children[i]
            .as_element()
            .and_then(|e| e.semantics.as_ref())
            .and_then(|s| s.role)
            .map(|r| serde_json::to_value(r).unwrap())
    };
    assert_eq!(role_token(0), Some(json!("button")));
    assert_eq!(role_token(1), Some(json!("option")));
}

#[test]
fn hidden_children_stay_decorative() {
    let el = expand(
        r#"Column {
            Text("Alpha").hidden()
        }.role("list")"#,
    );
    let s = el.ir_children[0]
        .as_element()
        .and_then(|e| e.semantics.clone())
        .unwrap();
    assert_eq!(s.hidden, Some(true));
    assert_eq!(s.role, None);
}

#[test]
fn content_behind_control_flow_is_not_wired() {
    // ForEach-generated items are deliberately untouched — same conservative
    // stance as the Tabs wiring.
    let el = expand(
        r#"Column {
            ForEach(items: @state.rows) { Text("@{item.label}") }
        }.role("list")"#,
    );
    assert!(matches!(el.ir_children[0], IRNode::ForEach { .. }));
}

#[test]
fn container_without_list_role_derives_no_listitems() {
    let el = expand(
        r#"Column {
            Text("Alpha")
        }"#,
    );
    assert_eq!(
        el.ir_children[0]
            .as_element()
            .and_then(|e| e.semantics.clone()),
        None
    );
}

#[test]
fn listitem_is_an_explicit_role_token_too() {
    let el = expand(r#"Row {}.role("listitem")"#);
    assert_eq!(
        serde_json::to_string(&el.semantics.unwrap()).unwrap(),
        r#"{"role":"listitem"}"#
    );
}

// ---------------------------------------------------------------------------
// Child-template name hoisting (__a11yName)
// ---------------------------------------------------------------------------

#[test]
fn mixed_static_and_templated_children_resolve_a_name_at_create() {
    let state = json!({"n": 3});
    let (_, _, _, initial) = setup(
        r#"Button {
            Text("Save")
            Text("@{state.n}")
        }"#,
        &state,
    );
    let s = create_semantics(&initial, "Button").expect("Button carries semantics");
    assert_eq!(s.name.as_deref(), Some("Save 3"));
    // Content-derived, not an author override: DOM keeps the visible text.
    assert_eq!(s.name_explicit, None);
    assert_eq!(s.name_missing, None);
    assert!(set_semantics(&initial).is_empty(), "no SetSemantics at create");
}

#[test]
fn child_template_change_re_emits_set_semantics_with_the_new_name() {
    let state = json!({"n": 3});
    let (mut tree, mut deps, ir, _) = setup(
        r#"Button {
            Text("Save")
            Text("@{state.n}")
        }"#,
        &state,
    );

    let patches = update(&mut tree, &mut deps, &ir, &json!({"n": 4}));
    let blocks = set_semantics(&patches);
    // The parent Button re-emits (its hoisted binding dirtied it); the Text
    // child has no semantics to re-emit.
    let names: Vec<_> = blocks
        .iter()
        .filter_map(|b| b.as_ref().and_then(|s| s.name.clone()))
        .collect();
    assert_eq!(names, vec!["Save 4".to_string()], "got {patches:?}");
}

#[test]
fn purely_templated_child_resolves_and_re_emits() {
    // The flagship finding-K case: Button { Text("@{state.x}") }.
    let state = json!({"x": "Search"});
    let (mut tree, mut deps, ir, initial) =
        setup(r#"Button { Text("@{state.x}") }"#, &state);
    let s = create_semantics(&initial, "Button").unwrap();
    assert_eq!(s.name.as_deref(), Some("Search"));

    let patches = update(&mut tree, &mut deps, &ir, &json!({"x": "Find"}));
    let names: Vec<_> = set_semantics(&patches)
        .iter()
        .filter_map(|b| b.as_ref().and_then(|s| s.name.clone()))
        .collect();
    assert_eq!(names, vec!["Find".to_string()]);
}

#[test]
fn pure_static_children_are_unchanged_by_hoisting() {
    let state = json!({"n": 3});
    let (mut tree, mut deps, ir, initial) = setup(
        r#"Button {
            Text("Save")
        }"#,
        &state,
    );
    let s = create_semantics(&initial, "Button").unwrap();
    assert_eq!(s.name.as_deref(), Some("Save"));

    // No synthetic prop on the wire for the static case…
    let props = initial
        .iter()
        .find_map(|p| match p {
            Patch::Create {
                element_type, props, ..
            } if element_type == "Button" => Some(props.clone()),
            _ => None,
        })
        .unwrap();
    assert!(!props.contains_key("__a11yName"));

    // …and a state change re-emits nothing (resolution is a fixed point).
    let patches = update(&mut tree, &mut deps, &ir, &json!({"n": 4}));
    assert!(
        !patches.iter().any(|p| matches!(p, Patch::SetSemantics { .. })),
        "static tree must not re-emit, got {patches:?}"
    );
}

#[test]
fn synthetic_prop_stays_off_the_wire_at_create() {
    // The hoisted carrier feeds `resolve_semantics` engine-side; the wire
    // carries only the typed name in the semantics block, never the prop.
    let state = json!({"n": 3});
    let (tree, _, _, initial) = setup(
        r#"Button {
            Text("Save")
            Text("@{state.n}")
        }"#,
        &state,
    );
    for patch in &initial {
        if let Patch::Create { props, .. } = patch {
            assert!(
                !props.contains_key("__a11yName"),
                "carrier prop leaked into Create: {patch:?}"
            );
        }
    }
    let s = create_semantics(&initial, "Button").unwrap();
    assert_eq!(s.name.as_deref(), Some("Save 3"));

    // Engine-side the carrier survives on the node — it must keep feeding
    // dependency-driven re-resolution after the Create was stripped.
    let kept = tree
        .iter()
        .any(|(_, n)| n.props.contains_key("__a11yName"));
    assert!(kept, "carrier prop must stay on the InstanceNode");
}

#[test]
fn synthetic_prop_change_emits_set_semantics_but_no_set_prop() {
    let state = json!({"n": 3});
    let (mut tree, mut deps, ir, _) = setup(
        r#"Button {
            Text("Save")
            Text("@{state.n}")
        }"#,
        &state,
    );

    let patches = update(&mut tree, &mut deps, &ir, &json!({"n": 4}));
    assert!(
        !patches.iter().any(|p| matches!(
            p,
            Patch::SetProp { name, .. } | Patch::RemoveProp { name, .. }
                if name == "__a11yName"
        )),
        "carrier prop leaked into the patch stream: {patches:?}"
    );
    let names: Vec<_> = set_semantics(&patches)
        .iter()
        .filter_map(|b| b.as_ref().and_then(|s| s.name.clone()))
        .collect();
    assert_eq!(names, vec!["Save 4".to_string()]);
}

#[test]
fn explicit_label_wins_over_child_templates() {
    let state = json!({"n": 3});
    let (mut tree, mut deps, ir, initial) = setup(
        r#"Button {
            Text("@{state.n}")
        }.label("Increment")"#,
        &state,
    );
    let s = create_semantics(&initial, "Button").unwrap();
    assert_eq!(s.name.as_deref(), Some("Increment"));
    assert_eq!(s.name_explicit, Some(true));

    // The hoist never fires under an author label, so the child change must
    // not clobber the explicit name.
    let patches = update(&mut tree, &mut deps, &ir, &json!({"n": 4}));
    for block in set_semantics(&patches).into_iter().flatten() {
        assert_eq!(block.name.as_deref(), Some("Increment"));
    }
}

#[test]
fn icon_only_button_is_still_name_missing() {
    // The hoist must not misfire on the loud-gap case.
    let state = json!({});
    let (_, _, _, initial) = setup(r#"Button { Icon("trash") }"#, &state);
    let s = create_semantics(&initial, "Button").unwrap();
    assert_eq!(s.name, None);
    assert_eq!(s.name_missing, Some(true));
}

#[test]
fn control_flow_children_still_defer_to_an_explicit_label() {
    // A ForEach child means the name is not statically recoverable — the
    // hoist stays out and the missing flag survives.
    let state = json!({"items": ["a"]});
    let (_, _, _, initial) = setup(
        r#"Button {
            ForEach(items: @state.items) { Text("@{item}") }
        }"#,
        &state,
    );
    let s = create_semantics(&initial, "Button").unwrap();
    assert_eq!(s.name, None);
    assert_eq!(s.name_missing, Some(true));
}
