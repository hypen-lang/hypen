//! Error types for Hypen Engine operations.
//!
//! Provides structured errors that SDK authors can pattern-match on,
//! replacing the previous `Result<_, String>` API.
//!
//! # Example
//!
//! ```rust
//! use hypen_engine::EngineError;
//!
//! fn handle_error(err: EngineError) {
//!     match err {
//!         EngineError::ParseError { source, message } => {
//!             eprintln!("Failed to parse '{}': {}", source, message);
//!         }
//!         EngineError::ComponentNotFound(name) => {
//!             eprintln!("Component '{}' not found", name);
//!         }
//!         EngineError::ActionNotFound(name) => {
//!             eprintln!("No handler for action '{}'", name);
//!         }
//!         EngineError::NotDeclared(msg) => {
//!             eprintln!("External request refused: {}", msg);
//!         }
//!         EngineError::RenderError(msg) => {
//!             eprintln!("Render failed: {}", msg);
//!         }
//!         EngineError::StateError(msg) => {
//!             eprintln!("State error: {}", msg);
//!         }
//!         EngineError::ExpressionError(msg) => {
//!             eprintln!("Expression error: {}", msg);
//!         }
//!     }
//! }
//! ```

use std::fmt;

/// Structured error type for Hypen Engine operations.
///
/// SDK authors can pattern-match on variants to distinguish between
/// different failure modes and provide appropriate error messages.
#[derive(Debug, Clone, PartialEq)]
pub enum EngineError {
    /// Error parsing Hypen DSL source code.
    ///
    /// `source` contains the input text (or a truncated prefix) that failed to parse.
    /// `message` contains the human-readable parse error.
    ParseError { source: String, message: String },

    /// A referenced component was not found in the registry.
    ///
    /// Contains the component name that could not be resolved.
    ComponentNotFound(String),

    /// Error during rendering or reconciliation.
    RenderError(String),

    /// No handler registered for the dispatched action.
    ///
    /// Contains the action name that had no handler.
    ActionNotFound(String),

    /// An external caller asked for something the app never declared.
    ///
    /// Distinct from [`ActionNotFound`](Self::ActionNotFound), which means no
    /// handler exists. This one means the handler is there and the request was
    /// *refused* — a navigation target outside the declared route table, a
    /// `set_input` field no `.bind()` declares, a framework-internal name. The
    /// distinction is not pedantry: these messages are read by agents, and
    /// "No handler registered for action: hypen.navigate: '/admin' is not a
    /// declared route" tells one both that the action is missing and that it
    /// isn't. It also maps cleanly onto a transport — this is a 403, while
    /// `ActionNotFound` is a 404.
    NotDeclared(String),

    /// Error related to state operations (invalid patch, deserialization failure).
    StateError(String),

    /// Error evaluating an expression or template string.
    ExpressionError(String),
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::ParseError { source, message } => {
                write!(f, "Parse error in '{}': {}", truncate(source, 60), message)
            }
            EngineError::ComponentNotFound(name) => {
                write!(f, "Component not found: {}", name)
            }
            EngineError::RenderError(msg) => {
                write!(f, "Render error: {}", msg)
            }
            EngineError::NotDeclared(detail) => {
                write!(f, "Not declared by this app: {}", detail)
            }
            EngineError::ActionNotFound(name) => {
                write!(f, "No handler registered for action: {}", name)
            }
            EngineError::StateError(msg) => {
                write!(f, "State error: {}", msg)
            }
            EngineError::ExpressionError(msg) => {
                write!(f, "Expression error: {}", msg)
            }
        }
    }
}

impl std::error::Error for EngineError {}

/// Convert from a String error (backward compatibility for internal code).
impl From<String> for EngineError {
    fn from(msg: String) -> Self {
        EngineError::RenderError(msg)
    }
}

/// Truncate a string for display in error messages.
fn truncate(s: &str, max_len: usize) -> &str {
    if s.len() <= max_len {
        s
    } else {
        // Find a valid char boundary
        let mut end = max_len;
        while !s.is_char_boundary(end) && end > 0 {
            end -= 1;
        }
        &s[..end]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_error_display() {
        let err = EngineError::ParseError {
            source: "Column { broken".to_string(),
            message: "unexpected end of input".to_string(),
        };
        let msg = err.to_string();
        assert!(msg.contains("Parse error"));
        assert!(msg.contains("Column { broken"));
        assert!(msg.contains("unexpected end of input"));
    }

    #[test]
    fn test_component_not_found_display() {
        let err = EngineError::ComponentNotFound("MyWidget".to_string());
        assert_eq!(err.to_string(), "Component not found: MyWidget");
    }

    #[test]
    fn test_action_not_found_display() {
        let err = EngineError::ActionNotFound("submitForm".to_string());
        assert_eq!(
            err.to_string(),
            "No handler registered for action: submitForm"
        );
    }

    #[test]
    fn test_render_error_display() {
        let err = EngineError::RenderError("node tree corrupted".to_string());
        assert_eq!(err.to_string(), "Render error: node tree corrupted");
    }

    #[test]
    fn test_state_error_display() {
        let err = EngineError::StateError("invalid JSON".to_string());
        assert_eq!(err.to_string(), "State error: invalid JSON");
    }

    #[test]
    fn test_expression_error_display() {
        let err = EngineError::ExpressionError("division by zero".to_string());
        assert_eq!(err.to_string(), "Expression error: division by zero");
    }

    #[test]
    fn test_error_is_clone_and_eq() {
        let err1 = EngineError::ActionNotFound("test".to_string());
        let err2 = err1.clone();
        assert_eq!(err1, err2);
    }

    #[test]
    fn test_error_debug() {
        let err = EngineError::ComponentNotFound("Foo".to_string());
        let debug = format!("{:?}", err);
        assert!(debug.contains("ComponentNotFound"));
        assert!(debug.contains("Foo"));
    }

    #[test]
    fn test_from_string() {
        let err: EngineError = "something went wrong".to_string().into();
        assert_eq!(
            err,
            EngineError::RenderError("something went wrong".to_string())
        );
    }

    #[test]
    fn test_truncate_long_source() {
        let long_source = "a".repeat(200);
        let err = EngineError::ParseError {
            source: long_source,
            message: "error".to_string(),
        };
        let display = err.to_string();
        // The source should be truncated in the display
        assert!(display.len() < 200);
    }

    #[test]
    fn test_error_implements_std_error() {
        let err = EngineError::StateError("test".to_string());
        let std_err: &dyn std::error::Error = &err;
        assert!(std_err.to_string().contains("State error"));
    }
}
