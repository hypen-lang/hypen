//! Action and event dispatching.
//!
//! This module handles the flow of user interactions from UI → logic:
//!
//! - **Actions** (`@actions.xxx` in DSL) — dispatched when users interact
//!   with buttons, forms, etc. Handlers are registered via
//!   [`Engine::on_action`](crate::Engine::on_action) or `WasmEngine::onAction`.
//!
//! - **Events** — low-level UI events (click, input change) that can be
//!   mapped to actions via the [`EventRouter`](event::EventRouter).

pub mod action;
pub mod event;

pub use action::{Action, ActionDispatcher};
pub use event::{Event, EventHandler};
