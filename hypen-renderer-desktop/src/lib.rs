//! # hypen-renderer-desktop
//!
//! Native desktop renderer for Hypen. Consumes the engine's [`Patch`] stream
//! and paints it to a `winit` window via `wgpu` (surface) + `tiny-skia`
//! (CPU rasteriser) + `cosmic-text` (text shaping).
//!
//! Phase 1 (the current scaffold): single-window, no clicks, hard-coded
//! layout for `Text` nodes. Validates the full pipe — Engine → Patches →
//! Tree → Pixmap → GPU surface — end to end.
//!
//! [`Patch`]: hypen_engine::Patch
//!
//! ## Quick start
//!
//! ```no_run
//! use hypen_renderer_desktop::DesktopApp;
//!
//! DesktopApp::new()
//!     .source(r#"Text("Hello from Hypen Desktop")"#)
//!     .title("Hypen Desktop — Hello")
//!     .run();
//! ```

pub mod accessibility;
pub mod app;
pub(crate) mod damage;
pub mod gpu;
pub(crate) mod ime;
pub mod layout;
pub mod module;
pub mod paint;
pub mod painter;
pub mod remote;
pub mod style;
pub mod text;
pub mod tree;
pub mod window;

pub use app::DesktopApp;
pub use module::HypenModule;
pub use remote::RemoteModule;
pub use painter::{PaintTarget, Painter};
pub use tree::{Node, Tree};

/// Re-exported for convenience so callers don't need to depend on the
/// engine crate directly to inspect patches.
pub use hypen_engine::Patch;
