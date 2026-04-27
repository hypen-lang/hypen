use super::conditionals::{
    evaluate_value, find_matching_branch, find_matching_route_with_key,
};
use super::tree::DEFAULT_ROUTER_CACHE_SIZE;
use super::item_bindings::replace_ir_node_item_bindings;
use super::keyed::{generate_item_key, reconcile_iterable_children};
use super::resolve::{evaluate_binding, resolve_props_full};
use super::{ControlFlowKind, InstanceTree, Patch};
use crate::ir::{Element, IRNode, NodeId, Props, RouterRoute, Value};
use crate::reactive::DependencyGraph;
use indexmap::IndexMap;

/// Data sources type alias for readability
type DataSources = indexmap::IndexMap<String, serde_json::Value>;

/// Module instances map type alias
type Modules = indexmap::IndexMap<String, crate::lifecycle::ModuleInstance>;

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
    fn effective_scope<'s>(&self, raw: Option<&'s str>) -> Option<&'s str> {
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
    fn effective_state(&self, raw_scope: Option<&str>) -> &'a serde_json::Value {
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
    ctx.patches
        .push(Patch::create(node_id, element.element_type.clone(), props));

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

/// Create an iterable element (List, Grid, etc.) that iterates over an array in state
fn create_list_tree_impl(
    ctx: &mut ReconcileCtx,
    element: &Element,
    parent_id: Option<NodeId>,
    is_root: bool,
) -> NodeId {
    let module_scope_ref = ctx.effective_scope(element.module_scope.as_deref());
    let effective_state = ctx.effective_state(element.module_scope.as_deref());

    // Get the array binding from first prop (prop "0")
    let array = if let Some(Value::Binding(binding)) = element.props.get("0") {
        evaluate_binding(binding, effective_state).unwrap_or(serde_json::Value::Array(vec![]))
    } else {
        serde_json::Value::Array(vec![])
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
    ctx.patches.push(Patch::create(
        node_id,
        node.element_type.clone(),
        node.props.clone(),
    ));

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
    if let serde_json::Value::Array(items) = &array {
        let key_path = element.props.get("key.0").and_then(|v| match v {
            Value::Static(serde_json::Value::String(s)) => Some(s.as_str()),
            _ => None,
        });
        let multi_template = element.ir_children.len() > 1;

        for (index, item) in items.iter().enumerate() {
            let item_key = generate_item_key(item, key_path, "item", index);

            for (template_idx, child_ir) in element.ir_children.iter().enumerate() {
                let child_key = if multi_template {
                    format!("{}#{}", item_key, template_idx)
                } else {
                    item_key.clone()
                };
                let child_with_item = replace_ir_node_item_bindings(
                    child_ir, item, index, "item", &item_key,
                );
                let child_id = create_ir_node_tree_impl(
                    ctx,
                    &child_with_item,
                    Some(node_id),
                    false,
                );
                if let Some(child_node) = ctx.tree.get_mut(child_id) {
                    child_node.key = Some(child_key);
                }
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
    let node = match ctx.tree.get(node_id).cloned() {
        Some(n) => n,
        None => return,
    };

    let effective_state = ctx.effective_state(element.module_scope.as_deref());
    let module_scope_ref = element.module_scope.as_deref();

    // Special handling for iterable elements (List, Grid, …) — the source
    // array binding lives in props["0"] and the per-item template is in
    // ir_children.
    let is_iterable = element.props.get("0").is_some() && !element.ir_children.is_empty();

    if is_iterable {
        let array = if let Some(Value::Binding(binding)) = element.props.get("0") {
            evaluate_binding(binding, effective_state).unwrap_or(serde_json::Value::Array(vec![]))
        } else {
            serde_json::Value::Array(vec![])
        };

        if let serde_json::Value::Array(items) = &array {
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
            );
        }

        return;
    }

    // If element type changed, replace the entire subtree.
    if node.element_type != element.element_type {
        replace_subtree_impl(ctx, node_id, &node, element);
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
            _ => {}
        }
    }

    // Diff and apply prop changes.
    let new_props = resolve_props_full(&element.props, effective_state, None, ctx.data_sources);
    let prop_patches = diff_props(node_id, &node.props, &new_props);
    ctx.patches.extend(prop_patches);

    if let Some(node) = ctx.tree.get_mut(node_id) {
        node.props = new_props; // move the Arc directly — no extra clone
        node.raw_props = element.props.clone();
    }

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
        let old_children = node.children.clone();
        let new_children = &element.ir_children;

        for (i, new_child_ir) in new_children.iter().enumerate() {
            if let Some(&old_child_id) = old_children.get(i) {
                reconcile_ir_node_impl(ctx, old_child_id, new_child_ir);
            } else {
                create_ir_node_tree_impl(ctx, new_child_ir, Some(node_id), false);
            }
        }

        if old_children.len() > new_children.len() {
            for old_child_id in old_children.iter().skip(new_children.len()).copied() {
                let subtree_ids = collect_subtree_ids(ctx.tree, old_child_id);
                for &id in &subtree_ids {
                    ctx.patches.push(Patch::remove(id));
                    ctx.dependencies.remove_node(id);
                }
                ctx.tree.remove_child(node_id, old_child_id);
                ctx.tree.remove(old_child_id);
            }
        }
    }
}

/// Replace an entire subtree when element types don't match.
fn replace_subtree_impl(
    ctx: &mut ReconcileCtx,
    old_node_id: NodeId,
    old_node: &super::InstanceNode,
    new_element: &Element,
) {
    let parent_id = old_node.parent;

    let old_position = if let Some(pid) = parent_id {
        ctx.tree
            .get(pid)
            .and_then(|parent| parent.children.iter().position(|&id| id == old_node_id))
    } else {
        None
    };

    let ids_to_remove = collect_subtree_ids(ctx.tree, old_node_id);

    for &id in &ids_to_remove {
        ctx.patches.push(Patch::remove(id));
        ctx.dependencies.remove_node(id);
    }

    if let Some(pid) = parent_id {
        if let Some(parent) = ctx.tree.get_mut(pid) {
            parent.children = parent
                .children
                .iter()
                .filter(|&&id| id != old_node_id)
                .copied()
                .collect();
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

/// Diff two sets of props and generate SetProp/RemoveProp patches
pub fn diff_props(
    node_id: NodeId,
    old_props: &IndexMap<String, serde_json::Value>,
    new_props: &IndexMap<String, serde_json::Value>,
) -> Vec<Patch> {
    let mut patches = Vec::new();

    for (key, new_value) in new_props {
        if old_props.get(key) != Some(new_value) {
            patches.push(Patch::set_prop(node_id, key.clone(), new_value.clone()));
        }
    }

    for key in old_props.keys() {
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

/// Create a tree from an IRNode with separate logical and render parents.
///
/// `logical_parent` controls where the new node lives in the instance
/// tree; `render_parent` controls which parent the `Insert` patch
/// references. They diverge for control-flow children — a ForEach item
/// is logically owned by the ForEach container, but its `Insert` patch
/// targets the ForEach's grandparent because the renderer treats the
/// container as transparent.
fn create_ir_node_tree_full(
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
            // Control-flow containers always render under the logical
            // parent — they don't take a render-parent split themselves.
            create_control_flow_tree(ctx, node, logical_parent, is_root)
        }
    }
}

/// Create a ForEach or Conditional tree from an IRNode, destructuring inside.
fn create_control_flow_tree(
    ctx: &mut ReconcileCtx,
    node: &IRNode,
    parent_id: Option<NodeId>,
    is_root: bool,
) -> NodeId {
    match node {
        IRNode::ForEach { .. } => create_foreach_ir_tree(
            ctx,
            node,
            parent_id,
            is_root,
        ),
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

    let array =
        evaluate_binding(source, effective_state).unwrap_or(serde_json::Value::Array(vec![]));

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

    let render_parent = parent_id;

    if let serde_json::Value::Array(items) = &array {
        for (index, item) in items.iter().enumerate() {
            let item_key = generate_item_key(item, key_path, item_name, index);

            for child_template in template {
                let child_with_item = replace_ir_node_item_bindings(
                    child_template,
                    item,
                    index,
                    item_name,
                    &item_key,
                );
                create_ir_node_tree_full(
                    ctx,
                    &child_with_item,
                    Some(node_id),
                    render_parent,
                    is_root && render_parent.is_none(),
                );
            }
        }
    }

    node_id
}

/// Create a Conditional (When/If) tree from IRNode::Conditional
fn create_conditional_tree(
    ctx: &mut ReconcileCtx,
    value: &Value,
    branches: &[crate::ir::ConditionalBranch],
    fallback: Option<&[IRNode]>,
    original_node: &IRNode,
    parent_id: Option<NodeId>,
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

    let matched_children =
        find_matching_branch(&evaluated_value, branches, fallback, effective_state, ctx.data_sources);

    let render_parent = parent_id;

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
fn create_router_tree(
    ctx: &mut ReconcileCtx,
    location: &Value,
    routes: &[RouterRoute],
    fallback: Option<&[IRNode]>,
    original_node: &IRNode,
    parent_id: Option<NodeId>,
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
    let render_parent = parent_id;

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

/// Reconcile an existing tree against a new IRNode using a `ReconcileCtx`.
pub(crate) fn reconcile_ir_node_impl(ctx: &mut ReconcileCtx, node_id: NodeId, node: &IRNode) {
    let existing_node = ctx.tree.get(node_id).cloned();
    if existing_node.is_none() {
        return;
    }
    let existing = existing_node.unwrap();

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
            if !existing.is_foreach() {
                let parent_id = existing.parent;
                remove_subtree(ctx.tree, node_id, ctx.patches, ctx.dependencies);
                create_ir_node_tree_impl(ctx, node, parent_id, parent_id.is_none());
                return;
            }

            let module_scope_ref = ctx.effective_scope(module_scope.as_deref());
            let effective_state = ctx.effective_state(module_scope.as_deref());

            ctx.dependencies
                .add_dependency(node_id, source, module_scope_ref);

            let array = evaluate_binding(source, effective_state)
                .unwrap_or(serde_json::Value::Array(vec![]));

            if let serde_json::Value::Array(items) = &array {
                let old_children = existing.children.clone();
                let expected_children_count = items.len() * template.len();
                let render_parent = existing.parent.unwrap_or(node_id);

                if old_children.len() != expected_children_count {
                    for &old_child_id in &old_children {
                        ctx.patches.push(Patch::remove(old_child_id));
                    }

                    if let Some(node) = ctx.tree.get_mut(node_id) {
                        node.children.clear();
                    }

                    for (index, item) in items.iter().enumerate() {
                        let item_key =
                            generate_item_key(item, key_path.as_deref(), item_name, index);

                        for child_template in template {
                            let child_with_item = replace_ir_node_item_bindings(
                                child_template,
                                item,
                                index,
                                item_name,
                                &item_key,
                            );
                            // Mirror the initial-create path in
                            // `create_foreach_ir_tree` (diff.rs ~line 708-714):
                            // items must be LOGICAL children of the ForEach
                            // container while their Insert patch targets the
                            // render parent. Collapsing the two (what
                            // `create_ir_node_tree_impl` does) orphans items
                            // under the grandparent and leaves
                            // `ForEach.children` empty — every subsequent
                            // reconcile then sees a length mismatch, hits this
                            // rebuild branch again, and emits 0 Removes + N
                            // Creates indefinitely.
                            create_ir_node_tree_full(
                                ctx,
                                &child_with_item,
                                Some(node_id),
                                Some(render_parent),
                                false,
                            );
                        }
                    }
                } else {
                    let mut child_index = 0;
                    for (item_index, item) in items.iter().enumerate() {
                        let item_key =
                            generate_item_key(item, key_path.as_deref(), item_name, item_index);

                        for child_template in template {
                            if let Some(&old_child_id) = old_children.get(child_index) {
                                let child_with_item = replace_ir_node_item_bindings(
                                    child_template,
                                    item,
                                    item_index,
                                    item_name,
                                    &item_key,
                                );
                                reconcile_ir_node_impl(ctx, old_child_id, &child_with_item);
                            }
                            child_index += 1;
                        }
                    }
                }
            }
        }
        IRNode::Conditional {
            value,
            branches,
            fallback,
            module_scope,
        } => {
            if !existing.is_conditional() {
                let parent_id = existing.parent;
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

            let old_children = existing.children.clone();
            let old_len = old_children.len();
            let render_parent = existing.parent;

            if let Some(children) = matched_children {
                let new_len = children.len();
                let common = old_len.min(new_len);

                for (i, child) in children.iter().enumerate().take(common) {
                    if let Some(&old_child_id) = old_children.get(i) {
                        reconcile_ir_node_impl(ctx, old_child_id, child);
                    }
                }

                for i in common..old_len {
                    if let Some(&old_child_id) = old_children.get(i) {
                        remove_subtree(ctx.tree, old_child_id, ctx.patches, ctx.dependencies);
                        if let Some(cond_node) = ctx.tree.get_mut(node_id) {
                            cond_node.children = cond_node
                                .children
                                .iter()
                                .filter(|&&id| id != old_child_id)
                                .copied()
                                .collect();
                        }
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
            // If the existing node isn't a Router, replace it wholesale.
            if !existing.is_router() {
                let parent_id = existing.parent;
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
                match existing.control_flow.as_ref() {
                    Some(ControlFlowKind::Router {
                        cache,
                        current_route_key,
                        max_cache_size,
                    }) => (cache.clone(), current_route_key.clone(), *max_cache_size),
                    _ => (IndexMap::new(), None, DEFAULT_ROUTER_CACHE_SIZE),
                };

            let matched = find_matching_route_with_key(
                &location_str,
                routes,
                fallback.as_deref(),
            );
            let new_route_key = matched.as_ref().map(|(k, _)| k.clone());

            // Same route as before — nothing structural to do. Descendant
            // nodes get their own dirty marks when state changes; the
            // Router only reconciles when the *route* changes.
            if prev_route_key.is_some() && prev_route_key == new_route_key {
                return;
            }

            let render_parent = existing.parent;
            let old_children: Vec<NodeId> = existing.children.iter().copied().collect();

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
                            remove_subtree(
                                ctx.tree,
                                evicted_id,
                                ctx.patches,
                                ctx.dependencies,
                            );
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

/// Remove a subtree and generate Remove patches
fn remove_subtree(
    tree: &mut InstanceTree,
    node_id: NodeId,
    patches: &mut Vec<Patch>,
    dependencies: &mut DependencyGraph,
) {
    let ids = collect_subtree_ids(tree, node_id);
    for &id in &ids {
        patches.push(Patch::remove(id));
        dependencies.remove_node(id);
    }
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
            .find(|p| matches!(p, Patch::Insert { parent_id, .. } if parent_id == "root"));
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
