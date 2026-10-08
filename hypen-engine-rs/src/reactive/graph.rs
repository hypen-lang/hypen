use super::Binding;
use crate::ir::NodeId;
use indexmap::{IndexMap, IndexSet};
use std::collections::BTreeMap;
use std::hash::{BuildHasherDefault, Hasher};

/// Hasher for `NodeId`-keyed maps. A slotmap key hashes as two `u32`
/// writes (slot index, version) that are already well distributed, so one
/// multiply-rotate mix per write (the FxHash step) replaces SipHash at a
/// fraction of the instructions. Every node registers and unregisters
/// through these maps — a 1,000-row teardown probes it ~17k times.
#[derive(Default)]
struct NodeIdHasher(u64);

impl Hasher for NodeIdHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(u64::from(b));
        }
    }
    fn write_u32(&mut self, i: u32) {
        self.write_u64(u64::from(i));
    }
    fn write_u64(&mut self, i: u64) {
        self.0 = (self.0.rotate_left(5) ^ i).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}

type NodeIdMap<V> = IndexMap<NodeId, V, BuildHasherDefault<NodeIdHasher>>;

/// Tracks which nodes depend on which state paths
pub struct DependencyGraph {
    /// Maps state path → set of NodeIds that depend on it
    dependencies: IndexMap<String, IndexSet<NodeId>>,

    /// Maps NodeId → set of state paths it depends on
    node_bindings: NodeIdMap<IndexSet<String>>,

    /// Prefix index for efficient path lookups
    /// Maps path prefix → set of full paths that start with this prefix
    /// This enables O(log n) lookup instead of O(n) scan
    prefix_index: BTreeMap<String, IndexSet<String>>,

    /// Known data source provider names (registered via `register_data_source_provider`).
    /// When a `DataSource` binding references an unknown provider, it is tracked here
    /// so the host can emit warnings. This prevents typos like `@{username.field}` from
    /// silently resolving to null instead of erroring.
    registered_providers: IndexSet<String>,

    /// Data source providers referenced in bindings but not yet registered.
    /// The host can query this after a render pass to warn about potential typos.
    unregistered_provider_refs: IndexSet<String>,

    /// Reusable buffer for building a binding's graph key in
    /// [`add_dependency`](Self::add_dependency). Re-registering a dependency
    /// that already exists is the overwhelmingly common case on re-render, and
    /// it must not allocate just to discover there is nothing to do.
    key_scratch: String,
}

impl DependencyGraph {
    pub fn new() -> Self {
        Self {
            dependencies: IndexMap::new(),
            node_bindings: NodeIdMap::default(),
            prefix_index: BTreeMap::new(),
            registered_providers: IndexSet::new(),
            unregistered_provider_refs: IndexSet::new(),
            key_scratch: String::new(),
        }
    }

    /// Record that a node depends on a binding.
    ///
    /// State bindings use their path directly (e.g., `user.name`). When
    /// `module_scope` is `Some(name)`, state bindings are namespaced as
    /// `mod:name:path` (e.g., `mod:search:query`) so that
    /// `update_state(Some("search"), ...)` only invalidates nodes bound to
    /// that module's state.
    ///
    /// Data source bindings are namespaced as `ds:provider:path` regardless of
    /// module scope. Item bindings are skipped (handled by ForEach scope).
    ///
    /// Re-registering an existing `(node, path)` pair is a no-op. Reconciles
    /// re-walk every surviving node's bindings, so that is the hot case: the
    /// key is built into a reusable buffer and one hash probe ends the call
    /// with nothing allocated. Only a genuinely new registration pays for the
    /// owned keys the maps and prefix index keep.
    pub fn add_dependency(
        &mut self,
        node_id: NodeId,
        binding: &Binding,
        module_scope: Option<&str>,
    ) {
        use super::BindingSource;
        if binding.is_item() {
            return; // Item deps handled by ForEach scope
        }

        let mut key = std::mem::take(&mut self.key_scratch);
        key.clear();
        match &binding.source {
            BindingSource::State => {
                if let Some(scope) = module_scope {
                    key.push_str("mod:");
                    key.push_str(scope);
                    key.push(':');
                }
            }
            // Unreachable: filtered above. Restore the buffer and bail.
            BindingSource::Item => {
                self.key_scratch = key;
                return;
            }
            BindingSource::DataSource(provider) => {
                // Track references to unregistered providers so the host can warn
                if !self.registered_providers.contains(provider.as_str()) {
                    self.unregistered_provider_refs.insert(provider.clone());
                }
                key.push_str("ds:");
                key.push_str(provider);
                key.push(':');
            }
        }
        // Same as `binding.full_path()`, written in place.
        for (idx, segment) in binding.path.iter().enumerate() {
            if idx > 0 {
                key.push('.');
            }
            key.push_str(segment);
        }

        // Already registered — the dependencies map, node_bindings map and
        // prefix index all already carry exactly these facts.
        let known = self
            .node_bindings
            .get(&node_id)
            .is_some_and(|paths| paths.contains(key.as_str()));

        if !known {
            // Add to dependencies map
            self.dependencies
                .entry(key.clone())
                .or_default()
                .insert(node_id);

            // Add to node_bindings map
            self.node_bindings
                .entry(node_id)
                .or_default()
                .insert(key.clone());

            // Update prefix index for efficient lookups
            // Add all prefixes of this path to the index
            self.add_path_to_prefix_index(&key);
        }

        self.key_scratch = key;
    }

    /// Add a path and all its prefixes to the prefix index
    fn add_path_to_prefix_index(&mut self, path: &str) {
        // Add the full path to its own prefix
        self.prefix_index
            .entry(path.to_string())
            .or_default()
            .insert(path.to_string());

        // Add all parent prefixes
        let mut current = path;
        while let Some(dot_pos) = current.rfind('.') {
            current = &current[..dot_pos];
            self.prefix_index
                .entry(current.to_string())
                .or_default()
                .insert(path.to_string());
        }
    }

    /// Remove all dependencies for a node (when unmounting).
    ///
    /// Uses `swap_remove` throughout: `shift_remove` is O(map len) per call,
    /// so unmounting a large tree costs quadratic entry shifts. Both maps are
    /// membership indexes — `node_bindings` is only ever probed by key, and a
    /// path's dependent set is drained into the scheduler's dirty set, whose
    /// members are re-rendered independently — so the residual order of the
    /// entries a removal leaves behind is not part of the contract.
    ///
    /// A path whose last dependent node goes away is pruned from both the
    /// dependencies map and the prefix index. Without that, every binding
    /// path ever mounted stays behind as an empty entry: a long-lived app
    /// that keeps mounting rows with fresh `items.<n>.title` bindings grows
    /// both maps without bound, and every `get_affected_nodes("items")`
    /// walks the dead paths too.
    pub fn remove_node(&mut self, node_id: NodeId) {
        if let Some(paths) = self.node_bindings.swap_remove(&node_id) {
            for path in paths {
                let now_empty = match self.dependencies.get_mut(&path) {
                    Some(nodes) => {
                        nodes.swap_remove(&node_id);
                        nodes.is_empty()
                    }
                    None => false,
                };
                if now_empty {
                    self.dependencies.swap_remove(&path);
                    self.remove_path_from_prefix_index(&path);
                }
            }
        }
    }

    /// Inverse of [`add_path_to_prefix_index`](Self::add_path_to_prefix_index):
    /// drop `path` from its own entry and from every parent prefix, deleting
    /// prefix entries that end up empty.
    fn remove_path_from_prefix_index(&mut self, path: &str) {
        let mut current = path;
        loop {
            if let Some(paths) = self.prefix_index.get_mut(current) {
                paths.swap_remove(path);
                if paths.is_empty() {
                    self.prefix_index.remove(current);
                }
            }
            match current.rfind('.') {
                Some(dot_pos) => current = &current[..dot_pos],
                None => break,
            }
        }
    }

    /// Number of distinct state paths with at least one dependent node.
    pub fn tracked_path_count(&self) -> usize {
        self.dependencies.len()
    }

    /// Number of prefix-index entries (every tracked path plus every
    /// parent prefix of one).
    pub fn prefix_index_len(&self) -> usize {
        self.prefix_index.len()
    }

    /// Get all nodes that depend on a specific state path
    pub fn get_dependent_nodes(&self, path: &str) -> Option<&IndexSet<NodeId>> {
        self.dependencies.get(path)
    }

    /// Get all nodes affected by a state patch (considers nested paths)
    /// E.g., if "user" changes, both "user" and "user.name" subscribers are affected
    /// Uses prefix index for O(log n) lookup instead of O(n) scan
    pub fn get_affected_nodes(&self, changed_path: &str) -> IndexSet<NodeId> {
        let mut affected = IndexSet::new();
        let mut affected_paths = IndexSet::new();

        // Strategy: Find all paths that could be affected by this change
        // 1. Exact match: changed_path itself
        if self.dependencies.contains_key(changed_path) {
            affected_paths.insert(changed_path.to_string());
        }

        // 2. Parent paths: all prefixes of changed_path (e.g., "user.name" affects "user")
        let mut current = changed_path;
        while let Some(dot_pos) = current.rfind('.') {
            current = &current[..dot_pos];
            if self.dependencies.contains_key(current) {
                affected_paths.insert(current.to_string());
            }
        }

        // 3. Child paths: all paths that start with changed_path (e.g., "user" affects "user.name")
        // Use prefix index for efficient lookup
        if let Some(child_paths) = self.prefix_index.get(changed_path) {
            affected_paths.extend(child_paths.iter().cloned());
        }

        // Collect nodes from all affected paths
        for path in affected_paths {
            if let Some(nodes) = self.dependencies.get(&path) {
                affected.extend(nodes.iter().copied());
            }
        }

        affected
    }

    /// Register a data source provider name so that bindings to it
    /// are treated as intentional (not typos).
    pub fn register_data_source_provider(&mut self, name: impl Into<String>) {
        let name = name.into();
        self.registered_providers.insert(name.clone());
        // If this provider was previously flagged as unregistered, remove it
        self.unregistered_provider_refs.shift_remove(&name);
    }

    /// Get data source providers referenced in bindings but not registered.
    /// The host should warn about these — they likely represent typos
    /// (e.g., `@{username.field}` when the dev meant `@{state.username.field}`).
    pub fn unregistered_provider_refs(&self) -> &IndexSet<String> {
        &self.unregistered_provider_refs
    }

    /// Get all nodes bound to a data source provider.
    ///
    /// The prefix index uses `.` separators but data source paths use `:`
    /// between the `ds`, provider, and root key (e.g., `ds:spacetime:messages`).
    /// This method handles the `:` boundary correctly by scanning dependency paths.
    pub fn get_data_source_affected_nodes(&self, provider: &str) -> IndexSet<NodeId> {
        let prefix = format!("ds:{}:", provider);
        let root = format!("ds:{}", provider);
        let mut affected = IndexSet::new();

        for (path, nodes) in &self.dependencies {
            if path == &root || path.starts_with(&prefix) {
                affected.extend(nodes.iter().copied());
            }
        }

        affected
    }

    /// Nodes bound to a data source provider that read something under one of
    /// `changed_paths` (dotted, relative to the provider root, e.g.
    /// `user.name`), plus any node bound to the provider root itself.
    ///
    /// The sparse counterpart of
    /// [`get_data_source_affected_nodes`](Self::get_data_source_affected_nodes):
    /// a provider refresh that changed only `messages.3.text` leaves nodes
    /// bound to `ds:provider:user.name` alone. Each path resolves through
    /// the prefix index exactly like a state path (exact match, parents,
    /// children), so a binding to `messages` sees the change to
    /// `messages.3.text` and vice versa.
    pub fn get_data_source_affected_nodes_for_paths<'p>(
        &self,
        provider: &str,
        changed_paths: impl IntoIterator<Item = &'p str>,
    ) -> IndexSet<NodeId> {
        let mut affected = IndexSet::new();
        let mut key = String::with_capacity(provider.len() + 4);
        key.push_str("ds:");
        key.push_str(provider);
        key.push(':');
        let prefix_len = key.len();

        // A binding to the bare provider (`@{provider}`) registers under the
        // empty relative path; it reads the whole blob, so any change hits it.
        if let Some(nodes) = self.dependencies.get(key.as_str()) {
            affected.extend(nodes.iter().copied());
        }

        for path in changed_paths {
            key.truncate(prefix_len);
            key.push_str(path);
            affected.extend(self.get_affected_nodes(&key));
        }

        affected
    }

    /// Clear all dependencies (preserves registered providers)
    pub fn clear(&mut self) {
        self.dependencies.clear();
        self.node_bindings.clear();
        self.prefix_index.clear();
        self.unregistered_provider_refs.clear();
    }
}

impl Default for DependencyGraph {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prefix_index_basic() {
        use super::Binding;
        use crate::ir::Element;
        use crate::reconcile::tree::InstanceTree;

        let mut graph = DependencyGraph::new();

        // Create real NodeIds using InstanceTree
        let mut tree = InstanceTree::new();
        let node1 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
        let node2 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
        let node3 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));

        // Add dependencies
        let binding1 = Binding::state(vec!["user".to_string()]);
        let binding2 = Binding::state(vec!["user".to_string(), "name".to_string()]);
        let binding3 = Binding::state(vec!["user".to_string(), "email".to_string()]);

        graph.add_dependency(node1, &binding1, None);
        graph.add_dependency(node2, &binding2, None);
        graph.add_dependency(node3, &binding3, None);

        // Verify prefix index was built correctly
        assert!(graph.prefix_index.contains_key("user"));
        assert!(graph.prefix_index.contains_key("user.name"));
        assert!(graph.prefix_index.contains_key("user.email"));

        // user prefix should contain all three paths
        let user_paths = graph.prefix_index.get("user").unwrap();
        assert_eq!(user_paths.len(), 3);
        assert!(user_paths.contains("user"));
        assert!(user_paths.contains("user.name"));
        assert!(user_paths.contains("user.email"));
    }

    #[test]
    fn test_get_affected_nodes_with_prefix_index() {
        use super::Binding;
        use crate::ir::Element;
        use crate::reconcile::tree::InstanceTree;

        let mut graph = DependencyGraph::new();

        // Create real NodeIds using InstanceTree
        let mut tree = InstanceTree::new();
        let node1 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
        let node2 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
        let node3 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
        let node4 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));

        // Add dependencies
        graph.add_dependency(node1, &Binding::state(vec!["user".to_string()]), None);
        graph.add_dependency(
            node2,
            &Binding::state(vec!["user".to_string(), "name".to_string()]),
            None,
        );
        graph.add_dependency(
            node3,
            &Binding::state(vec!["user".to_string(), "email".to_string()]),
            None,
        );
        graph.add_dependency(node4, &Binding::state(vec!["posts".to_string()]), None);

        // When "user" changes, should affect node1, node2, and node3 (but not node4)
        let affected = graph.get_affected_nodes("user");
        assert_eq!(affected.len(), 3);
        assert!(affected.contains(&node1));
        assert!(affected.contains(&node2));
        assert!(affected.contains(&node3));
        assert!(!affected.contains(&node4));
    }

    #[test]
    fn test_get_affected_nodes_child_change() {
        use super::Binding;
        use crate::ir::Element;
        use crate::reconcile::tree::InstanceTree;

        let mut graph = DependencyGraph::new();

        // Create real NodeIds using InstanceTree
        let mut tree = InstanceTree::new();
        let node1 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
        let node2 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));

        graph.add_dependency(node1, &Binding::state(vec!["user".to_string()]), None);
        graph.add_dependency(
            node2,
            &Binding::state(vec!["user".to_string(), "name".to_string()]),
            None,
        );

        // When "user.name" changes, should affect both parent "user" and child "user.name"
        let affected = graph.get_affected_nodes("user.name");
        assert_eq!(affected.len(), 2);
        assert!(affected.contains(&node1)); // parent "user" affected
        assert!(affected.contains(&node2)); // exact match "user.name" affected
    }

    #[test]
    fn test_get_affected_nodes_exact_match_only() {
        use super::Binding;
        use crate::ir::Element;
        use crate::reconcile::tree::InstanceTree;

        let mut graph = DependencyGraph::new();

        // Create real NodeId using InstanceTree
        let mut tree = InstanceTree::new();
        let node1 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));

        graph.add_dependency(
            node1,
            &Binding::state(vec!["user".to_string(), "name".to_string()]),
            None,
        );

        // When "user.email" changes, should not affect "user.name"
        let affected = graph.get_affected_nodes("user.email");
        assert_eq!(affected.len(), 0);
    }

    #[test]
    fn test_prefix_index_performance() {
        use super::Binding;
        use crate::ir::Element;
        use crate::reconcile::tree::InstanceTree;

        let mut graph = DependencyGraph::new();
        let mut tree = InstanceTree::new();

        // Add many dependencies with nested paths
        for i in 0..100 {
            let node_id = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
            let path = vec![
                "user".to_string(),
                "profile".to_string(),
                "details".to_string(),
                format!("field{}", i),
            ];
            let binding = Binding::state(path);
            graph.add_dependency(node_id, &binding, None);
        }

        // Should efficiently find all affected nodes when parent changes
        let affected = graph.get_affected_nodes("user");
        assert_eq!(affected.len(), 100);

        let affected = graph.get_affected_nodes("user.profile");
        assert_eq!(affected.len(), 100);

        let affected = graph.get_affected_nodes("user.profile.details");
        assert_eq!(affected.len(), 100);
    }

    #[test]
    fn test_clear_clears_prefix_index() {
        use super::Binding;
        use crate::ir::Element;
        use crate::reconcile::tree::InstanceTree;

        let mut graph = DependencyGraph::new();

        // Create real NodeId using InstanceTree
        let mut tree = InstanceTree::new();
        let node = tree.create_node(&Element::new("Text"), &serde_json::json!({}));

        graph.add_dependency(
            node,
            &Binding::state(vec!["user".to_string(), "name".to_string()]),
            None,
        );
        assert!(!graph.prefix_index.is_empty());

        graph.clear();
        assert!(graph.prefix_index.is_empty());
        assert!(graph.dependencies.is_empty());
        assert!(graph.node_bindings.is_empty());
    }

    #[test]
    fn test_get_data_source_affected_nodes() {
        use super::Binding;
        use crate::ir::Element;
        use crate::reconcile::tree::InstanceTree;

        let mut graph = DependencyGraph::new();
        let mut tree = InstanceTree::new();

        let node1 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
        let node2 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
        let node3 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
        let node4 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));

        // Bind to various data source paths
        graph.add_dependency(
            node1,
            &Binding::data_source("spacetime", vec!["messages".to_string()]),
            None,
        );
        graph.add_dependency(
            node2,
            &Binding::data_source("spacetime", vec!["users".to_string(), "name".to_string()]),
            None,
        );
        graph.add_dependency(
            node3,
            &Binding::data_source("firebase", vec!["docs".to_string()]),
            None,
        );
        // node4 bound to state (not data source)
        graph.add_dependency(node4, &Binding::state(vec!["count".to_string()]), None);

        // get_data_source_affected_nodes should find all spacetime nodes
        let affected = graph.get_data_source_affected_nodes("spacetime");
        assert_eq!(affected.len(), 2);
        assert!(affected.contains(&node1));
        assert!(affected.contains(&node2));
        assert!(!affected.contains(&node3)); // firebase, not spacetime
        assert!(!affected.contains(&node4)); // state, not data source

        // Verify the regular get_affected_nodes misses ds:spacetime children
        // (because : separators aren't in the prefix index)
        let affected_old = graph.get_affected_nodes("ds:spacetime");
        assert_eq!(
            affected_old.len(),
            0,
            "get_affected_nodes should miss colon-separated children"
        );
    }

    #[test]
    fn remove_node_prunes_dead_paths_and_prefixes() {
        use super::Binding;
        use crate::ir::Element;
        use crate::reconcile::tree::InstanceTree;

        let mut graph = DependencyGraph::new();
        let mut tree = InstanceTree::new();
        let node1 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
        let node2 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));

        graph.add_dependency(
            node1,
            &Binding::state(vec!["user".to_string(), "name".to_string()]),
            None,
        );
        graph.add_dependency(
            node2,
            &Binding::state(vec!["user".to_string(), "email".to_string()]),
            None,
        );
        assert_eq!(graph.tracked_path_count(), 2);
        assert_eq!(graph.prefix_index_len(), 3); // user, user.name, user.email

        // Dropping node1 retires `user.name` everywhere, but the shared
        // `user` prefix survives because `user.email` still lives under it.
        graph.remove_node(node1);
        assert_eq!(graph.tracked_path_count(), 1);
        assert!(!graph.dependencies.contains_key("user.name"));
        assert!(!graph.prefix_index.contains_key("user.name"));
        let user_paths = graph.prefix_index.get("user").expect("shared prefix kept");
        assert_eq!(user_paths.len(), 1);
        assert!(user_paths.contains("user.email"));
        assert_eq!(graph.get_affected_nodes("user").len(), 1);

        // Dropping the last subscriber empties both indexes entirely.
        graph.remove_node(node2);
        assert_eq!(graph.tracked_path_count(), 0);
        assert_eq!(graph.prefix_index_len(), 0);
        assert!(graph.get_affected_nodes("user").is_empty());
    }

    #[test]
    fn mount_unmount_churn_does_not_grow_indexes() {
        use super::Binding;
        use crate::ir::Element;
        use crate::reconcile::tree::InstanceTree;

        let mut graph = DependencyGraph::new();
        let mut tree = InstanceTree::new();

        // A long-lived list that keeps mounting rows under fresh indices:
        // each row binds a path nothing else will ever bind again.
        for i in 0..500 {
            let node = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
            graph.add_dependency(
                node,
                &Binding::state(vec![
                    "items".to_string(),
                    i.to_string(),
                    "title".to_string(),
                ]),
                None,
            );
            graph.remove_node(node);
            tree.remove(node);
        }

        assert_eq!(graph.tracked_path_count(), 0);
        assert_eq!(graph.prefix_index_len(), 0);
    }

    #[test]
    fn remove_node_keeps_shared_path_for_other_subscribers() {
        use super::Binding;
        use crate::ir::Element;
        use crate::reconcile::tree::InstanceTree;

        let mut graph = DependencyGraph::new();
        let mut tree = InstanceTree::new();
        let node1 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
        let node2 = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
        let binding = Binding::state(vec!["count".to_string()]);
        graph.add_dependency(node1, &binding, None);
        graph.add_dependency(node2, &binding, None);

        graph.remove_node(node1);
        assert_eq!(graph.tracked_path_count(), 1);
        assert_eq!(graph.get_affected_nodes("count").len(), 1);
        assert!(graph.get_affected_nodes("count").contains(&node2));

        // Re-registering after a prune works like a first registration.
        graph.add_dependency(node1, &binding, None);
        assert_eq!(graph.get_affected_nodes("count").len(), 2);
    }

    #[test]
    fn data_source_affected_nodes_for_paths_is_sparse() {
        use super::Binding;
        use crate::ir::Element;
        use crate::reconcile::tree::InstanceTree;

        let mut graph = DependencyGraph::new();
        let mut tree = InstanceTree::new();
        let whole = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
        let name = tree.create_node(&Element::new("Text"), &serde_json::json!({}));
        let messages = tree.create_node(&Element::new("List"), &serde_json::json!({}));
        let msg_text = tree.create_node(&Element::new("Text"), &serde_json::json!({}));

        graph.add_dependency(whole, &Binding::data_source("db", vec![]), None);
        graph.add_dependency(
            name,
            &Binding::data_source("db", vec!["user".to_string(), "name".to_string()]),
            None,
        );
        graph.add_dependency(
            messages,
            &Binding::data_source("db", vec!["messages".to_string()]),
            None,
        );
        graph.add_dependency(
            msg_text,
            &Binding::data_source(
                "db",
                vec!["messages".to_string(), "0".to_string(), "text".to_string()],
            ),
            None,
        );

        // A change deep inside `messages` reaches the list (parent), the leaf
        // (exact), and the whole-provider subscriber — never `user.name`.
        let affected = graph.get_data_source_affected_nodes_for_paths("db", ["messages.0.text"]);
        assert!(affected.contains(&whole));
        assert!(affected.contains(&messages));
        assert!(affected.contains(&msg_text));
        assert!(!affected.contains(&name));

        // Replacing `messages` wholesale reaches every child binding.
        let affected = graph.get_data_source_affected_nodes_for_paths("db", ["messages"]);
        assert!(affected.contains(&messages));
        assert!(affected.contains(&msg_text));
        assert!(!affected.contains(&name));

        // A change to a sibling provider's field touches nothing here.
        let affected = graph.get_data_source_affected_nodes_for_paths("other", ["user.name"]);
        assert!(affected.is_empty());

        // The full scan is the superset.
        assert_eq!(graph.get_data_source_affected_nodes("db").len(), 4);
    }
}
