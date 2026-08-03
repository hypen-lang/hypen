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

mod session;
pub mod session_manager;
mod types;

pub use session::{ModuleSessionConfig, RemoteSession, SessionConfig};
pub use session_manager::{SessionInfo, SessionManager, SessionManagerConfig};
pub use types::*;
