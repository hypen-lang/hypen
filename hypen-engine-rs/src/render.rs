//! Shared rendering logic for Engine and WasmEngine
//!
//! This module contains the common rendering logic to avoid code duplication
//! between the native Engine and WASM WasmEngine implementations.

use crate::{
    ir::{NodeId, Value},
    lifecycle::ModuleInstance,
    reactive::{DependencyGraph, Scheduler},
    reconcile::{
        diff::is_engine_internal_prop, emit_semantics_delta, reconcile_ir_node_impl, InstanceTree,
        Patch, ReconcileCtx,
    },
};

/// Render only dirty nodes (optimized for state changes)
/// This is shared logic used by both Engine and WasmEngine
pub fn render_dirty_nodes(
    scheduler: &mut Scheduler,
    tree: &mut InstanceTree,
    module: Option<&ModuleInstance>,
) -> Vec<Patch> {
    render_dirty_nodes_full(
        scheduler,
        tree,
        module,
        &mut DependencyGraph::new(),
        None,
        None,
    )
}

/// Render only dirty nodes with data source context
pub fn render_dirty_nodes_with_data_sources(
    scheduler: &mut Scheduler,
    tree: &mut InstanceTree,
    module: Option<&ModuleInstance>,
    data_sources: Option<&indexmap::IndexMap<String, serde_json::Value>>,
) -> Vec<Patch> {
    render_dirty_nodes_full(
        scheduler,
        tree,
        module,
        &mut DependencyGraph::new(),
        data_sources,
        None,
    )
}

/// Render only dirty nodes with dependency tracking for List reconciliation
pub fn render_dirty_nodes_with_deps(
    scheduler: &mut Scheduler,
    tree: &mut InstanceTree,
    module: Option<&ModuleInstance>,
    dependencies: &mut DependencyGraph,
) -> Vec<Patch> {
    render_dirty_nodes_full(scheduler, tree, module, dependencies, None, None)
}

/// Full render of dirty nodes with all contexts
pub fn render_dirty_nodes_full(
    scheduler: &mut Scheduler,
    tree: &mut InstanceTree,
    module: Option<&ModuleInstance>,
    dependencies: &mut DependencyGraph,
    data_sources: Option<&indexmap::IndexMap<String, serde_json::Value>>,
    modules: Option<&indexmap::IndexMap<String, ModuleInstance>>,
) -> Vec<Patch> {
    if !scheduler.has_dirty() {
        return Vec::new();
    }

    let dirty_nodes = scheduler.take_dirty();
    // The state paths that produced this batch, when every marking carried
    // one. They let iterable re-renders touch only the item indices the
    // change named ("rows.500.selected" → row 500) instead of running a
    // keyed pass over every child. `None` → full passes everywhere.
    let changed_paths = scheduler.take_changed_paths();
    let state = module
        .map(|m| m.get_state())
        .unwrap_or(&serde_json::Value::Null);

    // Store old props before updating, then update and generate patches for changed props only
    let mut patches = Vec::new();
    for node_id in dirty_nodes {
        // One tree lookup answers all three questions about this node:
        //   * is it a List node (array binding in raw_props AND an
        //     element_template — set for List elements that re-render
        //     their children)?
        //   * is it a control-flow node (ForEach/Conditional) with an IR
        //     template?
        //   * is it a ForEach?
        let (is_list_node, is_control_flow, is_foreach) = match tree.get(node_id) {
            Some(n) => (
                n.raw_props
                    .get("0")
                    .map(|v| matches!(v, Value::Binding(_)))
                    .unwrap_or(false)
                    && n.element_template.is_some(),
                n.ir_node_template.is_some(),
                n.is_foreach(),
            ),
            None => (false, false, false),
        };

        // Narrow pass first: when the batch's changed paths name specific
        // item indices of this iterable, reconcile only those children.
        // Falls through to the full pass whenever the hint doesn't hold
        // (wholesale array replacement, growth/shrink, identity changes,
        // unknown provenance).
        if is_list_node || is_foreach {
            if let Some(cp) = changed_paths.as_deref() {
                if render_dirty_iterable_partial(
                    node_id,
                    tree,
                    state,
                    &mut patches,
                    dependencies,
                    data_sources,
                    modules,
                    cp,
                ) {
                    continue;
                }
            }
        }

        if is_list_node {
            // For List nodes, we need to re-reconcile the entire list
            render_dirty_list(
                node_id,
                tree,
                state,
                &mut patches,
                dependencies,
                data_sources,
            );
        } else if is_control_flow {
            // For control flow nodes (ForEach/Conditional from IRNode path),
            // re-reconcile the entire subtree using the stored IR template.
            let ir_template = tree.get(node_id).and_then(|n| n.ir_node_template.clone());
            if let Some(template) = ir_template {
                let mut ctx = ReconcileCtx {
                    tree,
                    state,
                    patches: &mut patches,
                    dependencies,
                    data_sources,
                    modules,
                };
                reconcile_ir_node_impl(&mut ctx, node_id, &template);
            }
        } else {
            // Regular node: just update props. The old map is taken out
            // rather than cloned — it is only needed for the comparison,
            // and the node's props are replaced wholesale just below.
            let old_props = tree.get_mut(node_id).map(|n| std::mem::take(&mut n.props));

            // Determine the effective state: if this node belongs to a module scope,
            // use that module's state; otherwise use the primary module's state.
            let effective_state = tree
                .get(node_id)
                .and_then(|n| n.module_scope.as_deref())
                .and_then(|scope| modules.and_then(|m| m.get(scope)))
                .map(|m| m.get_state())
                .unwrap_or(state);

            // Update props with new state (and data sources if available)
            if let Some(node) = tree.get_mut(node_id) {
                if data_sources.is_some() {
                    node.update_props_with_data_sources(effective_state, data_sources);
                } else {
                    node.update_props(effective_state);
                }
            }

            // Compare and generate patches only for changed props. Deref
            // the Arc<IndexMap> explicitly to get a `&IndexMap` iterator.
            // Engine-internal carriers (hoisted `__a11yName`) never emit —
            // their change reaches renderers via SetSemantics below.
            if let (Some(old), Some(node)) = (old_props, tree.get(node_id)) {
                for (key, new_value) in node.props.iter() {
                    if is_engine_internal_prop(key) {
                        continue;
                    }
                    if old.get(key) != Some(new_value) {
                        patches.push(Patch::set_prop(node_id, key.to_string(), new_value.clone()));
                    }
                }
                // Remove props that no longer exist
                for key in old.keys() {
                    if is_engine_internal_prop(key) {
                        continue;
                    }
                    if !node.props.contains_key(key) {
                        patches.push(Patch::remove_prop(node_id, key.to_string()));
                    }
                }
            }

            // A reactive prop change can also change the node's *resolved*
            // semantics (templated accessible name, bound self-state /
            // checked). Re-resolve against the fresh props and emit a
            // SetSemantics when the renderer's block went stale — this is
            // what keeps Canvas/native accessibility live after first paint
            // (DOM mostly re-derives from content, but other renderers read
            // the block verbatim).
            emit_semantics_delta(tree, node_id, &mut patches);
        }
    }

    patches
}

/// Try to re-render a dirty iterable (List element or ForEach container) by
/// touching ONLY the item indices named in the batch's changed paths.
///
/// Returns `true` when the narrow pass fully handled the node; `false` means
/// the caller must run the full keyed pass. The hint applies exactly when
/// every relevant changed path is strictly *inside* an item
/// (`<array>.<index>.<field...>`) and each named item still carries the same
/// reconciliation key — i.e. an in-place item edit. Everything else is a
/// structural change in disguise and bails out:
///
/// - a path equal to (or a parent of) the array path — wholesale replacement;
/// - a non-numeric segment after the array path (`rows.length`);
/// - an index at/past the current length, or a child-count mismatch — growth
///   or shrink;
/// - a key mismatch at a named index — reorder/swap, which must go through
///   the keyed pass to produce `Move` patches instead of content rewrites.
///
/// The narrow pass is the memo bail-out inverted: instead of paying O(rows)
/// to *discover* which children changed, the changed paths say so up front,
/// so cost is O(touched rows) and `select-row` stops walking 1,000 children
/// to update one.
#[allow(clippy::too_many_arguments)]
fn render_dirty_iterable_partial(
    node_id: NodeId,
    tree: &mut InstanceTree,
    state: &serde_json::Value,
    patches: &mut Vec<Patch>,
    dependencies: &mut DependencyGraph,
    data_sources: Option<&indexmap::IndexMap<String, serde_json::Value>>,
    modules: Option<&indexmap::IndexMap<String, ModuleInstance>>,
    changed_paths: &[String],
) -> bool {
    use crate::ir::IRNode;
    use crate::reconcile::item_bindings::replace_ir_node_item_bindings;
    use crate::reconcile::keyed::{
        generate_item_key, item_fingerprint, iterable_child_key, stamp_iter_memo,
        templates_fingerprint,
    };
    use crate::reconcile::resolve::evaluate_binding_ref;

    // ── Extract the iterable's shape from the node ──────────────────────
    // Both flavors reduce to: a source binding, an item name, an optional
    // key path, and the per-item template list.
    enum Templates {
        List(std::sync::Arc<crate::ir::Element>),
        ForEach(std::sync::Arc<IRNode>),
    }

    let (binding, templates_src, item_name, key_path, module_scope) = {
        let Some(node) = tree.get(node_id) else {
            return true; // removed earlier in this batch — nothing to render
        };
        if let Some(template) = &node.element_template {
            // List element: array binding in raw prop "0", key in `key.0`.
            let Some(Value::Binding(b)) = node.raw_props.get("0") else {
                return false;
            };
            let key_path = template.props.get("key.0").and_then(|v| match v {
                Value::Static(serde_json::Value::String(s)) => Some(s.clone()),
                _ => None,
            });
            (
                b.clone(),
                Templates::List(template.clone()),
                "item".to_string(),
                key_path,
                node.module_scope.clone(),
            )
        } else if let Some(ir) = &node.ir_node_template {
            let IRNode::ForEach {
                source,
                item_name,
                key_path,
                ..
            } = &**ir
            else {
                return false;
            };
            (
                source.clone(),
                Templates::ForEach(ir.clone()),
                item_name.clone(),
                key_path.clone(),
                node.module_scope.clone(),
            )
        } else {
            return false;
        }
    };

    // Item-sourced iterables (nested ForEach) resolve against the enclosing
    // item, which the dirty batch's state paths say nothing about.
    if !binding.is_state() {
        return false;
    }

    // ── Scan the changed paths for index hints ──────────────────────────
    // Dependency keys are scope-prefixed (`mod:{name}:{path}`), so the
    // comparison base must be too.
    let joined = binding.path.join(".");
    let base = match module_scope.as_deref() {
        Some(scope) => format!("mod:{}:{}", scope, joined),
        None => joined,
    };

    let mut indices = std::collections::BTreeSet::new();
    for p in changed_paths {
        // A parent of the array path changed → the array itself may be a
        // different value → wholesale.
        if base
            .strip_prefix(p.as_str())
            .is_some_and(|r| r.starts_with('.'))
        {
            return false;
        }
        let Some(rest) = p.strip_prefix(base.as_str()) else {
            continue;
        };
        if rest.is_empty() {
            return false; // the array itself was replaced
        }
        let Some(rest) = rest.strip_prefix('.') else {
            continue; // shares a name prefix, different path ("rowsTotal")
        };
        let index_segment = rest.split('.').next().unwrap_or(rest);
        let Ok(index) = index_segment.parse::<usize>() else {
            return false; // "rows.length" and friends → wholesale
        };
        indices.insert(index);
    }
    if indices.is_empty() {
        // Dirty for reasons the hint can't express — run the full pass.
        return false;
    }

    // ── Validate the hint against the live tree ─────────────────────────
    let effective_state = module_scope
        .as_deref()
        .and_then(|scope| modules.and_then(|m| m.get(scope)))
        .map(|m| m.get_state())
        .unwrap_or(state);

    let Some(serde_json::Value::Array(items)) = evaluate_binding_ref(&binding, effective_state)
    else {
        return false;
    };

    let templates: &[IRNode] = match &templates_src {
        Templates::List(element) => &element.ir_children,
        Templates::ForEach(ir) => match &**ir {
            IRNode::ForEach { template, .. } => template.as_slice(),
            _ => return false,
        },
    };
    let template_count = templates.len();
    if template_count == 0 {
        return false;
    }

    let children: Vec<NodeId> = tree
        .get(node_id)
        .map(|n| n.children.iter().copied().collect())
        .unwrap_or_default();
    if children.len() != items.len() * template_count {
        return false; // growth/shrink slipped past the path check
    }

    let multi_template = template_count > 1;
    let mut item_keys: Vec<(usize, String)> = Vec::with_capacity(indices.len());
    for &index in &indices {
        if index >= items.len() {
            return false;
        }
        let item_key = generate_item_key(&items[index], key_path.as_deref(), &item_name, index);
        for template_idx in 0..template_count {
            let child_id = children[index * template_count + template_idx];
            let expected = iterable_child_key(&item_key, template_idx, multi_template);
            let matches = tree
                .get(child_id)
                .and_then(|n| n.key.as_deref())
                .is_some_and(|k| k == expected);
            if !matches {
                return false; // identity change (swap/reorder) → keyed pass
            }
        }
        item_keys.push((index, item_key));
    }

    // ── Reconcile exactly the touched children ──────────────────────────
    // The templates here are always the container node's own stored Arc,
    // so the cached fingerprint is safe (see fingerprint_for_container).
    let templates_hash = match tree.get(node_id).and_then(|n| n.iter_fp_cache) {
        Some(hash) => hash,
        None => {
            let hash = templates_fingerprint(templates);
            if let Some(node) = tree.get_mut(node_id) {
                node.iter_fp_cache = Some(hash);
            }
            hash
        }
    };
    let mut ctx = ReconcileCtx {
        tree,
        state,
        patches,
        dependencies,
        data_sources,
        modules,
    };
    // Compiled binding maps narrow the per-row work further: only the
    // item-dependent props are resolved and diffed, no substituted subtree.
    let compiled = crate::reconcile::binding_map::compiled_for(
        &mut ctx,
        node_id,
        templates,
        &item_name,
        templates_hash,
    );

    for (index, item_key) in item_keys {
        let item = &items[index];
        let item_hash = item_fingerprint(item);
        for (template_idx, template) in templates.iter().enumerate() {
            let child_id = children[index * template_count + template_idx];
            let memo = ctx.tree.get(child_id).and_then(|n| n.iter_memo);
            let memo_hit = memo
                .is_some_and(|m| m.templates_hash == templates_hash && m.item_hash == item_hash);
            if memo_hit {
                continue;
            }
            // Compiled apply is sound only when the child last rendered
            // under this exact template (see keyed.rs) — otherwise static
            // props may have changed and only the full reconcile sees them.
            let same_template = memo.is_some_and(|m| m.templates_hash == templates_hash);
            let fast = same_template
                && compiled
                    .as_deref()
                    .and_then(|c| c.get(template_idx))
                    .is_some_and(|ct| {
                        crate::reconcile::binding_map::apply_compiled_row(
                            &mut ctx, child_id, ct, item, &item_name,
                        )
                    });
            if !fast {
                let substituted =
                    replace_ir_node_item_bindings(template, item, index, &item_name, &item_key);
                reconcile_ir_node_impl(&mut ctx, child_id, &substituted);
            }
            stamp_iter_memo(&mut ctx, child_id, item_hash, templates_hash);
        }
    }

    true
}

/// Render a dirty List node by re-reconciling its children using the
/// shared keyed-iterable reconciliation pipeline.
fn render_dirty_list(
    node_id: NodeId,
    tree: &mut InstanceTree,
    state: &serde_json::Value,
    patches: &mut Vec<Patch>,
    dependencies: &mut DependencyGraph,
    data_sources: Option<&indexmap::IndexMap<String, serde_json::Value>>,
) {
    use crate::reconcile::keyed::reconcile_iterable_children;

    // Pull out the array binding, the per-item template, and the explicit
    // `key:` annotation (if any) from the stored element template.
    let (array_binding, element_template, key_path_owned) = {
        let node = match tree.get(node_id) {
            Some(n) => n,
            None => return,
        };

        let binding = match node.raw_props.get("0") {
            Some(Value::Binding(b)) => b.clone(),
            _ => return,
        };

        let template = match &node.element_template {
            Some(t) => t.clone(),
            None => return,
        };

        let key_path = template.props.get("key.0").and_then(|v| match v {
            Value::Static(serde_json::Value::String(s)) => Some(s.clone()),
            _ => None,
        });

        (binding, template, key_path)
    };

    // Borrow the items straight out of state — `state` and `tree` are
    // disjoint borrows, so the keyed pass can read the array in place.
    // The old `evaluate_binding(..).clone()` chain deep-copied the whole
    // array (twice) on every dirty list render.
    let items: &[serde_json::Value] =
        match crate::reconcile::resolve::evaluate_binding_ref(&array_binding, state) {
            Some(serde_json::Value::Array(items)) => items,
            Some(_) => return,
            None => &[],
        };

    let mut ctx = ReconcileCtx {
        tree,
        state,
        patches,
        dependencies,
        data_sources,
        modules: None,
    };

    reconcile_iterable_children(
        &mut ctx,
        node_id,
        items,
        "item",
        key_path_owned.as_deref(),
        &element_template.ir_children,
        // The template list is this node's own stored Arc — cacheable.
        true,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ir::Element, lifecycle::Module, reactive::Binding};
    use serde_json::json;

    #[test]
    fn test_render_dirty_nodes_no_dirty() {
        let mut scheduler = Scheduler::new();
        let mut tree = InstanceTree::new();

        let patches = render_dirty_nodes(&mut scheduler, &mut tree, None);
        assert_eq!(patches.len(), 0);
    }

    #[test]
    fn test_render_dirty_nodes_with_changes() {
        let mut scheduler = Scheduler::new();
        let mut tree = InstanceTree::new();

        // Create a module with state
        let module = Module::new("TestModule");
        let initial_state = json!({"count": 0});
        let instance = ModuleInstance::new(module, initial_state);

        // Create a node with a binding
        let element = Element::new("Text");
        let node_id = tree.create_node(&element, instance.get_state());

        // Mark the node as dirty
        scheduler.mark_dirty(node_id);

        // Render dirty nodes
        let _patches = render_dirty_nodes(&mut scheduler, &mut tree, Some(&instance));

        // Should have processed the dirty node (though patches may be empty if props didn't change)
        assert!(
            !scheduler.has_dirty(),
            "Scheduler should have no more dirty nodes"
        );
    }

    #[test]
    fn test_render_dirty_nodes_state_change() {
        use crate::ir::Value;

        let mut scheduler = Scheduler::new();
        let mut tree = InstanceTree::new();

        // Create module with initial state
        let module = Module::new("TestModule");
        let initial_state = json!({"text": "Hello"});
        let mut instance = ModuleInstance::new(module, initial_state);

        // Create a node with a binding to state
        let mut element = Element::new("Text");
        element.props.insert(
            "0".to_string(),
            Value::Binding(Binding::state(vec!["text".to_string()])),
        );
        let node_id = tree.create_node(&element, instance.get_state());

        // Update the node's props to reflect initial state
        if let Some(node) = tree.get_mut(node_id) {
            node.update_props(instance.get_state());
        }

        // Update state
        instance.update_state(json!({"text": "World"}));

        // Mark node as dirty
        scheduler.mark_dirty(node_id);

        // Render dirty nodes
        let patches = render_dirty_nodes(&mut scheduler, &mut tree, Some(&instance));

        // Should generate a SetProp patch for the changed text
        let set_prop_count = patches
            .iter()
            .filter(|p| matches!(p, Patch::SetProp { .. }))
            .count();
        assert!(
            set_prop_count > 0,
            "Should have SetProp patches for changed state"
        );
    }

    #[test]
    fn dirty_node_with_templated_name_emits_set_semantics() {
        use crate::ir::{Semantics, Value};

        let mut scheduler = Scheduler::new();
        let mut tree = InstanceTree::new();

        let module = Module::new("TestModule");
        let mut instance = ModuleInstance::new(module, json!({"label": "Save"}));

        // A Button whose accessible name rides the templated `0` prop.
        let mut element = Element::new("Button");
        element.props.insert(
            "0".to_string(),
            Value::Binding(Binding::state(vec!["label".to_string()])),
        );
        element.semantics = Semantics::derive(&element);
        let node_id = tree.create_node(&element, instance.get_state());
        // Simulate the create-time emit: resolve + record last_semantics,
        // exactly as create_element_node does.
        if let Some(node) = tree.get_mut(node_id) {
            node.update_props(instance.get_state());
            node.last_semantics =
                crate::reconcile::diff::resolve_semantics(node.semantics.as_deref(), &node.props)
                    .map(Box::new);
            assert_eq!(
                node.last_semantics.as_ref().and_then(|s| s.name.as_deref()),
                Some("Save")
            );
        }

        // The bound path changes → dirty render emits SetSemantics with the
        // freshly-resolved name.
        instance.update_state(json!({"label": "Submit"}));
        scheduler.mark_dirty(node_id);
        let patches = render_dirty_nodes(&mut scheduler, &mut tree, Some(&instance));

        let blocks: Vec<_> = patches
            .iter()
            .filter_map(|p| match p {
                Patch::SetSemantics { semantics, .. } => Some(semantics.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(blocks.len(), 1, "got {patches:?}");
        assert_eq!(
            blocks[0].as_ref().and_then(|s| s.name.as_deref()),
            Some("Submit")
        );

        // A no-op re-render emits nothing further.
        scheduler.mark_dirty(node_id);
        let patches = render_dirty_nodes(&mut scheduler, &mut tree, Some(&instance));
        assert!(
            !patches
                .iter()
                .any(|p| matches!(p, Patch::SetSemantics { .. })),
            "unchanged semantics must not re-emit, got {patches:?}"
        );
    }

    #[test]
    fn test_render_dirty_nodes_multiple_nodes() {
        let mut scheduler = Scheduler::new();
        let mut tree = InstanceTree::new();

        let module = Module::new("TestModule");
        let initial_state = json!({});
        let instance = ModuleInstance::new(module, initial_state);

        // Create multiple nodes
        let element1 = Element::new("Text");
        let element2 = Element::new("Text");
        let element3 = Element::new("Text");

        let node_id_1 = tree.create_node(&element1, instance.get_state());
        let _node_id_2 = tree.create_node(&element2, instance.get_state());
        let node_id_3 = tree.create_node(&element3, instance.get_state());

        // Mark only some nodes as dirty
        scheduler.mark_dirty(node_id_1);
        scheduler.mark_dirty(node_id_3);

        // Should have 2 dirty nodes
        assert!(scheduler.has_dirty());

        render_dirty_nodes(&mut scheduler, &mut tree, Some(&instance));

        // All dirty nodes should be processed
        assert!(!scheduler.has_dirty());
    }
}
