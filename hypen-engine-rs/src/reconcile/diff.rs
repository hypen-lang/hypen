use super::conditionals::{evaluate_value, find_matching_branch, find_matching_route_with_key};
use super::item_bindings::replace_ir_node_item_bindings;
use super::keyed::{
    generate_item_key, iterable_child_key, reconcile_iterable_children,
    reconcile_iterable_children_full,
};
use super::resolve::{evaluate_binding_ref, resolve_props_full};
use super::tree::DEFAULT_ROUTER_CACHE_SIZE;
use super::{ControlFlowKind, InstanceTree, Patch};
use crate::ir::{Element, IRNode, NodeId, Props, RouterRoute, Value};
use crate::reactive::DependencyGraph;
use indexmap::IndexMap;

/// Data sources type alias for readability
type DataSources = indexmap::IndexMap<String, serde_json::Value>;

/// Module instances map type alias
type Modules = indexmap::IndexMap<String, crate::lifecycle::ModuleInstance>;

/// Resolve a node's derive-time (base) semantics against resolved props —
/// templated accessible names and bound self-state/checked fold in exactly
/// as at the Create sites. The single resolution rule shared by initial
/// create and the reactive [`Patch::SetSemantics`] delta paths.
pub(crate) fn resolve_semantics(
    base: &Option<crate::ir::Semantics>,
    resolved_props: &IndexMap<String, serde_json::Value>,
) -> Option<crate::ir::Semantics> {
    base.clone().map(|s| {
        s.with_resolved_name(resolved_props)
            .with_resolved_state(resolved_props)
    })
}

/// Compare a node's freshly-resolved semantics against the block last sent
/// to the renderer and emit a [`Patch::SetSemantics`] when they differ,
/// recording the new block as last-sent. No-op for nodes whose semantics
/// never had bindings (resolution is then a fixed point, so the comparison
/// stays equal and static trees pay nothing beyond the `PartialEq`).
pub(crate) fn emit_semantics_delta(
    tree: &mut InstanceTree,
    node_id: NodeId,
    patches: &mut Vec<Patch>,
) {
    let Some(node) = tree.get(node_id) else {
        return;
    };
    // Fast path: a node that never carried semantics can't gain any —
    // derivation happens at expand, not reconcile.
    if node.semantics.is_none() && node.last_semantics.is_none() {
        return;
    }
    let new_semantics = resolve_semantics(&node.semantics, &node.props);
    if new_semantics != node.last_semantics {
        patches.push(Patch::set_semantics(node_id, new_semantics.clone()));
        if let Some(node) = tree.get_mut(node_id) {
            node.last_semantics = new_semantics;
        }
    }
}

/// Shared mutable context threaded through the recursive tree-building and
/// reconciliation helpers.  Grouping these fields removes the repetitive
/// parameter tuple that was being copy-pasted across every internal function.
pub(crate) struct ReconcileCtx<'a> {
    pub tree: &'a mut InstanceTree,
    pub state: &'a serde_json::Value,
    pub patches: &'a mut Vec<Patch>,
    pub dependencies: &'a mut DependencyGraph,
    pub data_sources: Option<&'a DataSources>,
    pub modules: Option<&'a Modules>,
}

impl<'a> ReconcileCtx<'a> {
    /// Resolve a raw `module_scope` to its effective form.
    ///
    /// Returns `Some(scope)` only when the named module is actually registered
    /// in `ctx.modules`. When the scope name has no matching named module
    /// (e.g. the legacy "wrap your primary module's DSL in `module App { ... }`"
    /// pattern), this returns `None` so dependency registration falls back to
    /// raw paths and state lookup falls back to the primary module's state.
    pub(crate) fn effective_scope<'s>(&self, raw: Option<&'s str>) -> Option<&'s str> {
        raw.filter(|scope| {
            self.modules
                .map(|m| m.contains_key(*scope))
                .unwrap_or(false)
        })
    }

    /// Resolve the state slot to read bindings against.
    ///
    /// Returns the named module's state when `effective_scope` matches a
    /// registered module, otherwise the primary state from the context.
    pub(crate) fn effective_state(&self, raw_scope: Option<&str>) -> &'a serde_json::Value {
        match self.effective_scope(raw_scope) {
            Some(scope) => self
                .modules
                .and_then(|m| m.get(scope))
                .map(|m| m.get_state())
                .unwrap_or(self.state),
            None => self.state,
        }
    }
}

/// Reconcile an IRNode tree against the instance tree and generate patches
/// This is the primary entry point for the IRNode-based reconciliation system,
/// which supports first-class ForEach, When/If, and custom item variable names.
pub fn reconcile_ir(
    tree: &mut InstanceTree,
    node: &IRNode,
    parent_id: Option<NodeId>,
    state: &serde_json::Value,
    dependencies: &mut DependencyGraph,
) -> Vec<Patch> {
    reconcile_ir_with_ds(tree, node, parent_id, state, dependencies, None, None)
}

/// Reconcile an IRNode tree with data source context
pub fn reconcile_ir_with_ds(
    tree: &mut InstanceTree,
    node: &IRNode,
    parent_id: Option<NodeId>,
    state: &serde_json::Value,
    dependencies: &mut DependencyGraph,
    data_sources: Option<&DataSources>,
    modules: Option<&indexmap::IndexMap<String, crate::lifecycle::ModuleInstance>>,
) -> Vec<Patch> {
    let mut patches = Vec::new();

    // For initial render, create the tree
    if tree.root().is_none() {
        let mut ctx = ReconcileCtx {
            tree,
            state,
            patches: &mut patches,
            dependencies,
            data_sources,
            modules,
        };
        let node_id = create_ir_node_tree_impl(&mut ctx, node, parent_id, true);
        ctx.tree.set_root(node_id);
        return patches;
    }

    // Incremental update: reconcile root against existing tree
    if let Some(root_id) = tree.root() {
        let mut ctx = ReconcileCtx {
            tree,
            state,
            patches: &mut patches,
            dependencies,
            data_sources,
            modules,
        };
        reconcile_ir_node_impl(&mut ctx, root_id, node);
    }

    patches
}

/// Create a tree node for an `Element`.
///
/// Used by the IRNode dispatcher's `IRNode::Element` arm. The
/// `render_parent` parameter exists so control-flow constructs (ForEach,
/// Conditional, Router) can mount their children's tree slot under the
/// CFN container while emitting the actual `Insert` patch into the
/// CFN's grandparent — the renderer treats CFN containers as transparent.
/// When `render_parent == logical_parent` the two parameters collapse
/// to the normal "render where the tree puts it" behavior.
fn create_element_node(
    ctx: &mut ReconcileCtx,
    element: &Element,
    logical_parent: Option<NodeId>,
    render_parent: Option<NodeId>,
    is_root: bool,
) -> NodeId {
    let module_scope_ref = ctx.effective_scope(element.module_scope.as_deref());
    let effective_state = ctx.effective_state(element.module_scope.as_deref());

    // Iterable element fast-path (List, Grid, …) — only valid in the
    // "normal" path where logical and render parents agree, since
    // create_list_tree_impl emits its own Insert patches against the
    // tree-side parent.
    if logical_parent == render_parent {
        if let Some(Value::Binding(_)) = element.props.get("0") {
            if !element.ir_children.is_empty() {
                return create_list_tree_impl(ctx, element, logical_parent, is_root);
            }
        }
    }

    // Allocate the node and register reactive dependencies for every
    // binding in its props.
    let node_id = ctx
        .tree
        .create_node_full(element, effective_state, ctx.data_sources);

    for value in element.props.values() {
        match value {
            Value::Binding(binding) => {
                ctx.dependencies
                    .add_dependency(node_id, binding, module_scope_ref);
            }
            Value::TemplateString { bindings, .. } => {
                for binding in bindings {
                    ctx.dependencies
                        .add_dependency(node_id, binding, module_scope_ref);
                }
            }
            Value::StateSwitch { path, .. } => {
                // `.states` driving path registers exactly like a Binding —
                // state changes dirty the node and pose flips flow out as
                // ordinary SetProp/RemoveProp.
                ctx.dependencies.add_dependency(
                    node_id,
                    &state_switch_binding(path),
                    module_scope_ref,
                );
            }
            _ => {}
        }
    }

    // Build the Create patch payload. Lazy elements stash the first
    // child's component name in a `__lazy_child` prop so renderers know
    // what to fetch when the user activates the slot.
    let is_lazy = element
        .props
        .get("__lazy")
        .and_then(|v| match v {
            Value::Static(val) => val.as_bool(),
            _ => None,
        })
        .unwrap_or(false);

    let mut props = ctx
        .tree
        .get(node_id)
        .map(|n| n.props.clone())
        .unwrap_or_else(|| std::sync::Arc::new(indexmap::IndexMap::new()));
    if is_lazy && !element.ir_children.is_empty() {
        if let Some(IRNode::Element(first_child)) = element.ir_children.first() {
            // Copy-on-write: only clone the map if it's still shared with
            // the InstanceNode we pulled it from.
            std::sync::Arc::make_mut(&mut props).insert(
                "__lazy_child".to_string(),
                serde_json::json!(first_child.element_type),
            );
        }
    }
    // Resolve any deferred (templated) accessible name from the now-resolved
    // props before emitting the Create patch, and remember the resolved
    // block so later dirty re-renders can diff against it (SetSemantics).
    let semantics = resolve_semantics(&element.semantics, &props);
    if let Some(node) = ctx.tree.get_mut(node_id) {
        node.last_semantics = semantics.clone();
    }
    strip_engine_internal_props(&mut props);
    ctx.patches.push(Patch::create(
        node_id,
        element.element_type.clone(),
        props,
        semantics,
    ));

    // Tree-side: hang the node off its logical parent.
    if let Some(parent) = logical_parent {
        ctx.tree.add_child(parent, node_id, None);
    }

    // Patch-side: emit Insert into render_parent when set; otherwise
    // fall back to "root" (for root-level children of a control-flow
    // container whose own NodeId is not known to the renderer) before
    // finally falling through to the logical parent (which only fires
    // when render_parent was omitted by a caller that passed the same
    // parent for both).
    if let Some(rp) = render_parent {
        ctx.patches.push(Patch::insert(rp, node_id, None));
    } else if is_root {
        ctx.patches.push(Patch::insert_root(node_id));
    } else if let Some(lp) = logical_parent {
        ctx.patches.push(Patch::insert(lp, node_id, None));
    }

    // Recurse into children (skipped for lazy elements). Module-scoped
    // state propagates so `${state.x}` inside the subtree resolves
    // against the right module slot.
    if !is_lazy {
        let old_state = ctx.state;
        ctx.state = effective_state;
        for child_ir in &element.ir_children {
            create_ir_node_tree_impl(ctx, child_ir, Some(node_id), false);
        }
        ctx.state = old_state;
    }

    node_id
}

/// Substitution-path creation of one list row — the fallback when no row
/// prototype applies (unplannable template). Identical to the historical
/// per-row body: substitute, create, collapse the run into an Instantiate
/// when the plan allows.
#[allow(clippy::too_many_arguments)]
fn create_list_row_slow(
    ctx: &mut ReconcileCtx,
    child_ir: &IRNode,
    item: &serde_json::Value,
    index: usize,
    item_key: &str,
    node_id: NodeId,
    instantiation_plans: &Option<Vec<Option<crate::reconcile::binding_map::InstantiationPlan>>>,
    template_idx: usize,
) -> NodeId {
    let child_with_item = replace_ir_node_item_bindings(child_ir, item, index, "item", item_key);
    let mark = ctx.patches.len();
    let child_id = create_ir_node_tree_impl(ctx, &child_with_item, Some(node_id), false);
    crate::reconcile::binding_map::emit_row_as_instantiate(
        ctx,
        instantiation_plans,
        template_idx,
        mark,
        node_id,
    );
    child_id
}

/// Create an iterable element (List, Grid, etc.) that iterates over an array in state
fn create_list_tree_impl(
    ctx: &mut ReconcileCtx,
    element: &Element,
    parent_id: Option<NodeId>,
    is_root: bool,
) -> NodeId {
    let module_scope_ref = ctx.effective_scope(element.module_scope.as_deref());
    let effective_state = ctx.effective_state(element.module_scope.as_deref());

    // Get the array binding from first prop (prop "0"). Borrowed straight
    // out of state — `state` and `tree` are disjoint borrows in
    // `ReconcileCtx`, so there is no reason to deep-copy the whole bound
    // array just to iterate it once.
    let array: Option<&serde_json::Value> = match element.props.get("0") {
        Some(Value::Binding(binding)) => evaluate_binding_ref(binding, effective_state),
        _ => None,
    };

    // Create a container element - use the original element type (List, Grid, etc.)
    // but remove the "0" prop since it's only for iteration, not rendering
    let mut list_element = Element::new(&element.element_type);
    for (key, value) in &element.props {
        if key != "0" {
            list_element.props.insert(key.clone(), value.clone());
        }
    }

    let node_id = ctx
        .tree
        .create_node_full(&list_element, effective_state, ctx.data_sources);

    // Register the List node as depending on the array binding
    if let Some(Value::Binding(binding)) = element.props.get("0") {
        ctx.dependencies
            .add_dependency(node_id, binding, module_scope_ref);
    }

    // Store the original element template for re-reconciliation
    if let Some(node) = ctx.tree.get_mut(node_id) {
        node.raw_props = element.props.clone();
        node.element_template = Some(std::sync::Arc::new(element.clone()));
    }

    // Generate Create patch for container
    let node = ctx.tree.get(node_id).unwrap();
    let semantics = resolve_semantics(&node.semantics, &node.props);
    let (element_type, mut props) = (node.element_type.clone(), node.props.clone());
    if let Some(node) = ctx.tree.get_mut(node_id) {
        node.last_semantics = semantics.clone();
    }
    strip_engine_internal_props(&mut props);
    ctx.patches
        .push(Patch::create(node_id, element_type, props, semantics));

    // Insert container
    if let Some(parent) = parent_id {
        ctx.tree.add_child(parent, node_id, None);
        ctx.patches.push(Patch::insert(parent, node_id, None));
    } else if is_root {
        ctx.patches.push(Patch::insert_root(node_id));
    }

    // Create children for each item in the array. Stamp every per-template
    // child with a key so the next reconcile can match by identity instead
    // of position.
    if let Some(serde_json::Value::Array(items)) = array {
        let key_path = element.props.get("key.0").and_then(|v| match v {
            Value::Static(serde_json::Value::String(s)) => Some(s.as_str()),
            _ => None,
        });
        let multi_template = element.ir_children.len() > 1;
        // Warm the iterable memo at creation (see create_foreach_ir_tree):
        // the first re-reconcile then skips unchanged items outright.
        let templates_hash = crate::reconcile::keyed::templates_fingerprint(&element.ir_children);
        // This node's stored template IS this element — warm the cache so
        // the first update pass skips the serialization.
        if let Some(node) = ctx.tree.get_mut(node_id) {
            node.iter_fp_cache = Some(templates_hash);
        }
        let instantiation_plans = Some(crate::reconcile::binding_map::plan_templates_for_emission(
            &element.ir_children,
        ));
        // Row prototypes, built lazily on the first row that can use one:
        // static + state-bound props resolve once here, and each row is an
        // Arc-clone + item overlay instead of substitution + full resolve.
        let mut row_protos: Vec<Option<Option<crate::reconcile::binding_map::RowPrototype>>> =
            (0..element.ir_children.len()).map(|_| None).collect();

        for (index, item) in items.iter().enumerate() {
            let item_key = generate_item_key(item, key_path, "item", index);
            let item_hash = crate::reconcile::keyed::item_fingerprint(item);

            for (template_idx, child_ir) in element.ir_children.iter().enumerate() {
                let child_key = if multi_template {
                    format!("{}#{}", item_key, template_idx)
                } else {
                    item_key.clone()
                };
                let plan = instantiation_plans
                    .as_ref()
                    .and_then(|plans| plans.get(template_idx))
                    .and_then(Option::as_ref);
                let child_id = if let Some(plan) = plan {
                    if row_protos[template_idx].is_none() {
                        row_protos[template_idx] =
                            Some(crate::reconcile::binding_map::build_row_prototype(
                                ctx, child_ir, "item",
                            ));
                    }
                    match row_protos[template_idx].as_ref().and_then(Option::as_ref) {
                        Some(proto) => crate::reconcile::binding_map::instantiate_row_from_proto(
                            ctx, proto, plan, item, "item", node_id, node_id,
                        ),
                        None => create_list_row_slow(
                            ctx,
                            child_ir,
                            item,
                            index,
                            &item_key,
                            node_id,
                            &instantiation_plans,
                            template_idx,
                        ),
                    }
                } else {
                    create_list_row_slow(
                        ctx,
                        child_ir,
                        item,
                        index,
                        &item_key,
                        node_id,
                        &instantiation_plans,
                        template_idx,
                    )
                };
                if let Some(child_node) = ctx.tree.get_mut(child_id) {
                    child_node.key = Some(child_key);
                }
                crate::reconcile::keyed::stamp_iter_memo(ctx, child_id, item_hash, templates_hash);
            }
        }
    }

    node_id
}

/// Reconcile an existing tree node against a new `Element`.
///
/// Inlined into [`reconcile_ir_node_impl`]'s `IRNode::Element` arm — there
/// is no public Element-only entry point any more, so this stays private
/// and lives next to the IR dispatcher that calls it.
fn reconcile_element_node(ctx: &mut ReconcileCtx, node_id: NodeId, element: &Element) {
    // Existence check only — the fields this function needs are read one at
    // a time below. Cloning the whole `InstanceNode` up front cost 4-8
    // allocations (element_type String, semantics, boxed caches) per
    // reconciled node, and `reconcile_ir_node_impl` had already paid for
    // one clone before calling in here.
    if ctx.tree.get(node_id).is_none() {
        return;
    }

    let effective_state = ctx.effective_state(element.module_scope.as_deref());
    let module_scope_ref = element.module_scope.as_deref();

    // Special handling for iterable elements (List, Grid, …) — the source
    // array binding lives in props["0"] and the per-item template is in
    // ir_children.
    let is_iterable = element.props.get("0").is_some() && !element.ir_children.is_empty();

    if is_iterable {
        // Borrowed, not cloned: see `create_list_tree_impl`.
        let array: Option<&serde_json::Value> = match element.props.get("0") {
            Some(Value::Binding(binding)) => evaluate_binding_ref(binding, effective_state),
            _ => None,
        };

        if let Some(serde_json::Value::Array(items)) = array {
            // Look for an explicit `key:` prop on the iterable element so
            // `Grid(@items, key: "uuid")` overrides the default id auto-detect.
            let key_path = element.props.get("key.0").and_then(|v| match v {
                Value::Static(serde_json::Value::String(s)) => Some(s.as_str()),
                _ => None,
            });

            reconcile_iterable_children(
                ctx,
                node_id,
                items,
                "item",
                key_path,
                &element.ir_children,
                // Incoming IR — nested lists arrive freshly substituted, so
                // the fingerprint cache must not be consulted.
                false,
            );
        }

        return;
    }

    // If element type changed, replace the entire subtree.
    let type_changed = ctx
        .tree
        .get(node_id)
        .is_some_and(|n| n.element_type != element.element_type);
    if type_changed {
        let parent_id = ctx.tree.get(node_id).and_then(|n| n.parent);
        replace_subtree_impl(ctx, node_id, parent_id, element);
        return;
    }

    // Register dependencies for every binding in the new props.
    for value in element.props.values() {
        match value {
            Value::Binding(binding) => {
                ctx.dependencies
                    .add_dependency(node_id, binding, module_scope_ref);
            }
            Value::TemplateString { bindings, .. } => {
                for binding in bindings {
                    ctx.dependencies
                        .add_dependency(node_id, binding, module_scope_ref);
                }
            }
            Value::StateSwitch { path, .. } => {
                ctx.dependencies.add_dependency(
                    node_id,
                    &state_switch_binding(path),
                    module_scope_ref,
                );
            }
            _ => {}
        }
    }

    // Diff and apply prop changes. The old props are read straight off the
    // node (`tree` and `patches` are disjoint fields of the context, so the
    // shared borrow and the patch push coexist).
    let new_props = resolve_props_full(&element.props, effective_state, None, ctx.data_sources);
    if let Some(node) = ctx.tree.get(node_id) {
        let prop_patches = diff_props(node_id, &node.props, &new_props);
        ctx.patches.extend(prop_patches);
    }

    if let Some(node) = ctx.tree.get_mut(node_id) {
        node.props = new_props; // move the Arc directly — no extra clone
        node.raw_props = element.props.clone();
    }

    // Re-resolve semantics against the fresh props; emit SetSemantics when
    // the block a renderer holds went stale (templated name, bound state).
    emit_semantics_delta(ctx.tree, node_id, ctx.patches);

    // Reconcile children (skip when this element is lazy — the renderer
    // hasn't asked for the subtree yet).
    let is_lazy = element
        .props
        .get("__lazy")
        .and_then(|v| match v {
            Value::Static(val) => val.as_bool(),
            _ => None,
        })
        .unwrap_or(false);

    if !is_lazy {
        // `im::Vector` clone is a refcount bump, not a copy.
        let old_children = match ctx.tree.get(node_id) {
            Some(node) => node.children.clone(),
            None => return,
        };
        let new_children = &element.ir_children;

        for (i, new_child_ir) in new_children.iter().enumerate() {
            if let Some(&old_child_id) = old_children.get(i) {
                reconcile_ir_node_impl(ctx, old_child_id, new_child_ir);
            } else {
                create_ir_node_tree_impl(ctx, new_child_ir, Some(node_id), false);
            }
        }

        if old_children.len() > new_children.len() {
            let doomed: Vec<NodeId> = old_children
                .iter()
                .skip(new_children.len())
                .copied()
                .collect();
            for &old_child_id in &doomed {
                emit_subtree_removal(ctx.tree, old_child_id, ctx.patches, ctx.dependencies);
                ctx.tree.remove(old_child_id);
            }
            // Unlink all of them in ONE pass over the parent's child vector.
            // `InstanceTree::remove_child` rebuilds the whole `im::Vector`,
            // so calling it per doomed child made this loop O(n²).
            if let Some(parent) = ctx.tree.get_mut(node_id) {
                parent.children.retain(|id| !doomed.contains(id));
            }
        }
    }
}

/// Replace an entire subtree when element types don't match.
fn replace_subtree_impl(
    ctx: &mut ReconcileCtx,
    old_node_id: NodeId,
    parent_id: Option<NodeId>,
    new_element: &Element,
) {
    let old_position = if let Some(pid) = parent_id {
        ctx.tree
            .get(pid)
            .and_then(|parent| parent.children.iter().position(|&id| id == old_node_id))
    } else {
        None
    };

    emit_subtree_removal(ctx.tree, old_node_id, ctx.patches, ctx.dependencies);

    // Unlink by index — the old filter-collect rebuilt the parent's entire
    // child vector to drop a single entry.
    if let (Some(pid), Some(pos)) = (parent_id, old_position) {
        if let Some(parent) = ctx.tree.get_mut(pid) {
            if parent.children.get(pos) == Some(&old_node_id) {
                parent.children.remove(pos);
            }
        }
    }

    ctx.tree.remove(old_node_id);

    let is_root = parent_id.is_none();
    let new_node_id = create_element_node(ctx, new_element, parent_id, parent_id, is_root);

    if is_root {
        ctx.tree.set_root(new_node_id);
    } else if let Some(pid) = parent_id {
        if let Some(pos) = old_position {
            if let Some(parent) = ctx.tree.get_mut(pid) {
                let current_len = parent.children.len();
                if pos < current_len - 1 {
                    let new_id = parent.children.pop_back().unwrap();
                    parent.children.insert(pos, new_id);
                    let next_sibling = parent.children.get(pos + 1).copied();
                    ctx.patches
                        .push(Patch::move_node(pid, new_node_id, next_sibling));
                }
            }
        }
    }
}

/// Collect all node IDs in a subtree (post-order: children before parents)
fn collect_subtree_ids(tree: &InstanceTree, root_id: NodeId) -> Vec<NodeId> {
    let mut result = Vec::new();
    let mut stack: Vec<(NodeId, bool)> = vec![(root_id, false)];

    while let Some((node_id, children_processed)) = stack.pop() {
        if children_processed {
            result.push(node_id);
        } else {
            stack.push((node_id, true));
            if let Some(node) = tree.get(node_id) {
                for &child_id in node.children.iter().rev() {
                    stack.push((child_id, false));
                }
            }
        }
    }

    result
}

/// The state `Binding` equivalent of a `Value::StateSwitch` driving path,
/// so `.states` nodes register in the dependency graph exactly like a
/// `@{state.<path>}` binding (including module-scope namespacing).
pub(crate) fn state_switch_binding(path: &str) -> crate::reactive::Binding {
    crate::reactive::Binding::state(path.split('.').map(str::to_string).collect())
}

/// Engine-internal carrier props: kept in `InstanceNode` resolved props so
/// `resolve_semantics` and dependency-driven re-renders can read them, but
/// never emitted to renderers — their payload already reaches every renderer
/// as the typed `Semantics` block on `Create`/`SetSemantics`.
pub(crate) fn is_engine_internal_prop(key: &str) -> bool {
    key == "__a11yName"
}

/// Copy-on-write strip of engine-internal props before a `Patch::Create`:
/// clones the shared map only when such a key is actually present, so the
/// common no-hoist case stays an `Arc::clone`. Must run *after*
/// `resolve_semantics`, which reads the carrier props.
fn strip_engine_internal_props(props: &mut super::tree::ResolvedProps) {
    if props.keys().any(|k| is_engine_internal_prop(k)) {
        std::sync::Arc::make_mut(props).retain(|k, _| !is_engine_internal_prop(k));
    }
}

/// Diff two sets of props and generate SetProp/RemoveProp patches
pub fn diff_props(
    node_id: NodeId,
    old_props: &IndexMap<String, serde_json::Value>,
    new_props: &IndexMap<String, serde_json::Value>,
) -> Vec<Patch> {
    let mut patches = Vec::new();

    for (key, new_value) in new_props {
        if is_engine_internal_prop(key) {
            continue;
        }
        if old_props.get(key) != Some(new_value) {
            patches.push(Patch::set_prop(node_id, key.clone(), new_value.clone()));
        }
    }

    for key in old_props.keys() {
        if is_engine_internal_prop(key) {
            continue;
        }
        if !new_props.contains_key(key) {
            patches.push(Patch::remove_prop(node_id, key.clone()));
        }
    }

    patches
}

// ============================================================================
// IRNode-based reconciliation (first-class control flow constructs)
// ============================================================================

/// Create a tree from an IRNode using a `ReconcileCtx`.
///
/// Convenience wrapper that uses the same node for both logical (tree)
/// and render (patch) parents — the common case.
pub(crate) fn create_ir_node_tree_impl(
    ctx: &mut ReconcileCtx,
    node: &IRNode,
    parent_id: Option<NodeId>,
    is_root: bool,
) -> NodeId {
    create_ir_node_tree_full(ctx, node, parent_id, parent_id, is_root)
}

/// Resolve the nearest ancestor a renderer actually knows about.
///
/// Control-flow containers (`__ForEach` / `__Conditional` / `__Router`)
/// are transparent on the renderer side: they never receive a `Create`
/// patch, so an `Insert`/`Move`/`Attach` whose parent names one is
/// silently dropped. Walk up the instance tree from `start` (inclusive)
/// until a non-control-flow node is found. `None` means the chain is all
/// control flow up to the root — callers then address "root".
fn nearest_render_parent(tree: &InstanceTree, start: Option<NodeId>) -> Option<NodeId> {
    let mut current = start;
    while let Some(id) = current {
        match tree.get(id) {
            Some(node) if node.control_flow.is_some() => current = node.parent,
            Some(_) => return Some(id),
            None => return None,
        }
    }
    None
}

/// Create a tree from an IRNode with separate logical and render parents.
///
/// `logical_parent` controls where the new node lives in the instance
/// tree; `render_parent` controls which parent the `Insert` patch
/// references. They diverge for control-flow children — a ForEach item
/// is logically owned by the ForEach container, but its `Insert` patch
/// targets the ForEach's grandparent because the renderer treats the
/// container as transparent.
pub(crate) fn create_ir_node_tree_full(
    ctx: &mut ReconcileCtx,
    node: &IRNode,
    logical_parent: Option<NodeId>,
    render_parent: Option<NodeId>,
    is_root: bool,
) -> NodeId {
    match node {
        IRNode::Element(element) => {
            create_element_node(ctx, element, logical_parent, render_parent, is_root)
        }
        IRNode::ForEach { .. } | IRNode::Conditional { .. } | IRNode::Router { .. } => {
            // Control-flow containers live under the logical parent in the
            // tree, but their children's Insert patches must keep targeting
            // the incoming render parent: collapsing the two would re-parent
            // e.g. a ForEach item's subtree onto the ForEach container
            // itself when the item root is another control-flow node (an If
            // per item), and the renderer would drop it.
            create_control_flow_tree(ctx, node, logical_parent, render_parent, is_root)
        }
    }
}

/// Create a ForEach or Conditional tree from an IRNode, destructuring inside.
fn create_control_flow_tree(
    ctx: &mut ReconcileCtx,
    node: &IRNode,
    parent_id: Option<NodeId>,
    render_parent: Option<NodeId>,
    is_root: bool,
) -> NodeId {
    match node {
        IRNode::ForEach { .. } => {
            create_foreach_ir_tree(ctx, node, parent_id, render_parent, is_root)
        }
        IRNode::Conditional {
            value,
            branches,
            fallback,
            ..
        } => create_conditional_tree(
            ctx,
            value,
            branches,
            fallback.as_deref(),
            node,
            parent_id,
            render_parent,
            is_root,
        ),
        IRNode::Router {
            location,
            routes,
            fallback,
            ..
        } => create_router_tree(
            ctx,
            location,
            routes,
            fallback.as_deref(),
            node,
            parent_id,
            render_parent,
            is_root,
        ),
        IRNode::Element(_) => unreachable!("create_control_flow_tree called with Element"),
    }
}

/// Create a ForEach iteration tree from IRNode::ForEach
fn create_foreach_ir_tree(
    ctx: &mut ReconcileCtx,
    node: &IRNode,
    parent_id: Option<NodeId>,
    render_parent_hint: Option<NodeId>,
    is_root: bool,
) -> NodeId {
    let (source, item_name, key_path, template, props, raw_scope) = match node {
        IRNode::ForEach {
            source,
            item_name,
            key_path,
            template,
            props,
            module_scope,
        } => (
            source,
            item_name.as_str(),
            key_path.as_deref(),
            template.as_slice(),
            props,
            module_scope.as_deref(),
        ),
        _ => unreachable!("create_foreach_ir_tree called with non-ForEach node"),
    };

    // Resolve scope: only "real" if a named module is registered.
    let module_scope_ref = ctx.effective_scope(raw_scope);
    let effective_state = ctx.effective_state(raw_scope);

    // Borrowed out of state, not cloned — the array is only iterated here.
    let array = evaluate_binding_ref(source, effective_state);

    let resolved_props = resolve_props_full(props, effective_state, None, ctx.data_sources);

    let node_id = ctx.tree.create_control_flow_node(
        "__ForEach",
        resolved_props,
        props.clone(),
        ControlFlowKind::ForEach {
            item_name: item_name.to_string(),
            key_path: key_path.map(|s| s.to_string()),
        },
        node.clone(),
    );

    ctx.dependencies
        .add_dependency(node_id, source, module_scope_ref);

    if let Some(parent) = parent_id {
        ctx.tree.add_child(parent, node_id, None);
    }

    // Items must be inserted under a node the renderer knows: the hint may
    // itself be a control-flow container (this ForEach nested directly
    // under an If, or handed a container by a rebuild path), so normalize
    // to the nearest real element ancestor.
    let render_parent = nearest_render_parent(ctx.tree, render_parent_hint.or(parent_id));

    if let Some(serde_json::Value::Array(items)) = array {
        let multi_template = template.len() > 1;
        // Same fingerprint the keyed reconciler will compute for this
        // template list — stamping it here means the FIRST re-reconcile
        // already memo-skips unchanged items instead of paying one full
        // substitution pass to warm the memo.
        let templates_hash = crate::reconcile::keyed::templates_fingerprint(template);
        if let Some(node) = ctx.tree.get_mut(node_id) {
            node.iter_fp_cache = Some(templates_hash);
        }
        // Template emission needs a concrete render parent to address the
        // Instantiate at; a root-level ForEach falls back to plain patches.
        let instantiation_plans = render_parent
            .map(|_| crate::reconcile::binding_map::plan_templates_for_emission(template));
        let mut row_protos: Vec<Option<Option<crate::reconcile::binding_map::RowPrototype>>> =
            (0..template.len()).map(|_| None).collect();

        for (index, item) in items.iter().enumerate() {
            let item_key = generate_item_key(item, key_path, item_name, index);
            let item_hash = crate::reconcile::keyed::item_fingerprint(item);

            for (template_idx, child_template) in template.iter().enumerate() {
                let plan = render_parent.and(
                    instantiation_plans
                        .as_ref()
                        .and_then(|plans| plans.get(template_idx))
                        .and_then(Option::as_ref),
                );
                if let (Some(plan), Some(rp)) = (plan, render_parent) {
                    if row_protos[template_idx].is_none() {
                        row_protos[template_idx] =
                            Some(crate::reconcile::binding_map::build_row_prototype(
                                ctx,
                                child_template,
                                item_name,
                            ));
                    }
                    if let Some(proto) = row_protos[template_idx].as_ref().and_then(Option::as_ref)
                    {
                        let child_id = crate::reconcile::binding_map::instantiate_row_from_proto(
                            ctx, proto, plan, item, item_name, node_id, rp,
                        );
                        if let Some(child_node) = ctx.tree.get_mut(child_id) {
                            child_node.key =
                                Some(iterable_child_key(&item_key, template_idx, multi_template));
                        }
                        crate::reconcile::keyed::stamp_iter_memo(
                            ctx,
                            child_id,
                            item_hash,
                            templates_hash,
                        );
                        continue;
                    }
                }
                let child_with_item = replace_ir_node_item_bindings(
                    child_template,
                    item,
                    index,
                    item_name,
                    &item_key,
                );
                let mark = ctx.patches.len();
                let child_id = create_ir_node_tree_full(
                    ctx,
                    &child_with_item,
                    Some(node_id),
                    render_parent,
                    is_root && render_parent.is_none(),
                );
                if let Some(rp) = render_parent {
                    crate::reconcile::binding_map::emit_row_as_instantiate(
                        ctx,
                        &instantiation_plans,
                        template_idx,
                        mark,
                        rp,
                    );
                }
                // Stamp the same per-child key the keyed reconciler derives so
                // the FIRST update already matches by identity. Element
                // templates get `element.key` from replace_ir_node_item_bindings
                // for free, but control-flow templates (and every template
                // beyond the first, which needs the `#idx` suffix) do not.
                if let Some(child_node) = ctx.tree.get_mut(child_id) {
                    child_node.key =
                        Some(iterable_child_key(&item_key, template_idx, multi_template));
                }
                crate::reconcile::keyed::stamp_iter_memo(ctx, child_id, item_hash, templates_hash);
            }
        }
    }

    node_id
}

/// Create a Conditional (When/If) tree from IRNode::Conditional
#[allow(clippy::too_many_arguments)]
fn create_conditional_tree(
    ctx: &mut ReconcileCtx,
    value: &Value,
    branches: &[crate::ir::ConditionalBranch],
    fallback: Option<&[IRNode]>,
    original_node: &IRNode,
    parent_id: Option<NodeId>,
    render_parent_hint: Option<NodeId>,
    is_root: bool,
) -> NodeId {
    let raw_scope = match original_node {
        IRNode::Conditional { module_scope, .. } => module_scope.as_deref(),
        _ => None,
    };
    let module_scope_ref = ctx.effective_scope(raw_scope);
    let effective_state = ctx.effective_state(raw_scope);

    let evaluated_value = evaluate_value(value, effective_state, ctx.data_sources);

    let mut raw_props = Props::new();
    raw_props.insert("__condition".to_string(), value.clone());

    let node_id = ctx.tree.create_control_flow_node(
        "__Conditional",
        std::sync::Arc::new(IndexMap::new()),
        raw_props,
        ControlFlowKind::Conditional,
        original_node.clone(),
    );

    if let Value::Binding(binding) = value {
        ctx.dependencies
            .add_dependency(node_id, binding, module_scope_ref);
    } else if let Value::TemplateString { bindings, .. } = value {
        for binding in bindings {
            ctx.dependencies
                .add_dependency(node_id, binding, module_scope_ref);
        }
    }

    if let Some(parent) = parent_id {
        ctx.tree.add_child(parent, node_id, None);
    }

    let matched_children = find_matching_branch(
        &evaluated_value,
        branches,
        fallback,
        effective_state,
        ctx.data_sources,
    );

    // See create_foreach_ir_tree: branch children must render under the
    // nearest real element, not a control-flow container (this If may be
    // a ForEach item root, where the logical parent is the __ForEach).
    let render_parent = nearest_render_parent(ctx.tree, render_parent_hint.or(parent_id));

    if let Some(children) = matched_children {
        for child in children {
            create_ir_node_tree_full(
                ctx,
                child,
                Some(node_id),
                render_parent,
                is_root && render_parent.is_none(),
            );
        }
    }

    node_id
}

/// Create a Router tree from IRNode::Router.
///
/// Mirrors `create_conditional_tree`: builds a single `__Router` control-flow
/// node, registers a dependency on the location binding, picks the matching
/// route, and renders only that route's children. The renderer never sees
/// `Router` or `Route` element types — it just sees the matched children
/// inserted under the Router's render parent.
#[allow(clippy::too_many_arguments)]
fn create_router_tree(
    ctx: &mut ReconcileCtx,
    location: &Value,
    routes: &[RouterRoute],
    fallback: Option<&[IRNode]>,
    original_node: &IRNode,
    parent_id: Option<NodeId>,
    render_parent_hint: Option<NodeId>,
    is_root: bool,
) -> NodeId {
    let raw_scope = match original_node {
        IRNode::Router { module_scope, .. } => module_scope.as_deref(),
        _ => None,
    };
    let module_scope_ref = ctx.effective_scope(raw_scope);
    let effective_state = ctx.effective_state(raw_scope);

    // Resolve location to a string. Anything that isn't a string falls back
    // to the empty path so the fallback (or no route) is selected.
    let evaluated = evaluate_value(location, effective_state, ctx.data_sources);
    let location_str = match &evaluated {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    };

    let mut raw_props = Props::new();
    raw_props.insert("__location".to_string(), location.clone());

    // Seed the Router with an empty cache and the initial route key
    // (filled in once we know which route matched below).
    let node_id = ctx.tree.create_control_flow_node(
        "__Router",
        std::sync::Arc::new(IndexMap::new()),
        raw_props,
        ControlFlowKind::Router {
            cache: IndexMap::new(),
            current_route_key: None,
            max_cache_size: DEFAULT_ROUTER_CACHE_SIZE,
        },
        original_node.clone(),
    );

    // Register dependency on the location binding so updates to state.location
    // dirty this Router node and trigger reconciliation.
    if let Value::Binding(binding) = location {
        ctx.dependencies
            .add_dependency(node_id, binding, module_scope_ref);
    } else if let Value::TemplateString { bindings, .. } = location {
        for binding in bindings {
            ctx.dependencies
                .add_dependency(node_id, binding, module_scope_ref);
        }
    }

    if let Some(parent) = parent_id {
        ctx.tree.add_child(parent, node_id, None);
    }

    // Find the matched route (with its pattern key) so we can remember
    // which route produced the current children. On the next location
    // change, the Router reconciler will cache *these* NodeIds under
    // that key before swapping in new children.
    let matched = find_matching_route_with_key(&location_str, routes, fallback);
    // See create_foreach_ir_tree: route children render under the nearest
    // real element ancestor, never a control-flow container.
    let render_parent = nearest_render_parent(ctx.tree, render_parent_hint.or(parent_id));

    if let Some((route_key, children)) = matched.as_ref() {
        for child in *children {
            create_ir_node_tree_full(
                ctx,
                child,
                Some(node_id),
                render_parent,
                is_root && render_parent.is_none(),
            );
        }

        // Record the route we just rendered so the reconciler knows
        // which cache bucket to populate on navigation away.
        if let Some(router_node) = ctx.tree.get_mut(node_id) {
            if let Some(ControlFlowKind::Router {
                current_route_key, ..
            }) = router_node.control_flow.as_mut()
            {
                *current_route_key = Some(route_key.clone());
            }
        }
    }

    node_id
}

/// Tear down every child of a ForEach container and rebuild the list from
/// scratch.
///
/// This is the historical ForEach update strategy and is now only the
/// **fallback** for state the keyed reconciler can't match by identity (see
/// the `children_intact` guard in [`reconcile_ir_node_impl`]). It is correct
/// but not minimal: O(n) Removes + O(n) Creates for an O(1) change, which
/// destroys renderer-side state (focus, scroll, input values, media playback)
/// inside every row and, with animations, plays every row's exit alongside
/// every row's enter.
///
/// Keeps the logical-vs-render parent split: children are created under the
/// ForEach container (`node_id`) while their Insert patches address
/// `render_parent`.
#[allow(clippy::too_many_arguments)]
fn rebuild_foreach_children(
    ctx: &mut ReconcileCtx,
    node_id: NodeId,
    render_parent: NodeId,
    old_children: &[NodeId],
    items: &[serde_json::Value],
    item_name: &str,
    key_path: Option<&str>,
    template: &[IRNode],
) {
    for &old_child_id in old_children {
        let patch = root_remove_patch(ctx.tree, old_child_id);
        ctx.dependencies.remove_node(old_child_id);
        ctx.tree.remove(old_child_id);
        ctx.patches.push(patch);
    }

    if let Some(node) = ctx.tree.get_mut(node_id) {
        node.children.clear();
    }

    let multi_template = template.len() > 1;
    for (index, item) in items.iter().enumerate() {
        let item_key = generate_item_key(item, key_path, item_name, index);

        for (template_idx, child_template) in template.iter().enumerate() {
            let child_with_item =
                replace_ir_node_item_bindings(child_template, item, index, item_name, &item_key);
            let child_id = create_ir_node_tree_full(
                ctx,
                &child_with_item,
                Some(node_id),
                Some(render_parent),
                false,
            );
            if let Some(child_node) = ctx.tree.get_mut(child_id) {
                child_node.key = Some(iterable_child_key(&item_key, template_idx, multi_template));
            }
        }
    }
}

/// Reconcile an existing tree against a new IRNode using a `ReconcileCtx`.
pub(crate) fn reconcile_ir_node_impl(ctx: &mut ReconcileCtx, node_id: NodeId, node: &IRNode) {
    // Existence check only. Each arm reads the handful of fields it needs
    // straight off the node — cloning the whole `InstanceNode` here (and
    // then AGAIN inside `reconcile_element_node`) was the single most
    // frequent allocation in a reconcile pass, and the Element arm never
    // touched the clone at all.
    if ctx.tree.get(node_id).is_none() {
        return;
    }

    match node {
        IRNode::Element(element) => {
            reconcile_element_node(ctx, node_id, element);
        }
        IRNode::ForEach {
            source,
            item_name,
            key_path,
            template,
            props: _,
            module_scope,
        } => {
            let (is_foreach, existing_parent) = match ctx.tree.get(node_id) {
                Some(n) => (n.is_foreach(), n.parent),
                None => return,
            };

            if !is_foreach {
                let parent_id = existing_parent;
                remove_subtree(ctx.tree, node_id, ctx.patches, ctx.dependencies);
                create_ir_node_tree_impl(ctx, node, parent_id, parent_id.is_none());
                return;
            }

            let module_scope_ref = ctx.effective_scope(module_scope.as_deref());
            let effective_state = ctx.effective_state(module_scope.as_deref());

            ctx.dependencies
                .add_dependency(node_id, source, module_scope_ref);

            // Borrowed out of state — see `create_foreach_ir_tree`.
            let array = evaluate_binding_ref(source, effective_state);

            if let Some(serde_json::Value::Array(items)) = array {
                let old_children: Vec<NodeId> = match ctx.tree.get(node_id) {
                    Some(n) => n.children.iter().copied().collect(),
                    None => return,
                };
                // The ForEach container is transparent to renderers: items are
                // LOGICAL children of `node_id` but their Insert/Move patches
                // must target the nearest real ELEMENT ancestor (the RENDER
                // parent) — the immediate parent may itself be a transparent
                // control-flow container (ForEach directly inside an If).
                // Collapsing the two orphans items under the grandparent and
                // leaves `ForEach.children` empty — every later reconcile then
                // sees a length mismatch and rebuilds forever. Both branches
                // below keep the split; `create_foreach_ir_tree` is the
                // reference for the create side.
                let render_parent =
                    nearest_render_parent(ctx.tree, existing_parent).unwrap_or(node_id);

                // Fallback: keyed reconciliation reasons about the recorded
                // children by identity, so it needs every one of them to still
                // resolve in the tree. A dangling id means the container's
                // bookkeeping is out of sync with the arena (nothing in-tree
                // produces that today, but a stale `children` entry used to be
                // possible) — rebuild from scratch instead of matching against
                // ghosts. Correct but O(n), so it stays the exception.
                let children_intact = old_children.iter().all(|&id| ctx.tree.get(id).is_some());

                if children_intact {
                    reconcile_iterable_children_full(
                        ctx,
                        node_id,
                        render_parent,
                        items,
                        item_name,
                        key_path.as_deref(),
                        template,
                        // The incoming node may be an outer row's substituted
                        // copy — recompute rather than trust the cache.
                        false,
                    );
                } else {
                    rebuild_foreach_children(
                        ctx,
                        node_id,
                        render_parent,
                        &old_children,
                        items,
                        item_name,
                        key_path.as_deref(),
                        template,
                    );
                }
            }
        }
        IRNode::Conditional {
            value,
            branches,
            fallback,
            module_scope,
        } => {
            let (is_conditional, existing_parent) = match ctx.tree.get(node_id) {
                Some(n) => (n.is_conditional(), n.parent),
                None => return,
            };

            if !is_conditional {
                let parent_id = existing_parent;
                remove_subtree(ctx.tree, node_id, ctx.patches, ctx.dependencies);
                create_ir_node_tree_impl(ctx, node, parent_id, parent_id.is_none());
                return;
            }

            let module_scope_ref = ctx.effective_scope(module_scope.as_deref());
            let effective_state = ctx.effective_state(module_scope.as_deref());

            if let Value::Binding(binding) = value {
                ctx.dependencies
                    .add_dependency(node_id, binding, module_scope_ref);
            } else if let Value::TemplateString { bindings, .. } = value {
                for binding in bindings {
                    ctx.dependencies
                        .add_dependency(node_id, binding, module_scope_ref);
                }
            }

            let evaluated_value = evaluate_value(value, effective_state, ctx.data_sources);
            let matched_children = find_matching_branch(
                &evaluated_value,
                branches,
                fallback.as_deref(),
                effective_state,
                ctx.data_sources,
            );

            // `im::Vector` clone is a refcount bump, not a copy.
            let old_children = match ctx.tree.get(node_id) {
                Some(n) => n.children.clone(),
                None => return,
            };
            let old_len = old_children.len();
            // Nearest real element — a Conditional that is a ForEach item
            // root has the transparent __ForEach as its immediate parent.
            let render_parent = nearest_render_parent(ctx.tree, existing_parent);

            if let Some(children) = matched_children {
                let new_len = children.len();
                let common = old_len.min(new_len);

                for (i, child) in children.iter().enumerate().take(common) {
                    if let Some(&old_child_id) = old_children.get(i) {
                        reconcile_ir_node_impl(ctx, old_child_id, child);
                    }
                }

                if common < old_len {
                    let doomed: Vec<NodeId> = old_children.iter().skip(common).copied().collect();
                    for &old_child_id in &doomed {
                        remove_subtree(ctx.tree, old_child_id, ctx.patches, ctx.dependencies);
                    }
                    // One rebuild of the container's child vector for the
                    // whole tail — the old filter-collect ran once per
                    // removed child, making a full branch swap O(n²).
                    if let Some(cond_node) = ctx.tree.get_mut(node_id) {
                        cond_node.children.retain(|id| !doomed.contains(id));
                    }
                }

                let children_is_root = render_parent.is_none();
                for child in &children[common..] {
                    create_ir_node_tree_full(
                        ctx,
                        child,
                        Some(node_id),
                        render_parent,
                        children_is_root,
                    );
                }
            } else {
                for &old_child_id in &old_children {
                    remove_subtree(ctx.tree, old_child_id, ctx.patches, ctx.dependencies);
                }

                if let Some(cond_node) = ctx.tree.get_mut(node_id) {
                    cond_node.children.clear();
                }
            }
        }
        IRNode::Router {
            location,
            routes,
            fallback,
            module_scope,
        } => {
            let (is_router, existing_parent) = match ctx.tree.get(node_id) {
                Some(n) => (n.is_router(), n.parent),
                None => return,
            };

            // If the existing node isn't a Router, replace it wholesale.
            if !is_router {
                let parent_id = existing_parent;
                remove_subtree(ctx.tree, node_id, ctx.patches, ctx.dependencies);
                create_ir_node_tree_impl(ctx, node, parent_id, parent_id.is_none());
                return;
            }

            let module_scope_ref = ctx.effective_scope(module_scope.as_deref());
            let effective_state = ctx.effective_state(module_scope.as_deref());

            // Re-register the location dependency in case it was cleared.
            if let Value::Binding(binding) = location {
                ctx.dependencies
                    .add_dependency(node_id, binding, module_scope_ref);
            } else if let Value::TemplateString { bindings, .. } = location {
                for binding in bindings {
                    ctx.dependencies
                        .add_dependency(node_id, binding, module_scope_ref);
                }
            }

            let evaluated = evaluate_value(location, effective_state, ctx.data_sources);
            let location_str = match &evaluated {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Null => String::new(),
                other => other.to_string(),
            };

            // Read the current cache state out of the existing node. Each
            // Router instance carries its own detached-subtree cache keyed
            // by route pattern (see ControlFlowKind::Router).
            let (mut cache, prev_route_key, max_cache_size) =
                match ctx.tree.get(node_id).and_then(|n| n.control_flow.as_ref()) {
                    Some(ControlFlowKind::Router {
                        cache,
                        current_route_key,
                        max_cache_size,
                    }) => (cache.clone(), current_route_key.clone(), *max_cache_size),
                    _ => (IndexMap::new(), None, DEFAULT_ROUTER_CACHE_SIZE),
                };

            let matched = find_matching_route_with_key(&location_str, routes, fallback.as_deref());
            let new_route_key = matched.as_ref().map(|(k, _)| k.clone());

            // Same route as before — nothing structural to do. Descendant
            // nodes get their own dirty marks when state changes; the
            // Router only reconciles when the *route* changes.
            if prev_route_key.is_some() && prev_route_key == new_route_key {
                return;
            }

            let render_parent = nearest_render_parent(ctx.tree, existing_parent);
            let old_children: Vec<NodeId> = match ctx.tree.get(node_id) {
                Some(n) => n.children.iter().copied().collect(),
                None => return,
            };

            // Step 1: take the currently-rendered children off the Router.
            //   - If we have a prev_route_key → detach them and stash under
            //     that key (keep-alive: nodes, deps, props all live on).
            //   - If we don't (first reconcile after a cache miss or
            //     mismatched prior state) → fall back to hard teardown so
            //     we don't leak orphans.
            if let Some(prev_key) = prev_route_key.as_ref() {
                for &child_id in &old_children {
                    // Emit a Detach patch so the renderer unlinks its
                    // native node but keeps it alive. The engine-side
                    // node stays in the tree; its descendants stay
                    // under it; dependencies stay registered so state
                    // updates flow through while off-screen.
                    ctx.patches.push(Patch::detach(child_id));
                    if let Some(child) = ctx.tree.get_mut(child_id) {
                        child.parent = None;
                    }
                }
                if !old_children.is_empty() {
                    // Replace any prior entry for this key (e.g. if we
                    // navigated away, back, and away again).
                    cache.shift_remove(prev_key);
                    cache.insert(prev_key.clone(), old_children);
                }
            } else {
                for &old_child_id in &old_children {
                    remove_subtree(ctx.tree, old_child_id, ctx.patches, ctx.dependencies);
                }
            }

            if let Some(router_node) = ctx.tree.get_mut(node_id) {
                router_node.children.clear();
            }

            // Step 2: LRU-evict old cache entries if we exceeded the cap.
            // Dropping an entry means its subtree is gone for good, so
            // we tear it down properly (frees nodes + deps).
            while cache.len() > max_cache_size {
                let evicted_key = cache.keys().next().cloned();
                if let Some(evicted_key) = evicted_key {
                    if let Some(evicted_ids) = cache.shift_remove(&evicted_key) {
                        for evicted_id in evicted_ids {
                            remove_subtree(ctx.tree, evicted_id, ctx.patches, ctx.dependencies);
                        }
                    }
                } else {
                    break;
                }
            }

            // Step 3: attach the new route's subtree — reuse cached
            // nodes if we've seen this route before, otherwise build
            // from scratch.
            if let Some(new_key) = new_route_key.as_ref() {
                if let Some(cached_ids) = cache.shift_remove(new_key) {
                    // Cache hit: reattach the detached subtrees in order.
                    // When the Router is itself the IR root, its own
                    // NodeId is a control-flow pseudo-node the renderer
                    // never created — attach to "root" in that case.
                    for cached_id in &cached_ids {
                        if let Some(child) = ctx.tree.get_mut(*cached_id) {
                            child.parent = Some(node_id);
                        }
                        if let Some(router_node) = ctx.tree.get_mut(node_id) {
                            router_node.children.push_back(*cached_id);
                        }
                        let attach_patch = match render_parent {
                            Some(rp) => Patch::attach(rp, *cached_id, None),
                            None => Patch::attach_root(*cached_id, None),
                        };
                        ctx.patches.push(attach_patch);
                    }
                } else if let Some((_, children)) = matched.as_ref() {
                    // Cache miss: build fresh IR tree for this route.
                    // When the Router is at the IR root (render_parent
                    // is None) the children must be inserted at "root";
                    // that's what `is_root` signals to create_element_node.
                    let children_is_root = render_parent.is_none();
                    for child in *children {
                        create_ir_node_tree_full(
                            ctx,
                            child,
                            Some(node_id),
                            render_parent,
                            children_is_root,
                        );
                    }
                }
            }

            // Step 4: write the updated cache + current route back to
            // the Router node. If nothing matched (no route, no
            // fallback) we keep the cache but clear current_route_key
            // so the next reconcile treats this as a fresh state.
            if let Some(router_node) = ctx.tree.get_mut(node_id) {
                router_node.control_flow = Some(ControlFlowKind::Router {
                    cache,
                    current_route_key: new_route_key,
                    max_cache_size,
                });
            }
        }
    }
}

/// Build the root `Remove` patch for `id`, flagged with `transition: true`
/// when the node's resolved props carry an `"__anim.exit"` spec. Must be
/// called BEFORE the node is removed from `tree` — afterwards the props
/// (and the spec) are gone and the removal silently loses its animation.
pub(crate) fn root_remove_patch(tree: &InstanceTree, id: NodeId) -> Patch {
    let exits = tree
        .get(id)
        .is_some_and(|node| node.props.contains_key(crate::ir::anim::ANIM_EXIT_PROP));
    if exits {
        Patch::remove_with_transition(id)
    } else {
        Patch::remove(id)
    }
}

/// Emit the Remove patches for the subtree rooted at `root_id` and clear its
/// dependency registrations, without mutating the tree — callers unlink and
/// `tree.remove(...)` afterwards (`&InstanceTree` enforces that the removal
/// root's `"__anim.exit"` spec is read before any mutation).
///
/// Ordering (the contract documented on [`Patch::Remove`]):
/// - root has an exit spec → flagged root Remove FIRST, then descendants as
///   plain Removes (post-order among themselves). Descendants are plain even
///   when they carry their own exit specs — parent-remove-wins falls out
///   structurally because only the removal root is consulted. The animated
///   path keeps the per-descendant Removes because a renderer deferring the
///   root's teardown must still be told which descendants are going away.
/// - no exit spec → a SINGLE Remove for the subtree root. Renderers own
///   descendant teardown on this path (the keyed and ForEach-rebuild paths
///   have always emitted root-only Removes — see `root_remove_patch`'s
///   callers in `keyed.rs` and `rebuild_foreach_children` — and the DOM
///   renderer's `sweepDetachedDescendants` exists exactly for it). Emitting
///   one patch per descendant meant ~17k patches to clear a 1,000-row list
///   that the renderer discards in a single subtree unlink.
fn emit_subtree_removal(
    tree: &InstanceTree,
    root_id: NodeId,
    patches: &mut Vec<Patch>,
    dependencies: &mut DependencyGraph,
) {
    let root_patch = root_remove_patch(tree, root_id);
    let animated = matches!(
        root_patch,
        Patch::Remove {
            transition: true,
            ..
        }
    );

    if animated {
        let ids = collect_subtree_ids(tree, root_id);
        patches.push(root_patch);
        for &id in &ids {
            if id != root_id {
                patches.push(Patch::remove(id));
            }
        }
        for &id in &ids {
            dependencies.remove_node(id);
        }
        return;
    }

    patches.push(root_patch);
    // Engine-side bookkeeping still has to drop every descendant's reactive
    // registrations; walked with a plain stack so no id vector is
    // materialized for what is now a single patch.
    let mut stack = vec![root_id];
    while let Some(id) = stack.pop() {
        dependencies.remove_node(id);
        if let Some(node) = tree.get(id) {
            stack.extend(node.children.iter().copied());
        }
    }
}

/// Remove a subtree and generate Remove patches
fn remove_subtree(
    tree: &mut InstanceTree,
    node_id: NodeId,
    patches: &mut Vec<Patch>,
    dependencies: &mut DependencyGraph,
) {
    emit_subtree_removal(tree, node_id, patches, dependencies);
    tree.remove(node_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::Value;
    use serde_json::json;

    #[test]
    fn test_create_simple_tree() {
        use crate::reactive::DependencyGraph;

        let mut tree = InstanceTree::new();
        let mut patches = Vec::new();
        let mut dependencies = DependencyGraph::new();

        let element = Element::new("Column")
            .with_child(Element::new("Text").with_prop("text", Value::Static(json!("Hello"))));

        let state = json!({});
        let mut ctx = ReconcileCtx {
            tree: &mut tree,
            state: &state,
            patches: &mut patches,
            dependencies: &mut dependencies,
            data_sources: None,
            modules: None,
        };
        create_element_node(&mut ctx, &element, None, None, true);

        // Should create 2 nodes (Column + Text) + 2 Inserts (root + child)
        // Create Column, Insert Column into root, Create Text, Insert Text into Column
        assert_eq!(patches.len(), 4);

        // Verify root insert patch exists
        let root_insert = patches
            .iter()
            .find(|p| matches!(p, Patch::Insert { parent_id, .. } if parent_id.as_ref() == "root"));
        assert!(root_insert.is_some(), "Root insert patch should exist");
    }

    #[test]
    fn test_diff_props() {
        let node_id = NodeId::default();
        let old = indexmap::indexmap! {
            "color".to_string() => json!("red"),
            "size".to_string() => json!(16),
        };
        let new = indexmap::indexmap! {
            "color".to_string() => json!("blue"),
            "size".to_string() => json!(16),
        };

        let patches = diff_props(node_id, &old, &new);

        // Only color changed
        assert_eq!(patches.len(), 1);
    }
}
