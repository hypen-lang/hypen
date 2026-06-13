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
