//! Keyed child reconciliation using the LIS algorithm.
//!
//! When children carry stable keys, we can reorder them with minimal
//! DOM moves by computing the Longest Increasing Subsequence (LIS) of
//! old-to-new position mappings.

use super::diff::{create_ir_node_tree_impl, reconcile_ir_node_impl, ReconcileCtx};
use super::item_bindings::replace_ir_node_item_bindings;
use super::Patch;
use crate::ir::{IRNode, NodeId};
use indexmap::IndexMap;

/// Generate a stable key for a list item.
///
/// Resolution order:
/// 1. Explicit `key_path` (e.g., from `Grid(@items, key: "uuid")`) — wins.
/// 2. Auto-detect `id` field on object items so the common case works
///    without an explicit `key:` annotation.
/// 3. Fall back to a positional key (`item-0`, `item-1`, …) which
///    intentionally produces no stable identity across reorders.
pub(crate) fn generate_item_key(
    item: &serde_json::Value,
    key_path: Option<&str>,
    item_name: &str,
    index: usize,
) -> String {
    fn stringify(v: &serde_json::Value) -> Option<String> {
        match v {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            serde_json::Value::Bool(b) => Some(b.to_string()),
            _ => None,
        }
    }

    if let Some(kp) = key_path {
        if let Some(s) = item.get(kp).and_then(stringify) {
            return s;
        }
    }

    // Auto-detect: object items with an `id` field get keyed by id.
    if let Some(s) = item.get("id").and_then(stringify) {
        return s;
    }

    format!("{}-{}", item_name, index)
}

/// Reconcile the children of an iterable container (list, ForEach, …) against
/// a new array of items, using stable keys to minimize DOM mutations.
///
/// Each rendered child of `parent_id` is keyed by the item's resolved key
/// (see [`generate_item_key`]). When the new array reorders items, this
/// function reuses the matching old children, computes a Longest Increasing
/// Subsequence over their old positions, and emits the minimal set of
/// `Move` patches. New items are created via `create_ir_node_tree_impl` and
/// dropped items are removed.
///
/// `ir_templates` is the per-iteration template list — typically one IRNode,
/// but ForEach blocks may declare multiple. Each template instance is
/// expanded with the current item via [`replace_ir_node_item_bindings`]
/// before the keyed match runs.
///
/// `child_key_for(item_key, template_idx)` builds the per-child key. For
/// single-template lists this is just `item_key`; for multi-template ForEach
/// it's `format!("{item_key}#{template_idx}")` so siblings from the same item
/// don't collide.
pub(crate) fn reconcile_iterable_children(
    ctx: &mut ReconcileCtx,
    parent_id: NodeId,
    items: &[serde_json::Value],
    item_name: &str,
    key_path: Option<&str>,
    ir_templates: &[IRNode],
) {
    let multi_template = ir_templates.len() > 1;

    // Snapshot the parent's existing children + their keys.
    let old_children: Vec<NodeId> = ctx
        .tree
        .get(parent_id)
        .map(|n| n.children.iter().copied().collect())
        .unwrap_or_default();

    let mut old_keyed: IndexMap<String, NodeId> = IndexMap::new();
    let mut old_unkeyed: Vec<NodeId> = Vec::new();
    for &child_id in &old_children {
        match ctx.tree.get(child_id).and_then(|n| n.key.clone()) {
            Some(key) => {
                old_keyed.insert(key, child_id);
            }
            None => old_unkeyed.push(child_id),
        }
    }

    // Detach the old children from the parent up front so create_ir_node_tree_impl
    // doesn't append at arbitrary positions during the rebuild. We'll set the
    // final children list at the end.
    if let Some(parent_node) = ctx.tree.get_mut(parent_id) {
        parent_node.children.clear();
    }

    let mut new_child_ids: Vec<NodeId> = Vec::with_capacity(items.len() * ir_templates.len());
    // Track per-child keys so we can stamp them onto the (possibly newly
    // created) tree nodes after the rebuild.
    let mut new_child_keys: Vec<String> = Vec::with_capacity(new_child_ids.capacity());
    let mut unkeyed_idx = 0;

    for (item_index, item) in items.iter().enumerate() {
        let item_key = generate_item_key(item, key_path, item_name, item_index);

        for (template_idx, template) in ir_templates.iter().enumerate() {
            let child_key = if multi_template {
                format!("{}#{}", item_key, template_idx)
            } else {
                item_key.clone()
            };

            let child_id = if let Some(&old_id) = old_keyed.get(&child_key) {
                // Re-attach the matched child and reconcile in place against
                // the freshly substituted IR (so item-binding values get
                // refreshed even when keys match).
                let substituted =
                    replace_ir_node_item_bindings(template, item, item_index, item_name, &item_key);
                if let Some(parent_node) = ctx.tree.get_mut(parent_id) {
                    parent_node.children.push_back(old_id);
                }
                reconcile_ir_node_impl(ctx, old_id, &substituted);
                old_keyed.shift_remove(&child_key);
                old_id
            } else if let Some(&old_id) = old_unkeyed.get(unkeyed_idx) {
                // No keyed match but an unkeyed slot is free — reuse it
                // positionally. This is the path for templates whose items
                // don't carry stable identity.
                let substituted =
                    replace_ir_node_item_bindings(template, item, item_index, item_name, &item_key);
                if let Some(parent_node) = ctx.tree.get_mut(parent_id) {
                    parent_node.children.push_back(old_id);
                }
                reconcile_ir_node_impl(ctx, old_id, &substituted);
                unkeyed_idx += 1;
                old_id
            } else {
                // Brand new child — create_ir_node_tree_impl will append it
                // to the parent's children list and emit Create+Insert.
                let substituted =
                    replace_ir_node_item_bindings(template, item, item_index, item_name, &item_key);
                create_ir_node_tree_impl(ctx, &substituted, Some(parent_id), false)
            };

            new_child_ids.push(child_id);
            new_child_keys.push(child_key);
        }
    }

    // Stamp keys onto the (re-used or freshly created) tree nodes so the
    // *next* reconcile finds them again.
    for (id, key) in new_child_ids.iter().zip(new_child_keys.iter()) {
        if let Some(node) = ctx.tree.get_mut(*id) {
            node.key = Some(key.clone());
        }
    }

    // Compute the longest increasing subsequence of old positions to find
    // which reused children are already in the right order. Anything not in
    // the LIS needs an explicit Move patch.
    let old_positions: Vec<Option<usize>> = new_child_ids
        .iter()
        .map(|new_id| old_children.iter().position(|old_id| old_id == new_id))
        .collect();
    let lis = longest_increasing_subsequence(&old_positions);

    // Emit Move patches for previously-existing children that need to slide.
    // Brand-new children (old_position == None) were already inserted via
    // create_ir_node_tree_impl; reused children that landed in the correct
    // relative position are in `lis` and need no patch.
    for (new_idx, &child_id) in new_child_ids.iter().enumerate() {
        if old_positions[new_idx].is_none() {
            // Newly created — already inserted by create_ir_node_tree_impl.
            continue;
        }
        if !lis.contains(&new_idx) {
            let before_id = new_child_ids.get(new_idx + 1).copied();
            ctx.patches
                .push(Patch::move_node(parent_id, child_id, before_id));
        }
    }

    // Remove old children that weren't reused.
    for &old_id in old_keyed.values() {
        ctx.dependencies.remove_node(old_id);
        ctx.tree.remove(old_id);
        ctx.patches.push(Patch::remove(old_id));
    }
    for &old_id in &old_unkeyed[unkeyed_idx..] {
        ctx.dependencies.remove_node(old_id);
        ctx.tree.remove(old_id);
        ctx.patches.push(Patch::remove(old_id));
    }
}

/// Find the longest increasing subsequence (LIS) indices.
/// Uses the patience-sort / binary-search algorithm for O(n log n) performance.
/// Returns indices (into the original `positions` slice) of elements that are
/// already in correct relative order, minimizing DOM moves during reconciliation.
fn longest_increasing_subsequence(positions: &[Option<usize>]) -> Vec<usize> {
    // Extract valid positions with their original indices
    let valid: Vec<(usize, usize)> = positions
        .iter()
        .enumerate()
        .filter_map(|(idx, &pos)| pos.map(|p| (idx, p)))
        .collect();

    if valid.is_empty() {
        return Vec::new();
    }

    let n = valid.len();
    // `tails[i]` holds the index (into `valid`) of the smallest tail element for
    // an increasing subsequence of length `i + 1`.
    let mut tails: Vec<usize> = Vec::with_capacity(n);
    // `prev[i]` links back to the predecessor of valid[i] in the LIS.
    let mut prev: Vec<Option<usize>> = vec![None; n];

    for i in 0..n {
        let val = valid[i].1;
        // Binary search for the leftmost tail >= val
        let pos = tails.partition_point(|&t| valid[t].1 < val);

        if pos == tails.len() {
            tails.push(i);
        } else {
            tails[pos] = i;
        }

        if pos > 0 {
            prev[i] = Some(tails[pos - 1]);
        }
    }

    // Reconstruct: walk backwards from the last tail entry
    let mut result = Vec::with_capacity(tails.len());
    let mut idx = Some(*tails.last().unwrap());
    while let Some(i) = idx {
        result.push(valid[i].0);
        idx = prev[i];
    }
    result.reverse();

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_longest_increasing_subsequence_basic() {
        // Test case: [0, 1, 2, 3] - already in order, should select all
        let positions = vec![Some(0), Some(1), Some(2), Some(3)];
        let lis = longest_increasing_subsequence(&positions);
        assert_eq!(lis, vec![0, 1, 2, 3]);
    }

    #[test]
    fn test_longest_increasing_subsequence_reverse() {
        // Test case: [3, 2, 1, 0] - reversed, should select only one element
        let positions = vec![Some(3), Some(2), Some(1), Some(0)];
        let lis = longest_increasing_subsequence(&positions);
        assert_eq!(lis.len(), 1);
    }

    #[test]
    fn test_longest_increasing_subsequence_mixed() {
        // Test case: [0, 3, 1, 2] - should select [0, 1, 2]
        let positions = vec![Some(0), Some(3), Some(1), Some(2)];
        let lis = longest_increasing_subsequence(&positions);
        assert_eq!(lis.len(), 3);
        // Should contain indices of 0, 1, 2 in the original array
        assert!(lis.contains(&0));
        assert!(lis.contains(&2));
        assert!(lis.contains(&3));
    }

    #[test]
    fn test_longest_increasing_subsequence_with_new_items() {
        // Test case: [None, Some(0), None, Some(1)] - new items mixed with existing
        let positions = vec![None, Some(0), None, Some(1)];
        let lis = longest_increasing_subsequence(&positions);
        assert_eq!(lis, vec![1, 3]); // Only indices with existing positions
    }

    #[test]
    fn test_longest_increasing_subsequence_empty() {
        let positions: Vec<Option<usize>> = vec![];
        let lis = longest_increasing_subsequence(&positions);
        assert_eq!(lis, Vec::<usize>::new());
    }

    #[test]
    fn test_longest_increasing_subsequence_all_new() {
        // All new items (no old positions)
        let positions = vec![None, None, None];
        let lis = longest_increasing_subsequence(&positions);
        assert_eq!(lis, Vec::<usize>::new());
    }

    #[test]
    fn test_lis_large_sequence() {
        // Test that the O(n log n) algorithm handles longer sequences correctly
        // [3, 1, 4, 1, 5, 9, 2, 6] has LIS of length 4: 1,4,5,9 or 1,4,5,6
        let positions: Vec<Option<usize>> = vec![
            Some(3),
            Some(1),
            Some(4),
            Some(1),
            Some(5),
            Some(9),
            Some(2),
            Some(6),
        ];
        let lis = longest_increasing_subsequence(&positions);
        assert_eq!(lis.len(), 4);
        // Verify the subsequence is actually increasing
        let values: Vec<usize> = lis.iter().map(|&i| positions[i].unwrap()).collect();
        for w in values.windows(2) {
            assert!(w[0] < w[1], "LIS must be strictly increasing: {:?}", values);
        }
    }
}
