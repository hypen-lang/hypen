//! Remote UI protocol layer for server-driven rendering.
//!
//! This module provides a framework-agnostic [`RemoteSession`] that manages
//! a per-client engine, component discovery, state, and the WebSocket message
//! protocol. Plug it into any async server (Axum, Actix, Warp, etc.).
//!
//! # Protocol Flow
//!
//! ```text
//! Client                          Server
//!   │── connect ──────────────────>│
//!   │── hello {sessionId?} ──────>│
//!   │<── sessionAck ──────────────│
//!   │<── initialTree {patches} ───│
//!   │                              │
//!   │── dispatchAction ──────────>│  (user taps button)
//!   │<── patch {patches} ─────────│  (engine re-renders)
//!   │<── stateUpdate {state} ─────│  (optional, for tooling)
//!   │                              │
//!   │── close ────────────────────>│
//! ```
//!
//! # Example (Axum)
//!
//! ```rust,ignore
//! use hypen_server::prelude::*;
//! use hypen_server::remote::{RemoteSession, SessionConfig};
//!
//! // In your WebSocket handler:
//! async fn ws_handler(ws: WebSocket, session: RemoteSession) {
//!     let (mut sender, mut receiver) = ws.split();
//!
//!     // Send initial messages
//!     let hello_response = session.handle_hello(None);
//!     for msg in hello_response {
//!         sender.send(Message::Text(msg)).await.unwrap();
//!     }
//!
//!     // Message loop
//!     while let Some(Ok(msg)) = receiver.next().await {
//!         let responses = session.handle_message(msg.to_text().unwrap());
//!         for resp in responses {
//!             sender.send(Message::Text(resp)).await.unwrap();
//!         }
//!     }
//! }
//! ```

mod session;
pub mod session_manager;
mod types;

pub use session::{ModuleSessionConfig, RemoteSession, SessionConfig};
pub use session_manager::{SessionInfo, SessionManager, SessionManagerConfig};
pub use types::*;
