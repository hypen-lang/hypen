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
//! - When the engine attached a semantics block with a role (structural
//!   like `Heading`, or author opt-in like `.role("tab")`), that role
//!   overrides the structural mapping above; actions are unaffected.
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

    // Author-declared id (`.id("panel-1")`) → AccessKit NodeId, for the
    // cross-node relationships (`controls`/`describedby`/`labelledby`/
    // `owns`/`activeDescendant`). Rebuilt from the live pass on every
    // update, so — unlike a persistent registry — it cannot go stale across
    // reconcile / Router detach-attach / keyed reorder, and it only ever
    // resolves to nodes that exist in *this* TreeUpdate (a reference to an
    // off-screen target is dropped rather than dangling).
    let author_ids: std::collections::HashMap<&str, NodeId> = pass
        .items
        .iter()
        .filter_map(|it| {
            pass.a11y
                .get(&it.node_id)
                .and_then(|s| s.id.as_deref())
                .map(|author_id| (author_id, ak_node_id(&it.node_id)))
        })
        .collect();

    // First pass: emit a node for every layout item, recording its
    // AccessKit id alongside the original renderer id so the second
    // pass can build the parent's children list.
    let mut item_ak_ids: Vec<(NodeId, &LayoutItem)> = Vec::with_capacity(pass.items.len());
    for item in &pass.items {
        let id = ak_node_id(&item.node_id);
        let mut node = build_node_for(item, pass, &author_ids);
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

/// Map an engine semantic role ([`hypen_engine::ir::Role`]) to its AccessKit
/// counterpart. Every current engine role has a faithful AccessKit 0.24
/// variant, so the match is total; keeping it exhaustive (no `_` arm) means a
/// new engine role fails compilation here instead of silently falling back to
/// the structural role.
fn ak_role(role: hypen_engine::ir::Role) -> Role {
    use hypen_engine::ir::Role as SemRole;
    match role {
        SemRole::Button => Role::Button,
        SemRole::Link => Role::Link,
        SemRole::Paragraph => Role::Paragraph,
        SemRole::Heading => Role::Heading,
        SemRole::Img => Role::Image,
        // The engine's `Textbox` covers single- and multi-line inputs but
        // doesn't say which; `TextInput` matches the structural `Input`
        // mapping, and AccessKit treats multiline-ness as a refinement.
        SemRole::Textbox => Role::TextInput,
        SemRole::Checkbox => Role::CheckBox,
        SemRole::Switch => Role::Switch,
        SemRole::Listbox => Role::ListBox,
        SemRole::Slider => Role::Slider,
        SemRole::Progressbar => Role::ProgressIndicator,
        SemRole::Status => Role::Status,
        SemRole::Navigation => Role::Navigation,
        SemRole::Main => Role::Main,
        SemRole::Region => Role::Region,
        SemRole::Search => Role::Search,
        SemRole::Banner => Role::Banner,
        SemRole::Contentinfo => Role::ContentInfo,
        SemRole::Complementary => Role::Complementary,
        SemRole::List => Role::List,
        SemRole::Listitem => Role::ListItem,
        SemRole::Dialog => Role::Dialog,
        SemRole::Tablist => Role::TabList,
        SemRole::Tab => Role::Tab,
        SemRole::Tabpanel => Role::TabPanel,
        SemRole::OptionItem => Role::ListBoxOption,
        SemRole::Combobox => Role::ComboBox,
    }
}

fn build_node_for(
    item: &LayoutItem,
    pass: &LayoutPass,
    author_ids: &std::collections::HashMap<&str, NodeId>,
) -> Node {
    let mut node = match &item.kind {
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
        ItemKind::Image { src, .. } => {
            let mut node = Node::new(Role::Image);
            // Without a real `alt` prop the best we can do is the
            // file name (or src tail) so screen readers say something
            // more useful than "image". The web SDK reads `alt`; when
            // we expose it through the engine this fallback narrows.
            if let Some(s) = src.as_deref() {
                let label = s
                    .rsplit('/')
                    .next()
                    .filter(|t| !t.is_empty())
                    .unwrap_or(s)
                    .to_string();
                node.set_label(label);
            }
            node
        }
        ItemKind::Icon { .. } => {
            // Icons are decorative-by-default; AccessKit gets a bare
            // Image role so screen readers don't announce them
            // unless the host explicitly surfaces `aria-label`
            // through the engine (Phase 16+).
            Node::new(Role::Image)
        }
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
    };

    // Prefer the engine-derived accessibility semantics over the layout
    // heuristics above: the accessible name handles `.label(...)`, icon
    // exclusion, image `alt`, and bound/templated text that the structural
    // fallbacks can't see. `.description(...)` becomes a supplementary
    // AccessKit description.
    if let Some(sem) = pass.a11y.get(&item.node_id) {
        // The engine role (structural like Heading/Checkbox, or author opt-in
        // like `.role("tab")` / `.landmark("navigation")`) is more specific
        // than the ItemKind heuristic, so it wins. Overriding the role leaves
        // the node's actions intact — a Button keeps its Click action.
        if let Some(role) = sem.role {
            node.set_role(ak_role(role));
        }
        if let Some(name) = sem.name.as_deref() {
            node.set_label(name);
        }
        if let Some(desc) = sem.description.as_deref() {
            node.set_description(desc);
        }

        // Cross-node relationships: resolve the author-declared target id to
        // the AccessKit NodeId of the item that declared it (`.id(...)`).
        // AccessKit models these natively (unlike SwiftUI's string hints);
        // the OS bridges (UIA/AT-SPI/macOS AX) degrade unevenly, but a
        // resolved relationship is strictly better than none. Unresolvable
        // targets (off-screen, undeclared) are dropped — a dangling AccessKit
        // NodeId reference would be worse than the missing relationship.
        let resolve = |target: &Option<String>| -> Option<NodeId> {
            target.as_deref().and_then(|t| author_ids.get(t)).copied()
        };
        if let Some(target) = resolve(&sem.controls) {
            node.set_controls(vec![target]);
        }
        if let Some(target) = resolve(&sem.describedby) {
            node.set_described_by(vec![target]);
        }
        if let Some(target) = resolve(&sem.labelledby) {
            node.set_labelled_by(vec![target]);
        }
        if let Some(target) = resolve(&sem.owns) {
            node.set_owns(vec![target]);
        }
        if let Some(target) = resolve(&sem.active_descendant) {
            node.set_active_descendant(target);
        }
    }

    node
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
            semantics: None,
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
            t.apply(&create(
                "btn",
                "Button",
                &[("action", json!("@actions.save"))],
            ));
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
    fn engine_semantic_name_overrides_layout_heuristic_label() {
        use hypen_engine::ir::{Role, Semantics};
        // An icon-only button named via `.label("Delete")`: the layout
        // heuristic (first descendant text) finds nothing and would fall back
        // to the action name, but the engine-derived accessible name wins.
        let sem = Semantics {
            role: Some(Role::Button),
            name: Some("Delete".into()),
            ..Default::default()
        };
        let pass = build_pass(|t| {
            t.apply(&Patch::Create {
                id: "btn".into(),
                element_type: "Button".into(),
                props: props(&[("action", json!("@actions.del"))]),
                semantics: Some(sem),
            });
            t.apply(&insert(ROOT_ID, "btn"));
        });

        let update = tree_update_for_layout(&pass);
        let btn = update
            .nodes
            .iter()
            .find(|(id, _)| *id == ak_node_id("btn"))
            .map(|(_, n)| n)
            .expect("button node");
        assert_eq!(btn.label(), Some("Delete"));
    }

    #[test]
    fn set_semantics_updates_the_accesskit_label_on_the_next_pass() {
        use hypen_engine::ir::{Role, Semantics};
        // Reactive re-emit (Patch::SetSemantics): the renderer Tree swaps in
        // the new block, and the next LayoutPass rebuild feeds it to the
        // AccessKit translation — the stale-name case this patch exists for.
        let named = |name: &str| Semantics {
            role: Some(Role::Button),
            name: Some(name.into()),
            ..Default::default()
        };

        let mut tree = Tree::new();
        tree.apply(&Patch::Create {
            id: "btn".into(),
            element_type: "Button".into(),
            props: props(&[("action", json!("@actions.save"))]),
            semantics: Some(named("Save")),
        });
        tree.apply(&insert(ROOT_ID, "btn"));
        tree.apply(&Patch::SetSemantics {
            id: "btn".into(),
            semantics: Some(named("Submit")),
        });

        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
        let update = tree_update_for_layout(&pass);
        let btn = update
            .nodes
            .iter()
            .find(|(id, _)| *id == ak_node_id("btn"))
            .map(|(_, n)| n)
            .expect("button node");
        assert_eq!(btn.label(), Some("Submit"), "AccessKit must see the re-emitted name");

        // Clearing (semantics: None) drops the engine block; the layout
        // heuristics take over again rather than announcing a stale name.
        tree.apply(&Patch::SetSemantics {
            id: "btn".into(),
            semantics: None,
        });
        assert!(tree.get("btn").unwrap().semantics.is_none());
    }

    #[test]
    fn author_id_relationships_resolve_to_accesskit_node_ids() {
        use hypen_engine::ir::{Role as SemRole, Semantics};

        // A disclosure button controlling a panel: `.controls("panel-1")` on
        // the button, `.id("panel-1")` on the panel. The AccessKit nodes must
        // be linked by NodeId; an unresolvable reference must be dropped.
        let button_sem = Semantics {
            role: Some(SemRole::Button),
            name: Some("Show details".into()),
            controls: Some("panel-1".into()),
            // Dangling on purpose — no element declares this id.
            describedby: Some("nope".into()),
            ..Default::default()
        };
        let panel_sem = Semantics {
            id: Some("panel-1".into()),
            labelledby: Some("btn-1".into()),
            ..Default::default()
        };
        let button_with_id_sem = Semantics {
            id: Some("btn-1".into()),
            ..button_sem.clone()
        };

        let mut tree = Tree::new();
        tree.apply(&Patch::Create {
            id: "btn".into(),
            element_type: "Button".into(),
            props: props(&[("action", json!("@actions.toggle"))]),
            semantics: Some(button_with_id_sem),
        });
        tree.apply(&insert(ROOT_ID, "btn"));
        tree.apply(&Patch::Create {
            id: "panel".into(),
            element_type: "Column".into(),
            props: props(&[]),
            semantics: Some(panel_sem),
        });
        tree.apply(&insert(ROOT_ID, "panel"));

        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
        let update = tree_update_for_layout(&pass);

        let node_of = |rid: &str| {
            update
                .nodes
                .iter()
                .find(|(id, _)| *id == ak_node_id(rid))
                .map(|(_, n)| n)
                .unwrap_or_else(|| panic!("no AccessKit node for {rid}"))
        };

        let btn = node_of("btn");
        assert_eq!(
            btn.controls(),
            &[ak_node_id("panel")],
            "controls must resolve to the panel's AccessKit NodeId"
        );
        assert!(
            btn.described_by().is_empty(),
            "a dangling reference must be dropped, not emitted"
        );

        let panel = node_of("panel");
        assert_eq!(panel.labelled_by(), &[ak_node_id("btn")]);
    }

    #[test]
    fn opt_in_role_on_container_overrides_generic_container() {
        use hypen_engine::ir::{Role as SemRole, Semantics};
        // `.role("tab")` on a plain Column: structurally a GenericContainer,
        // but the author-declared role must reach the AccessKit tree.
        let sem = Semantics {
            role: Some(SemRole::Tab),
            name: Some("Settings".into()),
            ..Default::default()
        };
        let pass = build_pass(|t| {
            t.apply(&Patch::Create {
                id: "tab-1".into(),
                element_type: "Column".into(),
                props: props(&[]),
                semantics: Some(sem),
            });
            t.apply(&insert(ROOT_ID, "tab-1"));
        });

        let update = tree_update_for_layout(&pass);
        let tab = update
            .nodes
            .iter()
            .find(|(id, _)| *id == ak_node_id("tab-1"))
            .map(|(_, n)| n)
            .expect("tab node");
        assert_eq!(tab.role(), Role::Tab);
        assert_eq!(tab.label(), Some("Settings"));
    }

    #[test]
    fn structural_heading_role_reaches_accesskit() {
        use hypen_engine::ir::{Role as SemRole, Semantics};
        // The engine derives `role: heading` for a Heading element; the
        // desktop layout has no Heading ItemKind (it falls into the container
        // path), so without the semantics override this would announce as a
        // generic container.
        let sem = Semantics {
            role: Some(SemRole::Heading),
            name: Some("Billing".into()),
            ..Default::default()
        };
        let pass = build_pass(|t| {
            t.apply(&Patch::Create {
                id: "h1".into(),
                element_type: "Heading".into(),
                props: props(&[]),
                semantics: Some(sem),
            });
            t.apply(&insert(ROOT_ID, "h1"));
        });

        let update = tree_update_for_layout(&pass);
        let heading = update
            .nodes
            .iter()
            .find(|(id, _)| *id == ak_node_id("h1"))
            .map(|(_, n)| n)
            .expect("heading node");
        assert_eq!(heading.role(), Role::Heading);
    }

    #[test]
    fn button_without_engine_role_keeps_structural_button_and_click() {
        use hypen_engine::ir::Semantics;
        // A semantics block that carries a name but no role must not disturb
        // the structural mapping: the ItemKind role stays and the Click
        // action keeps routing to the engine.
        let sem = Semantics {
            name: Some("Delete".into()),
            ..Default::default()
        };
        let pass = build_pass(|t| {
            t.apply(&Patch::Create {
                id: "btn".into(),
                element_type: "Button".into(),
                props: props(&[("action", json!("@actions.del"))]),
                semantics: Some(sem),
            });
            t.apply(&insert(ROOT_ID, "btn"));
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
        assert_eq!(btn.label(), Some("Delete"));
    }

    #[test]
    fn engine_role_override_preserves_button_click_action() {
        use hypen_engine::ir::{Role as SemRole, Semantics};
        // `.role("tab")` on a Button: the announced role changes but the
        // element is still actionable — Click must survive the override.
        let sem = Semantics {
            role: Some(SemRole::Tab),
            name: Some("General".into()),
            ..Default::default()
        };
        let pass = build_pass(|t| {
            t.apply(&Patch::Create {
                id: "btn".into(),
                element_type: "Button".into(),
                props: props(&[("action", json!("@actions.select"))]),
                semantics: Some(sem),
            });
            t.apply(&insert(ROOT_ID, "btn"));
        });

        let update = tree_update_for_layout(&pass);
        let btn = update
            .nodes
            .iter()
            .find(|(id, _)| *id == ak_node_id("btn"))
            .map(|(_, n)| n)
            .expect("button node");
        assert_eq!(btn.role(), Role::Tab);
        assert!(btn.supports_action(Action::Click));
    }

    #[test]
    fn every_engine_role_maps_to_a_distinct_faithful_accesskit_role() {
        use hypen_engine::ir::Role as SemRole;
        // Spot-check the landmark and widget mappings whose AccessKit names
        // differ from the engine spelling — a typo'd variant here would
        // announce the wrong thing to every desktop screen reader.
        for (sem, ak) in [
            (SemRole::Img, Role::Image),
            (SemRole::Textbox, Role::TextInput),
            (SemRole::Checkbox, Role::CheckBox),
            (SemRole::Listbox, Role::ListBox),
            (SemRole::Progressbar, Role::ProgressIndicator),
            (SemRole::Contentinfo, Role::ContentInfo),
            (SemRole::Tablist, Role::TabList),
            (SemRole::Tabpanel, Role::TabPanel),
            (SemRole::OptionItem, Role::ListBoxOption),
            (SemRole::Combobox, Role::ComboBox),
        ] {
            assert_eq!(ak_role(sem), ak, "mapping for {sem:?}");
        }
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
