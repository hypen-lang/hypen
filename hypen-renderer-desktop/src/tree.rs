//! Renderer-side virtual tree.
//!
//! Mirrors the engine's node graph by replaying the [`Patch`] stream the
//! engine emits. Phase 1 supports the structural patches needed to render a
//! single static tree: `Create`, `Insert`, `SetProp`, `RemoveProp`,
//! `Remove`, `Move`. `Detach` / `Attach` (Router cache) and `SetText`
//! (reserved by the engine) are stubbed and will land in a later phase.

use hypen_engine::Patch;
use serde_json::Value;
use std::collections::HashMap;

/// The synthetic parent ID used by the engine for top-level nodes.
pub const ROOT_ID: &str = "root";

/// A flat node in the renderer tree.
#[derive(Debug, Clone)]
pub struct Node {
    pub id: String,
    pub element_type: String,
    pub props: HashMap<String, Value>,
}

impl Node {
    /// Convenience: positional text content lives at prop key `"0"`.
    pub fn text_content(&self) -> Option<&str> {
        self.props.get("0").and_then(Value::as_str)
    }
}

/// Renderer-side mirror of the engine's node graph.
///
/// Cheap to mutate, cheap to walk. Intentionally not thread-safe — owned
/// by the window's event-loop thread.
#[derive(Debug, Default)]
pub struct Tree {
    nodes: HashMap<String, Node>,
    /// `parent_id → ordered child ids`. The synthetic `"root"` parent is
    /// included here.
    children: HashMap<String, Vec<String>>,
}

impl Tree {
    pub fn new() -> Self {
        let mut children = HashMap::new();
        children.insert(ROOT_ID.to_string(), Vec::new());
        Self {
            nodes: HashMap::new(),
            children,
        }
    }

    pub fn root_children(&self) -> &[String] {
        self.children
            .get(ROOT_ID)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn children_of(&self, id: &str) -> &[String] {
        self.children.get(id).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn get(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    /// Apply a single patch.
    ///
    /// Patches that reference unknown nodes are logged and skipped rather
    /// than panicking — the renderer should be forgiving of out-of-order
    /// streams from buggy hosts during development.
    pub fn apply(&mut self, patch: &Patch) {
        match patch {
            Patch::Create {
                id,
                element_type,
                props,
            } => {
                let mut prop_map = HashMap::with_capacity(props.len());
                for (k, v) in props.iter() {
                    prop_map.insert(k.clone(), v.clone());
                }
                self.nodes.insert(
                    id.clone(),
                    Node {
                        id: id.clone(),
                        element_type: element_type.clone(),
                        props: prop_map,
                    },
                );
                self.children.entry(id.clone()).or_default();
            }
            Patch::SetProp { id, name, value } => {
                if let Some(node) = self.nodes.get_mut(id) {
                    node.props.insert(name.clone(), value.clone());
                } else {
                    log::warn!("SetProp on unknown node {id}");
                }
            }
            Patch::RemoveProp { id, name } => {
                if let Some(node) = self.nodes.get_mut(id) {
                    node.props.remove(name);
                }
            }
            Patch::SetText { id, text } => {
                // Reserved by the engine — currently unreachable in production.
                // Emulate by writing prop "0" so renderer behaviour stays
                // consistent if a host emits it.
                if let Some(node) = self.nodes.get_mut(id) {
                    node.props.insert("0".into(), Value::String(text.clone()));
                }
            }
            Patch::Insert {
                parent_id,
                id,
                before_id,
            } => {
                let siblings = self.children.entry(parent_id.clone()).or_default();
                Self::insert_at(siblings, id.clone(), before_id.as_deref());
            }
            Patch::Move {
                parent_id,
                id,
                before_id,
            } => {
                if let Some(siblings) = self.children.get_mut(parent_id) {
                    siblings.retain(|c| c != id);
                    Self::insert_at(siblings, id.clone(), before_id.as_deref());
                }
            }
            Patch::Remove { id } => {
                self.remove_subtree(id);
                // Also detach from any parent children list.
                for siblings in self.children.values_mut() {
                    siblings.retain(|c| c != id);
                }
            }
            Patch::Detach { id: _ } | Patch::Attach { .. } => {
                // Phase 1: Router cache support is a Phase 4+ concern.
                // Treat as no-ops for now; once routing is exercised in an
                // example, we'll implement keep-alive subtrees.
            }
        }
    }

    fn insert_at(siblings: &mut Vec<String>, id: String, before_id: Option<&str>) {
        siblings.retain(|c| c != &id);
        match before_id {
            Some(before) => match siblings.iter().position(|c| c == before) {
                Some(idx) => siblings.insert(idx, id),
                None => siblings.push(id),
            },
            None => siblings.push(id),
        }
    }

    fn remove_subtree(&mut self, id: &str) {
        if let Some(children) = self.children.remove(id) {
            for child in &children {
                self.remove_subtree(child);
            }
        }
        self.nodes.remove(id);
    }

    /// Apply a batch in order. Convenience wrapper.
    pub fn apply_batch(&mut self, patches: &[Patch]) {
        for p in patches {
            self.apply(p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hypen_engine::Patch;
    use indexmap::IndexMap;
    use serde_json::{json, Value};
    use std::sync::Arc;

    /// Build an `Arc<IndexMap<String, Value>>` for `Patch::Create`'s `props`.
    fn props(entries: &[(&str, Value)]) -> Arc<IndexMap<String, Value>> {
        let mut map = IndexMap::new();
        for (k, v) in entries {
            map.insert((*k).to_string(), v.clone());
        }
        Arc::new(map)
    }

    fn create(id: &str, element_type: &str, entries: &[(&str, Value)]) -> Patch {
        Patch::Create {
            id: id.to_string(),
            element_type: element_type.to_string(),
            props: props(entries),
        }
    }

    fn insert(parent_id: &str, id: &str, before_id: Option<&str>) -> Patch {
        Patch::Insert {
            parent_id: parent_id.to_string(),
            id: id.to_string(),
            before_id: before_id.map(|s| s.to_string()),
        }
    }

    fn move_patch(parent_id: &str, id: &str, before_id: Option<&str>) -> Patch {
        Patch::Move {
            parent_id: parent_id.to_string(),
            id: id.to_string(),
            before_id: before_id.map(|s| s.to_string()),
        }
    }

    #[test]
    fn apply_create_then_insert_makes_root_child() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Text", &[("0", json!("Hello"))]));
        tree.apply(&insert(ROOT_ID, "a", None));

        assert_eq!(tree.root_children(), &["a".to_string()]);
        let node = tree.get("a").expect("node a should exist");
        assert_eq!(node.id, "a");
        assert_eq!(node.element_type, "Text");
        assert_eq!(node.props.get("0"), Some(&json!("Hello")));
    }

    #[test]
    fn insert_with_before_id_positions_correctly() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Text", &[]));
        tree.apply(&insert(ROOT_ID, "a", None));
        tree.apply(&create("b", "Text", &[]));
        tree.apply(&insert(ROOT_ID, "b", None));
        // Insert "c" before "b" — should land between a and b.
        tree.apply(&create("c", "Text", &[]));
        tree.apply(&insert(ROOT_ID, "c", Some("b")));

        assert_eq!(
            tree.root_children(),
            &["a".to_string(), "c".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn insert_with_unknown_before_id_appends() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Text", &[]));
        tree.apply(&insert(ROOT_ID, "a", None));
        tree.apply(&create("b", "Text", &[]));
        // before_id refers to a sibling that doesn't exist — graceful append.
        tree.apply(&insert(ROOT_ID, "b", Some("ghost")));

        assert_eq!(
            tree.root_children(),
            &["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn set_prop_updates_existing_node_props() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Text", &[("0", json!("hi"))]));
        tree.apply(&Patch::SetProp {
            id: "a".into(),
            name: "color".into(),
            value: json!("red"),
        });

        let node = tree.get("a").expect("node a should exist");
        assert_eq!(node.props.get("color"), Some(&json!("red")));
        // Original prop should still be present.
        assert_eq!(node.props.get("0"), Some(&json!("hi")));
    }

    #[test]
    fn set_prop_on_unknown_node_is_a_noop() {
        let mut tree = Tree::new();
        // Should not panic; just logged.
        tree.apply(&Patch::SetProp {
            id: "ghost".into(),
            name: "color".into(),
            value: json!("red"),
        });
        assert!(tree.get("ghost").is_none());
    }

    #[test]
    fn remove_prop_removes_the_key() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Text", &[("color", json!("red"))]));
        tree.apply(&Patch::RemoveProp {
            id: "a".into(),
            name: "color".into(),
        });
        let node = tree.get("a").expect("node a should exist");
        assert!(!node.props.contains_key("color"));
    }

    #[test]
    fn remove_cascades_subtree() {
        // a -> b -> c
        let mut tree = Tree::new();
        tree.apply(&create("a", "Column", &[]));
        tree.apply(&insert(ROOT_ID, "a", None));
        tree.apply(&create("b", "Column", &[]));
        tree.apply(&insert("a", "b", None));
        tree.apply(&create("c", "Text", &[]));
        tree.apply(&insert("b", "c", None));

        // Sanity check the linkage before removal.
        assert_eq!(tree.children_of("a"), &["b".to_string()]);
        assert_eq!(tree.children_of("b"), &["c".to_string()]);

        tree.apply(&Patch::Remove { id: "a".into() });

        // Nodes are gone.
        assert!(tree.get("a").is_none());
        assert!(tree.get("b").is_none());
        assert!(tree.get("c").is_none());

        // Parent-child links are gone.
        assert!(tree.root_children().is_empty());
        assert!(tree.children_of("a").is_empty());
        assert!(tree.children_of("b").is_empty());
        assert!(tree.children_of("c").is_empty());
    }

    #[test]
    fn move_repositions_within_parent() {
        let mut tree = Tree::new();
        for id in ["a", "b", "c"] {
            tree.apply(&create(id, "Text", &[]));
            tree.apply(&insert(ROOT_ID, id, None));
        }
        assert_eq!(
            tree.root_children(),
            &["a".to_string(), "b".to_string(), "c".to_string()]
        );

        // Move "c" to before "a".
        tree.apply(&move_patch(ROOT_ID, "c", Some("a")));

        assert_eq!(
            tree.root_children(),
            &["c".to_string(), "a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn set_text_writes_to_prop_zero() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Text", &[("0", json!("old"))]));
        tree.apply(&Patch::SetText {
            id: "a".into(),
            text: "new".into(),
        });
        let node = tree.get("a").expect("node a should exist");
        assert_eq!(node.props.get("0"), Some(&json!("new")));
    }

    #[test]
    fn apply_batch_processes_in_order() {
        let mut tree = Tree::new();
        let batch = vec![
            create("a", "Column", &[]),
            insert(ROOT_ID, "a", None),
            create("b", "Text", &[("0", json!("child"))]),
            insert("a", "b", None),
            Patch::SetProp {
                id: "b".into(),
                name: "color".into(),
                value: json!("blue"),
            },
        ];
        tree.apply_batch(&batch);

        assert_eq!(tree.root_children(), &["a".to_string()]);
        assert_eq!(tree.children_of("a"), &["b".to_string()]);
        let b = tree.get("b").expect("node b should exist");
        assert_eq!(b.props.get("color"), Some(&json!("blue")));
        assert_eq!(b.props.get("0"), Some(&json!("child")));
    }

    #[test]
    fn detach_and_attach_are_currently_noops() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Column", &[]));
        tree.apply(&insert(ROOT_ID, "a", None));
        tree.apply(&create("b", "Text", &[]));
        tree.apply(&insert("a", "b", None));

        let root_before: Vec<String> = tree.root_children().to_vec();
        let a_children_before: Vec<String> = tree.children_of("a").to_vec();

        // Phase 4+ will implement these; currently they should be no-ops.
        tree.apply(&Patch::Detach { id: "b".into() });
        tree.apply(&Patch::Attach {
            parent_id: "a".into(),
            id: "b".into(),
            before_id: None,
        });

        assert_eq!(tree.root_children(), root_before.as_slice());
        assert_eq!(tree.children_of("a"), a_children_before.as_slice());
        assert!(tree.get("a").is_some());
        assert!(tree.get("b").is_some());
    }

    #[test]
    fn node_text_content_returns_prop_zero_string() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Text", &[("0", json!("hello world"))]));
        let node = tree.get("a").expect("node a should exist");
        assert_eq!(node.text_content(), Some("hello world"));

        // Non-string prop "0" should not parse as text.
        tree.apply(&create("b", "Text", &[("0", json!(42))]));
        let node_b = tree.get("b").expect("node b should exist");
        assert_eq!(node_b.text_content(), None);

        // Missing prop "0" should return None.
        tree.apply(&create("c", "Text", &[]));
        let node_c = tree.get("c").expect("node c should exist");
        assert_eq!(node_c.text_content(), None);
    }
}
