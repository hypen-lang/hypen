//! Binding-agnostic helpers shared by the JS (wasm-bindgen) and WASI (C FFI)
//! bindings.
//!
//! Both bindings wrap the same `EngineCore` and need identical bookkeeping
//! on top of it (node-ID indexing for `render_into`, parse-error
//! formatting). The subtree reconcile itself is
//! `EngineCore::render_subtree_into`, so it shares the pre/post passes of
//! every other reconcile entry point. Keeping that logic here means adding a
//! new engine capability doesn't require editing two near-identical copies
//! of the surrounding glue.
//!
//! This module is only compiled for wasm32 targets since its only callers
//! live behind `#[cfg(target_arch = "wasm32")]`.

use std::collections::HashMap;
use std::sync::Arc;

use crate::{engine_core::EngineCore, ir::NodeId, reconcile::Patch};

/// Maps compact node-ID strings (as emitted in patches) back to their
/// SlotMap keys so `render_into(parent_id, ...)` can resolve the host's
/// opaque identifier to a concrete tree node in O(1).
///
/// Keyed by `Arc<str>` so indexing a patch's id is a refcount bump of the
/// memoized string, not a fresh `String`; `&str` lookups still work via
/// `Borrow<str>`.
#[derive(Default)]
pub(crate) struct NodeIdIndex {
    map: HashMap<Arc<str>, NodeId>,
}

impl NodeIdIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn lookup(&self, id: &str) -> Option<NodeId> {
        self.map.get(id).copied()
    }

    /// Walk a patch batch and record any newly-created node IDs.
    ///
    /// This must be called while the tree is in sync with `patches`: after
    /// reconciliation has produced them but before another render could
    /// mutate the tree again.
    pub fn index_creates(&mut self, patches: &[Patch], core: &EngineCore) {
        for patch in patches {
            // Template instantiation creates nodes too — every id in
            // `nodes` is a freshly created element.
            if let Patch::Instantiate { nodes, .. } = patch {
                for id in nodes {
                    if self.map.contains_key(id) {
                        continue;
                    }
                    let Ok(ffi) = id.parse::<u64>() else { continue };
                    let node_id = NodeId::from(slotmap::KeyData::from_ffi(ffi));
                    if core.tree.get(node_id).is_some() {
                        self.map.insert(id.clone(), node_id);
                    }
                }
                continue;
            }
            if let Patch::Create { id, .. } = patch {
                if self.map.contains_key(id) {
                    continue;
                }
                // `node_id_str` is `KeyData::as_ffi().to_string()`, so the
                // reverse is exact: parse the decimal back into the key
                // rather than scanning the tree for a node that formats to
                // the same string. The old scan was O(creates × tree size)
                // and allocated a String per probe — on a 17k-node first
                // render that is ~145M formatted comparisons.
                let Ok(ffi) = id.parse::<u64>() else { continue };
                let node_id = NodeId::from(slotmap::KeyData::from_ffi(ffi));
                if core.tree.get(node_id).is_some() {
                    self.map.insert(id.clone(), node_id);
                }
            }
        }
    }
}

/// Format a batch of parse errors into a single human-readable message.
pub(crate) fn format_parse_errors(errors: &[hypen_parser::error::Rich<char>]) -> String {
    errors
        .iter()
        .map(hypen_parser::error::format_error_simple)
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::Element;
    use crate::reconcile::tree::ResolvedProps;
    use indexmap::IndexMap;
    use std::sync::Arc;

    /// NodeIdIndex.lookup returns None for ids it hasn't seen, returns the
    /// correct SlotMap key after index_creates, and is resilient to the
    /// same Create patch appearing twice.
    #[test]
    fn node_id_index_create_patch_tracking() {
        let mut core = EngineCore::new();
        let mut index = NodeIdIndex::new();

        // Build two real nodes in the tree so node_id_str() produces real
        // strings we can look up.
        let elem_a = Element::new("Text");
        let elem_b = Element::new("Column");
        let id_a = core.tree.create_node(&elem_a, &serde_json::Value::Null);
        let id_b = core.tree.create_node(&elem_b, &serde_json::Value::Null);
        let str_a = crate::reconcile::node_id_str(id_a);
        let str_b = crate::reconcile::node_id_str(id_b);

        assert!(index.lookup(&str_a).is_none(), "fresh index must be empty");

        let empty_props: ResolvedProps = Arc::new(IndexMap::new());
        let patches = vec![
            Patch::Create {
                id: str_a.clone(),
                element_type: "Text".into(),
                props: empty_props.clone(),
                semantics: None,
            },
            // Duplicate of the same Create — must not bloat the index or
            // panic on a second insert.
            Patch::Create {
                id: str_a.clone(),
                element_type: "Text".into(),
                props: empty_props.clone(),
                semantics: None,
            },
            Patch::Create {
                id: str_b.clone(),
                element_type: "Column".into(),
                props: empty_props.clone(),
                semantics: None,
            },
            // Non-Create patches must be ignored.
            Patch::Remove {
                id: str_a.clone(),
                transition: false,
            },
        ];
        index.index_creates(&patches, &core);

        assert_eq!(index.lookup(&str_a), Some(id_a));
        assert_eq!(index.lookup(&str_b), Some(id_b));
        assert!(index.lookup("nonexistent").is_none());
    }

    #[test]
    fn format_parse_errors_handles_empty_batch() {
        assert_eq!(format_parse_errors(&[]), "");
    }
}
