//! `Painter` abstraction.
//!
//! The renderer rasterises the [`Tree`] each frame through a `Painter`
//! implementation. Phase 1 ships [`paint::cpu::CpuPainter`] (tiny-skia +
//! cosmic-text). When Vello catches up to wgpu 29 (or we grow a `tiny-skia`
//! upgrade story), a GPU painter slots in behind the same trait without
//! any other code in the crate changing.
//!
//! [`Tree`]: crate::tree::Tree
//! [`paint::cpu::CpuPainter`]: crate::paint::cpu::CpuPainter

use crate::tree::Tree;

/// The framebuffer the painter writes into.
///
/// `pixels` is a tightly packed RGBA8 (premultiplied alpha) buffer of
/// `width * height * 4` bytes. The renderer's GPU layer uploads this
/// to a wgpu texture and blits it to the surface.
pub struct PaintTarget<'a> {
    pub pixels: &'a mut [u8],
    pub width: u32,
    pub height: u32,
    /// Logical → physical scale factor (HiDPI). Painters use this to
    /// scale font sizes / stroke widths so output is crisp.
    pub scale_factor: f32,
}

/// Trait implemented by each rasteriser backend.
pub trait Painter {
    /// Paint a single frame of `tree` into `target`. The framebuffer
    /// is *not* cleared by the renderer — implementations are
    /// responsible for filling the background.
    fn paint(&mut self, tree: &Tree, target: PaintTarget<'_>);
}
