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
pub use crate::state::State;

pub use crate::remote::{
    AgentHandle, ModuleSessionConfig, OutboundSink, RemoteMessage, RemoteSession, SessionConfig,
    SessionInfo, SessionManager, SessionManagerConfig, SessionRegistry,
};

// Re-export engine types that users commonly need
pub use hypen_engine::Patch;

// The external capability surface — what a caller that is *not* the rendered
// UI (an MCP server, a REST endpoint, a CLI, an agent) may see and dispatch.
// Re-exported so embedders don't take a direct `hypen-engine` dependency for
// three structs and three names. See [`hypen_engine::agent`] for the rule the
// surface enforces, and `ModuleInstance::dispatch_external` /
// `RemoteSession::dispatch_external` for the SDK entry points.
pub use hypen_engine::{AgentAction, AgentRoute, BoundInput, BACK, NAVIGATE, SET_INPUT};
