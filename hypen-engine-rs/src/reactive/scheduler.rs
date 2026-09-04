use crate::ir::NodeId;
use indexmap::IndexSet;

/// Tracks which nodes need to be re-rendered.
///
/// Alongside the dirty set, the scheduler records the *state paths* whose
/// changes produced the current batch (when the caller knows them, via
/// [`mark_dirty_for_path`](Self::mark_dirty_for_path)). Renderers use those
/// paths to narrow iterable re-reconciliation to the touched indices — a
/// change to `"rows.500.selected"` only needs row 500 revisited, not a keyed
/// pass over all 1,000 children. Any marking with unknown provenance
/// ([`mark_dirty`](Self::mark_dirty) / [`mark_many_dirty`](Self::mark_many_dirty))
/// poisons the batch's path record, and consumers fall back to the full pass
/// — correctness never depends on the hint being present.
pub struct Scheduler {
    /// Set of dirty nodes that need recomputation
    dirty_nodes: IndexSet<NodeId>,
    /// State paths that produced the current dirty batch (dependency-graph
    /// keys, so scoped modules appear as `mod:{name}:{path}`).
    changed_paths: Vec<String>,
    /// False when any marking in the batch didn't carry a path — the paths
    /// above are then incomplete and must not be used for narrowing.
    paths_reliable: bool,
}

impl Scheduler {
    pub fn new() -> Self {
        Self {
            dirty_nodes: IndexSet::new(),
            changed_paths: Vec::new(),
            paths_reliable: true,
        }
    }

    /// Mark a node as dirty (needs re-render).
    ///
    /// Provenance-free: disables path narrowing for this batch.
    pub fn mark_dirty(&mut self, node_id: NodeId) {
        self.paths_reliable = false;
        self.dirty_nodes.insert(node_id);
    }

    /// Mark multiple nodes as dirty.
    ///
    /// Provenance-free: disables path narrowing for this batch.
    pub fn mark_many_dirty(&mut self, node_ids: impl IntoIterator<Item = NodeId>) {
        self.paths_reliable = false;
        self.dirty_nodes.extend(node_ids);
    }

    /// Mark nodes dirty because the state at `path` changed, keeping the
    /// path on record so iterable re-renders can narrow to touched indices.
    pub fn mark_dirty_for_path(
        &mut self,
        path: &str,
        node_ids: impl IntoIterator<Item = NodeId>,
    ) {
        self.changed_paths.push(path.to_string());
        self.dirty_nodes.extend(node_ids);
    }

    /// Get all dirty nodes and clear the dirty set
    pub fn take_dirty(&mut self) -> IndexSet<NodeId> {
        std::mem::take(&mut self.dirty_nodes)
    }

    /// The changed paths backing the current batch, or `None` when any
    /// marking lacked provenance. Clears the record and resets reliability —
    /// call once per render cycle, alongside [`take_dirty`](Self::take_dirty).
    pub fn take_changed_paths(&mut self) -> Option<Vec<String>> {
        let reliable = std::mem::replace(&mut self.paths_reliable, true);
        let paths = std::mem::take(&mut self.changed_paths);
        reliable.then_some(paths)
    }

    /// Check if there are any dirty nodes
    pub fn has_dirty(&self) -> bool {
        !self.dirty_nodes.is_empty()
    }

    /// Clear all dirty nodes without returning them
    pub fn clear(&mut self) {
        self.dirty_nodes.clear();
        self.changed_paths.clear();
        self.paths_reliable = true;
    }
}

impl Default for Scheduler {
    fn default() -> Self {
        Self::new()
    }
}
