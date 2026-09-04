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
pub mod anim;
pub mod app;
pub(crate) mod damage;
#[cfg(feature = "dev-overlay")]
pub(crate) mod dev_overlay;
pub mod gpu;
pub(crate) mod ime;
pub mod layout;
#[cfg(target_os = "macos")]
pub(crate) mod macos;
#[cfg(feature = "video")]
pub mod media;
pub mod module;
pub mod paint;
pub mod painter;
#[cfg(test)]
mod perf_bench;
pub mod remote;
pub mod style;
pub mod text;
pub(crate) mod text_nav;
pub mod tree;
/// Video v2 — player states, the `playback` bind struct, and composition
/// slots. Mirrors `hypen-web/packages/core/src/types.ts`.
pub mod video_v2;
pub mod window;

pub use app::DesktopApp;
pub use layout::{window_controls_platform_insets, SafeAreaInsets, WINDOW_CONTROLS_BAR_HEIGHT};
pub use module::HypenModule;
pub use painter::{PaintTarget, Painter};
pub use remote::{ConnectionStatus, RemoteModule};
pub use tree::{Node, Tree};
pub use window::Shortcut;

/// Re-exported for convenience so callers don't need to depend on the
/// engine crate directly to inspect patches.
pub use hypen_engine::Patch;

/// `mimalloc::MiMalloc`, re-exported behind the `mimalloc` Cargo
/// feature so downstream binaries can wire it as the global
/// allocator in one line:
///
/// ```ignore
/// // In your binary's main.rs:
/// #[global_allocator]
/// static GLOBAL: hypen_renderer_desktop::MiMalloc = hypen_renderer_desktop::MiMalloc;
///
/// fn main() {
///     hypen_renderer_desktop::DesktopApp::new()
///         .source(r#"Text("Hello")"#)
///         .run();
/// }
/// ```
///
/// Why: the macOS / glibc system allocators are RSS-greedy with
/// churny workloads — patch processing in particular allocates and
/// frees small-to-medium objects continuously, and the system
/// allocator holds pages in process address space rather than
/// returning them to the OS. `mimalloc` returns pages aggressively
/// and typically reduces RSS by 20-40 MB on a long-running
/// renderer session, for the cost of one extra dep on the final
/// binary. Off by default — apps that don't enable the feature
/// pay no binary cost.
///
/// Only a final binary can set `#[global_allocator]`; libraries
/// can't. That's why we re-export the type and let the binary do
/// the wiring rather than installing it ourselves.
#[cfg(feature = "mimalloc")]
pub use mimalloc::MiMalloc;
