//! Text shaping + rasterisation.
//!
//! Wraps a single shared `cosmic-text` `FontSystem` and `SwashCache`. Both
//! are expensive to construct — we build them once per painter and reuse
//! them across frames.

use crate::style::Rgba;
use cosmic_text::{
    Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, SwashCache,
};
use tiny_skia::Pixmap;

/// Owns the long-lived text engine state.
pub struct TextEngine {
    pub fonts: FontSystem,
    pub swash: SwashCache,
}

impl TextEngine {
    pub fn new() -> Self {
        Self {
            fonts: FontSystem::new(),
            swash: SwashCache::new(),
        }
    }

    /// Measure `text` at `font_size` (physical px). When `wrap_width` is
    /// `Some`, lines wrap to fit; otherwise text stays on one line.
    /// Returns `(width, height)` in physical pixels.
    pub fn measure(
        &mut self,
        text: &str,
        font_size: f32,
        wrap_width: Option<f32>,
    ) -> (f32, f32) {
        let metrics = Metrics::new(font_size, font_size * 1.3);
        let mut buffer = Buffer::new(&mut self.fonts, metrics);
        let attrs = Attrs::new().family(Family::SansSerif);
        buffer.set_text(text, &attrs, Shaping::Advanced, None);
        buffer.set_size(wrap_width, None);
        buffer.shape_until_scroll(&mut self.fonts, false);

        let mut max_w: f32 = 0.0;
        let mut total_h: f32 = 0.0;
        for run in buffer.layout_runs() {
            max_w = max_w.max(run.line_w);
            total_h = total_h.max(run.line_y + run.line_height * 0.3);
        }
        if total_h == 0.0 {
            total_h = font_size * 1.3;
        }
        (max_w.ceil(), total_h.ceil())
    }

    /// Lay out `text` and rasterise it into `pixmap` in black at `(x, y)`.
    /// Convenience over [`Self::draw_text_colored`] for callers that don't
    /// need a custom colour.
    pub fn draw_text(
        &mut self,
        pixmap: &mut Pixmap,
        text: &str,
        x: f32,
        y: f32,
        font_size: f32,
    ) {
        self.draw_text_colored(pixmap, text, x, y, font_size, Rgba::BLACK, None);
    }

    /// Lay out `text` and rasterise it into `pixmap` at `(x, y)` (top-left,
    /// in physical pixels). `font_size` is in physical pixels too — caller
    /// applies HiDPI scale. `color` is straight-alpha RGBA. When
    /// `wrap_width` is `Some`, lines wrap to fit.
    #[allow(clippy::too_many_arguments)]
    pub fn draw_text_colored(
        &mut self,
        pixmap: &mut Pixmap,
        text: &str,
        x: f32,
        y: f32,
        font_size: f32,
        color: Rgba,
        wrap_width: Option<f32>,
    ) {
        let metrics = Metrics::new(font_size, font_size * 1.3);
        let mut buffer = Buffer::new(&mut self.fonts, metrics);
        let attrs = Attrs::new().family(Family::SansSerif);
        buffer.set_text(text, &attrs, Shaping::Advanced, None);
        buffer.set_size(wrap_width, None);

        // cosmic-text's Color is stored straight-alpha and multiplied
        // into the per-pixel coverage. Premultiply happens in our blit
        // step below.
        let cosmic_color = Color::rgba(color.0, color.1, color.2, color.3);

        // `draw` walks each glyph and calls our closure with a coverage rect.
        // The legacy renderer emits one (x, y, 1, 1, color) per pixel for
        // glyphs and (x, y, w, h, color) rects for decorations like
        // underlines. We blit each into the tiny-skia pixmap manually so we
        // control alpha blending and pixel format.
        let pixmap_w = pixmap.width() as i32;
        let pixmap_h = pixmap.height() as i32;
        let pixmap_pixels = pixmap.pixels_mut();

        buffer.draw(
            &mut self.fonts,
            &mut self.swash,
            cosmic_color,
            |gx, gy, w, h, glyph_color| {
                let r = glyph_color.r();
                let g = glyph_color.g();
                let b = glyph_color.b();
                let a = glyph_color.a();
                if a == 0 || w == 0 || h == 0 {
                    return;
                }
                let sa = a as u32;
                let inv_sa = 255 - sa;
                for dy in 0..h as i32 {
                    let py = y as i32 + gy + dy;
                    if py < 0 || py >= pixmap_h {
                        continue;
                    }
                    for dx in 0..w as i32 {
                        let px = x as i32 + gx + dx;
                        if px < 0 || px >= pixmap_w {
                            continue;
                        }
                        let idx = (py as usize) * (pixmap_w as usize) + (px as usize);
                        if let Some(dst) = pixmap_pixels.get_mut(idx) {
                            let dr = dst.red() as u32;
                            let dg = dst.green() as u32;
                            let db = dst.blue() as u32;
                            let da = dst.alpha() as u32;
                            let nr = ((r as u32 * sa + dr * inv_sa) / 255) as u8;
                            let ng = ((g as u32 * sa + dg * inv_sa) / 255) as u8;
                            let nb = ((b as u32 * sa + db * inv_sa) / 255) as u8;
                            let na = (sa + (da * inv_sa) / 255) as u8;
                            *dst = tiny_skia::PremultipliedColorU8::from_rgba(nr, ng, nb, na)
                                .unwrap_or(*dst);
                        }
                    }
                }
            },
        );
    }
}

impl Default for TextEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::TextEngine;

    #[test]
    fn measure_unwrapped_returns_single_line_height() {
        let mut t = TextEngine::new();
        let (w, h) = t.measure("hello world hello world", 18.0, None);
        assert!(w > 0.0);
        // Without wrap, height should match a single line + descenders —
        // generously bound at 2x the metric height.
        assert!(h <= 18.0 * 2.6, "single-line height should not exceed 2x font-size, got {h}");
    }

    #[test]
    fn measure_with_narrow_wrap_increases_height() {
        let mut t = TextEngine::new();
        let long = "the quick brown fox jumps over the lazy dog several times";
        let (_w_unwrapped, h_unwrapped) = t.measure(long, 18.0, None);
        let (w_wrapped, h_wrapped) = t.measure(long, 18.0, Some(80.0));
        assert!(
            h_wrapped > h_unwrapped,
            "wrapped height ({h_wrapped}) should exceed unwrapped ({h_unwrapped})",
        );
        assert!(
            w_wrapped <= 80.0 + 1.0,
            "wrapped width ({w_wrapped}) should fit within ~80px",
        );
    }
}
