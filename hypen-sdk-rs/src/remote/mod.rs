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
//!
//! # Device capabilities: on by default
//!
//! Build the per-connection session with the connection's transport and
//! the device plane (RFC 001) is on — no enable call: a client whose hello
//! offers `device` gets one, every `sessionAck` carries a rotating
//! `resumeToken`, and handlers reach the device through `ctx.device()`.
//!
//! ```rust,ignore
//! use hypen_server::device::{DeviceTransport, SessionTransport};
//!
//! enum Out { Text(String), Binary(Vec<u8>), Close(u16, String) }
//! struct Conn(tokio::sync::mpsc::UnboundedSender<Out>);
//! impl DeviceTransport for Conn {
//!     fn send_text(&self, t: String) { let _ = self.0.send(Out::Text(t)); }
//!     fn send_binary(&self, f: Vec<u8>) { let _ = self.0.send(Out::Binary(f)); }
//!     fn close(&self, c: u16, r: &str) { let _ = self.0.send(Out::Close(c, r.into())); }
//! }
//! impl SessionTransport for Conn {
//!     fn send_ui(&self, m: String) { let _ = self.0.send(Out::Text(m)); }
//! }
//!
//! // Per connection — one ordered writer drains `rx` onto the socket:
//! let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
//! let session = RemoteSession::connect(def, components, Arc::new(Conn(tx.clone())));
//! // text frames:   session.handle_message_with(&text, |m| { let _ = tx.send(Out::Text(m.into())); });
//! // binary frames: session.handle_binary(&frame);
//! // socket gone:   session.handle_close();
//! ```
//!
//! Options (budgets, item caps) and the opt-out live on the server-wide
//! [`DeviceServer`](crate::device::DeviceServer) — sessions use
//! `DeviceServer::shared()` unless given one with
//! [`RemoteSession::with_device_server`] — `configure_device(...)`,
//! `disable_device()`; per connection, [`RemoteSession::disable_device`].
//! Connection admission (`DeviceServer::admit`: Origin allowlist /
//! authenticator) is enforced exactly when configured and is not a device
//! prerequisite; with neither configured every client is admitted and one
//! startup warning is logged. A session built without a transport
//! ([`RemoteSession::from_definition`], [`RemoteSession::new`] with
//! `transport: None`) is UI-only — the in-process / test form. Hosts
//! serving legacy clients that never send `hello` call
//! [`RemoteSession::handle_hello`] themselves after their grace period;
//! that session has no device plane.
//!
//! Device activation follows the screen: navigating (through `@router.*`
//! or the host driving [`RemoteSession::router`]) away from a route whose
//! body shows a registered module cancels that module's activation-owned
//! device work, and entering a route activates its module.
//!
//! # Attach mode (agent surface)
//!
//! An agent — an MCP server, a REST route, a CLI — can act on a **live**
//! user session and have its effects land on that user's screen. Keep the
//! session in an `Arc`, register it in a [`SessionRegistry`] once hello has
//! completed together with an [`OutboundSink`] that feeds the socket writer,
//! and hand out [`AgentHandle`]s from wherever you authorise the caller:
//!
//! ```rust,ignore
//! use std::sync::Arc;
//! use hypen_server::remote::{RemoteSession, SessionRegistry};
//!
//! // One per server, shared across connection tasks.
//! let registry = Arc::new(SessionRegistry::new());
//!
//! // Per connection: a single writer drains `rx` onto the socket, and the
//! // session's own replies go through the same channel — queued via
//! // `handle_message_with`, i.e. while the session lock is held — so
//! // revisions reach the socket in the order they were assigned.
//! let session = Arc::new(RemoteSession::new(config));
//! let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
//! let sink: hypen_server::remote::OutboundSink = {
//!     let tx = tx.clone();
//!     Arc::new(move |msg| { let _ = tx.send(msg); })
//! };
//! let mut registered: Option<String> = None;
//! // In the socket loop, for every inbound text frame:
//! session.handle_message_with(&text, |m| { let _ = tx.send(m.to_string()); });
//! if registered.as_deref() != session.acked_session_id().as_deref() {
//!     match registry.register(&session, Arc::clone(&sink)) {
//!         Ok(id) => registered = id,            // `None` until hello completes
//!         Err(e) => eprintln!("not attachable: {e}"), // id held by a live peer; retry later
//!     }
//! }
//! // ... on exit (drops this session's record only):
//! registry.unregister(&session);
//!
//! // Elsewhere, after *you* have authorised the caller for `id`:
//! if let Some(agent) = registry.attach(&id) {
//!     let actions = agent.list_actions()?;           // declared surface only
//!     agent.dispatch("addToCart", Some(&payload))?;  // guarded; patches reach the user
//!     let total = agent.get_state(Some("Cart"), Some("total"))?;
//! }
//! ```
//!
//! Dispatch runs through the engine's guarded `dispatch_external`, never the
//! renderer's permissive path: a refusal is an `Err` with no traffic on the
//! user's transport and no revision bump, and a permitted dispatch emits
//! exactly what a click on that session emits. The registry and handles hold
//! only `Weak` references — a handle can never own, suspend or destroy the
//! session, and once the host drops its `Arc` every call returns
//! [`SdkError::SessionGone`](crate::error::SdkError::SessionGone). A session
//! id is client-chosen (that is how resume works), so `register` refuses to
//! displace a different live session holding the same id
//! ([`SdkError::SessionIdTaken`](crate::error::SdkError::SessionIdTaken))
//! and `unregister` only ever drops the caller's own record.
//!
//! # WebSocket Compression (`permessage-deflate`)
//!
//! Hypen enables `permessage-deflate` by default across its SDKs, and the
//! patch stream this module produces compresses well (repetitive JSON).
//! **This crate has no socket of its own, so there is nothing to configure
//! here** — [`RemoteSession`] hands you `String`s and consumes `String`s.
//! Compression is negotiated by whatever WebSocket transport you wire the
//! session into, per connection, during the HTTP upgrade handshake.
//!
//! ## Status in the Rust ecosystem (verified 2026-07)
//!
//! The mainstream Rust WebSocket stack **cannot negotiate
//! `permessage-deflate` at all**:
//!
//! - `tungstenite` / `tokio-tungstenite` expose no `deflate` (or any
//!   compression) feature in **any** published release up to and including
//!   0.30.0, and pull in no compression crate. The `tungstenite` README
//!   still states: *"There is no support for permessage-deflate at the
//!   moment, but the PRs are welcome"*. Tracking issue
//!   [snapview/tungstenite-rs#2](https://github.com/snapview/tungstenite-rs/issues/2)
//!   has been open since 2017; an implementation landed in
//!   [#328](https://github.com/snapview/tungstenite-rs/pull/328) and was
//!   subsequently reverted, and the revert-of-the-revert
//!   ([#426](https://github.com/snapview/tungstenite-rs/pull/426)) is still
//!   unmerged.
//! - **Axum** builds its `WebSocketUpgrade` on `tokio-tungstenite` and
//!   therefore inherits the limitation. `WebSocketUpgrade` exposes
//!   `read_buffer_size`, `write_buffer_size`, `max_write_buffer_size`,
//!   `max_message_size`, `max_frame_size`, `accept_unmasked_frames` and
//!   subprotocol selection — **no compression/extension knob exists**, and
//!   adding one is not possible while the underlying crate cannot deflate.
//! - **Actix Web** is in the same position: `actix-http` does ship `flate2`,
//!   but only for HTTP body compression (its `__compress` feature), not for
//!   the WebSocket `permessage-deflate` extension.
//!
//! **So: an Axum- or Actix-hosted Hypen server runs uncompressed today, and
//! there is no configuration that changes that.** Do not advertise
//! compression support you cannot deliver.
//!
//! ## What this means in practice
//!
//! `permessage-deflate` is negotiated per connection and is strictly
//! optional in RFC 7692: a client offers `Sec-WebSocket-Extensions:
//! permessage-deflate`, and a server that does not understand it simply
//! omits the header from its `101` response. Both peers then speak plain
//! uncompressed frames. This is fully interoperable — nothing breaks:
//!
//! - Browser clients always offer `permessage-deflate`. Against a
//!   tungstenite-backed Hypen server the offer is declined and the browser
//!   transparently runs uncompressed.
//! - Android/OkHttp clients behave the same way.
//! - The Hypen desktop renderer offers no compression at all (see
//!   `hypen-renderer-desktop`), and interoperates with
//!   compression-enabled servers unchanged.
//!
//! The cost is bandwidth, not correctness.
//!
//! ## If you need compression today
//!
//! Terminate the WebSocket in front of your Rust process, or pick a
//! transport that implements the extension:
//!
//! - **Reverse proxy** — nginx (`ngx_http_v2`/websocket + a deflate-capable
//!   build) or a CDN/edge terminator that handles `permessage-deflate` and
//!   forwards plain frames to your Axum/Actix upstream. This is the least
//!   invasive option and keeps this SDK untouched.
//! - **Run the server on a non-Rust Hypen SDK** — the TypeScript/Node and
//!   Cloudflare Workers servers negotiate `permessage-deflate` natively.
//! - **`soketto`** ([crates.io](https://crates.io/crates/soketto)) is the
//!   one maintained pure-Rust WebSocket crate with a real
//!   `permessage-deflate` implementation, behind its `deflate` feature.
//!   Because [`RemoteSession`] is transport-agnostic (it is just
//!   `handle_hello` / `handle_message` over `String`s), you can drive it
//!   from a `soketto` server exactly as you would from Axum — the session
//!   contract is unchanged.
//!
//! Re-check this section when bumping `tokio-tungstenite`: if
//! [snapview/tungstenite-rs#426](https://github.com/snapview/tungstenite-rs/pull/426)
//! merges, a `deflate` feature becomes available and Axum can plausibly
//! expose it.

mod agent;
mod session;
pub mod session_manager;
mod types;

pub use agent::{AgentHandle, OutboundSink, SessionRegistry};
pub use session::{ModuleSessionConfig, RemoteSession, SessionConfig};
pub use session_manager::{SessionInfo, SessionManager, SessionManagerConfig};
pub use types::*;
