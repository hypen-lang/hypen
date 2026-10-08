//! Vello-backed painter.
//!
//! Walks a [`LayoutPass`](crate::layout::LayoutPass) and encodes the
//! visible items into a [`vello::Scene`]. The GPU compute / render
//! passes that follow live in [`crate::gpu::Gpu::present`].
//!
//! Reuses every layout-side optimisation we built for the CPU path:
//! emit-time viewport cull, hover / press / focus interaction state,
//! damage-aware item iteration. The text / icon / image raster
//! caches that lived on `CpuPainter` move into this painter as
//! Vello-flavoured equivalents — pre-rasterised glyph runs become
//! cached `vello::Scene` fragments that can be appended to the
//! frame Scene with a transform, instead of pre-rasterised
//! `tiny_skia::Pixmap`s.

use crate::layout::{ItemKind, LayoutPass, Rect as LayoutRect, TextAlign};
use crate::style::{
    BorderLineStyle, Rgba, BORDER_SIDES_ALL, BORDER_SIDE_BOTTOM, BORDER_SIDE_LEFT,
    BORDER_SIDE_RIGHT, BORDER_SIDE_TOP,
};
use crate::text::TextEngine;
use crate::window::Selection;
use std::collections::HashMap;
use vello::kurbo::{Affine, BezPath, Cap, Join, Rect as KRect, RoundedRect, Shape, Stroke};
use vello::peniko::{Brush, Color, Fill};
use vello::Scene;

/// Per-frame interaction state mirrored from `App`. Same shape as
/// `crate::paint::cpu::InteractionState` so the painter swap stays
/// transparent to `window.rs`.
#[derive(Default)]
pub struct InteractionState {
    pub hovered: std::collections::HashSet<String>,
    pub pressed: std::collections::HashSet<String>,
    pub focused: Option<String>,
    /// `true` when the current focus arrived via the keyboard (Tab) and
    /// so should show a focus ring — the `:focus-visible` rule. Mouse
    /// clicks focus without setting this, so clicking a button / tile
    /// doesn't stamp a blue ring on it (the press feedback is enough).
    pub focus_visible: bool,
    pub input_selections: HashMap<String, Selection>,
    pub ime_preedit: Option<(String, String)>,
    /// Per-Textarea inner scroll offset (physical px), mirrored from
    /// `App`. Absent → 0.
    pub textarea_scroll: HashMap<String, f32>,
}

/// One cached encoded scene for a single subtree (e.g. one Post in the
/// feed, one cell in the Search grid). Stored on the painter, replayed
/// across frames whenever nothing inside the subtree changed.
struct CachedSubtree {
    /// Encoded Vello scene fragment for the subtree's items. Built
    /// once on cache miss, appended to the frame scene on subsequent
    /// hits with a translation that accounts for scroll-fast-path
    /// y-shifts of the items.
    scene: Scene,
    /// `rect.y` of the first item in the subtree at the moment we
    /// encoded this fragment. On hit, the current first item's
    /// `rect.y` is compared against this and the diff becomes the
    /// translation argument to `scene.append` — that lets the scroll
    /// fast-path (which uniformly shifts every item's y by the wheel
    /// delta) reuse the cached encoding without re-painting it.
    origin_y: f32,
    /// Outer clip rect (the scrollable ancestor's rect) at encode
    /// time. The cached scene itself is encoded WITHOUT the outer
    /// clip layer — clip is pushed in the main scene around the
    /// `append` call so the clip stays fixed in viewport space
    /// while items inside translate with scroll.
    clip_to: Option<LayoutRect>,
    /// Radius of `clip_to` in physical pixels. Stored with the cached
    /// fragment because changing a clipping ancestor's radius changes the
    /// pixels even when the descendant scene itself is unchanged.
    clip_radius: f32,
    /// Renderer node ids of every item encoded into this fragment.
    /// Backs [`VelloPainter::invalidate_subtrees_containing`]: a
    /// paint-only patch batch drops exactly the entries whose id set
    /// intersects the affected nodes instead of the whole cache.
    item_ids: Vec<String>,
    /// Image sources this fragment asked for and did NOT get while it
    /// was being encoded (still fetching, or failed): every one of
    /// them drew nothing. The fragment is exact until one of them
    /// resolves, so an image landing anywhere else in the page leaves
    /// it alone — see the image-load check in `build_scene`. Empty for
    /// the overwhelming majority of fragments (bitmap-bearing items are
    /// painted outside the cache; only a Video poster reaches here).
    awaiting_images: Vec<String>,
    /// Digest of the geometry the fragment was encoded for (every
    /// item's rect, clip and transform, relative to the first item's
    /// y). A fragment that survived a structural batch
    /// (`invalidate_structural`) must match this against the new
    /// layout before it replays — see `validated_epoch`.
    geometry: u64,
    /// The `VelloPainter::structural_epoch` this fragment's geometry was
    /// last confirmed for. Equal to the painter's: trusted. Behind it: a
    /// structural batch landed since, so the next hit re-digests the
    /// current items and either re-confirms or misses.
    validated_epoch: u64,
    /// The first item's cumulative transform at encode time. The
    /// splice-on-hit is a pure y-translate, which is only valid when
    /// the CURRENT transform is that translate's conjugation of this
    /// one — true for page scroll (everything shifts) and for
    /// container scroll under translate-only ancestry, false the
    /// moment a non-shifting ancestor (the scrolled container itself
    /// included) carries `scale`/`rotate`, where content really moves
    /// `s·dy`, not `dy`. The hit branch checks the conjugation and
    /// misses (re-encodes) when it doesn't hold — self-validating,
    /// instead of guessing from tree shape.
    transform: crate::layout::Affine2,
}

pub struct VelloPainter {
    text: TextEngine,
    interaction: InteractionState,
    /// Persistent scene we rebuild each frame. Held on the painter
    /// so the `Vec<u8>` encoding storage Vello allocates can be
    /// reused frame-to-frame instead of re-allocating.
    scene: Scene,
    /// Painter-side scene cache, keyed by a hash of
    /// `(subtree_root_id, interaction_state_within_subtree)`. Each
    /// entry stores a previously-encoded Vello scene fragment for
    /// one subtree (a Post in the feed, a cell in the Search grid).
    /// On cache hit we splice the fragment into the frame scene with
    /// a translation that picks up the scroll fast-path's y-shift —
    /// no re-encoding of glyphs, images, paths.
    ///
    /// Invalidated wholesale by `invalidate_subtree_cache()` (called
    /// whenever `tree_generation` bumps), by `clear_image_cache()`
    /// for symmetry, and by viewport size changes inside
    /// `build_scene`. Per-key invalidation is implicit in the key
    /// composition: hover / press / focus transitions change the
    /// key and miss the cache for exactly the affected subtree.
    subtree_cache: indexmap::IndexMap<u64, CachedSubtree>,
    /// Last viewport size we built a scene for; viewport change drops
    /// the entire cache (rects, scrollbar positioning, etc. all change).
    last_viewport: Option<(u32, u32)>,
    /// Last `crate::paint::image::image_load_generation()` we saw at
    /// build time. The image worker bumps that counter every time it
    /// resolves a fetch (loaded or failed). When the painter sees a
    /// new value here, any cached subtree that encoded its images
    /// under the previous generation might have rendered "nothing"
    /// because the source wasn't ready — we drop the cache so the
    /// next paint re-encodes with the now-available bitmap. Without
    /// this, images on the social feed were stuck invisible until
    /// the user resized the window (which dropped the cache as a
    /// side-effect of the viewport change).
    last_image_load_gen: u64,
    /// Sources `draw_image` (or the Video poster path) looked up and
    /// missed while the current subtree fragment was being encoded.
    /// Cleared at the start of a cache-miss encode and moved into the
    /// new `CachedSubtree::awaiting_images` at its end; pushes outside
    /// an encode are discarded by the next clear.
    encoding_awaits: Vec<String>,
    /// Bumped by every `invalidate_structural`. Fragments stamped with
    /// an older epoch re-validate their geometry on their next hit,
    /// whenever that is — a fragment that scrolled off before the batch
    /// and back in three frames later still gets checked.
    structural_epoch: u64,
    /// Renderer node ids the drag-and-drop runtime wants painted LAST
    /// (the lifted item and its subtree — `DesktopDnd::raised_ids`), so
    /// the ghost floats above its siblings while it is dragged / held.
    /// Empty in the overwhelmingly common no-drag frame, where the
    /// cached-subtree paint path runs untouched; a non-empty set paints
    /// every item individually (the drag frame invalidates the fragment
    /// cache anyway) with the raised ids deferred to a final pass.
    raised: std::collections::HashSet<String>,
    /// Hit / miss telemetry for tests and ad-hoc profiling. Reset by
    /// `invalidate_subtree_cache`. Not used in production logic.
    #[cfg(test)]
    subtree_cache_hits: u64,
    #[cfg(test)]
    subtree_cache_misses: u64,
    /// Decoded source-bitmap cache, keyed by `src` URL only. The
    /// stored `peniko::ImageData` wraps the full SOURCE pixmap
    /// (source width/height, no fit/radius/size-specific processing).
    /// Per-draw size, fit and rounded-corner clipping are expressed
    /// via the `Affine` transform and a clip layer in `draw_image`,
    /// so the same cached source bitmap is reused for every rect
    /// that references it — a w-14 avatar and a w-7 thumbnail of the
    /// same URL share one entry. Vello scales at draw time via the
    /// transform. `peniko::ImageData` shares its RGBA bytes via
    /// `Blob`, so cache hits are zero-copy.
    ///
    /// Cap controls "distinct source URLs in flight". At ~4 MB per
    /// decoded 1080px image, 128 entries ≈ a ~500 MB ceiling — about
    /// half the old 256-entry cap because each entry now holds the
    /// full source (previously the cap also had to absorb
    /// `(src, w, h, fit, radius)` duplicates which no longer exist).
    image_cache: indexmap::IndexMap<String, vello::peniko::ImageData>,
    /// Preformatted once-per-second native metrics label. Feature-gated so
    /// production painters retain no field, branch, or paint work.
    #[cfg(feature = "dev-overlay")]
    dev_overlay: Option<(String, f32)>,
    /// Device host UI (consent dialogs, capture panel, chooser, activity
    /// indicators): painted after everything else, see
    /// `crate::device::overlay`.
    device_overlay: Option<std::sync::Arc<crate::device::overlay::OverlayLayout>>,
}

const IMAGE_CACHE_CAP: usize = 128;
/// Subtree-scene cache cap. Each entry holds one encoded Vello
/// fragment per subtree — for a 30-post feed, that's ~30 entries; the
/// cap leaves headroom for nav between routes (Search grid cells +
/// Profile thumbnails + feed posts all keep their entries). FIFO
/// `shift_remove_index(0)` eviction — not LRU, since nothing here
/// re-inserts on a hit, which also makes insertion order the closest
/// available proxy for recency.
const SUBTREE_CACHE_CAP: usize = 256;

impl VelloPainter {
    pub fn new() -> Self {
        Self {
            text: TextEngine::new(),
            interaction: InteractionState::default(),
            scene: Scene::new(),
            image_cache: indexmap::IndexMap::new(),
            subtree_cache: indexmap::IndexMap::new(),
            last_viewport: None,
            last_image_load_gen: 0,
            encoding_awaits: Vec::new(),
            structural_epoch: 0,
            #[cfg(feature = "dev-overlay")]
            dev_overlay: None,
            device_overlay: None,
            raised: std::collections::HashSet::new(),
            #[cfg(test)]
            subtree_cache_hits: 0,
            #[cfg(test)]
            subtree_cache_misses: 0,
        }
    }

    /// Drop every cached subtree fragment. Called from `App::redraw`'s
    /// patch-flush path whenever `tree_generation` increments — any
    /// patch in the batch may have changed something inside one of the
    /// cached subtrees, and the cheapest correct invalidation is "drop
    /// it all, let the next frame rebuild fragments that are still
    /// visible." The image / text caches are unaffected; those are
    /// keyed by content, not by scene shape.
    pub fn invalidate_subtree_cache(&mut self) {
        self.subtree_cache.clear();
        #[cfg(test)]
        {
            self.subtree_cache_hits = 0;
            self.subtree_cache_misses = 0;
        }
    }

    /// Scoped alternative to [`VelloPainter::invalidate_subtree_cache`]
    /// for batches that only rewrote paint props (no structural patch,
    /// no layout-affecting prop): drop exactly the cached fragments
    /// that encoded one of the `affected` nodes and keep the rest.
    /// The caller is responsible for the safety precondition — every
    /// retained fragment's items must be geometrically identical after
    /// the batch (see `paint_only_affected_ids` in `window.rs`), which
    /// holds because paint-only props feed neither Taffy styles nor
    /// item rects. `affected` must already include descendants of the
    /// patched nodes (opacity / transforms inherit downward).
    pub fn invalidate_subtrees_containing(&mut self, affected: &std::collections::HashSet<String>) {
        if affected.is_empty() {
            return;
        }
        self.subtree_cache
            .retain(|_, entry| !entry.item_ids.iter().any(|id| affected.contains(id)));
    }

    /// A structural batch landed (`window::structural_fragment_invalidation`
    /// decided what it touched): drop the fragments that encoded one of
    /// `dropped`, keep every other fragment, and require each survivor
    /// to re-prove its geometry against the new layout before it
    /// replays. Rects can shift anywhere after a structural change (a
    /// removed sibling moves everything below it); a survivor whose
    /// items still sit where they did relative to one another replays
    /// through the usual y-translate, one whose geometry changed misses
    /// and re-encodes.
    pub fn invalidate_structural(&mut self, dropped: &std::collections::HashSet<String>) {
        if !dropped.is_empty() {
            self.subtree_cache
                .retain(|_, entry| !entry.item_ids.iter().any(|id| dropped.contains(id)));
        }
        self.structural_epoch = self.structural_epoch.wrapping_add(1);
    }

    #[cfg(test)]
    pub(crate) fn subtree_cache_hits(&self) -> u64 {
        self.subtree_cache_hits
    }

    #[cfg(test)]
    pub(crate) fn subtree_cache_misses(&self) -> u64 {
        self.subtree_cache_misses
    }

    #[cfg(test)]
    pub(crate) fn subtree_cache_len(&self) -> usize {
        self.subtree_cache.len()
    }

    pub fn text_engine_mut(&mut self) -> &mut TextEngine {
        &mut self.text
    }

    /// Replace the set of node ids painted last (the drag-and-drop
    /// ghost subtree). Pass an empty set when no drag is lifted.
    pub fn set_raised(&mut self, ids: std::collections::HashSet<String>) {
        self.raised = ids;
    }

    pub fn interaction_mut(&mut self) -> &mut InteractionState {
        &mut self.interaction
    }

    #[cfg(feature = "dev-overlay")]
    pub(crate) fn set_dev_overlay(&mut self, label: &str, top: f32) {
        match self.dev_overlay.as_mut() {
            Some((current, current_top)) => {
                if current != label {
                    current.clear();
                    current.push_str(label);
                }
                *current_top = top;
            }
            None => self.dev_overlay = Some((label.into(), top)),
        }
    }

    /// The device overlay for the next scenes (`None` = nothing shown).
    pub(crate) fn set_device_overlay(
        &mut self,
        overlay: Option<std::sync::Arc<crate::device::overlay::OverlayLayout>>,
    ) {
        self.device_overlay = overlay;
    }

    /// Reset and rebuild the scene from the given layout. Returns a
    /// borrow of the encoded scene; caller passes it to
    /// `Gpu::present`. The scene's storage is reused across frames.
    pub fn build_scene(
        &mut self,
        layout: &LayoutPass,
        viewport: (u32, u32),
        scale_factor: f32,
        scroll_y: f32,
    ) -> &Scene {
        let _ = scroll_y; // already baked into item rects by emit_items
        self.scene.reset();

        // Viewport-size change invalidates every cached subtree:
        // their item rects, clip rects, and aspect-ratio-driven inner
        // sizes all need re-emitting. Cheaper to drop the cache than
        // to detect partial validity.
        if self.last_viewport != Some(viewport) {
            self.subtree_cache.clear();
            self.last_viewport = Some(viewport);
        }
        // Image worker landed one or more fetches since the last
        // build. A subtree whose images were `Loading` at encode time
        // rendered nothing for that Image, so it must re-encode with
        // the now-loaded bitmap — but ONLY that subtree. Each fragment
        // remembers the sources it missed (`awaiting_images`); one
        // whose list is empty, or whose awaited sources are all still
        // unloaded, is exact and stays. Dropping everything here used
        // to make one thumbnail landing in a 600-post feed re-encode
        // every visible card. The cheap monotonic check keeps the
        // steady-state hot path (no fetches in flight) free of cost:
        // AtomicU64 load + integer compare.
        let load_gen = crate::paint::image::image_load_generation();
        if load_gen != self.last_image_load_gen {
            self.subtree_cache.retain(|_, entry| {
                !entry
                    .awaiting_images
                    .iter()
                    .any(|src| crate::paint::image::loaded_source(src).is_some())
            });
            self.last_image_load_gen = load_gen;
        }

        let viewport_rect = LayoutRect {
            x: 0.0,
            y: 0.0,
            w: viewport.0 as f32,
            h: viewport.1 as f32,
        };
        // Slice the items list into contiguous runs that share a
        // `subtree_root`. Items with `subtree_root = None` (no
        // scrollable ancestor — headers, BottomNav, the search bar
        // Row) draw directly with no caching. Items with `Some(id)`
        // group with their neighbours sharing the same id and go
        // through `paint_subtree` for cache lookup.
        let items = &layout.items;
        if !self.raised.is_empty() {
            // Drag-and-drop ghost frame: paint everything but the raised
            // subtree in order, then the raised items on top. Bypasses
            // the fragment cache for this frame only — a lifted drag
            // moves transforms every frame, so the cache has no hits to
            // offer here anyway.
            let mut deferred: Vec<&crate::layout::LayoutItem> = Vec::new();
            for item in items.iter() {
                if self.raised.contains(&item.node_id) {
                    deferred.push(item);
                    continue;
                }
                if rects_intersect(item.visual_rect(), viewport_rect) {
                    self.draw_item(item, scale_factor);
                }
            }
            for item in deferred {
                if rects_intersect(item.visual_rect(), viewport_rect) {
                    self.draw_item(item, scale_factor);
                }
            }
        }
        let mut i = if self.raised.is_empty() { 0 } else { items.len() };
        while i < items.len() {
            match items[i].subtree_root.as_deref() {
                None => {
                    // Cull against the VISUAL rect (transform-aware
                    // AABB) — a transformed item paints where its
                    // transform puts it, not where Taffy laid it out.
                    if rects_intersect(items[i].visual_rect(), viewport_rect) {
                        self.draw_item(&items[i], scale_factor);
                    }
                    i += 1;
                }
                Some(root_id) => {
                    let start = i;
                    let mut end = i + 1;
                    while end < items.len() && items[end].subtree_root.as_deref() == Some(root_id) {
                        end += 1;
                    }
                    self.paint_subtree(&items[start..end], root_id, scale_factor, viewport_rect);
                    i = end;
                }
            }
        }
        // Page-level scrollbar. Only drawn when page-scroll is the
        // *active* scroll model: i.e. content overflows the viewport
        // AND no per-container `.scrollable(...)` claims the overflow.
        // When a scrollable descendant exists, wheel events route to
        // that container (see `App::redraw`'s `hit_scrollable` path)
        // and `scroll_y` stays at 0 — leaving an unmoving thumb in
        // the corner is just noise. Per-container scrollbars are
        // their own future feature; this gate at least stops the
        // ghost page scrollbar showing on Search / Profile / feed.
        let viewport_h = viewport.1 as f32;
        let content_h = layout.content_size.1;
        let page_scroll_active = content_h > viewport_h && layout.scrollable_ids.is_empty();
        if page_scroll_active {
            let track_w = 4.0 * scale_factor;
            let track_x = viewport.0 as f32 - track_w - 2.0 * scale_factor;
            let visible_frac = (viewport_h / content_h).clamp(0.05, 1.0);
            let thumb_h = (viewport_h * visible_frac).max(20.0 * scale_factor);
            // scroll_y here is read off the layout — items have it baked.
            // Approximate from content_h - bottom-most item's rect.y.
            let max_scroll = (content_h - viewport_h).max(1.0);
            let progress = (scroll_y / max_scroll).clamp(0.0, 1.0);
            let thumb_y = progress * (viewport_h - thumb_h);
            self.scene.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                Color::from_rgba8(0x80, 0x80, 0x80, 0x80),
                None,
                &KRect::new(
                    track_x as f64,
                    thumb_y as f64,
                    (track_x + track_w) as f64,
                    (thumb_y + thumb_h) as f64,
                ),
            );
        }
        #[cfg(feature = "dev-overlay")]
        self.draw_dev_overlay(viewport, scale_factor);
        self.draw_device_overlay();
        &self.scene
    }

    /// The device host UI, above the app and the dev HUD: app content can
    /// neither cover nor restyle it.
    fn draw_device_overlay(&mut self) {
        use crate::device::overlay::DrawOp;
        let Some(overlay) = self.device_overlay.clone() else {
            return;
        };
        for op in &overlay.ops {
            match op {
                DrawOp::Fill {
                    rect,
                    color,
                    radius,
                } => fill_rect(&mut self.scene, *rect, *color, *radius),
                DrawOp::Stroke {
                    rect,
                    color,
                    radius,
                    width,
                } => stroke_rect(&mut self.scene, *rect, *color, *radius, *width),
                DrawOp::Text {
                    x,
                    y,
                    text,
                    size,
                    weight,
                    color,
                    wrap,
                } => {
                    self.text.draw_text_into_scene_line_height(
                        &mut self.scene,
                        text,
                        *x,
                        *y,
                        *size,
                        *color,
                        *wrap,
                        *weight,
                        *size * 1.2,
                    );
                }
                DrawOp::Image { rect, frame } => self.draw_preview_frame(*rect, frame),
            }
        }
    }

    /// A camera preview frame, contain-fitted into `rect` (the caller filled
    /// the letterbox).
    fn draw_preview_frame(&mut self, rect: LayoutRect, frame: &crate::device::ui::PreviewFrame) {
        use vello::peniko::{Blob, ImageAlphaType, ImageData, ImageFormat};
        if frame.width == 0
            || frame.height == 0
            || rect.w <= 0.0
            || rect.h <= 0.0
            || frame.rgba.len() < frame.width as usize * frame.height as usize * 4
        {
            return;
        }
        let img = ImageData {
            data: Blob::new(frame.rgba.clone()),
            format: ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::AlphaPremultiplied,
            width: frame.width,
            height: frame.height,
        };
        let s = (rect.w / frame.width as f32).min(rect.h / frame.height as f32);
        let dx = rect.x as f64 + ((rect.w - frame.width as f32 * s) * 0.5) as f64;
        let dy = rect.y as f64 + ((rect.h - frame.height as f32 * s) * 0.5) as f64;
        let transform = Affine::translate((dx, dy)).pre_scale(s as f64);
        self.scene.draw_image(&img, transform);
    }

    /// Paint after every Hypen item and scrollbar, making this a true native
    /// overlay that cannot be reordered, clipped, or scrolled by app content.
    #[cfg(feature = "dev-overlay")]
    fn draw_dev_overlay(&mut self, viewport: (u32, u32), scale_factor: f32) {
        let Some((label, top)) = self.dev_overlay.clone() else {
            return;
        };
        let font_size = 11.0 * scale_factor;
        let line_height = 14.0 * scale_factor;
        let pad_x = 7.0 * scale_factor;
        let pad_y = 3.0 * scale_factor;
        let right = 8.0 * scale_factor;
        let (text_w, _) =
            self.text
                .measure_weighted_line_height(&label, font_size, None, 600, line_height);
        let rect = LayoutRect {
            x: (viewport.0 as f32 - text_w - pad_x * 2.0 - right).max(0.0),
            y: top * scale_factor,
            w: text_w + pad_x * 2.0,
            h: line_height + pad_y * 2.0,
        };
        fill_rect(
            &mut self.scene,
            rect,
            Rgba(0x12, 0x14, 0x18, 0xe6),
            6.0 * scale_factor,
        );
        self.text.draw_text_into_scene_line_height(
            &mut self.scene,
            &label,
            rect.x + pad_x,
            rect.y + pad_y,
            font_size,
            Rgba(0xf8, 0xfa, 0xfc, 0xff),
            None,
            600,
            line_height,
        );
    }

    /// Drop cached image tiles when memory pressure or a scene reset
    /// is desired. The cache auto-evicts at capacity FIFO-style; this
    /// is for tests / explicit teardown.
    pub fn clear_image_cache(&mut self) {
        self.image_cache.clear();
        self.subtree_cache.clear();
    }

    /// Test-only accessor for the per-painter image cache size. Used
    /// to assert that draws of the same `src` at different rect sizes
    /// share a single entry rather than duplicating the source bitmap.
    #[cfg(test)]
    pub(crate) fn image_cache_len(&self) -> usize {
        self.image_cache.len()
    }

    /// Paint a contiguous slice of items that share one `subtree_root`,
    /// going through the scene cache where possible.
    ///
    /// **Cache key.** `(root_id, item ids in order, per-item
    /// interaction state)`. Membership is in the key because the cull
    /// can emit a subtree partially (a card taller than the cull
    /// buffer) — a fragment encoded from a partial slice must miss
    /// once the culled descendants scroll back in. Anything else that
    /// changes appearance (props, layout) bumps `tree_generation`,
    /// which `App::redraw` follows with an invalidation.
    ///
    /// **Translation.** Cached fragments store the `rect.y` of their
    /// first item at encode time. On hit, `current_origin_y -
    /// cached_origin_y` gives the y-delta the scroll fast-path
    /// applied; we splice the cached scene with `Affine::translate`
    /// so the cached encoding stays valid through a wheel burst.
    ///
    /// **Clipping.** The outer clip (the scrollable ancestor's rect)
    /// is fixed in viewport space — it does NOT shift with scroll.
    /// If we encoded it into the cached scene, the translate would
    /// move it incorrectly. So we encode the cached scene WITHOUT
    /// the outer clip layer, and push/pop the clip on the main
    /// scene around the `append`. Items still keep their own inner
    /// clip layers (text truncate) inside the cached scene — those
    /// shift with the items, which is correct.
    fn paint_subtree(
        &mut self,
        items: &[crate::layout::LayoutItem],
        root_id: &str,
        scale_factor: f32,
        viewport_rect: LayoutRect,
    ) {
        if items.is_empty() {
            return;
        }
        // Off-screen subtree: skip entirely. Cheaper than a cache
        // miss + encode of the empty case. Uses the union of the
        // subtree's clip_to (or a bbox of items as a fallback) to
        // decide visibility.
        let subtree_bbox = subtree_bounding_rect(items);
        if !rects_intersect(subtree_bbox, viewport_rect) {
            return;
        }

        // Vello applies Scene::append's transform to encoded path/glyph
        // transforms, but replaying mixed image fragments has proven unsafe in
        // the live renderer: bitmap and card geometry can separate during a
        // retained scroll. Keep bitmap-bearing items on the direct path while
        // still caching the vector/text runs around them. This preserves paint
        // order (surface -> image -> labels) and avoids the old all-or-nothing
        // fallback that re-encoded the entire card on every wheel frame.
        let mut vector_start = 0;
        for (index, item) in items.iter().enumerate() {
            if !item_has_bitmap(item) {
                continue;
            }
            if vector_start < index {
                self.paint_cached_subtree_fragment(
                    &items[vector_start..index],
                    root_id,
                    scale_factor,
                );
            }
            let pushed = push_outer_clip(&mut self.scene, item.clip_to, item.clip_radius);
            self.draw_item_no_outer_clip(item, scale_factor, item.clip_to, item.clip_radius);
            if pushed {
                self.scene.pop_layer();
            }
            vector_start = index + 1;
        }
        if vector_start < items.len() {
            self.paint_cached_subtree_fragment(&items[vector_start..], root_id, scale_factor);
        }
    }

    /// Cache/replay a bitmap-free contiguous run from one scroll subtree.
    /// Membership is already part of the key, so multiple runs from the same
    /// root cannot alias one another.
    fn paint_cached_subtree_fragment(
        &mut self,
        items: &[crate::layout::LayoutItem],
        root_id: &str,
        scale_factor: f32,
    ) {
        if items.is_empty() {
            return;
        }

        let key = subtree_cache_key(root_id, items, &self.interaction);
        let outer_clip = items[0].clip_to;
        let outer_clip_radius = items[0].clip_radius;
        let current_origin_y = items[0].rect.y;

        // Cache lookup. `self.subtree_cache` and `self.scene` are
        // disjoint fields, so Rust's borrow checker is happy with one
        // immutable borrow of the cache + one mutable borrow of the
        // scene simultaneously — no `unsafe`, no clone, no re-lookup.
        // The trick is to NOT route the append through a helper
        // method on `self` (that would mutably borrow ALL of self
        // and break the disjointness). We inline the push/append/
        // pop here instead.
        if let Some(cached) = self.subtree_cache.get_mut(&key) {
            let dy = current_origin_y - cached.origin_y;
            // A structural batch landed since this fragment was last
            // confirmed: the items may have moved relative to one
            // another, so re-digest them before trusting the replay.
            let geometry_holds = cached.validated_epoch == self.structural_epoch || {
                let holds = cached.geometry == fragment_geometry_digest(items);
                if holds {
                    cached.validated_epoch = self.structural_epoch;
                }
                holds
            };
            // Splice validity: the y-translate replay is exact iff the
            // first item's current cumulative transform is the cached
            // one conjugated by that translate (see
            // `CachedSubtree::transform`). Non-shifting transformed
            // ancestry — a scaled scrolled container, a rotated
            // wrapper — fails this and re-encodes instead of
            // mispainting. Identity (the overwhelming case) passes
            // trivially: conjugating identity is identity.
            let splice_valid = items[0]
                .transform
                .approx_eq(&cached.transform.conjugate_translate(0.0, dy), 1e-3);
            if geometry_holds
                && cached.clip_to == outer_clip
                && cached.clip_radius == outer_clip_radius
                && splice_valid
            {
                // Split-borrow: `cached.scene` reads `self.subtree_cache`,
                // `self.scene` is the disjoint mut target.
                let pushed = push_outer_clip(&mut self.scene, outer_clip, outer_clip_radius);
                self.scene
                    .append(&cached.scene, Some(Affine::translate((0.0, dy as f64))));
                if pushed {
                    self.scene.pop_layer();
                }
                #[cfg(test)]
                {
                    self.subtree_cache_hits += 1;
                }
                return;
            }
        }

        // Miss: encode a fresh sub-scene with the items, store it,
        // then append into the main scene under the outer clip.
        // mem::replace lets us redirect `draw_item`'s writes (which
        // always go through `self.scene`) into a private scene
        // without refactoring every draw helper to take a Scene
        // parameter — swap, draw, swap back.
        let prev_scene = std::mem::replace(&mut self.scene, Scene::new());
        self.encoding_awaits.clear();
        for item in items {
            self.draw_item_no_outer_clip(item, scale_factor, outer_clip, outer_clip_radius);
        }
        let sub_scene = std::mem::replace(&mut self.scene, prev_scene);
        let awaiting_images = std::mem::take(&mut self.encoding_awaits);

        // A same-key miss (splice-invalid re-encode of an existing
        // entry) replaces in place — evicting first would drop an
        // innocent oldest entry and net `len = CAP − 1`.
        if !self.subtree_cache.contains_key(&key) && self.subtree_cache.len() >= SUBTREE_CACHE_CAP {
            self.subtree_cache.shift_remove_index(0);
        }
        self.subtree_cache.insert(
            key,
            CachedSubtree {
                scene: sub_scene,
                origin_y: current_origin_y,
                clip_to: outer_clip,
                clip_radius: outer_clip_radius,
                item_ids: items.iter().map(|it| it.node_id.clone()).collect(),
                awaiting_images,
                geometry: fragment_geometry_digest(items),
                validated_epoch: self.structural_epoch,
                transform: items[0].transform,
            },
        );
        // Append the just-cached scene at identity translation. Same
        // disjoint-field split-borrow as the hit branch.
        let cached = &self.subtree_cache[&key];
        let pushed = push_outer_clip(&mut self.scene, outer_clip, outer_clip_radius);
        self.scene.append(&cached.scene, None);
        if pushed {
            self.scene.pop_layer();
        }
        #[cfg(test)]
        {
            self.subtree_cache_misses += 1;
        }
    }

    /// Variant of `draw_item` that omits the outer-clip push/pop —
    /// the outer clip is handled at the subtree level, not per item.
    /// Inner clips (text truncate) are still emitted as before.
    fn draw_item_no_outer_clip(
        &mut self,
        item: &crate::layout::LayoutItem,
        scale_factor: f32,
        outer_clip: Option<LayoutRect>,
        outer_clip_radius: f32,
    ) {
        // Skip the per-item clip if it matches the outer clip we
        // already pushed at the subtree level — `draw_item` would
        // re-push it otherwise. For items whose clip_to differs
        // (rare; normally everything in a subtree shares the same
        // scrollable ancestor), leave it alone. The clip is threaded
        // as a parameter so no per-item `LayoutItem` clone is needed.
        if item.clip_to == outer_clip && item.clip_radius == outer_clip_radius {
            self.draw_item_with(item, scale_factor, None, 0.0, item.transform);
        } else {
            self.draw_item(item, scale_factor);
        }
    }

    fn draw_item(&mut self, item: &crate::layout::LayoutItem, scale_factor: f32) {
        self.draw_item_with(
            item,
            scale_factor,
            item.clip_to,
            item.clip_radius,
            item.transform,
        );
    }

    /// `draw_item` body with the outer clip and transform threaded as
    /// parameters instead of read off the item. Lets the subtree-cache
    /// encode path and the transform recursion suppress either without
    /// cloning the whole `LayoutItem` (Strings, icon paths, variant
    /// vecs) per drawn item per frame.
    fn draw_item_with(
        &mut self,
        item: &crate::layout::LayoutItem,
        scale_factor: f32,
        clip_to: Option<LayoutRect>,
        clip_radius: f32,
        transform: crate::layout::Affine2,
    ) {
        // Per-item transform (static `translateX` / `translateY` /
        // `scale` / `rotate` props and animator-driven writes alike —
        // one resolution path, composed in the layout transform
        // post-pass; see `LayoutItem::transform`). The item's WHOLE
        // draw — alpha layer, bg, border, content, focus ring — is
        // encoded into a sub-scene and spliced back under the item's
        // affine, so glyphs / images / icons / rings all move together
        // without threading a transform through every draw helper. The
        // OUTER clip (a scrollable ancestor's rect) is pushed on the
        // main scene, OUTSIDE the transform — CSS semantics: an
        // ancestor's overflow clip crops the transformed descendant in
        // the ancestor's own (untransformed) space. Hit-testing reads
        // the same cumulative affine (`LayoutItem::hit_contains`), so
        // pixels and hit targets move identically by construction.
        if !transform.is_identity() {
            let prev_scene = std::mem::replace(&mut self.scene, Scene::new());
            self.draw_item_with(
                item,
                scale_factor,
                None,
                0.0,
                crate::layout::Affine2::IDENTITY,
            );
            let sub_scene = std::mem::replace(&mut self.scene, prev_scene);
            let pushed = push_outer_clip(&mut self.scene, clip_to, clip_radius);
            self.scene
                .append(&sub_scene, Some(affine2_to_kurbo(transform)));
            if pushed {
                self.scene.pop_layer();
            }
            return;
        }
        // Outer clip for items inside a `.scrollable(...)` container:
        // wraps the entire draw (bg + border + content + focus ring)
        // so anything that has scrolled past the container's edge is
        // cropped to the container's rect rather than bleeding onto
        // siblings above / below — without this, the Search example's
        // grid Images paint over the Input above when scrolled. One
        // push/pop pair per clipped item; Vello composes nested
        // clips cleanly when the per-Text-truncate path below also
        // pushes its own.
        let outer_clip_active = clip_to.is_some();
        if let Some(clip) = clip_to {
            let r = rounded_rect_path(clip, clip_radius);
            self.scene.push_layer(
                vello::peniko::Fill::NonZero,
                vello::peniko::BlendMode::default(),
                1.0,
                Affine::IDENTITY,
                &r,
            );
        }

        // Per-item opacity (the `opacity` prop, inherited down the tree
        // at emit time — see `LayoutItem::opacity`). Wraps the item's
        // whole draw (bg + border + content + focus ring) in an alpha
        // layer. This is the paint half of the animation runtime's
        // `fade` / `pulse` / opacity-transition support; static
        // `.opacity(...)` props ride the same path. The layer's clip is
        // the item rect padded generously so borders / focus rings /
        // glyph anti-aliasing aren't cropped by the alpha layer itself.
        let alpha_layer_active = item.opacity < 0.999;
        if alpha_layer_active {
            const ALPHA_PAD: f32 = 8.0;
            let pad = ALPHA_PAD * scale_factor;
            let r = vello::kurbo::Rect::new(
                (item.rect.x - pad) as f64,
                (item.rect.y - pad) as f64,
                (item.rect.x + item.rect.w + pad) as f64,
                (item.rect.y + item.rect.h + pad) as f64,
            );
            self.scene.push_layer(
                vello::peniko::Fill::NonZero,
                vello::peniko::BlendMode::default(),
                item.opacity.clamp(0.0, 1.0),
                Affine::IDENTITY,
                &r,
            );
        }

        // Background and border resolution mirrors the CPU painter:
        // explicit paint-time state variants
        // (`backgroundColor:hover.0`, ...) win first, then the legacy
        // Button hover / press tint fills in whichever channel a variant
        // did NOT already override.
        let hovered = self.interaction.hovered.contains(&item.node_id);
        let pressed = self.interaction.pressed.contains(&item.node_id);
        let focused = self.interaction.focused.as_deref() == Some(&item.node_id);
        let mut background = item.background;
        let mut border_color = item.border.color;
        let mut bg_from_variant = false;
        let mut border_from_variant = false;
        // Resolve background / border / foreground state variants in one pass.
        // `active_states` is computed once and reused; `fg_override` is the
        // foreground `color` variant applied to Text / Input / Icon below.
        let fg_override = if item.state_variants.is_empty() {
            None
        } else {
            let states = item.state_variants.active_states(hovered, pressed, focused);
            if let Some(c) = item.state_variants.background_color_for(&states) {
                background = Some(c);
                bg_from_variant = true;
            }
            if let Some(c) = item.state_variants.border_color_for(&states) {
                border_color = c;
                border_from_variant = true;
            }
            item.state_variants.color_for(&states)
        };
        // Automatic pseudo-state tint for Buttons that didn't declare their own
        // `hover:`/`active:` state variant. An explicit variant always wins
        // first (gated by `bg_from_variant`/`border_from_variant`); otherwise
        // buttons with an opaque fill get lightened/darkened, while transparent
        // ones (icon buttons like a toolbar's home/reload) get a subtle neutral
        // overlay so hover/press still read as something (restored from main).
        if matches!(item.kind, ItemKind::Button | ItemKind::Card) {
            const HOVER_FILL: Rgba = Rgba(100, 116, 139, 28);
            const PRESS_FILL: Rgba = Rgba(100, 116, 139, 48);
            let has_fill = background.is_some_and(|b| b.3 > 0);
            if pressed {
                if !bg_from_variant {
                    background = if has_fill {
                        background.map(|b| darken(b, 0.85))
                    } else {
                        Some(PRESS_FILL)
                    };
                }
                if !border_from_variant {
                    border_color = darken(border_color, 0.7);
                }
            } else if hovered && !bg_from_variant {
                background = if has_fill {
                    background.map(|b| lighten(b, 1.05))
                } else {
                    Some(HOVER_FILL)
                };
            }
        }

        let radius = item.border.radius * scale_factor;
        if let Some(shadow_style) = item.shadow {
            let spread = shadow_style.spread * scale_factor;
            let shadow = KRect::new(
                (item.rect.x + shadow_style.x * scale_factor - spread) as f64,
                (item.rect.y + shadow_style.y * scale_factor - spread) as f64,
                (item.rect.x + item.rect.w + shadow_style.x * scale_factor + spread) as f64,
                (item.rect.y + item.rect.h + shadow_style.y * scale_factor + spread) as f64,
            );
            self.scene.draw_blurred_rounded_rect(
                Affine::IDENTITY,
                shadow,
                color_to_peniko(shadow_style.color),
                (radius + spread).max(0.0) as f64,
                (shadow_style.blur * scale_factor) as f64,
            );
        } else if matches!(item.kind, ItemKind::Card) {
            let shadow = KRect::new(
                item.rect.x as f64,
                (item.rect.y + 2.0 * scale_factor) as f64,
                (item.rect.x + item.rect.w) as f64,
                (item.rect.y + item.rect.h + 2.0 * scale_factor) as f64,
            );
            self.scene.draw_blurred_rounded_rect(
                Affine::IDENTITY,
                shadow,
                Color::from_rgba8(0, 0, 0, 26),
                radius as f64,
                (2.0 * scale_factor) as f64,
            );
        }
        // CSS layer order for a `background` value: colour at the bottom,
        // then the image, then the gradient on top. The wallpaper is exactly
        // that stack — a darkening `linear-gradient(...)` over a photo.
        if let Some(pb) = item.background_layers.as_ref() {
            // Fully layered stack (radial gradients, multi-layer
            // `background` shorthand). The shorthand's own colour layer
            // paints above the `backgroundColor` fill, below every
            // image/gradient layer; the layers themselves are stored
            // bottom-first, so painting in order stacks them like CSS.
            if let Some(bg) = background {
                fill_rect(&mut self.scene, item.rect, bg, radius);
            }
            if let Some(c) = pb.color {
                fill_rect(&mut self.scene, item.rect, c, radius);
            }
            // A colour-only (or gradient-only) `background` shorthand
            // must not swallow a separate `backgroundImage` url — that
            // image painted via the legacy branch before the layered
            // path existed. When the stack carries its own url layer,
            // both reads saw the same shorthand and the stack wins.
            let has_image_layer = pb
                .layers
                .iter()
                .any(|l| matches!(l, crate::style::BackgroundLayer::Image(_)));
            if !has_image_layer {
                if let Some(src) = item.background_image.as_deref() {
                    self.draw_image(
                        item.rect,
                        Some(src),
                        crate::layout::ObjectFit::Cover,
                        radius,
                    );
                }
            }
            for layer in &pb.layers {
                match layer {
                    crate::style::BackgroundLayer::Image(src) => {
                        self.draw_image(
                            item.rect,
                            Some(src),
                            crate::layout::ObjectFit::Cover,
                            radius,
                        );
                    }
                    crate::style::BackgroundLayer::Linear(grad) => {
                        fill_gradient_rect(&mut self.scene, item.rect, grad, radius);
                    }
                    crate::style::BackgroundLayer::Radial(grad) => {
                        fill_radial_gradient_rect(
                            &mut self.scene,
                            item.rect,
                            grad,
                            radius,
                            scale_factor,
                        );
                    }
                }
            }
            // A `.linearGradient()` applicator or Tailwind
            // `bg-gradient-to-*` arrives in a DIFFERENT prop than the
            // `background` shorthand that built this stack; it painted
            // on top before the layered path existed, so it still must.
            if let Some(grad) = item.background_gradient.as_ref() {
                fill_gradient_rect(&mut self.scene, item.rect, grad, radius);
            }
        } else if let Some(src) = item.background_image.as_deref() {
            if let Some(bg) = background {
                fill_rect(&mut self.scene, item.rect, bg, radius);
            }
            // `center / cover` is what the shorthand asks for and what
            // `ObjectFit::Cover` does: fill the box, crop the overflow.
            self.draw_image(
                item.rect,
                Some(src),
                crate::layout::ObjectFit::Cover,
                radius,
            );
            if let Some(grad) = item.background_gradient.as_ref() {
                fill_gradient_rect(&mut self.scene, item.rect, grad, radius);
            }
        } else if let Some(grad) = item.background_gradient.as_ref() {
            // Gradient takes precedence over solid `background` when
            // the DSL declared one (`bg-gradient-to-br from-* to-*` or
            // an explicit `linear-gradient(...)`). CSS layers solid
            // colour beneath the gradient image; with opaque-stop
            // gradients (the common case) the solid is occluded, and
            // we don't bother painting it underneath. Translucent
            // stops still show the parent background through —
            // matching standard CSS behaviour for `background:
            // <color> linear-gradient(...)` minus the stack.
            fill_gradient_rect(&mut self.scene, item.rect, grad, radius);
        } else if let Some(bg) = background {
            fill_rect(&mut self.scene, item.rect, bg, radius);
        }
        if item.border.is_visible() {
            if item.border.is_partial() {
                stroke_partial_border(
                    &mut self.scene,
                    item.rect,
                    border_color,
                    item.border.width * scale_factor,
                    item.border.sides,
                );
            } else {
                stroke_rect_styled(
                    &mut self.scene,
                    item.rect,
                    border_color,
                    radius,
                    item.border.width * scale_factor,
                    item.border.style,
                );
            }
        }

        match &item.kind {
            ItemKind::Container | ItemKind::Button | ItemKind::Card => {
                // Background + border already drawn above.
            }
            ItemKind::Text {
                content,
                font_size,
                line_height,
                color,
                align,
                max_lines,
                padding,
            } => {
                // `truncate` (max_lines = Some(1)) wants overflow to
                // disappear cleanly instead of bleeding into siblings.
                // Push a clip layer matching the laid-out rect, draw,
                // pop. For unbounded / multi-line text we can skip the
                // clip — Taffy already gave the rect enough height for
                // every line, so glyph descenders don't overflow in
                // practice and the extra layer just costs encoding.
                let needs_clip = max_lines.is_some();
                if needs_clip {
                    let clip = vello::kurbo::Rect::new(
                        item.rect.x as f64,
                        item.rect.y as f64,
                        (item.rect.x + item.rect.w) as f64,
                        (item.rect.y + item.rect.h) as f64,
                    );
                    self.scene.push_layer(
                        vello::peniko::Fill::NonZero,
                        vello::peniko::BlendMode::default(),
                        1.0,
                        Affine::IDENTITY,
                        &clip,
                    );
                }
                self.draw_text(
                    item,
                    content,
                    *font_size * scale_factor,
                    *line_height * scale_factor,
                    fg_override.unwrap_or(*color),
                    *align,
                    item.font_weight,
                    *max_lines,
                    *padding,
                );
                if needs_clip {
                    self.scene.pop_layer();
                }
            }
            ItemKind::Input {
                value,
                placeholder,
                multiline: true,
                color,
                ..
            } => {
                self.draw_textarea(
                    item,
                    value,
                    placeholder.as_deref(),
                    fg_override.unwrap_or(*color),
                    scale_factor,
                );
            }
            ItemKind::Input {
                value,
                placeholder,
                font_size,
                color,
                padding,
                ..
            } => {
                self.draw_input(
                    item,
                    value,
                    placeholder.as_deref(),
                    *font_size * scale_factor,
                    fg_override.unwrap_or(*color),
                    item.font_weight,
                    scale_factor,
                    *padding,
                );
            }
            ItemKind::Audio { controls } => {
                if *controls {
                    fill_rect(
                        &mut self.scene,
                        item.rect,
                        Rgba(0xf3, 0xf4, 0xf6, 0xff),
                        item.rect.h * 0.5,
                    );
                    let center_y = item.rect.y + item.rect.h * 0.5;
                    let button_radius = (item.rect.h * 0.28).min(15.0 * scale_factor);
                    let button_x = item.rect.x + 18.0 * scale_factor;
                    let button = vello::kurbo::Circle::new(
                        (button_x as f64, center_y as f64),
                        button_radius as f64,
                    );
                    self.scene.fill(
                        Fill::NonZero,
                        Affine::IDENTITY,
                        color_to_peniko(Rgba(0x47, 0x55, 0x69, 0xff)),
                        None,
                        &button,
                    );
                    let mut play = BezPath::new();
                    play.move_to((button_x - 3.0 * scale_factor, center_y - 5.0 * scale_factor));
                    play.line_to((button_x + 5.0 * scale_factor, center_y));
                    play.line_to((button_x - 3.0 * scale_factor, center_y + 5.0 * scale_factor));
                    play.close_path();
                    self.scene
                        .fill(Fill::NonZero, Affine::IDENTITY, Color::WHITE, None, &play);

                    let time_w = 68.0 * scale_factor;
                    let track_x = item.rect.x + 42.0 * scale_factor;
                    let track_w = (item.rect.w - 42.0 * scale_factor - time_w).max(0.0);
                    fill_rect(
                        &mut self.scene,
                        LayoutRect {
                            x: track_x,
                            y: center_y - scale_factor,
                            w: track_w,
                            h: 2.0 * scale_factor,
                        },
                        Rgba(0xd1, 0xd5, 0xdb, 0xff),
                        scale_factor,
                    );
                    self.text.draw_text_into_scene(
                        &mut self.scene,
                        "0:00 / 0:01",
                        item.rect.x + item.rect.w - time_w + 4.0 * scale_factor,
                        center_y - 7.0 * scale_factor,
                        12.0 * scale_factor,
                        Rgba(0x64, 0x74, 0x8b, 0xff),
                        Some((time_w - 8.0 * scale_factor).max(0.0)),
                        400,
                    );
                }
            }
            ItemKind::Checkbox { checked } => {
                let blue = Rgba(0x3b, 0x82, 0xf6, 0xff);
                fill_rect(
                    &mut self.scene,
                    item.rect,
                    if *checked {
                        blue
                    } else {
                        Rgba(0xff, 0xff, 0xff, 0xff)
                    },
                    3.0 * scale_factor,
                );
                stroke_rect(
                    &mut self.scene,
                    item.rect,
                    if *checked {
                        blue
                    } else {
                        Rgba(0x9c, 0xa3, 0xaf, 0xff)
                    },
                    3.0 * scale_factor,
                    1.0 * scale_factor,
                );
                if *checked {
                    let mut check = BezPath::new();
                    check.move_to((
                        item.rect.x + item.rect.w * 0.22,
                        item.rect.y + item.rect.h * 0.52,
                    ));
                    check.line_to((
                        item.rect.x + item.rect.w * 0.43,
                        item.rect.y + item.rect.h * 0.72,
                    ));
                    check.line_to((
                        item.rect.x + item.rect.w * 0.80,
                        item.rect.y + item.rect.h * 0.28,
                    ));
                    self.scene.stroke(
                        &Stroke::new((2.0 * scale_factor) as f64),
                        Affine::IDENTITY,
                        &Brush::Solid(Color::WHITE),
                        None,
                        &check,
                    );
                }
            }
            ItemKind::Switch { checked } => {
                let track = if *checked {
                    Rgba(0x22, 0xc5, 0x5e, 0xff)
                } else {
                    Rgba(0xd1, 0xd5, 0xdb, 0xff)
                };
                fill_rect(&mut self.scene, item.rect, track, item.rect.h * 0.5);
                let knob_radius = item.rect.h * 0.38;
                let knob_x = if *checked {
                    item.rect.x + item.rect.w - item.rect.h * 0.5
                } else {
                    item.rect.x + item.rect.h * 0.5
                };
                let knob = vello::kurbo::Circle::new(
                    (knob_x as f64, (item.rect.y + item.rect.h * 0.5) as f64),
                    knob_radius as f64,
                );
                self.scene
                    .fill(Fill::NonZero, Affine::IDENTITY, Color::WHITE, None, &knob);
            }
            ItemKind::Slider { fraction, disabled } => {
                let track_h = 4.0 * scale_factor;
                let track = LayoutRect {
                    x: item.rect.x,
                    y: item.rect.y + (item.rect.h - track_h) * 0.5,
                    w: item.rect.w,
                    h: track_h,
                };
                fill_rect(
                    &mut self.scene,
                    track,
                    Rgba(0xe5, 0xe7, 0xeb, 0xff),
                    track_h * 0.5,
                );
                let active = if *disabled {
                    Rgba(0x93, 0xc5, 0xfd, 0xff)
                } else {
                    Rgba(0x3b, 0x82, 0xf6, 0xff)
                };
                fill_rect(
                    &mut self.scene,
                    LayoutRect {
                        w: track.w * *fraction,
                        ..track
                    },
                    active,
                    track_h * 0.5,
                );
                let thumb = vello::kurbo::Circle::new(
                    (
                        (track.x + track.w * *fraction) as f64,
                        (item.rect.y + item.rect.h * 0.5) as f64,
                    ),
                    (6.0 * scale_factor) as f64,
                );
                self.scene.fill(
                    Fill::NonZero,
                    Affine::IDENTITY,
                    color_to_peniko(active),
                    None,
                    &thumb,
                );
            }
            ItemKind::ProgressBar { fraction } => {
                fill_rect(
                    &mut self.scene,
                    item.rect,
                    Rgba(0xe5, 0xe7, 0xeb, 0xff),
                    item.rect.h * 0.5,
                );
                fill_rect(
                    &mut self.scene,
                    LayoutRect {
                        w: item.rect.w * *fraction,
                        ..item.rect
                    },
                    Rgba(0x21, 0x96, 0xf3, 0xff),
                    item.rect.h * 0.5,
                );
            }
            ItemKind::Spinner { color } => {
                let circle = vello::kurbo::Circle::new(
                    (
                        (item.rect.x + item.rect.w * 0.5) as f64,
                        (item.rect.y + item.rect.h * 0.5) as f64,
                    ),
                    (item.rect.w.min(item.rect.h) * 0.38) as f64,
                );
                self.scene.stroke(
                    &Stroke::new((3.0 * scale_factor) as f64),
                    Affine::IDENTITY,
                    color_to_peniko(Rgba(color.0, color.1, color.2, 0x55)),
                    None,
                    &circle,
                );
                let marker = vello::kurbo::Circle::new(
                    (
                        (item.rect.x + item.rect.w * 0.5) as f64,
                        (item.rect.y + item.rect.h * 0.12) as f64,
                    ),
                    (1.8 * scale_factor) as f64,
                );
                self.scene.fill(
                    Fill::NonZero,
                    Affine::IDENTITY,
                    color_to_peniko(*color),
                    None,
                    &marker,
                );
            }
            ItemKind::Select { value, placeholder } => {
                fill_rect(
                    &mut self.scene,
                    item.rect,
                    Rgba(0xff, 0xff, 0xff, 0xff),
                    4.0 * scale_factor,
                );
                stroke_rect(
                    &mut self.scene,
                    item.rect,
                    Rgba(0x9c, 0xa3, 0xaf, 0xff),
                    4.0 * scale_factor,
                    scale_factor,
                );
                let label = if value.is_empty() { placeholder } else { value };
                self.text.draw_text_into_scene(
                    &mut self.scene,
                    label,
                    item.rect.x + 10.0 * scale_factor,
                    item.rect.y + (item.rect.h - 16.0 * scale_factor) * 0.5,
                    16.0 * scale_factor,
                    Rgba(0x37, 0x41, 0x51, 0xff),
                    Some((item.rect.w - 30.0 * scale_factor).max(0.0)),
                    400,
                );
                let mut caret = BezPath::new();
                caret.move_to((
                    item.rect.x + item.rect.w - 16.0 * scale_factor,
                    item.rect.y + item.rect.h * 0.42,
                ));
                caret.line_to((
                    item.rect.x + item.rect.w - 10.0 * scale_factor,
                    item.rect.y + item.rect.h * 0.42,
                ));
                caret.line_to((
                    item.rect.x + item.rect.w - 13.0 * scale_factor,
                    item.rect.y + item.rect.h * 0.58,
                ));
                caret.close_path();
                self.scene.fill(
                    Fill::NonZero,
                    Affine::IDENTITY,
                    color_to_peniko(Rgba(0x4b, 0x55, 0x63, 0xff)),
                    None,
                    &caret,
                );
            }
            ItemKind::Image { src, fit } => {
                self.draw_image(item.rect, src.as_deref(), *fit, radius);
            }
            ItemKind::Video {
                poster,
                state,
                slots,
                ..
            } => {
                // Video v2: a present slot REPLACES the built-in for its
                // concern — `poster` suppresses the poster-prop bitmap,
                // `controls` suppresses native chrome (the play glyph),
                // `loading` / `error` replace the glyph in their state.
                // The slot subtrees themselves are ordinary items
                // emitted right after this one, so they composite on
                // top of whatever is drawn here.
                let glyph = slots.draws_builtin_glyph(*state);
                // Feature `video`: a live decoded frame wins over the
                // poster — objectFit contain, letterboxed on black per
                // the contract, with the play affordance overlaid only
                // while paused / ended.
                #[cfg(feature = "video")]
                let live_frame_drawn = {
                    if let Some(frame) = crate::media::current_frame(&item.node_id) {
                        fill_rect(
                            &mut self.scene,
                            item.rect,
                            crate::paint::image::VIDEO_LETTERBOX_RGBA,
                            radius,
                        );
                        self.draw_video_frame(item.rect, &frame, radius);
                        if glyph && crate::media::is_paused(&item.node_id) {
                            draw_play_glyph(&mut self.scene, item.rect, scale_factor);
                        }
                        true
                    } else {
                        false
                    }
                };
                #[cfg(not(feature = "video"))]
                let live_frame_drawn = false;
                if !live_frame_drawn {
                    // No inline decode (feature off) or no frame yet:
                    // poster frame (cover) or dark placeholder, then
                    // the play affordance on top.
                    let poster_ready = !slots.poster
                        && poster
                            .as_deref()
                            .map(|p| {
                                crate::paint::image::ensure_loaded_public(p);
                                let ready = crate::paint::image::loaded_source(p).is_some();
                                if !ready {
                                    self.note_awaiting_image(p);
                                }
                                ready
                            })
                            .unwrap_or(false);
                    if poster_ready {
                        self.draw_image(
                            item.rect,
                            poster.as_deref(),
                            crate::layout::ObjectFit::Cover,
                            radius,
                        );
                    } else {
                        fill_rect(
                            &mut self.scene,
                            item.rect,
                            crate::paint::image::VIDEO_PLACEHOLDER_RGBA,
                            radius,
                        );
                    }
                    if glyph {
                        draw_play_glyph(&mut self.scene, item.rect, scale_factor);
                    }
                }
            }
            ItemKind::Scrubber { video_id, preview } => {
                // Progress is read LIVE here (registry / drag preview),
                // not baked into the item: playback advances the thumb
                // through the frame-driven repaints the decoder already
                // triggers, with no layout pass per frame.
                let fraction = crate::video_v2::scrubber_fraction(video_id.as_deref(), *preview);
                draw_scrubber(&mut self.scene, item.rect, fraction, scale_factor);
            }
            ItemKind::Chart(chart) => {
                // The chart resolved every mark into device-pixel shapes at
                // layout time (`crate::chart::build_scene`); painting is a
                // straight walk of that draw list.
                self.draw_chart(chart);
            }
            ItemKind::ChartMark(_) => {
                // Interaction only: the chart item above already drew this
                // mark's geometry. Emitting it as its own item is what makes
                // it hit-testable, focusable and dispatchable.
            }
            ItemKind::Icon {
                paths,
                view_box,
                tint,
            } => {
                draw_icon(
                    &mut self.scene,
                    item.rect,
                    paths,
                    *view_box,
                    fg_override.or(*tint),
                );
            }
        }

        if self.interaction.focus_visible
            && self.interaction.focused.as_deref() == Some(&item.node_id)
        {
            // Keyboard focus only (`:focus-visible`). Match the item's
            // own corner radius so focus on a circle (rounded-full
            // Image / Avatar) follows the shape instead of stamping an
            // awkward 11px-radius rect over it.
            draw_focus_ring(&mut self.scene, item.rect, scale_factor, radius);
        }

        if alpha_layer_active {
            self.scene.pop_layer();
        }
        if outer_clip_active {
            self.scene.pop_layer();
        }
    }

    /// Paint a resolved chart: fills, strokes, dashes and labels straight
    /// off [`crate::chart::ChartScene::shapes`], which is already in
    /// absolute device pixels.
    fn draw_chart(&mut self, chart: &crate::chart::ChartScene) {
        use crate::chart::ChartShape;
        // Disjoint field borrows: labels need the text engine while the
        // geometry goes into the scene.
        let VelloPainter {
            scene,
            text: text_engine,
            ..
        } = self;
        for shape in &chart.shapes {
            match shape {
                ChartShape::Label {
                    x,
                    y,
                    text,
                    size,
                    color,
                    align,
                    rotated,
                } => {
                    let (w, _) = text_engine.measure_weighted(text, *size, None, 400);
                    let tx = match align {
                        crate::chart::LabelAlign::Start => *x,
                        crate::chart::LabelAlign::Middle => x - w * 0.5,
                        crate::chart::LabelAlign::End => x - w,
                    };
                    if *rotated {
                        // The y-axis title reads bottom-to-top. Vello has no
                        // transform on the text call, so the label is drawn
                        // into a fragment and appended rotated about its
                        // anchor.
                        let mut fragment = Scene::new();
                        text_engine.draw_text_into_scene(
                            &mut fragment,
                            text,
                            tx,
                            y - size * 0.5,
                            *size,
                            *color,
                            None,
                            400,
                        );
                        scene.append(
                            &fragment,
                            Some(Affine::rotate_about(
                                -std::f64::consts::FRAC_PI_2,
                                vello::kurbo::Point::new(*x as f64, *y as f64),
                            )),
                        );
                    } else {
                        text_engine
                            .draw_text_into_scene(scene, text, tx, *y, *size, *color, None, 400);
                    }
                }
                other => {
                    if let Some((path, paint)) = chart_shape_path(other) {
                        draw_chart_path(scene, &path, paint);
                    }
                }
            }
        }
    }

    fn draw_text(
        &mut self,
        item: &crate::layout::LayoutItem,
        content: &str,
        scaled_size: f32,
        scaled_line_height: f32,
        color: Rgba,
        align: TextAlign,
        weight: u16,
        max_lines: Option<u32>,
        padding: (f32, f32, f32, f32),
    ) {
        // Compute the content rect from the outer rect + padding. Bg /
        // border render against the outer rect (separately, in
        // `draw_item`), but glyphs need to live inside the padded
        // content area. Wrap width also has to subtract horizontal
        // padding so text doesn't overflow into the right pad.
        let (pad_l, pad_t, pad_r, _pad_b) = padding;
        let content_x = item.rect.x + pad_l;
        let content_y = item.rect.y + pad_t;
        let content_w = (item.rect.w - pad_l - pad_r).max(0.0);
        // `truncate` (max_lines = Some(1)) needs `wrap = None` so the
        // shaper produces one line — passing the rect width forces a
        // wrap regardless. Caller pushed a clip layer to crop overflow.
        let wrap = if matches!(max_lines, Some(1)) {
            None
        } else {
            Some(content_w)
        };
        let mut painted = content.to_string();
        if let Some(limit) = max_lines {
            // `measure_weighted_line_height` ceils its height, so a
            // fractional line height (`leading-[1.3]` at 12px = 15.6)
            // reports two lines as 32, not 31.2. Compare against the
            // ceiled cap or every text that fits in exactly `limit`
            // lines would be ellipsized down to `limit - 1`.
            let max_height = (scaled_line_height * limit as f32).ceil();
            let (original_width, original_height) = self.text.measure_weighted_line_height(
                content,
                scaled_size,
                wrap,
                weight,
                scaled_line_height,
            );
            if original_height > max_height + 0.5 || (limit == 1 && original_width > content_w) {
                let chars: Vec<char> = content.chars().collect();
                let mut low = 0usize;
                let mut high = chars.len();
                while low < high {
                    let mid = (low + high + 1) / 2;
                    let candidate =
                        format!("{}…", chars[..mid].iter().collect::<String>().trim_end());
                    let (candidate_width, candidate_height) =
                        self.text.measure_weighted_line_height(
                            &candidate,
                            scaled_size,
                            if limit == 1 { None } else { Some(content_w) },
                            weight,
                            scaled_line_height,
                        );
                    if candidate_height <= max_height + 0.5
                        && (limit != 1 || candidate_width <= content_w)
                    {
                        low = mid;
                    } else {
                        high = mid - 1;
                    }
                }
                painted = format!("{}…", chars[..low].iter().collect::<String>().trim_end());
            }
        }
        // Alignment needs the glyph run's intrinsic width. The wrapped
        // measurement reports the full constraint width, which made center
        // and end offsets resolve to zero even for a short single line.
        let (intrinsic_w, _) = self.text.measure_weighted_line_height(
            &painted,
            scaled_size,
            None,
            weight,
            scaled_line_height,
        );
        let line_w = intrinsic_w.min(content_w);
        let dx = match align {
            TextAlign::Start => 0.0,
            TextAlign::Center => ((content_w - line_w).max(0.0)) * 0.5,
            TextAlign::End => (content_w - line_w).max(0.0),
        };
        self.text.draw_text_into_scene_line_height(
            &mut self.scene,
            &painted,
            content_x + dx,
            content_y,
            scaled_size,
            color,
            wrap,
            weight,
            scaled_line_height,
        );
    }

    fn draw_input(
        &mut self,
        item: &crate::layout::LayoutItem,
        value: &str,
        placeholder: Option<&str>,
        scaled_size: f32,
        color: Rgba,
        weight: u16,
        scale_factor: f32,
        padding: (f32, f32, f32, f32),
    ) {
        let (pad_left, pad_top, pad_right, _) = padding;
        let inner_w = (item.rect.w - pad_left - pad_right).max(0.0);
        let text_x = item.rect.x + pad_left;
        let text_y = item.rect.y + pad_top;

        // An Input is single-line: draw the value/placeholder with NO
        // wrap and clip overflow to the field. Previously this passed
        // `Some(inner_w)`, so a long value (e.g. a full URL in the
        // address bar) wrapped onto a second line — but the caret and
        // selection below measure single-line (`None`), so the caret
        // landed at the unwrapped x-offset while the glyphs sat on the
        // wrapped line. Single-line + clip keeps glyphs and caret on
        // the same baseline. (Horizontal scroll-to-caret for values
        // wider than the field is a separate enhancement.)
        let content_clip = vello::kurbo::Rect::new(
            text_x as f64,
            item.rect.y as f64,
            (text_x + inner_w) as f64,
            (item.rect.y + item.rect.h) as f64,
        );
        self.scene.push_layer(
            vello::peniko::Fill::NonZero,
            vello::peniko::BlendMode::default(),
            1.0,
            Affine::IDENTITY,
            &content_clip,
        );

        if value.is_empty() {
            if let Some(p) = placeholder {
                self.text.draw_text_into_scene(
                    &mut self.scene,
                    p,
                    text_x,
                    text_y,
                    scaled_size,
                    Rgba(0x90, 0x96, 0xa1, 0xff),
                    None,
                    weight,
                );
            }
        } else {
            self.text.draw_text_into_scene(
                &mut self.scene,
                value,
                text_x,
                text_y,
                scaled_size,
                color,
                None,
                weight,
            );
        }

        // Caret / selection / preedit overlay when focused. Same
        // model as the CPU painter: collapsed selection → 1 px caret;
        // range → translucent accent-blue band.
        if self.interaction.focused.as_deref() == Some(&item.node_id) {
            let sel = self
                .interaction
                .input_selections
                .get(&item.node_id)
                .copied()
                .unwrap_or_else(|| Selection::caret(value.len()))
                .clamped(value.len());
            let caret_h_px = scaled_size * 1.2;
            let preedit = self
                .interaction
                .ime_preedit
                .as_ref()
                .filter(|(id, _)| id == &item.node_id)
                .map(|(_, t)| t.as_str());

            if !sel.is_collapsed() && preedit.is_none() {
                let (lead_w, _) =
                    self.text
                        .measure_weighted(&value[..sel.min()], scaled_size, None, weight);
                let (trail_w, _) =
                    self.text
                        .measure_weighted(&value[..sel.max()], scaled_size, None, weight);
                fill_rect(
                    &mut self.scene,
                    LayoutRect {
                        x: text_x + lead_w,
                        y: text_y,
                        w: trail_w - lead_w,
                        h: caret_h_px,
                    },
                    Rgba(0x00, 0x7a, 0xff, 0x55),
                    0.0,
                );
            } else {
                let caret_offset = sel.head.min(value.len());
                let (caret_x_offset, _) =
                    self.text
                        .measure_weighted(&value[..caret_offset], scaled_size, None, weight);
                fill_rect(
                    &mut self.scene,
                    LayoutRect {
                        x: text_x + caret_x_offset,
                        y: text_y,
                        w: 1.5 * scale_factor,
                        h: caret_h_px,
                    },
                    Rgba(0x00, 0x7a, 0xff, 0xff),
                    0.0,
                );
            }
            if let Some(pre) = preedit {
                let caret_offset = sel.head.min(value.len());
                let (caret_x_offset, _) =
                    self.text
                        .measure_weighted(&value[..caret_offset], scaled_size, None, weight);
                self.text.draw_text_into_scene(
                    &mut self.scene,
                    pre,
                    text_x + caret_x_offset,
                    text_y,
                    scaled_size,
                    color,
                    None,
                    weight,
                );
                let (pre_w, _) = self.text.measure_weighted(pre, scaled_size, None, weight);
                fill_rect(
                    &mut self.scene,
                    LayoutRect {
                        x: text_x + caret_x_offset,
                        y: text_y + caret_h_px - 1.0 * scale_factor,
                        w: pre_w,
                        h: 1.0 * scale_factor,
                    },
                    Rgba(0x00, 0x7a, 0xff, 0xff),
                    0.0,
                );
            }
        }

        // Close the single-line content clip pushed at the top.
        self.scene.pop_layer();
    }

    /// Paint a `Textarea`: the value (or muted placeholder) soft-wrapped
    /// to the content width, shifted by the inner scroll offset and
    /// clipped to the padding box; plus, when focused, the multi-line
    /// selection bands, caret, and IME preedit. All geometry comes from
    /// [`crate::textarea::FieldFrame`] + `TextEngine::visual_lines`, the
    /// same layout the window uses for click / arrow-key caret math.
    fn draw_textarea(
        &mut self,
        item: &crate::layout::LayoutItem,
        value: &str,
        placeholder: Option<&str>,
        color: Rgba,
        scale_factor: f32,
    ) {
        use crate::textarea::{caret_position, selection_bands, FieldFrame};
        let Some(frame) = FieldFrame::of(item, scale_factor) else {
            return;
        };
        let disabled = item.state_variants.disabled;
        let dim = |c: Rgba| {
            if disabled {
                Rgba(c.0, c.1, c.2, (c.3 as u16 * 5 / 10) as u8)
            } else {
                c
            }
        };
        let stored = self
            .interaction
            .textarea_scroll
            .get(&item.node_id)
            .copied()
            .unwrap_or(0.0);
        let scroll = frame.clamp_scroll_for(&mut self.text, value, stored);
        let origin_y = frame.text_y - scroll;

        // Clip: content box horizontally (plus a caret's width so an
        // end-of-line caret stays visible), padding box vertically —
        // scrolled lines disappear under the padding edge like the DOM.
        let caret_w = 1.5 * scale_factor;
        let content_clip = vello::kurbo::Rect::new(
            frame.text_x as f64,
            frame.clip_top as f64,
            (frame.text_x + frame.inner_w + caret_w) as f64,
            frame.clip_bottom as f64,
        );
        self.scene.push_layer(
            vello::peniko::Fill::NonZero,
            vello::peniko::BlendMode::default(),
            1.0,
            Affine::IDENTITY,
            &content_clip,
        );

        let focused = self.interaction.focused.as_deref() == Some(&item.node_id);
        let preedit = self
            .interaction
            .ime_preedit
            .as_ref()
            .filter(|(id, _)| focused && id == &item.node_id)
            .map(|(_, t)| t.clone());

        // Selection bands under the glyphs, like native text views.
        let sel = focused.then(|| {
            self.interaction
                .input_selections
                .get(&item.node_id)
                .copied()
                .unwrap_or_else(|| Selection::caret(value.len()))
                .clamped(value.len())
        });
        let lines = if focused {
            frame.lines(&mut self.text, value)
        } else {
            Vec::new()
        };
        if let Some(sel) = sel.filter(|s| !s.is_collapsed() && preedit.is_none()) {
            for (x0, top, x1, h) in selection_bands(&lines, sel.min(), sel.max(), frame.font_px * 0.3)
            {
                fill_rect(
                    &mut self.scene,
                    LayoutRect {
                        x: frame.text_x + x0,
                        y: origin_y + top,
                        w: x1 - x0,
                        h,
                    },
                    Rgba(0x00, 0x7a, 0xff, 0x55),
                    0.0,
                );
            }
        }

        if value.is_empty() {
            if let Some(p) = placeholder {
                self.text.draw_text_into_scene_line_height(
                    &mut self.scene,
                    p,
                    frame.text_x,
                    origin_y,
                    frame.font_px,
                    dim(Rgba(0x90, 0x96, 0xa1, 0xff)),
                    Some(frame.inner_w),
                    frame.weight,
                    frame.line_px,
                );
            }
        } else {
            self.text.draw_text_into_scene_line_height(
                &mut self.scene,
                value,
                frame.text_x,
                origin_y,
                frame.font_px,
                dim(color),
                Some(frame.inner_w),
                frame.weight,
                frame.line_px,
            );
        }

        if let Some(sel) = sel {
            let (cx, ctop, ch) = caret_position(&lines, sel.head.min(value.len()));
            let line_h = if ch > 0.0 { ch } else { frame.line_px };
            let caret_h = line_h.min(frame.font_px * 1.2);
            let caret_y = origin_y + ctop + (line_h - caret_h) * 0.5;
            let mut caret_x = frame.text_x + cx;
            if let Some(pre) = preedit.as_deref() {
                self.text.draw_text_into_scene_line_height(
                    &mut self.scene,
                    pre,
                    caret_x,
                    origin_y + ctop,
                    frame.font_px,
                    color,
                    None,
                    frame.weight,
                    frame.line_px,
                );
                let (pre_w, _) =
                    self.text
                        .measure_weighted(pre, frame.font_px, None, frame.weight);
                fill_rect(
                    &mut self.scene,
                    LayoutRect {
                        x: caret_x,
                        y: caret_y + caret_h - 1.0 * scale_factor,
                        w: pre_w,
                        h: 1.0 * scale_factor,
                    },
                    Rgba(0x00, 0x7a, 0xff, 0xff),
                    0.0,
                );
                caret_x += pre_w;
            }
            if sel.is_collapsed() || preedit.is_some() {
                fill_rect(
                    &mut self.scene,
                    LayoutRect {
                        x: caret_x,
                        y: caret_y,
                        w: caret_w,
                        h: caret_h,
                    },
                    Rgba(0x00, 0x7a, 0xff, 0xff),
                    0.0,
                );
            }
        }

        self.scene.pop_layer();
    }

    /// Record that the fragment being encoded asked for `src` and drew
    /// nothing because it is not decoded yet. See
    /// `CachedSubtree::awaiting_images`.
    fn note_awaiting_image(&mut self, src: &str) {
        if !self.encoding_awaits.iter().any(|s| s == src) {
            self.encoding_awaits.push(src.to_string());
        }
    }

    fn draw_image(
        &mut self,
        rect: LayoutRect,
        src: Option<&str>,
        fit: crate::layout::ObjectFit,
        radius: f32,
    ) {
        // We share the global image cache (`crate::paint::image::cache()`)
        // for decoded source bitmaps, and the per-painter cache below
        // wraps each decoded source in a `peniko::ImageData` once.
        // Keyed by `src` ONLY: rect size, object-fit and rounded-corner
        // radius all feed the `Affine` transform / clip layer below,
        // not the cache key. Two draws of the same URL at different
        // rect sizes therefore share a single entry.
        let Some(src) = src else {
            // No source — let the page background show through.
            return;
        };
        let _ = (rect.w, rect.h, fit, radius); // size/fit/radius feed the transform, not the key.

        if !self.image_cache.contains_key(src) {
            // Load source via the existing async cache (HTTP / local
            // file decode runs on the worker). Returns Arc<Pixmap>.
            // Probe the decoded hot tier first: asking the source cache to
            // "ensure" an already-decoded image needlessly acquires its
            // mutex and, for test/preseeded sources, can even enqueue a fake
            // load that invalidates the scene cache on completion.
            let pm = crate::paint::image::loaded_source(src).or_else(|| {
                crate::paint::image::ensure_loaded_public(src);
                crate::paint::image::loaded_source(src)
            });
            let Some(pm) = pm else {
                self.note_awaiting_image(src);
                return;
            };
            let img = pixmap_to_peniko(&pm);
            if self.image_cache.len() >= IMAGE_CACHE_CAP {
                self.image_cache.shift_remove_index(0);
            }
            self.image_cache.insert(src.to_string(), img);
        }
        let img = self.image_cache.get(src).expect("just inserted");

        // Resolve object-fit into a transform that maps image-space
        // (0..w, 0..h) → rect-space.
        let (sx, sy) = {
            let raw_sx = rect.w / img.width as f32;
            let raw_sy = rect.h / img.height as f32;
            match fit {
                crate::layout::ObjectFit::Fill => (raw_sx, raw_sy),
                crate::layout::ObjectFit::Cover => {
                    let s = raw_sx.max(raw_sy);
                    (s, s)
                }
                crate::layout::ObjectFit::Contain => {
                    let s = raw_sx.min(raw_sy);
                    (s, s)
                }
                crate::layout::ObjectFit::None => (1.0, 1.0),
            }
        };
        let dx = rect.x as f64 + ((rect.w - img.width as f32 * sx) * 0.5) as f64;
        let dy = rect.y as f64 + ((rect.h - img.height as f32 * sy) * 0.5) as f64;
        let transform = Affine::translate((dx, dy)).pre_scale_non_uniform(sx as f64, sy as f64);

        // `object-fit: cover` intentionally scales the source past one axis
        // of the destination. An HTML `<img>` still clips those pixels to its
        // own content box; Desktop previously did so only when `radius > 0`,
        // allowing a square-cornered/responsive Grid image to paint over the
        // card text below after a wide-window resize.
        let clip_shape = rounded_rect_path(rect, radius.max(0.0));
        self.scene.push_layer(
            vello::peniko::Fill::NonZero,
            vello::peniko::BlendMode::default(),
            1.0,
            Affine::IDENTITY,
            &clip_shape,
        );
        self.scene.draw_image(img, transform);
        self.scene.pop_layer();
    }

    /// Feature `video`: composite the latest decoded RGBA playback
    /// frame into `rect` with objectFit contain (the caller fills the
    /// letterbox black first). A fresh `ImageData` per frame is fine
    /// for v1 — the frame's bytes are shared via `Arc`, so the CPU
    /// cost is a pointer bump and Vello uploads the texture per frame
    /// either way.
    #[cfg(feature = "video")]
    fn draw_video_frame(
        &mut self,
        rect: LayoutRect,
        frame: &crate::media::VideoFrame,
        radius: f32,
    ) {
        use vello::peniko::{Blob, ImageAlphaType, ImageData, ImageFormat};
        if frame.width == 0 || frame.height == 0 || rect.w <= 0.0 || rect.h <= 0.0 {
            return;
        }
        let img = ImageData {
            data: Blob::new(frame.data.clone()),
            format: ImageFormat::Rgba8,
            // Video frames are opaque, so the bytes are identical
            // under both alpha interpretations; premultiplied matches
            // the painter's other images.
            alpha_type: ImageAlphaType::AlphaPremultiplied,
            width: frame.width,
            height: frame.height,
        };
        let sx = rect.w / frame.width as f32;
        let sy = rect.h / frame.height as f32;
        let s = sx.min(sy) as f64;
        let dx = rect.x as f64 + (rect.w as f64 - frame.width as f64 * s) * 0.5;
        let dy = rect.y as f64 + (rect.h as f64 - frame.height as f64 * s) * 0.5;
        let transform = Affine::translate((dx, dy)).pre_scale(s);
        if radius > 0.0 {
            let clip_shape = rounded_rect_path(rect, radius);
            self.scene.push_layer(
                vello::peniko::Fill::NonZero,
                vello::peniko::BlendMode::default(),
                1.0,
                Affine::IDENTITY,
                &clip_shape,
            );
            self.scene.draw_image(&img, transform);
            self.scene.pop_layer();
        } else {
            self.scene.draw_image(&img, transform);
        }
    }
}

impl Default for VelloPainter {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Drawing primitives.
// ---------------------------------------------------------------------------

/// Paint a rounded (or square) rect filled with a linear gradient.
/// The DSL produces these via `bg-gradient-to-* from-* via-* to-*`
/// Tailwind utilities; `style::prop_linear_gradient` resolves the
/// var-indirection. Stops are passed to Vello's
/// `peniko::Gradient::new_linear` which renders them on the GPU.
fn fill_gradient_rect(
    scene: &mut Scene,
    rect: LayoutRect,
    grad: &crate::style::LinearGradient,
    radius: f32,
) {
    if rect.w <= 0.0 || rect.h <= 0.0 || grad.stops.is_empty() {
        return;
    }
    let ((sx, sy), (ex, ey)) = grad.direction.axis(rect.x, rect.y, rect.w, rect.h);
    let mut gradient = vello::peniko::Gradient::new_linear(
        vello::kurbo::Point::new(sx as f64, sy as f64),
        vello::kurbo::Point::new(ex as f64, ey as f64),
    );
    let stops = grad.resolved_offsets();
    let color_stops: Vec<vello::peniko::ColorStop> = stops
        .into_iter()
        .map(|(off, c)| vello::peniko::ColorStop {
            offset: off,
            color: vello::peniko::color::DynamicColor::from_alpha_color(
                vello::peniko::Color::from_rgba8(c.0, c.1, c.2, c.3),
            ),
        })
        .collect();
    gradient.stops = vello::peniko::ColorStops(color_stops.into());
    let brush = Brush::Gradient(gradient);
    if radius > 0.0 {
        let r = radius.min(rect.w * 0.5).min(rect.h * 0.5).max(0.0);
        let kr = RoundedRect::new(
            rect.x as f64,
            rect.y as f64,
            (rect.x + rect.w) as f64,
            (rect.y + rect.h) as f64,
            r as f64,
        );
        scene.fill(Fill::NonZero, Affine::IDENTITY, &brush, None, &kr);
    } else {
        let kr = KRect::new(
            rect.x as f64,
            rect.y as f64,
            (rect.x + rect.w) as f64,
            (rect.y + rect.h) as f64,
        );
        scene.fill(Fill::NonZero, Affine::IDENTITY, &brush, None, &kr);
    }
}

/// Paint a rounded (or square) rect filled with a radial gradient.
/// The ending shape may be an ellipse (`radial-gradient(85% 60% at …)`),
/// which Vello's circular `new_radial` can't express directly — so the
/// gradient is built on a unit circle at the origin and stretched into
/// place with a brush transform (translate to the centre, scale by the
/// per-axis radii).
fn fill_radial_gradient_rect(
    scene: &mut Scene,
    rect: LayoutRect,
    grad: &crate::style::RadialGradient,
    radius: f32,
    scale: f32,
) {
    if rect.w <= 0.0 || rect.h <= 0.0 || grad.stops.is_empty() {
        return;
    }
    let cx = rect.x + grad.center.0 * rect.w;
    let cy = rect.y + grad.center.1 * rect.h;
    let (rx, ry) = grad.resolve_radii(rect.w, rect.h, scale);
    if rx <= 0.0 || ry <= 0.0 {
        // CSS's degenerate case (e.g. `closest-side` with the centre on
        // a box edge): the ending shape is treated as vanishingly
        // small, so every point sits past the last stop — a flat fill
        // of the last stop's colour, not an invisible element.
        if let Some(last) = grad.stops.last() {
            fill_rect(scene, rect, last.color, radius);
        }
        return;
    }
    let mut gradient = vello::peniko::Gradient::new_radial(vello::kurbo::Point::new(0.0, 0.0), 1.0);
    let stops = grad.resolved_offsets();
    let color_stops: Vec<vello::peniko::ColorStop> = stops
        .into_iter()
        .map(|(off, c)| vello::peniko::ColorStop {
            offset: off,
            color: vello::peniko::color::DynamicColor::from_alpha_color(
                vello::peniko::Color::from_rgba8(c.0, c.1, c.2, c.3),
            ),
        })
        .collect();
    gradient.stops = vello::peniko::ColorStops(color_stops.into());
    let brush = Brush::Gradient(gradient);
    let brush_transform =
        Affine::translate((cx as f64, cy as f64)) * Affine::scale_non_uniform(rx as f64, ry as f64);
    if radius > 0.0 {
        let r = radius.min(rect.w * 0.5).min(rect.h * 0.5).max(0.0);
        let kr = RoundedRect::new(
            rect.x as f64,
            rect.y as f64,
            (rect.x + rect.w) as f64,
            (rect.y + rect.h) as f64,
            r as f64,
        );
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            &brush,
            Some(brush_transform),
            &kr,
        );
    } else {
        let kr = KRect::new(
            rect.x as f64,
            rect.y as f64,
            (rect.x + rect.w) as f64,
            (rect.y + rect.h) as f64,
        );
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            &brush,
            Some(brush_transform),
            &kr,
        );
    }
}

/// Build the kurbo path for one chart shape, paired with how to paint it.
/// `Label` has no path — the caller draws text for that one.
fn chart_shape_path(
    shape: &crate::chart::ChartShape,
) -> Option<(BezPath, &crate::chart::ShapePaint)> {
    use crate::chart::ChartShape;
    match shape {
        ChartShape::Path {
            points,
            smooth,
            close_to_y,
            paint,
        } => {
            if points.is_empty() {
                return None;
            }
            let mut path = BezPath::new();
            path.move_to((points[0].0 as f64, points[0].1 as f64));
            let segments = if *smooth {
                crate::chart::smooth_segments(points)
            } else {
                Vec::new()
            };
            if segments.is_empty() {
                for p in &points[1..] {
                    path.line_to((p.0 as f64, p.1 as f64));
                }
            } else {
                for (c1, c2, end) in segments {
                    path.curve_to(
                        (c1.0 as f64, c1.1 as f64),
                        (c2.0 as f64, c2.1 as f64),
                        (end.0 as f64, end.1 as f64),
                    );
                }
            }
            if let Some(base) = close_to_y {
                let last = points[points.len() - 1];
                let first = points[0];
                path.line_to((last.0 as f64, *base as f64));
                path.line_to((first.0 as f64, *base as f64));
                path.close_path();
            }
            Some((path, paint))
        }
        ChartShape::Rect {
            rect,
            radius,
            paint,
        } => {
            if rect.w <= 0.0 && rect.h <= 0.0 {
                return None;
            }
            let r = radius.min(rect.w * 0.5).min(rect.h * 0.5).max(0.0) as f64;
            let rounded = RoundedRect::new(
                rect.x as f64,
                rect.y as f64,
                (rect.x + rect.w) as f64,
                (rect.y + rect.h) as f64,
                r,
            );
            Some((rounded.to_path(0.1), paint))
        }
        ChartShape::Circle { cx, cy, r, paint } => {
            if *r <= 0.0 {
                return None;
            }
            let circle = vello::kurbo::Circle::new((*cx as f64, *cy as f64), *r as f64);
            Some((circle.to_path(0.1), paint))
        }
        ChartShape::Segment {
            x1,
            y1,
            x2,
            y2,
            paint,
        } => {
            let mut path = BezPath::new();
            path.move_to((*x1 as f64, *y1 as f64));
            path.line_to((*x2 as f64, *y2 as f64));
            Some((path, paint))
        }
        ChartShape::SvgPath {
            d,
            transform,
            paint,
        } => {
            let mut path = svg_path_to_kurbo(d)?;
            let [a, b, c, dd, e, f] = *transform;
            // Data units -> pixels is baked into the geometry, so the
            // stroke stays non-scaling exactly like the SVG
            // `vector-effect: non-scaling-stroke` the DOM renderer sets.
            path.apply_affine(Affine::new([
                a as f64, b as f64, c as f64, dd as f64, e as f64, f as f64,
            ]));
            Some((path, paint))
        }
        ChartShape::Label { .. } => None,
    }
}

/// How many strokes approximate one glow / mark shadow.
///
/// Vello's only blur primitive is `draw_blurred_rounded_rect`, which cannot
/// take an arbitrary path, so a mark's `glow(...)` (and the shape-shadow
/// family that means the same thing on a path) is drawn as a stack of
/// progressively wider, lower-alpha strokes behind the geometry rather than
/// a true Gaussian blur. Close enough to read as a soft halo; cheap, and it
/// degrades to nothing when the radius is zero.
const CHART_GLOW_PASSES: usize = 3;

fn draw_chart_path(scene: &mut Scene, path: &BezPath, paint: &crate::chart::ShapePaint) {
    if let Some(glow) = paint.glow {
        if glow.radius > 0.0 && glow.color.3 > 0 {
            let offset = Affine::translate((glow.dx as f64, glow.dy as f64));
            for pass in (1..=CHART_GLOW_PASSES).rev() {
                let spread = glow.radius * (pass as f32 / CHART_GLOW_PASSES as f32);
                let alpha = (glow.color.3 as f32 * 0.35 / pass as f32).clamp(0.0, 255.0) as u8;
                if alpha == 0 {
                    continue;
                }
                let color = color_to_peniko(Rgba(glow.color.0, glow.color.1, glow.color.2, alpha));
                let width = (paint.width.max(1.0) + spread * 2.0) as f64;
                scene.stroke(&Stroke::new(width), offset, color, None, path);
                if paint.fill.is_some() {
                    scene.fill(Fill::NonZero, offset, color, None, path);
                }
            }
        }
    }
    if let Some(fill) = paint.fill {
        if fill.3 > 0 {
            scene.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                color_to_peniko(fill),
                None,
                path,
            );
        }
    }
    if let Some(stroke_color) = paint.stroke {
        if stroke_color.3 > 0 && paint.width > 0.0 {
            let mut stroke = Stroke::new(paint.width as f64);
            if paint.round_cap {
                stroke = stroke.with_caps(Cap::Round).with_join(Join::Round);
            }
            if let Some((on, off)) = paint.dash {
                stroke = stroke.with_dashes(0.0, [on as f64, off as f64]);
            }
            scene.stroke(
                &stroke,
                Affine::IDENTITY,
                color_to_peniko(stroke_color),
                None,
                path,
            );
        }
    }
}

fn fill_rect(scene: &mut Scene, rect: LayoutRect, color: Rgba, radius: f32) {
    if rect.w <= 0.0 || rect.h <= 0.0 || color.3 == 0 {
        return;
    }
    let brush = Brush::Solid(color_to_peniko(color));
    if radius > 0.0 {
        let r = radius.min(rect.w * 0.5).min(rect.h * 0.5).max(0.0);
        let kr = RoundedRect::new(
            rect.x as f64,
            rect.y as f64,
            (rect.x + rect.w) as f64,
            (rect.y + rect.h) as f64,
            r as f64,
        );
        scene.fill(Fill::NonZero, Affine::IDENTITY, &brush, None, &kr);
    } else {
        let kr = KRect::new(
            rect.x as f64,
            rect.y as f64,
            (rect.x + rect.w) as f64,
            (rect.y + rect.h) as f64,
        );
        scene.fill(Fill::NonZero, Affine::IDENTITY, &brush, None, &kr);
    }
}

fn stroke_rect(scene: &mut Scene, rect: LayoutRect, color: Rgba, radius: f32, width: f32) {
    stroke_rect_styled(scene, rect, color, radius, width, BorderLineStyle::Solid);
}

fn stroke_rect_styled(
    scene: &mut Scene,
    rect: LayoutRect,
    color: Rgba,
    radius: f32,
    width: f32,
    line_style: BorderLineStyle,
) {
    if width <= 0.0 || color.3 == 0 {
        return;
    }
    let brush = Brush::Solid(color_to_peniko(color));
    let width64 = width as f64;
    let stroke = match line_style {
        BorderLineStyle::Solid => Stroke::new(width64),
        BorderLineStyle::Dashed => {
            Stroke::new(width64).with_dashes(0.0, [width64 * 3.0, width64 * 2.0])
        }
        BorderLineStyle::Dotted => Stroke::new(width64)
            .with_caps(Cap::Round)
            .with_dashes(0.0, [width64 * 0.1, width64 * 2.0]),
    };
    if radius > 0.0 {
        let r = radius.min(rect.w * 0.5).min(rect.h * 0.5).max(0.0);
        let kr = RoundedRect::new(
            rect.x as f64,
            rect.y as f64,
            (rect.x + rect.w) as f64,
            (rect.y + rect.h) as f64,
            r as f64,
        );
        scene.stroke(&stroke, Affine::IDENTITY, &brush, None, &kr);
    } else {
        let kr = KRect::new(
            rect.x as f64,
            rect.y as f64,
            (rect.x + rect.w) as f64,
            (rect.y + rect.h) as f64,
        );
        scene.stroke(&stroke, Affine::IDENTITY, &brush, None, &kr);
    }
}

fn stroke_partial_border(scene: &mut Scene, rect: LayoutRect, color: Rgba, width: f32, sides: u8) {
    if width <= 0.0 || color.3 == 0 {
        return;
    }
    if sides & BORDER_SIDE_TOP != 0 {
        fill_rect(
            scene,
            LayoutRect {
                x: rect.x,
                y: rect.y,
                w: rect.w,
                h: width,
            },
            color,
            0.0,
        );
    }
    if sides & BORDER_SIDE_BOTTOM != 0 {
        fill_rect(
            scene,
            LayoutRect {
                x: rect.x,
                y: rect.y + rect.h - width,
                w: rect.w,
                h: width,
            },
            color,
            0.0,
        );
    }
    if sides & BORDER_SIDE_LEFT != 0 {
        fill_rect(
            scene,
            LayoutRect {
                x: rect.x,
                y: rect.y,
                w: width,
                h: rect.h,
            },
            color,
            0.0,
        );
    }
    if sides & BORDER_SIDE_RIGHT != 0 {
        fill_rect(
            scene,
            LayoutRect {
                x: rect.x + rect.w - width,
                y: rect.y,
                w: width,
                h: rect.h,
            },
            color,
            0.0,
        );
    }
    let _ = BORDER_SIDES_ALL; // keep symbol referenced
}

fn draw_focus_ring(scene: &mut Scene, rect: LayoutRect, scale: f32, item_radius: f32) {
    let inset = -3.0 * scale;
    let ring_rect = LayoutRect {
        x: rect.x + inset,
        y: rect.y + inset,
        w: rect.w - 2.0 * inset,
        h: rect.h - 2.0 * inset,
    };
    // Expand the item's own radius by the inset so the ring stays
    // concentric with the rounded corner instead of corner-cutting.
    // For square items (radius 0) this falls back to a small bias so
    // the ring reads as a focus state, not a hard rectangle.
    let radius = if item_radius > 0.0 {
        item_radius + (-inset)
    } else {
        4.0 * scale
    };
    stroke_rect(
        scene,
        ring_rect,
        Rgba(0x00, 0x7a, 0xff, 0xcc),
        radius,
        2.0 * scale,
    );
}

fn draw_icon(
    scene: &mut Scene,
    rect: LayoutRect,
    paths: &[crate::paint::icon::IconPath],
    view_box: (f32, f32, f32, f32),
    tint: Option<Rgba>,
) {
    if rect.w <= 0.0 || rect.h <= 0.0 || paths.is_empty() {
        return;
    }
    let (vx, vy, vw, vh) = view_box;
    if vw <= 0.0 || vh <= 0.0 {
        return;
    }
    let scale = (rect.w / vw).min(rect.h / vh) as f64;
    let dx = rect.x as f64 + ((rect.w - vw * scale as f32) * 0.5) as f64 - vx as f64 * scale;
    let dy = rect.y as f64 + ((rect.h - vh * scale as f32) * 0.5) as f64 - vy as f64 * scale;
    let transform = Affine::translate((dx, dy)).pre_scale(scale);

    for p in paths {
        let Some(bezpath) = svg_path_to_kurbo(&p.d) else {
            continue;
        };

        let fill_attr = p.fill.as_deref();
        let fill_disabled = matches!(fill_attr, Some("none") | Some("transparent"));
        let fill_color = if fill_disabled {
            None
        } else if matches!(fill_attr, None | Some("currentColor")) {
            tint
        } else {
            tint.or_else(|| fill_attr.and_then(crate::style::parse_color))
        };
        if let Some(c) = fill_color {
            if c.3 > 0 {
                scene.fill(Fill::NonZero, transform, color_to_peniko(c), None, &bezpath);
            }
        }

        let stroke_attr = p.stroke.as_deref();
        let stroke_disabled = matches!(stroke_attr, Some("none") | Some("transparent"));
        let stroke_color = if stroke_disabled {
            None
        } else if matches!(stroke_attr, Some("currentColor")) {
            Some(tint.unwrap_or(Rgba::BLACK))
        } else if stroke_attr.is_some() {
            tint.or_else(|| stroke_attr.and_then(crate::style::parse_color))
        } else {
            None
        };
        if let Some(c) = stroke_color {
            if c.3 > 0 {
                let width = p.stroke_width.unwrap_or(1.0);
                if width > 0.0 {
                    let stroke = Stroke::new(width as f64);
                    scene.stroke(&stroke, transform, color_to_peniko(c), None, &bezpath);
                }
            }
        }
    }
}

fn rects_intersect(a: LayoutRect, b: LayoutRect) -> bool {
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/// Convert the layout-side [`crate::layout::Affine2`] into a kurbo
/// `Affine` — both store `[a, b, c, d, e, f]` mapping
/// `(x, y) → (a·x + c·y + e, b·x + d·y + f)`, so the conversion is a
/// widening copy.
fn affine2_to_kurbo(t: crate::layout::Affine2) -> Affine {
    let [a, b, c, d, e, f] = t.0;
    Affine::new([a as f64, b as f64, c as f64, d as f64, e as f64, f as f64])
}

/// Bounding box of every item's VISUAL rect (transform-aware AABB) in
/// the subtree slice. Used as the visibility test for the whole slice —
/// if this is off-screen the painter skips the cache lookup and the
/// draw entirely.
fn subtree_bounding_rect(items: &[crate::layout::LayoutItem]) -> LayoutRect {
    debug_assert!(!items.is_empty());
    let first = items[0].visual_rect();
    let mut min_x = first.x;
    let mut min_y = first.y;
    let mut max_x = first.x + first.w;
    let mut max_y = first.y + first.h;
    for item in &items[1..] {
        let r = item.visual_rect();
        min_x = min_x.min(r.x);
        min_y = min_y.min(r.y);
        max_x = max_x.max(r.x + r.w);
        max_y = max_y.max(r.y + r.h);
    }
    LayoutRect {
        x: min_x,
        y: min_y,
        w: (max_x - min_x).max(0.0),
        h: (max_y - min_y).max(0.0),
    }
}

/// Compose the cache key for a subtree slice. Two slices produce the
/// same key iff their root + interaction-overlap is identical; under a
/// single `tree_generation`, that's exactly the set of inputs the
/// cached encoding depends on.
/// Everything a fragment replay assumes about its items' placement:
/// each rect relative to the first item's y (so a uniform shift — the
/// replay's translate — leaves it unchanged), each clip rect as is (the
/// scrollable's own rect does not move with its content; the hit path
/// compares the outer clip the same way) and radius, and the cumulative
/// transform. Paint content is not here — a changed node's fragment is
/// dropped by id instead (`invalidate_structural`).
fn fragment_geometry_digest(items: &[crate::layout::LayoutItem]) -> u64 {
    use std::hash::Hasher;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    let origin_y = items.first().map(|it| it.rect.y).unwrap_or(0.0);
    let rect = |h: &mut std::collections::hash_map::DefaultHasher, r: &LayoutRect, dy: f32| {
        h.write_u32(r.x.to_bits());
        h.write_u32((r.y - dy).to_bits());
        h.write_u32(r.w.to_bits());
        h.write_u32(r.h.to_bits());
    };
    h.write_usize(items.len());
    for item in items {
        rect(&mut h, &item.rect, origin_y);
        match &item.clip_to {
            Some(clip) => {
                h.write_u8(1);
                rect(&mut h, clip, 0.0);
            }
            None => h.write_u8(0),
        }
        h.write_u32(item.clip_radius.to_bits());
        for v in item.transform.0 {
            h.write_u32(v.to_bits());
        }
    }
    h.finish()
}

fn subtree_cache_key(
    root_id: &str,
    items: &[crate::layout::LayoutItem],
    interaction: &InteractionState,
) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    root_id.hash(&mut h);
    // Membership matters, not just the root: `emit_items` culls per
    // NODE, so a subtree whose root is on screen can be emitted with
    // some of its own descendants culled (a card taller than the cull
    // buffer). A fragment encoded from that partial slice must MISS
    // once the missing descendants scroll back in — without the ids in
    // the key it replayed the truncated encoding forever and the
    // returning descendants never painted.
    items.len().hash(&mut h);
    for item in items {
        let id = item.node_id.as_str();
        id.hash(&mut h);
        let mut state: u8 = 0;
        if interaction.hovered.contains(id) {
            state |= 0b001;
        }
        if interaction.pressed.contains(id) {
            state |= 0b010;
        }
        if interaction.focused.as_deref() == Some(id) {
            state |= 0b100;
            // The focused field's caret / selection / preedit are painted
            // into the fragment: a caret move must miss the cache.
            if let Some(sel) = interaction.input_selections.get(id) {
                (sel.anchor, sel.head).hash(&mut h);
            }
            if let Some((_, pre)) = interaction.ime_preedit.as_ref().filter(|(pid, _)| pid == id) {
                pre.hash(&mut h);
            }
        }
        state.hash(&mut h);
        if let Some(scroll) = interaction.textarea_scroll.get(id) {
            scroll.to_bits().hash(&mut h);
        }
    }
    h.finish()
}

fn item_has_bitmap(item: &crate::layout::LayoutItem) -> bool {
    matches!(item.kind, ItemKind::Image { .. })
        || item.background_image.is_some()
        || item.background_layers.as_ref().is_some_and(|layers| {
            layers
                .layers
                .iter()
                .any(|layer| matches!(layer, crate::style::BackgroundLayer::Image(_)))
        })
}

/// Push an outer-clip layer (the scrollable ancestor's rect) onto
/// `scene`. Returns `true` if a layer was pushed and the caller must
/// `pop_layer()` to balance. `Option::None` → no clip → no-op.
fn push_outer_clip(scene: &mut Scene, outer_clip: Option<LayoutRect>, clip_radius: f32) -> bool {
    let Some(clip) = outer_clip else { return false };
    let r = rounded_rect_path(clip, clip_radius);
    scene.push_layer(
        vello::peniko::Fill::NonZero,
        vello::peniko::BlendMode::default(),
        1.0,
        Affine::IDENTITY,
        &r,
    );
    true
}

/// Video v2 `Scrubber`: track + elapsed progress + thumb. Geometry is
/// shared with the CPU painter via
/// [`crate::paint::image::scrubber_geometry`], which is also what the
/// window's pointer→fraction mapping is written against.
fn draw_scrubber(scene: &mut Scene, rect: LayoutRect, fraction: f32, scale: f32) {
    let Some(g) = crate::paint::image::scrubber_geometry(rect, fraction, scale) else {
        return;
    };
    fill_rect(
        scene,
        g.track,
        crate::paint::image::SCRUBBER_TRACK_RGBA,
        g.radius,
    );
    if g.progress.w > 0.0 {
        fill_rect(
            scene,
            g.progress,
            crate::paint::image::SCRUBBER_PROGRESS_RGBA,
            g.radius,
        );
    }
    let thumb = vello::kurbo::Circle::new((g.thumb_cx as f64, g.thumb_cy as f64), g.thumb_r as f64);
    scene.fill(
        Fill::NonZero,
        Affine::IDENTITY,
        &Brush::Solid(color_to_peniko(crate::paint::image::SCRUBBER_THUMB_RGBA)),
        None,
        &thumb,
    );
}

/// Centered play affordance for a Video surface: translucent scrim
/// circle + white rounded triangle. Geometry is shared with the CPU
/// painter via [`crate::paint::image::play_glyph_geometry`] so both
/// backends draw the identical glyph.
fn draw_play_glyph(scene: &mut Scene, rect: LayoutRect, scale: f32) {
    let Some(glyph) = crate::paint::image::play_glyph_geometry(rect, scale) else {
        return;
    };
    let circle = vello::kurbo::Circle::new((glyph.cx as f64, glyph.cy as f64), glyph.radius as f64);
    scene.fill(
        Fill::NonZero,
        Affine::IDENTITY,
        &Brush::Solid(color_to_peniko(crate::paint::image::PLAY_GLYPH_CIRCLE_RGBA)),
        None,
        &circle,
    );
    // Rounded triangle: each corner replaced by a quad through the
    // vertex, mirroring `image::rounded_polygon_path`.
    let pts = glyph.triangle;
    let corner = glyph.corner;
    let towards = |from: (f32, f32), to: (f32, f32)| -> (f64, f64) {
        let dx = to.0 - from.0;
        let dy = to.1 - from.1;
        let len = (dx * dx + dy * dy).sqrt();
        if len <= f32::EPSILON {
            return (from.0 as f64, from.1 as f64);
        }
        let d = corner.min(len * 0.5);
        (
            (from.0 + dx / len * d) as f64,
            (from.1 + dy / len * d) as f64,
        )
    };
    let mut path = BezPath::new();
    for i in 0..3 {
        let p = pts[i];
        let prev = pts[(i + 2) % 3];
        let next = pts[(i + 1) % 3];
        let a = towards(p, prev);
        let b = towards(p, next);
        if i == 0 {
            path.move_to(a);
        } else {
            path.line_to(a);
        }
        path.quad_to((p.0 as f64, p.1 as f64), b);
    }
    path.close_path();
    scene.fill(
        Fill::NonZero,
        Affine::IDENTITY,
        &Brush::Solid(color_to_peniko(
            crate::paint::image::PLAY_GLYPH_TRIANGLE_RGBA,
        )),
        None,
        &path,
    );
}

fn rounded_rect_path(rect: LayoutRect, radius: f32) -> RoundedRect {
    let r = radius.min(rect.w * 0.5).min(rect.h * 0.5).max(0.0);
    RoundedRect::new(
        rect.x as f64,
        rect.y as f64,
        (rect.x + rect.w) as f64,
        (rect.y + rect.h) as f64,
        r as f64,
    )
}

fn color_to_peniko(c: Rgba) -> Color {
    Color::from_rgba8(c.0, c.1, c.2, c.3)
}

fn darken(c: Rgba, factor: f32) -> Rgba {
    Rgba(
        (c.0 as f32 * factor).clamp(0.0, 255.0) as u8,
        (c.1 as f32 * factor).clamp(0.0, 255.0) as u8,
        (c.2 as f32 * factor).clamp(0.0, 255.0) as u8,
        c.3,
    )
}

fn lighten(c: Rgba, factor: f32) -> Rgba {
    Rgba(
        ((c.0 as f32) * factor).clamp(0.0, 255.0) as u8,
        ((c.1 as f32) * factor).clamp(0.0, 255.0) as u8,
        ((c.2 as f32) * factor).clamp(0.0, 255.0) as u8,
        c.3,
    )
}

fn pixmap_to_peniko(pm: &tiny_skia::Pixmap) -> vello::peniko::ImageData {
    use vello::peniko::{Blob, ImageAlphaType, ImageData, ImageFormat};
    let blob = Blob::new(std::sync::Arc::new(pm.data().to_vec()));
    ImageData {
        data: blob,
        format: ImageFormat::Rgba8,
        alpha_type: ImageAlphaType::AlphaPremultiplied,
        width: pm.width(),
        height: pm.height(),
    }
}

fn svg_path_to_kurbo(d: &str) -> Option<BezPath> {
    use vello::kurbo::{Arc, Point, SvgArc, Vec2};
    let mut path = BezPath::new();
    let mut current = (0.0_f64, 0.0_f64);
    let mut subpath_start = (0.0_f64, 0.0_f64);
    // For Smooth* commands the implicit reflected control point is
    // taken from the previous CurveTo / SmoothCurveTo (cubic) or
    // Quadratic / SmoothQuadratic (quad) segment. Otherwise it's the
    // current point. Track the last "real" cubic / quad control so
    // S / T render correctly — Lucide's MessageCircle / Send / Heart
    // icons all rely on smooth-cubic continuations.
    let mut last_cubic_ctrl: Option<(f64, f64)> = None;
    let mut last_quad_ctrl: Option<(f64, f64)> = None;
    let parser = svgtypes::PathParser::from(d);
    for segment in parser.flatten() {
        use svgtypes::PathSegment::*;
        let mut produced_cubic_ctrl: Option<(f64, f64)> = None;
        let mut produced_quad_ctrl: Option<(f64, f64)> = None;
        match segment {
            MoveTo { abs, x, y } => {
                let to = if abs {
                    (x, y)
                } else {
                    (current.0 + x, current.1 + y)
                };
                path.move_to(to);
                current = to;
                subpath_start = to;
            }
            LineTo { abs, x, y } => {
                let to = if abs {
                    (x, y)
                } else {
                    (current.0 + x, current.1 + y)
                };
                path.line_to(to);
                current = to;
            }
            HorizontalLineTo { abs, x } => {
                let to = if abs {
                    (x, current.1)
                } else {
                    (current.0 + x, current.1)
                };
                path.line_to(to);
                current = to;
            }
            VerticalLineTo { abs, y } => {
                let to = if abs {
                    (current.0, y)
                } else {
                    (current.0, current.1 + y)
                };
                path.line_to(to);
                current = to;
            }
            CurveTo {
                abs,
                x1,
                y1,
                x2,
                y2,
                x,
                y,
            } => {
                let (c1, c2, to) = if abs {
                    ((x1, y1), (x2, y2), (x, y))
                } else {
                    (
                        (current.0 + x1, current.1 + y1),
                        (current.0 + x2, current.1 + y2),
                        (current.0 + x, current.1 + y),
                    )
                };
                path.curve_to(c1, c2, to);
                produced_cubic_ctrl = Some(c2);
                current = to;
            }
            SmoothCurveTo { abs, x2, y2, x, y } => {
                // Reflect last cubic control about current point; if
                // the previous segment was not a cubic, the reflected
                // control is the current point itself (per SVG spec).
                let c1 = match last_cubic_ctrl {
                    Some((px, py)) => (2.0 * current.0 - px, 2.0 * current.1 - py),
                    None => current,
                };
                let (c2, to) = if abs {
                    ((x2, y2), (x, y))
                } else {
                    (
                        (current.0 + x2, current.1 + y2),
                        (current.0 + x, current.1 + y),
                    )
                };
                path.curve_to(c1, c2, to);
                produced_cubic_ctrl = Some(c2);
                current = to;
            }
            Quadratic { abs, x1, y1, x, y } => {
                let (c, to) = if abs {
                    ((x1, y1), (x, y))
                } else {
                    (
                        (current.0 + x1, current.1 + y1),
                        (current.0 + x, current.1 + y),
                    )
                };
                path.quad_to(c, to);
                produced_quad_ctrl = Some(c);
                current = to;
            }
            SmoothQuadratic { abs, x, y } => {
                let c = match last_quad_ctrl {
                    Some((px, py)) => (2.0 * current.0 - px, 2.0 * current.1 - py),
                    None => current,
                };
                let to = if abs {
                    (x, y)
                } else {
                    (current.0 + x, current.1 + y)
                };
                path.quad_to(c, to);
                produced_quad_ctrl = Some(c);
                current = to;
            }
            EllipticalArc {
                abs,
                rx,
                ry,
                x_axis_rotation,
                large_arc,
                sweep,
                x,
                y,
            } => {
                let to = if abs {
                    (x, y)
                } else {
                    (current.0 + x, current.1 + y)
                };
                let svg_arc = SvgArc {
                    from: Point::new(current.0, current.1),
                    to: Point::new(to.0, to.1),
                    radii: Vec2::new(rx, ry),
                    x_rotation: x_axis_rotation.to_radians(),
                    large_arc,
                    sweep,
                };
                if svg_arc.is_straight_line() {
                    path.line_to(to);
                } else if let Some(arc) = Arc::from_svg_arc(&svg_arc) {
                    // Subdivide the arc into cubic Beziers and append.
                    // 0.1 px tolerance is plenty for icon-scale curves.
                    for el in arc.append_iter(0.1) {
                        path.push(el);
                    }
                } else {
                    path.line_to(to);
                }
                current = to;
            }
            ClosePath { .. } => {
                path.close_path();
                current = subpath_start;
            }
        }
        last_cubic_ctrl = produced_cubic_ctrl;
        last_quad_ctrl = produced_quad_ctrl;
    }
    if path.elements().is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::{LayoutItem, ScrollMeta};
    use crate::style::Border;

    fn item(id: &str, x: f32, y: f32, w: f32, h: f32) -> LayoutItem {
        LayoutItem {
            node_id: id.to_string(),
            kind: ItemKind::Container,
            rect: LayoutRect { x, y, w, h },
            action: None,
            action_payload: None,
            hover_action: None,
            hover_payload: None,
            video_intent: None,
            background: Some(Rgba(0xff, 0, 0, 0xff)),
            hover: crate::layout::HoverStyle::default(),
            shadow: None,
            border: Border::default(),
            scrollable: None,
            font_weight: 400,
            clip_to: None,
            clip_radius: 0.0,
            subtree_root: None,
            background_gradient: None,
            background_layers: None,
            background_image: None,
            state_variants: crate::style::StateVariants::default(),
            opacity: 1.0,
            transform: crate::layout::Affine2::IDENTITY,
        }
    }

    /// Item builder with explicit `subtree_root`, for subtree-cache
    /// tests. Otherwise identical to `item()`.
    fn item_in(id: &str, root: &str, x: f32, y: f32, w: f32, h: f32) -> LayoutItem {
        let mut it = item(id, x, y, w, h);
        it.subtree_root = Some(root.to_string());
        it
    }

    /// The device host UI is encoded after every app item: a real
    /// overlay layout (scrim, panel, text, buttons, a camera preview)
    /// adds paths and an image to an otherwise empty scene, and clearing
    /// it removes them again.
    #[test]
    fn device_overlay_paints_last_and_clears() {
        use crate::device::ui::{
            CameraPhase, CameraPrompt, DeviceUi, OverlayHub, PreviewFrame, Surface, SurfaceUpdate,
        };
        let empty = LayoutPass {
            items: vec![],
            content_size: (0.0, 0.0),
            by_node_id: std::collections::HashMap::new(),
            actionable_ids: vec![],
            focusable_ids: vec![],
            scrollable_ids: vec![],
            hoverable_ids: vec![],
            a11y: std::collections::HashMap::new(),
            a11y_hash: 0,
        };
        let mut painter = VelloPainter::new();
        let baseline = painter.build_scene(&empty, (800, 600), 1.0, 0.0).encoding().path_tags.len();

        let hub = std::sync::Arc::new(OverlayHub::new());
        hub.attach_window(std::sync::Arc::new(|| {}));
        let id = hub
            .show(
                Surface::Camera(CameraPrompt {
                    origin: "wss://app.example".into(),
                    video: false,
                    max_duration_ms: None,
                }),
                std::sync::Arc::new(|_| {}),
            )
            .unwrap();
        hub.update(id, SurfaceUpdate::CameraPhase(CameraPhase::Live));
        hub.update(
            id,
            SurfaceUpdate::Preview(PreviewFrame {
                width: 4,
                height: 3,
                rgba: std::sync::Arc::new(vec![200; 48]),
            }),
        );
        let mut ctl = crate::device::overlay::OverlayController::new(hub);
        ctl.sync();
        let layout = ctl
            .layout((800, 600), 1.0, std::time::Instant::now(), &mut |t: &str, size: f32, wrap: Option<f32>, weight: u16| {
                painter
                    .text_engine_mut()
                    .measure_weighted_line_height(t, size, wrap, weight, size * 1.2)
            })
            .expect("a shown surface lays out");
        assert!(layout.ops.iter().any(|o| matches!(o, crate::device::overlay::DrawOp::Image { .. })));
        painter.set_device_overlay(Some(layout));
        let with_overlay = painter.build_scene(&empty, (800, 600), 1.0, 0.0).encoding().path_tags.len();
        assert!(with_overlay > baseline, "{with_overlay} > {baseline}");
        painter.set_device_overlay(None);
        let cleared = painter.build_scene(&empty, (800, 600), 1.0, 0.0).encoding().path_tags.len();
        assert_eq!(cleared, baseline);
    }

    #[test]
    fn build_scene_skips_offscreen_items() {
        let mut painter = VelloPainter::new();
        let layout = LayoutPass {
            items: vec![
                item("visible", 100.0, 100.0, 50.0, 50.0),
                item("offscreen", 5000.0, 5000.0, 50.0, 50.0),
            ],
            content_size: (200.0, 200.0),
            by_node_id: std::collections::HashMap::new(),
            actionable_ids: vec![],
            focusable_ids: vec![],
            scrollable_ids: vec![],
            hoverable_ids: vec![],
            a11y: std::collections::HashMap::new(),
            a11y_hash: 0,
        };
        // Build is the side effect we're testing — just verify it
        // doesn't panic and produces a non-empty scene for visible
        // items only.
        let scene = painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        // A non-empty scene encodes at least one fill command.
        assert!(scene.encoding().path_tags.len() > 0);
    }

    #[cfg(feature = "dev-overlay")]
    #[test]
    fn development_metrics_paint_after_the_app_scene() {
        let layout = LayoutPass {
            items: vec![item("content", 20.0, 20.0, 80.0, 40.0)],
            content_size: (120.0, 80.0),
            by_node_id: std::collections::HashMap::new(),
            actionable_ids: vec![],
            focusable_ids: vec![],
            scrollable_ids: vec![],
            hoverable_ids: vec![],
            a11y: std::collections::HashMap::new(),
            a11y_hash: 0,
        };
        let mut plain = VelloPainter::new();
        let plain_paths = plain
            .build_scene(&layout, (400, 200), 1.0, 0.0)
            .encoding()
            .n_paths;

        let mut with_hud = VelloPainter::new();
        with_hud.set_dev_overlay("RAM 192 MB  CPU 8.0%  FRAME 8.3 ms  120 FPS", 6.0);
        let hud_paths = with_hud
            .build_scene(&layout, (400, 200), 1.0, 0.0)
            .encoding()
            .n_paths;

        assert!(
            hud_paths > plain_paths,
            "the native HUD must append its surface and glyph paths after app content"
        );
    }

    #[test]
    fn card_encodes_a_shadow_behind_its_surface() {
        let encoded_paths = |kind| {
            let mut painter = VelloPainter::new();
            let mut surface = item("surface", 20.0, 20.0, 120.0, 60.0);
            surface.kind = kind;
            surface.border.radius = 8.0;
            let layout = LayoutPass {
                items: vec![surface],
                content_size: (160.0, 100.0),
                by_node_id: std::collections::HashMap::new(),
                actionable_ids: vec![],
                focusable_ids: vec![],
                scrollable_ids: vec![],
                hoverable_ids: vec![],
                a11y: std::collections::HashMap::new(),
                a11y_hash: 0,
            };
            painter
                .build_scene(&layout, (160, 100), 1.0, 0.0)
                .encoding()
                .n_paths
        };

        let plain = encoded_paths(ItemKind::Container);
        let card = encoded_paths(ItemKind::Card);
        assert!(card > plain, "Card should add a blurred shadow path");
    }

    /// The chart draw list has to reach the GPU encoder: a chart with
    /// marks must encode strictly more paths than the same box empty, and
    /// a glow must add its halo strokes on top of that. Also the panic
    /// guard for `draw_chart` — every shape variant runs through here.
    #[test]
    fn a_chart_encodes_its_marks_and_its_glow() {
        use crate::tree::Tree;
        use serde_json::json;

        let encoded = |props: &[(&str, serde_json::Value)]| {
            let mut tree = Tree::new();
            let mut create = |id: &str, ty: &str, props: &[(&str, serde_json::Value)]| {
                let mut map: indexmap::IndexMap<String, serde_json::Value> =
                    indexmap::IndexMap::new();
                for (k, v) in props {
                    map.insert((*k).into(), v.clone());
                }
                tree.apply(&hypen_engine::Patch::Create {
                    id: id.into(),
                    element_type: ty.into(),
                    props: std::sync::Arc::new(map),
                    semantics: None,
                });
            };
            create("c", "Chart", &[]);
            create("ax", "Axis", &[("0", json!("x")), ("grid", json!(true))]);
            create(
                "ay",
                "Axis",
                &[("0", json!("y")), ("label", json!("Units"))],
            );
            create("b", "Bars", &[("data", json!([3, 1, 2]))]);
            create("l", "Line", props);
            create("a", "Area", &[("points", json!([1, 2, 3]))]);
            create("p", "Points", &[("points", json!([[0, 1]]))]);
            create("r", "Rule", &[("y", json!(2))]);
            create("q", "Path", &[("d", json!("M0,0 L2,3"))]);
            for id in ["ax", "ay", "b", "l", "a", "p", "r", "q"] {
                tree.apply(&hypen_engine::Patch::Insert {
                    parent_id: "c".into(),
                    id: id.into(),
                    before_id: None,
                });
            }
            let rect = LayoutRect {
                x: 0.0,
                y: 0.0,
                w: 320.0,
                h: 200.0,
            };
            let scene = std::sync::Arc::new(crate::chart::build_scene(
                &tree,
                "c",
                rect,
                crate::style::Viewport::new(800.0, 600.0),
                1.0,
            ));
            let mut chart = item("c", 0.0, 0.0, 320.0, 200.0);
            chart.kind = ItemKind::Chart(scene);
            let layout = LayoutPass {
                items: vec![chart],
                content_size: (320.0, 200.0),
                by_node_id: std::collections::HashMap::new(),
                actionable_ids: vec![],
                focusable_ids: vec![],
                scrollable_ids: vec![],
                hoverable_ids: vec![],
                a11y: std::collections::HashMap::new(),
                a11y_hash: 0,
            };
            VelloPainter::new()
                .build_scene(&layout, (320, 200), 1.0, 0.0)
                .encoding()
                .n_paths
        };

        let empty = {
            let layout = LayoutPass {
                items: vec![item("c", 0.0, 0.0, 320.0, 200.0)],
                content_size: (320.0, 200.0),
                by_node_id: std::collections::HashMap::new(),
                actionable_ids: vec![],
                focusable_ids: vec![],
                scrollable_ids: vec![],
                hoverable_ids: vec![],
                a11y: std::collections::HashMap::new(),
                a11y_hash: 0,
            };
            VelloPainter::new()
                .build_scene(&layout, (320, 200), 1.0, 0.0)
                .encoding()
                .n_paths
        };

        let plain = encoded(&[("points", json!([1, 2, 3]))]);
        assert!(
            plain > empty,
            "a chart's marks must encode paths ({plain} vs {empty} for an empty box)"
        );
        let glowing = encoded(&[("points", json!([1, 2, 3])), ("glow.0", json!(10))]);
        assert!(
            glowing > plain,
            "a glow adds its halo strokes behind the mark ({glowing} vs {plain})"
        );
    }

    #[test]
    fn arbitrary_angle_gradient_encodes_full_rect_axis_and_all_stops() {
        let mut scene = Scene::new();
        let rect = LayoutRect {
            x: 10.0,
            y: 20.0,
            w: 200.0,
            h: 100.0,
        };
        let gradient = crate::style::LinearGradient {
            direction: crate::style::GradientDirection::Angle(45.0),
            stops: vec![
                crate::style::GradientStop {
                    color: Rgba(0xff, 0, 0, 0xff),
                    offset: Some(0.0),
                },
                crate::style::GradientStop {
                    color: Rgba(0, 0xff, 0, 0xff),
                    offset: Some(0.5),
                },
                crate::style::GradientStop {
                    color: Rgba(0, 0, 0xff, 0xff),
                    offset: Some(1.0),
                },
            ],
        };

        fill_gradient_rect(&mut scene, rect, &gradient, 8.0);
        let encoding = scene.encoding();
        assert_eq!(encoding.n_paths, 1, "gradient should fill one rounded rect");
        assert_eq!(encoding.resources.color_stops.len(), 3);
        assert_eq!(encoding.draw_data.len(), 5);

        let decoded: Vec<f32> = encoding.draw_data[1..]
            .iter()
            .copied()
            .map(f32::from_bits)
            .collect();
        let ((sx, sy), (ex, ey)) = gradient.direction.axis(rect.x, rect.y, rect.w, rect.h);
        for (actual, expected) in decoded.into_iter().zip([sx, sy, ex, ey]) {
            assert!(
                (actual - expected).abs() < 1e-4,
                "encoded gradient coordinate {actual} != expected {expected}",
            );
        }
    }

    /// Layout helper for subtree-cache tests: one scrollable parent
    /// "feed" with three sibling subtrees "post_a", "post_b", "post_c".
    /// Each post has one item placed inside its parent's clip rect.
    fn three_post_layout() -> LayoutPass {
        let clip = LayoutRect {
            x: 0.0,
            y: 0.0,
            w: 800.0,
            h: 600.0,
        };
        let mut a = item_in("post_a", "post_a", 0.0, 0.0, 400.0, 100.0);
        a.clip_to = Some(clip);
        let mut b = item_in("post_b", "post_b", 0.0, 110.0, 400.0, 100.0);
        b.clip_to = Some(clip);
        let mut c = item_in("post_c", "post_c", 0.0, 220.0, 400.0, 100.0);
        c.clip_to = Some(clip);
        LayoutPass {
            items: vec![a, b, c],
            content_size: (400.0, 320.0),
            by_node_id: std::collections::HashMap::new(),
            actionable_ids: vec![],
            focusable_ids: vec![],
            scrollable_ids: vec![],
            hoverable_ids: vec![],
            a11y: std::collections::HashMap::new(),
            a11y_hash: 0,
        }
    }

    #[test]
    fn subtree_cache_hits_on_second_build_with_identical_inputs() {
        let mut painter = VelloPainter::new();
        let layout = three_post_layout();
        // First pass: every subtree misses (cold cache).
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_misses(), 3);
        assert_eq!(painter.subtree_cache_hits(), 0);
        assert_eq!(painter.subtree_cache_len(), 3);
        // Second pass with identical inputs: every subtree hits.
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_misses(), 3);
        assert_eq!(painter.subtree_cache_hits(), 3);
    }

    /// An image fetch landing used to drop EVERY cached fragment. Only a
    /// fragment that drew nothing for a source it was waiting on can be
    /// stale, and only once that source is decoded — the other cards in
    /// the feed keep their encodings.
    #[test]
    fn image_load_only_reencodes_fragments_that_awaited_the_landed_source() {
        use std::sync::Arc;
        let late = "test://vello-painter-late-poster";
        let mut layout = three_post_layout();
        // Bitmap-bearing items paint outside the cache; a Video poster is
        // the one image a cached fragment itself looks up.
        layout.items[1].kind = ItemKind::Video {
            poster: Some(late.to_string()),
            src: None,
            state: Default::default(),
            slots: Default::default(),
        };
        let mut painter = VelloPainter::new();
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_misses(), 3);
        assert_eq!(painter.subtree_cache_len(), 3);

        // Some other image landed: nothing these fragments awaited has
        // resolved, so every one of them replays.
        crate::paint::image::bump_image_load_generation_for_test();
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_misses(), 3);
        assert_eq!(painter.subtree_cache_hits(), 3);
        assert_eq!(painter.subtree_cache_len(), 3);

        // The poster lands: exactly the fragment that drew nothing for
        // it re-encodes; its two neighbours still hit.
        let mut pm = tiny_skia::Pixmap::new(16, 16).expect("alloc poster pixmap");
        pm.fill(tiny_skia::Color::from_rgba8(0x10, 0x20, 0x30, 0xff));
        crate::paint::image::test_seed_decoded(late, Arc::new(pm));
        crate::paint::image::bump_image_load_generation_for_test();
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_misses(), 4);
        assert_eq!(painter.subtree_cache_hits(), 5);
        assert_eq!(painter.subtree_cache_len(), 3);

        // Re-encoded against the decoded poster, the fragment awaits
        // nothing: further loads leave it alone too.
        crate::paint::image::bump_image_load_generation_for_test();
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_misses(), 4);
        assert_eq!(painter.subtree_cache_hits(), 8);
    }

    #[test]
    fn subtree_cache_reencodes_when_rounded_clip_changes() {
        let mut painter = VelloPainter::new();
        let mut layout = three_post_layout();
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_misses(), 3);

        for item in &mut layout.items {
            item.clip_radius = 16.0;
        }
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);

        assert_eq!(painter.subtree_cache_hits(), 0);
        assert_eq!(painter.subtree_cache_misses(), 6);
    }

    #[test]
    fn subtree_cache_invalidates_only_the_hovered_subtree() {
        let mut painter = VelloPainter::new();
        let layout = three_post_layout();
        // Warm the cache.
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_misses(), 3);
        // Now hover post_b. Key for post_b changes (hover state
        // toggled), but post_a / post_c keys are unchanged → they
        // hit the existing entries while post_b takes a fresh miss.
        painter
            .interaction_mut()
            .hovered
            .insert("post_b".to_string());
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_hits(), 2);
        assert_eq!(painter.subtree_cache_misses(), 4);
    }

    #[test]
    fn invalidate_subtree_cache_drops_all_entries() {
        let mut painter = VelloPainter::new();
        let layout = three_post_layout();
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_len(), 3);
        painter.invalidate_subtree_cache();
        assert_eq!(painter.subtree_cache_len(), 0);
        assert_eq!(painter.subtree_cache_hits(), 0);
        assert_eq!(painter.subtree_cache_misses(), 0);
    }

    #[test]
    fn invalidate_subtrees_containing_drops_only_affected_entries() {
        let mut painter = VelloPainter::new();
        let layout = three_post_layout();
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_len(), 3);

        // Affect post_b only: its entry drops, the other two stay and
        // hit on the next build while post_b takes a fresh miss.
        let mut affected = std::collections::HashSet::new();
        affected.insert("post_b".to_string());
        painter.invalidate_subtrees_containing(&affected);
        assert_eq!(painter.subtree_cache_len(), 2);
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_hits(), 2);
        assert_eq!(painter.subtree_cache_misses(), 4);
        assert_eq!(painter.subtree_cache_len(), 3);

        // Empty affected set is a no-op.
        painter.invalidate_subtrees_containing(&std::collections::HashSet::new());
        assert_eq!(painter.subtree_cache_len(), 3);

        // An id unknown to every entry drops nothing.
        let mut unknown = std::collections::HashSet::new();
        unknown.insert("ghost".to_string());
        painter.invalidate_subtrees_containing(&unknown);
        assert_eq!(painter.subtree_cache_len(), 3);
    }

    /// After a structural batch, fragments that encoded a patched node
    /// are dropped; every other fragment stays and replays once its
    /// geometry is re-confirmed against the new layout — a uniform shift
    /// (the posts below a removed one moving up) still replays through
    /// the translate, a reshaped fragment misses.
    #[test]
    fn structural_invalidation_keeps_fragments_whose_geometry_holds() {
        let mut painter = VelloPainter::new();
        let mut layout = three_post_layout();
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_len(), 3);

        // post_b was patched; post_c shifted up as a whole (its row
        // above it got shorter) — relative geometry unchanged.
        let mut dropped = std::collections::HashSet::new();
        dropped.insert("post_b".to_string());
        painter.invalidate_structural(&dropped);
        assert_eq!(painter.subtree_cache_len(), 2);
        layout.items[2].rect.y -= 40.0;
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(
            painter.subtree_cache_hits(),
            2,
            "post_a and the shifted post_c replay"
        );
        assert_eq!(painter.subtree_cache_misses(), 4, "only post_b re-encodes");
        assert_eq!(painter.subtree_cache_len(), 3);

        // Confirmed once, a survivor is trusted on later frames without
        // re-digesting (same hit count growth as a plain scroll frame).
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_hits(), 5);
        assert_eq!(painter.subtree_cache_misses(), 4);

        // Another structural batch touches nothing by id, but post_c
        // got wider: its fragment fails validation and re-encodes;
        // the others re-confirm and replay.
        painter.invalidate_structural(&std::collections::HashSet::new());
        assert_eq!(painter.subtree_cache_len(), 3);
        layout.items[2].rect.w += 30.0;
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_hits(), 7);
        assert_eq!(painter.subtree_cache_misses(), 5);
        assert_eq!(painter.subtree_cache_len(), 3);
    }

    /// Validation is owed per fragment, not per frame: a fragment that was
    /// off screen during the frame right after the structural batch is
    /// still checked when it next comes into view.
    #[test]
    fn structural_validation_waits_for_an_offscreen_fragment() {
        let mut painter = VelloPainter::new();
        let mut layout = three_post_layout();
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_misses(), 3);

        // post_c reshaped AND scrolled far off screen in the same batch.
        painter.invalidate_structural(&std::collections::HashSet::new());
        layout.items[2].rect.w += 30.0;
        layout.items[2].rect.y += 5000.0;
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_hits(), 2);
        assert_eq!(
            painter.subtree_cache_misses(),
            3,
            "post_c was culled, not encoded"
        );

        // Back on screen, still reshaped: the stale fragment must not
        // replay just because the validation frame has passed.
        layout.items[2].rect.y -= 5000.0;
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_hits(), 4);
        assert_eq!(
            painter.subtree_cache_misses(),
            4,
            "post_c re-encodes on return"
        );
    }

    #[test]
    fn subtree_cache_misses_when_membership_changes() {
        // Regression for the partial-subtree replay bug: `emit_items`
        // culls per node, so a subtree can be emitted with some of its
        // descendants culled (a card taller than the cull buffer). A
        // fragment encoded from that partial slice must MISS — not
        // replay translated — once the missing descendants scroll back
        // in, or they never paint again while the cache survives.
        let mut painter = VelloPainter::new();
        let clip = LayoutRect {
            x: 0.0,
            y: 0.0,
            w: 800.0,
            h: 600.0,
        };
        let with_clip = |mut it: LayoutItem| {
            it.clip_to = Some(clip);
            it
        };
        let root = with_clip(item_in("post", "post", 0.0, 0.0, 400.0, 800.0));
        let top = with_clip(item_in("post_top", "post", 0.0, 0.0, 400.0, 600.0));
        let bot = with_clip(item_in("post_bot", "post", 0.0, 600.0, 400.0, 100.0));
        let pass_for = |items: Vec<LayoutItem>| LayoutPass {
            items,
            content_size: (400.0, 800.0),
            by_node_id: std::collections::HashMap::new(),
            actionable_ids: vec![],
            focusable_ids: vec![],
            scrollable_ids: vec![],
            hoverable_ids: vec![],
            a11y: std::collections::HashMap::new(),
            a11y_hash: 0,
        };

        // Frame 1: the subtree is emitted partially (bot culled).
        let partial = pass_for(vec![root.clone(), top.clone()]);
        painter.build_scene(&partial, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_misses(), 1);
        // Same membership again: cache hit, as before.
        painter.build_scene(&partial, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_hits(), 1);

        // Frame 3: the culled descendant is back — membership changed,
        // so the truncated fragment must NOT replay.
        let full = pass_for(vec![root, top, bot]);
        painter.build_scene(&full, (800, 600), 1.0, 0.0);
        assert_eq!(
            painter.subtree_cache_hits(),
            1,
            "partial fragment must not be replayed for the full subtree"
        );
        assert_eq!(painter.subtree_cache_misses(), 2);
    }

    /// Splice validity (adversarial-review finding): replaying a
    /// cached fragment with a raw y-translate is only correct when the
    /// item's cumulative transform is that translate's conjugation of
    /// the encode-time one. Container scroll under a scaled container
    /// violates that — content really moves `s·dy` — so the hit
    /// branch must MISS and re-encode, not mispaint.
    #[test]
    fn subtree_cache_misses_when_shift_is_not_a_transform_conjugation() {
        let clip = LayoutRect {
            x: 0.0,
            y: 0.0,
            w: 800.0,
            h: 600.0,
        };
        // A fragment whose item carries a scale whose ORIGIN does not
        // move with the item (a scaled scrolled container above it):
        // simulate by keeping the transform fixed while the rect
        // shifts — exactly what `shift_container_scroll`'s exact
        // recompute produces when the scale lives on the (unmoving)
        // container.
        let fixed_scale = crate::layout::Affine2([1.5, 0.0, 0.0, 1.5, -40.0, -40.0]);
        let mut a = item_in("row", "row", 0.0, 200.0, 400.0, 100.0);
        a.clip_to = Some(clip);
        a.transform = fixed_scale;
        let pass_for = |it: LayoutItem| LayoutPass {
            items: vec![it],
            content_size: (400.0, 1000.0),
            by_node_id: std::collections::HashMap::new(),
            actionable_ids: vec![],
            focusable_ids: vec![],
            scrollable_ids: vec![],
            hoverable_ids: vec![],
            a11y: std::collections::HashMap::new(),
            a11y_hash: 0,
        };
        let mut painter = VelloPainter::new();
        painter.build_scene(&pass_for(a.clone()), (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_misses(), 1);

        // Rect shifted by container scroll; transform UNCHANGED (its
        // origin didn't move). The y-translate splice would paint the
        // row 100px off (correct motion is 150px under scale 1.5) —
        // the conjugation check must reject the hit.
        let mut shifted = a.clone();
        shifted.rect.y -= 100.0;
        painter.build_scene(&pass_for(shifted), (800, 600), 1.0, 0.0);
        assert_eq!(
            painter.subtree_cache_hits(),
            0,
            "non-conjugate shift must not replay the cached fragment"
        );
        assert_eq!(painter.subtree_cache_misses(), 2);

        // Positive control — the page-scroll analogue: rect shifted
        // AND transform conjugated by the same translate (everything
        // moved together). That splice is exact and must HIT.
        let mut b = item_in("row2", "row2", 0.0, 200.0, 400.0, 100.0);
        b.clip_to = Some(clip);
        b.transform = fixed_scale;
        let mut painter2 = VelloPainter::new();
        painter2.build_scene(&pass_for(b.clone()), (800, 600), 1.0, 0.0);
        let mut b_shifted = b.clone();
        b_shifted.rect.y -= 100.0;
        b_shifted.transform = b.transform.conjugate_translate(0.0, -100.0);
        painter2.build_scene(&pass_for(b_shifted), (800, 600), 1.0, 0.0);
        assert_eq!(
            painter2.subtree_cache_hits(),
            1,
            "a true conjugate shift keeps the fast splice"
        );
    }

    #[test]
    fn scrolled_image_subtree_draws_bitmap_directly_at_its_current_rect() {
        use std::sync::Arc;

        let src = "test://scrolled-food-card";
        let mut pixels = tiny_skia::Pixmap::new(10, 10).expect("image fixture");
        pixels.fill(tiny_skia::Color::from_rgba8(0xff, 0x80, 0x00, 0xff));
        crate::paint::image::test_seed_decoded(src, Arc::new(pixels));

        let mut image = item_in("photo", "card", 0.0, 200.0, 10.0, 10.0);
        image.kind = ItemKind::Image {
            src: Some(src.to_string()),
            fit: crate::layout::ObjectFit::Fill,
        };
        let pass_for = |item: LayoutItem| LayoutPass {
            items: vec![item],
            content_size: (300.0, 800.0),
            by_node_id: std::collections::HashMap::new(),
            actionable_ids: vec![],
            focusable_ids: vec![],
            scrollable_ids: vec![],
            hoverable_ids: vec![],
            a11y: std::collections::HashMap::new(),
            a11y_hash: 0,
        };

        let mut painter = VelloPainter::new();
        let first_at_original_y = painter
            .build_scene(&pass_for(image.clone()), (800, 600), 1.0, 0.0)
            .encoding()
            .transforms
            .iter()
            .any(|transform| (transform.translation[1] - 200.0).abs() < 0.01);
        assert!(first_at_original_y);

        image.rect.y -= 100.0;
        let shifted_scene = painter
            .build_scene(&pass_for(image), (800, 600), 1.0, 0.0)
            .encoding();
        let shifted_to_new_y = shifted_scene
            .transforms
            .iter()
            .any(|transform| (transform.translation[1] - 100.0).abs() < 0.01);

        assert_eq!(painter.subtree_cache_hits(), 0);
        assert_eq!(painter.subtree_cache_misses(), 0);
        assert_eq!(painter.subtree_cache_len(), 0);
        assert!(
            shifted_to_new_y,
            "the bitmap must be encoded directly at the scrolled card rect"
        );
    }

    #[test]
    fn mixed_image_card_caches_vector_runs_without_caching_the_bitmap() {
        use std::sync::Arc;

        let src = "test://mixed-food-card";
        let mut pixels = tiny_skia::Pixmap::new(10, 10).expect("image fixture");
        pixels.fill(tiny_skia::Color::from_rgba8(0xff, 0x80, 0x00, 0xff));
        crate::paint::image::test_seed_decoded(src, Arc::new(pixels));

        let make_pass = |offset: f32| {
            let mut surface = item_in("card", "card", 0.0, 100.0 - offset, 200.0, 180.0);
            surface.clip_to = Some(LayoutRect {
                x: 0.0,
                y: 0.0,
                w: 300.0,
                h: 400.0,
            });
            let mut image = item_in("photo", "card", 0.0, 100.0 - offset, 200.0, 100.0);
            image.kind = ItemKind::Image {
                src: Some(src.to_string()),
                fit: crate::layout::ObjectFit::Fill,
            };
            image.clip_to = surface.clip_to;
            let mut caption = item_in("caption", "card", 8.0, 208.0 - offset, 120.0, 20.0);
            caption.clip_to = surface.clip_to;
            LayoutPass {
                items: vec![surface, image, caption],
                content_size: (300.0, 800.0),
                by_node_id: std::collections::HashMap::new(),
                actionable_ids: vec![],
                focusable_ids: vec![],
                scrollable_ids: vec![],
                hoverable_ids: vec![],
                a11y: std::collections::HashMap::new(),
                a11y_hash: 0,
            }
        };

        let mut painter = VelloPainter::new();
        painter.build_scene(&make_pass(0.0), (300, 400), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_misses(), 2);
        assert_eq!(painter.subtree_cache_hits(), 0);

        let shifted_has_bitmap_transform = painter
            .build_scene(&make_pass(40.0), (300, 400), 1.0, 0.0)
            .encoding()
            .transforms
            .iter()
            .any(|transform| (transform.translation[1] - 60.0).abs() < 0.01);

        assert_eq!(painter.subtree_cache_hits(), 2);
        assert_eq!(painter.subtree_cache_misses(), 2);
        assert!(
            shifted_has_bitmap_transform,
            "the image stays direct while the surrounding vector runs hit cache"
        );
    }

    #[test]
    fn subtree_cache_clears_on_viewport_change() {
        let mut painter = VelloPainter::new();
        let layout = three_post_layout();
        painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(painter.subtree_cache_len(), 3);
        // Resize to a different viewport: cache should drop because
        // rect-relative geometry inside cached scenes is no longer
        // valid for the new clip / scrollbar / etc.
        painter.build_scene(&layout, (1024, 768), 1.0, 0.0);
        // After rebuild: 3 fresh misses, 0 hits, len still 3 (refilled).
        assert_eq!(painter.subtree_cache_hits(), 0);
        assert_eq!(painter.subtree_cache_misses(), 6);
        assert_eq!(painter.subtree_cache_len(), 3);
    }

    #[test]
    fn build_scene_with_no_visible_items_produces_empty_scene() {
        let mut painter = VelloPainter::new();
        let layout = LayoutPass {
            items: vec![],
            content_size: (0.0, 0.0),
            by_node_id: std::collections::HashMap::new(),
            actionable_ids: vec![],
            focusable_ids: vec![],
            scrollable_ids: vec![],
            hoverable_ids: vec![],
            a11y: std::collections::HashMap::new(),
            a11y_hash: 0,
        };
        let scene = painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert_eq!(scene.encoding().path_tags.len(), 0);
        let _ = ScrollMeta {
            content_h: 0.0,
            baked_offset: 0.0,
            emitted_offset: 0.0,
        }; // keep symbol referenced
    }

    #[test]
    fn pixmap_to_peniko_preserves_dimensions_and_format() {
        let mut pm = tiny_skia::Pixmap::new(8, 4).expect("alloc");
        pm.fill(tiny_skia::Color::from_rgba8(0, 128, 255, 255));
        let img = pixmap_to_peniko(&pm);
        assert_eq!(img.width, 8);
        assert_eq!(img.height, 4);
        assert_eq!(img.format, vello::peniko::ImageFormat::Rgba8);
        assert_eq!(
            img.alpha_type,
            vello::peniko::ImageAlphaType::AlphaPremultiplied
        );
        // 8 * 4 * 4 bytes (RGBA8).
        assert_eq!(img.data.len(), 8 * 4 * 4);
    }

    #[test]
    fn build_scene_culls_using_scroll_offset_baked_rects() {
        // Item rect already reflects scroll (emit_items bakes scroll_y
        // into y). Verify items above the viewport don't contribute.
        let mut painter = VelloPainter::new();
        let layout = LayoutPass {
            items: vec![
                // y = -200 is above the (0..600) viewport — should be culled.
                item("scrolled-out", 0.0, -200.0, 100.0, 50.0),
                item("on-screen", 0.0, 100.0, 100.0, 50.0),
            ],
            content_size: (100.0, 1000.0),
            by_node_id: std::collections::HashMap::new(),
            actionable_ids: vec![],
            focusable_ids: vec![],
            scrollable_ids: vec![],
            hoverable_ids: vec![],
            a11y: std::collections::HashMap::new(),
            a11y_hash: 0,
        };
        let scene = painter.build_scene(&layout, (800, 600), 1.0, 200.0);
        // At least one path encoded (the on-screen item) — and the
        // off-screen one didn't panic the encoder.
        assert!(scene.encoding().path_tags.len() > 0);
    }

    #[test]
    fn svg_path_parses_lucide_horizontal_line() {
        // The simplest Lucide command: M5 12h14 (a horizontal line).
        let path = svg_path_to_kurbo("M5 12h14").expect("non-empty path");
        assert!(path.elements().len() >= 2);
    }

    #[test]
    fn svg_path_parses_heroicon_heart_with_smooth_curves() {
        // Heroicons heart — uses relative `c` chains and the trailing
        // `s` smooth-cubic that we just added support for. If the
        // parser drops it, the icon disappears entirely.
        let d = "M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 \
                 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 \
                 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z";
        let path = svg_path_to_kurbo(d).expect("non-empty heart path");
        // Heart: 1 move + 4 cubics (3 relative + 1 absolute) + 1
        // relative cubic + 1 smooth cubic + close = 8 elements.
        assert!(
            path.elements().len() >= 6,
            "heart parsed only {} elements",
            path.elements().len()
        );
    }

    #[test]
    fn svg_path_parses_lucide_send_with_arc() {
        // Lucide send icon's fallback shape — uses an elliptical arc
        // (`A`) to round the tail, which we just added.
        let d = "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7Z";
        let path = svg_path_to_kurbo(d).expect("non-empty send path");
        assert!(path.elements().len() >= 5);
    }

    #[test]
    fn icon_renders_to_scene_with_stroke_for_currentcolor_paths() {
        // End-to-end: a Lucide-style stroked icon (fill="none",
        // stroke="currentColor") should produce stroke geometry in
        // the scene when a tint is supplied. Regression for the case
        // where `S` segments were silently dropped — the icon would
        // still parse to a few path elements but render as broken
        // line fragments (or nothing visible).
        let mut scene = Scene::new();
        let paths = vec![crate::paint::icon::IconPath {
            d: "M21 8.25c0-2.485-2.099-4.5-4.688-4.5s-3.597 \
                1.126-4.312 2.733C9.1 3.75 7 5.765 7 8.25c0 \
                7.22 9 12 9 12s9-4.78 9-12Z"
                .to_string(),
            fill: Some("none".to_string()),
            stroke: Some("currentColor".to_string()),
            stroke_width: Some(2.0),
            stroke_linecap: None,
            stroke_linejoin: None,
        }];
        let rect = LayoutRect {
            x: 0.0,
            y: 0.0,
            w: 24.0,
            h: 24.0,
        };
        draw_icon(
            &mut scene,
            rect,
            &paths,
            (0.0, 0.0, 24.0, 24.0),
            Some(Rgba(0x26, 0x26, 0x26, 0xff)),
        );
        assert!(
            !scene.encoding().path_tags.is_empty(),
            "icon produced empty scene — stroke not encoded"
        );
    }

    #[test]
    fn transformed_item_encodes_under_its_affine() {
        // Painter-level transform composition: the item's whole draw is
        // spliced into the frame scene under its cumulative affine, so
        // the ENCODING carries that transform (Vello applies transforms
        // per draw in the encoding stream, not by moving path points —
        // asserting the encoded transform IS asserting the painted
        // position).
        use crate::layout::Affine2;
        let mut painter = VelloPainter::new();
        let mut it = item("moved", 100.0, 100.0, 50.0, 50.0);
        it.transform = Affine2::translate(37.0, 19.0);
        let layout = LayoutPass {
            items: vec![it],
            content_size: (200.0, 200.0),
            by_node_id: std::collections::HashMap::new(),
            actionable_ids: vec![],
            focusable_ids: vec![],
            scrollable_ids: vec![],
            hoverable_ids: vec![],
            a11y: std::collections::HashMap::new(),
            a11y_hash: 0,
        };
        let scene = painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert!(!scene.encoding().path_tags.is_empty(), "content encoded");
        let found = scene.encoding().transforms.iter().any(|t| {
            (t.translation[0] - 37.0).abs() < 0.01
                && (t.translation[1] - 19.0).abs() < 0.01
                && (t.matrix[0] - 1.0).abs() < 0.01
                && (t.matrix[3] - 1.0).abs() < 0.01
        });
        assert!(
            found,
            "the item's affine must appear in the encoding transform stream: {:?}",
            scene.encoding().transforms
        );
    }

    #[test]
    fn transformed_item_encodes_rotation_matrix() {
        use crate::layout::Affine2;
        let mut painter = VelloPainter::new();
        let mut it = item("spun", 100.0, 100.0, 50.0, 50.0);
        // Compose like the layout post-pass does: rotate about center.
        let (cx, cy) = (125.0, 125.0);
        it.transform = Affine2::translate(cx, cy)
            .mul(&Affine2::rotate_deg(90.0))
            .mul(&Affine2::translate(-cx, -cy));
        let layout = LayoutPass {
            items: vec![it],
            content_size: (200.0, 200.0),
            by_node_id: std::collections::HashMap::new(),
            actionable_ids: vec![],
            focusable_ids: vec![],
            scrollable_ids: vec![],
            hoverable_ids: vec![],
            a11y: std::collections::HashMap::new(),
            a11y_hash: 0,
        };
        let scene = painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        // cos 90° = 0, sin 90° = 1 → matrix [0, 1, -1, 0].
        let found = scene.encoding().transforms.iter().any(|t| {
            t.matrix[0].abs() < 0.01
                && (t.matrix[1] - 1.0).abs() < 0.01
                && (t.matrix[2] + 1.0).abs() < 0.01
                && t.matrix[3].abs() < 0.01
        });
        assert!(
            found,
            "rotation must reach the encoding: {:?}",
            scene.encoding().transforms
        );
    }

    #[test]
    fn transform_does_not_drop_content_and_offscreen_transform_culls() {
        use crate::layout::Affine2;
        // Same item painted plain vs transformed encodes the same
        // number of paths (nothing dropped by the sub-scene splice)...
        let count_paths = |transform: Affine2| {
            let mut painter = VelloPainter::new();
            let mut it = item("x", 10.0, 10.0, 50.0, 50.0);
            it.transform = transform;
            let layout = LayoutPass {
                items: vec![it],
                content_size: (200.0, 200.0),
                by_node_id: std::collections::HashMap::new(),
                actionable_ids: vec![],
                focusable_ids: vec![],
                scrollable_ids: vec![],
                hoverable_ids: vec![],
                a11y: std::collections::HashMap::new(),
                a11y_hash: 0,
            };
            painter
                .build_scene(&layout, (800, 600), 1.0, 0.0)
                .encoding()
                .n_paths
        };
        let plain = count_paths(Affine2::IDENTITY);
        let moved = count_paths(Affine2::translate(30.0, 30.0));
        assert!(plain > 0);
        assert_eq!(plain, moved, "transform must not drop content");
        // ...and a transform that carries the item off-screen culls it,
        // while one that carries an off-screen rect ON-screen paints it.
        let gone = count_paths(Affine2::translate(5000.0, 5000.0));
        assert_eq!(gone, 0, "transformed-away item culls");
        let mut painter = VelloPainter::new();
        let mut it = item("back", 5000.0, 5000.0, 50.0, 50.0);
        it.transform = Affine2::translate(-4950.0, -4950.0);
        let layout = LayoutPass {
            items: vec![it],
            content_size: (200.0, 200.0),
            by_node_id: std::collections::HashMap::new(),
            actionable_ids: vec![],
            focusable_ids: vec![],
            scrollable_ids: vec![],
            hoverable_ids: vec![],
            a11y: std::collections::HashMap::new(),
            a11y_hash: 0,
        };
        let scene = painter.build_scene(&layout, (800, 600), 1.0, 0.0);
        assert!(
            scene.encoding().n_paths > 0,
            "transformed-into-view item must paint"
        );
    }

    #[test]
    fn draw_image_shares_one_cache_entry_across_rect_sizes() {
        // Regression for the per-painter image cache bug: previously
        // the cache was keyed by `(src, w, h, fit, radius)`, so the
        // same avatar drawn at w-14 AND w-7 produced two identical
        // copies of the decoded source bitmap. The key is now `src`
        // only — size/fit/radius feed the `Affine` transform instead.
        use crate::layout::ObjectFit;
        use std::sync::Arc;

        let src = "test://vello-painter-share-source";
        // Seed the global decoded-source cache so `loaded_source(src)`
        // returns synchronously without going through the async worker.
        let mut pm = tiny_skia::Pixmap::new(64, 64).expect("alloc src pixmap");
        pm.fill(tiny_skia::Color::from_rgba8(0xff, 0x80, 0x00, 0xff));
        crate::paint::image::test_seed_decoded(src, Arc::new(pm));

        let mut painter = VelloPainter::new();
        painter.clear_image_cache();

        // Same src, two very different rects — story-avatar size and
        // hot-link thumbnail size. Different fit, different radius too.
        painter.draw_image(
            LayoutRect {
                x: 0.0,
                y: 0.0,
                w: 56.0,
                h: 56.0,
            },
            Some(src),
            ObjectFit::Cover,
            8.0,
        );
        painter.draw_image(
            LayoutRect {
                x: 100.0,
                y: 100.0,
                w: 28.0,
                h: 28.0,
            },
            Some(src),
            ObjectFit::Contain,
            0.0,
        );

        assert_eq!(
            painter.image_cache_len(),
            1,
            "draws of the same src at different rects must share one cache entry; \
             got {} entries (cache key is leaking rect size again)",
            painter.image_cache_len(),
        );
        assert_eq!(
            painter.scene.encoding().n_clips,
            4,
            "each Image draw must encode a balanced clip pair, including radius=0",
        );
        assert_eq!(painter.scene.encoding().n_open_clips, 0);
    }
}
