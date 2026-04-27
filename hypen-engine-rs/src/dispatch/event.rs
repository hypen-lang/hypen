use serde::{Deserialize, Serialize};

/// A UI event from a platform renderer (e.g., click, input change)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    /// Node ID that generated the event
    pub node_id: String,

    /// Event name (e.g., "click", "change", "submit")
    pub event_name: String,

    /// Optional event payload (varies by event type)
    pub payload: Option<serde_json::Value>,
}

impl Event {
    pub fn new(node_id: impl Into<String>, event_name: impl Into<String>) -> Self {
        Self {
            node_id: node_id.into(),
            event_name: event_name.into(),
            payload: None,
        }
    }

    pub fn with_payload(mut self, payload: serde_json::Value) -> Self {
        self.payload = Some(payload);
        self
    }
}

/// Callback type for event handlers
pub type EventHandler = Box<dyn Fn(&Event) + Send + Sync>;

/// Routes UI events to the appropriate action handlers
pub struct EventRouter {
    /// Map of (node_id, event_name) -> action_name
    event_actions: indexmap::IndexMap<(String, String), String>,
}

impl EventRouter {
    pub fn new() -> Self {
        Self {
            event_actions: indexmap::IndexMap::new(),
        }
    }

    /// Register that a node's event should trigger an action
    pub fn register(
        &mut self,
        node_id: impl Into<String>,
        event_name: impl Into<String>,
        action_name: impl Into<String>,
    ) {
        let key = (node_id.into(), event_name.into());
        self.event_actions.insert(key, action_name.into());
    }

    /// Get the action name for a given node event
    pub fn get_action(&self, node_id: &str, event_name: &str) -> Option<&str> {
        self.event_actions
            .get(&(node_id.to_string(), event_name.to_string()))
            .map(|s| s.as_str())
    }

    /// Unregister an event
    pub fn unregister(&mut self, node_id: &str, event_name: &str) {
        self.event_actions
            .shift_remove(&(node_id.to_string(), event_name.to_string()));
    }

    /// Clear all event mappings
    pub fn clear(&mut self) {
        self.event_actions.clear();
    }
}

impl Default for EventRouter {
    fn default() -> Self {
        Self::new()
    }
}
