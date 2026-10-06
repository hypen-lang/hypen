use std::fmt;

/// Error type for the Hypen SDK.
#[derive(Debug)]
pub enum SdkError {
    /// Error from the underlying engine.
    Engine(hypen_engine::EngineError),

    /// A module was not found in the registry.
    ModuleNotFound(String),

    /// Failed to deserialize an action payload.
    ActionPayload { action: String, message: String },

    /// State serialization/deserialization error.
    StateSerde(String),

    /// Route matching or navigation error.
    Route(String),

    /// Component file I/O or resolution error.
    Component(String),

    /// An [`AgentHandle`](crate::remote::AgentHandle) outlived the session it
    /// was attached to. A handle only ever holds a `Weak` reference — the
    /// host owns the session, and once the host drops it every call on the
    /// handle returns this. Carries the session id the handle was bound to.
    SessionGone(String),

    /// [`SessionRegistry::register`](crate::remote::SessionRegistry::register)
    /// refused to key a session under an id that a *different*, still-live
    /// session already holds. The record and the session that owns it are
    /// untouched; the caller's session is not registered. Carries the
    /// contested id.
    SessionIdTaken(String),

    /// Generic SDK error.
    Other(String),
}

impl fmt::Display for SdkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SdkError::Engine(e) => write!(f, "Engine error: {e}"),
            SdkError::ModuleNotFound(name) => write!(f, "Module not found: {name}"),
            SdkError::ActionPayload { action, message } => {
                write!(f, "Invalid payload for action '{action}': {message}")
            }
            SdkError::StateSerde(msg) => write!(f, "State serialization error: {msg}"),
            SdkError::Route(msg) => write!(f, "Route error: {msg}"),
            SdkError::Component(msg) => write!(f, "Component error: {msg}"),
            SdkError::SessionGone(id) => write!(f, "Session gone: {id}"),
            SdkError::SessionIdTaken(id) => {
                write!(f, "Session id already held by a live session: {id}")
            }
            SdkError::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for SdkError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SdkError::Engine(e) => Some(e),
            _ => None,
        }
    }
}

impl From<hypen_engine::EngineError> for SdkError {
    fn from(e: hypen_engine::EngineError) -> Self {
        SdkError::Engine(e)
    }
}

impl From<serde_json::Error> for SdkError {
    fn from(e: serde_json::Error) -> Self {
        SdkError::StateSerde(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, SdkError>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;

    #[test]
    fn test_display_all_variants() {
        let cases: Vec<(SdkError, &str)> = vec![
            (
                SdkError::ModuleNotFound("Counter".into()),
                "Module not found: Counter",
            ),
            (
                SdkError::ActionPayload {
                    action: "add".into(),
                    message: "missing field".into(),
                },
                "Invalid payload for action 'add': missing field",
            ),
            (
                SdkError::StateSerde("bad json".into()),
                "State serialization error: bad json",
            ),
            (SdkError::Route("no match".into()), "Route error: no match"),
            (
                SdkError::Component("not found".into()),
                "Component error: not found",
            ),
            (
                SdkError::SessionGone("session_1".into()),
                "Session gone: session_1",
            ),
            (
                SdkError::SessionIdTaken("session_1".into()),
                "Session id already held by a live session: session_1",
            ),
            (SdkError::Other("something".into()), "something"),
        ];

        for (err, expected) in cases {
            assert_eq!(err.to_string(), expected);
        }
    }

    #[test]
    fn test_display_engine_variant() {
        let err = SdkError::Engine(hypen_engine::EngineError::ActionNotFound("missing".into()));
        let msg = err.to_string();
        assert!(msg.starts_with("Engine error:"));
    }

    #[test]
    fn test_source_engine_returns_some() {
        let engine_err = hypen_engine::EngineError::ActionNotFound("x".into());
        let err = SdkError::Engine(engine_err);
        assert!(err.source().is_some());
    }

    #[test]
    fn test_source_non_engine_returns_none() {
        let err = SdkError::Other("hello".into());
        assert!(err.source().is_none());
    }

    #[test]
    fn test_from_engine_error() {
        let engine_err = hypen_engine::EngineError::ActionNotFound("x".into());
        let sdk_err: SdkError = engine_err.into();
        assert!(matches!(sdk_err, SdkError::Engine(_)));
    }

    #[test]
    fn test_from_serde_error() {
        let serde_err = serde_json::from_str::<i32>("not json").unwrap_err();
        let sdk_err: SdkError = serde_err.into();
        assert!(matches!(sdk_err, SdkError::StateSerde(_)));
    }
}
