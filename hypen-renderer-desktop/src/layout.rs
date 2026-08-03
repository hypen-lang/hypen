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
    border_at, border_with, has_explicit_border, margin_with, node_layout_active_states,
    padding_at, padding_with, prop_color_at, prop_dim_with, prop_f32_at, prop_f32_with,
    Border, Dim, Rgba, VariantState, Viewport,
};
use crate::text::TextEngine;
use crate::tree::{Tree, ROOT_ID};
use std::collections::HashMap;
use taffy::prelude::*;
use taffy::style::Overflow;

/// Convert the GPU surface size — which wgpu reports in **physical**
/// pixels — into the logical (CSS) viewport that breakpoints and
/// viewport units resolve against.
///
/// Geometry deliberately does not go through here: taffy styles are
/// built in physical px by multiplying lengths by `scale`. Only the
/// *resolution basis* converts, which is why a 960pt window on a 2x
/// display must evaluate as `md` (960 ≥ 768) and not `xl` (1920 ≥ 1280).
pub(crate) fn logical_viewport(viewport_px: (u32, u32), scale: f32) -> Viewport {
    if scale > 0.0 {
        Viewport::new(viewport_px.0 as f32 / scale, viewport_px.1 as f32 / scale)
    } else {
        Viewport::new(viewport_px.0 as f32, viewport_px.1 as f32)
    }
}

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

/// 2D affine transform in the painter's physical-pixel space, stored as
/// the six coefficients `[a, b, c, d, e, f]` mapping
/// `(x, y) → (a·x + c·y + e, b·x + d·y + f)` — the same layout kurbo's
/// `Affine` uses, so the painter converts losslessly.
///
/// This is the paint-AND-hit-test transform for a [`LayoutItem`]: the
/// node's own `translateX` / `translateY` / `scale` / `rotate` props
/// composed with every ancestor's (nested transforms compose down the
/// tree, CSS-style). The one composition is consumed by the Vello
/// painter (pixels), the `hit_*` paths (pointer targets), the AccessKit
/// bounds, and the caret/pointer→local mapping — the project's
/// non-negotiable rule: pixels never move without hit targets moving
/// identically.
///
/// Composition per node follows the DOM renderer's canonical
/// `TRANSFORM_ORDER` (`translateX, translateY, scale, rotate` — CSS
/// individual-function semantics: the translation is applied OUTSIDE
/// the scale/rotate, so a translated node travels the authored distance
/// regardless of its scale). The transform origin is the CENTER of the
/// node's layout box, matching the canvas painter's default
/// (`transformOriginX/Y` default 0.5). Reconciliation note: the canvas
/// painter folds the translation INSIDE its scale/rotate (ctx op order
/// `translate(c) · S · R · translate(-c + t)`), so under a combined
/// scale+slide the canvas offset is scaled (24px × 0.95 = 22.8px) where
/// DOM/desktop travel the full 24px — desktop follows the DOM/CSS
/// composition, the reference the animation protocol was designed
/// against.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Affine2(pub [f32; 6]);

impl Affine2 {
    pub const IDENTITY: Affine2 = Affine2([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    pub fn is_identity(&self) -> bool {
        self == &Self::IDENTITY
    }

    pub fn translate(tx: f32, ty: f32) -> Self {
        Affine2([1.0, 0.0, 0.0, 1.0, tx, ty])
    }

    pub fn scale(s: f32) -> Self {
        Affine2([s, 0.0, 0.0, s, 0.0, 0.0])
    }

    /// Rotation by `deg` degrees (the prop vocabulary's unit — canvas
    /// `parseFloat(props.rotate)` treats the number as degrees and the
    /// DOM spin keyframes run 0deg → 360deg).
    pub fn rotate_deg(deg: f32) -> Self {
        let r = deg.to_radians();
        let (sin, cos) = (r.sin(), r.cos());
        Affine2([cos, sin, -sin, cos, 0.0, 0.0])
    }

    /// Compose: `self.then_apply_after(other)` — the returned transform
    /// applies `other` FIRST, then `self` (standard matrix product
    /// `self × other`).
    pub fn mul(&self, other: &Affine2) -> Affine2 {
        let [a1, b1, c1, d1, e1, f1] = self.0;
        let [a2, b2, c2, d2, e2, f2] = other.0;
        Affine2([
            a1 * a2 + c1 * b2,
            b1 * a2 + d1 * b2,
            a1 * c2 + c1 * d2,
            b1 * c2 + d1 * d2,
            a1 * e2 + c1 * f2 + e1,
            b1 * e2 + d1 * f2 + f1,
        ])
    }

    pub fn apply(&self, x: f32, y: f32) -> (f32, f32) {
        let [a, b, c, d, e, f] = self.0;
        (a * x + c * y + e, b * x + d * y + f)
    }

    /// Inverse, or `None` for a degenerate transform (`scale(0)`
    /// collapses the item to a point — nothing is hittable, matching
    /// how a zero-determinant CSS transform renders nothing targetable).
    pub fn inverse(&self) -> Option<Affine2> {
        let [a, b, c, d, e, f] = self.0;
        let det = a * d - b * c;
        if det.abs() < 1e-6 {
            return None;
        }
        let inv_det = 1.0 / det;
        Some(Affine2([
            d * inv_det,
            -b * inv_det,
            -c * inv_det,
            a * inv_det,
            (c * f - d * e) * inv_det,
            (b * e - a * f) * inv_det,
        ]))
    }

    /// Conjugate by a uniform translation: `T(dx,dy) · self · T(-dx,-dy)`.
    /// This is the exact update for the scroll fast path — when every
    /// item rect shifts by `(dx, dy)` without a re-emit, each cumulative
    /// transform (whose origin terms embed the emit-time rect centers)
    /// shifts by the same conjugation (`∏ T(d)·Lᵢ·T(-d) = T(d)·(∏Lᵢ)·T(-d)`).
    pub fn conjugate_translate(&self, dx: f32, dy: f32) -> Affine2 {
        Affine2::translate(dx, dy)
            .mul(self)
            .mul(&Affine2::translate(-dx, -dy))
    }

    /// Axis-aligned bounding box of `rect` under this transform — the
    /// item's VISUAL rect (AccessKit bounds, damage regions, paint
    /// culling all read this).
    pub fn aabb_of(&self, rect: Rect) -> Rect {
        if self.is_identity() {
            return rect;
        }
        let corners = [
            self.apply(rect.x, rect.y),
            self.apply(rect.x + rect.w, rect.y),
            self.apply(rect.x, rect.y + rect.h),
            self.apply(rect.x + rect.w, rect.y + rect.h),
        ];
        let mut min_x = f32::INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        for (x, y) in corners {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
        Rect {
            x: min_x,
            y: min_y,
            w: (max_x - min_x).max(0.0),
            h: (max_y - min_y).max(0.0),
        }
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

/// Resolved `hover:` pseudo-state overrides (from tw `hover:bg-*` /
/// `hover:border-*`, which the engine expands into `backgroundColor:hover`
/// / `borderColor:hover` props). Applied by the painter when the item is
/// in the interaction `hovered` set. `None` fields fall back to the
/// base style (and, for Buttons, the automatic hover tint).
#[derive(Debug, Clone, Copy, Default)]
pub struct HoverStyle {
    pub background: Option<Rgba>,
    pub border_color: Option<Rgba>,
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
    /// Action name to dispatch on hover-state changes via the
    /// `.onHover(@actions.X, …)` applicator. The window fires this
    /// twice per pointer trip: once on enter with payload
    /// `{hovered: true, …static args}`, once on leave with
    /// `{hovered: false, …static args}`. Mirrors `action` so any
    /// element type can opt in — not gated to ACTIONABLE_TYPES. See
    /// `resolve_hover_action` for the parsing rules.
    pub hover_action: Option<String>,
    /// Static payload entries from `.onHover(@actions.X, key: value)`.
    /// The `hovered: bool` flag is merged in at dispatch time, so this
    /// field never contains it. `None` when only the action ref was
    /// supplied.
    pub hover_payload: Option<serde_json::Value>,
    /// Optional fill. Painted under everything else for the same item.
    /// Optional fill from `backgroundColor` / tw `bg-*`. Buttons no
    /// longer get implicit chrome — set `.backgroundColor(...)` or
    /// `.tw("bg-...")` explicitly. Containers and text default to `None`.
    pub background: Option<Rgba>,
    /// Resolved `hover:` overrides, applied while the item is hovered.
    pub hover: HoverStyle,
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
    /// Resolved linear gradient for this item's background, when the
    /// DSL applied a `bg-gradient-to-* from-* to-*` (or explicit
    /// `linear-gradient(...)`) — overrides `background` solid fill
    /// at paint time. `None` for the common solid-colour case so
    /// the existing `fill_rect` fast path stays untouched.
    pub background_gradient: Option<crate::style::LinearGradient>,
    /// Background IMAGE source for this item, from the CSS `background`
    /// shorthand's `url(...)` layer (`data:` or remote). CSS paints it above
    /// the solid colour and under the gradient. `None` for the common case.
    pub background_image: Option<String>,
    /// Paint-time state-variant colour overrides (hover/focus/active/
    /// disabled, optionally breakpoint-combined) for `backgroundColor`,
    /// `color`, and `borderColor`. Precomputed here (node + viewport in
    /// hand) so the painter can apply them against live
    /// `InteractionState` without the renderer tree. `is_empty()` in the
    /// common no-variant case → painter fast path.
    pub state_variants: crate::style::StateVariants,
    /// Effective opacity `0..=1` for this item's paint: the node's own
    /// `opacity` prop multiplied down from its ancestors (CSS-style
    /// group inheritance, approximated per item). `1.0` — fully opaque
    /// — in the common case; computed in a post-pass after emission,
    /// gated on any tree node actually carrying an opacity prop, so the
    /// no-opacity tree pays one boolean scan. The Vello painter wraps
    /// the item's draws in an alpha layer when this is `< 1`. This is
    /// what makes `fade` enters/exits, `pulse`, and `.transition` on
    /// `opacity` honest on desktop.
    pub opacity: f32,
    /// Cumulative paint/hit transform for this item: the node's own
    /// `translateX` / `translateY` / `scale` / `rotate` props composed
    /// with every ancestor's (see [`Affine2`] for composition order and
    /// origin). Identity — the overwhelmingly common case — costs
    /// nothing: the post-pass that fills this is gated on any tree node
    /// actually carrying a transform prop, and every consumer takes an
    /// `is_identity()` fast path. Filled by the transform post-pass
    /// after emission; consumed by the Vello painter, every `hit_*`
    /// path, the AccessKit bounds, and pointer→local mapping — one
    /// resolution shared by pixels and hit targets (constraint #5).
    /// Static transform props and animator-driven ones ride this same
    /// field: the animator writes the interpolated values into the REAL
    /// tree props, and this post-pass reads them back like any other.
    pub transform: Affine2,
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
    /// Engine-derived accessibility semantics by `node_id`. The AccessKit
    /// translation reads this for the accessible name/role/hidden of each
    /// item, falling back to layout heuristics when absent.
    pub(crate) a11y: std::collections::HashMap<String, hypen_engine::ir::Semantics>,
    /// Indexes of items whose `hover_action` is `Some(_)`. Hover
    /// hit-testing (`hit_hoverable`) iterates this list in reverse —
    /// just like `actionable_ids` — to find the topmost subject under
    /// the cursor. Kept separate from `actionable_ids` because hover
    /// applicators are allowed on ANY element type, not just buttons.
    pub(crate) hoverable_ids: Vec<usize>,
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
    /// CSS font weight. Bold glyphs are wider, so the wrap result
    /// depends on it: measuring at 400 while the painter draws at 700
    /// makes a bold line that Taffy sized for one line wrap onto two,
    /// and the box stays a line short of the glyphs drawn into it.
    font_weight: u16,
}

/// The live interaction state fed into the layout pass so that
/// layout-affecting state variants (`padding:hover`, `width:focus`, …)
/// resolve against the node actually under the pointer / pressed /
/// focused. Holds the single node id in each role (the desktop renderer
/// tracks one hovered / pressed / focused node at a time).
///
/// For the overwhelmingly common node that carries no layout-affecting
/// state variant, this never changes the resolved style: the per-node
/// active states only matter when a `:state` variant exists on a
/// layout-affecting prop, and the window gates relayout on exactly that
/// condition (see `node_has_layout_state_variant`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LayoutInteraction {
    pub hovered: Option<String>,
    pub pressed: Option<String>,
    pub focused: Option<String>,
}

impl LayoutInteraction {
    /// Build the layout-time active-state list for `node` (identified by
    /// `id`) against this interaction snapshot. Empty (the fast path)
    /// when the node is neither hovered, pressed, focused, nor disabled.
    fn active_states_for<'a>(&self, id: &str, node: &crate::tree::Node) -> Vec<&'a str> {
        let hovered = self.hovered.as_deref() == Some(id);
        let pressed = self.pressed.as_deref() == Some(id);
        let focused = self.focused.as_deref() == Some(id);
        node_layout_active_states(node, hovered, pressed, focused)
    }
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
    /// Live interaction snapshot used to resolve layout-affecting state
    /// variants (`padding:hover`, …). Refreshed each compute from the
    /// window. The `interaction_key` folds it into the structure key so
    /// a hover/press/focus transition forces a `restyle_all` — but ONLY
    /// when the tree actually has layout-affecting state variants (the
    /// window passes the empty default otherwise, so the key is stable).
    interaction: LayoutInteraction,
    /// Hash of the interaction snapshot that the current per-node styles
    /// were built against. A mismatch on the next compute triggers a
    /// restyle so the new states reach Taffy.
    interaction_key: u64,
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
            interaction: LayoutInteraction::default(),
            interaction_key: 0,
        }
    }

    /// Force a full rebuild on the next compute. Called when an
    /// unhandled patch path falls through `apply_patches`, or when
    /// the renderer Tree gets out of sync with the Taffy mirror for
    /// any other reason.
    pub fn mark_needs_rebuild(&mut self) {
        self.needs_bulk_rebuild = true;
    }

    /// Update the interaction snapshot used to resolve layout-affecting
    /// state variants. The window calls this before each compute. When
    /// the tree has no layout-affecting state variants, the window
    /// passes the default (all-`None`) value so the interaction key
    /// stays constant and no relayout is triggered by hover/press/focus.
    pub fn set_interaction(&mut self, interaction: LayoutInteraction) {
        self.interaction = interaction;
    }

    /// Free the Taffy node for renderer `id`, if present. Used to
    /// mirror [`Tree::evict_detached_over`] teardown: the caller
    /// passes every id in the evicted subtree, so each node's Taffy
    /// parent is either also being removed or has no live link — no
    /// parent child-list fixup is needed.
    pub fn remove_node(&mut self, id: &str) {
        if let Some(tid) = self.node_map.remove(id) {
            let _ = self.tree.remove(tid);
            self.renderer_for_taffy.remove(&tid);
        }
    }

    /// Total live Taffy nodes (root container included). Test hook for
    /// asserting that re-Create / Remove don't leak orphaned nodes.
    #[cfg(test)]
    pub(crate) fn total_node_count(&self) -> usize {
        self.tree.total_node_count()
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
        viewport: Viewport,
    ) -> bool {
        let mut all_applied = true;
        for patch in patches {
            if !self.apply_patch(patch, tree, scale, viewport) {
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
        viewport: Viewport,
    ) -> bool {
        use hypen_engine::Patch;
        match patch {
            Patch::Create { id, .. } => {
                if let Some(node) = tree.get(id) {
                    // If this id already maps to a Taffy node, free the
                    // old one before allocating its replacement. Without
                    // this, a host that re-Creates an existing id (e.g.
                    // a render loop rebuilding a subtree) silently
                    // overwrites the map entry and leaves the previous
                    // Taffy node — a full Style + NodeContext — orphaned
                    // in `self.tree` for the process lifetime. Over a
                    // long idle session that is an unbounded leak.
                    if let Some(old) = self.node_map.remove(id) {
                        if let Some(parent) = self.tree.parent(old) {
                            let mut siblings: Vec<NodeId> =
                                self.tree.children(parent).unwrap_or_default();
                            siblings.retain(|c| *c != old);
                            let _ = self.tree.set_children(parent, &siblings);
                        }
                        let _ = self.tree.remove(old);
                        self.renderer_for_taffy.remove(&old);
                    }
                    let active_states = self.interaction.active_states_for(id, node);
                    let style = node_style_with(node, scale, viewport, &active_states);
                    let ctx = node_context(node, scale, viewport);
                    let taffy_id = self.tree.new_leaf_with_context(style, ctx).ok();
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
                let Some(&tid) = self.node_map.get(id) else {
                    return true;
                };
                // Appearance-only props (color / backgroundColor /
                // src / icon paths / etc.) don't change Taffy
                // geometry. Skip `set_style` so Taffy's per-node
                // dirty bit stays clean — the next `compute_layout`
                // becomes a no-op walk, and the painter picks up the
                // new prop value on the next `emit_items` pass that
                // re-reads from the renderer Tree directly.
                if is_layout_prop(name) {
                    if let Some(node) = tree.get(id) {
                        let active_states = self.interaction.active_states_for(id, node);
                        let style = node_style_with(node, scale, viewport, &active_states);
                        let _ = self.tree.set_style(tid, style);
                        if node.element_type == "Text" {
                            let ctx = node_context(node, scale, viewport);
                            let _ = self.tree.set_node_context(tid, Some(ctx));
                        }
                    }
                }
                true
            }
            Patch::SetSemantics { .. } => {
                // Accessibility-only: no Taffy geometry impact. The
                // renderer Tree already updated its `Node.semantics`; the
                // next LayoutPass rebuild re-collects the a11y side-map.
                // (A SetSemantics always accompanies the SetProp for the
                // prop that fed it, so the repaint/AccessKit push it needs
                // is already scheduled.)
                true
            }
            Patch::SetText { id, .. } => {
                // SetText is reserved + always layout-affecting on
                // Text nodes (changes measured width/height).
                let Some(&tid) = self.node_map.get(id) else {
                    return true;
                };
                if let Some(node) = tree.get(id) {
                    let active_states = self.interaction.active_states_for(id, node);
                    let style = node_style_with(node, scale, viewport, &active_states);
                    let _ = self.tree.set_style(tid, style);
                    if node.element_type == "Text" {
                        let ctx = node_context(node, scale, viewport);
                        let _ = self.tree.set_node_context(tid, Some(ctx));
                    }
                }
                true
            }
            Patch::Insert {
                parent_id,
                id,
                before_id,
            }
            | Patch::Attach {
                parent_id,
                id,
                before_id,
            } => {
                self.set_parent_children(parent_id, id, before_id.as_deref(), tree);
                true
            }
            Patch::Move {
                parent_id,
                id,
                before_id,
            } => {
                if let Some(&child) = self.node_map.get(id) {
                    if let Some(old_parent) = self.tree.parent(child) {
                        let mut old: Vec<NodeId> =
                            self.tree.children(old_parent).unwrap_or_default();
                        old.retain(|c| *c != child);
                        let _ = self.tree.set_children(old_parent, &old);
                    }
                }
                self.set_parent_children(parent_id, id, before_id.as_deref(), tree);
                true
            }
            Patch::Remove { id, .. } => {
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
            // Batch-scoped animation prelude: addresses no node and never
            // affects layout. The desktop renderer doesn't animate batch
            // stamps yet — ignoring it snaps, which is the protocol's
            // sanctioned degradation.
            Patch::BatchAnimation { .. } => false,
        }
    }

    fn set_parent_children(
        &mut self,
        parent_id: &str,
        child_id: &str,
        before_id: Option<&str>,
        tree: &Tree,
    ) {
        let Some(&child_tid) = self.node_map.get(child_id) else {
            return;
        };
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
            let Ok(mut s) = self.tree.style(child).cloned() else {
                continue;
            };
            if idx == 0 {
                s.position = Position::Relative;
                s.inset = Rect_ {
                    top: LengthPercentageAuto::auto(),
                    right: LengthPercentageAuto::auto(),
                    bottom: LengthPercentageAuto::auto(),
                    left: LengthPercentageAuto::auto(),
                };
            } else {
                make_stack_overlay_absolute(&mut s);
            }
            let _ = self.tree.set_style(child, s);
        }
    }

    /// Re-style a single node from its current renderer-tree props.
    /// Called by the window when the animation runtime writes a
    /// layout-affecting prop directly into the tree (no patch flows, so
    /// `apply_patch`'s SetProp restyle path never sees it): the retained
    /// Taffy style must follow the interpolated value every tick so
    /// geometry — and hit-testing — track the animation.
    pub fn restyle_node(&mut self, id: &str, tree: &Tree, scale: f32, viewport: Viewport) {
        let (Some(&tid), Some(node)) = (self.node_map.get(id), tree.get(id)) else {
            return;
        };
        let active_states = self.interaction.active_states_for(id, node);
        let style = node_style_with(node, scale, viewport, &active_states);
        let _ = self.tree.set_style(tid, style);
        if node.element_type == "Text" {
            let ctx = node_context(node, scale, viewport);
            let _ = self.tree.set_node_context(tid, Some(ctx));
        }
    }

    /// Re-apply styles to every node and refresh the root style.
    /// Called when the structure key flipped on viewport / scale —
    /// breakpoint resolution and HiDPI scaling are baked into
    /// per-node styles at build time, so we have to recompute them.
    pub fn restyle_all(&mut self, tree: &Tree, scale: f32, viewport_px: (u32, u32)) {
        let viewport = logical_viewport(viewport_px, scale);
        // Re-style every existing node.
        let entries: Vec<(NodeId, String)> = self
            .renderer_for_taffy
            .iter()
            .map(|(t, r)| (*t, r.clone()))
            .collect();
        for (tid, rid) in entries {
            if let Some(node) = tree.get(&rid) {
                let active_states = self.interaction.active_states_for(&rid, node);
                let style = node_style_with(node, scale, viewport, &active_states);
                let _ = self.tree.set_style(tid, style);
                if node.element_type == "Text" {
                    let ctx = node_context(node, scale, viewport);
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
                width: length(viewport_px.0 as f32),
                height: length(viewport_px.1 as f32),
            },
            min_size: Size {
                width: length(viewport_px.0 as f32),
                height: length(viewport_px.1 as f32),
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

/// Hash a [`LayoutInteraction`] so `compute_inner_state` can detect a
/// change between frames and force a `restyle_all`. The default (all
/// `None`) hashes to a stable value, so a tree with no layout-affecting
/// state variants — for which the window never populates this — never
/// trips the interaction-changed branch.
fn interaction_hash(i: &LayoutInteraction) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    i.hovered.hash(&mut h);
    i.pressed.hash(&mut h);
    i.focused.hash(&mut h);
    h.finish()
}

impl LayoutPass {
    /// Convenience for callers that don't need scrolling — equivalent
    /// Convenience for tests / static screenshots that want every
    /// item in the tree, regardless of whether it falls within the
    /// viewport. The App always wants culling, so the public
    /// scroll-aware entry points pass `cull = true` internally.
    pub fn compute(tree: &Tree, text: &mut TextEngine, viewport: (u32, u32), scale: f32) -> Self {
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
        Self::compute_inner(
            tree,
            text,
            viewport,
            scale,
            scroll_y,
            &HashMap::new(),
            false,
        )
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
        Self::compute_inner_state(
            state,
            tree,
            text,
            viewport,
            scale,
            scroll_y,
            scrolls,
            tree_generation,
            true,
        )
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
        Self::compute_inner_state(
            &mut state, tree, text, viewport, scale, scroll_y, scrolls, 0, cull,
        )
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
        let viewport_logical = logical_viewport(viewport, scale);
        // Interaction state feeds layout-affecting state variants. A
        // change since the last compute means the resolved per-node
        // styles are stale and need a restyle so the new active states
        // reach Taffy. The window only mutates `state.interaction` away
        // from the default when the tree actually has layout-affecting
        // state variants, so plain hover/press/focus frames leave this
        // key stable and stay on the fast (no-restyle) path.
        let interaction_key = interaction_hash(&state.interaction);
        let interaction_changed = interaction_key != state.interaction_key;
        let style_changed = state.structure_key != key;
        let needs_rebuild = state.needs_bulk_rebuild;
        // The build / restyle paths read `state.interaction`; clone it
        // up front so the `&mut state.tree` borrow during the bulk
        // rebuild doesn't conflict with the immutable read.
        let interaction = state.interaction.clone();

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
                    viewport_logical,
                    &mut state.renderer_for_taffy,
                    &interaction,
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
        } else if style_changed || interaction_changed || !state.root_initialised {
            // Viewport / scale changed, OR an interaction transition
            // toggled a layout-affecting state variant — either way the
            // structure (renderer Tree) is intact, so just refresh
            // styles (variant-aware) + root size. `restyle_all` walks
            // every node through `node_style_with`, picking up the new
            // active states. Taffy's per-node dirty tracking keeps the
            // subsequent `compute_layout` incremental.
            state.restyle_all(tree, scale, viewport);
            state.structure_key = key;
        } else {
            // Structure key matched (width + scale unchanged), but
            // viewport.height may still have moved — height alone
            // doesn't invalidate any per-node Style, but the root's
            // `min_size.height = viewport.h` does need to follow.
            state.refresh_root_size(scale, viewport);
        }
        state.interaction_key = interaction_key;
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
                    // CSS min-content: break at every legal opportunity,
                    // so the reported width is the widest unbreakable run
                    // (the longest word). Answering MaxContent here — the
                    // full unwrapped line — told Taffy the text could not
                    // break at all, which becomes the item's automatic
                    // minimum size (`min-width: auto`). Flex items then
                    // refused to shrink and overflowed the row instead,
                    // while the painter still wrapped glyphs to the final
                    // rect: two lines of text drawn into a one-line box,
                    // spilling out from under their background pills.
                    AvailableSpace::MinContent => Some(0.0),
                    AvailableSpace::MaxContent => None,
                })
            };
            let (w, h) =
                text.measure_weighted(text_content, ctx.font_size, wrap_width, ctx.font_weight);
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
            viewport_logical,
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

        // Effective opacity post-pass: propagate `opacity` props down the
        // renderer tree multiplicatively (CSS group-opacity semantics,
        // approximated per item — see `LayoutItem::opacity`). Gated on
        // any node actually carrying the prop so the common tree pays a
        // single boolean scan and no per-item ancestor walks. The scan
        // is a prefix match, not exact-key lookups, so variant-decorated
        // keys (`opacity@md.0`, `opacity:hover.0`) open the gate too —
        // `effective_opacity` resolves them breakpoint-aware via
        // `prop_f32_at`, and an exact-key gate would leave a node styled
        // ONLY by a decorated key painting at full opacity.
        let has_opacity = tree
            .nodes()
            .any(|n| n.props.keys().any(|k| k.starts_with("opacity")));
        if has_opacity {
            let mut memo: HashMap<String, f32> = HashMap::new();
            for it in items.iter_mut() {
                it.opacity = effective_opacity(tree, &it.node_id, viewport_logical, &mut memo);
            }
        }

        // Transform post-pass: compose `translateX` / `translateY` /
        // `scale` / `rotate` (static props AND animator-driven writes —
        // one resolution path) into a cumulative per-item affine. Runs
        // AFTER the page-scroll shift so transform origins (rect
        // centers) live in the same coordinate space as the emitted
        // rects. Same gating shape as the opacity pass: a tree with no
        // transform props pays one boolean scan.
        compute_item_transforms(tree, &mut items, viewport_logical, scale);

        let mut by_node_id = HashMap::with_capacity(items.len());
        let mut actionable_ids = Vec::new();
        let mut focusable_ids = Vec::new();
        let mut scrollable_ids = Vec::new();
        let mut hoverable_ids = Vec::new();
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
            if it.hover_action.is_some() {
                hoverable_ids.push(idx);
            }
        }

        // Collect engine-derived semantics for the items that have any, so the
        // AccessKit translation can use them.
        let mut a11y = HashMap::new();
        for it in &items {
            if let Some(node) = tree.get(&it.node_id) {
                if let Some(sem) = node.semantics.as_ref() {
                    a11y.insert(it.node_id.clone(), sem.clone());
                }
            }
        }

        Self {
            items,
            content_size,
            by_node_id,
            actionable_ids,
            focusable_ids,
            scrollable_ids,
            hoverable_ids,
            a11y,
        }
    }

    /// O(1) item lookup by renderer node id.
    pub fn item_by_id(&self, id: &str) -> Option<&LayoutItem> {
        self.by_node_id.get(id).map(|&i| &self.items[i])
    }

    /// Recompute the per-item transform post-pass against the CURRENT
    /// tree props, in place. Used by the window after the animator
    /// writes FLIP invert props into the tree mid-frame (after this
    /// pass's items were already emitted): the freshly-started invert
    /// must reach paint AND hit-testing this same frame, without paying
    /// a full Taffy recompute (transforms are paint/hit-only — Taffy
    /// geometry is untouched by them).
    pub fn refresh_transforms(&mut self, tree: &Tree, viewport: Viewport, scale: f32) {
        compute_item_transforms(tree, &mut self.items, viewport, scale);
    }

    pub fn hit(&self, x: f32, y: f32) -> Option<&LayoutItem> {
        self.hit_excluding(x, y, &|_| false)
    }

    /// [`LayoutPass::hit`] with an exclusion predicate. Items whose node
    /// id the predicate rejects are skipped and the search continues to
    /// items beneath them. Used by the window to exclude exit-animating
    /// subtrees — engine-side those ids are already dead, so the corpse
    /// must not swallow clicks while its exit plays.
    pub fn hit_excluding(
        &self,
        x: f32,
        y: f32,
        excluded: &dyn Fn(&str) -> bool,
    ) -> Option<&LayoutItem> {
        // Walk actionables in reverse paint order — topmost wins.
        // O(n_actionables) instead of O(n_items). `hit_contains` is the
        // transform-aware containment (constraint #5: a transformed
        // pixel's hit target is at the transformed position).
        self.actionable_ids
            .iter()
            .rev()
            .map(|&i| &self.items[i])
            .find(|it| it.hit_contains(x, y) && !excluded(&it.node_id))
    }

    /// Topmost element with an `onHover` applicator under the cursor.
    /// Parallel pipeline to `hit()` because hover-trackable subjects
    /// aren't gated to actionable types (a plain Row / Container can
    /// opt in via `.onHover(...)`).
    pub fn hit_hoverable(&self, x: f32, y: f32) -> Option<&LayoutItem> {
        self.hit_hoverable_excluding(x, y, &|_| false)
    }

    /// [`LayoutPass::hit_hoverable`] with an exclusion predicate (see
    /// [`LayoutPass::hit_excluding`]).
    pub fn hit_hoverable_excluding(
        &self,
        x: f32,
        y: f32,
        excluded: &dyn Fn(&str) -> bool,
    ) -> Option<&LayoutItem> {
        self.hoverable_ids
            .iter()
            .rev()
            .map(|&i| &self.items[i])
            .find(|it| it.hit_contains(x, y) && !excluded(&it.node_id))
    }

    /// Topmost focusable item under the cursor — actionables OR text
    /// inputs. Used by mouse-down to choose a focus target (clicking
    /// an Input focuses it for typing; clicking a Button focuses *and*
    /// the matching mouse-up dispatches its action).
    pub fn hit_focusable(&self, x: f32, y: f32) -> Option<&LayoutItem> {
        self.hit_focusable_excluding(x, y, &|_| false)
    }

    /// [`LayoutPass::hit_focusable`] with an exclusion predicate (see
    /// [`LayoutPass::hit_excluding`]).
    pub fn hit_focusable_excluding(
        &self,
        x: f32,
        y: f32,
        excluded: &dyn Fn(&str) -> bool,
    ) -> Option<&LayoutItem> {
        self.focusable_ids
            .iter()
            .rev()
            .map(|&i| &self.items[i])
            .find(|it| it.hit_contains(x, y) && !excluded(&it.node_id))
    }

    /// Topmost scrollable Container under the cursor. Used by the
    /// wheel handler to route scroll to the innermost scrollable.
    pub fn hit_scrollable(&self, x: f32, y: f32) -> Option<&LayoutItem> {
        self.hit_scrollable_excluding(x, y, &|_| false)
    }

    /// [`LayoutPass::hit_scrollable`] with an exclusion predicate (see
    /// [`LayoutPass::hit_excluding`]).
    pub fn hit_scrollable_excluding(
        &self,
        x: f32,
        y: f32,
        excluded: &dyn Fn(&str) -> bool,
    ) -> Option<&LayoutItem> {
        self.scrollable_ids
            .iter()
            .rev()
            .map(|&i| &self.items[i])
            .find(|it| it.hit_contains(x, y) && !excluded(&it.node_id))
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
        self.focus_next_excluding(current, &|_| false)
    }

    /// [`LayoutPass::focus_next`] with an exclusion predicate (see
    /// [`LayoutPass::hit_excluding`]): excluded ids — exit-animating
    /// subtrees, whose nodes still paint but are engine-side dead —
    /// are skipped, continuing (with wrap) to the next non-excluded
    /// focusable. `None` when every focusable is excluded.
    pub fn focus_next_excluding(
        &self,
        current: Option<&str>,
        excluded: &dyn Fn(&str) -> bool,
    ) -> Option<String> {
        let n = self.focusable_ids.len();
        if n == 0 {
            return None;
        }
        let start = current
            .and_then(|c| {
                self.focusable_ids
                    .iter()
                    .position(|&i| self.items[i].node_id == c)
            })
            .map(|i| (i + 1) % n)
            .unwrap_or(0);
        for step in 0..n {
            let id = &self.items[self.focusable_ids[(start + step) % n]].node_id;
            if !excluded(id) {
                return Some(id.clone());
            }
        }
        None
    }

    /// Node id of the focusable that precedes `current` in document
    /// order. Wraps to the last when `current` is the first.
    pub fn focus_prev(&self, current: Option<&str>) -> Option<String> {
        self.focus_prev_excluding(current, &|_| false)
    }

    /// [`LayoutPass::focus_prev`] with an exclusion predicate (see
    /// [`LayoutPass::focus_next_excluding`]).
    pub fn focus_prev_excluding(
        &self,
        current: Option<&str>,
        excluded: &dyn Fn(&str) -> bool,
    ) -> Option<String> {
        let n = self.focusable_ids.len();
        if n == 0 {
            return None;
        }
        let start = current
            .and_then(|c| {
                self.focusable_ids
                    .iter()
                    .position(|&i| self.items[i].node_id == c)
            })
            .map(|i| (i + n - 1) % n)
            .unwrap_or(n - 1);
        for step in 0..n {
            let id = &self.items[self.focusable_ids[(start + n - step) % n]].node_id;
            if !excluded(id) {
                return Some(id.clone());
            }
        }
        None
    }
}

impl LayoutItem {
    /// True for items that take focus on click / Tab — actionables
    /// (Buttons, Cards, Links) plus text-input elements.
    pub fn is_focusable(&self) -> bool {
        self.action.is_some() || matches!(self.kind, ItemKind::Input { .. })
    }

    /// Transform-aware pointer containment: the viewport-space point is
    /// inverse-transformed into item space and tested against the
    /// layout rect — correct under scale + rotate + translate, and under
    /// nested transforms (the cumulative transform composes them all).
    /// A degenerate transform (`scale(0)`) makes the item unhittable.
    /// EVERY pointer hit path (`hit_*`) routes through this so pixels
    /// and hit targets can never disagree.
    pub fn hit_contains(&self, x: f32, y: f32) -> bool {
        // An ancestor scrollable's overflow clip (`clip_to`) crops this
        // item in VIEWPORT space, OUTSIDE its own transform — CSS
        // overflow semantics, and exactly what paint does: the clip is
        // pushed on the main scene under `Affine::IDENTITY`, before the
        // item's affine (see `vello_painter::draw_item` / the
        // `push_outer_clip` sites). A point outside that clip is never
        // painted, so it must never hit either — otherwise an item
        // scrolled/transformed past its scrollable ancestor's edge stays
        // clickable through the (now empty) space it vacated. Test the
        // RAW viewport point here, before the transform-inverse below,
        // because `clip_to` lives in the same space as the raw point (it
        // rides `rect` through every page-scroll shift).
        if let Some(clip) = self.clip_to {
            if !clip.contains(x, y) {
                return false;
            }
        }
        if self.transform.is_identity() {
            return self.rect.contains(x, y);
        }
        match self.transform.inverse() {
            Some(inv) => {
                let (lx, ly) = inv.apply(x, y);
                self.rect.contains(lx, ly)
            }
            None => false,
        }
    }

    /// Map a viewport-space point into this item's LOCAL (layout-rect)
    /// space — the space `rect`, text metrics, and caret math live in.
    /// Identity transform returns the point unchanged; a degenerate
    /// transform (unhittable anyway) also falls back to the unchanged
    /// point so caret math degrades gracefully.
    pub fn to_local(&self, x: f32, y: f32) -> (f32, f32) {
        if self.transform.is_identity() {
            return (x, y);
        }
        match self.transform.inverse() {
            Some(inv) => inv.apply(x, y),
            None => (x, y),
        }
    }

    /// The item's VISUAL rect: the axis-aligned bounding box of the
    /// layout rect under the cumulative transform. What AccessKit
    /// publishes, damage regions cover, and paint culling tests —
    /// `rect` itself stays the untransformed Taffy geometry.
    pub fn visual_rect(&self) -> Rect {
        self.transform.aabb_of(self.rect)
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
    viewport: Viewport,
    renderer_for_taffy: &mut HashMap<NodeId, String>,
    interaction: &LayoutInteraction,
) -> Option<NodeId> {
    let node = tree.get(node_id)?;
    // Per-node active interaction states for layout-affecting state
    // variants. Empty (fast path) unless this node is the hovered /
    // pressed / focused subject or is disabled.
    let vs = VariantState::paint(viewport, interaction.active_states_for(node_id, node));

    match node.element_type.as_str() {
        et if IMAGE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
            // Images sized by `width` / `height` (px or %), with
            // `.size(N)` as the square-fallback (icons use this).
            // Percent maps to Taffy's `Dimension::Percent` so an
            // Image with `.width("100%")` fills its parent column.
            let size_fallback = prop_f32_with(node, "size", &vs);
            let w_dim = prop_dim_with(node, "width", &vs);
            let h_dim = prop_dim_with(node, "height", &vs);
            let aspect_ratio = crate::style::prop_aspect_ratio_with(node, "aspectRatio", &vs);

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
                margin: margin_to_taffy(margin_with(node, &vs), scale),
                border: border_to_taffy(border_with(node, &vs), scale),
                ..Default::default()
            };
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
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
                margin: margin_to_taffy(margin_with(node, &vs), scale),
                border: border_to_taffy(border_with(node, &vs), scale),
                ..Default::default()
            };
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            let id = taffy.new_leaf(style).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        "Text" => {
            let font_size = prop_f32_at(node, "fontSize", viewport)
                .map(|v| v * scale)
                .unwrap_or(DEFAULT_FONT_SIZE_PX * scale);
            let content = node
                .text_content()
                .map(|c| c.into_owned())
                .unwrap_or_default();
            // Text leaves DO take padding / margin / border like any
            // other flex node — `tw("text-sm font-semibold px-4")` on
            // a Text was being silently dropped because the Text
            // branch only set `display: Flex` and forgot the box
            // model. `px-4` then collapsed to zero, and the user saw
            // "1421 likes" rendered flush-left instead of indented.
            let pad = padding_with(node, &vs);
            let mut style = Style {
                display: Display::Flex,
                padding: Rect_ {
                    left: length(pad.left * scale),
                    right: length(pad.right * scale),
                    top: length(pad.top * scale),
                    bottom: length(pad.bottom * scale),
                },
                margin: margin_to_taffy(margin_with(node, &vs), scale),
                border: border_to_taffy(border_with(node, &vs), scale),
                ..Default::default()
            };
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            let id = taffy
                .new_leaf_with_context(
                    style,
                    NodeContext {
                        text: Some(content),
                        font_size,
                        max_lines: resolve_max_lines(node, viewport),
                        font_weight: resolve_font_weight(node, viewport),
                    },
                )
                .ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et if ACTIONABLE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
            // Buttons are flex containers with their own default padding
            // unless overridden by .padding(...).
            let pad = padding_with(node, &vs);
            // Only default when the node declares NO padding. Testing the
            // resolved value for zero cannot distinguish "unset" from an
            // explicit `p-0`, so `.tw("p-0")` silently kept the 16pt default
            // — the launcher's dock icons grew 56pt -> 88pt and four of them
            // overflowed their `max-w-[260px]` container.
            let declares_padding = crate::style::declares_padding(node, &vs);
            let pad_x = if declares_padding {
                (pad.left + pad.right) * 0.5
            } else {
                DEFAULT_BUTTON_PAD_X
            };
            let pad_y = if declares_padding {
                (pad.top + pad.bottom) * 0.5
            } else {
                DEFAULT_BUTTON_PAD_Y
            };
            // Column-direction Button + no implicit centring — see
            // the matching comment in `node_style`'s actionable
            // branch for the full rationale (single-child stretch
            // via cross-axis default, multi-child users wrap in a
            // Row explicitly).
            let mut style = Style {
                display: Display::Flex,
                flex_direction: FlexDirection::Column,
                padding: Rect_ {
                    left: length(pad.left.max(pad_x) * scale),
                    right: length(pad.right.max(pad_x) * scale),
                    top: length(pad.top.max(pad_y) * scale),
                    bottom: length(pad.bottom.max(pad_y) * scale),
                },
                margin: margin_to_taffy(margin_with(node, &vs), scale),
                border: border_to_taffy(border_with(node, &vs), scale),
                gap: Size {
                    width: length(prop_f32_with(node, "gap", &vs).unwrap_or(4.0) * scale),
                    height: length(0.0),
                },
                overflow: taffy::Point {
                    x: Overflow::Visible,
                    y: Overflow::Visible,
                },
                ..Default::default()
            };
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            let mut children = Vec::new();
            for child_id in tree.children_of(node_id) {
                if let Some(c) =
                    build_subtree(taffy, tree, child_id, scale, viewport, renderer_for_taffy, interaction)
                {
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
            let pad = padding_with(node, &vs);
            let mut style = Style {
                display: Display::Flex,
                padding: Rect_ {
                    left: length(pad.left * scale),
                    right: length(pad.right * scale),
                    top: length(pad.top * scale),
                    bottom: length(pad.bottom * scale),
                },
                margin: margin_to_taffy(margin_with(node, &vs), scale),
                border: border_to_taffy(border_with(node, &vs), scale),
                ..Default::default()
            };
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            let mut children = Vec::new();
            for child_id in tree.children_of(node_id) {
                if let Some(c) =
                    build_subtree(taffy, tree, child_id, scale, viewport, renderer_for_taffy, interaction)
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
                    make_stack_overlay_absolute(&mut s);
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
            let cols = prop_f32_with(node, "gridColumns", &vs)
                .map(|v| v.max(1.0) as u16)
                .unwrap_or(1);
            let pad = padding_with(node, &vs);
            let gap_v = prop_f32_with(node, "gap", &vs).unwrap_or(DEFAULT_GAP_PX) * scale;
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
                margin: margin_to_taffy(margin_with(node, &vs), scale),
                border: border_to_taffy(border_with(node, &vs), scale),
                gap: Size {
                    width: length(gap_v),
                    height: length(gap_v),
                },
                ..Default::default()
            };
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            apply_overflow_props(&mut style, node, viewport);
            apply_position_props(&mut style, node, &vs, scale);
            let mut children = Vec::new();
            for child_id in tree.children_of(node_id) {
                if let Some(c) =
                    build_subtree(taffy, tree, child_id, scale, viewport, renderer_for_taffy, interaction)
                {
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
            let pad = padding_with(node, &vs);
            let gap_v = prop_f32_with(node, "gap", &vs).unwrap_or(DEFAULT_GAP_PX) * scale;
            let mut style = Style {
                display: Display::Flex,
                flex_direction: dir,
                padding: Rect_ {
                    left: length(pad.left * scale),
                    right: length(pad.right * scale),
                    top: length(pad.top * scale),
                    bottom: length(pad.bottom * scale),
                },
                margin: margin_to_taffy(margin_with(node, &vs), scale),
                border: border_to_taffy(border_with(node, &vs), scale),
                gap: Size {
                    width: length(gap_v),
                    height: length(gap_v),
                },
                ..Default::default()
            };
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            // Critical: `apply_overflow_props` here is what turns
            // `.scrollable(true)` into Taffy `overflow: scroll` on
            // first build. Without it, the bulk-build path produces
            // a HomePage that grows to its full content height and
            // wheel events bottom out at `max=0`. `node_style()` (used
            // by patches / restyle_all) had these — `build_subtree`
            // didn't. Same goes for `apply_position_props` (Story's
            // `absolute top-0 left-0 right-0` overlay would have been
            // silently re-stacked under the post image otherwise).
            apply_overflow_props(&mut style, node, viewport);
            apply_position_props(&mut style, node, &vs, scale);
            let mut children = Vec::new();
            for child_id in tree.children_of(node_id) {
                if let Some(c) =
                    build_subtree(taffy, tree, child_id, scale, viewport, renderer_for_taffy, interaction)
                {
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
            | "minwidth"
            | "min-width"
            | "minheight"
            | "min-height"
            | "maxwidth"
            | "max-width"
            | "maxheight"
            | "max-height"
            | "aspectratio"
            | "aspect-ratio"
            | "fontsize"
            | "font-size"
            | "fontweight"
            | "font-weight"
            | "gap"
            | "flex"
            | "flexgrow"
            | "flex-grow"
            | "flexshrink"
            | "flex-shrink"
            | "flexbasis"
            | "flex-basis"
            | "alignitems"
            | "align-items"
            | "alignself"
            | "align-self"
            | "alignContent"
            | "align-content"
            | "justifycontent"
            | "justify-content"
            | "justifyself"
            | "justify-self"
            | "display"
            | "overflow"
            | "overflowx"
            | "overflow-x"
            | "overflowy"
            | "overflow-y"
            | "position"
            | "top"
            | "right"
            | "bottom"
            | "left"
            | "0" // positional Text content — re-shapes the line
    )
}

/// Compute the Taffy `Style` for a renderer node based on its
/// element type + props. Pure function: no Taffy mutations, no
/// recursion. Used both by `build_subtree` (for the initial bulk
/// build path) and `TaffyState::apply_patch` (per-node Create /
/// SetProp updates).
///
/// `active_states` are the node's live interaction states (`hover` /
/// `focus` / `active` / `disabled`) so layout-affecting state variants
/// (`padding:hover`, …) resolve into the geometry. An empty slice
/// resolves only responsive breakpoints — the behaviour every call site
/// had before interaction states were threaded in.
pub(crate) fn node_style_with(
    node: &crate::tree::Node,
    scale: f32,
    viewport: Viewport,
    active_states: &[&str],
) -> Style {
    let vs = VariantState::paint(viewport, active_states.to_vec());
    let et = node.element_type.as_str();
    let mut style = if IMAGE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) {
        let size_fallback = prop_f32_with(node, "size", &vs);
        let w_dim = prop_dim_with(node, "width", &vs);
        let h_dim = prop_dim_with(node, "height", &vs);
        let aspect_ratio = crate::style::prop_aspect_ratio_with(node, "aspectRatio", &vs);
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
            margin: margin_to_taffy(margin_with(node, &vs), scale),
            border: border_to_taffy(border_with(node, &vs), scale),
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
            margin: margin_to_taffy(margin_with(node, &vs), scale),
            border: border_to_taffy(border_with(node, &vs), scale),
            ..Default::default()
        }
    } else if et == "Text" {
        let pad = padding_with(node, &vs);
        Style {
            display: Display::Flex,
            padding: Rect_ {
                left: length(pad.left * scale),
                right: length(pad.right * scale),
                top: length(pad.top * scale),
                bottom: length(pad.bottom * scale),
            },
            margin: margin_to_taffy(margin_with(node, &vs), scale),
            border: border_to_taffy(border_with(node, &vs), scale),
            ..Default::default()
        }
    } else if ACTIONABLE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) {
        let pad = padding_with(node, &vs);
        // See the matching branch in `node_style_with`: default only when the
        // node declares NO padding, so an explicit `p-0` is honoured.
        let declares_padding = crate::style::declares_padding(node, &vs);
        let pad_x = if declares_padding {
            (pad.left + pad.right) * 0.5
        } else {
            DEFAULT_BUTTON_PAD_X
        };
        let pad_y = if declares_padding {
            (pad.top + pad.bottom) * 0.5
        } else {
            DEFAULT_BUTTON_PAD_Y
        };
        Style {
            display: Display::Flex,
            // `Column` direction (not Row) so the Button's single
            // child stretches to fill the Button's width through
            // flex's default `align-items: stretch` (cross axis =
            // horizontal in Column direction). With Row direction,
            // stretch only fills height — the meal-card Button's
            // inner `Row { icon, Column.flex-1, arrow }` would stay
            // content-sized and the `flex-1` Column inside would
            // have no room to grow. Every Button in the social /
            // calorie examples has exactly one direct child (an
            // Icon, Image, or a wrapping Row); multi-child layouts
            // wrap in an explicit `Row {}`.
            //
            // No implicit `align-items: center` / `justify-content:
            // center` either — users opt in via
            // `tw("items-center justify-center")`, which all the
            // genuinely-icon-centred Buttons already do.
            flex_direction: FlexDirection::Column,
            padding: Rect_ {
                left: length(pad.left.max(pad_x) * scale),
                right: length(pad.right.max(pad_x) * scale),
                top: length(pad.top.max(pad_y) * scale),
                bottom: length(pad.bottom.max(pad_y) * scale),
            },
            margin: margin_to_taffy(margin_with(node, &vs), scale),
            border: border_to_taffy(border_with(node, &vs), scale),
            gap: Size {
                width: length(prop_f32_with(node, "gap", &vs).unwrap_or(4.0) * scale),
                height: length(0.0),
            },
            overflow: taffy::Point {
                x: Overflow::Visible,
                y: Overflow::Visible,
            },
            ..Default::default()
        }
    } else if et.eq_ignore_ascii_case("Stack") {
        let pad = padding_with(node, &vs);
        Style {
            display: Display::Flex,
            padding: Rect_ {
                left: length(pad.left * scale),
                right: length(pad.right * scale),
                top: length(pad.top * scale),
                bottom: length(pad.bottom * scale),
            },
            margin: margin_to_taffy(margin_with(node, &vs), scale),
            border: border_to_taffy(border_with(node, &vs), scale),
            ..Default::default()
        }
    } else if et.eq_ignore_ascii_case("Grid") {
        // Mirror of `build_subtree`'s Grid branch — see that comment
        // for the rationale (Search's explore feed needs N equal
        // tracks instead of falling through to a 1-column flex).
        let cols = prop_f32_with(node, "gridColumns", &vs)
            .map(|v| v.max(1.0) as u16)
            .unwrap_or(1);
        let pad = padding_with(node, &vs);
        let gap_v = prop_f32_with(node, "gap", &vs).unwrap_or(DEFAULT_GAP_PX) * scale;
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
            margin: margin_to_taffy(margin_with(node, &vs), scale),
            border: border_to_taffy(border_with(node, &vs), scale),
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
        let pad = padding_with(node, &vs);
        let gap_v = prop_f32_with(node, "gap", &vs).unwrap_or(DEFAULT_GAP_PX) * scale;
        Style {
            display: Display::Flex,
            flex_direction: dir,
            padding: Rect_ {
                left: length(pad.left * scale),
                right: length(pad.right * scale),
                top: length(pad.top * scale),
                bottom: length(pad.bottom * scale),
            },
            margin: margin_to_taffy(margin_with(node, &vs), scale),
            border: border_to_taffy(border_with(node, &vs), scale),
            gap: Size {
                width: length(gap_v),
                height: length(gap_v),
            },
            ..Default::default()
        }
    };
    apply_flex_props(&mut style, node, &vs, scale);
    apply_alignment_props(&mut style, node, viewport);
    apply_size_props(&mut style, node, &vs, scale);
    apply_overflow_props(&mut style, node, viewport);
    apply_position_props(&mut style, node, &vs, scale);
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
    vs: &VariantState,
    scale: f32,
) {
    use crate::style::{prop_dim_with, prop_str_at, Dim};
    let viewport = vs.viewport;
    if let Some(s) = prop_str_at(node, "position", viewport) {
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
    if let Some(d) = prop_dim_with(node, "inset", vs) {
        let v = dim_to_lpa(d, scale);
        style.inset = Rect_ {
            top: v,
            right: v,
            bottom: v,
            left: v,
        };
    }
    if let Some(d) = prop_dim_with(node, "top", vs) {
        style.inset.top = dim_to_lpa(d, scale);
    }
    if let Some(d) = prop_dim_with(node, "right", vs) {
        style.inset.right = dim_to_lpa(d, scale);
    }
    if let Some(d) = prop_dim_with(node, "bottom", vs) {
        style.inset.bottom = dim_to_lpa(d, scale);
    }
    if let Some(d) = prop_dim_with(node, "left", vs) {
        style.inset.left = dim_to_lpa(d, scale);
    }
}

/// Apply CSS-style overflow props (`overflow`, `overflowX`,
/// `overflowY`) and the Hypen-DSL `.scrollable(...)` applicator to
/// `style.overflow`. Without this, scrollable containers' children
/// painted past the parent's bounds — e.g. a horizontal Stories row
/// with five items at `w-20` apiece overflowing into the viewport
/// margin instead of clipping at the row's right edge.
fn apply_overflow_props(style: &mut Style, node: &crate::tree::Node, viewport: Viewport) {
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
    let scrollable_axes = match crate::style::prop_str_at(node, "scrollable", viewport)
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
    if let Some(o) = prop_str_at(node, "overflow", viewport).and_then(parse) {
        style.overflow = taffy::Point { x: o, y: o };
    }
    if let Some(o) = prop_str_at(node, "overflowX", viewport).and_then(parse) {
        style.overflow.x = o;
    }
    if let Some(o) = prop_str_at(node, "overflowY", viewport).and_then(parse) {
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
pub(crate) fn node_context(node: &crate::tree::Node, scale: f32, viewport: Viewport) -> NodeContext {
    if node.element_type == "Text" {
        let font_size = prop_f32_at(node, "fontSize", viewport)
            .map(|v| v * scale)
            .unwrap_or(DEFAULT_FONT_SIZE_PX * scale);
        let font_weight = resolve_font_weight(node, viewport);
        NodeContext {
            text: Some(
                node.text_content()
                    .map(|c| c.into_owned())
                    .unwrap_or_default(),
            ),
            font_size,
            max_lines: resolve_max_lines(node, viewport),
            font_weight,
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
pub(crate) fn resolve_max_lines(node: &crate::tree::Node, viewport: Viewport) -> Option<u32> {
    let v = prop_f32_at(node, "maxLines", viewport)
        .or_else(|| prop_f32_at(node, "max-lines", viewport))?;
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

/// Convert a Stack overlay child (any child past the first) into an
/// absolute box. The child's margins become top/left inset offsets so
/// `.marginTop(36).marginLeft(36)` anchors a badge at +36/+36 from the
/// parent's top-left instead of pushing into flex flow; right/bottom
/// stay `auto` so the overlay sizes to its own width/height (or content).
fn make_stack_overlay_absolute(s: &mut Style) {
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

/// Read `width` / `height` props (px or %) and apply to the Style's
/// `size`. Touches every container kind so explicit sizing on
/// generic Columns / Rows / Containers behaves like every other
/// renderer instead of always falling through to content size.
fn apply_size_props(style: &mut Style, node: &crate::tree::Node, vs: &VariantState, scale: f32) {
    if let Some(d) = prop_dim_with(node, "width", vs) {
        style.size.width = match d {
            Dim::Length(v) => Dimension::length(v * scale),
            Dim::Percent(p) => Dimension::percent(p),
        };
    }
    if let Some(d) = prop_dim_with(node, "height", vs) {
        style.size.height = match d {
            Dim::Length(v) => Dimension::length(v * scale),
            Dim::Percent(p) => Dimension::percent(p),
        };
    }
    if let Some(d) = prop_dim_with(node, "minWidth", vs) {
        style.min_size.width = match d {
            Dim::Length(v) => Dimension::length(v * scale),
            Dim::Percent(p) => Dimension::percent(p),
        };
    }
    if let Some(d) = prop_dim_with(node, "minHeight", vs) {
        style.min_size.height = match d {
            Dim::Length(v) => Dimension::length(v * scale),
            Dim::Percent(p) => Dimension::percent(p),
        };
    }
    if let Some(d) = prop_dim_with(node, "maxWidth", vs) {
        style.max_size.width = match d {
            Dim::Length(v) => Dimension::length(v * scale),
            Dim::Percent(p) => Dimension::percent(p),
        };
    }
    if let Some(d) = prop_dim_with(node, "maxHeight", vs) {
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
fn apply_alignment_props(style: &mut Style, node: &crate::tree::Node, viewport: Viewport) {
    use crate::style::prop_str_at;
    // Hypen's semantic aliases. These name a *geometric* axis, so which
    // flex property they map to flips with `flex_direction` — in a Row
    // `horizontalAlignment` is the main axis (justify), in a Column it
    // is the cross axis (align). Same convention as the Android and
    // SwiftUI renderers.
    //
    // Read before the CSS names below so an explicit `justifyContent` /
    // `alignItems` on the same node still wins.
    //
    // Desktop understood neither alias, so todo's task rows lost both
    // their `space-between` (Remove stopped being pushed to the right
    // edge) and their `center` cross-alignment (text and button sat on
    // staggered baselines).
    let column = matches!(
        style.flex_direction,
        FlexDirection::Column | FlexDirection::ColumnReverse
    );
    for (name, is_main_axis) in [
        ("horizontalAlignment", !column),
        ("verticalAlignment", column),
    ] {
        let Some(s) = prop_str_at(node, name, viewport) else {
            continue;
        };
        if is_main_axis {
            if let Some(j) = parse_justify(&s) {
                style.justify_content = Some(j);
            }
        } else if let Some(a) = parse_align(&s) {
            style.align_items = Some(a);
        }
    }
    if let Some(s) = prop_str_at(node, "alignItems", viewport) {
        if let Some(a) = parse_align(&s) {
            style.align_items = Some(a);
        }
    }
    if let Some(s) = prop_str_at(node, "alignSelf", viewport) {
        if let Some(a) = parse_align(&s) {
            style.align_self = Some(a);
        }
    }
    if let Some(s) = prop_str_at(node, "justifyContent", viewport) {
        if let Some(j) = parse_justify(&s) {
            style.justify_content = Some(j);
        }
    }
    if let Some(s) = prop_str_at(node, "justifySelf", viewport) {
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
/// Apply the `flex: <n>` shorthand (`grow: n, shrink: 1, basis: 0`).
///
/// CSS `flex: 1` is shorthand for `1 1 0%`, but the spec specially-cases
/// `flex-basis: 0%` to resolve to 0 *unconditionally* — it does NOT
/// require a definite parent. Taffy 0.10's percent resolution is not
/// specially cased; with an indefinite-size ancestor anywhere up the
/// chain, every level's `flex-basis: 0%` falls back to content sizing
/// and the whole flex distribution collapses (the bug behind HomePage's
/// `rect_h ≈ content_h` despite `flex-1` + `min_size = 0` +
/// `overflow: scroll`). Emitting `Length(0)` instead of `Percent(0)`
/// makes the basis unconditionally zero, which is what browsers do.
fn set_flex_shorthand(style: &mut Style, num: f32) {
    style.flex_grow = num;
    style.flex_shrink = 1.0;
    style.flex_basis = Dimension::length(0.0);
}

fn apply_flex_props(style: &mut Style, node: &crate::tree::Node, vs: &VariantState, scale: f32) {
    use crate::style::{prop_dim_with, prop_f32_with, prop_str_with, Dim};
    if let Some(s) = prop_str_with(node, "flex", vs) {
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
                    set_flex_shorthand(style, num);
                }
            }
        }
    } else if let Some(num) = prop_f32_with(node, "flex", vs) {
        // `.flex(1)` in the DSL serialises its argument as a JSON
        // *number*, not a string, so the `prop_str_at` path above never
        // sees it and the node silently kept the Taffy default
        // (`grow: 0`). That's the "URL bar / toolbar field won't grow to
        // full width" bug: the address-bar pill is `.flex(1)` and got
        // dropped, so it shrank to content. Apply the same `flex: <n>`
        // shorthand for the numeric form.
        set_flex_shorthand(style, num);
    }
    if let Some(g) = prop_f32_with(node, "flexGrow", vs) {
        style.flex_grow = g;
    }
    if let Some(sh) = prop_f32_with(node, "flexShrink", vs) {
        style.flex_shrink = sh;
    }
    if let Some(b) = prop_dim_with(node, "flexBasis", vs) {
        style.flex_basis = match b {
            Dim::Length(v) => Dimension::length(v * scale),
            Dim::Percent(p) => Dimension::percent(p),
        };
    }
    // CSS `flex-direction: row | column | row-reverse | column-reverse`.
    // Without this, every non-`Row` element type (`List`, `Grid`,
    // `Container`, etc.) renders as a flex Column regardless of what
    // the user wrote in `.tw("flex-row")` — the AddFood category tabs
    // are the visible victim: they stack vertically because the
    // wrapping `List` defaults to Column and ignores its
    // `flex-direction: row` prop. Element-type still seeds the
    // default (so a `Row` declared without any tw still works), but
    // any explicit `flex-direction` overrides.
    if let Some(s) = prop_str_with(node, "flexDirection", vs) {
        match s.trim().to_ascii_lowercase().as_str() {
            "row" => style.flex_direction = FlexDirection::Row,
            "row-reverse" => style.flex_direction = FlexDirection::RowReverse,
            "column" => style.flex_direction = FlexDirection::Column,
            "column-reverse" => style.flex_direction = FlexDirection::ColumnReverse,
            _ => {}
        }
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
    viewport: Viewport,
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
            let hover_action = resolve_hover_action(node);
            let hover_payload = hover_action
                .as_ref()
                .and_then(|_| resolve_hover_payload(node));
            let mut item_border = border_at(node, viewport);
            // The DSL says `.borderRadius(8)` even when there's no
            // border line — round the fill anyway. The painter checks
            // `is_visible()` independently before stroking.
            let background_explicit = prop_color_at(node, "backgroundColor", viewport);
            // `hover:` tw variant — the engine expands `hover:bg-white`
            // into a `backgroundColor:hover` prop (and `:hover.0`), which
            // `prop_color_at` finds via its `.0` fallback. Resolved once;
            // the painter applies it while the item is hovered.
            let hover = HoverStyle {
                background: prop_color_at(node, "backgroundColor:hover", viewport),
                border_color: prop_color_at(node, "borderColor:hover", viewport),
            };
            // Tailwind `bg-gradient-to-* from-* via-* to-*` emits a
            // `background-image: linear-gradient(...)` plus the
            // `--tw-gradient-*` custom props; `prop_linear_gradient`
            // resolves the var-indirection and parses to our
            // painter-side type. Returns `None` for the typical
            // solid-fill case → painter takes its existing fast
            // path. Only the `Container` push reads this today, but
            // we resolve it once here to avoid repeating work.
            let background_gradient = crate::style::prop_linear_gradient(node, viewport);
            // The `url(...)` layer of the same value. Resolved once here
            // beside the gradient so every item kind carries it.
            let background_image = crate::style::prop_background_image_url(node);
            // Paint-time state-variant colour overrides (hover/focus/
            // active/disabled). Resolved once here for every item kind;
            // empty for the common plain-styled node so the painter's
            // fast path is undisturbed.
            let item_state_variants = crate::style::state_variants(node, viewport);
            let scrollable = is_scrollable_node(node, viewport);
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
                        prop_f32_at(node, "fontSize", viewport).unwrap_or(DEFAULT_FONT_SIZE_PX);
                    let font_weight = resolve_font_weight(node, viewport);
                    let color = prop_color_at(node, "color", viewport).unwrap_or(Rgba::BLACK);
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
                        hover_action: hover_action.clone(),
                        hover_payload: hover_payload.clone(),
                        background,
                        hover,
                        border: item_border,
                        scrollable: None,
                        font_weight,
                        clip_to: parent_clip_to,
                        subtree_root: subtree_root.map(str::to_string),
                        background_gradient: background_gradient.clone(),
                        background_image: background_image.clone(),
                        state_variants: item_state_variants.clone(),
                        opacity: 1.0,
                        transform: Affine2::IDENTITY,
                    });
                }
                "Text" => {
                    let font_size =
                        prop_f32_at(node, "fontSize", viewport).unwrap_or(DEFAULT_FONT_SIZE_PX);
                    let font_weight = resolve_font_weight(node, viewport);
                    let color = prop_color_at(node, "color", viewport).unwrap_or(Rgba::BLACK);
                    let content = node
                        .text_content()
                        .map(|c| c.into_owned())
                        .unwrap_or_default();
                    let align =
                        parse_text_align(crate::style::prop_str_at(node, "textAlign", viewport));
                    let max_lines = resolve_max_lines(node, viewport);
                    // Pass padding to the painter so it can shift the
                    // glyph origin / shrink the wrap width without
                    // losing the outer rect (which still drives bg /
                    // border rendering and hit-testing).
                    let pad = padding_at(node, viewport);
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
                        hover_action: hover_action.clone(),
                        hover_payload: hover_payload.clone(),
                        background: background_explicit,
                        hover,
                        border: item_border,
                        scrollable: None,
                        font_weight,
                        clip_to: parent_clip_to,
                        subtree_root: subtree_root.map(str::to_string),
                        background_gradient: background_gradient.clone(),
                        background_image: background_image.clone(),
                        state_variants: item_state_variants.clone(),
                        opacity: 1.0,
                        transform: Affine2::IDENTITY,
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
                            .or_else(|| node.props.get("viewBox").and_then(|v| v.as_str()));
                        let view_box = crate::paint::icon::parse_view_box(view_box_str);
                        let tint = prop_color_at(node, "color", viewport);
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
                            hover_action: hover_action.clone(),
                            hover_payload: hover_payload.clone(),
                            background: background_explicit,
                            hover,
                            border: item_border,
                            scrollable: None,
                            font_weight: 400,
                            clip_to: parent_clip_to,
                            subtree_root: subtree_root.map(str::to_string),
                            background_gradient: background_gradient.clone(),
                        background_image: background_image.clone(),
                            state_variants: item_state_variants.clone(),
                            opacity: 1.0,
                            transform: Affine2::IDENTITY,
                        });
                    } else {
                        let src =
                            crate::style::prop_str_at(node, "src", viewport).map(str::to_string);
                        let fit = parse_object_fit(crate::style::prop_str_at(
                            node,
                            "objectFit",
                            viewport,
                        ));
                        out.push(LayoutItem {
                            node_id: rid.to_string(),
                            kind: ItemKind::Image { src, fit },
                            rect,
                            action,
                            action_payload: action_payload.clone(),
                            hover_action: hover_action.clone(),
                            hover_payload: hover_payload.clone(),
                            background: background_explicit,
                            hover,
                            border: item_border,
                            scrollable: None,
                            font_weight: 400,
                            clip_to: parent_clip_to,
                            subtree_root: subtree_root.map(str::to_string),
                            background_gradient: background_gradient.clone(),
                        background_image: background_image.clone(),
                            state_variants: item_state_variants.clone(),
                            opacity: 1.0,
                            transform: Affine2::IDENTITY,
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
                        hover_action: hover_action.clone(),
                        hover_payload: hover_payload.clone(),
                        background: background_explicit,
                        hover,
                        border: item_border,
                        scrollable: None,
                        font_weight: 400,
                        clip_to: parent_clip_to,
                        subtree_root: subtree_root.map(str::to_string),
                        background_gradient: background_gradient.clone(),
                        background_image: background_image.clone(),
                        state_variants: item_state_variants.clone(),
                        opacity: 1.0,
                        transform: Affine2::IDENTITY,
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
                        hover_action,
                        hover_payload,
                        background: background_explicit,
                        hover,
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
                        background_gradient: background_gradient.clone(),
                        background_image: background_image.clone(),
                        state_variants: item_state_variants,
                        opacity: 1.0,
                        transform: Affine2::IDENTITY,
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
    for child in flow_children.iter().chain(overlay_children.iter()).copied() {
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
            viewport,
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

/// Effective opacity for `id`: its own `opacity` prop (clamped to
/// `0..=1`, default fully opaque) multiplied by every ancestor's, up to
/// the synthetic root. Memoized per layout pass — the memo makes the
/// whole-items pass O(nodes) instead of O(items × depth).
fn effective_opacity(
    tree: &Tree,
    id: &str,
    viewport: Viewport,
    memo: &mut HashMap<String, f32>,
) -> f32 {
    if let Some(v) = memo.get(id) {
        return *v;
    }
    let own = tree
        .get(id)
        .and_then(|n| crate::style::prop_f32_at(n, "opacity", viewport))
        .map(|v| v.clamp(0.0, 1.0))
        .unwrap_or(1.0);
    let inherited = match tree.parent_of(id) {
        Some(parent) if parent != ROOT_ID => {
            let parent = parent.to_string();
            effective_opacity(tree, &parent, viewport, memo)
        }
        _ => 1.0,
    };
    let eff = own * inherited;
    memo.insert(id.to_string(), eff);
    eff
}

/// The transform prop vocabulary the desktop resolves at paint/hit
/// time: the four whitelisted animatable transform props. Matches what
/// the canvas painter reads per node (its `scaleX`/`scaleY`/`skew*`
/// extras are outside the animation whitelist and stay desktop-ignored,
/// a recorded narrowing).
fn tree_has_transform_props(tree: &Tree) -> bool {
    tree.nodes().any(|n| {
        n.props.keys().any(|k| {
            k.starts_with("translateX")
                || k.starts_with("translateY")
                || k.starts_with("scale")
                || k.starts_with("rotate")
        })
    })
}

/// Read a transform prop as f32. `prop_f32_at` handles numbers and
/// px-suffixed strings (breakpoint-variant-aware); the fallback strips
/// a `deg` suffix so `rotate: "45deg"` — the DOM-facing string form —
/// resolves too.
fn transform_f32(node: &crate::tree::Node, name: &str, viewport: Viewport) -> Option<f32> {
    if let Some(v) = prop_f32_at(node, name, viewport) {
        return Some(v);
    }
    let s = crate::style::prop_str_at(node, name, viewport)?;
    let trimmed = s.trim();
    let stripped = trimmed.strip_suffix("deg").unwrap_or(trimmed);
    stripped.trim().parse::<f32>().ok().filter(|v| v.is_finite())
}

/// One node's LOCAL transform about the center of its layout box.
/// `translateX`/`translateY` are logical px (multiplied by the HiDPI
/// `scale` into the physical space rects live in); `scale` is a factor;
/// `rotate` is degrees. Composition order and origin: see [`Affine2`].
fn node_local_transform(
    node: &crate::tree::Node,
    rect: Rect,
    viewport: Viewport,
    scale: f32,
) -> Affine2 {
    let tx = transform_f32(node, "translateX", viewport).unwrap_or(0.0) * scale;
    let ty = transform_f32(node, "translateY", viewport).unwrap_or(0.0) * scale;
    let s = transform_f32(node, "scale", viewport).unwrap_or(1.0);
    let rot = transform_f32(node, "rotate", viewport).unwrap_or(0.0);
    if tx == 0.0 && ty == 0.0 && s == 1.0 && rot == 0.0 {
        return Affine2::IDENTITY;
    }
    let cx = rect.x + rect.w * 0.5;
    let cy = rect.y + rect.h * 0.5;
    Affine2::translate(tx, ty)
        .mul(&Affine2::translate(cx, cy))
        .mul(&Affine2::scale(s))
        .mul(&Affine2::rotate_deg(rot))
        .mul(&Affine2::translate(-cx, -cy))
}

/// Cumulative transform for `id`: every ancestor's local transform (in
/// root→leaf order) composed with the node's own — nested transforms
/// compose down the tree, CSS-style. Memoized per pass so the whole
/// items walk is O(nodes). Nodes without an emitted item (the synthetic
/// root; never a live ancestor of an emitted item, since culling skips
/// whole subtrees) contribute identity.
fn cumulative_transform(
    tree: &Tree,
    id: &str,
    viewport: Viewport,
    scale: f32,
    rects: &HashMap<String, Rect>,
    memo: &mut HashMap<String, Affine2>,
) -> Affine2 {
    if let Some(m) = memo.get(id) {
        return *m;
    }
    let parent_m = match tree.parent_of(id) {
        Some(parent) if parent != ROOT_ID => {
            let parent = parent.to_string();
            cumulative_transform(tree, &parent, viewport, scale, rects, memo)
        }
        _ => Affine2::IDENTITY,
    };
    let local = match (tree.get(id), rects.get(id)) {
        (Some(node), Some(rect)) => node_local_transform(node, *rect, viewport, scale),
        _ => Affine2::IDENTITY,
    };
    let m = parent_m.mul(&local);
    memo.insert(id.to_string(), m);
    m
}

/// Transform post-pass over the emitted items (see the call site in
/// `compute_inner_state` and [`LayoutPass::refresh_transforms`]).
/// Gated on any node carrying a transform prop; when the gate is
/// closed every item is reset to identity (the refresh path can run
/// after a settle removed the last transform prop).
pub(crate) fn compute_item_transforms(
    tree: &Tree,
    items: &mut [LayoutItem],
    viewport: Viewport,
    scale: f32,
) {
    if !tree_has_transform_props(tree) {
        for it in items.iter_mut() {
            it.transform = Affine2::IDENTITY;
        }
        return;
    }
    // Rect side-map for origin resolution — ancestors of an emitted
    // item are always emitted themselves (culling skips whole
    // subtrees), so every origin an item needs is present.
    let rects: HashMap<String, Rect> = items
        .iter()
        .map(|it| (it.node_id.clone(), it.rect))
        .collect();
    let mut memo: HashMap<String, Affine2> = HashMap::new();
    for it in items.iter_mut() {
        it.transform = cumulative_transform(tree, &it.node_id, viewport, scale, &rects, &mut memo);
    }
}

/// Scrollable container detection. Marks the container as scrollable
/// if any of:
/// - `.scrollable(true)` / `.scrollable("vertical" | "horizontal" |
///   "both" | "scroll" | "auto")` — the Hypen-DSL applicator the
///   social example actually uses.
/// - `overflow` / `overflowY` prop resolves to `"scroll"` / `"auto"`
///   (CSS-style fallback used by tw classes).
fn is_scrollable_node(node: &crate::tree::Node, viewport: Viewport) -> bool {
    if let Some(s) = crate::style::prop_str_at(node, "scrollable", viewport) {
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
    let v = crate::style::prop_str_at(node, "overflowY", viewport)
        .or_else(|| crate::style::prop_str_at(node, "overflow", viewport))
        .or_else(|| crate::style::prop_str_at(node, "overflowX", viewport));
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
    Some(
        stripped
            .strip_prefix("actions.")
            .unwrap_or(stripped)
            .to_string(),
    )
}

/// Collect the named arguments of `onClick(...)` (or `action(...)`)
/// into a payload object. `.onClick(@router.push, to: "/x", id: 42)`
/// → `{"to": "/x", "id": 42}`; the positional action ref at `.0` is
/// excluded. Returns `None` when no payload args were attached. The
/// payload is forwarded verbatim to `module.dispatch_action`, which
/// the SDK plumbs to the action handler (`router.push` reads
/// `payload.to`, user handlers read whatever they like).
pub(crate) fn resolve_action_payload(node: &crate::tree::Node) -> Option<serde_json::Value> {
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

/// Pull an `@actions.X` reference off `props.onHover`. Thin wrapper
/// over [`resolve_named_event_action`] for the hover case. Applies to
/// ANY element type — the goal of `.onHover(...)` is to let a plain
/// Container / Row light up state when the pointer is over it, which
/// the actionable-type gate would block.
pub(crate) fn resolve_hover_action(node: &crate::tree::Node) -> Option<String> {
    resolve_named_event_action(node, "onHover").map(|(action, _)| action)
}

/// Collect the static named arguments from an `.onHover(@actions.X, …)`
/// applicator. The window appends `hovered: bool` at dispatch time,
/// so this helper deliberately strips an author-supplied `hovered`
/// key — otherwise a stale `hovered: true` from the DSL would leak
/// into a leave-side event and clobber the runtime value.
pub(crate) fn resolve_hover_payload(node: &crate::tree::Node) -> Option<serde_json::Value> {
    let (_, mut payload) = resolve_named_event_action(node, "onHover")?;
    if let serde_json::Value::Object(ref mut obj) = payload {
        obj.remove("hovered");
        if obj.is_empty() {
            return None;
        }
    }
    Some(payload)
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
pub(crate) fn resolve_font_weight(node: &crate::tree::Node, viewport: Viewport) -> u16 {
    if let Some(v) = prop_f32_at(node, "fontWeight", viewport) {
        return (v as u16).clamp(100, 900);
    }
    if let Some(s) = crate::style::prop_str_at(node, "fontWeight", viewport) {
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
