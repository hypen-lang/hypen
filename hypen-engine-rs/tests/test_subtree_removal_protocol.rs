//! Regression tests pinning the **subtree-removal wire contract** that
//! `reconcile::diff::emit_subtree_removal` implements.
//!
//! Two rules, and they pull in opposite directions — hence a dedicated file:
//!
//! 1. **Non-animated removal is root-only.** A subtree that leaves without an
//!    `"__anim.exit"` spec on its root produces exactly ONE `Patch::Remove`,
//!    naming the subtree root. Descendants get no Removes of their own; the
//!    renderer sweeps them (the DOM renderer's `sweepDetachedDescendants`
//!    exists for precisely this, and the keyed / ForEach-rebuild teardown
//!    paths have always emitted root-only Removes). Regressing this to
//!    per-descendant Removes puts ~17k patches on the wire to clear a
//!    1,000-row list.
//!
//! 2. **Animated removal keeps every descendant Remove, root FIRST.** When
//!    the removal root carries `"__anim.exit"`, the renderer may defer the
//!    root's teardown to play the exit — so it must be told, up front, that
//!    the subtree is going, and then which descendants go with it. The
//!    flagged root Remove is emitted before any descendant Remove, and every
//!    descendant is plain regardless of its own exit spec (parent-remove-wins).
//!
//! Rule 2 is the reason rule 1 cannot simply be applied everywhere.

mod common;

use common::{column_with_children, row_with_children, text_element};
use hypen_engine::ir::{Element, IRNode, NodeId, Value};
use hypen_engine::reactive::DependencyGraph;
use hypen_engine::reconcile::patch::node_id_str;
use hypen_engine::reconcile::{reconcile_ir, InstanceTree, Patch};
use serde_json::json;

/// A `Row` carrying an exit spec in the same lowered form `ir::anim` produces.
fn exiting_row(children: Vec<Element>) -> Element {
    let mut row = Element::new("Row").with_prop(
        "__anim.exit",
        Value::Static(json!({"presets": ["fade"], "duration": 150, "curve": "easeIn"})),
    );
    for child in children {
        row = row.with_child(child);
    }
    row
}

/// `(id, transition)` of a patch that must be a `Remove`.
fn expect_remove(patch: &Patch) -> (&str, bool) {
    match patch {
        Patch::Remove { id, transition } => (id.as_ref(), *transition),
        other => panic!("expected Remove, got {other:?}"),
    }
}

fn removes(patches: &[Patch]) -> Vec<(&str, bool)> {
    patches
        .iter()
        .filter(|p| matches!(p, Patch::Remove { .. }))
        .map(expect_remove)
        .collect()
}

/// Render `initial`, then reconcile to `updated`, returning the update's
/// patches plus the NodeIds captured from the initial tree by `capture`.
fn render_then_update<T>(
    initial: Element,
    updated: Element,
    capture: impl Fn(&InstanceTree) -> T,
) -> (Vec<Patch>, T) {
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let state = json!({});

    reconcile_ir(
        &mut tree,
        &IRNode::Element(initial),
        None,
        &state,
        &mut dependencies,
    );
    let captured = capture(&tree);

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(updated),
        None,
        &state,
        &mut dependencies,
    );
    (patches, captured)
}

/// Walk to `root -> children[idx] -> children[..]`.
fn child_at(tree: &InstanceTree, parent: NodeId, idx: usize) -> NodeId {
    *tree
        .get(parent)
        .expect("parent node")
        .children
        .get(idx)
        .expect("child at index")
}

// ============================================================================
// Rule 1 — non-animated removal is root-only
// ============================================================================

#[test]
fn plain_subtree_removal_emits_only_the_root_remove() {
    // GIVEN: Column { Text("keep"), Row { Text("a"), Text("b") } }, no
    // animation props anywhere.
    let initial = column_with_children(vec![
        text_element("keep"),
        row_with_children(vec![text_element("a"), text_element("b")]),
    ]);
    // WHEN: the Row subtree leaves.
    let updated = column_with_children(vec![text_element("keep")]);

    let (patches, (row_id, a_id, b_id)) = render_then_update(initial, updated, |tree| {
        let root = tree.root().expect("root");
        let row = child_at(tree, root, 1);
        (row, child_at(tree, row, 0), child_at(tree, row, 1))
    });

    // THEN: exactly one Remove, naming the subtree ROOT.
    assert_eq!(
        removes(&patches),
        vec![(node_id_str(row_id).as_ref(), false)],
        "a plain subtree removal is one root Remove: {patches:?}"
    );

    // AND: neither descendant is mentioned anywhere on the wire.
    for (label, id) in [("a", a_id), ("b", b_id)] {
        let id_str = node_id_str(id);
        assert!(
            !patches
                .iter()
                .any(|p| matches!(p, Patch::Remove { id, .. } if id == &id_str)),
            "descendant {label} ({id_str}) must not get a Remove of its own: {patches:?}"
        );
    }

    // AND: the serialized form is byte-compatible with the pre-flag protocol.
    let wire = serde_json::to_string(&patches).expect("serialize");
    assert!(
        !wire.contains("transition"),
        "non-animated removals must carry no transition field: {wire}"
    );
}

#[test]
fn plain_removal_stays_root_only_for_a_deep_subtree() {
    // GIVEN: a 4-level-deep subtree — the patch count must track the number
    // of removal ROOTS, never the node count.
    let deep = row_with_children(vec![column_with_children(vec![row_with_children(vec![
        text_element("leaf-1"),
        text_element("leaf-2"),
    ])])]);
    let initial = column_with_children(vec![text_element("keep"), deep]);
    let updated = column_with_children(vec![text_element("keep")]);

    let (patches, doomed_root) = render_then_update(initial, updated, |tree| {
        let root = tree.root().expect("root");
        child_at(tree, root, 1)
    });

    assert_eq!(
        removes(&patches),
        vec![(node_id_str(doomed_root).as_ref(), false)],
        "removal patch count must not scale with subtree depth/size: {patches:?}"
    );
}

// ============================================================================
// Rule 2 — animated removal: flagged root FIRST, then plain descendants
// ============================================================================

#[test]
fn animated_subtree_removal_emits_flagged_root_first_then_descendants() {
    // GIVEN: Column { Text("keep"), Row.exit { Text("a"), Text("b") } }
    let initial = column_with_children(vec![
        text_element("keep"),
        exiting_row(vec![text_element("a"), text_element("b")]),
    ]);
    // WHEN: the exiting Row leaves.
    let updated = column_with_children(vec![text_element("keep")]);

    let (patches, (row_id, a_id, b_id)) = render_then_update(initial, updated, |tree| {
        let root = tree.root().expect("root");
        let row = child_at(tree, root, 1);
        (row, child_at(tree, row, 0), child_at(tree, row, 1))
    });

    // THEN: the flagged root comes FIRST, then both descendants as PLAIN
    // Removes — the renderer must learn the subtree is exiting before any
    // descendant teardown arrives.
    let seen = removes(&patches);
    assert_eq!(
        seen[0],
        (node_id_str(row_id).as_ref(), true),
        "flagged root Remove must be first: {patches:?}"
    );
    let tail: Vec<&str> = seen[1..]
        .iter()
        .map(|(id, transition)| {
            assert!(!transition, "descendant Removes are always plain: {seen:?}");
            *id
        })
        .collect();
    assert_eq!(
        tail.len(),
        2,
        "both descendants keep their own Remove on the animated path: {patches:?}"
    );
    for id in [a_id, b_id] {
        assert!(
            tail.contains(&node_id_str(id).as_ref()),
            "descendant {} missing from the animated teardown: {patches:?}",
            node_id_str(id)
        );
    }
}

#[test]
fn exit_spec_on_a_descendant_never_flags_anything() {
    // GIVEN: Column { Text("keep"), Row { Text.exit } } — ONLY the child
    // carries an exit spec; the removal root (Row) does not.
    let exiting_text = Element::new("Text")
        .with_prop("text", Value::Static(json!("inner")))
        .with_prop(
            "__anim.exit",
            Value::Static(json!({"presets": ["fade"], "duration": 150, "curve": "easeIn"})),
        );
    let initial = column_with_children(vec![
        text_element("keep"),
        Element::new("Row").with_child(exiting_text),
    ]);
    let updated = column_with_children(vec![text_element("keep")]);

    let (patches, row_id) = render_then_update(initial, updated, |tree| {
        let root = tree.root().expect("root");
        child_at(tree, root, 1)
    });

    // THEN: parent-remove-wins. Only the removal root is consulted for an
    // exit spec, so nothing is flagged — which means this is an ordinary
    // non-animated removal and collapses to the single root Remove.
    assert_eq!(
        removes(&patches),
        vec![(node_id_str(row_id).as_ref(), false)],
        "a descendant's exit spec must not animate (or expand) the teardown: {patches:?}"
    );
}
