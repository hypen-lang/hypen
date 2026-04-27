//! Convenient re-exports for common usage.
//!
//! ```rust,ignore
//! use hypen_server::prelude::*;
//! ```

pub use crate::action::{ActionContext, ActionSender};
pub use crate::app::HypenApp;
pub use crate::context::GlobalContext;
pub use crate::discovery::ComponentRegistry;
pub use crate::error::{Result, SdkError};
pub use crate::events::EventEmitter;
#[cfg(feature = "async")]
pub use crate::module::BoxFuture;
pub use crate::module::{create_nested_instance, ModuleBuilder, ModuleDefinition, ModuleInstance};
pub use crate::router::HypenRouter;

pub use crate::remote::{
    ModuleSessionConfig, RemoteMessage, RemoteSession, SessionConfig, SessionInfo,
    SessionManager, SessionManagerConfig,
};

// Re-export engine types that users commonly need
pub use hypen_engine::Patch;
