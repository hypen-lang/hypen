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
    Rgba, BORDER_SIDES_ALL, BORDER_SIDE_BOTTOM, BORDER_SIDE_LEFT, BORDER_SIDE_RIGHT,
    BORDER_SIDE_TOP,
};
use crate::text::TextEngine;
use crate::window::Selection;
use std::collections::HashMap;
use vello::kurbo::{Affine, BezPath, Rect as KRect, RoundedRect, Stroke};
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
    /// Renderer node ids of every item encoded into this fragment.
    /// Backs [`VelloPainter::invalidate_subtrees_containing`]: a
    /// paint-only patch batch drops exactly the entries whose id set
    /// intersects the affected nodes instead of the whole cache.
    item_ids: Vec<String>,
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
}

const IMAGE_CACHE_CAP: usize = 128;
/// Subtree-scene cache cap. Each entry holds one encoded Vello
/// fragment per subtree — for a 30-post feed, that's ~30 entries; the
/// cap leaves headroom for nav between routes (Search grid cells +
/// Profile thumbnails + feed posts all keep their entries while LRU
/// trims the least-recently-painted). FIFO `shift_remove_index(0)`
/// eviction.
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
    pub fn invalidate_subtrees_containing(
        &mut self,
        affected: &std::collections::HashSet<String>,
    ) {
        if affected.is_empty() {
            return;
        }
        self.subtree_cache
            .retain(|_, entry| !entry.item_ids.iter().any(|id| affected.contains(id)));
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

    pub fn interaction_mut(&mut self) -> &mut InteractionState {
        &mut self.interaction
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
        // build. Any subtree whose images were `Loading` at encode
        // time would have rendered nothing for that Image, so we
        // drop the cache and let those subtrees re-encode with the
        // now-loaded bitmap. The cheap monotonic check here keeps
        // the steady-state hot path (no fetches in flight) free of
        // cost: AtomicU64 load + integer compare.
        let load_gen = crate::paint::image::image_load_generation();
        if load_gen != self.last_image_load_gen {
            self.subtree_cache.clear();
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
        let mut i = 0;
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
        &self.scene
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

        let key = subtree_cache_key(root_id, items, &self.interaction);
        let outer_clip = items[0].clip_to;
        let current_origin_y = items[0].rect.y;

        // Cache lookup. `self.subtree_cache` and `self.scene` are
        // disjoint fields, so Rust's borrow checker is happy with one
        // immutable borrow of the cache + one mutable borrow of the
        // scene simultaneously — no `unsafe`, no clone, no re-lookup.
        // The trick is to NOT route the append through a helper
        // method on `self` (that would mutably borrow ALL of self
        // and break the disjointness). We inline the push/append/
        // pop here instead.
        if let Some(cached) = self.subtree_cache.get(&key) {
            let dy = current_origin_y - cached.origin_y;
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
            if cached.clip_to == outer_clip && splice_valid {
                // Split-borrow: `cached.scene` reads `self.subtree_cache`,
                // `self.scene` is the disjoint mut target.
                let pushed = push_outer_clip(&mut self.scene, outer_clip);
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
        for item in items {
            self.draw_item_no_outer_clip(item, scale_factor, outer_clip);
        }
        let sub_scene = std::mem::replace(&mut self.scene, prev_scene);

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
                item_ids: items.iter().map(|it| it.node_id.clone()).collect(),
                transform: items[0].transform,
            },
        );
        // Append the just-cached scene at identity translation. Same
        // disjoint-field split-borrow as the hit branch.
        let cached = &self.subtree_cache[&key];
        let pushed = push_outer_clip(&mut self.scene, outer_clip);
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
    ) {
        // Skip the per-item clip if it matches the outer clip we
        // already pushed at the subtree level — `draw_item` would
        // re-push it otherwise. For items whose clip_to differs
        // (rare; normally everything in a subtree shares the same
        // scrollable ancestor), leave it alone. The clip is threaded
        // as a parameter so no per-item `LayoutItem` clone is needed.
        if item.clip_to == outer_clip {
            self.draw_item_with(item, scale_factor, None, item.transform);
        } else {
            self.draw_item(item, scale_factor);
        }
    }

    fn draw_item(&mut self, item: &crate::layout::LayoutItem, scale_factor: f32) {
        self.draw_item_with(item, scale_factor, item.clip_to, item.transform);
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
            self.draw_item_with(item, scale_factor, None, crate::layout::Affine2::IDENTITY);
            let sub_scene = std::mem::replace(&mut self.scene, prev_scene);
            let pushed = push_outer_clip(&mut self.scene, clip_to);
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
            let r = vello::kurbo::Rect::new(
                clip.x as f64,
                clip.y as f64,
                (clip.x + clip.w) as f64,
                (clip.y + clip.h) as f64,
            );
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
        if matches!(item.kind, ItemKind::Button) {
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
            self.draw_image(item.rect, Some(src), crate::layout::ObjectFit::Cover, radius);
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
                stroke_rect(
                    &mut self.scene,
                    item.rect,
                    border_color,
                    radius,
                    item.border.width * scale_factor,
                );
            }
        }

        match &item.kind {
            ItemKind::Container | ItemKind::Button => {
                // Background + border already drawn above.
            }
            ItemKind::Text {
                content,
                font_size,
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
                let needs_clip = matches!(*max_lines, Some(1));
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
                font_size,
                color,
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
                                crate::paint::image::loaded_source(p).is_some()
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
                let fraction =
                    crate::video_v2::scrubber_fraction(video_id.as_deref(), *preview);
                draw_scrubber(&mut self.scene, item.rect, fraction, scale_factor);
            }
            ItemKind::Icon {
                paths,
                view_box,
                tint,
            } => {
                draw_icon(&mut self.scene, item.rect, paths, *view_box, fg_override.or(*tint));
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

    fn draw_text(
        &mut self,
        item: &crate::layout::LayoutItem,
        content: &str,
        scaled_size: f32,
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
        let (line_w, _) = self
            .text
            .measure_weighted(content, scaled_size, wrap, weight);
        let dx = match align {
            TextAlign::Start => 0.0,
            TextAlign::Center => ((content_w - line_w).max(0.0)) * 0.5,
            TextAlign::End => (content_w - line_w).max(0.0),
        };
        self.text.draw_text_into_scene(
            &mut self.scene,
            content,
            content_x + dx,
            content_y,
            scaled_size,
            color,
            wrap,
            weight,
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
    ) {
        let pad_x = 12.0 * scale_factor;
        let pad_y = 8.0 * scale_factor;
        let inner_w = (item.rect.w - 2.0 * pad_x).max(0.0);
        let text_x = item.rect.x + pad_x;
        let text_y = item.rect.y + pad_y;

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
            let pm = {
                crate::paint::image::ensure_loaded_public(src);
                crate::paint::image::loaded_source(src)
            };
            let Some(pm) = pm else {
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

        if radius > 0.0 {
            // Clip to a rounded rect, draw the image, pop the clip.
            let clip_shape = rounded_rect_path(rect, radius);
            self.scene.push_layer(
                vello::peniko::Fill::NonZero,
                vello::peniko::BlendMode::default(),
                1.0,
                Affine::IDENTITY,
                &clip_shape,
            );
            self.scene.draw_image(img, transform);
            self.scene.pop_layer();
        } else {
            self.scene.draw_image(img, transform);
        }
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
    if width <= 0.0 || color.3 == 0 {
        return;
    }
    let brush = Brush::Solid(color_to_peniko(color));
    let stroke = Stroke::new(width as f64);
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
        }
        state.hash(&mut h);
    }
    h.finish()
}

/// Push an outer-clip layer (the scrollable ancestor's rect) onto
/// `scene`. Returns `true` if a layer was pushed and the caller must
/// `pop_layer()` to balance. `Option::None` → no clip → no-op.
fn push_outer_clip(scene: &mut Scene, outer_clip: Option<LayoutRect>) -> bool {
    let Some(clip) = outer_clip else { return false };
    let r = vello::kurbo::Rect::new(
        clip.x as f64,
        clip.y as f64,
        (clip.x + clip.w) as f64,
        (clip.y + clip.h) as f64,
    );
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
    let thumb = vello::kurbo::Circle::new(
        (g.thumb_cx as f64, g.thumb_cy as f64),
        g.thumb_r as f64,
    );
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
    let circle = vello::kurbo::Circle::new(
        (glyph.cx as f64, glyph.cy as f64),
        glyph.radius as f64,
    );
    scene.fill(
        Fill::NonZero,
        Affine::IDENTITY,
        &Brush::Solid(color_to_peniko(
            crate::paint::image::PLAY_GLYPH_CIRCLE_RGBA,
        )),
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
        ((from.0 + dx / len * d) as f64, (from.1 + dy / len * d) as f64)
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
            border: Border::default(),
            scrollable: None,
            font_weight: 400,
            clip_to: None,
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
        let _ = ScrollMeta { content_h: 0.0, baked_offset: 0.0, emitted_offset: 0.0 }; // keep symbol referenced
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
            painter.build_scene(&layout, (800, 600), 1.0, 0.0).encoding().n_paths
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
    }
}
