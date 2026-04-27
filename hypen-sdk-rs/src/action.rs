use serde::de::DeserializeOwned;
use serde_json::Value;

/// Context for a dispatched action, providing metadata and raw payload access.
///
/// While `on_action::<T>()` handles payload deserialization automatically,
/// `ActionContext` is available for internal dispatch and middleware use cases.
pub struct ActionContext {
    /// The action name (e.g., `"increment"`, `"setName"`).
    pub name: String,

    /// The raw JSON payload (if any).
    raw_payload: Option<Value>,

    /// Who dispatched this action.
    pub sender: ActionSender,
}

/// Identifies who dispatched an action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionSender {
    /// Dispatched from UI (e.g., `@actions.increment`).
    Ui,
    /// Dispatched programmatically from code.
    Programmatic,
    /// Custom sender identifier.
    Custom(String),
}

impl ActionContext {
    pub(crate) fn new(name: String, payload: Option<Value>, sender: ActionSender) -> Self {
        Self {
            name,
            raw_payload: payload,
            sender,
        }
    }

    /// Deserialize the action payload into `T`.
    ///
    /// Returns `None` if no payload was provided or deserialization fails.
    pub fn payload<T: DeserializeOwned>(&self) -> Option<T> {
        self.raw_payload
            .as_ref()
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }

    /// Get the raw JSON payload.
    pub fn raw_payload(&self) -> Option<&Value> {
        self.raw_payload.as_ref()
    }

    /// Check if this action has a payload.
    pub fn has_payload(&self) -> bool {
        self.raw_payload.is_some()
    }
}

impl From<&hypen_engine::dispatch::Action> for ActionContext {
    fn from(action: &hypen_engine::dispatch::Action) -> Self {
        let sender = match action.sender.as_deref() {
            Some("ui") | None => ActionSender::Ui,
            Some("programmatic") => ActionSender::Programmatic,
            Some(other) => ActionSender::Custom(other.to_string()),
        };
        Self::new(action.name.clone(), action.payload.clone(), sender)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_action_context_payload_deserialization() {
        let ctx = ActionContext::new(
            "test".into(),
            Some(json!({"name": "Alice", "age": 30})),
            ActionSender::Ui,
        );

        #[derive(serde::Deserialize, PartialEq, Debug)]
        struct Payload {
            name: String,
            age: i32,
        }

        let payload: Option<Payload> = ctx.payload();
        assert_eq!(
            payload,
            Some(Payload {
                name: "Alice".into(),
                age: 30
            })
        );
    }

    #[test]
    fn test_action_context_scalar_payload() {
        let ctx = ActionContext::new("test".into(), Some(json!(42)), ActionSender::Programmatic);

        let val: Option<i32> = ctx.payload();
        assert_eq!(val, Some(42));
    }

    #[test]
    fn test_action_context_no_payload() {
        let ctx = ActionContext::new("test".into(), None, ActionSender::Ui);

        let val: Option<i32> = ctx.payload();
        assert_eq!(val, None);
        assert!(!ctx.has_payload());
    }

    #[test]
    fn test_action_context_wrong_type_returns_none() {
        let ctx = ActionContext::new("test".into(), Some(json!("hello")), ActionSender::Ui);

        let val: Option<i32> = ctx.payload();
        assert_eq!(val, None);
    }

    #[test]
    fn test_from_engine_action() {
        let engine_action = hypen_engine::dispatch::Action::new("click")
            .with_payload(json!({"x": 10}))
            .with_sender("ui");

        let ctx = ActionContext::from(&engine_action);
        assert_eq!(ctx.name, "click");
        assert_eq!(ctx.sender, ActionSender::Ui);
        assert!(ctx.has_payload());
    }
}
