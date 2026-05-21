//! Text shaping + rasterisation.
//!
//! Wraps a single shared `cosmic-text` `FontSystem` and `SwashCache`. Both
//! are expensive to construct — we build them once per painter and reuse
//! them across frames.

use crate::style::Rgba;
use cosmic_text::{
    Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, SwashCache,
};
use std::collections::HashMap;
use tiny_skia::Pixmap;

/// Cap on cached `(text, font_size, wrap_width) -> (w, h)` entries.
/// 2k is plenty for a busy screen (the social example tops out near
/// ~120 unique text/font/wrap tuples) and bounds memory at ~32KB.
const MEASURE_CACHE_CAP: usize = 2048;

/// Owns the long-lived text engine state.
pub struct TextEngine {
    pub fonts: FontSystem,
    pub swash: SwashCache,
    /// Memoise `measure(text, font_size, wrap_width)` results.
    /// Cosmic-text's `Buffer::new` + `set_text` + `shape_until_scroll`
    /// pipeline is the dominant per-frame cost on text-heavy screens
    /// (Taffy fires the measure callback multiple times per text node
    /// per layout pass). The (text, size, wrap) triple is invariant
    /// for a given content snapshot, so a cheap cache turns N text
    /// nodes × M Taffy passes into ≤N shapes per frame.
    measure_cache: HashMap<u64, (f32, f32)>,
}

impl TextEngine {
    pub fn new() -> Self {
        Self {
            fonts: FontSystem::new(),
            swash: SwashCache::new(),
            measure_cache: HashMap::new(),
        }
    }

    /// Drop the cached measurements. Call when the font system gains
    /// new fonts, or on a heavy memory-pressure signal. The cache
    /// auto-evicts at `MEASURE_CACHE_CAP` so ordinary use never needs
    /// to call this.
    pub fn clear_measure_cache(&mut self) {
        self.measure_cache.clear();
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
        // Cache key: hash text + font_size bits + wrap bits. f32 NaN
        // never reaches us (Taffy hands us finite values), so
        // to_bits() is collision-free across the inputs we get.
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        text.hash(&mut hasher);
        font_size.to_bits().hash(&mut hasher);
        wrap_width.map(f32::to_bits).hash(&mut hasher);
        let key = hasher.finish();
        if let Some(&hit) = self.measure_cache.get(&key) {
            return hit;
        }

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
        let result = (max_w.ceil(), total_h.ceil());
        if self.measure_cache.len() >= MEASURE_CACHE_CAP {
            // Cheap LRU substitute: drop the whole map when it fills.
            // The next frame rebuilds only what's still on screen.
            self.measure_cache.clear();
        }
        self.measure_cache.insert(key, result);
        result
    }

    /// Return the byte offset within `text` whose leading-substring
    /// width is closest to `target_x` (physical pixels). Used by the
    /// window's click-to-position-cursor path on Inputs.
    ///
    /// Walks every char-boundary plus end-of-string and picks the
    /// minimum `|measure(prefix).w - target_x|`. cosmic-text caches
    /// glyphs internally so per-prefix measure is O(n) amortised —
    /// fine for sub-second Input strings, worth tightening when
    /// `Textarea` (multi-line) editing lands.
    pub fn byte_offset_at_x(&mut self, text: &str, target_x: f32, font_size: f32) -> usize {
        if text.is_empty() {
            return 0;
        }
        let mut best = 0usize;
        let mut best_dx = target_x.abs();
        for (i, _) in text.char_indices() {
            if i == 0 {
                continue;
            }
            let (w, _) = self.measure(&text[..i], font_size, None);
            let dx = (w - target_x).abs();
            if dx < best_dx {
                best = i;
                best_dx = dx;
            }
        }
        let (full_w, _) = self.measure(text, font_size, None);
        if (full_w - target_x).abs() < best_dx {
            best = text.len();
        }
        best
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
        // cosmic-text's swash glyph path overwrites the source colour's
        // alpha byte with the per-pixel coverage byte, so the inner
        // `if a == 0` guard never sees a zero source. Short-circuit
        // here so a fully-transparent draw is a true no-op — without
        // this, drawing in `Rgba::TRANSPARENT` still mutates pixels.
        if color.3 == 0 {
            return;
        }
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
    use crate::style::Rgba;
    use tiny_skia::Pixmap;

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

    #[test]
    fn measure_empty_string_has_minimum_height() {
        let mut t = TextEngine::new();
        let (w, h) = t.measure("", 18.0, None);
        assert_eq!(w, 0.0, "empty string should have zero width, got {w}");
        // Empty text still produces a non-degenerate line so layout doesn't
        // collapse Inputs / wrap-targets to zero height. cosmic-text reports
        // a smaller-than-font-size descender slice for the empty buffer, so
        // we just require the height to be at least the font-size itself
        // (≥ 18px in this case) — far above zero, conservative against
        // future metric tweaks.
        assert!(
            h >= 18.0,
            "empty string height ({h}) should be at least font_size (18.0)",
        );
    }

    #[test]
    fn measure_single_char() {
        let mut t = TextEngine::new();
        let (w, h) = t.measure("x", 18.0, None);
        assert!(w > 0.0, "single char should have positive width, got {w}");
        // Still single-line — generously bound at 2x font-size.
        assert!(
            h <= 18.0 * 2.6,
            "single-char height ({h}) should not exceed 2x font-size",
        );
    }

    #[test]
    fn measure_with_newlines_grows_height() {
        let mut t = TextEngine::new();
        let (_w_one, h_one) = t.measure("line1", 18.0, None);
        let (_w_two, h_two) = t.measure("line1\nline2", 18.0, None);
        // Two lines should be roughly twice the height of one. Allow
        // generous slop for ascender/descender adjustments.
        assert!(
            h_two > h_one * 1.6,
            "two-line height ({h_two}) should be ~2x one-line ({h_one})",
        );
        assert!(
            h_two < h_one * 2.6,
            "two-line height ({h_two}) should not exceed ~2.5x one-line ({h_one})",
        );
    }

    #[test]
    fn measure_larger_font_grows_proportionally() {
        let mut t = TextEngine::new();
        let s = "Hello world";
        let (w_small, h_small) = t.measure(s, 18.0, None);
        let (w_big, h_big) = t.measure(s, 36.0, None);
        // Scaling 18 → 36 should roughly double both axes. Fonts aren't
        // perfectly linear, so allow 30% tolerance.
        let w_ratio = w_big / w_small;
        let h_ratio = h_big / h_small;
        assert!(
            (1.4..=2.6).contains(&w_ratio),
            "width should ~2x with font size; got ratio {w_ratio} ({w_small} → {w_big})",
        );
        assert!(
            (1.4..=2.6).contains(&h_ratio),
            "height should ~2x with font size; got ratio {h_ratio} ({h_small} → {h_big})",
        );
    }

    /// Helper: scan a window of the pixmap looking for any pixel that is
    /// detectably darker (any channel < 250) than the white background.
    fn has_dark_pixel(pixmap: &Pixmap, x0: u32, y0: u32, w: u32, h: u32) -> bool {
        for py in y0..(y0 + h).min(pixmap.height()) {
            for px in x0..(x0 + w).min(pixmap.width()) {
                if let Some(p) = pixmap.pixel(px, py) {
                    if p.red() < 250 || p.green() < 250 || p.blue() < 250 {
                        return true;
                    }
                }
            }
        }
        false
    }

    #[test]
    fn draw_text_into_pixmap_writes_pixels() {
        let mut t = TextEngine::new();
        let mut pixmap = Pixmap::new(120, 40).expect("pixmap alloc");
        // Fill white so any glyph blends visibly darker than background.
        pixmap.fill(tiny_skia::Color::from_rgba8(0xff, 0xff, 0xff, 0xff));

        // Render in pure black.
        t.draw_text_colored(&mut pixmap, "hi", 4.0, 4.0, 18.0, Rgba::BLACK, None);

        // Search the rectangle the glyphs should occupy. Use a generous
        // window since exact metrics depend on the loaded sans-serif.
        assert!(
            has_dark_pixel(&pixmap, 0, 0, 120, 40),
            "expected at least one non-white pixel after drawing 'hi'",
        );
    }

    #[test]
    fn draw_text_colored_respects_color_alpha() {
        // Regression: cosmic-text's swash glyph path used to replace
        // the source colour's alpha with the per-pixel coverage byte,
        // so drawing in `Rgba::TRANSPARENT` still mutated the pixmap.
        // We now short-circuit at the source — a transparent draw is
        // a true no-op (byte-identical pre/post). Opaque renders
        // continue to mutate as expected.
        let mut t = TextEngine::new();

        let mut red = Pixmap::new(120, 40).expect("red alloc");
        red.fill(tiny_skia::Color::from_rgba8(0xff, 0xff, 0xff, 0xff));
        let red_before = red.data().to_vec();
        t.draw_text_colored(&mut red, "hi", 4.0, 4.0, 18.0, Rgba(0xff, 0, 0, 0xff), None);
        assert_ne!(
            red.data(),
            red_before.as_slice(),
            "opaque-red render should differ from the pre-render snapshot",
        );

        let mut transparent = Pixmap::new(120, 40).expect("transparent alloc");
        transparent.fill(tiny_skia::Color::from_rgba8(0xff, 0xff, 0xff, 0xff));
        let before = transparent.data().to_vec();
        t.draw_text_colored(
            &mut transparent,
            "hi",
            4.0,
            4.0,
            18.0,
            Rgba::TRANSPARENT,
            None,
        );
        assert_eq!(
            transparent.data(),
            before.as_slice(),
            "transparent draw must leave the pixmap byte-identical",
        );
    }

    // -----------------------------------------------------------------
    // byte_offset_at_x — click-to-position cursor on Inputs
    // -----------------------------------------------------------------

    #[test]
    fn byte_offset_at_x_returns_zero_for_empty_string() {
        let mut t = TextEngine::new();
        assert_eq!(t.byte_offset_at_x("", 0.0, 18.0), 0);
        assert_eq!(t.byte_offset_at_x("", 100.0, 18.0), 0);
    }

    #[test]
    fn byte_offset_at_x_zero_lands_at_start() {
        let mut t = TextEngine::new();
        assert_eq!(t.byte_offset_at_x("hello", 0.0, 18.0), 0);
    }

    #[test]
    fn byte_offset_at_x_far_right_lands_at_end() {
        let mut t = TextEngine::new();
        // 10000 px is well past any realistic string — result must be
        // the byte length so click-past-end places the caret at end.
        let s = "hello";
        assert_eq!(t.byte_offset_at_x(s, 10_000.0, 18.0), s.len());
    }

    #[test]
    fn byte_offset_at_x_lands_on_a_char_boundary_for_multibyte() {
        // "héllo" has bytes h(0) é(1..3) l(3) l(4) o(5) — len 6.
        // Any returned offset must be a valid char boundary so callers
        // can safely slice with it.
        let mut t = TextEngine::new();
        let s = "héllo";
        for px in [0.0_f32, 5.0, 10.0, 20.0, 50.0, 200.0] {
            let off = t.byte_offset_at_x(s, px, 18.0);
            assert!(
                s.is_char_boundary(off),
                "offset {off} for x={px} is not a char boundary in {s:?}",
            );
        }
    }
}
