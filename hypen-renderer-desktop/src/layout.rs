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

/// Default gap between flex children. Zero, matching CSS / iOS /
/// Android — implicit chrome here turns every Column into a
/// 8px-spaced stack regardless of what the layout actually asks
/// for, which is the exact "weird padding between sections" people
/// report (e.g. the social example's title → Stories → Posts gap).
/// Components that want spacing set it explicitly via `.gap(N)` or
/// tw `gap-N`.
const DEFAULT_GAP_PX: f32 = 0.0;
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

#[derive(Debug, Clone, Copy, PartialEq)]
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
        /// `Some(n)` clamps the text to at most `n` rendered lines —
        /// the `truncate` Tailwind utility maps to `maxLines: 1` and
        /// is the common case. `None` means "wrap to whatever fits".
        /// Measure ignores wrap when `Some(1)` so width grows naturally;
        /// the painter clips overflow to the laid-out rect so the
        /// extra glyphs disappear instead of overflowing siblings.
        max_lines: Option<u32>,
        /// `(left, top, right, bottom)` padding in *physical* pixels.
        /// `LayoutItem.rect` stays the outer (border-box) rect so
        /// background fills and borders draw the full padded box;
        /// the painter uses this inset to shift the glyph origin and
        /// shrink the wrap width to the content area.
        padding: (f32, f32, f32, f32),
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
    /// Optional JSON payload attached to the action via the named
    /// applicator arguments — e.g. `.onClick(@router.push, to: "/x")`
    /// → `Some({"to": "/x"})`. Forwarded to
    /// `HypenModule::dispatch_action` so the SDK / action handler
    /// can react. `None` when the action has no extra arguments.
    pub action_payload: Option<serde_json::Value>,
    /// Optional fill. Painted under everything else for the same item.
    /// Optional fill from `backgroundColor` / tw `bg-*`. Buttons no
    /// longer get implicit chrome — set `.backgroundColor(...)` or
    /// `.tw("bg-...")` explicitly. Containers and text default to `None`.
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
    /// `Some(rect)` when this item lives inside a `.scrollable(...)`
    /// container and the painter must clip its draw to that
    /// container's rect. Without this clip, descendants of a
    /// scrollable container that have scrolled past the container's
    /// top / bottom edge would paint at their absolute screen
    /// position — overlapping content above / below the container
    /// (the "input visible in the grid gaps" bug). The rect is in
    /// the same coordinate space as `rect`, so page-scroll passes
    /// shift both together. `None` for items whose scrollable
    /// ancestor is the synthetic page root (or with no scrollable
    /// ancestor at all).
    pub clip_to: Option<Rect>,
    /// Renderer-tree id of the "direct child of the nearest
    /// scrollable ancestor" this item belongs to. Items with the
    /// same `subtree_root` form one painter-side cache unit — each
    /// Post in HomePage's feed, each cell of Search's Grid. `None`
    /// when the item has no scrollable ancestor (no caching needed;
    /// it gets repainted normally). The painter uses this to slice
    /// the items list into contiguous subtrees that can be re-used
    /// across frames as encoded `vello::Scene` fragments.
    pub subtree_root: Option<String>,
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
    pub(crate) by_node_id: HashMap<String, usize>,
    /// Indexes of `items` whose `action` is `Some(_)` — Buttons /
    /// Cards / Links. `actionables()` and `hit()` iterate this.
    pub(crate) actionable_ids: Vec<usize>,
    /// Indexes of focusable items (actionables + Inputs) in document
    /// order. `focus_next` / `focus_prev` walk this directly.
    pub(crate) focusable_ids: Vec<usize>,
    /// Indexes of items whose `scrollable` is `Some(_)`. Wheel
    /// routing iterates these (in reverse for topmost-first) instead
    /// of the full items vec.
    pub(crate) scrollable_ids: Vec<usize>,
}

/// Per-Taffy-node sidecar so the measure callback can look up text
/// content and font size without a back-channel into the renderer tree.
#[derive(Debug, Default)]
pub(crate) struct NodeContext {
    text: Option<String>,
    font_size: f32,
    /// `Some(1)` when the node has `truncate` (or otherwise
    /// `maxLines: 1`) — the measurer ignores parent wrap_width and
    /// returns a single-line natural-width measure so Taffy doesn't
    /// reflow the text onto two lines. The painter still clips the
    /// drawn glyphs to the laid-out rect.
    max_lines: Option<u32>,
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
    /// renderer_id → Taffy `NodeId` lookup for incremental patch
    /// application. Maintained by `apply_patches` and consulted by
    /// `set_parent_children` / Move / Remove handlers.
    node_map: HashMap<String, NodeId>,
    structure_key: u64,
    /// `true` once the root has been initialised with the page-level
    /// padding / gap style for the current viewport. Reset when
    /// viewport / scale changes so the root style refreshes too.
    root_initialised: bool,
    /// `true` when the Taffy tree is out of sync with the renderer
    /// Tree (cold start, or an unhandled patch fell through). The
    /// next compute runs a bulk rebuild and clears the flag.
    needs_bulk_rebuild: bool,
}

impl TaffyState {
    pub fn new() -> Self {
        let mut tree: TaffyTree<NodeContext> = TaffyTree::new();
        // Container so `set_children` works for the very first
        // Insert(parent_id == ROOT) patch we receive; the proper
        // outer-wrapper style + size lands in `restyle_all` once the
        // viewport is known.
        let root = tree
            .new_with_children(Style::default(), &[])
            .expect("taffy root container");
        Self {
            tree,
            root,
            renderer_for_taffy: HashMap::new(),
            node_map: HashMap::new(),
            structure_key: 0,
            root_initialised: false,
            needs_bulk_rebuild: true,
        }
    }

    /// Force a full rebuild on the next compute. Called when an
    /// unhandled patch path falls through `apply_patches`, or when
    /// the renderer Tree gets out of sync with the Taffy mirror for
    /// any other reason.
    pub fn mark_needs_rebuild(&mut self) {
        self.needs_bulk_rebuild = true;
    }

    /// Apply patches incrementally so the Taffy tree stays mirrored
    /// with the renderer Tree across frames. Must be called *after*
    /// `tree.apply_batch(&patches)` so renderer-node lookups inside
    /// reflect the post-patch state. Returns `true` if every patch
    /// was applied; `false` if anything fell through that the caller
    /// should treat as an unhandled case (forces a structural
    /// rebuild on the next compute).
    pub fn apply_patches(
        &mut self,
        patches: &[hypen_engine::Patch],
        tree: &Tree,
        scale: f32,
        viewport_w: f32,
    ) -> bool {
        let mut all_applied = true;
        for patch in patches {
            if !self.apply_patch(patch, tree, scale, viewport_w) {
                all_applied = false;
            }
        }
        if all_applied {
            // Taffy is now mirrored to the renderer Tree post-batch.
            // Skip the bulk rebuild on the next compute and let
            // `restyle_all` (cheap) handle any viewport / scale shift.
            self.needs_bulk_rebuild = false;
        }
        all_applied
    }

    fn apply_patch(
        &mut self,
        patch: &hypen_engine::Patch,
        tree: &Tree,
        scale: f32,
        viewport_w: f32,
    ) -> bool {
        use hypen_engine::Patch;
        match patch {
            Patch::Create { id, .. } => {
                if let Some(node) = tree.get(id) {
                    let style = node_style(node, scale, viewport_w);
                    let ctx = node_context(node, scale, viewport_w);
                    let taffy_id = self
                        .tree
                        .new_leaf_with_context(style, ctx)
                        .ok();
                    if let Some(tid) = taffy_id {
                        self.node_map.insert(id.clone(), tid);
                        self.renderer_for_taffy.insert(tid, id.clone());
                        return true;
                    }
                    return false;
                }
                true
            }
            Patch::SetProp { id, name, .. } | Patch::RemoveProp { id, name } => {
                let Some(&tid) = self.node_map.get(id) else { return true };
                // Appearance-only props (color / backgroundColor /
                // src / icon paths / etc.) don't change Taffy
                // geometry. Skip `set_style` so Taffy's per-node
                // dirty bit stays clean — the next `compute_layout`
                // becomes a no-op walk, and the painter picks up the
                // new prop value on the next `emit_items` pass that
                // re-reads from the renderer Tree directly.
                if is_layout_prop(name) {
                    if let Some(node) = tree.get(id) {
                        let style = node_style(node, scale, viewport_w);
                        let _ = self.tree.set_style(tid, style);
                        if node.element_type == "Text" {
                            let ctx = node_context(node, scale, viewport_w);
                            let _ = self.tree.set_node_context(tid, Some(ctx));
                        }
                    }
                }
                true
            }
            Patch::SetText { id, .. } => {
                // SetText is reserved + always layout-affecting on
                // Text nodes (changes measured width/height).
                let Some(&tid) = self.node_map.get(id) else { return true };
                if let Some(node) = tree.get(id) {
                    let style = node_style(node, scale, viewport_w);
                    let _ = self.tree.set_style(tid, style);
                    if node.element_type == "Text" {
                        let ctx = node_context(node, scale, viewport_w);
                        let _ = self.tree.set_node_context(tid, Some(ctx));
                    }
                }
                true
            }
            Patch::Insert { parent_id, id, before_id }
            | Patch::Attach { parent_id, id, before_id } => {
                self.set_parent_children(
                    parent_id,
                    id,
                    before_id.as_deref(),
                    tree,
                );
                true
            }
            Patch::Move { parent_id, id, before_id } => {
                if let Some(&child) = self.node_map.get(id) {
                    if let Some(old_parent) = self.tree.parent(child) {
                        let mut old: Vec<NodeId> = self
                            .tree
                            .children(old_parent)
                            .unwrap_or_default();
                        old.retain(|c| *c != child);
                        let _ = self.tree.set_children(old_parent, &old);
                    }
                }
                self.set_parent_children(parent_id, id, before_id.as_deref(), tree);
                true
            }
            Patch::Remove { id } => {
                if let Some(tid) = self.node_map.remove(id) {
                    if let Some(parent) = self.tree.parent(tid) {
                        let mut children: Vec<NodeId> =
                            self.tree.children(parent).unwrap_or_default();
                        children.retain(|c| *c != tid);
                        let _ = self.tree.set_children(parent, &children);
                    }
                    let _ = self.tree.remove(tid);
                    self.renderer_for_taffy.remove(&tid);
                }
                true
            }
            Patch::Detach { id } => {
                if let Some(&tid) = self.node_map.get(id) {
                    if let Some(parent) = self.tree.parent(tid) {
                        let mut children: Vec<NodeId> =
                            self.tree.children(parent).unwrap_or_default();
                        children.retain(|c| *c != tid);
                        let _ = self.tree.set_children(parent, &children);
                    }
                }
                true
            }
        }
    }

    fn set_parent_children(
        &mut self,
        parent_id: &str,
        child_id: &str,
        before_id: Option<&str>,
        tree: &Tree,
    ) {
        let Some(&child_tid) = self.node_map.get(child_id) else { return };
        let parent_tid = if parent_id == ROOT_ID {
            self.root
        } else if let Some(&t) = self.node_map.get(parent_id) {
            t
        } else {
            return;
        };
        let mut children: Vec<NodeId> = self.tree.children(parent_tid).unwrap_or_default();
        children.retain(|c| *c != child_tid);
        let pos = before_id
            .and_then(|bid| self.node_map.get(bid))
            .and_then(|t| children.iter().position(|c| c == t))
            .unwrap_or(children.len());
        children.insert(pos, child_tid);
        let _ = self.tree.set_children(parent_tid, &children);

        // Stack: every child past the first picks up `position:
        // absolute` + margin → inset so it overlays the base. This
        // runs whenever a Stack's children change so newly-inserted
        // children get the right styling and reordering doesn't
        // strand absolute settings on the wrong child.
        if parent_tid != self.root {
            if let Some(parent_node) = tree.get(parent_id) {
                if parent_node.element_type.eq_ignore_ascii_case("Stack") {
                    self.apply_stack_overlay_styles(parent_tid);
                }
            }
        }
    }

    fn apply_stack_overlay_styles(&mut self, parent_tid: NodeId) {
        let children: Vec<NodeId> = self.tree.children(parent_tid).unwrap_or_default();
        for (idx, &child) in children.iter().enumerate() {
            let Ok(mut s) = self.tree.style(child).cloned() else { continue };
            if idx == 0 {
                s.position = Position::Relative;
                s.inset = Rect_ {
                    top: LengthPercentageAuto::auto(),
                    right: LengthPercentageAuto::auto(),
                    bottom: LengthPercentageAuto::auto(),
                    left: LengthPercentageAuto::auto(),
                };
            } else {
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
            }
            let _ = self.tree.set_style(child, s);
        }
    }

    /// Re-apply styles to every node and refresh the root style.
    /// Called when the structure key flipped on viewport / scale —
    /// breakpoint resolution and HiDPI scaling are baked into
    /// per-node styles at build time, so we have to recompute them.
    pub fn restyle_all(&mut self, tree: &Tree, scale: f32, viewport: (u32, u32)) {
        let viewport_w = viewport.0 as f32;
        // Re-style every existing node.
        let entries: Vec<(NodeId, String)> = self
            .renderer_for_taffy
            .iter()
            .map(|(t, r)| (*t, r.clone()))
            .collect();
        for (tid, rid) in entries {
            if let Some(node) = tree.get(&rid) {
                let style = node_style(node, scale, viewport_w);
                let _ = self.tree.set_style(tid, style);
                if node.element_type == "Text" {
                    let ctx = node_context(node, scale, viewport_w);
                    let _ = self.tree.set_node_context(tid, Some(ctx));
                }
            }
        }
        // Refresh the synthetic outer wrapper's style too.
        // No implicit padding / gap on the synthetic outer wrapper.
        // iOS / Android / web all give the app's root component edge-
        // to-edge access to the viewport — implicit page chrome here
        // turns every `border-b` divider into a 3-sided box and makes
        // it impossible to do a full-bleed status bar or hero image.
        // Trivial demos that want breathing room set it themselves
        // (e.g. `.tw("p-6")` on their root Column).
        let outer_style = Style {
            display: Display::Flex,
            flex_direction: FlexDirection::Column,
            // Width is fixed to the viewport (so children with
            // `width: 100%` resolve correctly). Height grows to
            // content — `min_size.height = viewport.h` keeps the
            // wrapper at least viewport-tall so empty pages still
            // fill the surface, but content taller than the viewport
            // overflows freely. Without this, every flex child got
            // squeezed to fit and `content_size.1` capped at
            // viewport.h → `clamp_scroll` pinned scroll to 0.
            // Outer wrapper is exactly viewport-sized. Children that
            // need to scroll declare `.scrollable(...)` and get their
            // own `overflow: scroll` via `apply_overflow_props`; that
            // per-container scroll path (see `hit_scrollable` in
            // window.rs) is the supported route to scroll any content
            // taller than the viewport. Keeping the root sized to the
            // viewport is what lets a `flex-1 + bottom-bar` page (e.g.
            // social App.hypen) actually leave the bottom bar on
            // screen — when the root was `height: auto` it grew to
            // child content and pushed the bottom bar off the bottom
            // edge.
            size: Size {
                width: length(viewport.0 as f32),
                height: length(viewport.1 as f32),
            },
            min_size: Size {
                width: length(viewport.0 as f32),
                height: length(viewport.1 as f32),
            },
            ..Default::default()
        };
        let _ = self.tree.set_style(self.root, outer_style);
        self.root_initialised = true;

        // `node_style` is parent-agnostic, so it can't apply the
        // Stack-children-after-first-go-absolute overlay. Without
        // this re-walk, restyle_all silently strips the absolute
        // positioning every Stack child past the first received from
        // `build_subtree` / `apply_stack_overlay_styles` — that's why
        // the "Your story" badge rendered next to the avatar instead
        // of overlapping it after a viewport-driven restyle.
        let stack_parents: Vec<NodeId> = self
            .renderer_for_taffy
            .iter()
            .filter_map(|(tid, rid)| {
                let n = tree.get(rid)?;
                if n.element_type.eq_ignore_ascii_case("Stack") {
                    Some(*tid)
                } else {
                    None
                }
            })
            .collect();
        for tid in stack_parents {
            self.apply_stack_overlay_styles(tid);
        }
    }

    /// Cheap root-only refresh. Updates the synthetic outer wrapper's
    /// style with the current viewport size without re-walking every
    /// node. Called on every viewport change (including height-only)
    /// so the root's `min_size.height = viewport.h` stays accurate
    /// even when `restyle_all` is skipped because the structure_key
    /// (width + scale) didn't move. Without this, a window-height
    /// drag left the root pinned to the *old* height — the surface
    /// shows the page at its old size and the freshly-uncovered area
    /// reads back as grey base_color.
    pub fn refresh_root_size(&mut self, scale: f32, viewport: (u32, u32)) {
        if !self.root_initialised {
            return;
        }
        // No implicit padding / gap on the synthetic outer wrapper.
        // iOS / Android / web all give the app's root component edge-
        // to-edge access to the viewport — implicit page chrome here
        // turns every `border-b` divider into a 3-sided box and makes
        // it impossible to do a full-bleed status bar or hero image.
        // Trivial demos that want breathing room set it themselves
        // (e.g. `.tw("p-6")` on their root Column).
        let outer_style = Style {
            display: Display::Flex,
            flex_direction: FlexDirection::Column,
            // Outer wrapper is exactly viewport-sized. Children that
            // need to scroll declare `.scrollable(...)` and get their
            // own `overflow: scroll` via `apply_overflow_props`; that
            // per-container scroll path (see `hit_scrollable` in
            // window.rs) is the supported route to scroll any content
            // taller than the viewport. Keeping the root sized to the
            // viewport is what lets a `flex-1 + bottom-bar` page (e.g.
            // social App.hypen) actually leave the bottom bar on
            // screen — when the root was `height: auto` it grew to
            // child content and pushed the bottom bar off the bottom
            // edge.
            size: Size {
                width: length(viewport.0 as f32),
                height: length(viewport.1 as f32),
            },
            min_size: Size {
                width: length(viewport.0 as f32),
                height: length(viewport.1 as f32),
            },
            ..Default::default()
        };
        let _ = self.tree.set_style(self.root, outer_style);
    }
}

impl Default for TaffyState {
    fn default() -> Self {
        Self::new()
    }
}

/// Structure key for `TaffyState`. Drives the *restyle* decision:
/// when this changes, every node gets re-styled (breakpoint + HiDPI
/// scaling are baked into per-node Style at build time). Patch-driven
/// structural changes flow through `apply_patches` and don't bump
/// this key — the renderer's `tree_generation` is decoupled from
/// Taffy's structure key on purpose so a typing keystroke (one
/// `SetProp` patch) doesn't force a full Taffy restyle.
fn taffy_structure_key(viewport: (u32, u32), scale: f32) -> u64 {
    use std::hash::{Hash, Hasher};
    // Width and scale change resolved Style values: tw breakpoints
    // (`md:`, `lg:`) gate on width, and HiDPI scaling multiplies every
    // length token. Height does NOT — no token resolves against it —
    // so we deliberately exclude it. That turns a window-height drag
    // into a Taffy compute-layout-only pass instead of a full
    // restyle_all walk over every node, ~10× cheaper for any
    // non-trivial page during a live resize.
    let mut h = std::collections::hash_map::DefaultHasher::new();
    viewport.0.hash(&mut h);
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
        let _ = tree_generation; // tree generation no longer in key
        let key = taffy_structure_key(viewport, scale);
        let viewport_w_px = viewport.0 as f32;
        let style_changed = state.structure_key != key;
        let needs_rebuild = state.needs_bulk_rebuild;

        if needs_rebuild {
            // Cold start or out-of-sync after an unhandled patch.
            // Wipe and rebuild from the renderer Tree.
            state.tree = TaffyTree::new();
            state.renderer_for_taffy.clear();
            state.node_map.clear();
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
            // Rebuild node_map from renderer_for_taffy.
            state.node_map.clear();
            for (tid, rid) in &state.renderer_for_taffy {
                state.node_map.insert(rid.clone(), *tid);
            }
            // No implicit padding / gap on the outer wrapper — see
            // `restyle_all` for the rationale (edge-to-edge content
            // matching iOS / Android / web).
            let outer_style = Style {
                display: Display::Flex,
                flex_direction: FlexDirection::Column,
                size: Size {
                    width: length(viewport.0 as f32),
                    height: length(viewport.1 as f32),
                },
                min_size: Size {
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
            state.root_initialised = true;
            state.needs_bulk_rebuild = false;
        } else if style_changed || !state.root_initialised {
            // Viewport / scale changed but the structure (renderer
            // Tree) is intact — just refresh styles + root size.
            state.restyle_all(tree, scale, viewport);
            state.structure_key = key;
        } else {
            // Structure key matched (width + scale unchanged), but
            // viewport.height may still have moved — height alone
            // doesn't invalidate any per-node Style, but the root's
            // `min_size.height = viewport.h` does need to follow.
            state.refresh_root_size(scale, viewport);
        }
        let root = state.root;
        let taffy = &mut state.tree;
        let renderer_for_taffy = &state.renderer_for_taffy;

        // Width is bounded by the viewport so percent / flex math
        // resolves; height is `MaxContent` so the synthetic outer
        // wrapper grows to content rather than capping at the
        // viewport. The wrapper's `min_size.height = viewport.h`
        // keeps an empty page filling the surface; taller content
        // produces a `content_size.1` > `viewport.h` so the page
        // can actually scroll.
        let available = Size {
            width: AvailableSpace::Definite(viewport.0 as f32),
            height: AvailableSpace::MaxContent,
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
            // `truncate` (max_lines = Some(1)) also disables wrap so
            // the text stays one line — overflow is the painter's
            // problem (clipped to the laid-out rect).
            let wrap_width = if matches!(ctx.max_lines, Some(1)) {
                None
            } else {
                known.width.or(match avail.width {
                    AvailableSpace::Definite(w) => Some(w),
                    AvailableSpace::MinContent | AvailableSpace::MaxContent => None,
                })
            };
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
            scale,
            scrolls,
            &mut items,
            &mut content_size,
            cull_viewport,
            None,
            None,
        );

        // Apply scroll. Phase 8 only scrolls the page vertically;
        // horizontal can come when we expose Container::overflow.
        // `clip_to` rides along with `rect` — both live in the same
        // coordinate space, so the page-scroll subtraction has to
        // hit both, otherwise the clip stays at its natural y and
        // drifts away from the items it's supposed to clip.
        if scroll_y != 0.0 {
            for it in items.iter_mut() {
                it.rect.y -= scroll_y;
                if let Some(clip) = it.clip_to.as_mut() {
                    clip.y -= scroll_y;
                }
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
            let aspect_ratio = crate::style::prop_aspect_ratio_at(node, "aspectRatio", viewport_w);

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
            let content = node.text_content().map(|c| c.into_owned()).unwrap_or_default();
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
                        max_lines: resolve_max_lines(node, viewport_w),
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
        et if et.eq_ignore_ascii_case("Grid") => {
            // CSS-grid container. `.gridColumns(N)` sets the number of
            // equal-fraction tracks; `.gap(N)` applies to both axes.
            // Used by Search's explore feed which laid out as a single
            // column under the flex catchall, stretching each post
            // image edge-to-edge.
            let cols = prop_f32_at(node, "gridColumns", viewport_w)
                .map(|v| v.max(1.0) as u16)
                .unwrap_or(1);
            let pad = padding_at(node, viewport_w);
            let gap_v = prop_f32_at(node, "gap", viewport_w).unwrap_or(DEFAULT_GAP_PX) * scale;
            let mut style = Style {
                display: Display::Grid,
                grid_template_columns: (0..cols)
                    .map(|_| taffy::style_helpers::fr::<f32, _>(1.0))
                    .collect(),
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
            apply_overflow_props(&mut style, node, viewport_w);
            apply_position_props(&mut style, node, viewport_w, scale);
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
            // Critical: `apply_overflow_props` here is what turns
            // `.scrollable(true)` into Taffy `overflow: scroll` on
            // first build. Without it, the bulk-build path produces
            // a HomePage that grows to its full content height and
            // wheel events bottom out at `max=0`. `node_style()` (used
            // by patches / restyle_all) had these — `build_subtree`
            // didn't. Same goes for `apply_position_props` (Story's
            // `absolute top-0 left-0 right-0` overlay would have been
            // silently re-stacked under the post image otherwise).
            apply_overflow_props(&mut style, node, viewport_w);
            apply_position_props(&mut style, node, viewport_w, scale);
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

/// Whether changing a prop with this name (or its kebab variant)
/// requires Taffy to re-flow the layout. Appearance-only props
/// (`color`, `backgroundColor`, `src`, icon paths, etc.) skip
/// Taffy's dirty bit — the painter picks them up on the next
/// `emit_items` pass that re-reads from the renderer Tree, and
/// `compute_layout` short-circuits when nothing is dirty.
pub(crate) fn is_layout_prop(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with("padding") || lower.starts_with("margin") {
        return true;
    }
    if lower.starts_with("border") {
        // borderColor / border-color are appearance only; everything
        // else (border / borderWidth / borderRadius / per-side
        // widths) feeds the layout's box model.
        return !lower.contains("color");
    }
    matches!(
        lower.as_str(),
        "width"
            | "height"
            | "size"
            | "minwidth" | "min-width"
            | "minheight" | "min-height"
            | "maxwidth" | "max-width"
            | "maxheight" | "max-height"
            | "aspectratio" | "aspect-ratio"
            | "fontsize" | "font-size"
            | "fontweight" | "font-weight"
            | "gap"
            | "flex"
            | "flexgrow" | "flex-grow"
            | "flexshrink" | "flex-shrink"
            | "flexbasis" | "flex-basis"
            | "alignitems" | "align-items"
            | "alignself" | "align-self"
            | "alignContent" | "align-content"
            | "justifycontent" | "justify-content"
            | "justifyself" | "justify-self"
            | "display"
            | "overflow" | "overflowx" | "overflow-x" | "overflowy" | "overflow-y"
            | "position"
            | "top" | "right" | "bottom" | "left"
            | "0" // positional Text content — re-shapes the line
    )
}

/// Compute the Taffy `Style` for a renderer node based on its
/// element type + props. Pure function: no Taffy mutations, no
/// recursion. Used both by `build_subtree` (for the initial bulk
/// build path) and `TaffyState::apply_patch` (per-node Create /
/// SetProp updates).
pub(crate) fn node_style(
    node: &crate::tree::Node,
    scale: f32,
    viewport_w: f32,
) -> Style {
    let et = node.element_type.as_str();
    let mut style = if IMAGE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) {
        let size_fallback = prop_f32_at(node, "size", viewport_w);
        let w_dim = prop_dim_at(node, "width", viewport_w);
        let h_dim = prop_dim_at(node, "height", viewport_w);
        let aspect_ratio = crate::style::prop_aspect_ratio_at(node, "aspectRatio", viewport_w);
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
        Style {
            display: Display::Flex,
            size: Size { width, height },
            aspect_ratio,
            flex_shrink: 0.0,
            margin: margin_to_taffy(margin_at(node, viewport_w), scale),
            border: border_to_taffy(border_at(node, viewport_w), scale),
            ..Default::default()
        }
    } else if TEXT_INPUT_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) {
        let pad_x = DEFAULT_INPUT_PAD_X * scale;
        let pad_y = DEFAULT_INPUT_PAD_Y * scale;
        Style {
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
        }
    } else if et == "Text" {
        let pad = padding_at(node, viewport_w);
        Style {
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
        }
    } else if ACTIONABLE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) {
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
        Style {
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
        }
    } else if et.eq_ignore_ascii_case("Stack") {
        let pad = padding_at(node, viewport_w);
        Style {
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
        }
    } else if et.eq_ignore_ascii_case("Grid") {
        // Mirror of `build_subtree`'s Grid branch — see that comment
        // for the rationale (Search's explore feed needs N equal
        // tracks instead of falling through to a 1-column flex).
        let cols = prop_f32_at(node, "gridColumns", viewport_w)
            .map(|v| v.max(1.0) as u16)
            .unwrap_or(1);
        let pad = padding_at(node, viewport_w);
        let gap_v = prop_f32_at(node, "gap", viewport_w).unwrap_or(DEFAULT_GAP_PX) * scale;
        Style {
            display: Display::Grid,
            // `flex(1)` is Taffy's `minmax(0, 1fr)` helper — "exactly
            // evenly sized tracks." Plain `fr(1)` is `minmax(auto, 1fr)`
            // which lets each track grow past its fr share to fit
            // children's max-content. With `aspect-square w-full`
            // images, each image's max-content resolves to 100% of the
            // grid width, so the `auto` minimum pushed every track to
            // the full container width — three 960-px-wide cells per
            // row instead of three 320-px cells.
            grid_template_columns: (0..cols)
                .map(|_| taffy::style_helpers::flex::<f32, _>(1.0))
                .collect(),
            // Same percent-resolution gotcha on the row axis: the
            // default `auto` row track sizing asks each child for its
            // max-content height. A child with `width: Percent(1.0)`
            // + `aspect_ratio: 1` reports `max_content_h = 1 ×
            // container_w` (because the percent isn't resolved
            // against the column track yet during the row sizing
            // pass), so each row ended up reserving `container_w`
            // of height regardless of the actual rendered cell.
            // `min_content` reduces each auto-row's intrinsic size
            // to 0 + whatever the LAID-OUT child geometry pushes,
            // which after column tracks are resolved is the correct
            // aspect-ratio square height.
            grid_auto_rows: vec![taffy::style_helpers::min_content()],
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
        }
    } else {
        let dir = if et.eq_ignore_ascii_case("Row") {
            FlexDirection::Row
        } else {
            FlexDirection::Column
        };
        let pad = padding_at(node, viewport_w);
        let gap_v = prop_f32_at(node, "gap", viewport_w).unwrap_or(DEFAULT_GAP_PX) * scale;
        Style {
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
        }
    };
    apply_flex_props(&mut style, node, viewport_w, scale);
    apply_alignment_props(&mut style, node, viewport_w);
    apply_size_props(&mut style, node, viewport_w, scale);
    apply_overflow_props(&mut style, node, viewport_w);
    apply_position_props(&mut style, node, viewport_w, scale);
    style
}

/// Apply `position` + `top` / `right` / `bottom` / `left` / `inset`
/// props. Without this, tw `absolute top-0 left-0 right-0` (used by
/// e.g. Story overlay headers, modal close buttons) was silently
/// dropped and the overlay rendered in normal flex flow under its
/// siblings.
fn apply_position_props(
    style: &mut Style,
    node: &crate::tree::Node,
    viewport_w: f32,
    scale: f32,
) {
    use crate::style::{prop_dim_at, prop_str_at, Dim};
    if let Some(s) = prop_str_at(node, "position", viewport_w) {
        match s.trim().to_ascii_lowercase().as_str() {
            // Taffy 0.10 only models Absolute vs Relative; `fixed` /
            // `sticky` collapse to Absolute (relative to nearest
            // positioned ancestor) which is the right default for a
            // single-viewport native app.
            "absolute" | "fixed" | "sticky" => style.position = Position::Absolute,
            "relative" | "static" => style.position = Position::Relative,
            _ => {}
        }
    }
    fn dim_to_lpa(d: Dim, scale: f32) -> LengthPercentageAuto {
        match d {
            Dim::Length(v) => LengthPercentageAuto::length(v * scale),
            Dim::Percent(p) => LengthPercentageAuto::percent(p),
        }
    }
    if let Some(d) = prop_dim_at(node, "inset", viewport_w) {
        let v = dim_to_lpa(d, scale);
        style.inset = Rect_ { top: v, right: v, bottom: v, left: v };
    }
    if let Some(d) = prop_dim_at(node, "top", viewport_w) {
        style.inset.top = dim_to_lpa(d, scale);
    }
    if let Some(d) = prop_dim_at(node, "right", viewport_w) {
        style.inset.right = dim_to_lpa(d, scale);
    }
    if let Some(d) = prop_dim_at(node, "bottom", viewport_w) {
        style.inset.bottom = dim_to_lpa(d, scale);
    }
    if let Some(d) = prop_dim_at(node, "left", viewport_w) {
        style.inset.left = dim_to_lpa(d, scale);
    }
}

/// Apply CSS-style overflow props (`overflow`, `overflowX`,
/// `overflowY`) and the Hypen-DSL `.scrollable(...)` applicator to
/// `style.overflow`. Without this, scrollable containers' children
/// painted past the parent's bounds — e.g. a horizontal Stories row
/// with five items at `w-20` apiece overflowing into the viewport
/// margin instead of clipping at the row's right edge.
fn apply_overflow_props(
    style: &mut Style,
    node: &crate::tree::Node,
    viewport_w: f32,
) {
    use crate::style::prop_str_at;

    fn parse(s: &str) -> Option<Overflow> {
        match s.trim().to_ascii_lowercase().as_str() {
            "visible" => Some(Overflow::Visible),
            "hidden" | "clip" => Some(Overflow::Hidden),
            // Taffy 0.10 has Scroll behave like Hidden for layout
            // purposes (we handle the scroll offset ourselves);
            // either way the parent clips overflow.
            "scroll" | "auto" => Some(Overflow::Scroll),
            _ => None,
        }
    }

    // Hypen-DSL `.scrollable(...)` applicator. Sets the *axis* the
    // container scrolls on (and therefore clips on); the orthogonal
    // axis stays `Visible` so legitimately overflowing content (e.g.
    // a focus-ring stroke from a child) stays painted.
    let scrollable_axes = match crate::style::prop_str_at(node, "scrollable", viewport_w)
        .map(|s| s.trim().to_ascii_lowercase())
    {
        Some(s) if s == "horizontal" => Some((Overflow::Scroll, Overflow::Visible)),
        Some(s) if s == "vertical" || s == "true" || s == "scroll" || s == "auto" => {
            Some((Overflow::Visible, Overflow::Scroll))
        }
        Some(s) if s == "both" => Some((Overflow::Scroll, Overflow::Scroll)),
        _ => None,
    };
    // `.scrollable(true)` lands as a *bool* under either `scrollable`
    // or the engine-flattened `scrollable.0` key. `prop_str_at` above
    // only picks it up when the value happens to be a string; without
    // checking both bare + dotted bool here, `overflow: scroll`
    // never gets onto Taffy and the container's `layout.size.height`
    // grows to its full content extent (defeating the whole point of
    // per-container scroll — `rect.h >= content_h` makes max=0 and
    // wheel events go nowhere). Same shape of fix as
    // `is_scrollable_node`.
    let bool_is_true = |v: &serde_json::Value| {
        v.as_bool() == Some(true) || v.as_str().map(str::trim) == Some("true")
    };
    if scrollable_axes.is_none()
        && (node.props.get("scrollable").is_some_and(bool_is_true)
            || node.props.get("scrollable.0").is_some_and(bool_is_true))
    {
        style.overflow = taffy::Point {
            x: Overflow::Visible,
            y: Overflow::Scroll,
        };
    }
    if let Some((x, y)) = scrollable_axes {
        style.overflow = taffy::Point { x, y };
    }

    // CSS-style props win when explicitly set.
    if let Some(o) = prop_str_at(node, "overflow", viewport_w).and_then(parse) {
        style.overflow = taffy::Point { x: o, y: o };
    }
    if let Some(o) = prop_str_at(node, "overflowX", viewport_w).and_then(parse) {
        style.overflow.x = o;
    }
    if let Some(o) = prop_str_at(node, "overflowY", viewport_w).and_then(parse) {
        style.overflow.y = o;
    }

    // Classic flexbox-overflow gotcha: Taffy (like CSS) defaults
    // `min-height: auto` on flex items, which expands to the item's
    // content size. A `flex-1` child with `overflow: scroll` whose
    // content is taller than its flex allocation still won't shrink
    // — the auto min-size pins it to content height and `max =
    // content_h - rect_h` ends up at zero. Force `min_size` to 0 on
    // the scroll axis so the parent's flex distribution can actually
    // clip the frame to its allocation. Only zero the side we
    // scroll on; the cross-axis keeps its content-based min so a
    // narrow scrollable still sizes correctly.
    if style.overflow.x == Overflow::Scroll {
        style.min_size.width = length(0.0);
    }
    if style.overflow.y == Overflow::Scroll {
        style.min_size.height = length(0.0);
    }
}

/// Compute the Taffy `NodeContext` for a renderer node. Only Text
/// leaves carry a non-empty context (text content + scaled font
/// size); every other element returns `Default::default()` so the
/// measure callback short-circuits.
pub(crate) fn node_context(
    node: &crate::tree::Node,
    scale: f32,
    viewport_w: f32,
) -> NodeContext {
    if node.element_type == "Text" {
        let font_size = prop_f32_at(node, "fontSize", viewport_w)
            .map(|v| v * scale)
            .unwrap_or(DEFAULT_FONT_SIZE_PX * scale);
        NodeContext {
            text: Some(node.text_content().map(|c| c.into_owned()).unwrap_or_default()),
            font_size,
            max_lines: resolve_max_lines(node, viewport_w),
        }
    } else {
        NodeContext::default()
    }
}

/// Read `maxLines` (or `max-lines`, the CSS-property form emitted by
/// the `truncate` Tailwind utility) off a Text node. `Some(n)` means
/// the renderer should keep at most `n` rendered lines; `None` means
/// "wrap freely". Falls back to `None` when the value isn't a positive
/// integer.
pub(crate) fn resolve_max_lines(
    node: &crate::tree::Node,
    viewport_w: f32,
) -> Option<u32> {
    let v = prop_f32_at(node, "maxLines", viewport_w)
        .or_else(|| prop_f32_at(node, "max-lines", viewport_w))?;
    if v >= 1.0 {
        Some(v as u32)
    } else {
        None
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
                    // CSS `flex: 1` is shorthand for `1 1 0%`, but the
                    // spec specially-cases `flex-basis: 0%` to resolve
                    // to 0 *unconditionally* — it does NOT require a
                    // definite parent. Taffy 0.10's percent resolution
                    // is not specially cased here; with an indefinite-
                    // height ancestor anywhere up the chain, every
                    // level's `flex-basis: 0%` falls back to content
                    // sizing and the whole flex distribution collapses.
                    // That's exactly the bug behind HomePage's
                    // `rect_h ≈ content_h` despite `flex-1` + `min_size
                    // = 0` + `overflow: scroll`: Route's Column,
                    // Router, and App outer all have `flex-1`, so the
                    // chain back to the synthetic-root's definite
                    // height collapses to indefinite at every step.
                    // Emitting `Length(0)` instead of `Percent(0)`
                    // makes the basis unconditionally zero, which is
                    // what every browser actually does in practice.
                    style.flex_basis = Dimension::length(0.0);
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
    scale: f32,
    scrolls: &HashMap<String, f32>,
    out: &mut Vec<LayoutItem>,
    natural_bounds: &mut (f32, f32),
    cull_viewport: Option<Rect>,
    // `parent_clip_to`: rect of the nearest scrollable ancestor
    // (post-shift, same coord space as the `rect` we're about to
    // emit). `Some` means this item lives inside a `.scrollable(...)`
    // container and the painter must clip it; `None` means there's
    // no scrollable ancestor, or this *is* the scrollable container
    // (whose own bg/border isn't clipped — only its descendants are).
    parent_clip_to: Option<Rect>,
    // `subtree_root`: renderer-tree id of the direct child of the
    // nearest scrollable ancestor that this item belongs to. Threaded
    // through so each emitted LayoutItem can carry its painter-side
    // cache-unit identity (one Post in the feed, one cell in a Grid).
    // `None` outside any scrollable. When recursing into the children
    // of a scrollable, each child becomes a fresh subtree root —
    // descendants of that child propagate the same value. The
    // scrollable container's own row inherits the *outer* root (i.e.
    // typically `None`) so its bg/border doesn't get bundled into
    // any single child's cache entry.
    subtree_root: Option<&str>,
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
    // Use `content_size` (natural extent including overflowing
    // children) rather than the parent's constrained `size`. With a
    // viewport-pinned root + page-level scroll, the outer Column
    // reports `size.height = viewport.h` (clipped to fit) while its
    // children flex naturally to their full content extent — using
    // `size` here would have `natural_bounds.1` stop at viewport.h,
    // collapsing `content_size` and snapping page scroll to 0.
    let extent_h = layout.content_size.height.max(layout.size.height);
    let extent_w = layout.content_size.width.max(layout.size.width);
    natural_bounds.0 = natural_bounds.0.max(x + extent_w);
    natural_bounds.1 = natural_bounds.1.max(y_natural + extent_h);

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
        // Two viewport-heights of slack on each side. Pairs with the
        // half-viewport recompute threshold in `App::redraw`: gives
        // the user 1.5 viewports of pre-emitted content to scroll
        // through before the next emit lands, comfortably absorbing
        // wheel bursts on fast trackpads.
        let buffer = v.h * 2.0;
        // Cull against the natural content extent, not the
        // constrained box: a parent whose children overflow past
        // its `size.height` still hosts visible content past that
        // edge. Without this, an outer Column pinned to viewport.h
        // would cull the entire tree the moment page scroll exceeded
        // viewport.h + buffer, collapsing `natural_bounds.1` and
        // forcing scroll to 0.
        let bottom = rect.y + extent_h;
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
    // Clip rect handed down to children. Inherits `parent_clip_to`
    // by default; replaced with this node's own rect when the node
    // is itself scrollable, so descendants clip to *this* container.
    // The container's own row (bg / border) keeps `parent_clip_to`
    // — only its scrolling content gets clipped.
    let mut child_clip_to = parent_clip_to;

    if let Some(rid) = renderer_id.as_deref() {
        if let Some(node) = tree.get(rid) {
            let action = resolve_action(node);
            let action_payload = action.as_ref().and_then(|_| resolve_action_payload(node));
            let mut item_border = border_at(node, viewport_w);
            // The DSL says `.borderRadius(8)` even when there's no
            // border line — round the fill anyway. The painter checks
            // `is_visible()` independently before stroking.
            let background_explicit = prop_color_at(node, "backgroundColor", viewport_w);
            let scrollable = is_scrollable_node(node, viewport_w);
            if scrollable {
                let off = scrolls.get(rid).copied().unwrap_or(0.0);
                child_scroll_shift_y = parent_scroll_shift_y + off;
                // Anchor descendant clipping to this container's
                // own rect. Even if the container itself is inside
                // a larger scrollable, the painter clips to the
                // innermost — Vello's nested push_layer composes,
                // but the engine emit only needs the immediate
                // ancestor: nested scrollables aren't a real use
                // case in the social example and would need their
                // own scroll-routing rework anyway.
                child_clip_to = Some(rect);
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
                        action_payload: None,
                        background,
                        border: item_border,
                        scrollable: None,
                        font_weight,
                        clip_to: parent_clip_to,
                        subtree_root: subtree_root.map(str::to_string),
                    });
                }
                "Text" => {
                    let font_size =
                        prop_f32_at(node, "fontSize", viewport_w).unwrap_or(DEFAULT_FONT_SIZE_PX);
                    let font_weight = resolve_font_weight(node, viewport_w);
                    let color = prop_color_at(node, "color", viewport_w).unwrap_or(Rgba::BLACK);
                    let content = node.text_content().map(|c| c.into_owned()).unwrap_or_default();
                    let align = parse_text_align(crate::style::prop_str_at(node, "textAlign", viewport_w));
                    let max_lines = resolve_max_lines(node, viewport_w);
                    // Pass padding to the painter so it can shift the
                    // glyph origin / shrink the wrap width without
                    // losing the outer rect (which still drives bg /
                    // border rendering and hit-testing).
                    let pad = padding_at(node, viewport_w);
                    let padding_phys = (
                        pad.left * scale,
                        pad.top * scale,
                        pad.right * scale,
                        pad.bottom * scale,
                    );
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind: ItemKind::Text {
                            content,
                            font_size,
                            color,
                            align,
                            max_lines,
                            padding: padding_phys,
                        },
                        rect,
                        action,
                        action_payload: action_payload.clone(),
                        background: background_explicit,
                        border: item_border,
                        scrollable: None,
                        font_weight,
                        clip_to: parent_clip_to,
                        subtree_root: subtree_root.map(str::to_string),
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
                            action_payload: action_payload.clone(),
                            background: background_explicit,
                            border: item_border,
                            scrollable: None,
                            font_weight: 400,
                            clip_to: parent_clip_to,
                        subtree_root: subtree_root.map(str::to_string),
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
                            action_payload: action_payload.clone(),
                            background: background_explicit,
                            border: item_border,
                            scrollable: None,
                            font_weight: 400,
                            clip_to: parent_clip_to,
                        subtree_root: subtree_root.map(str::to_string),
                        });
                    }
                }
                et if ACTIONABLE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
                    // No implicit Button chrome — ghost/icon controls
                    // (e.g. Story close ✕) only paint what the DSL sets.
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind: ItemKind::Button,
                        rect,
                        action,
                        action_payload: action_payload.clone(),
                        background: background_explicit,
                        border: item_border,
                        scrollable: None,
                        font_weight: 400,
                        clip_to: parent_clip_to,
                        subtree_root: subtree_root.map(str::to_string),
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
                        action_payload,
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
                        clip_to: parent_clip_to,
                        subtree_root: subtree_root.map(str::to_string),
                    });
                }
            }
        }
    }

    let mut max_child_bottom_natural = y_natural;
    // Paint flow children before absolutely-positioned overlays so an
    // in-flow sibling (e.g. Story's full-bleed Image) doesn't cover a
    // header declared earlier in the tree. Matches the canvas renderer
    // and CSS stacking: absolute overlays land on top of in-flow content.
    let children = taffy.children(node_id).unwrap_or_default();
    let mut flow_children = Vec::new();
    let mut overlay_children = Vec::new();
    for child in children {
        let is_absolute = taffy
            .style(child)
            .map(|s| s.position == Position::Absolute)
            .unwrap_or(false);
        if is_absolute {
            overlay_children.push(child);
        } else {
            flow_children.push(child);
        }
    }
    for child in flow_children
        .iter()
        .chain(overlay_children.iter())
        .copied()
    {
        // If THIS node is a scrollable container, each of its direct
        // children becomes a fresh painter-side cache unit (each Post
        // / each Grid cell). Otherwise the child inherits whatever
        // subtree-root the current node belongs to.
        let child_subtree_root: Option<String> = if scrollable_idx.is_some() {
            renderer_for_taffy.get(&child).cloned()
        } else {
            subtree_root.map(str::to_string)
        };
        emit_items(
            taffy,
            child,
            x,
            y_natural,
            child_scroll_shift_y,
            tree,
            renderer_for_taffy,
            viewport_w,
            scale,
            scrolls,
            out,
            natural_bounds,
            cull_viewport,
            child_clip_to,
            child_subtree_root.as_deref(),
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

/// Scrollable container detection. Marks the container as scrollable
/// if any of:
/// - `.scrollable(true)` / `.scrollable("vertical" | "horizontal" |
///   "both" | "scroll" | "auto")` — the Hypen-DSL applicator the
///   social example actually uses.
/// - `overflow` / `overflowY` prop resolves to `"scroll"` / `"auto"`
///   (CSS-style fallback used by tw classes).
fn is_scrollable_node(node: &crate::tree::Node, viewport_w: f32) -> bool {
    if let Some(s) = crate::style::prop_str_at(node, "scrollable", viewport_w) {
        let lower = s.trim().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "true" | "vertical" | "horizontal" | "both" | "scroll" | "auto"
        ) {
            return true;
        }
    }
    // `.scrollable(true)` — single positional bool. The engine
    // flattens applicators into namespaced props, so this lands as
    // `scrollable.0 = bool(true)`. `prop_str_at` above only finds it
    // when the value happens to be a *string* "true"; a real
    // JSON-bool slipped past every check below and HomePage never
    // became scrollable — every wheel event fell through to page
    // scroll. Check both bare and `.0` for completeness, and accept
    // the string form as well to mirror `prop_str_at`'s arm above.
    let bool_is_true = |v: &serde_json::Value| {
        v.as_bool() == Some(true) || v.as_str().map(str::trim) == Some("true")
    };
    if node.props.get("scrollable").is_some_and(bool_is_true)
        || node.props.get("scrollable.0").is_some_and(bool_is_true)
    {
        return true;
    }
    let v = crate::style::prop_str_at(node, "overflowY", viewport_w)
        .or_else(|| crate::style::prop_str_at(node, "overflow", viewport_w))
        .or_else(|| crate::style::prop_str_at(node, "overflowX", viewport_w));
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
    // The engine flattens applicator arguments into namespaced props:
    // `.onClick(@router.push, to: "/x")` becomes
    //   onClick.0 = "@router.push"
    //   onClick.to = "/x"
    // and `Button("@actions.foo")` becomes `action.0 = "@actions.foo"`.
    // Older paths also sometimes set bare `onClick` / `action` strings,
    // so check both.
    //
    // `props.onClick*` is set explicitly via the `.onClick(...)`
    // applicator — accept it on ANY element so arbitrary containers
    // (Column / Row / Card) can be made clickable. `props.action*`
    // only exists because the engine resolves Button positional
    // syntax into it; gate that path to ACTIONABLE_TYPES so plain
    // `Text("X")` doesn't accidentally become an action handler.
    let click_raw = node
        .props
        .get("onClick.0")
        .or_else(|| node.props.get("onClick"))
        .and_then(|v| v.as_str());
    if let Some(raw) = click_raw {
        let stripped = raw.strip_prefix('@').unwrap_or(raw);
        return Some(
            stripped
                .strip_prefix("actions.")
                .unwrap_or(stripped)
                .to_string(),
        );
    }
    if !ACTIONABLE_TYPES
        .iter()
        .any(|t| t.eq_ignore_ascii_case(&node.element_type))
    {
        return None;
    }
    let raw = node
        .props
        .get("action.0")
        .or_else(|| node.props.get("action"))
        .and_then(|v| v.as_str())?;
    let stripped = raw.strip_prefix('@').unwrap_or(raw);
    Some(stripped.strip_prefix("actions.").unwrap_or(stripped).to_string())
}

/// Collect the named arguments of `onClick(...)` (or `action(...)`)
/// into a payload object. `.onClick(@router.push, to: "/x", id: 42)`
/// → `{"to": "/x", "id": 42}`; the positional action ref at `.0` is
/// excluded. Returns `None` when no payload args were attached. The
/// payload is forwarded verbatim to `module.dispatch_action`, which
/// the SDK plumbs to the action handler (`router.push` reads
/// `payload.to`, user handlers read whatever they like).
pub(crate) fn resolve_action_payload(
    node: &crate::tree::Node,
) -> Option<serde_json::Value> {
    let mut obj = serde_json::Map::new();
    for prefix in ["onClick.", "action."] {
        for (key, value) in node.props.iter() {
            let Some(suffix) = key.strip_prefix(prefix) else {
                continue;
            };
            // Skip the positional action-ref slot (`.0`).
            if suffix == "0" {
                continue;
            }
            obj.insert(suffix.to_string(), value.clone());
        }
        if !obj.is_empty() {
            break;
        }
    }
    if obj.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(obj))
    }
}

/// Generic event-applicator reader. Looks up `<event>.0` (or bare `<event>`)
/// on `node` and returns `(action_name, payload)` where `payload` is built
/// from any `<event>.<key>` siblings (e.g. `.onInput(@actions.search,
/// scope: "explore")` → action `"search"`, payload `{"scope": "explore"}`).
/// Returns `None` if no action ref is wired for that event.
pub(crate) fn resolve_named_event_action(
    node: &crate::tree::Node,
    event: &str,
) -> Option<(String, serde_json::Value)> {
    let zero_key = format!("{event}.0");
    let raw = node
        .props
        .get(&zero_key)
        .or_else(|| node.props.get(event))
        .and_then(|v| v.as_str())?;
    let stripped = raw.strip_prefix('@').unwrap_or(raw);
    let action = stripped
        .strip_prefix("actions.")
        .unwrap_or(stripped)
        .to_string();

    let prefix = format!("{event}.");
    let mut obj = serde_json::Map::new();
    for (key, value) in node.props.iter() {
        let Some(suffix) = key.strip_prefix(&prefix) else {
            continue;
        };
        if suffix == "0" {
            continue;
        }
        obj.insert(suffix.to_string(), value.clone());
    }
    Some((action, serde_json::Value::Object(obj)))
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
