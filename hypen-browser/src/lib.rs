//! Hypen Browser — a native desktop browser for Hypen apps.
//!
//! Wraps the Hypen desktop renderer in a single window that hosts:
//!
//! * A locally-defined Hypen module (the "shell") that renders the
//!   home screen and a floating iOS-style island for the address bar.
//! * An optional `RemoteModule` that streams patches from a
//!   `RemoteServer` over WebSocket once the user opens a URL.
//!
//! The two engines are merged inside [`browser::BrowserModule`] before
//! reaching the renderer — see that module's docs for the routing
//! rules.
//!
//! ## Run
//!
//! ```bash
//! cargo run -p hypen-browser
//! ```
//!
//! Type a Hypen WebSocket URL (e.g. `ws://localhost:3000`) into the
//! address bar and press **Open**, or click any tile under "Last
//! opened" to reopen a saved app. The island collapses to a small
//! chip when the app is loaded; click the chip to expand the address
//! bar again.

pub mod browser;
pub mod devlog;
pub mod shell;
pub mod storage;

pub use browser::BrowserModule;
pub use devlog::init_logging;
pub use storage::{normalize_url, pretty_name, RecentApp, Storage};
