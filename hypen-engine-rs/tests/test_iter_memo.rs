//! Tests for the iterable-child memo bail-out.
//!
//! Keyed reconciliation stamps each list child with the `(item, templates)`
//! pair it last rendered, and skips substitution + subtree reconcile when a
//! keyed match presents the identical pair. These tests pin down the three
//! behaviors that matter: unchanged items emit nothing, changed items still
//! update, and a changed *template* (the nested-ForEach case, where outer
//! substitution is baked into the inner templates) defeats the memo even
//! when the inner item is unchanged.

use hypen_engine::{
    ir::{Element, IRNode, Value},
    lifecycle::{Module, ModuleInstance},
    reactive::{Binding, DependencyGraph, Scheduler},
    reconcile::{reconcile_ir, InstanceTree, Patch},
    render::render_dirty_nodes_with_deps,
};
use serde_json::json;

fn item_text_element(path: &str) -> Element {
    let parts: Vec<String> = path.split('.').map(|s| s.to_string()).collect();
    let mut element = Element::new("Text");
    element
        .props
        .insert("0".to_string(), Value::Binding(Binding::item(parts)));
    element
}

fn rows_list() -> Element {
    let mut list = Element::new("List");
    list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    list.ir_children
        .push(IRNode::Element(item_text_element("name")));
    list
}

/// Render `initial`, swap the state to `next`, dirty the list, and return
/// the second render's patches.
fn rerender_patches(initial: serde_json::Value, next: serde_json::Value) -> Vec<Patch> {
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();
    let mut scheduler = Scheduler::new();

    let module = Module::new("TestModule");
    let mut instance = ModuleInstance::new(module, initial);

    reconcile_ir(
        &mut tree,
        &IRNode::Element(rows_list()),
        None,
        instance.get_state(),
        &mut dependencies,
    );
    let list_node_id = tree.root().expect("Should have root");

    instance.update_state(next);
    scheduler.mark_dirty(list_node_id);
    render_dirty_nodes_with_deps(
        &mut scheduler,
        &mut tree,
        Some(&instance),
        &mut dependencies,
    )
}

/// A re-render where every item is value-identical must emit no patches at
/// all — the memo bails out before substitution, so no Create/Remove churn
/// and no spurious SetProps.
#[test]
fn identical_items_emit_zero_patches() {
    let items = json!({"items": [
        {"id": 1, "name": "A"},
        {"id": 2, "name": "B"},
        {"id": 3, "name": "C"},
    ]});
    let patches = rerender_patches(items.clone(), items);
    assert!(
        patches.is_empty(),
        "identical items must reconcile to nothing, got: {:?}",
        patches
    );
}

/// Changing one item's content must still update exactly that child; the
/// other children memo out.
#[test]
fn changed_item_still_updates() {
    let before = json!({"items": [
        {"id": 1, "name": "A"},
        {"id": 2, "name": "B"},
    ]});
    let after = json!({"items": [
        {"id": 1, "name": "A"},
        {"id": 2, "name": "B2"},
    ]});
    let patches = rerender_patches(before, after);
    assert!(
        !patches.is_empty(),
        "the changed row must produce an update"
    );
    // The changed row's Text content must appear in some patch; the
    // unchanged row must not be re-created or removed.
    let has_new_value = patches.iter().any(|p| match p {
        Patch::SetProp { value, .. } => value == &json!("B2"),
        Patch::Create { props, .. } => props.values().any(|v| v == &json!("B2")),
        _ => false,
    });
    assert!(
        has_new_value,
        "expected a patch carrying \"B2\", got: {:?}",
        patches
    );
    let structural = patches
        .iter()
        .filter(|p| matches!(p, Patch::Create { .. } | Patch::Remove { .. }))
        .count();
    assert_eq!(
        structural, 0,
        "a content-only change must not create/remove nodes, got: {:?}",
        patches
    );
}

/// Reordering value-identical items must emit moves (structure) but no
/// per-item re-render churn.
#[test]
fn reorder_emits_moves_only() {
    let before = json!({"items": [
        {"id": 1, "name": "A"},
        {"id": 2, "name": "B"},
        {"id": 3, "name": "C"},
    ]});
    let after = json!({"items": [
        {"id": 3, "name": "C"},
        {"id": 2, "name": "B"},
        {"id": 1, "name": "A"},
    ]});
    let patches = rerender_patches(before, after);
    assert!(
        patches.iter().all(|p| matches!(p, Patch::Move { .. })),
        "a pure reorder must emit only Move patches, got: {:?}",
        patches
    );
    assert!(!patches.is_empty(), "a reorder must emit Move patches");
}

/// The template-fingerprint hazard, isolated: reconcile the SAME items
/// against a CHANGED per-item template. This is the shape nested ForEach
/// produces — outer substitution bakes outer item values into the inner
/// templates, so an outer change arrives here as "identical inner items,
/// different templates". An item-only memo would wrongly bail out; the
/// fingerprint must force a re-render.
#[test]
fn changed_template_defeats_memo() {
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let state = json!({"items": [
        {"id": 1, "name": "A"},
        {"id": 2, "name": "B"},
    ]});
    let module = Module::new("TestModule");
    let instance = ModuleInstance::new(module, state);

    // First render: leaf shows @{item.name}.
    reconcile_ir(
        &mut tree,
        &IRNode::Element(rows_list()),
        None,
        instance.get_state(),
        &mut dependencies,
    );

    // Same items, but the leaf template now renders a static marker — as if
    // an outer loop's substitution changed the inner template's content.
    let mut changed_leaf = Element::new("Text");
    changed_leaf
        .props
        .insert("0".to_string(), Value::Static(json!("MARKER")));
    let mut changed_list = Element::new("List");
    changed_list.props.insert(
        "0".to_string(),
        Value::Binding(Binding::state(vec!["items".to_string()])),
    );
    changed_list.ir_children.push(IRNode::Element(changed_leaf));

    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(changed_list),
        None,
        instance.get_state(),
        &mut dependencies,
    );

    let marker_count = patches
        .iter()
        .filter(|p| match p {
            Patch::SetProp { value, .. } => value == &json!("MARKER"),
            Patch::Create { props, .. } => props.values().any(|v| v == &json!("MARKER")),
            _ => false,
        })
        .count();
    assert_eq!(
        marker_count, 2,
        "identical items under a changed template must re-render BOTH \
         children — the fingerprint must defeat the item memo; got: {:?}",
        patches
    );
}

/// Same items AND same template presented via a fresh reconcile (not the
/// dirty-list path) must also bail out to nothing.
#[test]
fn identical_reconcile_via_public_api_is_empty() {
    let mut tree = InstanceTree::new();
    let mut dependencies = DependencyGraph::new();

    let state = json!({"items": [
        {"id": 1, "name": "A"},
        {"id": 2, "name": "B"},
    ]});
    let module = Module::new("TestModule");
    let instance = ModuleInstance::new(module, state);

    reconcile_ir(
        &mut tree,
        &IRNode::Element(rows_list()),
        None,
        instance.get_state(),
        &mut dependencies,
    );
    let patches = reconcile_ir(
        &mut tree,
        &IRNode::Element(rows_list()),
        None,
        instance.get_state(),
        &mut dependencies,
    );
    let child_churn = patches
        .iter()
        .filter(|p| !matches!(p, Patch::SetProp { .. } | Patch::RemoveProp { .. }))
        .count();
    assert_eq!(
        child_churn, 0,
        "re-reconciling an identical list must not create/remove/move \
         children, got: {:?}",
        patches
    );
}
