//! Compiled binding maps for iterable templates.
//!
//! A list re-render's per-changed-row cost used to be: deep-clone the whole
//! per-item template with the item's values substituted in
//! (`replace_ir_node_item_bindings`), then walk that subtree against the
//! instance tree diffing every prop of every node. For the common template
//! shape — a static element structure where only *some* props depend on the
//! item — almost all of that work rediscovers what a compiler could know up
//! front: **which** props can change when the item changes, and **where**
//! they live.
//!
//! [`compile_iter_templates`] extracts exactly that: one
//! [`CompiledEntry`] per item-dependent prop, addressed by its child-index
//! path from the template root. [`apply_compiled_row`] then updates a row
//! for a new item value by resolving just those entries and emitting
//! `SetProp`/`RemoveProp` for the ones that actually differ — O(item-bound
//! props) instead of O(template nodes × props).
//!
//! # What is compilable
//!
//! A template compiles only when its structure cannot vary with the item:
//! every node is a plain `IRNode::Element`. Any control flow (ForEach,
//! Conditional, Router) anywhere in the subtree makes the whole template
//! uncompilable — structure then depends on data, and the full
//! substitute-and-reconcile pass is the only correct engine. Uncompilable
//! is a cached, first-class outcome: callers fall back seamlessly and don't
//! retry the compile every pass.
//!
//! # Equivalence contract
//!
//! The fast path must be *observationally identical* to the slow path.
//! Substitution goes through the same [`replace_value_item_bindings`] the
//! full pass uses, and resolution through the same
//! [`resolve_single_value`], so a value can't resolve differently depending
//! on which path touched it. The compiled path is also strictly
//! *narrower*, not different: props that don't depend on the item are
//! untouched by an item change by definition (state-bound props update
//! through their own per-node dirty registrations, exactly as they do under
//! the memo bail-out).

use super::diff::{emit_semantics_delta, is_engine_internal_prop, ReconcileCtx};
use super::item_bindings::replace_value_item_bindings;
use super::resolve::resolve_single_value;
use super::Patch;
use crate::ir::{IRNode, NodeId, Value};
use std::sync::Arc;

/// One item-dependent prop of a compiled template.
#[derive(Debug, Clone)]
pub struct CompiledEntry {
    /// Child-index path from the template root to the owning element
    /// (empty = the root itself).
    pub offsets: Vec<usize>,
    /// Prop key on that element.
    pub prop: String,
    /// The PRE-substitution value, item bindings intact.
    pub value: Value,
}

/// All item-dependent props of one per-item template.
#[derive(Debug, Clone)]
pub struct CompiledTemplate {
    pub entries: Vec<CompiledEntry>,
}

/// Cached compile outcome for an iterable container, keyed by the same
/// templates fingerprint the memo uses. `compiled: None` records "not
/// compilable" so the walk isn't retried every pass.
#[derive(Debug, Clone)]
pub struct CompiledCache {
    pub templates_hash: u64,
    pub compiled: Option<Arc<Vec<CompiledTemplate>>>,
    /// Instantiation plans for the same templates, filled in on first
    /// request (see [`plans_for`]). `None` = not planned yet under this
    /// fingerprint; a fingerprint change resets it along with `compiled`.
    pub plans: Option<Arc<Vec<Option<InstantiationPlan>>>>,
}

/// Does resolving this value read the iteration item?
fn value_depends_on_item(value: &Value, item_name: &str) -> bool {
    match value {
        Value::Binding(b) => b.is_item(),
        Value::TemplateString { template, bindings } => {
            bindings.iter().any(|b| b.is_item())
                || super::item_bindings::with_item_markers(item_name, |dot, bare| {
                    template.contains(dot) || template.contains(bare)
                })
        }
        // Legacy textual form: a static string carrying `@{item...}`.
        Value::Static(serde_json::Value::String(s)) => {
            super::item_bindings::with_item_markers(item_name, |dot, bare| {
                s.contains(dot) || s.contains(bare)
            })
        }
        _ => false,
    }
}

/// Compile the per-item templates of an iterable into binding maps.
/// `None` = at least one template's structure can vary with the item.
pub(crate) fn compile_iter_templates(
    templates: &[IRNode],
    item_name: &str,
) -> Option<Vec<CompiledTemplate>> {
    fn walk(
        node: &IRNode,
        offsets: &mut Vec<usize>,
        item_name: &str,
        entries: &mut Vec<CompiledEntry>,
    ) -> bool {
        let IRNode::Element(element) = node else {
            return false; // control flow → structure varies with data
        };
        for (key, value) in &element.props {
            if value_depends_on_item(value, item_name) {
                entries.push(CompiledEntry {
                    offsets: offsets.clone(),
                    prop: key.clone(),
                    value: value.clone(),
                });
            }
        }
        for (child_idx, child) in element.ir_children.iter().enumerate() {
            offsets.push(child_idx);
            let ok = walk(child, offsets, item_name, entries);
            offsets.pop();
            if !ok {
                return false;
            }
        }
        true
    }

    let mut compiled = Vec::with_capacity(templates.len());
    for template in templates {
        let mut entries = Vec::new();
        let mut offsets = Vec::new();
        if !walk(template, &mut offsets, item_name, &mut entries) {
            return None;
        }
        compiled.push(CompiledTemplate { entries });
    }
    Some(compiled)
}

/// Fetch (or compile and cache) the binding maps for an iterable container.
/// The cache lives on the container's `InstanceNode`, keyed by
/// `templates_hash` — nested ForEach templates change content with the outer
/// item, and the hash is what detects that and forces a recompile.
pub(crate) fn compiled_for(
    ctx: &mut ReconcileCtx,
    container_id: NodeId,
    templates: &[IRNode],
    item_name: &str,
    templates_hash: u64,
) -> Option<Arc<Vec<CompiledTemplate>>> {
    if let Some(cache) = ctx
        .tree
        .get(container_id)
        .and_then(|n| n.iter_compiled.as_deref())
    {
        if cache.templates_hash == templates_hash {
            return cache.compiled.clone();
        }
    }
    let compiled = compile_iter_templates(templates, item_name).map(Arc::new);
    if let Some(node) = ctx.tree.get_mut(container_id) {
        // A fingerprint change invalidates the plans too — they are derived
        // from the same template content.
        node.iter_compiled = Some(Box::new(CompiledCache {
            templates_hash,
            compiled: compiled.clone(),
            plans: None,
        }));
    }
    compiled
}

/// Fetch (or build and cache) the instantiation plans for an iterable
/// container's templates.
///
/// Planning serializes a skeleton per template and content-addresses it, so
/// it is far from free — yet the plans are consumed only when a pass creates
/// brand-new children, and they depend on nothing but the template content.
/// Caching them beside the compiled maps under the same `templates_hash`
/// makes every later pass over an unchanged template list a hash probe.
///
/// The entry is written only when [`compiled_for`] has already established a
/// cache slot for this fingerprint (it always runs first at the call sites).
/// Otherwise the plans are still returned — just not cached — rather than
/// fabricating a slot whose `compiled` field would be a guess.
pub(crate) fn plans_for(
    ctx: &mut ReconcileCtx,
    container_id: NodeId,
    templates: &[IRNode],
    templates_hash: u64,
) -> Arc<Vec<Option<InstantiationPlan>>> {
    if let Some(cache) = ctx
        .tree
        .get(container_id)
        .and_then(|n| n.iter_compiled.as_deref())
    {
        if cache.templates_hash == templates_hash {
            if let Some(plans) = &cache.plans {
                return plans.clone();
            }
        }
    }
    let plans = Arc::new(plan_templates_for_emission(templates));
    if let Some(cache) = ctx
        .tree
        .get_mut(container_id)
        .and_then(|n| n.iter_compiled.as_deref_mut())
    {
        if cache.templates_hash == templates_hash {
            cache.plans = Some(plans.clone());
        }
    }
    plans
}

// ───────────────────────── Template instantiation ─────────────────────────
//
// The wire-level counterpart of the compiled binding map. Where the binding
// map narrows *updates* to the dynamic props, instantiation narrows
// *creation*: a template-shaped subtree goes over the wire as ONE
// `Instantiate` patch referencing a `RegisterTemplate` skeleton sent once,
// instead of a run of per-node `Create`+`Insert`. This is the one wire
// format — every plannable template emits this way; boundaries whose
// consumers can't exploit template cloning lower the stream back to plain
// patches with `portable::TemplateExpander`. The engine still builds its
// instance tree node-for-node exactly as before — dependency registration,
// memos and semantics are untouched — only the emitted patches change shape.

/// A template's instantiation plan: the skeleton payload and where the
/// dynamic props live, precomputed once per template content.
#[derive(Debug)]
pub struct InstantiationPlan {
    /// Wire id, content-addressed from the skeleton + dynamic prop set.
    /// NOT the memo's `templates_fingerprint`: that hash covers substituted
    /// outer-item values and per-row key stamps, so under a nested ForEach
    /// it differs for every outer row even when the planned template is
    /// byte-identical — one skeleton would be re-registered per row, and
    /// every template store (engine, boundary expanders, DOM prototypes)
    /// would grow with rows ever seen. Content addressing collapses
    /// identical plans to one registration, wherever they were planned.
    pub template_id: String,
    /// `RegisterTemplate.root` payload: static skeleton as plain JSON.
    pub skeleton: serde_json::Value,
    /// `(dfs_index, prop_key)` of every dynamic (non-statically-resolvable)
    /// prop — each instance sends these as subs.
    pub dynamic: Vec<(usize, String)>,
    /// Total element count (`Instantiate.nodes` must match exactly).
    pub node_count: usize,
}

/// Can this prop value be resolved with NO state, item, or data-source
/// context — i.e. baked into the registered skeleton? Any `@{...}` in a
/// static string may interpolate at resolve time (item or state textual
/// forms), so it counts as dynamic — an over-approximation that is always
/// safe: dynamic props just travel as per-instance subs.
fn is_statically_resolvable(value: &Value) -> bool {
    match value {
        Value::Static(serde_json::Value::String(s)) => !s.contains("@{"),
        Value::Static(_) | Value::Action(_) | Value::Resource(_) => true,
        _ => false,
    }
}

/// Build an instantiation plan for one per-item template. `None` when the
/// template's structure can vary with the item (any non-Element node).
pub(crate) fn plan_instantiation(template: &IRNode) -> Option<InstantiationPlan> {
    fn walk(
        node: &IRNode,
        dfs: &mut usize,
        dynamic: &mut Vec<(usize, String)>,
    ) -> Option<serde_json::Value> {
        let IRNode::Element(element) = node else {
            return None;
        };
        let my_index = *dfs;
        *dfs += 1;

        let mut static_props = serde_json::Map::new();
        let mut evaluator = None;
        for (key, value) in &element.props {
            if is_statically_resolvable(value) {
                if let Some(v) =
                    resolve_single_value(value, &serde_json::Value::Null, None, None, &mut evaluator)
                {
                    if !is_engine_internal_prop(key) {
                        static_props.insert(key.clone(), v);
                    }
                }
            } else {
                dynamic.push((my_index, key.clone()));
            }
        }

        let mut children = Vec::with_capacity(element.ir_children.len());
        for child in &element.ir_children {
            children.push(walk(child, dfs, dynamic)?);
        }

        Some(serde_json::json!({
            "elementType": element.element_type,
            "props": static_props,
            "children": children,
        }))
    }

    let mut dfs = 0;
    let mut dynamic = Vec::new();
    let skeleton = walk(template, &mut dfs, &mut dynamic)?;

    // Content-address the wire id (see `InstantiationPlan::template_id`).
    // The skeleton serializes deterministically (`serde_json::Map` orders
    // keys), and the dynamic set must participate: two templates with the
    // same statics but different dynamic props are different templates.
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    match serde_json::to_string(&skeleton) {
        Ok(s) => s.hash(&mut hasher),
        // Serialization of plain JSON can't fail; never-matching fallback.
        Err(_) => u64::MAX.hash(&mut hasher),
    }
    for (dfs_index, key) in &dynamic {
        dfs_index.hash(&mut hasher);
        key.hash(&mut hasher);
    }

    Some(InstantiationPlan {
        template_id: format!("t{:016x}", hasher.finish()),
        skeleton,
        dynamic,
        node_count: dfs,
    })
}

/// Plan template emission for one iterable pass. Per-template `None` when
/// that template's structure can vary with the item.
pub(crate) fn plan_templates_for_emission(templates: &[IRNode]) -> Vec<Option<InstantiationPlan>> {
    templates.iter().map(plan_instantiation).collect()
}

/// Rewrite the patches a just-created iterable child appended since `mark`
/// into `[RegisterTemplate?, Instantiate]` when a plan covers it. No-op
/// (patches stay as emitted) when there are no plans (root-level ForEach —
/// no concrete render parent to address), the template is unplannable, or
/// the run doesn't match the plan.
pub(crate) fn emit_row_as_instantiate(
    ctx: &mut ReconcileCtx,
    plans: &Option<Vec<Option<InstantiationPlan>>>,
    template_idx: usize,
    mark: usize,
    render_parent: NodeId,
) {
    let plan = plans
        .as_ref()
        .and_then(|plans| plans.get(template_idx))
        .and_then(Option::as_ref);
    emit_row_as_instantiate_with(ctx, plan, mark, render_parent);
}

/// [`emit_row_as_instantiate`] for callers that already hold the one plan
/// that applies (or know there is none).
pub(crate) fn emit_row_as_instantiate_with(
    ctx: &mut ReconcileCtx,
    plan: Option<&InstantiationPlan>,
    mark: usize,
    render_parent: NodeId,
) {
    let Some(plan) = plan else { return };
    let registered = ctx.tree.registered_templates.contains(&plan.template_id);
    // Read the row's run in place — no per-row Vec materialization. On a
    // plan mismatch the run simply stays where it is.
    let Some(out) = instantiate_from_created(
        plan,
        &ctx.patches[mark..],
        super::patch::node_id_str(render_parent),
        registered,
    ) else {
        return;
    };
    if matches!(out.first(), Some(Patch::RegisterTemplate { .. })) {
        ctx.tree
            .registered_templates
            .insert(plan.template_id.clone());
    }
    ctx.patches.truncate(mark);
    ctx.patches.extend(out);
}

/// Convert the `Create`/`Insert` run a freshly built subtree just emitted
/// (drained from the patch stream by the caller) into one `Instantiate`.
/// Returns the patches to append: either `[RegisterTemplate?, Instantiate]`
/// or, when the run doesn't match the plan (defensive), the original run
/// unchanged.
pub(crate) fn instantiate_from_created(
    plan: &InstantiationPlan,
    row_patches: &[Patch],
    parent_id_str: Arc<str>,
    already_registered: bool,
) -> Option<Vec<Patch>> {
    // The run must be exactly the plan's shape: node_count Creates (DFS
    // order) and node_count Inserts, nothing else. Anything unexpected —
    // an animation stamp, a nested detach, a future patch kind — falls
    // back to the plain run.
    let mut nodes: Vec<Arc<str>> = Vec::with_capacity(plan.node_count);
    let mut semantics: Vec<(usize, crate::ir::Semantics)> = Vec::new();
    let mut subs: Vec<(usize, String, serde_json::Value)> = Vec::new();
    let mut inserts = 0usize;

    for patch in row_patches {
        match patch {
            Patch::Create {
                id,
                props,
                semantics: sem,
                ..
            } => {
                let dfs_index = nodes.len();
                for (dyn_index, prop) in &plan.dynamic {
                    if *dyn_index == dfs_index {
                        if let Some(v) = props.get(prop.as_str()) {
                            subs.push((dfs_index, prop.clone(), v.clone()));
                        }
                    }
                }
                if let Some(sem) = sem {
                    semantics.push((dfs_index, sem.clone()));
                }
                nodes.push(id.clone());
            }
            Patch::Insert { .. } => inserts += 1,
            _ => return None,
        }
    }
    if nodes.len() != plan.node_count || inserts != plan.node_count {
        return None;
    }

    let mut out = Vec::with_capacity(2);
    if !already_registered {
        out.push(Patch::RegisterTemplate {
            template_id: plan.template_id.clone(),
            root: plan.skeleton.clone(),
        });
    }
    out.push(Patch::Instantiate {
        template_id: plan.template_id.clone(),
        parent_id: parent_id_str,
        before_id: None,
        nodes,
        subs,
        semantics,
    });
    Some(out)
}

/// Update one instantiated row for a new item value by applying its
/// compiled binding map: resolve each item-dependent prop, diff against the
/// stored resolved prop, and emit `SetProp`/`RemoveProp` for real changes.
/// Both the resolved props AND the raw props are updated — a stale raw prop
/// would let a later state-driven `update_props` resolve back to the old
/// value.
///
/// Returns `false` when the instance subtree doesn't match the template
/// shape (a navigation miss) — the caller must fall back to full
/// substitute-and-reconcile for this row.
pub(crate) fn apply_compiled_row(
    ctx: &mut ReconcileCtx,
    root_id: NodeId,
    template: &CompiledTemplate,
    item: &serde_json::Value,
    item_name: &str,
) -> bool {
    let mut evaluator = None;
    // Nodes whose props changed; semantics deltas run once per node after
    // all its entries are applied (mirrors the dirty-render path).
    let mut touched: Vec<NodeId> = Vec::new();

    for entry in &template.entries {
        // Navigate the instance subtree by the entry's child-index path.
        let mut node_id = root_id;
        let mut ok = true;
        for &offset in &entry.offsets {
            match ctx
                .tree
                .get(node_id)
                .and_then(|n| n.children.get(offset).copied())
            {
                Some(child) => node_id = child,
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            return false;
        }

        // Same substitution + resolution the full pass performs.
        let new_raw = replace_value_item_bindings(&entry.value, item, item_name);
        let new_resolved = resolve_single_value(
            &new_raw,
            ctx.state,
            None,
            ctx.data_sources,
            &mut evaluator,
        );

        let Some(node) = ctx.tree.get_mut(node_id) else {
            return false;
        };

        match new_resolved {
            Some(resolved) => {
                if node.props.get(entry.prop.as_str()) == Some(&resolved) {
                    continue;
                }
                Arc::make_mut(&mut node.props).insert(entry.prop.clone(), resolved.clone());
                node.raw_props.insert(entry.prop.clone(), new_raw);
                if !is_engine_internal_prop(&entry.prop) {
                    ctx.patches
                        .push(Patch::set_prop(node_id, entry.prop.clone(), resolved));
                }
            }
            None => {
                // `.states` switch resolving to ABSENT: drop the prop.
                if Arc::make_mut(&mut node.props)
                    .shift_remove(entry.prop.as_str())
                    .is_none()
                {
                    continue;
                }
                node.raw_props.insert(entry.prop.clone(), new_raw);
                if !is_engine_internal_prop(&entry.prop) {
                    ctx.patches
                        .push(Patch::remove_prop(node_id, entry.prop.clone()));
                }
            }
        }

        if !touched.contains(&node_id) {
            touched.push(node_id);
        }
    }

    for node_id in touched {
        emit_semantics_delta(ctx.tree, node_id, ctx.patches);
    }

    true
}

// ───────────────────────── Prototype row creation ─────────────────────────
//
// Creation-side counterpart of the compiled binding map. The substitution
// path built every row by deep-cloning the per-item IR template with item
// values baked in, then resolving EVERY prop of every node from scratch.
// For a plannable template that rediscovers the same facts 1,000 times:
// the static and state-bound props resolve identically for every row in a
// pass, and only the item-dependent props differ.
//
// A `RowPrototype` resolves the invariant part ONCE per pass; each row is
// then materialized by Arc-cloning the prototype's resolved props and
// overlaying just the item-dependent entries — plus the `Instantiate`
// patch built directly, with no throwaway per-node `Create`/`Insert` run.
//
// Fallback discipline mirrors the rest of this module: any template shape
// the prototype can't faithfully reproduce (control flow, `__lazy`
// elements, a potential nested iterable) refuses to build, and the caller
// takes the substitution path unchanged.

/// One element of a row prototype, in DFS preorder.
pub(crate) struct ProtoNode {
    element_type: String,
    /// Static + state/data-source props, resolved once per pass. Per-row
    /// item values overlay copy-on-write, so item-free nodes share this
    /// map across every row via `Arc`.
    base_resolved: super::tree::ResolvedProps,
    /// Template raw props, item bindings intact — the per-row overlay
    /// substitutes only the item-dependent keys, so state bindings stay
    /// raw for later dirty re-resolution.
    base_raw: crate::ir::Props,
    /// `(prop key, pre-substitution value)` per item-dependent prop.
    item_entries: Vec<(String, Value)>,
    /// State/data-source bindings to register on every created node —
    /// the same set `create_element_node` would register after
    /// substitution (item bindings excluded; they substitute away).
    bindings: Vec<crate::reactive::Binding>,
    semantics: Option<crate::ir::Semantics>,
    module_scope: Option<String>,
    /// DFS index of the parent element (`None` for the row root).
    parent: Option<usize>,
}

pub(crate) struct RowPrototype {
    nodes: Vec<ProtoNode>,
}

/// Build a row prototype for one per-item template, or `None` when the
/// template's creation semantics can't be reproduced from a prototype:
/// non-Element nodes (control flow), `__lazy` elements (children are
/// deliberately not created), or a possible nested iterable (`props["0"]`
/// binding + children — `create_element_node` routes those specially).
pub(crate) fn build_row_prototype(
    ctx: &ReconcileCtx,
    template: &IRNode,
    item_name: &str,
) -> Option<RowPrototype> {
    fn walk(
        ctx: &ReconcileCtx,
        node: &IRNode,
        item_name: &str,
        parent: Option<usize>,
        out: &mut Vec<ProtoNode>,
    ) -> bool {
        let IRNode::Element(element) = node else {
            return false;
        };
        if element.props.get("__lazy").is_some() {
            return false;
        }
        if !element.ir_children.is_empty() {
            if let Some(Value::Binding(_)) = element.props.get("0") {
                return false;
            }
        }

        let my_index = out.len();
        let effective_state = ctx.effective_state(element.module_scope.as_deref());
        let mut base = indexmap::IndexMap::new();
        let mut item_entries = Vec::new();
        let mut bindings = Vec::new();
        let mut evaluator = None;
        for (key, value) in &element.props {
            match value {
                Value::Binding(b) if !b.is_item() => bindings.push(b.clone()),
                Value::TemplateString { bindings: bs, .. } => {
                    bindings.extend(bs.iter().filter(|b| !b.is_item()).cloned());
                }
                Value::StateSwitch { path, .. } => {
                    bindings.push(super::diff::state_switch_binding(path));
                }
                _ => {}
            }
            if value_depends_on_item(value, item_name) {
                item_entries.push((key.clone(), value.clone()));
            } else if let Some(v) =
                resolve_single_value(value, effective_state, None, ctx.data_sources, &mut evaluator)
            {
                base.insert(key.clone(), v);
            }
        }
        out.push(ProtoNode {
            element_type: element.element_type.clone(),
            base_resolved: Arc::new(base),
            base_raw: element.props.clone(),
            item_entries,
            bindings,
            semantics: element.semantics.clone(),
            module_scope: element.module_scope.clone(),
            parent,
        });
        for child in &element.ir_children {
            if !walk(ctx, child, item_name, Some(my_index), out) {
                return false;
            }
        }
        true
    }

    let mut nodes = Vec::new();
    walk(ctx, template, item_name, None, &mut nodes).then_some(RowPrototype { nodes })
}

/// Materialize one row from its prototype: clone the resolved bases,
/// overlay the item-dependent props, hang the subtree in the instance
/// tree with dependencies registered, and emit `[RegisterTemplate?,
/// Instantiate]` directly — no intermediate per-node patch run.
///
/// The wire output is identical to what `emit_row_as_instantiate` would
/// have collapsed: subs cover every `plan.dynamic` prop (engine-internal
/// carriers excluded, exactly as `strip_engine_internal_props` excluded
/// them from the harvested `Create` props), and semantics resolve against
/// the row's final props just as `create_element_node` resolves them.
#[allow(clippy::too_many_arguments)]
pub(crate) fn instantiate_row_from_proto(
    ctx: &mut ReconcileCtx,
    proto: &RowPrototype,
    plan: &InstantiationPlan,
    item: &serde_json::Value,
    item_name: &str,
    logical_parent: NodeId,
    render_parent: NodeId,
) -> NodeId {
    let mut ids: Vec<NodeId> = Vec::with_capacity(proto.nodes.len());
    let mut subs: Vec<(usize, String, serde_json::Value)> = Vec::new();
    let mut wire_semantics: Vec<(usize, crate::ir::Semantics)> = Vec::new();
    let mut evaluator = None;

    for (index, proto_node) in proto.nodes.iter().enumerate() {
        let mut props = proto_node.base_resolved.clone();
        let mut raw = proto_node.base_raw.clone();
        for (prop, raw_value) in &proto_node.item_entries {
            let new_raw = replace_value_item_bindings(raw_value, item, item_name);
            match resolve_single_value(&new_raw, ctx.state, None, ctx.data_sources, &mut evaluator)
            {
                Some(v) => {
                    Arc::make_mut(&mut props).insert(prop.clone(), v);
                }
                None => {
                    Arc::make_mut(&mut props).shift_remove(prop.as_str());
                }
            }
            raw.insert(prop.clone(), new_raw);
        }

        let resolved_semantics = super::diff::resolve_semantics(&proto_node.semantics, &props);
        if let Some(sem) = &resolved_semantics {
            wire_semantics.push((index, sem.clone()));
        }
        for (dyn_index, prop) in &plan.dynamic {
            if *dyn_index == index && !is_engine_internal_prop(prop) {
                if let Some(v) = props.get(prop.as_str()) {
                    subs.push((index, prop.clone(), v.clone()));
                }
            }
        }

        let node_id = ctx.tree.insert_node_with(|id| super::tree::InstanceNode {
            id,
            element_type: proto_node.element_type.clone(),
            props,
            raw_props: raw,
            element_template: None,
            ir_node_template: None,
            control_flow: None,
            key: None,
            parent: None,
            children: im::Vector::new(),
            module_scope: proto_node.module_scope.clone(),
            semantics: proto_node.semantics.clone(),
            last_semantics: resolved_semantics,
            iter_memo: None,
            iter_compiled: None,
            iter_fp_cache: None,
        });

        let scope = ctx.effective_scope(proto_node.module_scope.as_deref());
        for binding in &proto_node.bindings {
            ctx.dependencies.add_dependency(node_id, binding, scope);
        }

        match proto_node.parent {
            Some(parent_index) => ctx.tree.add_child(ids[parent_index], node_id, None),
            None => ctx.tree.add_child(logical_parent, node_id, None),
        }
        ids.push(node_id);
    }

    if !ctx.tree.registered_templates.contains(&plan.template_id) {
        ctx.tree
            .registered_templates
            .insert(plan.template_id.clone());
        ctx.patches.push(Patch::RegisterTemplate {
            template_id: plan.template_id.clone(),
            root: plan.skeleton.clone(),
        });
    }
    ctx.patches.push(Patch::Instantiate {
        template_id: plan.template_id.clone(),
        parent_id: super::patch::node_id_str(render_parent),
        before_id: None,
        nodes: ids.iter().map(|&id| super::patch::node_id_str(id)).collect(),
        subs,
        semantics: wire_semantics,
    });

    ids[0]
}
