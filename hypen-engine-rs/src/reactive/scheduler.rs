use crate::ir::NodeId;
use indexmap::IndexSet;

/// Tracks which nodes need to be re-rendered
pub struct Scheduler {
    /// Set of dirty nodes that need recomputation
    dirty_nodes: IndexSet<NodeId>,
}

impl Scheduler {
    pub fn new() -> Self {
        Self {
            dirty_nodes: IndexSet::new(),
        }
    }

    /// Mark a node as dirty (needs re-render)
    pub fn mark_dirty(&mut self, node_id: NodeId) {
        self.dirty_nodes.insert(node_id);
    }

    /// Mark multiple nodes as dirty
    pub fn mark_many_dirty(&mut self, node_ids: impl IntoIterator<Item = NodeId>) {
        self.dirty_nodes.extend(node_ids);
    }

    /// Get all dirty nodes and clear the dirty set
    pub fn take_dirty(&mut self) -> IndexSet<NodeId> {
        std::mem::take(&mut self.dirty_nodes)
    }

    /// Check if there are any dirty nodes
    pub fn has_dirty(&self) -> bool {
        !self.dirty_nodes.is_empty()
    }

    /// Clear all dirty nodes without returning them
    pub fn clear(&mut self) {
        self.dirty_nodes.clear();
    }
}

impl Default for Scheduler {
    fn default() -> Self {
        Self::new()
    }
}
