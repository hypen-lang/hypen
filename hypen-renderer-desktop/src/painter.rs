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

/// Where the painter writes. Width / height are in physical pixels;
/// the painter owns the actual byte buffer (a `tiny_skia::Pixmap`
/// kept across frames so `Pixmap::new` allocs only happen on resize)
/// and exposes a borrow via `CpuPainter::pixmap_data()` after the
/// paint completes. The GPU layer uploads from that borrow directly,
/// avoiding a redundant per-frame surface-sized copy into App-owned
/// bytes.
pub struct PaintTarget<'a> {
    pub width: u32,
    pub height: u32,
    /// Logical → physical scale factor (HiDPI). Painters use this to
    /// scale font sizes / stroke widths so output is crisp.
    pub scale_factor: f32,
    _phantom: std::marker::PhantomData<&'a ()>,
}

impl<'a> PaintTarget<'a> {
    pub fn new(width: u32, height: u32, scale_factor: f32) -> Self {
        Self {
            width,
            height,
            scale_factor,
            _phantom: std::marker::PhantomData,
        }
    }
}

/// Trait implemented by each rasteriser backend.
pub trait Painter {
    /// Paint a single frame of `tree` into `target`. The framebuffer
    /// is *not* cleared by the renderer — implementations are
    /// responsible for filling the background.
    fn paint(&mut self, tree: &Tree, target: PaintTarget<'_>);
}
