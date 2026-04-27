use serde::{Deserialize, Serialize};

use crate::error::EngineError;

/// An action dispatched from the UI via `@actions.<name>` in Hypen DSL.
///
/// Actions are the primary mechanism for UI-to-logic communication. When a
/// user interacts with a component (e.g. clicks `Button("@actions.signIn")`),
/// the renderer dispatches an `Action` to the engine, which routes it to the
/// registered handler.
///
/// # Example
///
/// ```rust
/// use hypen_engine::dispatch::Action;
///
/// let action = Action::new("signIn")
///     .with_payload(serde_json::json!({"email": "alice@example.com"}));
///
/// assert_eq!(action.name, "signIn");
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Action {
    /// Action name (e.g. `"signIn"`, `"increment"`, `"addToCart"`)
    pub name: String,

    /// Optional payload data attached to the action.
    pub payload: Option<serde_json::Value>,

    /// Optional sender/source identifier (e.g. a node ID or component name).
    pub sender: Option<String>,
}

impl Action {
    /// Create a new action with the given name and no payload.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            payload: None,
            sender: None,
        }
    }

    pub fn with_payload(mut self, payload: serde_json::Value) -> Self {
        self.payload = Some(payload);
        self
    }

    pub fn with_sender(mut self, sender: impl Into<String>) -> Self {
        self.sender = Some(sender.into());
        self
    }
}

/// Callback signature for action handlers.
///
/// Handlers receive a shared reference to the [`Action`] being dispatched.
pub type ActionHandler = Box<dyn Fn(&Action) + Send + Sync>;

/// Routes actions to their registered handlers.
///
/// Used internally by [`Engine`](crate::Engine). SDK authors typically
/// register handlers via `Engine::on_action()` or `WasmEngine::onAction()`
/// rather than using this type directly.
pub struct ActionDispatcher {
    /// Map of action name -> handler
    handlers: indexmap::IndexMap<String, ActionHandler>,
}

impl ActionDispatcher {
    pub fn new() -> Self {
        Self {
            handlers: indexmap::IndexMap::new(),
        }
    }

    /// Register a handler for an action
    pub fn on<F>(&mut self, action_name: impl Into<String>, handler: F)
    where
        F: Fn(&Action) + Send + Sync + 'static,
    {
        self.handlers.insert(action_name.into(), Box::new(handler));
    }

    /// Dispatch an action to its handler
    pub fn dispatch(&self, action: &Action) -> Result<(), EngineError> {
        if let Some(handler) = self.handlers.get(&action.name) {
            handler(action);
            Ok(())
        } else {
            Err(EngineError::ActionNotFound(action.name.clone()))
        }
    }

    /// Check if a handler is registered for an action
    pub fn has_handler(&self, action_name: &str) -> bool {
        self.handlers.contains_key(action_name)
    }

    /// Remove a handler
    pub fn remove(&mut self, action_name: &str) {
        self.handlers.shift_remove(action_name);
    }

    /// Clear all handlers
    pub fn clear(&mut self) {
        self.handlers.clear();
    }
}

impl Default for ActionDispatcher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn test_action_dispatch() {
        let mut dispatcher = ActionDispatcher::new();
        let called = Arc::new(Mutex::new(false));
        let called_clone = called.clone();

        dispatcher.on("test", move |_action| {
            *called_clone.lock().unwrap() = true;
        });

        let action = Action::new("test");
        dispatcher.dispatch(&action).unwrap();

        assert!(*called.lock().unwrap());
    }

    #[test]
    fn test_missing_handler() {
        let dispatcher = ActionDispatcher::new();
        let action = Action::new("unknown");
        assert!(dispatcher.dispatch(&action).is_err());
    }
}
