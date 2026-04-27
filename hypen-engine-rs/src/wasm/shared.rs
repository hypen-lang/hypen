//! Binding-agnostic helpers shared by the JS (wasm-bindgen) and WASI (C FFI)
//! bindings.
//!
//! Both bindings wrap the same `EngineCore` and need identical bookkeeping
//! on top of it (node-ID indexing for `render_into`, the subtree-reconcile
//! body, parse-error formatting). Keeping that logic here means adding a
//! new engine capability doesn't require editing two near-identical copies
//! of the surrounding glue.
//!
//! This module is only compiled for wasm32 targets since its only callers
//! live behind `#[cfg(target_arch = "wasm32")]`.

use std::collections::HashMap;

use crate::{
    engine_core::EngineCore,
    ir::{IRNode, NodeId},
    reconcile::{create_ir_node_tree_impl, node_id_str, reconcile_ir_node_impl, Patch, ReconcileCtx},
};

/// Maps compact node-ID strings (as emitted in patches) back to their
/// SlotMap keys so `render_into(parent_id, ...)` can resolve the host's
/// opaque identifier to a concrete tree node in O(1).
#[derive(Default)]
pub(crate) struct NodeIdIndex {
    map: HashMap<String, NodeId>,
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
            if let Patch::Create { id, .. } = patch {
                if !self.map.contains_key(id) {
                    for (node_id, _) in core.tree.iter() {
                        if node_id_str(node_id) == *id {
                            self.map.insert(id.clone(), node_id);
                            break;
                        }
                    }
                }
            }
        }
    }
}

/// Reconcile `expanded` into `parent_id`'s subtree and bump the engine
/// revision — the shared body of `WasmEngine::render_into` /
/// `hypen_render_into`.
///
/// If the parent already has children, the expanded IR is reconciled
/// against the first child (a stable route swap for `Router`-style
/// patterns). Otherwise a fresh subtree is created directly under the
/// parent. Patches are appended to `patches` in either case.
pub(crate) fn render_subtree_into(
    core: &mut EngineCore,
    parent_id: NodeId,
    expanded: &IRNode,
    state: &serde_json::Value,
    patches: &mut Vec<Patch>,
) {
    let first_child_id = core
        .tree
        .get(parent_id)
        .and_then(|node| node.children.front().copied());

    let ds = (!core.data_sources.is_empty()).then_some(&core.data_sources);
    let mods = (!core.modules.is_empty()).then_some(&core.modules);

    match first_child_id {
        Some(first_child_id) => {
            let mut ctx = ReconcileCtx {
                tree: &mut core.tree,
                state,
                patches,
                dependencies: &mut core.dependencies,
                data_sources: ds,
                modules: mods,
            };
            reconcile_ir_node_impl(&mut ctx, first_child_id, expanded);
        }
        None => {
            let mut ctx = ReconcileCtx {
                tree: &mut core.tree,
                state,
                patches,
                dependencies: &mut core.dependencies,
                data_sources: ds,
                modules: mods,
            };
            create_ir_node_tree_impl(&mut ctx, expanded, Some(parent_id), false);
        }
    }

    core.revision += 1;
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
            },
            // Duplicate of the same Create — must not bloat the index or
            // panic on a second insert.
            Patch::Create {
                id: str_a.clone(),
                element_type: "Text".into(),
                props: empty_props.clone(),
            },
            Patch::Create {
                id: str_b.clone(),
                element_type: "Column".into(),
                props: empty_props.clone(),
            },
            // Non-Create patches must be ignored.
            Patch::Remove { id: str_a.clone() },
        ];
        index.index_creates(&patches, &core);

        assert_eq!(index.lookup(&str_a), Some(id_a));
        assert_eq!(index.lookup(&str_b), Some(id_b));
        assert!(index.lookup("nonexistent").is_none());
    }

    /// render_subtree_into must append Create patches (fresh subtree) when
    /// the parent has no children, and bump core.revision in both paths.
    #[test]
    fn render_subtree_into_fresh_subtree_path() {
        let mut core = EngineCore::new();
        let parent = core
            .tree
            .create_node(&Element::new("Column"), &serde_json::Value::Null);
        core.tree.set_root(parent);

        let rev_before = core.revision;
        let mut patches = Vec::new();
        let child_ir = IRNode::Element(Element::new("Text"));
        render_subtree_into(
            &mut core,
            parent,
            &child_ir,
            &serde_json::Value::Null,
            &mut patches,
        );

        assert!(
            patches.iter().any(|p| matches!(p, Patch::Create { .. })),
            "fresh subtree must emit at least one Create patch; got: {:?}",
            patches
        );
        assert_eq!(
            core.revision,
            rev_before + 1,
            "render_subtree_into must bump revision"
        );
    }

    #[test]
    fn format_parse_errors_handles_empty_batch() {
        assert_eq!(format_parse_errors(&[]), "");
    }
}
