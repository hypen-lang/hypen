use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// A unique subscription ID for unsubscribing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SubscriptionId(u64);

type Listener = Box<dyn Fn(&serde_json::Value) + Send + Sync>;
type ListenerList = Vec<(SubscriptionId, Arc<Listener>)>;

/// A thread-safe, typed event emitter for pub/sub messaging.
///
/// # Example
///
/// ```rust
/// use hypen_server::events::EventEmitter;
/// use serde_json::json;
/// use std::sync::{Arc, Mutex};
///
/// let emitter = EventEmitter::new();
///
/// let received = Arc::new(Mutex::new(Vec::new()));
/// let received_clone = received.clone();
///
/// let _sub = emitter.on("user:login", move |payload| {
///     received_clone.lock().unwrap().push(payload.clone());
/// });
///
/// emitter.emit("user:login", &json!({"name": "Alice"}));
///
/// assert_eq!(received.lock().unwrap().len(), 1);
/// ```
pub struct EventEmitter {
    next_id: Mutex<u64>,
    listeners: Mutex<HashMap<String, ListenerList>>,
    once_ids: Mutex<Vec<SubscriptionId>>,
}

impl EventEmitter {
    pub fn new() -> Self {
        Self {
            next_id: Mutex::new(0),
            listeners: Mutex::new(HashMap::new()),
            once_ids: Mutex::new(Vec::new()),
        }
    }

    /// Subscribe to an event. Returns a `SubscriptionId` for unsubscribing.
    pub fn on<F>(&self, event: impl Into<String>, handler: F) -> SubscriptionId
    where
        F: Fn(&serde_json::Value) + Send + Sync + 'static,
    {
        let id = self.next_sub_id();
        let mut listeners = self.listeners.lock().unwrap();
        listeners
            .entry(event.into())
            .or_default()
            .push((id, Arc::new(Box::new(handler))));
        id
    }

    /// Subscribe to an event once. The handler is removed after the first call.
    pub fn once<F>(&self, event: impl Into<String>, handler: F) -> SubscriptionId
    where
        F: Fn(&serde_json::Value) + Send + Sync + 'static,
    {
        let id = self.on(event, handler);
        self.once_ids.lock().unwrap().push(id);
        id
    }

    /// Emit an event to all listeners.
    pub fn emit(&self, event: &str, payload: &serde_json::Value) {
        // Collect listeners to call (clone Arcs to avoid holding lock during calls)
        let to_call: Vec<Arc<Listener>> = {
            let listeners = self.listeners.lock().unwrap();
            listeners
                .get(event)
                .map(|list| list.iter().map(|(_, h)| Arc::clone(h)).collect())
                .unwrap_or_default()
        };

        for handler in &to_call {
            handler(payload);
        }

        // Remove once-listeners
        let once_ids: Vec<SubscriptionId> = {
            let mut once = self.once_ids.lock().unwrap();
            std::mem::take(&mut *once)
        };
        for id in once_ids {
            self.off(id);
        }
    }

    /// Unsubscribe a specific listener by its `SubscriptionId`.
    pub fn off(&self, id: SubscriptionId) {
        let mut listeners = self.listeners.lock().unwrap();
        for list in listeners.values_mut() {
            list.retain(|(sub_id, _)| *sub_id != id);
        }
    }

    /// Remove all listeners for a specific event.
    pub fn remove_all(&self, event: &str) {
        let mut listeners = self.listeners.lock().unwrap();
        listeners.remove(event);
    }

    /// Clear all listeners for all events.
    pub fn clear(&self) {
        let mut listeners = self.listeners.lock().unwrap();
        listeners.clear();
    }

    /// Get the number of listeners for an event.
    pub fn listener_count(&self, event: &str) -> usize {
        let listeners = self.listeners.lock().unwrap();
        listeners.get(event).map(|l| l.len()).unwrap_or(0)
    }

    /// Get all event names that have at least one listener.
    pub fn event_names(&self) -> Vec<String> {
        let listeners = self.listeners.lock().unwrap();
        listeners
            .iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(k, _)| k.clone())
            .collect()
    }

    fn next_sub_id(&self) -> SubscriptionId {
        let mut id = self.next_id.lock().unwrap();
        let sub = SubscriptionId(*id);
        *id += 1;
        sub
    }
}

impl Default for EventEmitter {
    fn default() -> Self {
        Self::new()
    }
}

/// Well-known framework event names.
pub mod framework {
    pub const MODULE_CREATED: &str = "module:created";
    pub const MODULE_DESTROYED: &str = "module:destroyed";
    pub const ROUTE_CHANGED: &str = "route:changed";
    pub const STATE_UPDATED: &str = "state:updated";
    pub const ACTION_DISPATCHED: &str = "action:dispatched";
    pub const ERROR: &str = "error";
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicI32, Ordering};

    #[test]
    fn test_on_and_emit() {
        let emitter = EventEmitter::new();
        let count = Arc::new(AtomicI32::new(0));
        let count_clone = count.clone();

        emitter.on("test", move |_| {
            count_clone.fetch_add(1, Ordering::SeqCst);
        });

        emitter.emit("test", &json!(null));
        emitter.emit("test", &json!(null));

        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn test_once() {
        let emitter = EventEmitter::new();
        let count = Arc::new(AtomicI32::new(0));
        let count_clone = count.clone();

        emitter.once("test", move |_| {
            count_clone.fetch_add(1, Ordering::SeqCst);
        });

        emitter.emit("test", &json!(null));
        emitter.emit("test", &json!(null));

        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_off() {
        let emitter = EventEmitter::new();
        let count = Arc::new(AtomicI32::new(0));
        let count_clone = count.clone();

        let id = emitter.on("test", move |_| {
            count_clone.fetch_add(1, Ordering::SeqCst);
        });

        emitter.emit("test", &json!(null));
        emitter.off(id);
        emitter.emit("test", &json!(null));

        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_payload() {
        let emitter = EventEmitter::new();
        let received = Arc::new(Mutex::new(None));
        let received_clone = received.clone();

        emitter.on("data", move |payload| {
            *received_clone.lock().unwrap() = Some(payload.clone());
        });

        emitter.emit("data", &json!({"name": "Alice"}));

        let val = received.lock().unwrap().take().unwrap();
        assert_eq!(val["name"], "Alice");
    }

    #[test]
    fn test_listener_count() {
        let emitter = EventEmitter::new();

        assert_eq!(emitter.listener_count("test"), 0);

        let id = emitter.on("test", |_| {});
        assert_eq!(emitter.listener_count("test"), 1);

        emitter.on("test", |_| {});
        assert_eq!(emitter.listener_count("test"), 2);

        emitter.off(id);
        assert_eq!(emitter.listener_count("test"), 1);
    }

    #[test]
    fn test_event_names() {
        let emitter = EventEmitter::new();
        emitter.on("a", |_| {});
        emitter.on("b", |_| {});

        let mut names = emitter.event_names();
        names.sort();
        assert_eq!(names, vec!["a", "b"]);
    }

    #[test]
    fn test_remove_all_and_clear() {
        let emitter = EventEmitter::new();
        emitter.on("a", |_| {});
        emitter.on("a", |_| {});
        emitter.on("b", |_| {});

        emitter.remove_all("a");
        assert_eq!(emitter.listener_count("a"), 0);
        assert_eq!(emitter.listener_count("b"), 1);

        emitter.clear();
        assert_eq!(emitter.listener_count("b"), 0);
    }
}
