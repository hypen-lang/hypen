//! # Hypen Rust Server SDK
//!
//! Server-side SDK for building [Hypen](https://hypen.space) applications in Rust.
//!
//! Hypen is a declarative UI language and reactive runtime. This SDK provides
//! a type-safe, idiomatic Rust API for defining stateful modules, handling
//! actions, managing routing, and discovering components.
//!
//! ## Quick Start
//!
//! ```rust,ignore
//! use hypen_server::prelude::*;
//! use serde::{Deserialize, Serialize};
//!
//! #[derive(Clone, Default, Serialize, Deserialize)]
//! struct CounterState {
//!     count: i32,
//! }
//!
//! fn main() {
//!     let counter = HypenApp::module::<CounterState>("Counter")
//!         .state(CounterState { count: 0 })
//!         .ui(r#"
//!             Column {
//!                 Text("Count: @{state.count}")
//!                 Button("@actions.increment") { Text("+") }
//!                 Button("@actions.decrement") { Text("-") }
//!             }
//!         "#)
//!         .on_created(|state, _ctx| {
//!             println!("Counter created at {}", state.count);
//!         })
//!         .on_action::<()>("increment", |state, _, _ctx| {
//!             state.count += 1;
//!         })
//!         .on_action::<()>("decrement", |state, _, _ctx| {
//!             state.count -= 1;
//!         })
//!         .on_destroyed(|state, _ctx| {
//!             println!("Counter destroyed at {}", state.count);
//!         })
//!         .build();
//!
//!     // Create an app with routing
//!     let app = HypenApp::builder()
//!         .route("/", counter)
//!         .build();
//!
//!     // Instantiate and run
//!     let instance = app.instantiate(
//!         std::sync::Arc::new(
//!             HypenApp::module::<CounterState>("Counter")
//!                 .state(CounterState { count: 0 })
//!                 .on_action::<()>("increment", |s, _, _| s.count += 1)
//!                 .build()
//!         )
//!     ).unwrap();
//!     instance.mount();
//!     instance.dispatch_action("increment", None).unwrap();
//!     assert_eq!(instance.get_state().count, 1);
//! }
//! ```
//!
//! ## Architecture
//!
//! The SDK wraps the `hypen-engine` core and provides a high-level API:
//!
//! - **[`ModuleBuilder`](module::ModuleBuilder)** — Fluent builder for defining modules
//!   with typed state, action handlers, and lifecycle hooks.
//! - **[`HypenApp`](app::HypenApp)** — Application registry with routing, component
//!   discovery, and a global context.
//! - **[`GlobalContext`](context::GlobalContext)** — Cross-module communication hub
//!   for sharing state and events.
//! - **[`HypenRouter`](router::HypenRouter)** — URL pattern-based router with
//!   parameter extraction and navigation history.
//! - **[`ComponentRegistry`](discovery::ComponentRegistry)** — Auto-discovery of
//!   `.hypen` component files from the filesystem.
//! - **[`EventEmitter`](events::EventEmitter)** — Pub/sub event system for
//!   decoupled communication.
//!
//! ## Action Handling
//!
//! Actions always take a name and a type parameter for the payload.
//! Use `()` for actions with no payload.
//!
//! ### No payload
//!
//! ```rust,ignore
//! .on_action::<()>("increment", |state, _, _ctx| {
//!     state.count += 1;
//! })
//! ```
//!
//! ### Typed payload
//!
//! ```rust,ignore
//! #[derive(Deserialize)]
//! struct SetValue { value: i32 }
//!
//! .on_action::<SetValue>("set_value", |state, payload, _ctx| {
//!     state.count = payload.value;
//! })
//! ```
//!
//! ### Raw JSON payload
//!
//! ```rust,ignore
//! .on_action::<serde_json::Value>("raw", |state, raw, _ctx| {
//!     if let Some(n) = raw.as_i64() { state.count = n as i32; }
//! })
//! ```

pub mod action;
pub mod app;
pub mod context;
pub mod discovery;
pub mod error;
pub mod events;
pub mod managed_router;
pub mod module;
pub mod prelude;
pub mod remote;
pub mod router;
pub mod state;
