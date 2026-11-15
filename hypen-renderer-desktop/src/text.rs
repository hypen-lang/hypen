//! Text shaping + rasterisation.
//!
//! Wraps a single shared `cosmic-text` `FontSystem` and `SwashCache`. Both
//! are expensive to construct — we build them once per painter and reuse
//! them across frames.

use crate::layout::TextAlign;
use crate::style::Rgba;
use cosmic_text::{
    Attrs, Buffer, Family, FontSystem, Metrics, Shaping, SwashCache, SwashContent, Weight, Wrap,
};
use indexmap::IndexMap;
use std::borrow::Cow;
use std::sync::{Arc, OnceLock};
use tiny_skia::Pixmap;

/// Cap on cached `(text, font_size, wrap_width) -> (w, h)` entries.
///
/// This was briefly raised to 16k and reverted. The measurement that
/// justified the raise (a 600-post feed missing on nearly every lookup,
/// ~85% of a window-height resize frame) was real when taken, but
/// `TaffyState::wrapped_probes` now answers the repeated "how tall is
/// this text at this width" question *before* the measure cache is
/// consulted. Re-measured against the larger cap afterwards: exactly 0%
/// on a height drag, ~8% on the heaviest width drag — not worth ~950 KB
/// resident per window, which nothing clears outside an `Occluded(true)`
/// transition.
///
/// Note the real per-entry cost is ~60 B, not the 16 B the payload
/// suggests: `IndexMap` reserves its entry `Vec` to the index table's
/// capacity and hashbrown carries a control byte per bucket.
const MEASURE_CACHE_CAP: usize = 2048;
/// Cap on cached rasterised-text pixmaps. ~500 unique
/// (text, font_size, color, wrap) tuples covers a complex screen with
/// headroom. Avg pixmap size is ~5KB so memory is bounded near 2.5MB.
const RASTER_CACHE_CAP: usize = 512;
/// DOM Text sets `line-height: 1` so the line box equals the declared font
/// size. Native font ascent/descent still positions glyphs within that box.
const TEXT_LINE_HEIGHT_MULTIPLIER: f32 = 1.0;

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
    measure_cache: IndexMap<u64, (f32, f32)>,
    /// Pre-rasterised pixmaps keyed on `(text, font_size, color, wrap)`.
    /// On a cache hit, painting a Text becomes a single `draw_pixmap`
    /// instead of running cosmic-text's shape + per-glyph alpha blend
    /// loop again. This is the leaf-element layer cache — text nodes
    /// are by far the slowest single op in the paint loop.
    raster_cache: IndexMap<u64, Pixmap>,
    /// GPU-side twin of `raster_cache` for the Vello path, same key.
    /// `peniko::ImageData` shares its bytes via an `Arc`'d `Blob`, so a
    /// hit in `draw_text_into_scene` is an Arc bump instead of the
    /// multi-KB `tile.data().to_vec()` the pixmap→ImageData conversion
    /// costs — which used to run for EVERY text draw on every subtree
    /// re-encode.
    scene_tile_cache: IndexMap<u64, vello::peniko::ImageData>,
    /// Laid-out visual lines (ink extent + baseline) keyed on the same
    /// `(text, font_size, wrap, weight, line_height)` inputs as
    /// `measure_cache`. Backs decoration painting: without it every paint
    /// of a decorated Text built and shaped a fresh cosmic-text `Buffer`,
    /// on top of the (cached) glyph tile it decorates.
    line_runs_cache: IndexMap<u64, std::sync::Arc<[LineRun]>>,
    /// The `font-family` every shape / measure / draw uses: the renderer
    /// default (sans-serif) except inside [`Self::with_family`]. Part of
    /// every cache key above.
    family: FontFamily,
    /// Authored family list → the face family it resolves to on this
    /// host (see [`resolve_family_list`]). A screen uses a handful of
    /// distinct lists, so this stays tiny.
    family_resolution: rustc_hash::FxHashMap<Arc<str>, ResolvedFamily>,
    /// `(face family, requested weight)` → the weight to ask the shaper
    /// for: the CSS font-matching answer within that family (see
    /// [`css_matched_weight`]).
    weight_resolution: rustc_hash::FxHashMap<(Arc<str>, u16), u16>,
    /// How each wrapped line sits inside the text's box (`text-align`).
    /// Like `family`, a scoped setting ([`Self::replace_align`]) that is
    /// part of every draw-cache key; measuring ignores it.
    align: TextAlign,
    /// How many times [`Self::line_runs`] actually shaped (cache misses).
    #[cfg(test)]
    pub(crate) line_runs_shapes: usize,
}

impl TextEngine {
    pub fn new() -> Self {
        Self {
            fonts: build_slim_font_system(),
            swash: SwashCache::new(),
            measure_cache: IndexMap::new(),
            raster_cache: IndexMap::new(),
            scene_tile_cache: IndexMap::new(),
            line_runs_cache: IndexMap::new(),
            family: FontFamily::default(),
            family_resolution: Default::default(),
            weight_resolution: Default::default(),
            align: TextAlign::Start,
            #[cfg(test)]
            line_runs_shapes: 0,
        }
    }

    /// Drop the cached measurements + rasters. Call when the font
    /// system gains new fonts, or on a heavy memory-pressure signal.
    /// Both caches auto-evict at their caps so ordinary use never
    /// needs to call this.
    pub fn clear_measure_cache(&mut self) {
        self.measure_cache.clear();
        self.raster_cache.clear();
        self.scene_tile_cache.clear();
        self.line_runs_cache.clear();
    }

    /// Run `f` with `family` as the font family of every measure / draw /
    /// line-layout call it makes, then restore the previous one. Outside
    /// a scope text uses the renderer default (sans-serif), so a caller
    /// that never sets a family can't inherit a stale one.
    pub fn with_family<R>(&mut self, family: &FontFamily, f: impl FnOnce(&mut Self) -> R) -> R {
        if *family == self.family {
            return f(self);
        }
        let previous = self.replace_family(family.clone());
        let result = f(self);
        self.replace_family(previous);
        result
    }

    /// Set the current family and return the previous one — the
    /// non-closure form of [`Self::with_family`] for callers that need
    /// to borrow their own state around the text calls. Pair every call
    /// with a restoring one.
    pub fn replace_family(&mut self, family: FontFamily) -> FontFamily {
        std::mem::replace(&mut self.family, family)
    }

    /// Set the `text-align` every draw / line-layout call positions
    /// wrapped lines with, returning the previous one. Pair every call
    /// with a restoring one (like [`Self::replace_family`]).
    pub fn replace_align(&mut self, align: TextAlign) -> TextAlign {
        std::mem::replace(&mut self.align, align)
    }

    /// The installed face family the current [`FontFamily`] resolves to
    /// here — always a concrete family name, so the weight it is shaped
    /// at can be matched against that family's faces.
    fn face_family(&mut self) -> Arc<str> {
        let resolved = match self.family.list.as_ref() {
            None => ResolvedFamily::Generic(GenericFamily::SansSerif),
            Some(list) => match self.family_resolution.get(list) {
                Some(hit) => hit.clone(),
                None => {
                    let resolved = resolve_family_list(list, self.fonts.db());
                    if self.family_resolution.len() >= 64 {
                        self.family_resolution.clear();
                    }
                    self.family_resolution
                        .insert(Arc::clone(list), resolved.clone());
                    resolved
                }
            },
        };
        match resolved {
            ResolvedFamily::Named(name) => name,
            ResolvedFamily::Generic(generic) => generic_face_family(generic),
        }
    }

    /// The weight to shape `family` at for a requested CSS `weight`:
    /// the face CSS font matching picks (see [`css_matched_weight`]).
    /// cosmic-text only takes a family's face at exactly the requested
    /// weight; for any other weight it drops to its fallback list, which
    /// is how a `fontWeight(600)` serif title came out in a sans face.
    fn matched_weight(&mut self, family: &Arc<str>, weight: u16) -> u16 {
        let key = (Arc::clone(family), weight);
        if let Some(&hit) = self.weight_resolution.get(&key) {
            return hit;
        }
        let matched = css_matched_weight(self.fonts.db(), family, weight);
        if self.weight_resolution.len() >= 256 {
            self.weight_resolution.clear();
        }
        self.weight_resolution.insert(key, matched);
        matched
    }

    /// Shape `text` exactly as every measure / draw / line-layout path
    /// lays it out: the current family's face at its CSS-matched weight,
    /// the inherited `letter-spacing` and `text-transform`, emoji
    /// clusters on the colour-emoji face, browser line-break
    /// opportunities, and `Wrap::Word` (CSS `overflow-wrap: normal`).
    fn shape(
        &mut self,
        display: &str,
        font_size: f32,
        wrap_width: Option<f32>,
        weight: u16,
        line_height: f32,
    ) -> Buffer {
        let metrics = Metrics::new(font_size, line_height.max(font_size));
        let face = self.face_family();
        let matched = self.matched_weight(&face, weight);
        let mut attrs = Attrs::new()
            .family(Family::Name(&face))
            .weight(Weight(matched));
        let spacing = self.family.letter_spacing_em();
        if spacing != 0.0 {
            attrs = attrs.letter_spacing(spacing);
        }
        let mut buffer = Buffer::new(&mut self.fonts, metrics);
        let emoji = match emoji_family() {
            Some(emoji_face) => emoji_ranges(display)
                .map(|ranges| (emoji_face, ranges))
                .filter(|(_, ranges)| !ranges.is_empty()),
            None => None,
        };
        match emoji {
            None => buffer.set_text(display, &attrs, Shaping::Advanced, None),
            Some((emoji_face, ranges)) => {
                // Clusters with emoji presentation go to the colour-emoji
                // face like a browser's emoji font-fallback priority does:
                // left to ordinary fallback, a text face that happens to
                // carry the code point (DejaVu Sans has 😂 and ❤) wins and
                // the emoji draws as a monochrome outline.
                let emoji_attrs = attrs
                    .clone()
                    .family(Family::Name(emoji_face))
                    .weight(Weight(400));
                let mut spans = Vec::with_capacity(ranges.len() * 2 + 1);
                let mut at = 0;
                for range in ranges {
                    if range.start > at {
                        spans.push((&display[at..range.start], attrs.clone()));
                    }
                    spans.push((&display[range.clone()], emoji_attrs.clone()));
                    at = range.end;
                }
                if at < display.len() {
                    spans.push((&display[at..], attrs.clone()));
                }
                buffer.set_rich_text(spans, &attrs, Shaping::Advanced, None);
            }
        }
        buffer.set_size(wrap_width, None);
        // Match CSS `overflow-wrap: normal`: only break at word
        // boundaries (whitespace). A single word longer than the
        // wrap width overflows the parent instead of being chopped
        // mid-glyph — chopping was breaking usernames like
        // "charlie_eats" into "charlie_eat\ns" inside the Post Row
        // where flex shrink had squeezed the username column below
        // the word's intrinsic width. Cosmic-text defaults to
        // `WordOrGlyph`, which is what produced the broken render.
        buffer.set_wrap(Wrap::Word);
        buffer.shape_until_scroll(&mut self.fonts, false);
        buffer
    }

    /// Horizontal offset of each laid-out line inside the text's box for
    /// the current `text-align`: CSS aligns every line of a wrapped
    /// paragraph on its own, so a centred paragraph centres each line
    /// within the widest one (the box the caller positions).
    fn line_offsets(&self, buffer: &Buffer) -> (f32, f32) {
        let factor = match self.align {
            TextAlign::Start => 0.0,
            TextAlign::Center => 0.5,
            TextAlign::End => 1.0,
        };
        let box_w = buffer
            .layout_runs()
            .map(|run| run.line_w)
            .fold(0.0_f32, f32::max);
        (factor, box_w)
    }

    /// Measure `text` at `font_size` (physical px). When `wrap_width` is
    /// `Some`, lines wrap to fit; otherwise text stays on one line.
    /// Returns `(width, height)` in physical pixels.
    pub fn measure(&mut self, text: &str, font_size: f32, wrap_width: Option<f32>) -> (f32, f32) {
        self.measure_weighted(text, font_size, wrap_width, 400)
    }

    /// Same as [`Self::measure`] but takes a CSS-style font weight.
    /// Bold glyphs are wider, so the wrap result depends on weight;
    /// the cache keys on it.
    pub fn measure_weighted(
        &mut self,
        text: &str,
        font_size: f32,
        wrap_width: Option<f32>,
        weight: u16,
    ) -> (f32, f32) {
        self.measure_weighted_line_height(text, font_size, wrap_width, weight, font_size)
    }

    pub fn measure_weighted_line_height(
        &mut self,
        text: &str,
        font_size: f32,
        wrap_width: Option<f32>,
        weight: u16,
        line_height: f32,
    ) -> (f32, f32) {
        // Cache key: hash text + font_size bits + wrap bits + weight.
        // f32 NaN never reaches us (Taffy hands us finite values), so
        // to_bits() is collision-free across the inputs we get.
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        text.hash(&mut hasher);
        font_size.to_bits().hash(&mut hasher);
        wrap_width.map(f32::to_bits).hash(&mut hasher);
        weight.hash(&mut hasher);
        self.family.hash(&mut hasher);
        line_height.to_bits().hash(&mut hasher);
        let key = hasher.finish();
        if let Some(&hit) = self.measure_cache.get(&key) {
            return hit;
        }

        let display = display_text(text, self.family.transform);
        let buffer = self.shape(&display.text, font_size, wrap_width, weight, line_height);

        let mut max_w: f32 = 0.0;
        let mut total_h: f32 = 0.0;
        for run in buffer.layout_runs() {
            max_w = max_w.max(run.line_w);
            total_h = total_h.max(run.line_top + run.line_height);
        }
        if total_h == 0.0 {
            total_h = font_size * TEXT_LINE_HEIGHT_MULTIPLIER;
        }
        let result = (max_w.ceil(), total_h.ceil());
        if self.measure_cache.len() >= MEASURE_CACHE_CAP {
            // FIFO single-entry eviction. Wholesale clear caused
            // frame-time cliffs as the cache filled — every miss past
            // the cap re-shaped the next 2k unique text/font/wrap
            // tuples in lockstep. Single-entry pop keeps churn
            // proportional to inserts.
            //
            // FIFO deliberately, not a cheaper O(1) arbitrary victim:
            // nothing here re-inserts on a hit, so insertion order *is*
            // "time since this entry was faulted in", and dropping the
            // oldest is the only policy that guarantees a just-inserted
            // entry survives the next CAP-1 inserts. Random replacement
            // has the same mean lifetime and a worse tail. The O(len)
            // compaction is affordable at this cap; it would not be at
            // 16k, which is the other reason that raise was reverted.
            self.measure_cache.shift_remove_index(0);
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
    pub fn draw_text(&mut self, pixmap: &mut Pixmap, text: &str, x: f32, y: f32, font_size: f32) {
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
        self.draw_text_weighted(pixmap, text, x, y, font_size, color, wrap_width, 400);
    }

    /// Same as [`Self::draw_text_colored`] but takes a CSS-style font
    /// weight (100..900). 400 = normal, 700 = bold.
    pub fn draw_text_weighted(
        &mut self,
        pixmap: &mut Pixmap,
        text: &str,
        x: f32,
        y: f32,
        font_size: f32,
        color: Rgba,
        wrap_width: Option<f32>,
        weight: u16,
    ) {
        self.draw_text_weighted_line_height(
            pixmap, text, x, y, font_size, color, wrap_width, weight, font_size,
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub fn draw_text_weighted_line_height(
        &mut self,
        pixmap: &mut Pixmap,
        text: &str,
        x: f32,
        y: f32,
        font_size: f32,
        color: Rgba,
        wrap_width: Option<f32>,
        weight: u16,
        line_height: f32,
    ) {
        // cosmic-text's swash glyph path overwrites the source colour's
        // alpha byte with the per-pixel coverage byte, so the inner
        // `if a == 0` guard never sees a zero source. Short-circuit
        // here so a fully-transparent draw is a true no-op — without
        // this, drawing in `Rgba::TRANSPARENT` still mutates pixels.
        if color.3 == 0 {
            return;
        }
        // Same shaping as `measure_weighted_line_height` — without
        // matching the two paths, the draw could emit lines the
        // measure cache didn't account for (or vice versa) and the
        // raster cache key would diverge from the actual layout.
        let display = display_text(text, self.family.transform);
        let buffer = self.shape(&display.text, font_size, wrap_width, weight, line_height);
        let (factor, box_w) = self.line_offsets(&buffer);

        // Rasterise glyph by glyph through the swash cache and blend into
        // the tiny-skia pixmap ourselves, so we control alpha and pixel
        // format. (cosmic-text's own `Buffer::draw` replaces the colour's
        // alpha with the glyph coverage, which painted `rgba(…, 0.5)`
        // text fully opaque.)
        let origin_x = x as i32;
        let origin_y = y as i32;
        for run in buffer.layout_runs() {
            let dx = (box_w - run.line_w).max(0.0) * factor;
            for glyph in run.glyphs {
                let physical = glyph.physical((dx, run.line_y), 1.0);
                let Some(image) = self.swash.get_image(&mut self.fonts, physical.cache_key)
                else {
                    continue;
                };
                blit_glyph(
                    pixmap,
                    origin_x + physical.x + image.placement.left,
                    origin_y + physical.y - image.placement.top,
                    image,
                    color,
                );
            }
        }
    }

    /// Render `text` into a pre-rasterised tile and append it to a
    /// `vello::Scene` as a `draw_image`. Bridges cosmic-text's CPU
    /// glyph rasterisation to Vello's GPU compositor for the
    /// duration of the migration — when we ship a native vello
    /// `draw_glyphs` path (extracting font bytes from cosmic-text's
    /// fontdb), this becomes a fallback for unusual paths only.
    ///
    /// Reuses the existing `raster_cache` so repeated draws of the
    /// same `(text, font_size, color, wrap, weight)` tuple share
    /// the cached pixmap — only the per-call conversion to
    /// `peniko::Image` (a `Vec<u8>` clone of the tile) costs.
    #[allow(clippy::too_many_arguments)]
    pub fn draw_text_into_scene(
        &mut self,
        scene: &mut vello::Scene,
        text: &str,
        x: f32,
        y: f32,
        font_size: f32,
        color: Rgba,
        wrap_width: Option<f32>,
        weight: u16,
    ) {
        self.draw_text_into_scene_line_height(
            scene, text, x, y, font_size, color, wrap_width, weight, font_size,
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub fn draw_text_into_scene_line_height(
        &mut self,
        scene: &mut vello::Scene,
        text: &str,
        x: f32,
        y: f32,
        font_size: f32,
        color: Rgba,
        wrap_width: Option<f32>,
        weight: u16,
        line_height: f32,
    ) {
        if color.3 == 0 || text.is_empty() {
            return;
        }
        let (mw, mh) =
            self.measure_weighted_line_height(text, font_size, wrap_width, weight, line_height);
        let cw = mw.ceil().max(1.0) as u32;
        let ch = mh.ceil().max(1.0) as u32;

        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        text.hash(&mut hasher);
        font_size.to_bits().hash(&mut hasher);
        let color_u32 = u32::from_le_bytes([color.0, color.1, color.2, color.3]);
        color_u32.hash(&mut hasher);
        wrap_width.map(f32::to_bits).hash(&mut hasher);
        weight.hash(&mut hasher);
        self.family.hash(&mut hasher);
        (self.align as u8).hash(&mut hasher);
        line_height.to_bits().hash(&mut hasher);
        cw.hash(&mut hasher);
        ch.hash(&mut hasher);
        let key = hasher.finish();

        // GPU tile cache first: a hit skips both the CPU raster AND
        // the per-draw `to_vec` byte clone — the ImageData's Blob is
        // Arc-shared, so replaying a text tile costs a refcount bump.
        if !self.scene_tile_cache.contains_key(&key) {
            let img = {
                let tile = if let Some(t) = self.raster_cache.get(&key) {
                    t
                } else {
                    let mut tile = match Pixmap::new(cw, ch) {
                        Some(p) => p,
                        None => return,
                    };
                    self.draw_text_weighted_line_height(
                        &mut tile,
                        text,
                        0.0,
                        0.0,
                        font_size,
                        color,
                        wrap_width,
                        weight,
                        line_height,
                    );
                    if self.raster_cache.len() >= RASTER_CACHE_CAP {
                        self.raster_cache.shift_remove_index(0);
                    }
                    self.raster_cache.insert(key, tile);
                    self.raster_cache.get(&key).expect("inserted above")
                };
                // peniko::Image wraps the byte buffer in a
                // Blob<Arc<Vec<u8>>>; the one-time `to_vec` here is the
                // tile's bytes (~few KB for normal text spans).
                let blob = vello::peniko::Blob::new(std::sync::Arc::new(tile.data().to_vec()));
                vello::peniko::ImageData {
                    data: blob,
                    format: vello::peniko::ImageFormat::Rgba8,
                    alpha_type: vello::peniko::ImageAlphaType::AlphaPremultiplied,
                    width: tile.width(),
                    height: tile.height(),
                }
            };
            if self.scene_tile_cache.len() >= RASTER_CACHE_CAP {
                self.scene_tile_cache.shift_remove_index(0);
            }
            self.scene_tile_cache.insert(key, img);
        }
        let img = self
            .scene_tile_cache
            .get(&key)
            .expect("inserted above")
            .clone();
        // Pixmap is already physical-pixel sized and our translate is
        // integer-aligned (`x.round()`), so nearest-neighbor sampling
        // produces a 1:1 unblurred blit. Vello's default
        // `ImageQuality::Medium` (bilinear) re-samples the already-AA
        // glyph coverage and visibly softens every line of body text.
        let brush =
            vello::peniko::ImageBrush::from(img).with_quality(vello::peniko::ImageQuality::Low);
        let transform = vello::kurbo::Affine::translate((x.round() as f64, y.round() as f64));
        scene.draw_image(&brush, transform);
    }

    /// Same surface as [`Self::draw_text_colored`], but composites a
    /// pre-rasterised pixmap from the raster cache when one exists.
    /// Cache key is `(text, font_size, color, wrap_width, scale)`;
    /// on miss, raster into a small text-sized pixmap, store, and
    /// composite. Subsequent paints of the same content become a
    /// single `draw_pixmap` instead of the full shape + per-glyph
    /// alpha blend loop.
    ///
    /// Falls back to `draw_text_colored` when the measured size
    /// rounds to zero (empty text) — no cached entry needed.
    pub fn draw_text_cached(
        &mut self,
        target: &mut Pixmap,
        text: &str,
        x: f32,
        y: f32,
        font_size: f32,
        color: Rgba,
        wrap_width: Option<f32>,
    ) {
        self.draw_text_cached_weighted(target, text, x, y, font_size, color, wrap_width, 400);
    }

    /// Same as [`Self::draw_text_cached`] but takes a CSS-style font
    /// weight (100..900). 400 is normal, 700 is bold.
    pub fn draw_text_cached_weighted(
        &mut self,
        target: &mut Pixmap,
        text: &str,
        x: f32,
        y: f32,
        font_size: f32,
        color: Rgba,
        wrap_width: Option<f32>,
        weight: u16,
    ) {
        if color.3 == 0 || text.is_empty() {
            return;
        }
        // Measure first — both the cache key and the cached pixmap
        // dimensions need it. measure() is itself cached.
        let (mw, mh) = self.measure_weighted(text, font_size, wrap_width, weight);
        let cw = mw.ceil().max(1.0) as u32;
        let ch = mh.ceil().max(1.0) as u32;
        if cw == 0 || ch == 0 {
            return;
        }

        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        text.hash(&mut hasher);
        font_size.to_bits().hash(&mut hasher);
        let color_u32 = u32::from_le_bytes([color.0, color.1, color.2, color.3]);
        color_u32.hash(&mut hasher);
        wrap_width.map(f32::to_bits).hash(&mut hasher);
        weight.hash(&mut hasher);
        self.family.hash(&mut hasher);
        (self.align as u8).hash(&mut hasher);
        cw.hash(&mut hasher);
        ch.hash(&mut hasher);
        let key = hasher.finish();

        if !self.raster_cache.contains_key(&key) {
            // Render the text into a fresh small pixmap at origin
            // (0, 0). The pixmap is sized to the measured bbox so
            // unrelated background pixels don't get cached.
            let mut tile = match Pixmap::new(cw, ch) {
                Some(p) => p,
                None => {
                    self.draw_text_weighted(
                        target, text, x, y, font_size, color, wrap_width, weight,
                    );
                    return;
                }
            };
            self.draw_text_weighted(
                &mut tile, text, 0.0, 0.0, font_size, color, wrap_width, weight,
            );
            if self.raster_cache.len() >= RASTER_CACHE_CAP {
                // FIFO single-entry eviction; wholesale clear was
                // catastrophic on text-heavy screens (every miss
                // past 512 unique tiles re-rasterised the next
                // batch in lockstep).
                self.raster_cache.shift_remove_index(0);
            }
            self.raster_cache.insert(key, tile);
        }

        let tile = self.raster_cache.get(&key).expect("inserted above");
        // Composite onto `target` at the requested origin. Integer
        // translate keeps text crisp — fractional offsets would force
        // a sampler resample and blur the glyphs.
        let transform = tiny_skia::Transform::from_translate(x.round(), y.round());
        target.draw_pixmap(
            0,
            0,
            tiny_skia::PixmapRef::from_bytes(tile.data(), tile.width(), tile.height())
                .expect("tile bytes valid"),
            &tiny_skia::PixmapPaint::default(),
            transform,
            None,
        );
    }
}

/// One laid-out visual line, for painting text decorations: the glyph
/// run's left edge and width plus its top and baseline, all relative to
/// the text origin (in the same pixel space as the font size).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LineRun {
    pub x: f32,
    pub w: f32,
    pub top: f32,
    pub baseline: f32,
}

impl TextEngine {
    /// The visual lines of `text`, laid out exactly as
    /// [`Self::draw_text_into_scene_line_height`] paints them. Backs
    /// `underline` / `line-through` / `overline`, which need each wrapped
    /// line's extent and baseline. Only decorated text asks. Cached on
    /// the same inputs as the measure cache, so a repaint does no shaping.
    pub fn line_runs(
        &mut self,
        text: &str,
        font_size: f32,
        wrap_width: Option<f32>,
        weight: u16,
        line_height: f32,
    ) -> std::sync::Arc<[LineRun]> {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        text.hash(&mut hasher);
        font_size.to_bits().hash(&mut hasher);
        wrap_width.map(f32::to_bits).hash(&mut hasher);
        weight.hash(&mut hasher);
        self.family.hash(&mut hasher);
        (self.align as u8).hash(&mut hasher);
        line_height.to_bits().hash(&mut hasher);
        let key = hasher.finish();
        if let Some(hit) = self.line_runs_cache.get(&key) {
            return std::sync::Arc::clone(hit);
        }
        let runs: std::sync::Arc<[LineRun]> = self
            .shape_line_runs(text, font_size, wrap_width, weight, line_height)
            .into();
        // FIFO single-entry eviction, like the raster cache it pairs with.
        if self.line_runs_cache.len() >= RASTER_CACHE_CAP {
            self.line_runs_cache.shift_remove_index(0);
        }
        self.line_runs_cache
            .insert(key, std::sync::Arc::clone(&runs));
        runs
    }

    fn shape_line_runs(
        &mut self,
        text: &str,
        font_size: f32,
        wrap_width: Option<f32>,
        weight: u16,
        line_height: f32,
    ) -> Vec<LineRun> {
        #[cfg(test)]
        {
            self.line_runs_shapes += 1;
        }
        let display = display_text(text, self.family.transform);
        let buffer = self.shape(&display.text, font_size, wrap_width, weight, line_height);
        let (factor, box_w) = self.line_offsets(&buffer);
        buffer
            .layout_runs()
            .filter(|run| !run.glyphs.is_empty())
            .map(|run| {
                let dx = (box_w - run.line_w).max(0.0) * factor;
                // Trailing whitespace at a soft wrap is not decorated by
                // browsers either; measure the inked glyph span.
                let x0 = run.glyphs.iter().map(|g| g.x).fold(f32::INFINITY, f32::min);
                let x1 = run
                    .glyphs
                    .iter()
                    .filter(|g| {
                        !run.text[g.start..g.end]
                            .chars()
                            .all(|c| c.is_whitespace() || c == WORD_JOINER)
                    })
                    .map(|g| g.x + g.w)
                    .fold(x0, f32::max);
                LineRun {
                    x: x0 + dx,
                    w: (x1 - x0).max(0.0),
                    top: run.line_top,
                    baseline: run.line_y,
                }
            })
            .collect()
    }

    /// Lay `text` out exactly as [`Self::draw_text_into_scene_line_height`]
    /// paints it (same font, metrics, and `Wrap::Word` policy) and
    /// return the visual lines with GLOBAL byte offsets. Backs Textarea
    /// caret / hit-test / selection geometry ([`crate::textarea`]).
    ///
    /// Not cached: only the focused (or pointer-targeted) Textarea asks,
    /// at most a few times per event / frame.
    pub fn visual_lines(
        &mut self,
        text: &str,
        font_size: f32,
        wrap_width: Option<f32>,
        weight: u16,
        line_height: f32,
    ) -> Vec<crate::textarea::VisualLine> {
        use crate::textarea::{GlyphBox, VisualLine};
        let display = display_text(text, self.family.transform);
        let buffer = self.shape(&display.text, font_size, wrap_width, weight, line_height);
        // Byte offsets below index the shaped (display) text; report
        // them in `text`'s own offsets.
        let source = |offset: usize| display.source_offset(offset);

        // Global byte offset where each paragraph (BufferLine) starts:
        // the previous paragraph's text plus its own line ending.
        let mut para_start = Vec::with_capacity(buffer.lines.len());
        let mut acc = 0usize;
        for line in &buffer.lines {
            para_start.push(acc);
            acc += line.text().len() + line.ending().as_str().len();
        }

        let mut out: Vec<VisualLine> = Vec::new();
        let mut para_of: Vec<usize> = Vec::new();
        for run in buffer.layout_runs() {
            let base = para_start.get(run.line_i).copied().unwrap_or(acc);
            let base_source = source(base);
            let mut glyphs: Vec<GlyphBox> = run
                .glyphs
                .iter()
                .map(|g| GlyphBox {
                    start: source(base + g.start),
                    end: source(base + g.end),
                    x: g.x,
                    w: g.w,
                })
                .collect();
            glyphs.sort_by(|a, b| a.x.total_cmp(&b.x));
            let same_para_prev = para_of.last() == Some(&run.line_i);
            let (start, end) = if glyphs.is_empty() {
                // Empty paragraph (or a glyph-less wrapped continuation):
                // anchor at the previous line's end within the same
                // paragraph, else at the paragraph start.
                let at = if same_para_prev {
                    out.last().map(|p: &VisualLine| p.end).unwrap_or(base_source)
                } else {
                    base_source
                };
                (at, at)
            } else {
                let lo = glyphs.iter().map(|g| g.start).min().unwrap_or(base_source);
                let hi = glyphs.iter().map(|g| g.end).max().unwrap_or(base_source);
                // The first visual line of a paragraph always starts at
                // the paragraph start.
                (if same_para_prev { lo } else { base_source.min(lo) }, hi)
            };
            out.push(VisualLine {
                start,
                end,
                top: run.line_top,
                height: run.line_height,
                para_end: true,
                glyphs,
            });
            para_of.push(run.line_i);
        }
        for i in 1..out.len() {
            if para_of[i] == para_of[i - 1] {
                out[i - 1].para_end = false;
            }
        }
        out
    }
}

impl Default for TextEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// The inherited font settings a Text is shaped with: the CSS
/// `font-family` list as authored (`"Georgia, 'Times New Roman', serif"`;
/// none = the renderer's sans-serif) plus the other inherited properties
/// that change which glyphs are shaped and where — `letter-spacing` and
/// `text-transform`. Cheap to clone (one `Arc`), and hashed into every
/// text cache key, so two Texts that differ in any of them never share a
/// measure or a glyph tile.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct FontFamily {
    list: Option<Arc<str>>,
    /// `letter-spacing` in em of the Text's own font size, as `f32` bits
    /// (so the struct stays `Eq + Hash`); `0` is `normal`.
    letter_spacing_em: u32,
    transform: TextTransform,
}

impl FontFamily {
    /// The family list a `fontFamily` prop carries; blank means default.
    pub fn from_css(list: &str) -> Self {
        let list = list.trim();
        Self {
            list: (!list.is_empty()).then(|| Arc::from(list)),
            ..Self::default()
        }
    }

    /// Whether the family list is the renderer default (sans-serif).
    pub fn is_default(&self) -> bool {
        self.list.is_none()
    }

    /// The same family with CSS `letter-spacing`, in em of the Text's
    /// font size (added after every character, like a browser).
    pub fn with_letter_spacing_em(mut self, em: f32) -> Self {
        self.letter_spacing_em = if em.is_finite() && em != 0.0 {
            em.to_bits()
        } else {
            0
        };
        self
    }

    pub fn letter_spacing_em(&self) -> f32 {
        f32::from_bits(self.letter_spacing_em)
    }

    /// The same family with CSS `text-transform`.
    pub fn with_transform(mut self, transform: TextTransform) -> Self {
        self.transform = transform;
        self
    }

    pub fn transform(&self) -> TextTransform {
        self.transform
    }
}

/// CSS `text-transform`. Applied to the shaped string only: measure,
/// draw and decorations all see the transformed text, while the content
/// (accessibility, events) keeps what the app wrote.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum TextTransform {
    #[default]
    None,
    Uppercase,
    Lowercase,
    Capitalize,
}

impl TextTransform {
    /// Parse a `textTransform` value; unknown keywords are `none`.
    pub fn from_css(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "uppercase" => Self::Uppercase,
            "lowercase" => Self::Lowercase,
            "capitalize" => Self::Capitalize,
            _ => Self::None,
        }
    }
}

/// U+2060 WORD JOINER: zero-width, default-ignorable, and a UAX #14
/// "no break" on both sides — how [`display_text`] removes a break
/// opportunity the shaper would otherwise take.
const WORD_JOINER: char = '\u{2060}';

/// The string actually shaped for `text`, with a map back to `text`'s
/// byte offsets when it differs.
struct DisplayText<'a> {
    text: Cow<'a, str>,
    /// For each byte offset of `text` (plus the end), the source offset
    /// of the character it belongs to. `None` when unchanged.
    map: Option<Vec<usize>>,
}

impl DisplayText<'_> {
    fn source_offset(&self, offset: usize) -> usize {
        match &self.map {
            None => offset,
            Some(map) => map.get(offset).copied().unwrap_or_else(|| *map.last().unwrap_or(&0)),
        }
    }
}

/// Apply `text-transform`, then narrow the UAX #14 line-break
/// opportunities to the ones a browser takes.
///
/// Chrome does not break between two printable ASCII characters except
/// after a hyphen or a question mark: `https://x.com/SpaceX/status/…`
/// stays one unbreakable word and overflows, where plain UAX #14 (what
/// cosmic-text implements) breaks after every `/`, `!`, `}` before a
/// letter. Each such opportunity gets a [`WORD_JOINER`].
fn display_text(text: &str, transform: TextTransform) -> DisplayText<'_> {
    // 1. text-transform, char by char with each output char's source.
    let mut chars: Option<Vec<(char, usize)>> = None;
    match transform {
        TextTransform::None => {}
        TextTransform::Uppercase | TextTransform::Lowercase => {
            let upper = transform == TextTransform::Uppercase;
            let mut out = Vec::with_capacity(text.len());
            for (at, c) in text.char_indices() {
                if upper {
                    out.extend(c.to_uppercase().map(|u| (u, at)));
                } else {
                    out.extend(c.to_lowercase().map(|l| (l, at)));
                }
            }
            chars = Some(out);
        }
        TextTransform::Capitalize => {
            // The first letter of each word. Like a browser's word
            // segmentation, an apostrophe between letters (`O'Neil`) and
            // a leading digit (`3rd`) keep the word going; a hyphen,
            // space or bracket starts a new one.
            let mut out = Vec::with_capacity(text.len());
            let mut prev: Option<char> = None;
            let mut before_prev: Option<char> = None;
            for (at, c) in text.char_indices() {
                let in_word = match prev {
                    Some(p) if p.is_alphanumeric() => true,
                    Some('\'' | '\u{2019}') => before_prev.is_some_and(char::is_alphanumeric),
                    _ => false,
                };
                if c.is_alphabetic() && !in_word {
                    out.extend(c.to_uppercase().map(|u| (u, at)));
                } else {
                    out.push((c, at));
                }
                before_prev = prev;
                prev = Some(c);
            }
            chars = Some(out);
        }
    }
    let transformed: Cow<'_, str> = match &chars {
        None => Cow::Borrowed(text),
        Some(chars) => Cow::Owned(chars.iter().map(|(c, _)| *c).collect()),
    };

    // 2. Break opportunities between printable ASCII characters.
    let needs_tailoring = transformed
        .bytes()
        .any(|b| b.is_ascii_punctuation() && b != b'-' && b != b'?');
    let mut joins: Vec<usize> = Vec::new();
    if needs_tailoring {
        let bytes = transformed.as_bytes();
        for (at, opportunity) in unicode_linebreak::linebreaks(&transformed) {
            if opportunity != unicode_linebreak::BreakOpportunity::Allowed
                || at == 0
                || at >= bytes.len()
            {
                continue;
            }
            let (before, after) = (bytes[at - 1], bytes[at]);
            if before.is_ascii_graphic()
                && after.is_ascii_graphic()
                && before != b'-'
                && before != b'?'
            {
                joins.push(at);
            }
        }
    }

    if chars.is_none() && joins.is_empty() {
        return DisplayText {
            text: Cow::Borrowed(text),
            map: None,
        };
    }
    // Rebuild with the joiners and the byte map.
    let sources: Vec<(char, usize)> =
        chars.unwrap_or_else(|| text.char_indices().map(|(at, c)| (c, at)).collect());
    let mut out = String::with_capacity(transformed.len() + joins.len() * 3);
    let mut map = Vec::with_capacity(out.capacity() + 1);
    let mut joins = joins.into_iter().peekable();
    let mut shaped_at = 0usize;
    for (c, source) in sources {
        if joins.peek() == Some(&shaped_at) {
            joins.next();
            out.push(WORD_JOINER);
            map.extend(std::iter::repeat_n(source, WORD_JOINER.len_utf8()));
        }
        out.push(c);
        map.extend(std::iter::repeat_n(source, c.len_utf8()));
        shaped_at += c.len_utf8();
    }
    map.push(text.len());
    DisplayText {
        text: Cow::Owned(out),
        map: Some(map),
    }
}

/// The byte ranges of `text` to shape with the colour-emoji face, or
/// `None` when there are none: clusters with default emoji presentation
/// (😂), a text-default emoji followed by VS16 (`❤️`), keycaps,
/// regional-indicator flags, and what attaches to them (skin-tone
/// modifiers, ZWJ sequences, tag sequences). VS15 keeps text style.
fn emoji_ranges(text: &str) -> Option<Vec<std::ops::Range<usize>>> {
    use icu_properties::props::{
        Emoji, EmojiModifier, EmojiPresentation, ExtendedPictographic, RegionalIndicator,
    };
    use icu_properties::CodePointSetData;
    // Fast path: no emoji below U+00A9, and most UI text is ASCII.
    if text.bytes().all(|b| b < 0x80) && !text.contains('\u{20E3}') {
        return None;
    }
    let presentation = CodePointSetData::new::<EmojiPresentation>();
    let emoji = CodePointSetData::new::<Emoji>();
    let modifier = CodePointSetData::new::<EmojiModifier>();
    let pictographic = CodePointSetData::new::<ExtendedPictographic>();
    let regional = CodePointSetData::new::<RegionalIndicator>();

    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut ranges: Vec<std::ops::Range<usize>> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let (start, c) = chars[i];
        let next = chars.get(i + 1).map(|&(_, n)| n);
        let starts_emoji = if regional.contains(c) {
            true
        } else if next == Some('\u{FE0E}') {
            false
        } else if next == Some('\u{20E3}') || next == Some('\u{FE0F}') {
            emoji.contains(c)
        } else {
            presentation.contains(c)
        };
        if !starts_emoji {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        if regional.contains(c) && chars.get(j).is_some_and(|&(_, n)| regional.contains(n)) {
            j += 1; // a flag is a pair
        }
        loop {
            match chars.get(j).map(|&(_, n)| n) {
                Some(n)
                    if n == '\u{FE0F}'
                        || n == '\u{20E3}'
                        || modifier.contains(n)
                        || ('\u{E0020}'..='\u{E007F}').contains(&n) =>
                {
                    j += 1;
                }
                Some('\u{200D}')
                    if chars
                        .get(j + 1)
                        .is_some_and(|&(_, n)| pictographic.contains(n)) =>
                {
                    j += 2;
                }
                _ => break,
            }
        }
        let end = chars.get(j).map_or(text.len(), |&(at, _)| at);
        match ranges.last_mut() {
            Some(last) if last.end == start => last.end = end,
            _ => ranges.push(start..end),
        }
        i = j;
    }
    Some(ranges)
}

/// The installed colour-emoji family (the face a browser's emoji
/// fallback uses), if any.
fn emoji_family() -> Option<&'static str> {
    static FAMILY: OnceLock<Option<Arc<str>>> = OnceLock::new();
    FAMILY
        .get_or_init(|| {
            [
                "Noto Color Emoji",
                "Apple Color Emoji",
                "Segoe UI Emoji",
                "Twemoji",
                "Twitter Color Emoji",
                "JoyPixels",
                "EmojiOne Color",
            ]
            .into_iter()
            .find_map(|name| installed_family(system_font_db(), name))
        })
        .as_deref()
}

/// Blend one rasterised glyph into `pixmap` with its top-left at
/// `(left, top)`. `color` is straight-alpha; its alpha scales the glyph
/// coverage (and a colour glyph's own alpha), as a browser applies
/// `color: rgba(…)` / `opacity` to text.
fn blit_glyph(
    pixmap: &mut Pixmap,
    left: i32,
    top: i32,
    image: &cosmic_text::SwashImage,
    color: Rgba,
) {
    let width = image.placement.width as i32;
    let height = image.placement.height as i32;
    let pixmap_w = pixmap.width() as i32;
    let pixmap_h = pixmap.height() as i32;
    let pixels = pixmap.pixels_mut();
    let color_alpha = color.3 as u32;
    for gy in 0..height {
        let py = top + gy;
        if py < 0 || py >= pixmap_h {
            continue;
        }
        for gx in 0..width {
            let px = left + gx;
            if px < 0 || px >= pixmap_w {
                continue;
            }
            let i = (gy * width + gx) as usize;
            let (r, g, b, coverage) = match image.content {
                SwashContent::Mask => (color.0, color.1, color.2, image.data[i] as u32),
                SwashContent::SubpixelMask => {
                    let px = &image.data[i * 4..i * 4 + 4];
                    let avg = (px[0] as u32 + px[1] as u32 + px[2] as u32) / 3;
                    (color.0, color.1, color.2, avg)
                }
                SwashContent::Color => {
                    let px = &image.data[i * 4..i * 4 + 4];
                    (px[0], px[1], px[2], px[3] as u32)
                }
            };
            let sa = coverage * color_alpha / 255;
            if sa == 0 {
                continue;
            }
            let inv_sa = 255 - sa;
            let dst = &mut pixels[(py * pixmap_w + px) as usize];
            let nr = ((r as u32 * sa + dst.red() as u32 * inv_sa) / 255) as u8;
            let ng = ((g as u32 * sa + dst.green() as u32 * inv_sa) / 255) as u8;
            let nb = ((b as u32 * sa + dst.blue() as u32 * inv_sa) / 255) as u8;
            let na = (sa + (dst.alpha() as u32 * inv_sa) / 255) as u8;
            *dst = tiny_skia::PremultipliedColorU8::from_rgba(nr, ng, nb, na).unwrap_or(*dst);
        }
    }
}

/// CSS generic families (plus the `system-ui` / `ui-*` keywords), each
/// mapped to the face family the font database is configured with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GenericFamily {
    Serif,
    SansSerif,
    Monospace,
    Cursive,
    Fantasy,
    /// `system-ui`: the platform's UI font, which is not the browser's
    /// `sans-serif` — on Linux Chrome draws `system-ui` in the
    /// fontconfig default (DejaVu Sans) but `sans-serif` in Arial's
    /// metric twin (Liberation Sans).
    SystemUi,
}

impl GenericFamily {
    fn from_css(name: &str) -> Option<Self> {
        Some(match name.to_ascii_lowercase().as_str() {
            "serif" | "ui-serif" => Self::Serif,
            "sans-serif" => Self::SansSerif,
            "system-ui" | "ui-sans-serif" | "ui-rounded" => Self::SystemUi,
            // Apple's system-font keywords name nothing elsewhere: a
            // browser on Linux / Windows skips them like any missing
            // family and goes on down the list.
            "-apple-system" | "blinkmacsystemfont" if cfg!(target_os = "macos") => {
                Self::SystemUi
            }
            "monospace" | "ui-monospace" => Self::Monospace,
            "cursive" => Self::Cursive,
            "fantasy" => Self::Fantasy,
            _ => return None,
        })
    }
}

/// The face family a generic keyword draws in here (see
/// [`scan_system_fonts`] for the per-platform choices).
fn generic_face_family(generic: GenericFamily) -> Arc<str> {
    static FAMILIES: OnceLock<[Arc<str>; 6]> = OnceLock::new();
    let families = FAMILIES.get_or_init(|| {
        let db = system_font_db();
        let name = |family: fontdb::Family| Arc::from(db.family_name(&family));
        [
            name(fontdb::Family::Serif),
            name(fontdb::Family::SansSerif),
            name(fontdb::Family::Monospace),
            name(fontdb::Family::Cursive),
            name(fontdb::Family::Fantasy),
            Arc::from(system_ui_family(db)),
        ]
    });
    Arc::clone(&families[generic as usize])
}

/// The face CSS font matching (CSS Fonts 4 §5.2) picks in `family` for
/// a requested `weight`, as the weight to shape at: the exact weight if
/// the family has it; for 400–500 the nearest up to 500, then lighter,
/// then heavier; below 400 lighter first; above 500 heavier first. So
/// `600` in a regular/bold family is the bold face (what Chrome draws)
/// and `300` in Liberation Sans is the regular face, not a fallback
/// family. A variable face covering the weight keeps it as asked.
fn css_matched_weight(db: &fontdb::Database, family: &str, weight: u16) -> u16 {
    let mut upright = Vec::new();
    let mut any = Vec::new();
    for face in db
        .faces()
        .filter(|face| face.families.iter().any(|(name, _)| name.eq_ignore_ascii_case(family)))
    {
        if face_is_variable(db, face.id) {
            return weight;
        }
        any.push(face.weight.0);
        if face.style == fontdb::Style::Normal {
            upright.push(face.weight.0);
        }
    }
    let weights = if upright.is_empty() { any } else { upright };
    css_pick_weight(&weights, weight).unwrap_or(weight)
}

fn css_pick_weight(weights: &[u16], desired: u16) -> Option<u16> {
    if weights.contains(&desired) {
        return Some(desired);
    }
    let lighter = || weights.iter().copied().filter(|&w| w < desired).max();
    let heavier = || weights.iter().copied().filter(|&w| w > desired).min();
    if (400..=500).contains(&desired) {
        weights
            .iter()
            .copied()
            .filter(|&w| w > desired && w <= 500)
            .min()
            .or_else(lighter)
            .or_else(heavier)
    } else if desired < 400 {
        lighter().or_else(heavier)
    } else {
        heavier().or_else(lighter)
    }
}

/// Whether the face has an `fvar` table (a variable font).
fn face_is_variable(db: &fontdb::Database, id: fontdb::ID) -> bool {
    db.with_face_data(id, |data, index| {
        let read_u32 = |at: usize| {
            data.get(at..at + 4)
                .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
        };
        // A collection lists one offset table per face.
        let table_dir = if data.get(0..4) == Some(b"ttcf") {
            read_u32(12 + 4 * index as usize)? as usize
        } else {
            0
        };
        let count = data
            .get(table_dir + 4..table_dir + 6)
            .map(|b| u16::from_be_bytes([b[0], b[1]]))? as usize;
        Some((0..count).any(|i| {
            let record = table_dir + 12 + 16 * i;
            data.get(record..record + 4) == Some(b"fvar")
        }))
    })
    .flatten()
    .unwrap_or(false)
}

/// What a [`FontFamily`] list resolved to on this host: the first entry
/// that names an installed family, or a generic keyword.
#[derive(Clone, Debug, PartialEq, Eq)]
enum ResolvedFamily {
    Generic(GenericFamily),
    Named(Arc<str>),
}

/// Resolve a CSS family list the way a browser walks it: entries in
/// order, the first installed family (or generic keyword) wins, and a
/// list where nothing matches falls back to the default sans-serif.
/// cosmic-text itself takes one family and substitutes its own default
/// for a missing name, which would turn `"Georgia, serif"` into sans on
/// any host without Georgia.
fn resolve_family_list(list: &str, db: &fontdb::Database) -> ResolvedFamily {
    for entry in list.split(',') {
        let name = entry.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        if name.is_empty() {
            continue;
        }
        if let Some(generic) = GenericFamily::from_css(name) {
            return ResolvedFamily::Generic(generic);
        }
        let candidates =
            std::iter::once(name).chain(metric_compatible_aliases(name).iter().copied());
        for candidate in candidates {
            if let Some(found) = installed_family(db, candidate) {
                return ResolvedFamily::Named(found);
            }
        }
    }
    ResolvedFamily::Generic(GenericFamily::SansSerif)
}

/// The installed spelling of family `name` (case-insensitive), if any.
fn installed_family(db: &fontdb::Database, name: &str) -> Option<Arc<str>> {
    db.faces()
        .flat_map(|face| face.families.iter())
        .find(|(family, _)| family.eq_ignore_ascii_case(name))
        .map(|(family, _)| Arc::from(family.as_str()))
}

/// Metric-compatible open substitutes for the web's core fonts, the
/// same ones fontconfig aliases them to on Linux (which is what Chrome
/// draws there): `Arial` lays out like `Liberation Sans` / `Arimo`.
fn metric_compatible_aliases(name: &str) -> &'static [&'static str] {
    match name.to_ascii_lowercase().as_str() {
        "arial" | "helvetica" | "helvetica neue" => &["Liberation Sans", "Arimo"],
        "times new roman" | "times" => &["Liberation Serif", "Tinos"],
        "courier new" | "courier" => &["Liberation Mono", "Cousine"],
        "georgia" => &["Gelasio"],
        _ => &[],
    }
}

/// The OS-vendor font index (see [`scan_system_fonts`]), built once per
/// process. Every window's `FontSystem` starts from a clone of it, and
/// SVG text rendering shares its faces ([`svg_font_db`]) — the font
/// directories are walked and the face tables parsed exactly once.
fn system_font_db() -> &'static fontdb::Database {
    static DB: OnceLock<fontdb::Database> = OnceLock::new();
    DB.get_or_init(scan_system_fonts)
}

/// The system faces as a database for resvg's text layer. resvg links
/// fontdb 0.24 while cosmic-text links 0.23, so the database can't be
/// passed as-is, but the face records can: they are copied over (file
/// paths and already-mapped font bytes are shared, nothing is read or
/// parsed again), together with the generic-family choices, so an SVG's
/// `font-family="Georgia, serif"` / `font-weight="700"` picks the same
/// faces the renderer's own text does.
///
/// Only these faces are visible to an SVG: usvg never loads system or
/// `@font-face` fonts on its own, so an image source still can't make
/// the renderer read anything beyond the fonts it already indexed.
pub(crate) fn svg_font_db() -> Arc<resvg::usvg::fontdb::Database> {
    static DB: OnceLock<Arc<resvg::usvg::fontdb::Database>> = OnceLock::new();
    Arc::clone(DB.get_or_init(|| Arc::new(convert_for_svg(system_font_db()))))
}

fn convert_for_svg(src: &fontdb::Database) -> resvg::usvg::fontdb::Database {
    use resvg::usvg::fontdb as svg;
    let mut db = svg::Database::new();
    for face in src.faces() {
        let source = match &face.source {
            fontdb::Source::Binary(data) => svg::Source::Binary(Arc::clone(data)),
            fontdb::Source::File(path) => svg::Source::File(path.clone()),
            fontdb::Source::SharedFile(_, data) => svg::Source::Binary(Arc::clone(data)),
        };
        db.push_face_info(svg::FaceInfo {
            id: svg::ID::dummy(),
            source,
            index: face.index,
            // fontdb 0.24 vendors its own copy of the `Language` /
            // `Width` enums. Names are matched language-agnostically;
            // only the English (US) tag, which fontdb lists first, has a
            // role (it marks the canonical name), so it is the one kept.
            families: face
                .families
                .iter()
                .map(|(name, lang)| {
                    let lang = if *lang == fontdb::Language::English_UnitedStates {
                        svg::Language::English_UnitedStates
                    } else {
                        svg::Language::Unknown
                    };
                    (name.clone(), lang)
                })
                .collect(),
            post_script_name: face.post_script_name.clone(),
            style: match face.style {
                fontdb::Style::Normal => svg::Style::Normal,
                fontdb::Style::Italic => svg::Style::Italic,
                fontdb::Style::Oblique => svg::Style::Oblique,
            },
            weight: svg::Weight(face.weight.0),
            stretch: match face.stretch {
                fontdb::Stretch::UltraCondensed => svg::Stretch::UltraCondensed,
                fontdb::Stretch::ExtraCondensed => svg::Stretch::ExtraCondensed,
                fontdb::Stretch::Condensed => svg::Stretch::Condensed,
                fontdb::Stretch::SemiCondensed => svg::Stretch::SemiCondensed,
                fontdb::Stretch::Normal => svg::Stretch::Normal,
                fontdb::Stretch::SemiExpanded => svg::Stretch::SemiExpanded,
                fontdb::Stretch::Expanded => svg::Stretch::Expanded,
                fontdb::Stretch::ExtraExpanded => svg::Stretch::ExtraExpanded,
                fontdb::Stretch::UltraExpanded => svg::Stretch::UltraExpanded,
            },
            monospaced: face.monospaced,
        });
    }
    db.set_serif_family(src.family_name(&fontdb::Family::Serif));
    db.set_sans_serif_family(src.family_name(&fontdb::Family::SansSerif));
    db.set_monospace_family(src.family_name(&fontdb::Family::Monospace));
    db.set_cursive_family(src.family_name(&fontdb::Family::Cursive));
    db.set_fantasy_family(src.family_name(&fontdb::Family::Fantasy));
    db
}

/// The installed spelling of the first of `names` the database has.
fn first_installed(db: &fontdb::Database, names: &[&str]) -> Option<Arc<str>> {
    names.iter().find_map(|name| installed_family(db, name))
}

/// The family `system-ui` draws in. On Linux that is the fontconfig
/// default sans face — DejaVu Sans on the common distros (Noto Sans on
/// some), which is what Chrome uses for `system-ui` there — not the
/// Arial-compatible face `sans-serif` gets. Elsewhere the platform UI
/// face is the configured sans-serif.
fn system_ui_family(db: &fontdb::Database) -> Arc<str> {
    let sans = || Arc::from(db.family_name(&fontdb::Family::SansSerif));
    if cfg!(target_os = "linux") {
        first_installed(db, &["DejaVu Sans", "Noto Sans"]).unwrap_or_else(sans)
    } else {
        sans()
    }
}

fn build_slim_font_system() -> FontSystem {
    let locale = sys_locale::get_locale().unwrap_or_else(|| "en-US".to_string());
    FontSystem::new_with_locale_and_db(locale, system_font_db().clone())
}

/// Index the fonts in the platform-provided system font directories —
/// explicitly *not* walking user-installed font dirs. This is the
/// database every `FontSystem` (and SVG text) is built on.
///
/// `cosmic_text::FontSystem::new()` calls `fontdb::Database::load_system_fonts()`,
/// which on macOS recurses into `/Library/Fonts`, `/System/Library/Fonts`,
/// AND `~/Library/Fonts` (and `/Network/Library/Fonts`). The user-fonts
/// directory often carries tens of MB worth of resident font metadata
/// + mmapped file pages once we touch them — power users with design
/// software installed have 200+ fonts indexed for no benefit to a
/// dev-tooling / chat / feed renderer that asks for `sans-serif` and
/// gets it from the system default.
///
/// We load only the OS-vendor directories and skip user / network /
/// third-party (`/Library/Fonts/` on macOS — App Store font installers
/// drop here) sources. The family aliases mirror cosmic-text's own
/// defaults logic so `Family::SansSerif` etc. resolve to a real font
/// on every supported platform.
fn scan_system_fonts() -> fontdb::Database {
    let mut db = fontdb::Database::new();

    #[cfg(target_os = "macos")]
    {
        // Core San-Francisco system fonts + emoji live here.
        db.load_fonts_dir("/System/Library/Fonts/");
        // CJK + accented-Latin alternates live here. Metadata-only
        // index pass; the actual font bytes only get mmapped when a
        // glyph from the face is shaped.
        db.load_fonts_dir("/System/Library/Fonts/Supplemental/");
        db.set_sans_serif_family("Helvetica");
        db.set_serif_family("Times New Roman");
        db.set_monospace_family("Menlo");
        db.set_cursive_family("Apple Chancery");
        db.set_fantasy_family("Papyrus");
    }
    #[cfg(target_os = "linux")]
    {
        db.load_fonts_dir("/usr/share/fonts/");
        db.load_fonts_dir("/usr/local/share/fonts/");
        // Chrome's generic families on Linux, which is what the web
        // renderer draws: `sans-serif` / `serif` default to Arial / Times
        // New Roman, which fontconfig substitutes with their
        // metric-compatible twins; `monospace` is fontconfig's monospace
        // (DejaVu Sans Mono on most distros); `cursive` / `fantasy` use
        // Comic Sans / Impact when installed and otherwise fall back to
        // the standard (serif) font. Matching the faces, not just the
        // style, keeps line widths — and so wrapping and ellipsis — the
        // same as the browser's. DejaVu is the last resort for each.
        let sans = first_installed(
            &db,
            &["Liberation Sans", "Arimo", "Arial", "DejaVu Sans", "Noto Sans"],
        );
        let serif = first_installed(
            &db,
            &["Liberation Serif", "Tinos", "Times New Roman", "DejaVu Serif", "Noto Serif"],
        );
        let mono = first_installed(
            &db,
            &["DejaVu Sans Mono", "Liberation Mono", "Cousine", "Noto Sans Mono"],
        );
        if let Some(sans) = &sans {
            db.set_sans_serif_family(sans.as_ref());
        } else {
            db.set_sans_serif_family("DejaVu Sans");
        }
        let serif = serif.unwrap_or_else(|| Arc::from("DejaVu Serif"));
        db.set_serif_family(serif.as_ref());
        db.set_monospace_family(mono.as_deref().unwrap_or("DejaVu Sans Mono"));
        let cursive = first_installed(&db, &["Comic Sans MS"]);
        db.set_cursive_family(cursive.as_deref().unwrap_or(&serif));
        let fantasy = first_installed(&db, &["Impact"]);
        db.set_fantasy_family(fantasy.as_deref().unwrap_or(&serif));
    }
    #[cfg(target_os = "windows")]
    {
        let dir = std::env::var("SYSTEMROOT")
            .map(|d| format!("{d}\\Fonts"))
            .unwrap_or_else(|_| "C:\\Windows\\Fonts".to_string());
        db.load_fonts_dir(dir);
        db.set_sans_serif_family("Segoe UI");
        db.set_serif_family("Times New Roman");
        db.set_monospace_family("Consolas");
        db.set_cursive_family("Comic Sans MS");
        db.set_fantasy_family("Impact");
    }

    // Defensive: an empty index means cosmic-text's PlatformFallback
    // has nothing to fall back to — every render would log a missing-
    // font warning. Fall back to the full system load so the
    // renderer keeps painting (and we surface the path mismatch in
    // logs for a future fix).
    if db.is_empty() {
        log::warn!(
            "slim font db: no fonts found in OS-vendor dirs; falling back to full system load"
        );
        db.load_system_fonts();
    }

    log::debug!("slim font db: indexed {} font faces", db.len());

    db
}

#[cfg(test)]
mod tests {
    use super::TextEngine;
    use crate::style::Rgba;
    use tiny_skia::Pixmap;

    #[test]
    fn draw_text_cached_matches_uncached_pixels() {
        // Cache hit must produce visually identical output to the
        // uncached path. Render the same text twice via
        // `draw_text_cached` (second call hits the cache) and compare
        // to a third render via `draw_text_colored` directly.
        let mut t = TextEngine::new();
        let mut a = Pixmap::new(64, 32).unwrap();
        let mut b = Pixmap::new(64, 32).unwrap();
        a.fill(tiny_skia::Color::WHITE);
        b.fill(tiny_skia::Color::WHITE);
        // First call → cache miss, populates entry.
        t.draw_text_cached(&mut a, "Hi", 0.0, 0.0, 18.0, Rgba(0, 0, 0, 0xff), None);
        // Reference render via the direct path.
        t.draw_text_colored(&mut b, "Hi", 0.0, 0.0, 18.0, Rgba(0, 0, 0, 0xff), None);
        assert_eq!(
            a.data(),
            b.data(),
            "cached miss-render should match uncached"
        );

        // Second call → cache hit, must still match.
        let mut c = Pixmap::new(64, 32).unwrap();
        c.fill(tiny_skia::Color::WHITE);
        t.draw_text_cached(&mut c, "Hi", 0.0, 0.0, 18.0, Rgba(0, 0, 0, 0xff), None);
        assert_eq!(a.data(), c.data(), "cached hit-render should match miss");
    }

    #[test]
    fn draw_text_cached_zero_alpha_is_noop() {
        // Defensive: matches `draw_text_colored`'s short-circuit for
        // `Rgba::TRANSPARENT` so the cache never stores a pixmap that
        // can't be observed.
        let mut t = TextEngine::new();
        let mut pm = Pixmap::new(32, 16).unwrap();
        pm.fill(tiny_skia::Color::WHITE);
        let before = pm.data().to_vec();
        t.draw_text_cached(&mut pm, "Hi", 0.0, 0.0, 18.0, Rgba::TRANSPARENT, None);
        assert_eq!(
            pm.data(),
            before.as_slice(),
            "transparent draw must not mutate"
        );
    }

    #[test]
    fn draw_text_cached_empty_text_is_noop() {
        let mut t = TextEngine::new();
        let mut pm = Pixmap::new(32, 16).unwrap();
        pm.fill(tiny_skia::Color::WHITE);
        let before = pm.data().to_vec();
        t.draw_text_cached(&mut pm, "", 0.0, 0.0, 18.0, Rgba(0, 0, 0, 0xff), None);
        assert_eq!(pm.data(), before.as_slice(), "empty text must not mutate");
    }

    #[test]
    fn measure_unwrapped_returns_single_line_height() {
        let mut t = TextEngine::new();
        let (w, h) = t.measure("hello world hello world", 18.0, None);
        assert!(w > 0.0);
        // Without wrap, height should match a single line + descenders —
        // generously bound at 2x the metric height.
        assert!(
            h <= 18.0 * 2.6,
            "single-line height should not exceed 2x font-size, got {h}"
        );
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

    // ---- font-family ---------------------------------------------

    use super::{
        resolve_family_list, svg_font_db, system_font_db, FontFamily, GenericFamily, ResolvedFamily,
    };

    #[test]
    fn family_list_falls_through_missing_names_to_its_generic() {
        // No faces at all: every named family is missing, so the list's
        // generic keyword decides — never the renderer default.
        let empty = fontdb::Database::new();
        let serif = ResolvedFamily::Generic(GenericFamily::Serif);
        assert_eq!(
            resolve_family_list(
                "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
                &empty
            ),
            serif
        );
        assert_eq!(
            resolve_family_list("\"Nope\" , ui-monospace", &empty),
            ResolvedFamily::Generic(GenericFamily::Monospace)
        );
        // `system-ui` is its own generic (the platform UI face), not
        // `sans-serif` — Chrome on Linux draws the two in different faces.
        assert_eq!(
            resolve_family_list("system-ui,-apple-system,Segoe UI,sans-serif", &empty),
            ResolvedFamily::Generic(GenericFamily::SystemUi)
        );
        // Apple's keywords only mean the system font on macOS; elsewhere
        // a browser skips them like any missing name.
        if !cfg!(target_os = "macos") {
            assert_eq!(
                resolve_family_list("-apple-system, BlinkMacSystemFont, serif", &empty),
                ResolvedFamily::Generic(GenericFamily::Serif)
            );
        }
        // Nothing matches and no generic: CSS falls back to the default.
        assert_eq!(
            resolve_family_list("Nope", &empty),
            ResolvedFamily::Generic(GenericFamily::SansSerif)
        );
        assert!(FontFamily::from_css("  ").is_default());
    }

    #[test]
    fn tailwind_family_lists_resolve_to_their_generic() {
        // `font-sans` / `font-serif` / `font-mono` as tailwind-parse
        // expands them: the leading `ui-*` keyword decides on every host,
        // installed fonts or not.
        let empty = fontdb::Database::new();
        for db in [&empty, system_font_db()] {
            assert_eq!(
                resolve_family_list("ui-serif, Georgia, serif", db),
                ResolvedFamily::Generic(GenericFamily::Serif)
            );
            assert_eq!(
                resolve_family_list("ui-monospace, monospace", db),
                ResolvedFamily::Generic(GenericFamily::Monospace)
            );
            assert_eq!(
                resolve_family_list("ui-sans-serif, system-ui, sans-serif", db),
                ResolvedFamily::Generic(GenericFamily::SystemUi)
            );
        }
    }

    #[test]
    fn family_list_picks_the_first_installed_family() {
        let db = system_font_db();
        let Some(installed) = db.faces().next().map(|f| f.families[0].0.clone()) else {
            return; // fontless host: nothing to resolve to
        };
        let list = format!("NoSuchFamily, '{}', serif", installed.to_ascii_uppercase());
        assert_eq!(
            resolve_family_list(&list, db),
            ResolvedFamily::Named(installed.as_str().into())
        );
    }

    #[test]
    fn serif_family_measures_and_caches_apart_from_the_default() {
        let mut t = TextEngine::new();
        let text = "The Daily Hypen — Wikipedia's front page";
        let sans = t.measure_weighted(text, 32.0, None, 700);
        let serif_family = FontFamily::from_css("Georgia, 'Times New Roman', serif");
        let serif = t.with_family(&serif_family, |t| t.measure_weighted(text, 32.0, None, 700));
        assert_ne!(
            sans, serif,
            "a serif face must not reuse the sans measure / shaping"
        );
        // The scope ends with the default restored, and the cache keeps
        // both answers apart.
        assert_eq!(t.measure_weighted(text, 32.0, None, 700), sans);
        assert_eq!(
            t.with_family(&serif_family, |t| t.measure_weighted(text, 32.0, None, 700)),
            serif
        );
    }

    #[test]
    fn svg_font_db_is_the_renderer_font_index() {
        let ours = system_font_db();
        let svg = svg_font_db();
        assert_eq!(
            svg.len(),
            ours.len(),
            "every system face is visible to SVG text, nothing more"
        );
        assert_eq!(
            svg.family_name(&resvg::usvg::fontdb::Family::Serif),
            ours.family_name(&fontdb::Family::Serif)
        );
        assert!(std::sync::Arc::ptr_eq(&svg, &svg_font_db()), "built once");
    }
    // ---- browser-parity shaping -------------------------------------

    use super::{
        css_pick_weight, display_text, emoji_ranges, installed_family, TextTransform,
        WORD_JOINER,
    };
    use crate::layout::TextAlign;

    #[test]
    fn css_weight_matching_follows_the_css_fonts_algorithm() {
        let regular_bold = [400, 700];
        // Heavier-than-500 requests go up first: 600 is the bold face.
        assert_eq!(css_pick_weight(&regular_bold, 600), Some(700));
        assert_eq!(css_pick_weight(&regular_bold, 800), Some(700));
        // Light requests go down first, then up: Liberation Sans has no
        // light face, so 300 is the regular one (what Chrome draws).
        assert_eq!(css_pick_weight(&regular_bold, 300), Some(400));
        // DejaVu Sans ships ExtraLight (200): 300 takes it, like Chrome.
        assert_eq!(css_pick_weight(&[200, 400, 700], 300), Some(200));
        // 400–500 try up to 500, then lighter, then heavier.
        assert_eq!(css_pick_weight(&[300, 500, 700], 400), Some(500));
        assert_eq!(css_pick_weight(&[300, 700], 450), Some(300));
        assert_eq!(css_pick_weight(&[700], 500), Some(700));
        assert_eq!(css_pick_weight(&[], 400), None);
    }

    #[test]
    fn text_transform_reshapes_the_display_string_only() {
        let up = display_text("Sunday, november 15", TextTransform::Uppercase);
        assert_eq!(up.text, "SUNDAY, NOVEMBER 15");
        let low = display_text("English", TextTransform::Lowercase);
        assert_eq!(low.text, "english");
        // Chrome's word starts: a hyphen or quote starts a word, an
        // apostrophe inside one and a leading digit do not.
        let cap = display_text(
            "hello world-wide e-mail o'neil 3rd 'quoted' (paren)",
            TextTransform::Capitalize,
        );
        assert_eq!(cap.text, "Hello World-Wide E-Mail O'neil 3rd 'Quoted' (Paren)");
        // Offsets map back onto the source even when a char expands.
        let sharp = display_text("aßb", TextTransform::Uppercase);
        assert_eq!(sharp.text, "ASSB");
        assert_eq!(sharp.source_offset(1), 1);
        assert_eq!(sharp.source_offset(2), 1);
        assert_eq!(sharp.source_offset(3), 3);
        assert_eq!(sharp.source_offset(4), 4);
        assert!(display_text("plain", TextTransform::None).map.is_none());
    }

    #[test]
    fn urls_keep_the_browsers_line_break_opportunities() {
        let joined = display_text(
            "https://x.com/SpaceX/status/21213 and a-b c?d",
            TextTransform::None,
        );
        // No opportunity after `/` (or anywhere else inside the URL)…
        let url_end = joined.text.find(" and").unwrap();
        for (at, _) in unicode_linebreak::linebreaks(&joined.text) {
            assert!(
                at == 0 || at > url_end,
                "break inside the URL at {at}: {:?}",
                &joined.text[..at]
            );
        }
        // …but the hyphen and question-mark breaks Chrome takes survive.
        let breaks: Vec<usize> = unicode_linebreak::linebreaks(&joined.text)
            .map(|(at, _)| at)
            .collect();
        let after = |needle: &str| joined.text.find(needle).unwrap() + needle.len();
        assert!(breaks.contains(&after("a-")), "{breaks:?}");
        assert!(breaks.contains(&after("c?")), "{breaks:?}");
        assert!(joined.text.contains(WORD_JOINER));
        // Plain prose is shaped as written.
        assert!(display_text("Hello, world. Fine!", TextTransform::None).map.is_none());
    }

    #[test]
    fn a_url_wider_than_the_box_overflows_instead_of_breaking_at_slashes() {
        let mut t = TextEngine::new();
        let url = "https://x.com/SpaceX/status/2121316300702056595";
        let (one_line_w, one_line_h) = t.measure(url, 16.0, None);
        let (w, h) = t.measure(url, 16.0, Some(one_line_w * 0.6));
        assert_eq!(h, one_line_h, "the URL must stay on one line");
        assert_eq!(w, one_line_w);
    }

    #[test]
    fn emoji_clusters_are_found_for_the_colour_face() {
        assert_eq!(emoji_ranges("plain ascii"), None);
        let text = "Nice \u{2764}\u{FE0F} \u{1F602} \u{1F44D}\u{1F3FD} ok \u{1F1EC}\u{1F1E7} 1\u{FE0F}\u{20E3} \u{2764}\u{FE0E} \u{1F469}\u{200D}\u{1F4BB}";
        let ranges = emoji_ranges(text).unwrap();
        let picked: Vec<&str> = ranges.iter().map(|r| &text[r.clone()]).collect();
        assert_eq!(picked, ["\u{2764}\u{FE0F}", "\u{1F602}", "\u{1F44D}\u{1F3FD}", "\u{1F1EC}\u{1F1E7}", "1\u{FE0F}\u{20E3}", "\u{1F469}\u{200D}\u{1F4BB}"]);
    }

    #[test]
    fn colour_emoji_render_in_colour_even_when_a_text_face_has_them() {
        if super::emoji_family().is_none() {
            return; // no colour-emoji font on this host
        }
        let mut t = TextEngine::new();
        for emoji in ["\u{1F602}", "\u{2764}\u{FE0F}", "\u{1F62E}", "\u{1F622}", "\u{1F44D}"] {
            let mut pm = Pixmap::new(64, 64).unwrap();
            t.draw_text_colored(&mut pm, emoji, 4.0, 4.0, 32.0, Rgba::BLACK, None);
            let coloured = pm
                .pixels()
                .iter()
                .filter(|p| p.alpha() > 0)
                .any(|p| p.red() != p.green() || p.green() != p.blue());
            assert!(coloured, "{emoji} drew without colour");
        }
    }

    #[test]
    fn text_colour_alpha_scales_glyph_coverage() {
        let mut t = TextEngine::new();
        let draw = |t: &mut TextEngine, alpha: u8| {
            let mut pm = Pixmap::new(120, 40).unwrap();
            t.draw_text_colored(&mut pm, "×", 4.0, 4.0, 30.0, Rgba(255, 255, 255, alpha), None);
            pm.pixels().iter().map(|p| p.alpha()).max().unwrap()
        };
        assert_eq!(draw(&mut t, 255), 255);
        let half = draw(&mut t, 128);
        assert!((120..=135).contains(&half), "rgba(…, 0.5) text drew at alpha {half}");
    }

    #[test]
    fn letter_spacing_adds_to_every_character() {
        let mut t = TextEngine::new();
        let text = "FORECAST";
        let (plain, _) = t.measure(text, 20.0, None);
        let spaced_family = FontFamily::default().with_letter_spacing_em(0.1);
        let (spaced, _) = t.with_family(&spaced_family, |t| t.measure(text, 20.0, None));
        let expected = plain + 8.0 * 2.0;
        assert!(
            (spaced - expected).abs() <= 1.0,
            "0.1em at 20px over 8 chars: {plain} → {spaced}, want ≈{expected}"
        );
    }

    #[test]
    fn wrapped_centred_lines_are_centred_one_by_one() {
        let mut t = TextEngine::new();
        let text = "a much longer first line\nshort";
        let start = t.line_runs(text, 16.0, None, 400, 16.0);
        assert_eq!(start.len(), 2);
        assert_eq!(start[1].x, 0.0, "start-aligned lines sit flush left");
        let outer = t.replace_align(TextAlign::Center);
        let centred = t.line_runs(text, 16.0, None, 400, 16.0);
        let end = {
            t.replace_align(TextAlign::End);
            t.line_runs(text, 16.0, None, 400, 16.0)
        };
        t.replace_align(outer);
        let widest = start[0].w;
        let short = start[1].w;
        assert!((centred[0].x - 0.0).abs() < 0.5);
        assert!(
            (centred[1].x - (widest - short) / 2.0).abs() < 1.0,
            "short line centred: x={} for widths {widest}/{short}",
            centred[1].x
        );
        assert!((end[1].x + end[1].w - (end[0].x + end[0].w)).abs() < 1.0);
        // Painting honours the same offsets.
        let mut left = Pixmap::new(400, 40).unwrap();
        let mut mid = Pixmap::new(400, 40).unwrap();
        t.draw_text_colored(&mut left, text, 0.0, 0.0, 16.0, Rgba::BLACK, None);
        t.replace_align(TextAlign::Center);
        t.draw_text_colored(&mut mid, text, 0.0, 0.0, 16.0, Rgba::BLACK, None);
        t.replace_align(TextAlign::Start);
        let first_ink = |pm: &Pixmap, row_from: u32| {
            (0..pm.width())
                .find(|&x| (row_from..pm.height()).any(|y| pm.pixel(x, y).unwrap().alpha() > 0))
                .unwrap()
        };
        assert!(first_ink(&mid, 20) > first_ink(&left, 20) + 10);
    }

    #[test]
    fn a_weight_the_family_lacks_keeps_the_family() {
        // `fontWeight(600)` on a regular/bold serif: the bold serif face,
        // never a fallback sans (cosmic-text only takes exact weights).
        let mut t = TextEngine::new();
        let serif = FontFamily::from_css("Georgia, 'Times New Roman', serif");
        let text = "Things That Turbo Pascal Is Smaller Than";
        let (w600, w700) = t.with_family(&serif, |t| {
            (
                t.measure_weighted(text, 16.0, None, 600),
                t.measure_weighted(text, 16.0, None, 700),
            )
        });
        let face = super::generic_face_family(super::GenericFamily::Serif);
        let weights: Vec<u16> = system_font_db()
            .faces()
            .filter(|f| f.families.iter().any(|(n, _)| n.as_str() == &*face))
            .map(|f| f.weight.0)
            .collect();
        if weights.contains(&700) && !weights.contains(&600) {
            assert_eq!(w600, w700);
        }
    }

    #[test]
    fn generic_sans_serif_matches_chromes_linux_face_and_widths() {
        // Chrome on Linux draws `sans-serif` in Arial's metric twin; with
        // it installed, a 16px line measures what Chrome measured on the
        // same host (160.98 px for this string).
        let db = system_font_db();
        if !cfg!(target_os = "linux") || installed_family(db, "Liberation Sans").is_none() {
            return;
        }
        assert_eq!(
            db.family_name(&fontdb::Family::SansSerif),
            "Liberation Sans"
        );
        let mut t = TextEngine::new();
        let (w, _) = t.measure("Hamburgefonstiv 0123", 16.0, None);
        assert!((w - 161.0).abs() <= 1.0, "width {w}");
        if installed_family(db, "DejaVu Sans").is_some() {
            // `system-ui` is the fontconfig default (DejaVu Sans): 183.36.
            let ui = FontFamily::from_css("system-ui");
            let (w, _) = t.with_family(&ui, |t| t.measure("Hamburgefonstiv 0123", 16.0, None));
            assert!((w - 184.0).abs() <= 1.0, "system-ui width {w}");
            // …and its 300 is the ExtraLight face, like Chrome (also 183.36).
            let (w, _) = t.with_family(&ui, |t| {
                t.measure_weighted("Hamburgefonstiv 0123", 16.0, None, 300)
            });
            assert!((w - 184.0).abs() <= 1.0, "system-ui light width {w}");
        }
    }
}
