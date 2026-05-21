//! Layout pass via Taffy.
//!
//! Builds a [`TaffyTree`] mirroring the renderer tree, computes flex
//! layout, and walks back to absolute physical-pixel rects. The painter
//! and the hit-tester both consume the resulting [`Vec<LayoutItem>`] so
//! visuals and clicks agree by construction.
//!
//! Element-type → flex direction:
//!
//! - `Row` → row.
//! - `Column` / `Container` / unknown → column.
//!
//! Style props understood (`style.rs` has the full list):
//!
//! - `padding(.0|.top|.right|.bottom|.left|.horizontal|.vertical)` —
//!   container box-model padding.
//! - `gap.0` — flex gap on both axes.
//! - `fontSize.0` — overrides default text size for `Text` leaves.
//! - `color.0`, `backgroundColor.0` — read by the painter, not layout.

use crate::style::{
    border_at, has_explicit_border, margin_at, padding_at, prop_color_at, prop_dim_at, prop_f32_at,
    Border, Dim, Rgba,
};
use crate::text::TextEngine;
use crate::tree::{Tree, ROOT_ID};
use std::collections::HashMap;
use taffy::prelude::*;
use taffy::style::Overflow;

const DEFAULT_GAP_PX: f32 = 8.0;
const DEFAULT_PADDING_PX: f32 = 24.0;
const DEFAULT_BUTTON_PAD_X: f32 = 16.0;
const DEFAULT_BUTTON_PAD_Y: f32 = 10.0;
const DEFAULT_FONT_SIZE_PX: f32 = 18.0;
const DEFAULT_INPUT_MIN_W_PX: f32 = 200.0;
const DEFAULT_INPUT_PAD_X: f32 = 12.0;
const DEFAULT_INPUT_PAD_Y: f32 = 8.0;

/// Element types whose `action` prop is dispatched on click.
pub const ACTIONABLE_TYPES: &[&str] = &["Button", "Link", "Card"];

/// Element types that accept keyboard text input. Phase 7 ships `Input`;
/// `Textarea` will join when multi-line editing lands.
pub const TEXT_INPUT_TYPES: &[&str] = &["Input"];

/// Element types painted as bitmap surfaces. `Image` carries a `src`
/// URL/path; `Icon` resolves through the engine's resource registry
/// but is shaped the same here (placeholder rectangle when SVG isn't
/// rasterised yet).
pub const IMAGE_TYPES: &[&str] = &["Image", "Icon"];

/// Default text alignment when `textAlign` isn't set on a `Text`.
pub const DEFAULT_IMAGE_SIZE_PX: f32 = 60.0;

#[derive(Debug, Clone, Copy)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

#[derive(Debug, Clone)]
pub enum ItemKind {
    Text {
        content: String,
        font_size: f32,
        color: Rgba,
        align: TextAlign,
    },
    Button,
    Container,
    /// Single-line text input. The renderer keeps the live editor state
    /// (cursor, selection) in `App`, keyed by `node_id` — this struct
    /// just carries the resolved value, the placeholder, and the
    /// dotted state-binding path for `__hypen_bind` dispatches.
    Input {
        value: String,
        placeholder: Option<String>,
        bind_path: Option<String>,
        font_size: f32,
        color: Rgba,
    },
    /// Bitmap-backed `Image` / `Icon`. Phase 13 loads local file
    /// paths only; HTTP fetching lands with the network worker in a
    /// later phase. Painter falls back to a gray rounded placeholder
    /// when src is missing or unloadable.
    Image {
        src: Option<String>,
        /// CSS-style `object-fit` for how the source bitmap fills
        /// the laid-out rect. Defaults to `Fill` (independent stretch
        /// per axis), matching `<img>` semantics. `Cover` is the
        /// canonical Hypen avatar / hero-image setting.
        fit: ObjectFit,
    },
    /// Vector `Icon` whose `paths` were pre-resolved by the engine
    /// (`@resources.foo` → SVG path data). Painter rasterises the
    /// paths into the laid-out rect every frame; cheap because icons
    /// are small and the path-data parser is a tight pass.
    Icon {
        paths: Vec<crate::paint::icon::IconPath>,
        /// Min-x, min-y, width, height. Defaults to `0 0 24 24` (the
        /// usual Hypen / Lucide / Heroicons box) when absent.
        view_box: (f32, f32, f32, f32),
        /// Optional global tint that overrides each path's fill /
        /// stroke colour. Set when the user supplied `.color(red)` or
        /// `text-`-class on the icon.
        tint: Option<Rgba>,
    },
}

/// CSS-style `object-fit` for `Image` rasterisation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ObjectFit {
    /// Stretch the source independently per axis to fill the rect.
    /// Matches `<img>`'s default. Distorts non-square sources.
    #[default]
    Fill,
    /// Uniform scale to cover the rect; crops the off-axis content
    /// proportionally. Hypen's canonical avatar / hero-image fit.
    Cover,
    /// Uniform scale to fit entirely inside the rect; leaves blank
    /// bands on the off-axis when source aspect differs.
    Contain,
    /// No scaling; centred at natural size, cropped if larger than
    /// the rect.
    None,
}

pub(crate) fn parse_object_fit(s: Option<&str>) -> ObjectFit {
    match s.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("cover") => ObjectFit::Cover,
        Some("contain") => ObjectFit::Contain,
        Some("none") => ObjectFit::None,
        Some("fill") => ObjectFit::Fill,
        // `scale-down` collapses to `contain` for our purposes —
        // the difference (no upscale) only matters when the source
        // is smaller than the rect, which our cover-fit already
        // handles indistinguishably.
        Some("scale-down") => ObjectFit::Contain,
        _ => ObjectFit::Fill,
    }
}

/// Text alignment within a `Text`'s laid-out rect. Mirrors a slice of
/// CSS `text-align`: defaults to `Start`, switching to `Center` or
/// `End` when the user opts in via `.textAlign("center")` or the
/// kebab `text-align` form from tw classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TextAlign {
    #[default]
    Start,
    Center,
    End,
}

/// Per-scrollable-Container metadata. Set on a `LayoutItem` whose
/// node has `overflow: scroll` / `overflowY: auto` etc. The App
/// walks every item with `scrollable.is_some()` to route mouse-wheel
/// events and clamp scroll offsets.
#[derive(Debug, Clone, Copy)]
pub struct ScrollMeta {
    /// Total height of this scrollable's contents in physical pixels,
    /// measured from the inner top. Used to compute the maximum
    /// scroll offset (`max(0, content_h - rect.h)`).
    pub content_h: f32,
}

#[derive(Debug, Clone)]
pub struct LayoutItem {
    pub node_id: String,
    pub kind: ItemKind,
    pub rect: Rect,
    pub action: Option<String>,
    /// Optional fill. Painted under everything else for the same item.
    /// Buttons resolve to a sensible default if no `backgroundColor` was
    /// supplied; containers and text leave it `None` by default.
    pub background: Option<Rgba>,
    /// Border stroke (width + colour + radius). `Border::is_visible()`
    /// is the painter's gate.
    pub border: Border,
    /// `Some(_)` when this item is a scrollable container (Phase 16).
    /// Children are emitted with the container's current scroll offset
    /// baked into their `rect.y`; this metadata lets the App find the
    /// scrollable under the cursor and clamp its offset.
    pub scrollable: Option<ScrollMeta>,
    /// Font weight (CSS-style 100..900). Only meaningful for Text and
    /// Input items; defaults to 400 ("normal") on every item, with
    /// the painter reading it only when it draws glyphs.
    pub font_weight: u16,
}

pub struct LayoutPass {
    pub items: Vec<LayoutItem>,
    /// Tightest bounding box of all emitted items in the layout's
    /// natural (un-scrolled) coordinate space. Used by the window to
    /// clamp the scroll offset.
    pub content_size: (f32, f32),
    /// Side index: `node_id` → index into `items`. Lets every hover /
    /// click / IME / damage path that needs an item by id do an O(1)
    /// lookup instead of scanning the full vec. Built once at the end
    /// of `compute_inner_state`.
    by_node_id: HashMap<String, usize>,
    /// Indexes of `items` whose `action` is `Some(_)` — Buttons /
    /// Cards / Links. `actionables()` and `hit()` iterate this.
    actionable_ids: Vec<usize>,
    /// Indexes of focusable items (actionables + Inputs) in document
    /// order. `focus_next` / `focus_prev` walk this directly.
    focusable_ids: Vec<usize>,
    /// Indexes of items whose `scrollable` is `Some(_)`. Wheel
    /// routing iterates these (in reverse for topmost-first) instead
    /// of the full items vec.
    scrollable_ids: Vec<usize>,
}

/// Per-Taffy-node sidecar so the measure callback can look up text
/// content and font size without a back-channel into the renderer tree.
#[derive(Debug, Default)]
struct NodeContext {
    text: Option<String>,
    font_size: f32,
}

/// Retained Taffy structure across frames. The App holds one of
/// these so resize / scroll-out-of-buffer / scale invalidations
/// reuse the existing `TaffyTree` instead of allocating a fresh
/// one each frame and walking the renderer tree to rebuild it.
///
/// `structure_key` is a hash of the inputs that change the *shape*
/// of the Taffy tree (renderer-tree generation, viewport, scale —
/// the last two because tw breakpoints and HiDPI scaling are baked
/// into per-node `Style` at build time). When that key matches
/// across frames, the structure is reused. Otherwise it's torn
/// down and rebuilt.
pub struct TaffyState {
    tree: TaffyTree<NodeContext>,
    root: NodeId,
    renderer_for_taffy: HashMap<NodeId, String>,
    structure_key: u64,
}

impl TaffyState {
    pub fn new() -> Self {
        let mut tree: TaffyTree<NodeContext> = TaffyTree::new();
        // Dummy root; replaced on first structure rebuild.
        let root = tree
            .new_leaf(Style::default())
            .expect("taffy root placeholder");
        Self {
            tree,
            root,
            renderer_for_taffy: HashMap::new(),
            structure_key: 0,
        }
    }
}

impl Default for TaffyState {
    fn default() -> Self {
        Self::new()
    }
}

fn taffy_structure_key(tree_generation: u64, viewport: (u32, u32), scale: f32) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    tree_generation.hash(&mut h);
    viewport.0.hash(&mut h);
    viewport.1.hash(&mut h);
    scale.to_bits().hash(&mut h);
    h.finish()
}

impl LayoutPass {
    /// Convenience for callers that don't need scrolling — equivalent
    /// Convenience for tests / static screenshots that want every
    /// item in the tree, regardless of whether it falls within the
    /// viewport. The App always wants culling, so the public
    /// scroll-aware entry points pass `cull = true` internally.
    pub fn compute(
        tree: &Tree,
        text: &mut TextEngine,
        viewport: (u32, u32),
        scale: f32,
    ) -> Self {
        Self::compute_inner(tree, text, viewport, scale, 0.0, &HashMap::new(), false)
    }

    /// Page-only scroll, no culling — kept for tests and the demo
    /// pre-renders. Production callers go through
    /// [`Self::compute_with_scrolls`] which culls off-viewport
    /// subtrees.
    pub fn compute_with_scroll(
        tree: &Tree,
        text: &mut TextEngine,
        viewport: (u32, u32),
        scale: f32,
        scroll_y: f32,
    ) -> Self {
        Self::compute_inner(tree, text, viewport, scale, scroll_y, &HashMap::new(), false)
    }

    /// Run a full layout pass with both page-level `scroll_y` (physical
    /// px subtracted from every emitted item) and per-Container scroll
    /// offsets. `scrolls` maps a scrollable container's `node_id` to
    /// its current vertical scroll offset (positive = scrolled down).
    /// Descendants of each scrollable container have its offset
    /// subtracted from their `y` *in addition to* the page scroll, so
    /// nested scrollables compose correctly. Items fully outside the
    /// viewport (with one viewport-height of buffer on each side)
    /// are skipped at emit time so paint / hit-test / a11y work
    /// scales with visible content rather than feed length.
    pub fn compute_with_scrolls(
        tree: &Tree,
        text: &mut TextEngine,
        viewport: (u32, u32),
        scale: f32,
        scroll_y: f32,
        scrolls: &HashMap<String, f32>,
    ) -> Self {
        Self::compute_inner(tree, text, viewport, scale, scroll_y, scrolls, true)
    }

    /// Layout entry point used by `App.redraw` — keeps `TaffyState`
    /// across frames so resize / scroll-out-of-buffer / scale changes
    /// don't pay the cost of a fresh `TaffyTree` allocation + full
    /// renderer-tree walk every time. Structure rebuilds only when
    /// `(tree_generation, viewport, scale)` changes; other
    /// invalidations (page scroll position, per-Container scroll
    /// state) reuse the existing tree and just re-run
    /// `compute_layout` + emit.
    pub fn compute_with_state(
        state: &mut TaffyState,
        tree: &Tree,
        text: &mut TextEngine,
        viewport: (u32, u32),
        scale: f32,
        scroll_y: f32,
        scrolls: &HashMap<String, f32>,
        tree_generation: u64,
    ) -> Self {
        Self::compute_inner_state(state, tree, text, viewport, scale, scroll_y, scrolls, tree_generation, true)
    }

    fn compute_inner(
        tree: &Tree,
        text: &mut TextEngine,
        viewport: (u32, u32),
        scale: f32,
        scroll_y: f32,
        scrolls: &HashMap<String, f32>,
        cull: bool,
    ) -> Self {
        // One-shot entry for tests + demo pre-renders. Spins up a
        // fresh `TaffyState` so back-compat callers keep working
        // without threading retention through every site.
        let mut state = TaffyState::new();
        Self::compute_inner_state(&mut state, tree, text, viewport, scale, scroll_y, scrolls, 0, cull)
    }

    #[allow(clippy::too_many_arguments)]
    fn compute_inner_state(
        state: &mut TaffyState,
        tree: &Tree,
        text: &mut TextEngine,
        viewport: (u32, u32),
        scale: f32,
        scroll_y: f32,
        scrolls: &HashMap<String, f32>,
        tree_generation: u64,
        cull: bool,
    ) -> Self {
        let key = taffy_structure_key(tree_generation, viewport, scale);
        let viewport_w_px = viewport.0 as f32;

        if state.structure_key != key {
            // Rebuild structure. Reuse the `TaffyState` allocation
            // by replacing the inner `TaffyTree` (`TaffyTree::new()`
            // re-allocates the slotmap; the held HashMap clears in
            // place).
            state.tree = TaffyTree::new();
            state.renderer_for_taffy.clear();
            let mut root_children = Vec::new();
            for child_id in tree.root_children() {
                if let Some(node_id) = build_subtree(
                    &mut state.tree,
                    tree,
                    child_id,
                    scale,
                    viewport_w_px,
                    &mut state.renderer_for_taffy,
                ) {
                    root_children.push(node_id);
                }
            }
            let pad = DEFAULT_PADDING_PX * scale;
            let outer_style = Style {
                display: Display::Flex,
                flex_direction: FlexDirection::Column,
                padding: Rect_::length(pad),
                gap: Size {
                    width: length(DEFAULT_GAP_PX * scale),
                    height: length(DEFAULT_GAP_PX * scale),
                },
                size: Size {
                    width: length(viewport.0 as f32),
                    height: length(viewport.1 as f32),
                },
                ..Default::default()
            };
            state.root = state
                .tree
                .new_with_children(outer_style, &root_children)
                .expect("taffy root node");
            state.structure_key = key;
        }
        let root = state.root;
        let taffy = &mut state.tree;
        let renderer_for_taffy = &state.renderer_for_taffy;

        let available = Size {
            width: AvailableSpace::Definite(viewport.0 as f32),
            height: AvailableSpace::Definite(viewport.1 as f32),
        };
        let measure = |known: Size<Option<f32>>,
                       avail: Size<AvailableSpace>,
                       _node_id: NodeId,
                       ctx: Option<&mut NodeContext>,
                       _style: &Style|
         -> Size<f32> {
            let Some(ctx) = ctx else {
                return Size::ZERO;
            };
            let Some(text_content) = ctx.text.as_deref() else {
                return Size::ZERO;
            };
            // Wrap to whatever width the parent has told us about. Prefer
            // a known/definite constraint; fall back to the available
            // space if it's bounded; if both are unknown, no wrap.
            let wrap_width = known.width.or(match avail.width {
                AvailableSpace::Definite(w) => Some(w),
                AvailableSpace::MinContent | AvailableSpace::MaxContent => None,
            });
            let (w, h) = text.measure(text_content, ctx.font_size, wrap_width);
            Size {
                width: known.width.unwrap_or(w),
                height: known.height.unwrap_or(h),
            }
        };

        if let Err(e) = taffy.compute_layout_with_measure(root, available, measure) {
            log::warn!("taffy layout failed: {e:?}");
        }

        // Walk and emit absolute-rect items in natural (un-scrolled)
        // coordinates first so we can capture the true content size.
        let mut items = Vec::new();
        let mut content_size = (0.0_f32, 0.0_f32);
        // Cull subtrees outside the viewport (with one viewport-
        // height of buffer above + below for smooth scroll-in).
        // The cull viewport is in NATURAL (pre-page-scroll) item
        // coordinates: emit_items writes `rect.y = natural - any
        // ancestor container shifts`, and page scroll is applied as
        // a separate post-pass — so the cull's `y` origin must be
        // `scroll_y` to track which items are actually on-screen.
        // Items emitted here feed every downstream walk — paint,
        // hit-test, AccessKit, raster cache lookups — so culling
        // here bounds frame work to visible content. Tests that
        // need to inspect off-screen layout call the test-facing
        // `LayoutPass::compute*` wrappers which thread `cull = false`.
        let cull_viewport = if cull {
            Some(Rect {
                x: 0.0,
                y: scroll_y,
                w: viewport.0 as f32,
                h: viewport.1 as f32,
            })
        } else {
            None
        };
        emit_items(
            &taffy,
            root,
            0.0,
            0.0,
            0.0,
            tree,
            &renderer_for_taffy,
            viewport_w_px,
            scrolls,
            &mut items,
            &mut content_size,
            cull_viewport,
        );

        // Apply scroll. Phase 8 only scrolls the page vertically;
        // horizontal can come when we expose Container::overflow.
        if scroll_y != 0.0 {
            for it in items.iter_mut() {
                it.rect.y -= scroll_y;
            }
        }

        let mut by_node_id = HashMap::with_capacity(items.len());
        let mut actionable_ids = Vec::new();
        let mut focusable_ids = Vec::new();
        let mut scrollable_ids = Vec::new();
        for (idx, it) in items.iter().enumerate() {
            by_node_id.insert(it.node_id.clone(), idx);
            if it.action.is_some() {
                actionable_ids.push(idx);
            }
            if it.is_focusable() {
                focusable_ids.push(idx);
            }
            if it.scrollable.is_some() {
                scrollable_ids.push(idx);
            }
        }

        Self {
            items,
            content_size,
            by_node_id,
            actionable_ids,
            focusable_ids,
            scrollable_ids,
        }
    }

    /// O(1) item lookup by renderer node id.
    pub fn item_by_id(&self, id: &str) -> Option<&LayoutItem> {
        self.by_node_id.get(id).map(|&i| &self.items[i])
    }

    pub fn hit(&self, x: f32, y: f32) -> Option<&LayoutItem> {
        // Walk actionables in reverse paint order — topmost wins.
        // O(n_actionables) instead of O(n_items).
        self.actionable_ids
            .iter()
            .rev()
            .map(|&i| &self.items[i])
            .find(|it| it.rect.contains(x, y))
    }

    /// Topmost focusable item under the cursor — actionables OR text
    /// inputs. Used by mouse-down to choose a focus target (clicking
    /// an Input focuses it for typing; clicking a Button focuses *and*
    /// the matching mouse-up dispatches its action).
    pub fn hit_focusable(&self, x: f32, y: f32) -> Option<&LayoutItem> {
        self.focusable_ids
            .iter()
            .rev()
            .map(|&i| &self.items[i])
            .find(|it| it.rect.contains(x, y))
    }

    /// Topmost scrollable Container under the cursor. Used by the
    /// wheel handler to route scroll to the innermost scrollable.
    pub fn hit_scrollable(&self, x: f32, y: f32) -> Option<&LayoutItem> {
        self.scrollable_ids
            .iter()
            .rev()
            .map(|&i| &self.items[i])
            .find(|it| it.rect.contains(x, y))
    }

    /// All actionable items in document (paint) order.
    pub fn actionables(&self) -> impl Iterator<Item = &LayoutItem> {
        self.actionable_ids.iter().map(|&i| &self.items[i])
    }

    /// All focusable items in document order — actionables + text inputs.
    pub fn focusables(&self) -> impl Iterator<Item = &LayoutItem> {
        self.focusable_ids.iter().map(|&i| &self.items[i])
    }

    /// Node id of the focusable that follows `current` in document
    /// order. If `current` is `None` or unknown, returns the first
    /// focusable. If `current` is the last, wraps to the first.
    pub fn focus_next(&self, current: Option<&str>) -> Option<String> {
        if self.focusable_ids.is_empty() {
            return None;
        }
        let idx = current
            .and_then(|c| {
                self.focusable_ids
                    .iter()
                    .position(|&i| self.items[i].node_id == c)
            })
            .map(|i| (i + 1) % self.focusable_ids.len())
            .unwrap_or(0);
        Some(self.items[self.focusable_ids[idx]].node_id.clone())
    }

    /// Node id of the focusable that precedes `current` in document
    /// order. Wraps to the last when `current` is the first.
    pub fn focus_prev(&self, current: Option<&str>) -> Option<String> {
        let n = self.focusable_ids.len();
        if n == 0 {
            return None;
        }
        let idx = current
            .and_then(|c| {
                self.focusable_ids
                    .iter()
                    .position(|&i| self.items[i].node_id == c)
            })
            .map(|i| (i + n - 1) % n)
            .unwrap_or(n - 1);
        Some(self.items[self.focusable_ids[idx]].node_id.clone())
    }
}

impl LayoutItem {
    /// True for items that take focus on click / Tab — actionables
    /// (Buttons, Cards, Links) plus text-input elements.
    pub fn is_focusable(&self) -> bool {
        self.action.is_some() || matches!(self.kind, ItemKind::Input { .. })
    }
}

// ---------------------------------------------------------------------------
// Build phase: renderer tree → Taffy tree.
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn build_subtree(
    taffy: &mut TaffyTree<NodeContext>,
    tree: &Tree,
    node_id: &str,
    scale: f32,
    viewport_w: f32,
    renderer_for_taffy: &mut HashMap<NodeId, String>,
) -> Option<NodeId> {
    let node = tree.get(node_id)?;

    match node.element_type.as_str() {
        et if IMAGE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
            // Images sized by `width` / `height` (px or %), with
            // `.size(N)` as the square-fallback (icons use this).
            // Percent maps to Taffy's `Dimension::Percent` so an
            // Image with `.width("100%")` fills its parent column.
            let size_fallback = prop_f32_at(node, "size", viewport_w);
            let w_dim = prop_dim_at(node, "width", viewport_w);
            let h_dim = prop_dim_at(node, "height", viewport_w);
            let aspect_ratio = prop_f32_at(node, "aspectRatio", viewport_w);

            // When neither axis is set, fall back to .size or default.
            let default_len = size_fallback.unwrap_or(DEFAULT_IMAGE_SIZE_PX);
            let width = match w_dim {
                Some(Dim::Length(v)) => Dimension::length(v * scale),
                Some(Dim::Percent(p)) => Dimension::percent(p),
                None => Dimension::length(default_len * scale),
            };
            let height = match h_dim {
                Some(Dim::Length(v)) => Dimension::length(v * scale),
                Some(Dim::Percent(p)) => Dimension::percent(p),
                None if aspect_ratio.is_some() => Dimension::auto(),
                None => Dimension::length(default_len * scale),
            };
            // `flex_shrink: 0` keeps the image from being shrunk to 0
            // by sibling flex children when its width is `Percent` —
            // without this an image with `.width("100%")` collapses to
            // its content size (0) inside a horizontal flex parent.
            let mut style = Style {
                display: Display::Flex,
                size: Size { width, height },
                aspect_ratio,
                flex_shrink: 0.0,
                margin: margin_to_taffy(margin_at(node, viewport_w), scale),
                border: border_to_taffy(border_at(node, viewport_w), scale),
                ..Default::default()
            };
            apply_flex_props(&mut style, node, viewport_w, scale);
            apply_alignment_props(&mut style, node, viewport_w);
            apply_size_props(&mut style, node, viewport_w, scale);
            let id = taffy.new_leaf(style).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et if TEXT_INPUT_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
            // Inputs are leaf flex nodes with their own padding + a
            // sensible minimum width so they don't collapse to nothing
            // in horizontal layouts.
            let pad_x = DEFAULT_INPUT_PAD_X * scale;
            let pad_y = DEFAULT_INPUT_PAD_Y * scale;
            let mut style = Style {
                display: Display::Flex,
                min_size: Size {
                    width: length(DEFAULT_INPUT_MIN_W_PX * scale),
                    height: length((DEFAULT_FONT_SIZE_PX * 1.3) * scale + 2.0 * pad_y),
                },
                padding: Rect_ {
                    left: length(pad_x),
                    right: length(pad_x),
                    top: length(pad_y),
                    bottom: length(pad_y),
                },
                margin: margin_to_taffy(margin_at(node, viewport_w), scale),
                border: border_to_taffy(border_at(node, viewport_w), scale),
                ..Default::default()
            };
            apply_flex_props(&mut style, node, viewport_w, scale);
            apply_alignment_props(&mut style, node, viewport_w);
            apply_size_props(&mut style, node, viewport_w, scale);
            let id = taffy.new_leaf(style).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        "Text" => {
            let font_size = prop_f32_at(node, "fontSize", viewport_w)
                .map(|v| v * scale)
                .unwrap_or(DEFAULT_FONT_SIZE_PX * scale);
            let content = node.text_content().unwrap_or("").to_string();
            // Text leaves DO take padding / margin / border like any
            // other flex node — `tw("text-sm font-semibold px-4")` on
            // a Text was being silently dropped because the Text
            // branch only set `display: Flex` and forgot the box
            // model. `px-4` then collapsed to zero, and the user saw
            // "1421 likes" rendered flush-left instead of indented.
            let pad = padding_at(node, viewport_w);
            let mut style = Style {
                display: Display::Flex,
                padding: Rect_ {
                    left: length(pad.left * scale),
                    right: length(pad.right * scale),
                    top: length(pad.top * scale),
                    bottom: length(pad.bottom * scale),
                },
                margin: margin_to_taffy(margin_at(node, viewport_w), scale),
                border: border_to_taffy(border_at(node, viewport_w), scale),
                ..Default::default()
            };
            apply_flex_props(&mut style, node, viewport_w, scale);
            apply_alignment_props(&mut style, node, viewport_w);
            apply_size_props(&mut style, node, viewport_w, scale);
            let id = taffy
                .new_leaf_with_context(
                    style,
                    NodeContext {
                        text: Some(content),
                        font_size,
                    },
                )
                .ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et if ACTIONABLE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
            // Buttons are flex containers with their own default padding
            // unless overridden by .padding(...).
            let pad = padding_at(node, viewport_w);
            let pad_x = if pad.left == 0.0 && pad.right == 0.0 {
                DEFAULT_BUTTON_PAD_X
            } else {
                (pad.left + pad.right) * 0.5
            };
            let pad_y = if pad.top == 0.0 && pad.bottom == 0.0 {
                DEFAULT_BUTTON_PAD_Y
            } else {
                (pad.top + pad.bottom) * 0.5
            };
            let mut style = Style {
                display: Display::Flex,
                flex_direction: FlexDirection::Row,
                align_items: Some(AlignItems::Center),
                justify_content: Some(JustifyContent::Center),
                padding: Rect_ {
                    left: length(pad.left.max(pad_x) * scale),
                    right: length(pad.right.max(pad_x) * scale),
                    top: length(pad.top.max(pad_y) * scale),
                    bottom: length(pad.bottom.max(pad_y) * scale),
                },
                margin: margin_to_taffy(margin_at(node, viewport_w), scale),
                border: border_to_taffy(border_at(node, viewport_w), scale),
                gap: Size {
                    width: length(prop_f32_at(node, "gap", viewport_w).unwrap_or(4.0) * scale),
                    height: length(0.0),
                },
                overflow: taffy::Point {
                    x: Overflow::Visible,
                    y: Overflow::Visible,
                },
                ..Default::default()
            };
            apply_flex_props(&mut style, node, viewport_w, scale);
            apply_alignment_props(&mut style, node, viewport_w);
            apply_size_props(&mut style, node, viewport_w, scale);
            let mut children = Vec::new();
            for child_id in tree.children_of(node_id) {
                if let Some(c) = build_subtree(taffy, tree, child_id, scale, viewport_w, renderer_for_taffy) {
                    children.push(c);
                }
            }
            let id = taffy.new_with_children(style, &children).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et if et.eq_ignore_ascii_case("Stack") => {
            // Stack overlaps its children at the parent's origin.
            // The first child lays out normally and sizes the
            // parent (the "base" — typically the avatar in
            // `Stack { Image, BadgeOverlay }`); subsequent children
            // are `position: absolute` so they paint over the base
            // without claiming flex space. Honours `marginTop` /
            // `marginLeft` on overlay children as offsets from the
            // top-left, matching how the web Stack handler uses
            // CSS Grid + grid-template-areas to overlay children at
            // the same origin.
            let pad = padding_at(node, viewport_w);
            let mut style = Style {
                display: Display::Flex,
                padding: Rect_ {
                    left: length(pad.left * scale),
                    right: length(pad.right * scale),
                    top: length(pad.top * scale),
                    bottom: length(pad.bottom * scale),
                },
                margin: margin_to_taffy(margin_at(node, viewport_w), scale),
                border: border_to_taffy(border_at(node, viewport_w), scale),
                ..Default::default()
            };
            apply_flex_props(&mut style, node, viewport_w, scale);
            apply_alignment_props(&mut style, node, viewport_w);
            apply_size_props(&mut style, node, viewport_w, scale);
            let mut children = Vec::new();
            for child_id in tree.children_of(node_id) {
                if let Some(c) =
                    build_subtree(taffy, tree, child_id, scale, viewport_w, renderer_for_taffy)
                {
                    children.push(c);
                }
            }
            // Mark every child after the first as absolute. Their
            // existing margins resolve into `inset` for the absolute
            // positioning, so `.marginTop(36).marginLeft(36)` on a
            // badge overlay anchors at +36/+36 from the parent's
            // top-left instead of pushing into flex flow.
            for &child in children.iter().skip(1) {
                if let Ok(mut s) = taffy.style(child).cloned() {
                    s.position = Position::Absolute;
                    let m = s.margin;
                    s.inset = Rect_ {
                        top: length_or_zero_lpa(m.top),
                        right: LengthPercentageAuto::auto(),
                        bottom: LengthPercentageAuto::auto(),
                        left: length_or_zero_lpa(m.left),
                    };
                    s.margin = Rect_ {
                        top: LengthPercentageAuto::length(0.0),
                        right: LengthPercentageAuto::length(0.0),
                        bottom: LengthPercentageAuto::length(0.0),
                        left: LengthPercentageAuto::length(0.0),
                    };
                    let _ = taffy.set_style(child, s);
                }
            }
            let id = taffy.new_with_children(style, &children).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et => {
            let dir = if et.eq_ignore_ascii_case("Row") {
                FlexDirection::Row
            } else {
                FlexDirection::Column
            };
            let pad = padding_at(node, viewport_w);
            let gap_v = prop_f32_at(node, "gap", viewport_w).unwrap_or(DEFAULT_GAP_PX) * scale;
            let mut style = Style {
                display: Display::Flex,
                flex_direction: dir,
                padding: Rect_ {
                    left: length(pad.left * scale),
                    right: length(pad.right * scale),
                    top: length(pad.top * scale),
                    bottom: length(pad.bottom * scale),
                },
                margin: margin_to_taffy(margin_at(node, viewport_w), scale),
                border: border_to_taffy(border_at(node, viewport_w), scale),
                gap: Size {
                    width: length(gap_v),
                    height: length(gap_v),
                },
                ..Default::default()
            };
            apply_flex_props(&mut style, node, viewport_w, scale);
            apply_alignment_props(&mut style, node, viewport_w);
            apply_size_props(&mut style, node, viewport_w, scale);
            let mut children = Vec::new();
            for child_id in tree.children_of(node_id) {
                if let Some(c) = build_subtree(taffy, tree, child_id, scale, viewport_w, renderer_for_taffy) {
                    children.push(c);
                }
            }
            let id = taffy.new_with_children(style, &children).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
    }
}

/// Map a `LengthPercentageAuto` value through to the same flavour for
/// the inset axis (preserving Auto / Length / Percent semantics).
fn length_or_zero_lpa(v: LengthPercentageAuto) -> LengthPercentageAuto {
    // Auto margins on absolutely-positioned children produce
    // unstable insets; clamp to zero so the overlay anchors at the
    // parent's edge by default.
    if v == LengthPercentageAuto::auto() {
        LengthPercentageAuto::length(0.0)
    } else {
        v
    }
}

/// Read `width` / `height` props (px or %) and apply to the Style's
/// `size`. Touches every container kind so explicit sizing on
/// generic Columns / Rows / Containers behaves like every other
/// renderer instead of always falling through to content size.
fn apply_size_props(style: &mut Style, node: &crate::tree::Node, viewport_w: f32, scale: f32) {
    if let Some(d) = prop_dim_at(node, "width", viewport_w) {
        style.size.width = match d {
            Dim::Length(v) => Dimension::length(v * scale),
            Dim::Percent(p) => Dimension::percent(p),
        };
    }
    if let Some(d) = prop_dim_at(node, "height", viewport_w) {
        style.size.height = match d {
            Dim::Length(v) => Dimension::length(v * scale),
            Dim::Percent(p) => Dimension::percent(p),
        };
    }
    if let Some(d) = prop_dim_at(node, "minWidth", viewport_w) {
        style.min_size.width = match d {
            Dim::Length(v) => Dimension::length(v * scale),
            Dim::Percent(p) => Dimension::percent(p),
        };
    }
    if let Some(d) = prop_dim_at(node, "minHeight", viewport_w) {
        style.min_size.height = match d {
            Dim::Length(v) => Dimension::length(v * scale),
            Dim::Percent(p) => Dimension::percent(p),
        };
    }
    if let Some(d) = prop_dim_at(node, "maxWidth", viewport_w) {
        style.max_size.width = match d {
            Dim::Length(v) => Dimension::length(v * scale),
            Dim::Percent(p) => Dimension::percent(p),
        };
    }
    if let Some(d) = prop_dim_at(node, "maxHeight", viewport_w) {
        style.max_size.height = match d {
            Dim::Length(v) => Dimension::length(v * scale),
            Dim::Percent(p) => Dimension::percent(p),
        };
    }
}

/// Apply alignment props (`align-items`, `align-self`,
/// `justify-content`, `justify-self`). Without this, tw
/// `items-center` / `justify-center` were silently dropped and
/// children stretched to fill the cross-axis — that's what made
/// the StoryItem's circular border container render as an ellipse
/// (the inner container with `rounded-full` was being stretched
/// horizontally to match its parent's width via the default flex
/// `align-items: stretch`).
fn apply_alignment_props(style: &mut Style, node: &crate::tree::Node, viewport_w: f32) {
    use crate::style::prop_str_at;
    if let Some(s) = prop_str_at(node, "alignItems", viewport_w) {
        if let Some(a) = parse_align(&s) {
            style.align_items = Some(a);
        }
    }
    if let Some(s) = prop_str_at(node, "alignSelf", viewport_w) {
        if let Some(a) = parse_align(&s) {
            style.align_self = Some(a);
        }
    }
    if let Some(s) = prop_str_at(node, "justifyContent", viewport_w) {
        if let Some(j) = parse_justify(&s) {
            style.justify_content = Some(j);
        }
    }
    if let Some(s) = prop_str_at(node, "justifySelf", viewport_w) {
        if let Some(a) = parse_align(&s) {
            style.justify_self = Some(a);
        }
    }
}

fn parse_align(s: &str) -> Option<AlignItems> {
    match s.trim().to_ascii_lowercase().as_str() {
        "start" | "flex-start" => Some(AlignItems::Start),
        "center" => Some(AlignItems::Center),
        "end" | "flex-end" => Some(AlignItems::End),
        "stretch" => Some(AlignItems::Stretch),
        "baseline" => Some(AlignItems::Baseline),
        _ => None,
    }
}

fn parse_justify(s: &str) -> Option<JustifyContent> {
    match s.trim().to_ascii_lowercase().as_str() {
        "start" | "flex-start" => Some(JustifyContent::Start),
        "center" => Some(JustifyContent::Center),
        "end" | "flex-end" => Some(JustifyContent::End),
        "space-between" => Some(JustifyContent::SpaceBetween),
        "space-around" => Some(JustifyContent::SpaceAround),
        "space-evenly" => Some(JustifyContent::SpaceEvenly),
        "stretch" => Some(JustifyContent::Stretch),
        _ => None,
    }
}

/// Apply CSS-style flex shorthand and per-axis flex props onto
/// `style`. Reads `flex` (`"1"`, `"auto"`, `"none"`), `flexGrow`,
/// `flexShrink`, `flexBasis`. Without this, every node ran with the
/// Taffy defaults (`grow: 0, shrink: 1, basis: auto`) and tw
/// `flex-1` / `shrink-0` were silently dropped — that's why the
/// social example's "Hypengram" title shrunk and wrapped mid-word
/// instead of growing to fill the row.
fn apply_flex_props(style: &mut Style, node: &crate::tree::Node, viewport_w: f32, scale: f32) {
    use crate::style::{prop_dim_at, prop_f32_at, prop_str_at, Dim};
    if let Some(s) = prop_str_at(node, "flex", viewport_w) {
        match s.trim() {
            "auto" => {
                style.flex_grow = 1.0;
                style.flex_shrink = 1.0;
                style.flex_basis = Dimension::auto();
            }
            "none" => {
                style.flex_grow = 0.0;
                style.flex_shrink = 0.0;
                style.flex_basis = Dimension::auto();
            }
            "initial" => {}
            n => {
                if let Ok(num) = n.parse::<f32>() {
                    style.flex_grow = num;
                    style.flex_shrink = 1.0;
                    style.flex_basis = Dimension::percent(0.0);
                }
            }
        }
    }
    if let Some(g) = prop_f32_at(node, "flexGrow", viewport_w) {
        style.flex_grow = g;
    }
    if let Some(sh) = prop_f32_at(node, "flexShrink", viewport_w) {
        style.flex_shrink = sh;
    }
    if let Some(b) = prop_dim_at(node, "flexBasis", viewport_w) {
        style.flex_basis = match b {
            Dim::Length(v) => Dimension::length(v * scale),
            Dim::Percent(p) => Dimension::percent(p),
        };
    }
}

fn margin_to_taffy(m: crate::style::Padding, scale: f32) -> Rect_<LengthPercentageAuto> {
    Rect_ {
        left: LengthPercentageAuto::length(m.left * scale),
        right: LengthPercentageAuto::length(m.right * scale),
        top: LengthPercentageAuto::length(m.top * scale),
        bottom: LengthPercentageAuto::length(m.bottom * scale),
    }
}

fn border_to_taffy(b: Border, scale: f32) -> Rect_<LengthPercentage> {
    let w = if b.is_visible() { b.width * scale } else { 0.0 };
    Rect_ {
        left: length(w),
        right: length(w),
        top: length(w),
        bottom: length(w),
    }
}

// ---------------------------------------------------------------------------
// Walk phase: Taffy tree → flat absolute-positioned LayoutItem list.
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn emit_items(
    taffy: &TaffyTree<NodeContext>,
    node_id: NodeId,
    parent_x: f32,
    parent_y_natural: f32,
    parent_scroll_shift_y: f32,
    tree: &Tree,
    renderer_for_taffy: &HashMap<NodeId, String>,
    viewport_w: f32,
    scrolls: &HashMap<String, f32>,
    out: &mut Vec<LayoutItem>,
    natural_bounds: &mut (f32, f32),
    cull_viewport: Option<Rect>,
) {
    let layout = taffy.layout(node_id).expect("taffy layout");
    let x = parent_x + layout.location.x;
    let y_natural = parent_y_natural + layout.location.y;
    let rect = Rect {
        x,
        y: y_natural - parent_scroll_shift_y,
        w: layout.size.width,
        h: layout.size.height,
    };
    natural_bounds.0 = natural_bounds.0.max(x + layout.size.width);
    natural_bounds.1 = natural_bounds.1.max(y_natural + layout.size.height);

    // Viewport cull. When `cull_viewport` is `Some`, subtrees whose
    // rect ends one full viewport above the visible region OR starts
    // one full viewport below are skipped wholesale (no LayoutItem
    // emit, no recursion). Buffer = one viewport-height of slack on
    // each side so a partly-off-screen post that's about to scroll
    // in stays in the layout. The synthetic outer wrapper has no
    // renderer node — never cull it, otherwise the entire tree
    // disappears for any page taller than the viewport.
    let renderer_id = renderer_for_taffy.get(&node_id).cloned();
    if let (Some(v), Some(_)) = (cull_viewport, renderer_id.as_deref()) {
        let buffer = v.h;
        let bottom = rect.y + rect.h;
        let top = rect.y;
        if bottom < v.y - buffer || top > v.y + v.h + buffer {
            return;
        }
    }

    // Detect if this renderer node is a scrollable container; if so,
    // its descendants get an additional shift equal to its scroll
    // offset, and we back-fill `ScrollMeta { content_h }` after walking
    // children so the App can clamp the offset.
    let mut child_scroll_shift_y = parent_scroll_shift_y;
    let mut scrollable_idx: Option<usize> = None;

    if let Some(rid) = renderer_id.as_deref() {
        if let Some(node) = tree.get(rid) {
            let action = resolve_action(node);
            let mut item_border = border_at(node, viewport_w);
            // The DSL says `.borderRadius(8)` even when there's no
            // border line — round the fill anyway. The painter checks
            // `is_visible()` independently before stroking.
            let background_explicit = prop_color_at(node, "backgroundColor", viewport_w);
            let scrollable = is_scrollable_node(node, viewport_w);
            if scrollable {
                let off = scrolls.get(rid).copied().unwrap_or(0.0);
                child_scroll_shift_y = parent_scroll_shift_y + off;
            }
            match node.element_type.as_str() {
                et if TEXT_INPUT_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
                    let value = node
                        .props
                        .get("value")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let placeholder = node
                        .props
                        .get("placeholder")
                        .or_else(|| node.props.get("placeholder.0"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    let bind_path = node
                        .props
                        .get("bind")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    let font_size =
                        prop_f32_at(node, "fontSize", viewport_w).unwrap_or(DEFAULT_FONT_SIZE_PX);
                    let font_weight = resolve_font_weight(node, viewport_w);
                    let color = prop_color_at(node, "color", viewport_w).unwrap_or(Rgba::BLACK);
                    let background = background_explicit.or(Some(Rgba(0xff, 0xff, 0xff, 0xff)));
                    // Default Input frame, but only when the user
                    // didn't explicitly opt out (e.g. `border-0`).
                    if !item_border.is_visible() && !has_explicit_border(node) {
                        item_border = Border {
                            width: 1.0,
                            color: Rgba(0xc4, 0xcc, 0xd8, 0xff),
                            radius: 8.0,
                            sides: crate::style::BORDER_SIDES_ALL,
                        };
                    }
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind: ItemKind::Input {
                            value,
                            placeholder,
                            bind_path,
                            font_size,
                            color,
                        },
                        rect,
                        action: None,
                        background,
                        border: item_border,
                        scrollable: None,
                        font_weight,
                    });
                }
                "Text" => {
                    let font_size =
                        prop_f32_at(node, "fontSize", viewport_w).unwrap_or(DEFAULT_FONT_SIZE_PX);
                    let font_weight = resolve_font_weight(node, viewport_w);
                    let color = prop_color_at(node, "color", viewport_w).unwrap_or(Rgba::BLACK);
                    let content = node.text_content().unwrap_or("").to_string();
                    let align = parse_text_align(crate::style::prop_str_at(node, "textAlign", viewport_w));
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind: ItemKind::Text {
                            content,
                            font_size,
                            color,
                            align,
                        },
                        rect,
                        action,
                        background: background_explicit,
                        border: item_border,
                        scrollable: None,
                        font_weight,
                    });
                }
                et if IMAGE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
                    // The engine pre-resolves `Icon(@resources.foo)`
                    // into structured `paths` + `viewBox` props. When
                    // present, treat the element as a vector Icon
                    // (rasterised on the painter's GPU surface every
                    // frame); otherwise fall back to the bitmap
                    // `Image` path with a `src`.
                    // The engine resolves `Icon(@resources.foo)` and
                    // injects `__iconPaths` + `__iconViewBox` (matches
                    // the DOM / Canvas renderers in hypen-web). The
                    // legacy un-prefixed names are kept as a fallback
                    // for tests that synthesise patches by hand.
                    let icon_paths = node
                        .props
                        .get("__iconPaths")
                        .or_else(|| node.props.get("paths"))
                        .map(crate::paint::icon::parse_paths)
                        .unwrap_or_default();
                    if !icon_paths.is_empty() {
                        let view_box_str = node
                            .props
                            .get("__iconViewBox")
                            .and_then(|v| v.as_str())
                            .or_else(|| {
                                node.props.get("viewBox").and_then(|v| v.as_str())
                            });
                        let view_box = crate::paint::icon::parse_view_box(view_box_str);
                        let tint = prop_color_at(node, "color", viewport_w);
                        out.push(LayoutItem {
                            node_id: rid.to_string(),
                            kind: ItemKind::Icon {
                                paths: icon_paths,
                                view_box,
                                tint,
                            },
                            rect,
                            action,
                            background: background_explicit,
                            border: item_border,
                            scrollable: None,
                            font_weight: 400,
                        });
                    } else {
                        let src = crate::style::prop_str_at(node, "src", viewport_w)
                            .map(str::to_string);
                        let fit = parse_object_fit(crate::style::prop_str_at(
                            node,
                            "objectFit",
                            viewport_w,
                        ));
                        out.push(LayoutItem {
                            node_id: rid.to_string(),
                            kind: ItemKind::Image { src, fit },
                            rect,
                            action,
                            background: background_explicit,
                            border: item_border,
                            scrollable: None,
                            font_weight: 400,
                        });
                    }
                }
                et if ACTIONABLE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
                    // Default Button bg + stroke kick in only when the
                    // user didn't override either with `.tw(...)` or
                    // explicit applicators. `bg-transparent` and
                    // `border-0` disable them respectively.
                    let bg_explicit_present =
                        node.props.contains_key("backgroundColor")
                            || node.props.contains_key("backgroundColor.0")
                            || node.props.contains_key("background-color");
                    let background = if bg_explicit_present {
                        background_explicit
                    } else {
                        Some(Rgba(0xe7, 0xee, 0xff, 0xff))
                    };
                    if !item_border.is_visible() && !has_explicit_border(node) {
                        item_border = Border {
                            width: 1.0,
                            color: Rgba(0x4a, 0x6a, 0xd6, 0xff),
                            radius: 8.0,
                            sides: crate::style::BORDER_SIDES_ALL,
                        };
                    }
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind: ItemKind::Button,
                        rect,
                        action,
                        background,
                        border: item_border,
                        scrollable: None,
                        font_weight: 400,
                    });
                }
                _ => {
                    if scrollable {
                        scrollable_idx = Some(out.len());
                    }
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind: ItemKind::Container,
                        rect,
                        action,
                        background: background_explicit,
                        border: item_border,
                        // Filled in after children walk. content_h
                        // placeholder of 0.0 means "not scrollable yet"
                        // — only the Container branch ever back-fills.
                        scrollable: if scrollable {
                            Some(ScrollMeta { content_h: 0.0 })
                        } else {
                            None
                        },
                        font_weight: 400,
                    });
                }
            }
        }
    }

    let mut max_child_bottom_natural = y_natural;
    for child in taffy.children(node_id).unwrap_or_default() {
        emit_items(
            taffy,
            child,
            x,
            y_natural,
            child_scroll_shift_y,
            tree,
            renderer_for_taffy,
            viewport_w,
            scrolls,
            out,
            natural_bounds,
            cull_viewport,
        );
        if scrollable_idx.is_some() {
            if let Ok(cl) = taffy.layout(child) {
                let cb = y_natural + cl.location.y + cl.size.height;
                if cb > max_child_bottom_natural {
                    max_child_bottom_natural = cb;
                }
            }
        }
    }

    if let Some(idx) = scrollable_idx {
        // content_h = total height occupied by children below this
        // container's natural top. Used by the App to clamp the
        // scroll offset against `max(0, content_h - rect.h)`.
        let content_h = (max_child_bottom_natural - y_natural).max(0.0);
        if let Some(meta) = out[idx].scrollable.as_mut() {
            meta.content_h = content_h;
        }
    }
}

/// Scrollable container detection. A Container is scrollable if its
/// `overflow` or `overflowY` prop resolves to `"scroll"` or `"auto"`.
/// `"hidden"` and `"visible"` are explicitly non-scrollable; missing
/// props default to non-scrollable.
fn is_scrollable_node(node: &crate::tree::Node, viewport_w: f32) -> bool {
    let v = crate::style::prop_str_at(node, "overflowY", viewport_w)
        .or_else(|| crate::style::prop_str_at(node, "overflow", viewport_w));
    matches!(
        v.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("scroll") | Some("auto"),
    )
}

/// Pull an `@actions.X` reference off `props.action` / `props.onClick`
/// and strip the `@actions.` / `@` prefix. Only checked for actionable
/// element types — the engine resolves `Button("@actions.X")` into
/// `props.action`, so we never need to look at `props["0"]` (and doing
/// so would treat any positional Text content as an action name).
fn resolve_action(node: &crate::tree::Node) -> Option<String> {
    if !ACTIONABLE_TYPES
        .iter()
        .any(|t| t.eq_ignore_ascii_case(&node.element_type))
    {
        return None;
    }
    let raw = node
        .props
        .get("action")
        .or_else(|| node.props.get("onClick"))
        .and_then(|v| v.as_str())?;
    let stripped = raw.strip_prefix('@').unwrap_or(raw);
    Some(stripped.strip_prefix("actions.").unwrap_or(stripped).to_string())
}

// Suppress warning on imports used only in helper paths.
#[allow(dead_code)]
fn _root_anchor() -> &'static str {
    ROOT_ID
}

/// Resolve `font-weight` / `fontWeight` to a CSS-style numeric weight
/// in the 100..900 range. Strings like `"semibold"` and `"bold"` are
/// also accepted (matches the engine's resolution of named weights).
/// Defaults to 400 ("normal") when missing or unparseable.
pub(crate) fn resolve_font_weight(node: &crate::tree::Node, viewport_w: f32) -> u16 {
    if let Some(v) = prop_f32_at(node, "fontWeight", viewport_w) {
        return (v as u16).clamp(100, 900);
    }
    if let Some(s) = crate::style::prop_str_at(node, "fontWeight", viewport_w) {
        return parse_named_weight(s);
    }
    400
}

fn parse_named_weight(s: &str) -> u16 {
    match s.trim().to_ascii_lowercase().as_str() {
        "thin" => 100,
        "extralight" | "ultralight" => 200,
        "light" => 300,
        "normal" | "regular" => 400,
        "medium" => 500,
        "semibold" | "demibold" => 600,
        "bold" => 700,
        "extrabold" | "ultrabold" => 800,
        "black" | "heavy" => 900,
        other => other.parse::<u16>().unwrap_or(400).clamp(100, 900),
    }
}

/// Resolve a `textAlign` / `text-align` prop string to the local
/// [`TextAlign`] enum. `start` / `left` map to `Start`; `end` / `right`
/// to `End`; `center` to `Center`. Anything else (or missing) → Start.
pub(crate) fn parse_text_align(s: Option<&str>) -> TextAlign {
    match s.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("center") => TextAlign::Center,
        Some("end") | Some("right") => TextAlign::End,
        _ => TextAlign::Start,
    }
}

/// Local alias to avoid clashing with our `Rect` (Taffy's `Rect` is a
/// generic 4-edge container, not a 2D rectangle).
type Rect_<T> = taffy::geometry::Rect<T>;

#[cfg(test)]
#[path = "layout_tests.rs"]
mod tests;
