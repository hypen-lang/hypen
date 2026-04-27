use crate::ir::NodeId;

/// Lifecycle events for component instances
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComponentLifecycleEvent {
    /// Component instance was mounted to the tree
    Mounted,

    /// Component instance was unmounted from the tree
    Unmounted,
}

/// Callback type for component lifecycle events
pub type ComponentLifecycleCallback = Box<dyn Fn(NodeId, ComponentLifecycleEvent) + Send + Sync>;

/// Manages component lifecycle callbacks
pub struct ComponentLifecycle {
    /// Lifecycle event callback
    callback: Option<ComponentLifecycleCallback>,
}

impl ComponentLifecycle {
    pub fn new() -> Self {
        Self { callback: None }
    }

    /// Register a lifecycle callback
    pub fn on<F>(&mut self, callback: F)
    where
        F: Fn(NodeId, ComponentLifecycleEvent) + Send + Sync + 'static,
    {
        self.callback = Some(Box::new(callback));
    }

    /// Notify that a component was mounted
    pub fn notify_mounted(&self, node_id: NodeId) {
        if let Some(ref callback) = self.callback {
            callback(node_id, ComponentLifecycleEvent::Mounted);
        }
    }

    /// Notify that a component was unmounted
    pub fn notify_unmounted(&self, node_id: NodeId) {
        if let Some(ref callback) = self.callback {
            callback(node_id, ComponentLifecycleEvent::Unmounted);
        }
    }
}

impl Default for ComponentLifecycle {
    fn default() -> Self {
        Self::new()
    }
}
