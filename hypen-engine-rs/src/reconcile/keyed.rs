//! Keyed child reconciliation using the LIS algorithm.
//!
//! When children carry stable keys, we can reorder them with minimal
//! DOM moves by computing the Longest Increasing Subsequence (LIS) of
//! old-to-new position mappings.

use super::diff::{
    create_ir_node_tree_full, reconcile_ir_node_impl, root_remove_patch, ReconcileCtx,
};
use super::item_bindings::replace_ir_node_item_bindings;
use super::tree::IterMemo;
use super::Patch;
use crate::ir::{IRNode, NodeId};
use indexmap::IndexMap;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::hash::Hasher;

/// Fingerprint the substitution templates for the iterable memo
/// ([`InstanceNode::iter_memo`](super::tree::InstanceNode::iter_memo)).
///
/// Hashes each template's serialized form, so any content difference —
/// including outer-loop item values already substituted into a nested
/// ForEach's templates — changes the fingerprint. Cost is one serialization
/// of the (small) per-item template per *reconcile call*, not per item.
struct HashWriter(std::collections::hash_map::DefaultHasher);
impl std::io::Write for HashWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.write(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Content hash of a list item for the iterable memo — the write side of
/// [`IterMemo::item_hash`]. Serializes into the hasher, so no allocation.
pub(crate) fn item_fingerprint(item: &serde_json::Value) -> u64 {
    let mut w = HashWriter(std::collections::hash_map::DefaultHasher::new());
    if serde_json::to_writer(&mut w, item).is_err() {
        w.0.write_u64(u64::MAX);
    }
    w.0.finish()
}

/// Templates fingerprint with the per-container cache. `stable` asserts the
/// template list is the container node's OWN stored template (set once at
/// creation, never mutated in place) — only then may the cached hash be
/// read or written. Externally substituted templates (nested ForEach) pass
/// `false` and always recompute; a pointer- or content-stale cache there
/// would let the memo wrongly skip changed rows.
pub(crate) fn fingerprint_for_container(
    ctx: &mut ReconcileCtx,
    container_id: NodeId,
    templates: &[IRNode],
    stable: bool,
) -> u64 {
    if stable {
        if let Some(hash) = ctx.tree.get(container_id).and_then(|n| n.iter_fp_cache) {
            return hash;
        }
    }
    let hash = templates_fingerprint(templates);
    if stable {
        if let Some(node) = ctx.tree.get_mut(container_id) {
            node.iter_fp_cache = Some(hash);
        }
    }
    hash
}

pub(crate) fn templates_fingerprint(ir_templates: &[IRNode]) -> u64 {
    let mut w = HashWriter(std::collections::hash_map::DefaultHasher::new());
    for template in ir_templates {
        // Serialization of IR can't fail (plain data, no maps with non-string
        // keys); if it ever did, fall back to a never-matching fingerprint
        // by hashing the error site count.
        if serde_json::to_writer(&mut w, template).is_err() {
            w.0.write_u64(u64::MAX);
        }
        // Delimit templates so [AB] and [A,B] can't collide.
        w.0.write_u8(0xFF);
    }
    w.0.finish()
}

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
/// Subsequence over their current positions, and emits the minimal set of
/// `Move` patches. New items are created via `create_ir_node_tree_full` and
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
/// don't collide (see [`iterable_child_key`]).
pub(crate) fn reconcile_iterable_children(
    ctx: &mut ReconcileCtx,
    parent_id: NodeId,
    items: &[serde_json::Value],
    item_name: &str,
    key_path: Option<&str>,
    ir_templates: &[IRNode],
    stable_templates: bool,
) {
    // Iterable *elements* (List, Grid, …) are their own render parent: the
    // renderer knows the container node, so logical and render parent agree.
    reconcile_iterable_children_full(
        ctx,
        parent_id,
        parent_id,
        items,
        item_name,
        key_path,
        ir_templates,
        stable_templates,
    )
}

/// Per-child key for an iterable's item/template pair.
///
/// Single-node templates key straight off the item so the key survives
/// round-trips through `replace_ir_node_item_bindings` (which stamps
/// `element.key = item_key`). Multi-node templates disambiguate the siblings
/// an item expands into with a `#<template_idx>` suffix. Creation sites must
/// stamp exactly this so the first reconcile finds the children by identity.
pub(crate) fn iterable_child_key(
    item_key: &str,
    template_idx: usize,
    multi_template: bool,
) -> String {
    iterable_child_key_cow(item_key, template_idx, multi_template).into_owned()
}

/// Borrowing form of [`iterable_child_key`]: the single-template case *is*
/// the item key, so a caller that already owns it need not allocate a copy
/// per row per pass. Same key text as the owning form — one definition, so
/// the two can't drift.
pub(crate) fn iterable_child_key_cow(
    item_key: &str,
    template_idx: usize,
    multi_template: bool,
) -> Cow<'_, str> {
    if multi_template {
        Cow::Owned(format!("{}#{}", item_key, template_idx))
    } else {
        Cow::Borrowed(item_key)
    }
}

/// Record the `(item, templates)` inputs a child was just reconciled or
/// created against, enabling the memo bail-out on the next pass.
pub(crate) fn stamp_iter_memo(
    ctx: &mut ReconcileCtx,
    child_id: NodeId,
    item_hash: u64,
    templates_hash: u64,
) {
    if let Some(node) = ctx.tree.get_mut(child_id) {
        node.iter_memo = Some(IterMemo {
            item_hash,
            templates_hash,
        });
    }
}

/// Keyed reconciliation with an explicit logical/render parent split.
///
/// `logical_parent` owns the children in the instance tree; `render_parent`
/// is what `Insert`/`Move` patches target. They diverge for `IRNode::ForEach`:
/// items are LOGICAL children of the transparent `__ForEach` container while
/// their patches address the ForEach's own parent, because the renderer never
/// materialises the container. Collapsing the two orphans the items under the
/// grandparent and leaves `ForEach.children` empty, which makes every later
/// reconcile see a length mismatch and rebuild forever — see the fallback note
/// in `reconcile_ir_node_impl`'s ForEach arm.
/// Substitution-path creation of one keyed child — the fallback when no
/// row prototype applies. Identical to the historical create branch.
#[allow(clippy::too_many_arguments)]
fn create_keyed_row_slow(
    ctx: &mut ReconcileCtx,
    template: &IRNode,
    item: &serde_json::Value,
    item_index: usize,
    item_name: &str,
    item_key: &str,
    parent_id: NodeId,
    render_parent: NodeId,
    plan: Option<&super::binding_map::InstantiationPlan>,
) -> NodeId {
    let substituted =
        replace_ir_node_item_bindings(template, item, item_index, item_name, item_key);
    let mark = ctx.patches.len();
    let created = create_ir_node_tree_full(
        ctx,
        &substituted,
        Some(parent_id),
        Some(render_parent),
        false,
    );
    super::binding_map::emit_row_as_instantiate_with(ctx, plan, mark, render_parent);
    created
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn reconcile_iterable_children_full(
    ctx: &mut ReconcileCtx,
    logical_parent: NodeId,
    render_parent: NodeId,
    items: &[serde_json::Value],
    item_name: &str,
    key_path: Option<&str>,
    ir_templates: &[IRNode],
    stable_templates: bool,
) {
    let parent_id = logical_parent;
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
            // Duplicate keys (two items resolving to the same `id`) demote the
            // later occurrences to unkeyed rather than overwriting the map
            // entry — an overwritten entry would be neither reused nor removed,
            // leaking the node into the tree and the element into the renderer.
            Some(key) if !old_keyed.contains_key(&key) => {
                old_keyed.insert(key, child_id);
            }
            Some(_) => old_unkeyed.push(child_id),
            None => old_unkeyed.push(child_id),
        }
    }

    // Detach the old children from the LOGICAL parent up front so creation
    // doesn't append at arbitrary positions during the pass — the final
    // children list is rebuilt in desired order as we go.
    if let Some(parent_node) = ctx.tree.get_mut(parent_id) {
        parent_node.children.clear();
    }

    // One fingerprint for the whole pass — every child stamped this cycle
    // shares it, and a keyed match only skips when BOTH its stored item and
    // this fingerprint are unchanged.
    let templates_hash =
        fingerprint_for_container(ctx, parent_id, ir_templates, stable_templates);
    // Compiled binding maps (cached on the container): memo misses on
    // reused children apply just the item-dependent prop deltas instead of
    // substituting and re-walking the whole subtree. `None` = uncompilable
    // (control flow in the template) → full substitution below.
    let compiled = super::binding_map::compiled_for(
        ctx,
        parent_id,
        ir_templates,
        item_name,
        templates_hash,
    );
    // Template-instantiation plans: brand-new children go over the wire as
    // one Instantiate each. Cached beside the compiled maps under the same
    // fingerprint: planning serializes a skeleton per template, and a pass
    // over an unchanged template list must not redo that.
    let instantiation_plans =
        super::binding_map::plans_for(ctx, parent_id, ir_templates, templates_hash);
    // Row prototypes for brand-new children, built lazily on first use —
    // see binding_map::build_row_prototype.
    let mut row_protos: Vec<Option<Option<super::binding_map::RowPrototype>>> =
        (0..ir_templates.len()).map(|_| None).collect();

    // Item keys for the whole pass, materialized up front so each per-child
    // key can BORROW its item key instead of allocating a copy of it (the
    // single-template child key *is* the item key).
    let item_keys: Vec<String> = items
        .iter()
        .enumerate()
        .map(|(index, item)| generate_item_key(item, key_path, item_name, index))
        .collect();

    let mut new_child_ids: Vec<NodeId> = Vec::with_capacity(items.len() * ir_templates.len());
    // Track per-child keys so we can stamp them onto the (possibly newly
    // created) tree nodes after the rebuild.
    let mut new_child_keys: Vec<Cow<'_, str>> = Vec::with_capacity(new_child_ids.capacity());
    // Children created during this pass, in creation order. `create_*` appends
    // them at the end of the render parent, so this is the tail of the
    // post-create render order the placement pass reasons about below.
    let mut created_ids: Vec<NodeId> = Vec::new();
    let mut unkeyed_idx = 0;

    for (item_index, item) in items.iter().enumerate() {
        let item_key = item_keys[item_index].as_str();
        let item_hash = item_fingerprint(item);

        for (template_idx, template) in ir_templates.iter().enumerate() {
            let child_key = iterable_child_key_cow(item_key, template_idx, multi_template);

            let child_id = if let Some(&old_id) = old_keyed.get(child_key.as_ref()) {
                // Memo bail-out: the child rendered this exact item under
                // these exact templates last time, so substitution would
                // produce an identical subtree and the reconcile walk would
                // emit nothing. Re-attach and move on. (The substitution
                // output depends only on item content and template content —
                // `item_index` shapes fallback keys alone, and a key match
                // already pins those.)
                let memo = ctx.tree.get(old_id).and_then(|n| n.iter_memo);
                let memo_hit = memo
                    .is_some_and(|m| m.templates_hash == templates_hash && m.item_hash == item_hash);
                // The compiled map covers only the CURRENT template's
                // item-dependent props, so applying it is sound only when
                // the child last rendered under this exact template — a
                // template change can move static props too, and only the
                // full reconcile sees those.
                let same_template = memo.is_some_and(|m| m.templates_hash == templates_hash);

                if let Some(parent_node) = ctx.tree.get_mut(parent_id) {
                    parent_node.children.push_back(old_id);
                }
                if !memo_hit {
                    // Fast path: apply just the item-dependent prop deltas
                    // via the compiled binding map. Falls back to full
                    // substitution + subtree reconcile when the template is
                    // uncompilable or the subtree shape surprises us.
                    let fast = same_template
                        && compiled
                            .as_deref()
                            .and_then(|c| c.get(template_idx))
                            .is_some_and(|ct| {
                                super::binding_map::apply_compiled_row(
                                    ctx, old_id, ct, item, item_name,
                                )
                            });
                    if !fast {
                        // Reconcile in place against the freshly substituted
                        // IR (so item-binding values get refreshed on key
                        // match).
                        let substituted = replace_ir_node_item_bindings(
                            template, item, item_index, item_name, item_key,
                        );
                        reconcile_ir_node_impl(ctx, old_id, &substituted);
                    }
                    stamp_iter_memo(ctx, old_id, item_hash, templates_hash);
                }
                // `swap_remove`, not `shift_remove`: matching N children in
                // order would otherwise cost O(N²) entry shifts. Nothing reads
                // the residual ORDER of `old_keyed` — the leftovers are just
                // removed at the end, and those Removes address unrelated
                // siblings, so their relative order is not observable.
                old_keyed.swap_remove(child_key.as_ref());
                old_id
            } else if let Some(&old_id) = old_unkeyed.get(unkeyed_idx) {
                // No keyed match but an unkeyed slot is free — reuse it
                // positionally. This is the path for templates whose items
                // don't carry stable identity. The memo bail-out still
                // applies: substitution output depends only on item and
                // template content, never on the slot's position.
                let memo = ctx.tree.get(old_id).and_then(|n| n.iter_memo);
                let memo_hit = memo
                    .is_some_and(|m| m.templates_hash == templates_hash && m.item_hash == item_hash);
                let same_template = memo.is_some_and(|m| m.templates_hash == templates_hash);

                if let Some(parent_node) = ctx.tree.get_mut(parent_id) {
                    parent_node.children.push_back(old_id);
                }
                if !memo_hit {
                    // Same fast path as the keyed branch: positional reuse
                    // re-resolves every item-dependent prop against the new
                    // item, so which item the node previously showed is
                    // irrelevant — but the template must be unchanged (see
                    // the keyed branch).
                    let fast = same_template
                        && compiled
                            .as_deref()
                            .and_then(|c| c.get(template_idx))
                            .is_some_and(|ct| {
                                super::binding_map::apply_compiled_row(
                                    ctx, old_id, ct, item, item_name,
                                )
                            });
                    if !fast {
                        let substituted = replace_ir_node_item_bindings(
                            template, item, item_index, item_name, item_key,
                        );
                        reconcile_ir_node_impl(ctx, old_id, &substituted);
                    }
                    stamp_iter_memo(ctx, old_id, item_hash, templates_hash);
                }
                unkeyed_idx += 1;
                old_id
            } else {
                // Brand new child — create_ir_node_tree_full hangs it off the
                // LOGICAL parent while emitting Create + Insert against the
                // RENDER parent. The Insert appends (before_id: None); the
                // placement pass below slides it into position when the item
                // didn't land at the end.
                let plan = instantiation_plans
                    .get(template_idx)
                    .and_then(Option::as_ref);
                let created = if let Some(plan) = plan {
                    if row_protos[template_idx].is_none() {
                        row_protos[template_idx] = Some(
                            super::binding_map::build_row_prototype(ctx, template, item_name),
                        );
                    }
                    match row_protos[template_idx].as_ref().and_then(Option::as_ref) {
                        Some(proto) => super::binding_map::instantiate_row_from_proto(
                            ctx,
                            proto,
                            plan,
                            item,
                            item_name,
                            parent_id,
                            render_parent,
                        ),
                        None => create_keyed_row_slow(
                            ctx,
                            template,
                            item,
                            item_index,
                            item_name,
                            item_key,
                            parent_id,
                            render_parent,
                            Some(plan),
                        ),
                    }
                } else {
                    create_keyed_row_slow(
                        ctx,
                        template,
                        item,
                        item_index,
                        item_name,
                        item_key,
                        parent_id,
                        render_parent,
                        None,
                    )
                };
                stamp_iter_memo(ctx, created, item_hash, templates_hash);
                created_ids.push(created);
                created
            };

            new_child_ids.push(child_id);
            new_child_keys.push(child_key);
        }
    }

    // Stamp keys onto the (re-used or freshly created) tree nodes so the
    // *next* reconcile finds them again. `new_child_keys` is dead after this,
    // so the keys MOVE into the nodes — and a node already carrying its key
    // (every reused child, i.e. the whole steady state) is left untouched, so
    // an all-hit pass allocates nothing here.
    for (&id, key) in new_child_ids.iter().zip(new_child_keys) {
        if let Some(node) = ctx.tree.get_mut(id) {
            if node.key.as_deref() != Some(key.as_ref()) {
                node.key = Some(key.into_owned());
            }
        }
    }

    // ---- Placement pass -------------------------------------------------
    //
    // Reconstruct the render order the patches emitted so far have already
    // produced: surviving children keep their old relative order, then every
    // child created above, in creation order (each `Insert` appended). Old
    // children that are about to be removed are ignored — they only ever sit
    // *between* survivors, and `Move { before_id }` is an insert-before, so
    // their presence never changes a survivor's relative position.
    let retained: HashSet<NodeId> = new_child_ids.iter().copied().collect();
    let post_create_order: Vec<NodeId> = old_children
        .iter()
        .copied()
        .filter(|id| retained.contains(id))
        .chain(created_ids)
        .collect();
    let current_index: HashMap<NodeId, usize> = post_create_order
        .iter()
        .enumerate()
        .map(|(idx, &id)| (id, idx))
        .collect();

    // Longest increasing subsequence over each desired child's *current*
    // position: everything in the LIS is already in the right relative order
    // and needs no patch; everything else needs exactly one Move.
    let current_positions: Vec<Option<usize>> = new_child_ids
        .iter()
        .map(|new_id| current_index.get(new_id).copied())
        .collect();
    let mut in_lis = vec![false; new_child_ids.len()];
    for idx in longest_increasing_subsequence(&current_positions) {
        in_lis[idx] = true;
    }

    // Walk backwards so each Move's anchor (`new_child_ids[i + 1]`) is already
    // in its final position — the forward direction is wrong for any reorder
    // needing two or more moves (e.g. [a,b,c] → [c,b,a]).
    for new_idx in (0..new_child_ids.len()).rev() {
        if in_lis[new_idx] {
            continue;
        }
        let before_id = new_child_ids.get(new_idx + 1).copied();
        ctx.patches.push(Patch::move_node(
            render_parent,
            new_child_ids[new_idx],
            before_id,
        ));
    }

    // Remove old children that weren't reused. The exit spec must be read
    // (root_remove_patch) before `ctx.tree.remove` drops the node's props.
    for &old_id in old_keyed.values() {
        let patch = root_remove_patch(ctx.tree, old_id);
        ctx.dependencies.remove_node(old_id);
        ctx.tree.remove(old_id);
        ctx.patches.push(patch);
    }
    for &old_id in &old_unkeyed[unkeyed_idx..] {
        let patch = root_remove_patch(ctx.tree, old_id);
        ctx.dependencies.remove_node(old_id);
        ctx.tree.remove(old_id);
        ctx.patches.push(patch);
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
