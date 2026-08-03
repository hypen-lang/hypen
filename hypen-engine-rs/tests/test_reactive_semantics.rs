//! Engine-driven reactive semantics re-emit (`Patch::SetSemantics`).
//!
//! After first paint, a node's accessible name or state can change
//! reactively (templated name, bound self-state, bound checked). The
//! reconciler compares the freshly-resolved `Semantics` against the block
//! last sent to the renderer and emits a `SetSemantics` carrying the full
//! updated block — and nothing for static trees, where resolution is a
//! fixed point. See the `Patch::SetSemantics` docs in `reconcile/patch.rs`.

use hypen_engine::ir::ast_to_ir_node;
use hypen_engine::reactive::DependencyGraph;
use hypen_engine::reconcile::{reconcile_ir, InstanceTree, Patch};
use hypen_engine::ir::Semantics;
use hypen_parser::parse_component;
use serde_json::json;

/// Initial reconcile of `source` against `state`; returns the live tree,
/// deps, and expanded IR for follow-up reconciles.
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

#[test]
fn templated_name_re_emits_on_change() {
    let state = json!({"label": "Save"});
    let (mut tree, mut deps, ir, initial) = setup(r#"Button("@{state.label}")"#, &state);

    // First paint resolves the templated name into the Create block.
    let create_sem = initial.iter().find_map(|p| match p {
        Patch::Create { semantics, .. } => semantics.clone(),
        _ => None,
    });
    assert_eq!(create_sem.and_then(|s| s.name), Some("Save".to_string()));
    assert!(set_semantics(&initial).is_empty(), "no SetSemantics at create");

    // The name's source path changes → exactly one SetSemantics with the
    // new resolved name.
    let patches = update(&mut tree, &mut deps, &ir, &json!({"label": "Submit"}));
    let blocks = set_semantics(&patches);
    assert_eq!(blocks.len(), 1, "expected exactly one SetSemantics, got {patches:?}");
    let block = blocks[0].as_ref().expect("block should be Some");
    assert_eq!(block.name.as_deref(), Some("Submit"));
}

#[test]
fn unrelated_state_change_emits_no_set_semantics() {
    let state = json!({"label": "Save", "count": 1});
    let (mut tree, mut deps, ir, _) = setup(r#"Button("@{state.label}")"#, &state);

    let patches = update(&mut tree, &mut deps, &ir, &json!({"label": "Save", "count": 2}));
    assert!(
        set_semantics(&patches).is_empty(),
        "unchanged semantics must not re-emit, got {patches:?}"
    );
}

#[test]
fn static_tree_never_emits_set_semantics() {
    let (mut tree, mut deps, ir, initial) = setup(r#"Button("Save")"#, &json!({"x": 1}));
    assert!(set_semantics(&initial).is_empty());

    for x in 2..5 {
        let patches = update(&mut tree, &mut deps, &ir, &json!({ "x": x }));
        assert!(
            set_semantics(&patches).is_empty(),
            "static semantics resolution is a fixed point; got {patches:?}"
        );
    }
}

#[test]
fn bound_self_state_flip_re_emits() {
    let state = json!({"open": false});
    let (mut tree, mut deps, ir, initial) =
        setup(r#"Button("Menu").expanded(@state.open)"#, &state);

    // Resolved at create.
    let create_sem = initial
        .iter()
        .find_map(|p| match p {
            Patch::Create { semantics, .. } => semantics.clone(),
            _ => None,
        })
        .expect("Button carries semantics");
    assert_eq!(create_sem.expanded, Some(false));

    // Toggle → SetSemantics with expanded=true (name unchanged, still on
    // the block: it's the complete state, not a delta).
    let patches = update(&mut tree, &mut deps, &ir, &json!({"open": true}));
    let blocks = set_semantics(&patches);
    assert_eq!(blocks.len(), 1, "got {patches:?}");
    let block = blocks[0].as_ref().unwrap();
    assert_eq!(block.expanded, Some(true));
    assert_eq!(block.name.as_deref(), Some("Menu"));

    // Toggle back → re-emits (guards the `!=` comparison against a sticky
    // stale block).
    let patches = update(&mut tree, &mut deps, &ir, &json!({"open": false}));
    let blocks = set_semantics(&patches);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].as_ref().unwrap().expanded, Some(false));
}

#[test]
fn bound_checkbox_checked_re_emits() {
    let state = json!({"agreed": false});
    let (mut tree, mut deps, ir, _) =
        setup(r#"Checkbox(label: "Accept").bind(@state.agreed)"#, &state);

    let patches = update(&mut tree, &mut deps, &ir, &json!({"agreed": true}));
    let blocks = set_semantics(&patches);
    assert_eq!(blocks.len(), 1, "got {patches:?}");
    let block = blocks[0].as_ref().unwrap();
    assert_eq!(block.checked, Some(true));
    assert_eq!(block.name.as_deref(), Some("Accept"));
}

#[test]
fn set_semantics_serializes_with_camel_case_tag() {
    let state = json!({"label": "Save"});
    let (mut tree, mut deps, ir, _) = setup(r#"Button("@{state.label}")"#, &state);

    let patches = update(&mut tree, &mut deps, &ir, &json!({"label": "Go"}));
    let patch = patches
        .iter()
        .find(|p| matches!(p, Patch::SetSemantics { .. }))
        .expect("SetSemantics emitted");
    let json = serde_json::to_string(patch).unwrap();
    assert!(json.contains(r#""type":"setSemantics""#), "got: {json}");
    assert!(
        json.contains(r#""semantics":{"role":"button","name":"Go"}"#),
        "got: {json}"
    );
}

#[test]
fn bound_activedescendant_re_emits_on_change() {
    // The roving-focus pointer of composite widgets: arrowing through
    // options moves `aria-activedescendant` between option ids — the
    // canonical *reactive* id reference from the relationships design.
    let state = json!({"focused": "opt-1"});
    let (mut tree, mut deps, ir, initial) = setup(
        r#"Column {}.role("list").activedescendant(@state.focused)"#,
        &state,
    );

    let create_sem = initial
        .iter()
        .find_map(|p| match p {
            Patch::Create { semantics, .. } => semantics.clone(),
            _ => None,
        })
        .expect("Column with .role carries semantics");
    assert_eq!(create_sem.active_descendant.as_deref(), Some("opt-1"));

    let patches = update(&mut tree, &mut deps, &ir, &json!({"focused": "opt-2"}));
    let blocks = set_semantics(&patches);
    assert_eq!(blocks.len(), 1, "got {patches:?}");
    assert_eq!(
        blocks[0].as_ref().unwrap().active_descendant.as_deref(),
        Some("opt-2")
    );

    // Same value again → no re-emit.
    let patches = update(&mut tree, &mut deps, &ir, &json!({"focused": "opt-2"}));
    assert!(set_semantics(&patches).is_empty(), "got {patches:?}");
}

#[test]
fn foreach_items_mint_ids_from_item_data() {
    // The "auto-minted option ids" case from the relationships design: each
    // ForEach-generated option derives a stable id from the author's own
    // item data via a templated `.id(...)`, so `aria-activedescendant` has
    // real targets to point at. No engine-synthesised magic ids.
    let state = json!({
        "options": [
            {"id": "apple", "label": "Apple"},
            {"id": "pear",  "label": "Pear"}
        ],
        "focused": "opt-apple"
    });
    let src = r#"Column {
        ForEach(items: @state.options) {
            Text("@{item.label}").role("option").id("opt-@{item.id}")
        }
    }.role("listbox").activedescendant(@state.focused)"#;

    let (_tree, _deps, _ir, patches) = setup(src, &state);

    // Both options carry resolved per-item ids on their Create blocks.
    let option_ids: Vec<String> = patches
        .iter()
        .filter_map(|p| match p {
            Patch::Create { semantics: Some(s), .. } if s.role == Some(hypen_engine::ir::Role::OptionItem) => {
                s.id.clone()
            }
            _ => None,
        })
        .collect();
    assert_eq!(option_ids, vec!["opt-apple".to_string(), "opt-pear".to_string()]);

    // The container resolved its bound activedescendant.
    let listbox = patches
        .iter()
        .find_map(|p| match p {
            Patch::Create { semantics: Some(s), .. }
                if s.role == Some(hypen_engine::ir::Role::Listbox) =>
            {
                Some(s.clone())
            }
            _ => None,
        })
        .expect("listbox container");
    assert_eq!(listbox.active_descendant.as_deref(), Some("opt-apple"));
}

#[test]
fn name_reverting_to_original_re_emits() {
    let state = json!({"label": "Save"});
    let (mut tree, mut deps, ir, _) = setup(r#"Button("@{state.label}")"#, &state);

    update(&mut tree, &mut deps, &ir, &json!({"label": "Submit"}));
    let patches = update(&mut tree, &mut deps, &ir, &json!({"label": "Save"}));
    let blocks = set_semantics(&patches);
    assert_eq!(blocks.len(), 1, "revert must re-emit, got {patches:?}");
    assert_eq!(blocks[0].as_ref().unwrap().name.as_deref(), Some("Save"));
}
