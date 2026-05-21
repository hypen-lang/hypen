//! AccessKit translation: turn a [`LayoutPass`] into a `TreeUpdate`
//! that platform adapters (NVDA on Windows, VoiceOver on macOS, Orca on
//! Linux via AT-SPI) consume.
//!
//! Mapping:
//!
//! - The synthetic root node is a `Window`, with all top-level layout
//!   items as its children.
//! - `Text` items become `StaticText` nodes whose `value` carries the
//!   string.
//! - `Button`-like items (anything in `ACTIONABLE_TYPES`) become
//!   `Button` nodes that announce their first descendant `Text` as the
//!   accessible label and support `Action::Click` so screen readers can
//!   trigger the underlying engine action.
//! - Other elements fall back to `GenericContainer`.
//!
//! Coordinates are physical pixels matching the painter's frame buffer.
//!
//! ## Stable IDs
//!
//! AccessKit needs `u64` node ids; the renderer uses `String`. We hash
//! the renderer node id once per build with `DefaultHasher`. Identifiers
//! that the engine assigns are stable for the lifetime of the node, so
//! the hash is stable too — a screen reader observing focus changes
//! sees the same id across redraws.

use crate::layout::{ItemKind, LayoutItem, LayoutPass};
use accesskit::{Action, Node, NodeId, Rect as AkRect, Role, Tree, TreeId, TreeUpdate};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// AccessKit id for the synthetic window root. Hash-collision-proof
/// because no renderer node id is allowed to be the literal string
/// `"__hypen_root__"` (renderer node ids come from the engine and are
/// unique strings, never starting with a double underscore).
pub const ROOT_NODE_ID: NodeId = NodeId(0);

/// Hash a renderer node id (`String`) into a stable AccessKit `NodeId`.
/// Collisions with [`ROOT_NODE_ID`] are reserved by adding `1` so the
/// root never aliases a real node.
pub fn ak_node_id(renderer_id: &str) -> NodeId {
    let mut h = DefaultHasher::new();
    renderer_id.hash(&mut h);
    let raw = h.finish();
    if raw == ROOT_NODE_ID.0 {
        NodeId(1)
    } else {
        NodeId(raw)
    }
}

/// Given the AccessKit node id of an actionable element, walk
/// `pass.items` and return the renderer string id (so we can route
/// the click to the SDK module). Returns `None` if no actionable
/// hashes to `target`.
pub fn renderer_id_for(pass: &LayoutPass, target: NodeId) -> Option<String> {
    pass.actionables()
        .find(|it| ak_node_id(&it.node_id) == target)
        .map(|it| it.node_id.clone())
}

/// Build a `TreeUpdate` that fully describes `pass` to the OS
/// accessibility layer. We send the entire tree on every update —
/// the renderer doesn't track per-frame deltas and AccessKit accepts
/// full updates without complaint.
pub fn tree_update_for_layout(pass: &LayoutPass) -> TreeUpdate {
    let mut nodes: Vec<(NodeId, Node)> = Vec::with_capacity(pass.items.len() + 1);

    // First pass: emit a node for every layout item, recording its
    // AccessKit id alongside the original renderer id so the second
    // pass can build the parent's children list.
    let mut item_ak_ids: Vec<(NodeId, &LayoutItem)> = Vec::with_capacity(pass.items.len());
    for item in &pass.items {
        let id = ak_node_id(&item.node_id);
        let mut node = build_node_for(item, pass);
        node.set_bounds(item_rect(item));
        item_ak_ids.push((id, item));
        nodes.push((id, node));
    }

    // Root window node — every top-level item is a direct child here.
    // Phase 6 doesn't model containment depth in AccessKit; the engine
    // already collapses the visible structure into a flat list, and
    // screen readers happily linearise that.
    let mut root = Node::new(Role::Window);
    let children: Vec<NodeId> = item_ak_ids.iter().map(|(id, _)| *id).collect();
    root.set_children(children);
    nodes.push((ROOT_NODE_ID, root));

    TreeUpdate {
        nodes,
        tree: Some(Tree::new(ROOT_NODE_ID)),
        tree_id: TreeId::ROOT,
        focus: ROOT_NODE_ID,
    }
}

fn build_node_for(item: &LayoutItem, pass: &LayoutPass) -> Node {
    match &item.kind {
        ItemKind::Text { content, .. } => {
            let mut node = Node::new(Role::Label);
            node.set_value(content.clone());
            node.set_label(content.clone());
            node
        }
        ItemKind::Button => {
            let mut node = Node::new(Role::Button);
            // The accessible label is the first Text descendant —
            // works for `Button("@actions.X") { Text("Save") }` etc.
            // Without one we fall back to the action name.
            let label = first_descendant_text(item, pass)
                .unwrap_or_else(|| item.action.clone().unwrap_or_default());
            node.set_label(label);
            // Click is the standard "default action" — screen readers
            // map Enter / Space / VoiceOver gestures to it, and our
            // window adapter routes the resulting ActionRequest to
            // `module.dispatch_action(...)`.
            node.add_action(Action::Click);
            node
        }
        ItemKind::Container => Node::new(Role::GenericContainer),
        ItemKind::Input {
            value, placeholder, ..
        } => {
            let mut node = Node::new(Role::TextInput);
            node.set_value(value.clone());
            // Surface either the placeholder ("Email…") or the bind
            // path as the accessible label; without it screen readers
            // announce the field as anonymous.
            if let Some(p) = placeholder {
                node.set_label(p.clone());
            }
            node
        }
    }
}

/// Find the first `Text` item that paints inside `parent`'s rect. Used
/// to synthesise an accessible label for actionable elements that wrap
/// their visible label in `Text`.
fn first_descendant_text(parent: &LayoutItem, pass: &LayoutPass) -> Option<String> {
    pass.items.iter().find_map(|other| {
        if std::ptr::eq(other, parent) {
            return None;
        }
        match &other.kind {
            ItemKind::Text { content, .. } if rect_contains_rect(&parent.rect, &other.rect) => {
                Some(content.clone())
            }
            _ => None,
        }
    })
}

fn rect_contains_rect(outer: &crate::layout::Rect, inner: &crate::layout::Rect) -> bool {
    inner.x >= outer.x
        && inner.y >= outer.y
        && inner.x + inner.w <= outer.x + outer.w + 0.5
        && inner.y + inner.h <= outer.y + outer.h + 0.5
}

fn item_rect(item: &LayoutItem) -> AkRect {
    AkRect::new(
        item.rect.x as f64,
        item.rect.y as f64,
        (item.rect.x + item.rect.w) as f64,
        (item.rect.y + item.rect.h) as f64,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::LayoutPass;
    use crate::text::TextEngine;
    use crate::tree::{Tree, ROOT_ID};
    use hypen_engine::Patch;
    use indexmap::IndexMap;
    use serde_json::{json, Value};
    use std::sync::Arc;

    fn props(entries: &[(&str, Value)]) -> Arc<IndexMap<String, Value>> {
        let mut map = IndexMap::new();
        for (k, v) in entries {
            map.insert((*k).to_string(), v.clone());
        }
        Arc::new(map)
    }

    fn create(id: &str, et: &str, p: &[(&str, Value)]) -> Patch {
        Patch::Create {
            id: id.into(),
            element_type: et.into(),
            props: props(p),
        }
    }

    fn insert(parent: &str, id: &str) -> Patch {
        Patch::Insert {
            parent_id: parent.into(),
            id: id.into(),
            before_id: None,
        }
    }

    fn build_pass(builder: impl FnOnce(&mut Tree)) -> LayoutPass {
        let mut tree = Tree::new();
        builder(&mut tree);
        let mut text = TextEngine::new();
        LayoutPass::compute(&tree, &mut text, (800, 600), 1.0)
    }

    #[test]
    fn ak_node_id_is_stable_for_same_input() {
        assert_eq!(ak_node_id("button-1"), ak_node_id("button-1"));
        assert_ne!(ak_node_id("button-1"), ak_node_id("button-2"));
    }

    #[test]
    fn root_node_id_never_aliases_real_node() {
        // Root id is 0 and our hash of "" or anything else gets bumped
        // to 1 on collision — verify the bump happens for the input
        // that hashes to 0 (we can't easily produce one, but the bump
        // path itself is testable: just check no real id ever maps to 0).
        for s in ["a", "b", "btn", "Hypen Desktop", ""] {
            assert_ne!(
                ak_node_id(s),
                ROOT_NODE_ID,
                "renderer id `{s}` must not alias the synthetic root",
            );
        }
    }

    #[test]
    fn tree_update_includes_root_with_all_top_level_children() {
        let pass = build_pass(|t| {
            t.apply(&create("a", "Text", &[("0", json!("alpha"))]));
            t.apply(&insert(ROOT_ID, "a"));
            t.apply(&create("b", "Text", &[("0", json!("beta"))]));
            t.apply(&insert(ROOT_ID, "b"));
        });

        let update = tree_update_for_layout(&pass);
        let root = update
            .nodes
            .iter()
            .find(|(id, _)| *id == ROOT_NODE_ID)
            .map(|(_, n)| n)
            .expect("root node");
        assert_eq!(root.role(), Role::Window);
        assert_eq!(root.children().len(), pass.items.len());
    }

    #[test]
    fn button_node_has_role_button_and_click_action() {
        let pass = build_pass(|t| {
            t.apply(&create("btn", "Button", &[("action", json!("@actions.save"))]));
            t.apply(&insert(ROOT_ID, "btn"));
            t.apply(&create("lbl", "Text", &[("0", json!("Save"))]));
            t.apply(&insert("btn", "lbl"));
        });

        let update = tree_update_for_layout(&pass);
        let btn = update
            .nodes
            .iter()
            .find(|(id, _)| *id == ak_node_id("btn"))
            .map(|(_, n)| n)
            .expect("button node");
        assert_eq!(btn.role(), Role::Button);
        assert!(btn.supports_action(Action::Click));
    }

    #[test]
    fn button_label_is_first_descendant_text() {
        let pass = build_pass(|t| {
            t.apply(&create(
                "btn",
                "Button",
                &[("action", json!("@actions.save"))],
            ));
            t.apply(&insert(ROOT_ID, "btn"));
            t.apply(&create("lbl", "Text", &[("0", json!("Save changes"))]));
            t.apply(&insert("btn", "lbl"));
        });

        let update = tree_update_for_layout(&pass);
        let btn = update
            .nodes
            .iter()
            .find(|(id, _)| *id == ak_node_id("btn"))
            .map(|(_, n)| n)
            .expect("button node");
        assert_eq!(btn.label(), Some("Save changes"));
    }

    #[test]
    fn button_label_falls_back_to_action_name_when_no_text_child() {
        let pass = build_pass(|t| {
            t.apply(&create(
                "btn",
                "Button",
                &[("action", json!("@actions.purge"))],
            ));
            t.apply(&insert(ROOT_ID, "btn"));
        });

        let update = tree_update_for_layout(&pass);
        let btn = update
            .nodes
            .iter()
            .find(|(id, _)| *id == ak_node_id("btn"))
            .map(|(_, n)| n)
            .expect("button node");
        assert_eq!(btn.label(), Some("purge"));
    }

    #[test]
    fn text_node_carries_value_and_label() {
        let pass = build_pass(|t| {
            t.apply(&create("hi", "Text", &[("0", json!("Hello"))]));
            t.apply(&insert(ROOT_ID, "hi"));
        });

        let update = tree_update_for_layout(&pass);
        let txt = update
            .nodes
            .iter()
            .find(|(id, _)| *id == ak_node_id("hi"))
            .map(|(_, n)| n)
            .expect("text node");
        assert_eq!(txt.role(), Role::Label);
        assert_eq!(txt.value(), Some("Hello"));
        assert_eq!(txt.label(), Some("Hello"));
    }

    #[test]
    fn renderer_id_for_round_trips_button_id() {
        let pass = build_pass(|t| {
            t.apply(&create(
                "increment",
                "Button",
                &[("action", json!("@actions.inc"))],
            ));
            t.apply(&insert(ROOT_ID, "increment"));
        });
        let target = ak_node_id("increment");
        assert_eq!(renderer_id_for(&pass, target).as_deref(), Some("increment"));
    }

    #[test]
    fn renderer_id_for_returns_none_for_text_only_layouts() {
        let pass = build_pass(|t| {
            t.apply(&create("hi", "Text", &[("0", json!("Hello"))]));
            t.apply(&insert(ROOT_ID, "hi"));
        });
        // Text nodes are NOT actionable, so even if their id hashes
        // to a known NodeId they shouldn't be treated as a click target.
        assert_eq!(renderer_id_for(&pass, ak_node_id("hi")), None);
    }
}
