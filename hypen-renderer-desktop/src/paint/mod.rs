//! Painter implementations.
//!
//! Phase 1 ships a single CPU painter (tiny-skia + cosmic-text). When Vello
//! pairs with wgpu 29, a `gpu` module will sit alongside this one behind the
//! same [`Painter`] trait.
//!
//! [`Painter`]: crate::Painter

pub mod cpu;
pub mod icon;
pub mod image;
pub mod vello_painter;

/// Default `::placeholder` colour for Input / Textarea: Chromium's light
/// UA stylesheet colour (`#757575`), which the DOM renderer inherits. The
/// previous light slate (`#9096A1`) all but vanished on the light,
/// translucent fields apps commonly use (the weather search box).
pub const PLACEHOLDER_COLOR: crate::style::Rgba = crate::style::Rgba(0x75, 0x75, 0x75, 0xff);
