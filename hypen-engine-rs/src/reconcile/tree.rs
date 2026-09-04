use super::resolve::{resolve_props, resolve_props_full};
use crate::ir::{Element, IRNode, NodeId, Props, Semantics};
use indexmap::IndexMap;
use slotmap::SlotMap;
use std::sync::Arc;

/// Data sources type alias for readability
type DataSources = indexmap::IndexMap<String, serde_json::Value>;

/// Resolved prop map, shared behind `Arc` for O(1) cloning.
///
/// Every `InstanceNode` holds one of these and every `Patch::Create`
/// takes one. Emitting a Create for an existing node is therefore an
/// `Arc::clone` rather than a deep copy of the resolved `IndexMap`.
/// Resolution itself (`resolve_props_full`) still allocates fresh on
/// every call — the Arc is only for downstream sharing, not for any
/// form of caching across state updates.
pub type ResolvedProps = Arc<IndexMap<String, serde_json::Value>>;

/// Default cap on the number of cached route subtrees per Router node.
/// Oldest entry is evicted (and its subtree torn down) when exceeded.
/// Chosen to comfortably cover typical bottom-nav and small-stack apps
/// without unbounded memory growth.
pub const DEFAULT_ROUTER_CACHE_SIZE: usize = 10;

/// The kind of control flow node for re-reconciliation
#[derive(Debug, Clone)]
pub enum ControlFlowKind {
    /// ForEach iteration container
    ForEach {
        item_name: String,
        key_path: Option<String>,
    },
    /// Conditional (When/If) container
    Conditional,
    /// Router container — selects which Route's children to render based on
    /// the current location.
    ///
    /// Retains detached route subtrees between navigations so that
    /// navigating back to a previously-visited route emits `Attach`
    /// patches instead of rebuilding the tree. The cache is an
    /// insertion-ordered LRU; inserting past `max_cache_size` evicts
    /// the oldest entry and tears down its subtree.
    Router {
        /// Detached top-level child NodeIds keyed by route pattern.
        /// Each entry corresponds to a route that was previously
        /// rendered and has since been unlinked from the Router's
        /// children; descendants of these NodeIds stay in the
        /// InstanceTree + DependencyGraph (so state updates still
        /// flow through them — keep-alive semantics).
        cache: IndexMap<String, Vec<NodeId>>,
        /// Route pattern of the currently-rendered route, if any.
        /// `None` when no route matches (fallback rendered, or on
        /// brand-new Router before first location resolution).
        current_route_key: Option<String>,
        /// Maximum number of routes to cache before LRU eviction.
        max_cache_size: usize,
    },
}

/// Instance node - a concrete instance of an element in the tree
///
/// Uses im::Vector for children to enable O(1) structural sharing during clones.
/// This is critical for reconciliation performance where nodes are frequently cloned.
#[derive(Debug, Clone)]
pub struct InstanceNode {
    /// Unique node ID
    pub id: NodeId,

    /// Element type (e.g., "Column", "Text", "__ForEach", "__Conditional")
    pub element_type: String,

    /// Resolved props (bindings evaluated to actual values). Wrapped in
    /// `Arc` so emitting a `Create` patch for this node is O(1).
    pub props: ResolvedProps,

    /// Raw props (including bindings) for change detection - Arc-wrapped for O(1) clone
    pub raw_props: Props,

    /// Original element template (for List re-rendering) - legacy
    /// Only populated for List elements that need to re-render children
    /// Arc-wrapped for O(1) clone during reconciliation
    pub element_template: Option<Arc<Element>>,

    /// Original IRNode template (for ForEach/Conditional re-rendering)
    /// Used for control flow nodes that need to re-render on state change
    /// Arc-wrapped for O(1) clone during reconciliation
    pub ir_node_template: Option<Arc<IRNode>>,

    /// Control flow metadata for ForEach/Conditional nodes
    pub control_flow: Option<ControlFlowKind>,

    // Event handling removed - now done at renderer level
    /// Optional key for reconciliation
    pub key: Option<String>,

    /// Parent node ID
    pub parent: Option<NodeId>,

    /// Child node IDs (ordered) - uses im::Vector for O(1) clone
    pub children: im::Vector<NodeId>,

    /// Module scope this node belongs to (if any).
    /// Used during dirty re-rendering to resolve `@{state.xxx}` against
    /// the correct named module's state.
    pub module_scope: Option<String>,

    /// Derived accessibility semantics for this node, carried from the IR
    /// `Element` so any path that re-emits a `Create` patch (e.g. List
    /// re-render) keeps the node's semantics. `None` for control-flow
    /// containers and elements with nothing derivable.
    ///
    /// This is the *base* (derive-time) block — templated names and bound
    /// state unresolved. The resolved block last sent to the renderer lives
    /// in [`last_semantics`](Self::last_semantics).
    pub semantics: Option<Semantics>,

    /// The fully-resolved semantics block last emitted to the renderer
    /// (with `Create` or a later `SetSemantics`). Dirty re-renders resolve
    /// [`semantics`](Self::semantics) against the fresh props and compare
    /// against this to decide whether a [`Patch::SetSemantics`] is due —
    /// static blocks never compare unequal, so static trees emit nothing.
    pub last_semantics: Option<Semantics>,

    /// Iterable-child memo: the `(item value, templates fingerprint)` this
    /// child was last reconciled against, stamped by keyed reconciliation
    /// (`reconcile_iterable_children_full`). A later reconcile whose key
    /// matches AND whose memo compares equal skips template substitution and
    /// the whole subtree walk for this child — the per-item equivalent of
    /// React's `memo` bail-out. `None` for nodes that aren't iterable
    /// children. Boxed so the common case costs one pointer.
    ///
    /// State (`@{state.*}`) bindings inside the subtree stay live despite the
    /// skip: they are registered per-node in the `DependencyGraph`, so a
    /// state change dirties those nodes directly and the regular dirty-node
    /// path refreshes them without the list's involvement.
    pub iter_memo: Option<IterMemo>,

    /// Compiled binding-map cache for iterable CONTAINERS (List/ForEach
    /// nodes), keyed by the same templates fingerprint as the memo. See
    /// [`binding_map`](super::binding_map). `None` on non-container nodes;
    /// a cache whose `compiled` is `None` records "not compilable" so the
    /// compile walk isn't retried every pass.
    pub iter_compiled: Option<Box<super::binding_map::CompiledCache>>,

    /// Cached templates fingerprint for iterable CONTAINERS whose template
    /// list is the node's own stored `Arc` (List `element_template`,
    /// ForEach `ir_node_template`) — those are set once at node creation
    /// and never mutated in place, so the hash never goes stale. Passes
    /// whose templates arrive externally substituted (nested ForEach) must
    /// NOT read this; they recompute (see
    /// `keyed::fingerprint_for_container`'s `stable` flag).
    pub iter_fp_cache: Option<u64>,
}

/// See [`InstanceNode::iter_memo`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IterMemo {
    /// Content hash of the item this child last rendered (see
    /// `keyed::item_fingerprint`). A hash instead of a deep clone: stamping
    /// a memo cost a full item copy per changed row, and the equality probe
    /// walked both values — hashing the incoming item once per row does the
    /// same job allocation-free. The 64-bit collision risk (a wrongly
    /// skipped row) is on the order of 2^-64 per comparison.
    pub item_hash: u64,
    /// Fingerprint of the substitution templates in effect (hash of their
    /// serialized form). Templates embed outer-loop substitutions for nested
    /// ForEach, so an outer item change changes the fingerprint and defeats
    /// the memo even when this child's own item is unchanged.
    pub templates_hash: u64,
}

impl InstanceNode {
    pub fn new(id: NodeId, element: &Element, state: &serde_json::Value) -> Self {
        Self::new_full(id, element, state, None)
    }

    pub fn new_full(
        id: NodeId,
        element: &Element,
        state: &serde_json::Value,
        data_sources: Option<&DataSources>,
    ) -> Self {
        let props = resolve_props_full(&element.props, state, None, data_sources);

        Self {
            id,
            element_type: element.element_type.clone(),
            props,
            raw_props: element.props.clone(),
            element_template: None,
            ir_node_template: None,
            control_flow: None,
            key: element.key.clone(),
            parent: None,
            children: im::Vector::new(),
            module_scope: element.module_scope.clone(),
            semantics: element.semantics.clone(),
            last_semantics: None,
            iter_memo: None,
            iter_compiled: None,
            iter_fp_cache: None,
        }
    }

    /// Create a control flow container node (ForEach or Conditional)
    pub fn new_control_flow(
        id: NodeId,
        element_type: &str,
        props: ResolvedProps,
        raw_props: Props,
        control_flow: ControlFlowKind,
        ir_node_template: IRNode,
    ) -> Self {
        Self {
            id,
            element_type: element_type.to_string(),
            props,
            raw_props,
            element_template: None,
            ir_node_template: Some(Arc::new(ir_node_template)),
            control_flow: Some(control_flow),
            key: None,
            parent: None,
            children: im::Vector::new(),
            module_scope: None,
            semantics: None,
            last_semantics: None,
            iter_memo: None,
            iter_compiled: None,
            iter_fp_cache: None,
        }
    }

    /// Update props by re-evaluating bindings against new state
    pub fn update_props(&mut self, state: &serde_json::Value) {
        self.props = resolve_props(&self.raw_props, state);
    }

    /// Update props by re-evaluating bindings against state and data sources
    pub fn update_props_with_data_sources(
        &mut self,
        state: &serde_json::Value,
        data_sources: Option<&IndexMap<String, serde_json::Value>>,
    ) {
        self.props = resolve_props_full(&self.raw_props, state, None, data_sources);
    }

    /// Check if this is a ForEach control flow node
    pub fn is_foreach(&self) -> bool {
        matches!(self.control_flow, Some(ControlFlowKind::ForEach { .. }))
    }

    /// Check if this is a Conditional control flow node
    pub fn is_conditional(&self) -> bool {
        matches!(self.control_flow, Some(ControlFlowKind::Conditional))
    }

    /// Check if this is a Router control flow node
    pub fn is_router(&self) -> bool {
        matches!(self.control_flow, Some(ControlFlowKind::Router { .. }))
    }
}

/// The instance tree - maintains the current UI tree state
pub struct InstanceTree {
    /// All nodes in the tree
    nodes: SlotMap<NodeId, InstanceNode>,

    /// Root node ID
    root: Option<NodeId>,

    /// Template ids already sent this session — each `RegisterTemplate`
    /// goes out exactly once; every later plannable row references it via
    /// `Instantiate`. Boundaries whose consumers can't clone templates
    /// lower the stream back to plain patches with
    /// `portable::TemplateExpander`.
    pub registered_templates: std::collections::HashSet<String>,
}

impl InstanceTree {
    pub fn new() -> Self {
        Self {
            nodes: SlotMap::with_key(),
            root: None,
            registered_templates: std::collections::HashSet::new(),
        }
    }

    /// Clear all nodes and reset the tree
    pub fn clear(&mut self) {
        self.nodes.clear();
        self.root = None;
        // A cleared tree usually precedes a fresh render to the SAME
        // consumer, whose registered templates survive — keep the set so
        // templates aren't re-sent.
    }

    /// Create a new node and return its ID
    /// Insert a fully pre-built node, letting the builder see its assigned
    /// id. The prototype-clone creation path constructs `InstanceNode`s
    /// directly (no `Element` resolution) — see `binding_map`.
    pub(crate) fn insert_node_with(
        &mut self,
        build: impl FnOnce(NodeId) -> InstanceNode,
    ) -> NodeId {
        self.nodes.insert_with_key(build)
    }

    pub fn create_node(&mut self, element: &Element, state: &serde_json::Value) -> NodeId {
        self.nodes
            .insert_with_key(|id| InstanceNode::new(id, element, state))
    }

    /// Create a new node with data sources and return its ID
    pub fn create_node_full(
        &mut self,
        element: &Element,
        state: &serde_json::Value,
        data_sources: Option<&DataSources>,
    ) -> NodeId {
        self.nodes
            .insert_with_key(|id| InstanceNode::new_full(id, element, state, data_sources))
    }

    /// Create a control flow node (ForEach or Conditional) and return its ID
    pub fn create_control_flow_node(
        &mut self,
        element_type: &str,
        props: ResolvedProps,
        raw_props: Props,
        control_flow: ControlFlowKind,
        ir_node_template: IRNode,
    ) -> NodeId {
        self.nodes.insert_with_key(|id| {
            InstanceNode::new_control_flow(
                id,
                element_type,
                props,
                raw_props,
                control_flow,
                ir_node_template,
            )
        })
    }

    /// Get a node by ID
    pub fn get(&self, id: NodeId) -> Option<&InstanceNode> {
        self.nodes.get(id)
    }

    /// Get a mutable node by ID
    pub fn get_mut(&mut self, id: NodeId) -> Option<&mut InstanceNode> {
        self.nodes.get_mut(id)
    }

    /// Remove a node and all its descendants
    pub fn remove(&mut self, id: NodeId) -> Option<InstanceNode> {
        if let Some(node) = self.nodes.get(id) {
            let children = node.children.clone();
            // Remove all children recursively
            for child_id in children {
                self.remove(child_id);
            }
        }
        self.nodes.remove(id)
    }

    /// Set the root node
    pub fn set_root(&mut self, id: NodeId) {
        self.root = Some(id);
    }

    /// Get the root node ID
    pub fn root(&self) -> Option<NodeId> {
        self.root
    }

    /// Add a child to a parent node
    pub fn add_child(&mut self, parent_id: NodeId, child_id: NodeId, before: Option<NodeId>) {
        if let Some(parent) = self.nodes.get_mut(parent_id) {
            if let Some(before_id) = before {
                if let Some(pos) = parent.children.iter().position(|&id| id == before_id) {
                    parent.children.insert(pos, child_id);
                } else {
                    parent.children.push_back(child_id);
                }
            } else {
                parent.children.push_back(child_id);
            }
        }

        if let Some(child) = self.nodes.get_mut(child_id) {
            child.parent = Some(parent_id);
        }
    }

    /// Remove a child from its parent
    pub fn remove_child(&mut self, parent_id: NodeId, child_id: NodeId) {
        if let Some(parent) = self.nodes.get_mut(parent_id) {
            parent.children = parent
                .children
                .iter()
                .filter(|&&id| id != child_id)
                .copied()
                .collect();
        }

        if let Some(child) = self.nodes.get_mut(child_id) {
            child.parent = None;
        }
    }

    /// Update all nodes that depend on changed state
    pub fn update_nodes(
        &mut self,
        node_ids: &indexmap::IndexSet<NodeId>,
        state: &serde_json::Value,
    ) {
        for &node_id in node_ids {
            if let Some(node) = self.nodes.get_mut(node_id) {
                node.update_props(state);
            }
        }
    }

    /// Return the total number of nodes in the tree.
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// Return whether the tree is empty.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Iterate over all nodes
    pub fn iter(&self) -> impl Iterator<Item = (NodeId, &InstanceNode)> {
        self.nodes.iter()
    }
}

impl Default for InstanceTree {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {

    use crate::reconcile::resolve::evaluate_binding;
    use serde_json::json;

    #[test]
    fn test_evaluate_binding() {
        use crate::reactive::Binding;

        let state = json!({
            "user": {
                "name": "Alice",
                "age": 30
            }
        });

        let name_binding = Binding::state(vec!["user".to_string(), "name".to_string()]);
        let age_binding = Binding::state(vec!["user".to_string(), "age".to_string()]);
        let email_binding = Binding::state(vec!["user".to_string(), "email".to_string()]);

        assert_eq!(
            evaluate_binding(&name_binding, &state),
            Some(json!("Alice"))
        );
        assert_eq!(evaluate_binding(&age_binding, &state), Some(json!(30)));
        assert_eq!(evaluate_binding(&email_binding, &state), None);
    }
}
