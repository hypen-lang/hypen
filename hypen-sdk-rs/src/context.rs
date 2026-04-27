use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::events::EventEmitter;

/// Global context providing cross-module communication.
///
/// Shared across all module instances in an application. Provides:
/// - Module registry (look up other modules' state)
/// - Global event emitter
/// - Router access
///
/// # Example
///
/// ```rust
/// use hypen_server::context::GlobalContext;
///
/// let ctx = GlobalContext::new();
///
/// // Register module state
/// ctx.register_module_state("counter", serde_json::json!({"count": 0}));
///
/// // Access from another module
/// let state = ctx.get_module_state("counter");
/// assert!(state.is_some());
/// ```
pub struct GlobalContext {
    /// Module states indexed by name.
    module_states: Mutex<HashMap<String, Value>>,

    /// Global event emitter.
    events: EventEmitter,

    /// Router (set externally when routing is configured).
    router: Mutex<Option<Arc<crate::router::HypenRouter>>>,
}

impl GlobalContext {
    pub fn new() -> Self {
        Self {
            module_states: Mutex::new(HashMap::new()),
            events: EventEmitter::new(),
            router: Mutex::new(None),
        }
    }

    // ---- Module State Registry ----

    /// Register (or update) a module's state in the global context.
    pub fn register_module_state(&self, name: impl Into<String>, state: Value) {
        self.module_states
            .lock()
            .unwrap()
            .insert(name.into(), state);
    }

    /// Get a snapshot of a module's state by name.
    pub fn get_module_state(&self, name: &str) -> Option<Value> {
        self.module_states.lock().unwrap().get(name).cloned()
    }

    /// Check if a module is registered.
    pub fn has_module(&self, name: &str) -> bool {
        self.module_states.lock().unwrap().contains_key(name)
    }

    /// Get all registered module names.
    pub fn module_names(&self) -> Vec<String> {
        self.module_states.lock().unwrap().keys().cloned().collect()
    }

    /// Remove a module from the context.
    pub fn unregister_module(&self, name: &str) {
        self.module_states.lock().unwrap().remove(name);
    }

    /// Get a merged view of all module states.
    pub fn global_state(&self) -> Value {
        let states = self.module_states.lock().unwrap();
        let mut map = serde_json::Map::new();
        for (name, state) in states.iter() {
            map.insert(name.clone(), state.clone());
        }
        Value::Object(map)
    }

    // ---- Events ----

    /// Access the global event emitter.
    pub fn events(&self) -> &EventEmitter {
        &self.events
    }

    // ---- Router ----

    /// Set the router instance.
    pub fn set_router(&self, router: Arc<crate::router::HypenRouter>) {
        *self.router.lock().unwrap() = Some(router);
    }

    /// Get the router, if one has been configured.
    pub fn router(&self) -> Option<Arc<crate::router::HypenRouter>> {
        self.router.lock().unwrap().clone()
    }
}

impl Default for GlobalContext {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_register_and_get_state() {
        let ctx = GlobalContext::new();
        ctx.register_module_state("counter", json!({"count": 5}));

        let state = ctx.get_module_state("counter").unwrap();
        assert_eq!(state["count"], 5);
    }

    #[test]
    fn test_module_names() {
        let ctx = GlobalContext::new();
        ctx.register_module_state("a", json!({}));
        ctx.register_module_state("b", json!({}));

        let mut names = ctx.module_names();
        names.sort();
        assert_eq!(names, vec!["a", "b"]);
    }

    #[test]
    fn test_unregister() {
        let ctx = GlobalContext::new();
        ctx.register_module_state("test", json!({}));
        assert!(ctx.has_module("test"));

        ctx.unregister_module("test");
        assert!(!ctx.has_module("test"));
    }

    #[test]
    fn test_global_state() {
        let ctx = GlobalContext::new();
        ctx.register_module_state("counter", json!({"count": 1}));
        ctx.register_module_state("user", json!({"name": "Alice"}));

        let global = ctx.global_state();
        assert_eq!(global["counter"]["count"], 1);
        assert_eq!(global["user"]["name"], "Alice");
    }

    #[test]
    fn test_events_integration() {
        use std::sync::atomic::{AtomicI32, Ordering};

        let ctx = GlobalContext::new();
        let count = Arc::new(AtomicI32::new(0));
        let count_clone = count.clone();

        ctx.events().on("test", move |_| {
            count_clone.fetch_add(1, Ordering::SeqCst);
        });

        ctx.events().emit("test", &json!(null));
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}
