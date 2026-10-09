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
//! - `SafeArea` → column, full-size, padded by the embedder's
//!   [`SafeAreaInsets`] on the edges its `edges` prop selects.
//!
//! Style props understood (`style.rs` has the full list):
//!
//! - `padding(.0|.top|.right|.bottom|.left|.horizontal|.vertical)` —
//!   container box-model padding.
//! - `gap.0` — flex gap on both axes.
//! - `fontSize.0` — overrides default text size for `Text` leaves.
//! - `color.0`, `backgroundColor.0` — read by the painter, not layout.

use crate::style::{
    border_at, border_with, margin_with, node_layout_active_states, padding_at, padding_with,
    prop_color_at, prop_dim_with, prop_f32_at, prop_f32_with, prop_fill_fraction_with,
    prop_str_with, Border, Dim, Rgba, VariantState, Viewport,
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

/// Cull buffer for `emit_items`, in viewport-heights of slack on EACH
/// side of the visible region. Every emitted item feeds paint,
/// hit-testing, a11y and the per-item resolution work, so this is a
/// direct multiplier on the frames that DO walk the items: the
/// emitted window spans `1 + 2 × CULL_BUFFER_VH` viewports of
/// content.
///
/// History: 2.0 originally, halved to 1.0 when full relayouts ran on
/// every state-update frame (a 22–28% cut on heavy relayout frames),
/// then restored to 2.0 once the paint-only / container-scroll /
/// animation fast paths stopped re-walking the items on those frames
/// entirely. At that point the halving's win had shrunk to the rare
/// re-emit and the O(items) post-passes, while the larger buffer
/// halves the re-emit RATE during sustained scrolling and quadruples
/// the drift margin (`buffer − threshold`) that the combined
/// multi-source drift bound leans on.
///
/// Must stay at least as large as [`SCROLL_REEMIT_THRESHOLD_VH`].
/// The pairing is NOT about flings outrunning the window: when page
/// scroll drifts past the threshold, `App::redraw` re-emits in that
/// SAME frame (the `scroll_outside_buffer` branch feeds `cache_miss`
/// before anything paints), so no frame can ever paint un-emitted
/// space regardless of wheel delta. The invariant is only that
/// fast-path frames — where drift stays ≤ threshold — keep the whole
/// visible band inside the emitted window, which needs
/// `buffer ≥ threshold`.
pub(crate) const CULL_BUFFER_VH: f32 = 2.0;

/// Page-scroll re-emit threshold for `App::redraw`'s layout cache, in
/// viewport-heights: once `|scroll_y − last_scroll_y_emitted|` exceeds
/// `viewport.h × this`, the next frame recomputes (same frame it's
/// detected — see [`CULL_BUFFER_VH`]) instead of shifting cached
/// items. Higher = fewer full re-emits during sustained scrolling;
/// the only ceiling is the invariant below.
pub(crate) const SCROLL_REEMIT_THRESHOLD_VH: f32 = 0.5;

// Fast-path frames (drift ≤ threshold) must keep the visible band
// inside the emitted window: `buffer ≥ threshold`. The threshold is
// measured against an item's TOTAL displacement since its rects were
// emitted — page drift PLUS the summed drift of every scrollable in
// its ancestor chain (`window::chain_emit_drift`), so the bound holds
// at any scroll-nesting depth; per-source checks alone would reach
// `(depth+1) × threshold`. Both constants' only consumers are
// `emit_items` below and `App::redraw` — keep it that way, or the
// assert stops guarding anything.
const _: () = assert!(CULL_BUFFER_VH >= SCROLL_REEMIT_THRESHOLD_VH);

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
/// DOM Text inherits the browser's 16px root size when `.fontSize(...)` is
/// absent. Keep Desktop's implicit typography on the same contract.
const DEFAULT_FONT_SIZE_PX: f32 = 16.0;
const DEFAULT_INPUT_MIN_W_PX: f32 = 200.0;

/// Element types whose `action` prop is dispatched on click.
pub const ACTIONABLE_TYPES: &[&str] = &["Button", "Link", "Card"];

/// Element types that accept keyboard text input. Both emit
/// [`ItemKind::Input`]; `Textarea` sets `multiline` (soft wrap, hard
/// newlines, inner scroll) — see [`is_multiline_text_input`].
pub const TEXT_INPUT_TYPES: &[&str] = &["Input", "Textarea"];

/// True for the multi-line text input (`Textarea`).
pub fn is_multiline_text_input(element_type: &str) -> bool {
    element_type.eq_ignore_ascii_case("Textarea")
}

/// Browser default `<textarea rows>`: two visible lines.
const DEFAULT_TEXTAREA_ROWS: f32 = 2.0;
/// CSS `line-height: normal` for the system sans fonts — what a
/// `<textarea>` without an explicit line height uses.
const TEXTAREA_NORMAL_LINE_HEIGHT: f32 = 1.2;

/// Line height (logical px) of a Textarea's lines: an explicit
/// `lineHeight` (tw `text-sm` carries `1.25rem`) wins through the same
/// multiplier-or-length rule Text uses; otherwise CSS `normal`.
fn textarea_line_height(raw: Option<f32>, font_size: f32) -> f32 {
    match raw {
        Some(value) if value <= 4.0 => (font_size * value).max(font_size),
        Some(value) => value.max(font_size),
        None => font_size * TEXTAREA_NORMAL_LINE_HEIGHT,
    }
}

/// Base Taffy style shared by `Input` and `Textarea` (both leaf nodes,
/// DOM-reset box: no implicit frame or padding; explicit padding /
/// border / margin use the ordinary box model).
///
/// A `Textarea` sizes like a browser `<textarea>`: its intrinsic height
/// is `rows` lines (default 2) of its line height plus padding and
/// border, it does NOT grow with content (overflow scrolls inside, see
/// [`crate::textarea`]), `min-h-*` raises it, and an explicit
/// `height` / `size` / `fillMax*` replaces it.
fn text_input_style(node: &crate::tree::Node, vs: &VariantState, scale: f32) -> Style {
    let pad = padding_with(node, vs);
    let border = border_with(node, vs);
    let mut style = Style {
        display: Display::Flex,
        min_size: Size {
            width: length(DEFAULT_INPUT_MIN_W_PX * scale),
            height: length((DEFAULT_FONT_SIZE_PX * 1.3 + pad.top + pad.bottom) * scale),
        },
        padding: Rect_ {
            left: length(pad.left * scale),
            right: length(pad.right * scale),
            top: length(pad.top * scale),
            bottom: length(pad.bottom * scale),
        },
        margin: margin_to_taffy(margin_with(node, vs), scale),
        border: border_to_taffy(border, scale),
        ..Default::default()
    };
    let declares = |keys: &[&str]| {
        keys.iter()
            .any(|k| prop_dim_with(node, k, vs).is_some() || prop_f32_with(node, k, vs).is_some())
    };
    if declares(&["width", "size", "fillMaxWidth", "fillMaxSize"]) {
        // An explicit width wins over the renderer's default minimum
        // (`w-[120px]` must not render 200px wide), as in the DOM.
        style.min_size.width = Dimension::auto();
    }
    if is_multiline_text_input(&node.element_type) {
        let font_size = prop_f32_with(node, "fontSize", vs).unwrap_or(DEFAULT_FONT_SIZE_PX);
        let line_height = textarea_line_height(prop_f32_with(node, "lineHeight", vs), font_size);
        let rows = prop_f32_with(node, "rows", vs)
            .filter(|r| r.is_finite() && *r >= 1.0)
            .map(f32::floor)
            .unwrap_or(DEFAULT_TEXTAREA_ROWS);
        let intrinsic = (rows * line_height + pad.top + pad.bottom) * scale
            + border_side_px(border, crate::style::BORDER_SIDE_TOP, scale)
            + border_side_px(border, crate::style::BORDER_SIDE_BOTTOM, scale);
        if declares(&["height", "size", "fillMaxHeight", "fillMaxSize"]) {
            // Explicit height wins outright (CSS: the automatic minimum
            // of a sized item never exceeds its specified size).
            style.min_size.height = Dimension::auto();
        } else {
            style.size.height = length(intrinsic);
            style.min_size.height = length(intrinsic);
        }
    }
    style
}

/// Element types painted as bitmap surfaces. `Image` carries a `src`
/// URL/path; `Icon` resolves through the engine's resource registry
/// but is shaped the same here (placeholder rectangle when SVG isn't
/// rasterised yet).
pub const IMAGE_TYPES: &[&str] = &["Image", "Icon", "Avatar"];

pub const CONTROL_TYPES: &[&str] = &[
    "Checkbox",
    "Switch",
    "Slider",
    "Progress",
    "ProgressBar",
    "Spinner",
    "Loading",
    "Select",
    "Audio",
];

/// Element types rendered as media surfaces. Desktop has no inline
/// media decode (see `hypen-docs/content/docs/guide/components.mdx`): a `Video`
/// renders its `poster` frame (through the shared image pipeline) with
/// a play-glyph overlay, or a dark placeholder when no poster is
/// available. Kept separate from [`IMAGE_TYPES`] because the semantics
/// differ — sizing defaults to 16:9 (video has no natural aspect until
/// the poster loads), clicks dispatch `onPlay`, and a11y reports a
/// video role instead of an image.
pub const MEDIA_TYPES: &[&str] = &["Video"];

/// Element types rendered as a playback timeline (Video v2's `Scrubber`).
/// Inside a Video the widget wires itself to the enclosing player
/// renderer-side (thumb tracks playback at frame rate, drag previews
/// locally, release commits); outside one it renders inert.
pub const SCRUBBER_TYPES: &[&str] = &["Scrubber"];

/// Default logical height of a `Scrubber` — thumb diameter, so the whole
/// widget is a comfortable pointer target. The track itself is painted
/// much thinner, centred in this box.
pub const DEFAULT_SCRUBBER_HEIGHT_PX: f32 = 16.0;

/// Logical thickness of the Scrubber's track / progress bar.
pub const SCRUBBER_TRACK_PX: f32 = 4.0;

/// Minimum logical width so a Scrubber in a tight Row never collapses to
/// an untargetable sliver.
pub const DEFAULT_SCRUBBER_MIN_W_PX: f32 = 48.0;

/// Default text alignment when `textAlign` isn't set on a `Text`.
pub const DEFAULT_IMAGE_SIZE_PX: f32 = 60.0;

/// Default logical width for a `Video` with no width/height/size
/// constraints at all. Paired with [`DEFAULT_VIDEO_ASPECT`] this gives
/// an unconstrained video a sane 320×180 box instead of collapsing.
pub const DEFAULT_VIDEO_WIDTH_PX: f32 = 320.0;

/// Fallback aspect ratio (w / h) for `Video` when the node declares no
/// `aspectRatio` and the poster's natural size isn't known yet. Images
/// use their natural aspect; a video has none until (unless) a poster
/// loads, so the universal 16:9 default applies.
pub const DEFAULT_VIDEO_ASPECT: f32 = 16.0 / 9.0;

/// Element type of the safe-area container (`SafeArea { ... }`). The
/// engine emits primitive element types verbatim in their DSL spelling
/// — `SafeArea` arrives PascalCase on the wire, exactly like
/// `ProgressBar` — and we match it case-insensitively like every other
/// container type here.
pub const SAFE_AREA_TYPE: &str = "SafeArea";

/// Desktop's base platform safe-area insets: zero on every edge. A
/// desktop window has no notch, home indicator or rounded-corner
/// region, so with standard OS decorations an unconfigured `SafeArea`
/// is exactly a full-size `Column`.
///
/// The one native unsafe region a desktop window CAN have is the
/// window-controls bar (close / minimize / maximize) drawn over the
/// content — which only happens when the embedder opts into the macOS
/// unified titlebar ([`crate::DesktopApp::unified_titlebar`]); on
/// Windows and Linux the native decorations live outside the client
/// area. The window wiring accounts for that via
/// [`window_controls_platform_insets`] and
/// `TaffyState::set_platform_safe_area`, so this constant stays the
/// zero base. Embedders with some other unsafe region (an overlay HUD,
/// a custom client-side titlebar of their own) declare it through
/// [`SafeAreaInsets`].
pub const DESKTOP_SAFE_AREA_DEFAULT: crate::style::Padding = crate::style::Padding {
    top: 0.0,
    right: 0.0,
    bottom: 0.0,
    left: 0.0,
};

/// Height in logical px of the macOS window-controls strip (the
/// close / minimize / maximize "traffic lights") when the unified
/// titlebar merges it into the content: the standard NSWindow titlebar
/// is 28 pt and the buttons sit centered inside it.
pub const WINDOW_CONTROLS_BAR_HEIGHT: f32 = 28.0;

/// The platform safe-area insets for a window's decoration setup:
/// the window-controls bar is unsafe only where it is actually drawn
/// over the content, i.e. under the macOS unified titlebar
/// (`fullSizeContentView`). Everywhere else native decorations sit
/// outside the client area and every edge stays zero.
///
/// Pure so it is testable off-macOS: callers pass
/// `cfg!(target_os = "macos")` for `macos`.
pub fn window_controls_platform_insets(
    unified_titlebar: bool,
    macos: bool,
) -> crate::style::Padding {
    if unified_titlebar && macos {
        crate::style::Padding {
            top: WINDOW_CONTROLS_BAR_HEIGHT,
            ..DESKTOP_SAFE_AREA_DEFAULT
        }
    } else {
        DESKTOP_SAFE_AREA_DEFAULT
    }
}

/// Embedder-supplied safe-area insets, in **logical** px, one optional
/// value per edge.
///
/// `None` on an edge means "use the platform default for that edge" —
/// [`DESKTOP_SAFE_AREA_DEFAULT`], i.e. zero. Overrides therefore merge
/// per-edge over the defaults rather than replacing them wholesale:
/// `SafeAreaInsets::default().with_top(28.0)` pads only the top and
/// leaves the other three edges at the platform value. Desktop's
/// defaults happen to be zero, but the merge shape is deliberately the
/// same one the iOS / Android / web renderers use, where they are not.
///
/// ```rust
/// use hypen_renderer_desktop::SafeAreaInsets;
/// // Reserve room for a 28pt custom titlebar drawn over the content.
/// let insets = SafeAreaInsets::default().with_top(28.0);
/// assert_eq!(insets.resolved().top, 28.0);
/// assert_eq!(insets.resolved().bottom, 0.0);
/// ```
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct SafeAreaInsets {
    pub top: Option<f32>,
    pub right: Option<f32>,
    pub bottom: Option<f32>,
    pub left: Option<f32>,
}

impl SafeAreaInsets {
    /// Override every edge with the same value.
    pub fn all(v: f32) -> Self {
        Self {
            top: Some(v),
            right: Some(v),
            bottom: Some(v),
            left: Some(v),
        }
    }

    pub fn with_top(mut self, v: f32) -> Self {
        self.top = Some(v);
        self
    }

    pub fn with_right(mut self, v: f32) -> Self {
        self.right = Some(v);
        self
    }

    pub fn with_bottom(mut self, v: f32) -> Self {
        self.bottom = Some(v);
        self
    }

    pub fn with_left(mut self, v: f32) -> Self {
        self.left = Some(v);
        self
    }

    /// Merge the per-edge overrides over the zero base defaults. The
    /// result is the *effective* inset for each edge, still in logical
    /// px (the layout multiplies by `scale` on its way into Taffy).
    /// Inside the renderer prefer [`Self::resolved_over`] with the
    /// window's actual platform insets.
    pub fn resolved(self) -> crate::style::Padding {
        self.resolved_over(DESKTOP_SAFE_AREA_DEFAULT)
    }

    /// Merge the per-edge overrides over the given platform defaults —
    /// an edge left `None` falls back to the platform value for that
    /// edge, an edge that is `Some` (including `Some(0.0)`) wins.
    pub fn resolved_over(self, d: crate::style::Padding) -> crate::style::Padding {
        crate::style::Padding {
            top: self.top.unwrap_or(d.top),
            right: self.right.unwrap_or(d.right),
            bottom: self.bottom.unwrap_or(d.bottom),
            left: self.left.unwrap_or(d.left),
        }
    }

    /// The overrides with every unset edge pinned to the platform value
    /// — the fully-determined insets the layout actually applies.
    fn or_defaults(self, d: crate::style::Padding) -> SafeAreaInsets {
        let r = self.resolved_over(d);
        SafeAreaInsets {
            top: Some(r.top),
            right: Some(r.right),
            bottom: Some(r.bottom),
            left: Some(r.left),
        }
    }

    /// Fold into a `TaffyState` structure key so changing the insets at
    /// runtime forces a restyle of the existing tree.
    fn hash_into(self, h: &mut impl std::hash::Hasher) {
        use std::hash::Hash;
        for edge in [self.top, self.right, self.bottom, self.left] {
            edge.map(f32::to_bits).hash(h);
        }
    }
}

/// Resolve the safe-area padding a `SafeArea` node contributes, in
/// logical px: the effective insets (embedder overrides merged over the
/// platform defaults) masked by the node's `edges` prop.
///
/// `edges` is a JSON array of `"top"` / `"right"` / `"bottom"` /
/// `"left"` (`SafeArea(edges: ["top", "bottom"])`), read from the plain
/// key or its `.0` applicator-flattened form like every other list prop.
/// Absent, non-array, or without any usable entry → all four edges; an
/// explicit non-empty list is honored literally (unknown names dropped,
/// never widening back to all four), matching the other renderers.
fn safe_area_padding(node: &crate::tree::Node, insets: SafeAreaInsets) -> crate::style::Padding {
    let effective = insets.resolved();
    let listed = node
        .props
        .get("edges")
        .or_else(|| node.props.get("edges.0"))
        .and_then(|v| v.as_array());
    let Some(listed) = listed else {
        return effective;
    };
    // The all-edges default applies only when the author gave us nothing to
    // go on (absent prop, non-array, or a list with no usable entries). An
    // explicit non-empty list is honored literally: unknown edge names are
    // ignored rather than fatal — the prop crosses the wire from user DSL —
    // so a list that names only unknown edges insets nothing, never silently
    // widening back to all four. Matches the Swift/Android/web renderers.
    let mut out = crate::style::Padding::default();
    let mut candidates = false;
    for name in listed.iter().filter_map(|v| v.as_str()) {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        candidates = true;
        match name.to_ascii_lowercase().as_str() {
            "top" => out.top = effective.top,
            "right" => out.right = effective.right,
            "bottom" => out.bottom = effective.bottom,
            "left" => out.left = effective.left,
            _ => {}
        }
    }
    if candidates {
        out
    } else {
        effective
    }
}

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

    fn intersection(self, other: Self) -> Self {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = (self.x + self.w).min(other.x + other.w);
        let bottom = (self.y + self.h).min(other.y + other.h);
        Self {
            x,
            y,
            w: (right - x).max(0.0),
            h: (bottom - y).max(0.0),
        }
    }
}

/// Collapse two nested clip rectangles into the one effective clip carried by
/// a [`LayoutItem`]. Preserve a rounded outline only when the intersection is
/// wholly owned by one input; a partial overlap cannot be represented by one
/// rounded rectangle without incorrectly rounding a stationary cut edge.
fn intersect_clip_rects(a: Rect, a_radius: f32, b: Rect, b_radius: f32) -> (Rect, f32) {
    let intersection = a.intersection(b);
    let radius = if intersection == a && intersection == b {
        a_radius.max(b_radius)
    } else if intersection == a {
        a_radius
    } else if intersection == b {
        b_radius
    } else {
        0.0
    };
    (intersection, radius)
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

    /// Component-wise approximate equality. The painter's fragment-
    /// splice validity check compares an independently RECOMPUTED
    /// cumulative transform against a conjugation of the cached one —
    /// two float paths to the same value — so exact `==` would force
    /// spurious re-encodes on ulp noise. The tolerance is far below a
    /// visible sub-pixel.
    pub fn approx_eq(&self, other: &Affine2, eps: f32) -> bool {
        self.0
            .iter()
            .zip(other.0.iter())
            .all(|(a, b)| (a - b).abs() <= eps)
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
        line_height: f32,
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
        /// CSS `text-decoration: line-through` / Tailwind `line-through`.
        line_through: bool,
    },
    Button,
    /// Card keeps Button's action/accessibility behaviour while allowing the
    /// painter to apply the component's built-in surface shadow.
    Card,
    Container,
    /// Single-line text input. The renderer keeps the live editor state
    /// (cursor, selection) in `App`, keyed by `node_id` — this struct
    /// just carries the resolved value, the placeholder, and the
    /// dotted state-binding path for `__hypen_bind` dispatches.
    ///
    /// `Textarea` emits this same kind with `multiline: true`: the value
    /// soft-wraps to the content width, Enter inserts `\n`, and content
    /// taller than the box scrolls inside it (offset kept in `App`).
    Input {
        value: String,
        placeholder: Option<String>,
        bind_path: Option<String>,
        font_size: f32,
        /// Logical line height. Equals `font_size` for a single-line
        /// Input; a Textarea's explicit `lineHeight` or CSS `normal`.
        line_height: f32,
        /// `true` for `Textarea`.
        multiline: bool,
        color: Rgba,
        /// `(left, top, right, bottom)` content padding in physical pixels.
        /// Inputs have no renderer default padding; explicit `.padding(...)`
        /// is resolved through the same box model as Text and containers.
        padding: (f32, f32, f32, f32),
    },
    Checkbox {
        checked: bool,
    },
    Switch {
        checked: bool,
    },
    Slider {
        fraction: f32,
        disabled: bool,
    },
    ProgressBar {
        fraction: f32,
    },
    Spinner {
        color: Rgba,
    },
    Select {
        value: String,
        placeholder: String,
    },
    /// Compact built-in audio chrome. Playback plumbing is separate from the
    /// visual contract so Audio remains visible in headless screenshots.
    Audio {
        controls: bool,
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
    /// `Video` media surface. Desktop has no inline decode stack, so
    /// the painter renders the `poster` bitmap (objectFit cover,
    /// loaded through the shared image pipeline) — or a dark
    /// placeholder when there's no poster / the poster failed — and
    /// overlays a centered play glyph. `src` is the resolved stream
    /// URL of the current track (playlist-aware); carried for event
    /// payloads and the a11y label, never fetched as media.
    Video {
        poster: Option<String>,
        src: Option<String>,
        /// Video v2 player state, derived once per emit from the media
        /// registry (or the poster/probe failure registry without the
        /// `video` feature). Drives slot visibility and what the painter
        /// draws underneath the slots.
        state: crate::video_v2::VideoPlayerState,
        /// Which composition slots this node declares. A present slot
        /// replaces the built-in for its concern — see
        /// [`crate::video_v2::SlotPresence`].
        slots: crate::video_v2::SlotPresence,
    },
    /// Video v2 `Scrubber`: a playback timeline. Painted as
    /// track + progress + thumb from the ENCLOSING player's live
    /// position/duration (read at paint time, so the frame-driven
    /// repaints already happening during playback advance the thumb
    /// without a layout pass). `video_id` is `None` outside a Video —
    /// the widget then renders inert and commits nothing.
    Scrubber {
        video_id: Option<String>,
        /// In-flight drag preview (`0..=1`). While `Some`, the thumb
        /// follows the pointer and the live position is ignored; the
        /// release commits.
        preview: Option<f32>,
    },
    /// A `Chart` host: the resolved plot rectangle, scales and device-pixel
    /// draw list for its marks, built once per layout pass by
    /// [`crate::chart::build_scene`]. Mark children are laid out BY the
    /// chart rather than by Taffy, so they emit no items of their own —
    /// with the single exception of [`ItemKind::ChartMark`] (interaction)
    /// and `Marker`, whose ordinary Hypen children are real layout items
    /// shifted onto their data point.
    Chart(std::sync::Arc<crate::chart::ChartScene>),
    /// One interactive mark inside a `Chart`. Paints nothing — the chart's
    /// own item drew the geometry — and exists purely so the mark can be
    /// hit-tested, focused and dispatched like any other actionable. A mark
    /// with no event applicator emits NO item at all, which is what makes
    /// decorative marks pointer-transparent.
    ChartMark(std::sync::Arc<crate::chart::ResolvedMark>),
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
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScrollMeta {
    /// Total height of this scrollable's contents in physical pixels,
    /// measured from the inner top. Used to compute the maximum
    /// scroll offset (`max(0, content_h - rect.h)`).
    pub content_h: f32,
    /// The scroll offset this container's descendant RECTS currently
    /// reflect. Starts at the offset the layout was emitted with and
    /// advances with every in-place container-scroll shift
    /// (`LayoutPass::shift_container_scroll`). The live offset in
    /// `App::scrollables` can run ahead of it between a wheel /
    /// reveal write and the next redraw — consumers comparing item
    /// rects against the live offset (focus reveal, the shift fast
    /// path itself) must correct for `live - baked` drift, exactly
    /// like the page-scroll drift correction against
    /// `last_scroll_y_in_layout`.
    pub baked_offset: f32,
    /// The offset the cull window was last EMITTED against — the
    /// container-scroll analogue of `last_scroll_y_emitted`. Set at
    /// emit time, NOT advanced by in-place shifts, so
    /// `|live - emitted_offset|` measures how far content has moved
    /// since items were last walked; past
    /// [`SCROLL_REEMIT_THRESHOLD_VH`] the window forces a fresh
    /// emit (same buffer ≥ threshold pairing as page scroll: the
    /// recompute lands in the same frame, so shifted-in content is
    /// always emitted, never blank).
    pub emitted_offset: f32,
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

#[derive(Debug, Clone, Copy)]
pub struct BoxShadow {
    pub x: f32,
    pub y: f32,
    pub blur: f32,
    pub spread: f32,
    pub color: Rgba,
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
    /// Renderer-local video intent from `.videoIntent("fullscreen")`,
    /// resolved only for nodes that sit INSIDE a Video subtree (outside
    /// one the intent is inert, exactly like a `Scrubber`). An item with
    /// an intent is actionable and focusable even with no `.onClick` —
    /// the renderer performs the intent itself instead of dispatching.
    pub video_intent: Option<crate::video_v2::VideoIntent>,
    /// Optional fill. Painted under everything else for the same item.
    /// Optional fill from `backgroundColor` / tw `bg-*`. Buttons no
    /// longer get implicit chrome — set `.backgroundColor(...)` or
    /// `.tw("bg-...")` explicitly. Containers and text default to `None`.
    pub background: Option<Rgba>,
    /// Resolved `hover:` overrides, applied while the item is hovered.
    pub hover: HoverStyle,
    /// Authored `.shadow({x, y, blur, spread, color})` paint effect.
    pub shadow: Option<BoxShadow>,
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
    /// Corner radius of the clipping ancestor represented by `clip_to`, in
    /// physical pixels. A rounded `overflow-hidden` surface (notably Video)
    /// must clip descendants with the same outline as its own background;
    /// keeping only the rectangle lets full-bleed overlays repaint the four
    /// corner pixels square.
    pub clip_radius: f32,
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
    /// Layered CSS `background` stack (solid colour + interleaved
    /// image/gradient layers, radial gradients included) for values the
    /// two single-layer fields above can't express — the home-screen
    /// icon tiles' `radial-gradient(...), linear-gradient(...)` being
    /// the canonical case. When `Some`, the painter uses this stack and
    /// ignores `background_gradient` / `background_image`; `None` for
    /// the common case keeps the existing fast paths untouched.
    pub background_layers: Option<crate::style::ParsedBackground>,
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
    /// Content hash of `a11y` (in item order), precomputed by
    /// `collect_item_semantics` so the per-frame accessibility
    /// fingerprint folds in one u64 instead of re-formatting every
    /// item's semantics on every scroll frame.
    pub(crate) a11y_hash: u64,
    /// Indexes of items whose `hover_action` is `Some(_)`. Hover
    /// hit-testing (`hit_hoverable`) iterates this list in reverse —
    /// just like `actionable_ids` — to find the topmost subject under
    /// the cursor. Kept separate from `actionable_ids` because hover
    /// applicators are allowed on ANY element type, not just buttons.
    pub(crate) hoverable_ids: Vec<usize>,
}

/// Per-Taffy-node sidecar so the measure callback can look up text
/// content and font size without a back-channel into the renderer tree.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct NodeContext {
    text: Option<String>,
    font_size: f32,
    line_height: f32,
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
    /// Taffy nodes whose `size.width` was replaced by a computed
    /// fit-content length in the content-sizing pre-pass, mapped to the
    /// value that was written. See [`apply_fit_content_widths`].
    fit_widths: HashMap<NodeId, f32>,
    /// Temporary minimum heights written after flex sizing shrinks a Text
    /// below its max-content width. Each entry keeps the authored minimum
    /// so the override can be removed before the next layout pass.
    text_height_overrides: HashMap<NodeId, (Dimension, f32)>,
    /// Memo for [`apply_wrapped_text_heights`]: `node -> (content_width,
    /// required_height)` from the last pass that measured it.
    ///
    /// That pass is handed every node in the tree and re-shapes each
    /// wrappable Text through cosmic-text to ask "how tall are you at
    /// this width" — a question whose answer only moves when the width
    /// moves or the node's measure context does. On a window-HEIGHT
    /// drag neither happens, yet it was the single largest stage of the
    /// frame.
    ///
    /// Dropped by [`TaffyState::write_context`] (the measure inputs
    /// moved), by [`TaffyState::apply_patches`] (a batch can rewrite text
    /// content, which is a measure input even though it is not a
    /// "layout-affecting" prop key), by [`TaffyState::remove_node`], and
    /// — the one that is easy to miss — by the bulk-rebuild branch of
    /// `compute_inner_state`, which installs a fresh `TaffyTree` that
    /// re-issues the same `NodeId` sequence from scratch. Within one tree
    /// Taffy's slotmap versions a freed id and never reissues it, so ids
    /// genuinely collide only across a rebuild — and that branch runs
    /// with no `mark_needs_rebuild` at all, every time an image finishes
    /// loading.
    wrapped_probes: HashMap<NodeId, (f32, f32)>,
    /// Which viewport axes each node's style resolution actually read,
    /// recorded by [`crate::style::viewport_trace`] as a side effect of
    /// resolving it.
    ///
    /// This replaces the hand-written claim in `taffy_structure_key`
    /// about which axes matter. A viewport change now restyles exactly
    /// the nodes that consulted the axis that moved, instead of either
    /// the whole tree (what a width change used to do) or nothing at all
    /// (what a height change used to do, which is how `vh` lengths came
    /// to go stale).
    ///
    /// Nodes reading neither axis are absent, which is the overwhelming
    /// majority — a plain `padding(16)` resolves identically at every
    /// viewport.
    viewport_deps: HashMap<NodeId, u8>,
    /// `true` once every live node has been through
    /// [`TaffyState::resolve_node_style`], so `viewport_deps` can be
    /// trusted as complete.
    ///
    /// Nodes are created in nine places inside `build_subtree` plus the
    /// patch path, and stamping each of them would be one more list to
    /// keep in sync — the failure mode this whole mechanism exists to
    /// remove. So node creation just clears this flag, and the next
    /// viewport change takes the full `restyle_all`, which resolves
    /// everything and re-establishes the invariant. Self-healing: a
    /// missed stamp costs one restyle, never a stale style.
    deps_complete: bool,
    /// Viewport the current styles were resolved against.
    last_style_viewport: Option<(u32, u32)>,
    /// `true` when the fit-content pre-pass needs to re-run (cold start,
    /// restyle, patched content). Scroll-only frames leave it `false` so
    /// they keep the previous frame's widths and run a single layout.
    fit_pass_dirty: bool,
    /// Physical viewport the root wrapper's style was last written for.
    /// [`TaffyState::refresh_root_size`] runs on every compute; when the
    /// viewport hasn't moved, re-writing the identical root style only
    /// cleared the root's layout cache for nothing.
    last_root_viewport: Option<(u32, u32)>,
    /// Embedder-configured safe-area insets, applied as padding by every
    /// `SafeArea` node. Set from the window / app config; defaults to
    /// "no overrides", which falls back per-edge to `platform_safe_area`.
    /// Folded (as the effective values) into the structure key so a
    /// runtime change restyles.
    safe_area: SafeAreaInsets,
    /// The window's own platform safe-area insets — non-zero only for a
    /// decoration setup that draws the window-controls bar over the
    /// content (macOS unified titlebar; see
    /// [`window_controls_platform_insets`]). Embedder overrides merge
    /// per-edge over these.
    platform_safe_area: crate::style::Padding,
    image_load_generation: u64,
    /// Scroll panes whose Taffy style [`TaffyState::reconcile_content_sized_scroll_panes`]
    /// rewrote (content-resolving flex basis + `Clip` instead of
    /// `Scroll`), keyed to the overflow the style was built with so the
    /// pass can restore it when the pane stops qualifying.
    scroll_pane_overrides: HashMap<NodeId, taffy::Point<Overflow>>,
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
            fit_widths: HashMap::new(),
            text_height_overrides: HashMap::new(),
            wrapped_probes: HashMap::new(),
            viewport_deps: HashMap::new(),
            deps_complete: false,
            last_style_viewport: None,
            fit_pass_dirty: true,
            last_root_viewport: None,
            safe_area: SafeAreaInsets::default(),
            platform_safe_area: DESKTOP_SAFE_AREA_DEFAULT,
            image_load_generation: crate::paint::image::image_load_generation(),
            scroll_pane_overrides: HashMap::new(),
        }
    }

    /// Configure the safe-area insets every `SafeArea` node pads itself
    /// by. Per-edge `None` keeps the platform default for that edge
    /// (zero on desktop), so partial overrides merge. Changing the
    /// value marks the styles stale — the next compute sees a different
    /// structure key and restyles.
    pub fn set_safe_area_insets(&mut self, insets: SafeAreaInsets) {
        self.safe_area = insets;
    }

    /// The configured safe-area insets.
    pub fn safe_area_insets(&self) -> SafeAreaInsets {
        self.safe_area
    }

    /// Configure the window's platform safe-area insets — the values an
    /// edge falls back to when the embedder override leaves it `None`.
    /// Zero everywhere by default; the window wiring sets the
    /// window-controls bar here when the macOS unified titlebar draws
    /// it over the content. Like [`Self::set_safe_area_insets`], a
    /// change surfaces through the structure key and restyles on the
    /// next compute.
    pub fn set_platform_safe_area(&mut self, platform: crate::style::Padding) {
        self.platform_safe_area = platform;
    }

    /// The window's platform safe-area insets.
    pub fn platform_safe_area(&self) -> crate::style::Padding {
        self.platform_safe_area
    }

    /// The fully-determined insets the layout applies: embedder
    /// overrides merged per-edge over the platform values.
    fn effective_safe_area(&self) -> SafeAreaInsets {
        self.safe_area.or_defaults(self.platform_safe_area)
    }

    /// Force a full rebuild on the next compute. Called when an
    /// unhandled patch path falls through `apply_patches`, or when
    /// the renderer Tree gets out of sync with the Taffy mirror for
    /// any other reason.
    /// Number of live entries in the wrapped-height memo. Tests use it
    /// to assert the invalidation contract directly — the memo's effect
    /// is otherwise invisible in the output, which is exactly the
    /// property that makes a stale one dangerous.
    #[cfg(test)]
    pub(crate) fn wrapped_probe_len(&self) -> usize {
        self.wrapped_probes.len()
    }

    /// Number of content-sized flex nodes whose authored auto width is
    /// temporarily overridden by the fit-content pre-pass.
    #[cfg(test)]
    pub(crate) fn fit_width_override_len(&self) -> usize {
        self.fit_widths.len()
    }

    /// The memoised `(content_width, measured_height)` pairs, ordered so
    /// two passes can be compared. Lets a test assert that entries were
    /// genuinely re-measured rather than reused, which is the part of
    /// the contract that emptiness checks cannot see: the same pass that
    /// invalidates the memo also refills it.
    #[cfg(test)]
    pub(crate) fn wrapped_probe_snapshot(&self) -> Vec<(u64, u32, u32)> {
        // Keyed by `NodeId`, not values-only: a values-only snapshot
        // cannot see two nodes swapping entries, which is exactly how a
        // memo that outlived a tree rebuild fails.
        // `taffy::NodeId` is not `Ord`; it round-trips through `u64`.
        let mut out: Vec<(u64, u32, u32)> = self
            .wrapped_probes
            .iter()
            .map(|(id, (w, h))| (u64::from(*id), w.to_bits(), h.to_bits()))
            .collect();
        out.sort_unstable();
        out
    }

    /// Resolve one node's Taffy `Style` (and, for a Text, its measure
    /// context) while recording which viewport axes the resolution read.
    ///
    /// Every site that rebuilds a node's style goes through here, so the
    /// dependency record cannot drift from the resolution the way a
    /// hand-maintained predicate does.
    fn resolve_node_style(
        &mut self,
        tree: &Tree,
        tid: NodeId,
        rid: &str,
        node: &crate::tree::Node,
        scale: f32,
        viewport: Viewport,
    ) {
        crate::style::viewport_trace::begin();
        let active_states = self.interaction.active_states_for(rid, node);
        let style = node_style_with(
            node,
            scale,
            viewport,
            &active_states,
            self.effective_safe_area(),
        );
        let is_text = node.element_type == "Text";
        let ctx = is_text.then(|| node_context_in_tree(tree, rid, node, scale, viewport));
        // Taken AFTER the context too: `node_context_in_tree` resolves
        // font size / line height, which can themselves be `vh`.
        let axes = crate::style::viewport_trace::take();
        if axes == 0 {
            self.viewport_deps.remove(&tid);
        } else {
            self.viewport_deps.insert(tid, axes);
        }
        // Only write a style that actually differs. `set_style` marks the
        // node and every ancestor dirty, so writing an identical style
        // still costs Taffy the re-solve of that chain.
        if self.tree.style(tid) != Ok(&style) {
            let _ = self.tree.set_style(tid, style);
        }
        if let Some(ctx) = ctx {
            self.write_context(tid, ctx);
        }
    }

    /// How many live nodes' styles read the viewport at all. Test hook:
    /// the point of the tracer is that this is ZERO for the common tree.
    #[cfg(test)]
    pub(crate) fn viewport_dependent_node_count(&self) -> usize {
        self.viewport_deps.len()
    }

    /// Restyle only the nodes whose style read one of `axes`.
    ///
    /// The cheap half of a resize: a `vh` length or a breakpoint variant
    /// is rare, so this touches a handful of nodes where `restyle_all`
    /// touched every one of them.
    pub fn restyle_viewport_dependents(
        &mut self,
        tree: &Tree,
        scale: f32,
        viewport_px: (u32, u32),
        axes: u8,
    ) -> usize {
        let viewport = logical_viewport(viewport_px, scale);
        let targets: Vec<(NodeId, String)> = self
            .viewport_deps
            .iter()
            .filter(|(_, dep)| *dep & axes != 0)
            .filter_map(|(tid, _)| self.renderer_for_taffy.get(tid).map(|r| (*tid, r.clone())))
            .collect();
        if targets.is_empty() {
            return 0;
        }
        // A resolved width can move, so the fit-content and cross-axis
        // passes have to re-derive — same re-arm `restyle_all` does.
        self.fit_widths.clear();
        self.fit_pass_dirty = true;
        for (tid, rid) in &targets {
            if let Some(node) = tree.get(rid) {
                self.resolve_node_style(tree, *tid, rid, node, scale, viewport);
            }
        }
        targets.len()
    }

    /// Write a node's measure context, skipping the write — and the
    /// memo invalidation that comes with it — when the value is
    /// unchanged.
    ///
    /// `set_node_context` dirties the node, so writing an identical
    /// context still costs Taffy a re-measure; and it invalidates
    /// `wrapped_probes` wholesale, so a spurious write costs a full
    /// re-shape of every wrappable Text in the tree on the next pass.
    /// `restyle_all` rebuilds every context from scratch on any width
    /// change, and the overwhelming majority come back byte-identical.
    fn write_context(&mut self, tid: NodeId, ctx: NodeContext) {
        if self.tree.get_node_context(tid) == Some(&ctx) {
            return;
        }
        self.wrapped_probes.clear();
        let _ = self.tree.set_node_context(tid, Some(ctx));
    }

    pub fn mark_needs_rebuild(&mut self) {
        self.needs_bulk_rebuild = true;
        self.fit_pass_dirty = true;
        // The rebuild allocates fresh nodes that nothing has traced.
        self.deps_complete = false;
        // Every Taffy node is about to be discarded and reallocated, so
        // no `NodeId` keeps its meaning.
        self.wrapped_probes.clear();
    }

    /// Forget every retained record keyed by one Taffy node before that
    /// node is removed from the SlotMap.
    ///
    /// Keeping this in one place is a correctness boundary: `NodeId` embeds
    /// a SlotMap generation, so even a map consulted only on the next frame
    /// will panic if it retains a removed key. Route exits exposed the two
    /// easy-to-miss records here (`fit_widths` and
    /// `text_height_overrides`), while the other maps happened to already be
    /// cleared independently at each removal site.
    fn forget_node_records(&mut self, tid: NodeId) {
        self.renderer_for_taffy.remove(&tid);
        self.fit_widths.remove(&tid);
        self.text_height_overrides.remove(&tid);
        self.wrapped_probes.remove(&tid);
        self.viewport_deps.remove(&tid);
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
            // This id is dead; drop every per-node record rather than leave
            // a stale SlotMap key for the next layout.
            self.forget_node_records(tid);
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
        // The fit-content pre-pass re-runs only when the batch could
        // actually change content sizing: structural patches, layout-
        // affecting props, or text content. A paint-only batch (colour
        // flips, opacity, transforms — the keystroke-adjacent frames)
        // used to set this unconditionally, which made EVERY update
        // frame pay `collect_fit_candidates`' full-tree walk — the
        // dominant per-total-node frame tax on large trees.
        if patches.iter().any(patch_affects_layout) {
            self.fit_pass_dirty = true;
        }
        // Any batch at all invalidates the wrapped-height memo: a batch
        // can rewrite text content (which is not a "layout-affecting"
        // prop key, but is certainly a measure input) and it can remove
        // nodes — though that alone would not require this, since Taffy
        // versions a freed id and never reissues it within the same tree;
        // real id collisions come from the rebuild branch, which clears
        // the memo itself. Cheap to be blunt here — batches do not arrive
        // during a resize drag, the case the memo exists for.
        if !patches.is_empty() {
            self.wrapped_probes.clear();
        }
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
                    if let Some(old) = self.node_map.remove(id.as_ref()) {
                        if let Some(parent) = self.tree.parent(old) {
                            // O(n) single-pass unlink that also marks the
                            // parent dirty — no children-Vec clone +
                            // set_children round trip.
                            let _ = self.tree.remove_child(parent, old);
                        }
                        let _ = self.tree.remove(old);
                        self.forget_node_records(old);
                    }
                    let active_states = self.interaction.active_states_for(id, node);
                    let style = node_style_with(
                        node,
                        scale,
                        viewport,
                        &active_states,
                        self.effective_safe_area(),
                    );
                    let ctx = node_context_in_tree(tree, id.as_ref(), node, scale, viewport);
                    // A node nothing has traced yet.
                    self.deps_complete = false;
                    let taffy_id = self.tree.new_leaf_with_context(style, ctx).ok();
                    if let Some(tid) = taffy_id {
                        self.node_map.insert(id.to_string(), tid);
                        self.renderer_for_taffy.insert(tid, id.to_string());
                        return true;
                    }
                    return false;
                }
                true
            }
            Patch::SetProp { id, name, .. } | Patch::RemoveProp { id, name } => {
                let Some(&tid) = self.node_map.get(id.as_ref()) else {
                    return true;
                };
                // Appearance-only props (color / backgroundColor /
                // src / icon paths / etc.) don't change Taffy
                // geometry. Skip `set_style` so Taffy's per-node
                // dirty bit stays clean — the next `compute_layout`
                // becomes a no-op walk, and the painter picks up the
                // new prop value on the next `emit_items` pass that
                // re-reads from the renderer Tree directly.
                //
                // `name` is the RAW wire key — the engine flattens
                // applicators to decorated forms (`width.0`,
                // `padding@md.0`), so the gate must be the
                // decoration-stripping predicate. Plain
                // `is_layout_prop` here silently skipped the restyle
                // for every `.0`-flattened layout prop (`width.0`,
                // `fontSize.0`, `gap.0`, …): Taffy kept solving off
                // the stale style while the fit-pass gate
                // (`patch_affects_layout`, same key) correctly
                // flagged the batch layout-affecting.
                if is_layout_prop_key(name) {
                    if let Some(node) = tree.get(id) {
                        // Through `resolve_node_style`, NOT a raw
                        // `node_style_with`: a patch can hand a node its
                        // first `50vh` (or take its last one away), and a
                        // resolution that isn't traced leaves
                        // `viewport_deps` claiming the node reads no axis
                        // — so the next height-only drag skips it and the
                        // freshly-introduced `vh` freezes at today's
                        // pixels, the exact staleness this mechanism
                        // exists to prevent.
                        self.resolve_node_style(tree, tid, id, node, scale, viewport);
                    }
                    if let Some(parent_tid) = tree
                        .parent_of(id)
                        .filter(|parent| {
                            tree.get(parent)
                                .is_some_and(|node| node.element_type.eq_ignore_ascii_case("Grid"))
                        })
                        .and_then(|parent| self.node_map.get(parent).copied())
                    {
                        self.apply_grid_child_styles(parent_tid, tree);
                    }
                    if tree
                        .get(id)
                        .is_some_and(|node| node.element_type.eq_ignore_ascii_case("Row"))
                    {
                        self.apply_row_width_demand_style(tid, tree);
                    }
                    if let Some(parent_tid) = tree
                        .parent_of(id)
                        .filter(|parent| {
                            tree.get(parent)
                                .is_some_and(|node| node.element_type.eq_ignore_ascii_case("Row"))
                        })
                        .and_then(|parent| self.node_map.get(parent).copied())
                    {
                        self.apply_row_width_demand_style(parent_tid, tree);
                    }
                }
                // A `slot` (re)tag flips a Video child between full-bleed
                // overlay and `display: none`, and `node_style_with`
                // (parent-agnostic, run just above for layout props)
                // knows nothing about it. Re-apply the parent-dependent
                // part whenever the tag itself moves.
                if name == "slot" || name == "slot.0" {
                    if let Some(parent_tid) = tree
                        .parent_of(id)
                        .filter(|p| {
                            tree.get(p).is_some_and(|n| {
                                MEDIA_TYPES
                                    .iter()
                                    .any(|t| t.eq_ignore_ascii_case(&n.element_type))
                            })
                        })
                        .and_then(|p| self.node_map.get(p).copied())
                    {
                        self.apply_video_slot_styles(parent_tid, tree);
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
                let Some(&tid) = self.node_map.get(id.as_ref()) else {
                    return true;
                };
                if let Some(node) = tree.get(id) {
                    // Same door as SetProp above. Text content is not a
                    // viewport read, so this arm never *needs* the trace —
                    // but resolving through it keeps "every style write is
                    // traced" a statement about the code rather than about
                    // each call site's judgement.
                    self.resolve_node_style(tree, tid, id, node, scale, viewport);
                }
                true
            }
            Patch::Insert {
                parent_id,
                id,
                before_id,
            } => {
                self.set_parent_children(parent_id, id, before_id.as_deref(), tree);
                true
            }
            Patch::Attach {
                parent_id,
                id,
                before_id,
            } => {
                self.set_parent_children(parent_id, id, before_id.as_deref(), tree);
                // A cached route can receive an entire embedded-app subtree
                // while detached from the live root. Taffy's incremental
                // dirty propagation does not reliably invalidate every
                // descendant that was measured off-root when that route is
                // attached later. Keep the cheap link update above, but force
                // the next compute to rebuild from the authoritative Tree.
                false
            }
            Patch::Move {
                parent_id,
                id,
                before_id,
            } => {
                // `set_parent_children` unlinks from the old Taffy
                // parent itself (via `remove_child`, which marks that
                // parent dirty) before inserting under the new one.
                self.set_parent_children(parent_id, id, before_id.as_deref(), tree);
                true
            }
            Patch::Remove { id, .. } => {
                if let Some(tid) = self.node_map.remove(id.as_ref()) {
                    if let Some(parent) = self.tree.parent(tid) {
                        // Single-pass unlink + dirty-mark; `tree.remove`
                        // below would unlink too but does NOT mark the
                        // parent dirty, so the explicit remove_child stays.
                        let _ = self.tree.remove_child(parent, tid);
                    }
                    let _ = self.tree.remove(tid);
                    self.forget_node_records(tid);
                }
                true
            }
            Patch::Detach { id } => {
                if let Some(&tid) = self.node_map.get(id.as_ref()) {
                    if let Some(parent) = self.tree.parent(tid) {
                        let _ = self.tree.remove_child(parent, tid);
                    }
                }
                // See Attach above. Route cache transitions are infrequent;
                // rebuilding here avoids retaining stale off-root geometry.
                false
            }
            // Batch-scoped animation prelude: addresses no node and never
            // affects layout. The desktop renderer doesn't animate batch
            // stamps yet — ignoring it snaps, which is the protocol's
            // sanctioned degradation.
            Patch::BatchAnimation { .. } => false,
            // Template patches are lowered by the `TemplateExpander` in
            // `flush_patches` before any batch reaches the Taffy mirror.
            // One arriving here means the expander passed it through
            // (unknown template id / malformed skeleton) — report it as
            // unhandled so the caller falls back to a bulk rebuild.
            Patch::RegisterTemplate { .. } | Patch::Instantiate { .. } => false,
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
        // Unlink from any current Taffy parent first (Move within or
        // across parents, defensive re-Insert). `remove_child` marks
        // the old parent dirty. The subsequent add/insert is O(1) /
        // O(n_siblings) in place — the previous clone-children +
        // retain + set_children round trip made a batch inserting N
        // children under one parent O(N²).
        if let Some(prev) = self.tree.parent(child_tid) {
            let _ = self.tree.remove_child(prev, child_tid);
        }
        let pos = before_id
            .and_then(|bid| self.node_map.get(bid))
            .and_then(|t| {
                // Only anchored inserts pay the children() Vec clone;
                // the common append (before_id = None) skips it.
                self.tree
                    .children(parent_tid)
                    .ok()?
                    .iter()
                    .position(|c| c == t)
            });
        let _ = match pos {
            Some(idx) => self.tree.insert_child_at_index(parent_tid, idx, child_tid),
            None => self.tree.add_child(parent_tid, child_tid),
        };

        // Stack: every child past the first picks up `position:
        // absolute` + margin → inset so it overlays the base. This
        // runs whenever a Stack's children change so newly-inserted
        // children get the right styling and reordering doesn't
        // strand absolute settings on the wrong child.
        if parent_tid != self.root {
            if let Some(parent_node) = tree.get(parent_id) {
                if parent_node.element_type.eq_ignore_ascii_case("Stack") {
                    self.apply_stack_overlay_styles(parent_tid, tree);
                }
                // Video v2 slots: children of a Video are full-bleed
                // absolute overlays (untagged ones are `display: none`).
                // Same reasoning as Stack — `node_style_with` is
                // parent-agnostic, so the parent-dependent part is
                // re-applied whenever the child list changes.
                if MEDIA_TYPES
                    .iter()
                    .any(|t| t.eq_ignore_ascii_case(&parent_node.element_type))
                {
                    self.apply_video_slot_styles(parent_tid, tree);
                }
                if parent_node.element_type.eq_ignore_ascii_case("Grid") {
                    self.apply_grid_child_styles(parent_tid, tree);
                }
                if parent_node.element_type.eq_ignore_ascii_case("Row") {
                    self.apply_row_width_demand_style(parent_tid, tree);
                }
            }
        }
    }

    fn apply_row_width_demand_style(&mut self, row_tid: NodeId, tree: &Tree) {
        let Some(row_node) = self
            .renderer_for_taffy
            .get(&row_tid)
            .and_then(|rid| tree.get(rid))
        else {
            return;
        };
        let children: Vec<NodeId> = self.tree.children(row_tid).unwrap_or_default();
        let Ok(mut style) = self.tree.style(row_tid).cloned() else {
            return;
        };
        apply_row_width_demand(row_node, &mut style, &self.tree, &children);
        let _ = self.tree.set_style(row_tid, style);
    }

    /// Grid direct children stretch to their tracks on Web, Android, and
    /// iOS. A standalone Desktop Image deliberately has a 60×60 fallback,
    /// but leaving that definite fallback on an otherwise-unsized Grid child
    /// prevents Taffy's grid-item stretch from taking effect. Convert only
    /// bare direct Image children to a track-width square; authored dimensions
    /// and standalone images retain their normal sizing rules.
    fn apply_grid_child_styles(&mut self, parent_tid: NodeId, tree: &Tree) {
        let children: Vec<NodeId> = self.tree.children(parent_tid).unwrap_or_default();
        for child in children {
            let Some(node) = self
                .renderer_for_taffy
                .get(&child)
                .and_then(|rid| tree.get(rid))
            else {
                continue;
            };
            let Ok(mut style) = self.tree.style(child).cloned() else {
                continue;
            };
            apply_grid_image_stretch(node, &mut style);
            let _ = self.tree.set_style(child, style);
        }
    }

    /// Re-apply [`apply_slot_overlay_style`] to every child of a Video's
    /// Taffy node. Called on child-list changes and after `restyle_all`
    /// (which rebuilds parent-agnostic styles and would otherwise strip
    /// the overlay positioning).
    fn apply_video_slot_styles(&mut self, parent_tid: NodeId, tree: &Tree) {
        let children: Vec<NodeId> = self.tree.children(parent_tid).unwrap_or_default();
        for child in children {
            let tagged = self
                .renderer_for_taffy
                .get(&child)
                .and_then(|rid| tree.get(rid))
                .and_then(crate::video_v2::node_slot)
                .is_some();
            let Ok(mut s) = self.tree.style(child).cloned() else {
                continue;
            };
            apply_slot_overlay_style(&mut s, tagged);
            let _ = self.tree.set_style(child, s);
        }
    }

    fn apply_stack_overlay_styles(&mut self, parent_tid: NodeId, tree: &Tree) {
        let center_overlays = self.tree.style(parent_tid).is_ok_and(|style| {
            style.align_items == Some(AlignItems::Center)
                && style.justify_content == Some(JustifyContent::Center)
        });
        let children: Vec<NodeId> = self.tree.children(parent_tid).unwrap_or_default();
        for (idx, &child) in children.iter().enumerate() {
            let Ok(mut s) = self.tree.style(child).cloned() else {
                continue;
            };
            // A Stack is the Desktop equivalent of the DOM renderer's
            // one-cell grid. Text alignment needs the Text item to own the
            // whole grid track; otherwise its laid-out rect is only as wide
            // as its glyphs and center/end have no space to align within.
            if self
                .renderer_for_taffy
                .get(&child)
                .and_then(|rid| tree.get(rid))
                .is_some_and(text_requests_stack_track_width)
            {
                s.align_self = Some(AlignSelf::Stretch);
            }
            if idx == 0 {
                s.position = Position::Relative;
                s.inset = Rect_ {
                    top: LengthPercentageAuto::auto(),
                    right: LengthPercentageAuto::auto(),
                    bottom: LengthPercentageAuto::auto(),
                    left: LengthPercentageAuto::auto(),
                };
            } else {
                make_stack_overlay_absolute(&mut s, center_overlays);
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
        // Through `resolve_node_style` so the write is traced — the same
        // reason as `apply_patch`'s SetProp arm: an untraced resolution
        // leaves `viewport_deps` blind to a viewport unit this write may
        // have just introduced.
        self.resolve_node_style(tree, tid, id, node, scale, viewport);
        // The freshly-built style has an `auto` width again, so any
        // fit-content override we wrote is gone — drop the bookkeeping
        // and re-derive it on the next compute.
        self.fit_widths.remove(&tid);
        self.fit_pass_dirty = true;
        if let Some(parent_tid) = tree
            .parent_of(id)
            .filter(|parent| {
                tree.get(parent)
                    .is_some_and(|node| node.element_type.eq_ignore_ascii_case("Grid"))
            })
            .and_then(|parent| self.node_map.get(parent).copied())
        {
            self.apply_grid_child_styles(parent_tid, tree);
        }
        if node.element_type.eq_ignore_ascii_case("Row") {
            self.apply_row_width_demand_style(tid, tree);
        }
        if let Some(parent_tid) = tree
            .parent_of(id)
            .filter(|parent| {
                tree.get(parent)
                    .is_some_and(|node| node.element_type.eq_ignore_ascii_case("Row"))
            })
            .and_then(|parent| self.node_map.get(parent).copied())
        {
            self.apply_row_width_demand_style(parent_tid, tree);
        }
    }

    /// Re-apply styles to every node and refresh the root style.
    /// Called when the structure key flipped on viewport / scale —
    /// breakpoint resolution and HiDPI scaling are baked into
    /// per-node styles at build time, so we have to recompute them.
    pub fn restyle_all(&mut self, tree: &Tree, scale: f32, viewport_px: (u32, u32)) {
        let viewport = logical_viewport(viewport_px, scale);
        // Every style is about to be rebuilt from scratch, wiping the
        // fit-content widths this pass wrote last frame.
        self.fit_widths.clear();
        self.fit_pass_dirty = true;
        // Re-style every existing node.
        let entries: Vec<(NodeId, String)> = self
            .renderer_for_taffy
            .iter()
            .map(|(t, r)| (*t, r.clone()))
            .collect();
        for (tid, rid) in entries {
            if let Some(node) = tree.get(&rid) {
                self.resolve_node_style(tree, tid, &rid, node, scale, viewport);
            }
        }
        // Every live node has now been traced.
        self.deps_complete = true;
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
        self.last_root_viewport = Some(viewport_px);

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
            self.apply_stack_overlay_styles(tid, tree);
        }

        // Same re-walk for Video v2 slot parents: the parent-agnostic
        // restyle above stripped the absolute/inset-0 overlay styling
        // (and the `display: none` on untagged children) off every
        // Video child.
        let video_parents: Vec<NodeId> = self
            .renderer_for_taffy
            .iter()
            .filter_map(|(tid, rid)| {
                let n = tree.get(rid)?;
                MEDIA_TYPES
                    .iter()
                    .any(|t| t.eq_ignore_ascii_case(&n.element_type))
                    .then_some(*tid)
            })
            .collect();
        for tid in video_parents {
            self.apply_video_slot_styles(tid, tree);
        }

        let grid_parents: Vec<NodeId> = self
            .renderer_for_taffy
            .iter()
            .filter_map(|(tid, rid)| {
                tree.get(rid)?
                    .element_type
                    .eq_ignore_ascii_case("Grid")
                    .then_some(*tid)
            })
            .collect();
        for tid in grid_parents {
            self.apply_grid_child_styles(tid, tree);
        }
        let row_parents: Vec<NodeId> = self
            .renderer_for_taffy
            .iter()
            .filter_map(|(tid, rid)| {
                tree.get(rid)?
                    .element_type
                    .eq_ignore_ascii_case("Row")
                    .then_some(*tid)
            })
            .collect();
        for tid in row_parents {
            self.apply_row_width_demand_style(tid, tree);
        }
    }

    /// Carry percentage/stretch demand through wrapping vertical containers.
    /// Patch-driven construction creates a parent before its descendants are
    /// attached, so the demand must be reconciled after the tree is complete.
    /// Give a `flex-1` scroll pane CSS's intrinsic size inside a
    /// *content-sized* column.
    ///
    /// CSS `flex: 1` is `1 1 0%`, and a percentage basis against an
    /// indefinite container main size resolves to `content`. So in
    ///
    /// ```text
    /// Column {                                   // height: auto
    ///   Toolbar
    ///   Column { Grid … }.tw("flex-1 min-h-[300px] overflow-y-auto")
    ///   Status
    /// }.tw("min-h-[460px]")
    /// ```
    ///
    /// the browser sizes the pane to its content (floored by its
    /// min-height) and the outer column grows to fit. Desktop lowers
    /// `flex: N` to a *length* zero basis (see `set_flex_shorthand` for
    /// why that is the right default), and Taffy 0.10's intrinsic
    /// main-size pass short-circuits a scroll container's contribution to
    /// exactly that basis — ignoring both its content and its `min-height`
    /// (`determine_container_main_size`: `_ if item.is_scroll_container()
    /// => item.flex_basis`). The column therefore stayed at its own
    /// min-height, the pane got whatever was left, and the Files app's
    /// Grid overflowed it: the last row's names were clipped under the
    /// pane's bottom edge, and a pane shorter than its own `min-h` let
    /// the rows below it overlap the window chrome.
    ///
    /// For panes whose parent column is genuinely content-sized (auto
    /// height, not growing, laid out along a vertical main axis so it is
    /// not cross-stretched either) this restores the CSS contribution:
    ///
    /// * `flex_basis: 0%` — resolves to `content` while the parent is
    ///   being measured (CSS semantics) and to `0` in the final pass,
    ///   where the parent's size is known, so the pane still fills
    ///   exactly the leftover space;
    /// * `Overflow::Clip` for Taffy instead of `Scroll` — same clipping
    ///   and content-size behaviour for the renderer (which reads
    ///   scrolling from the props, never the Taffy style), but Taffy then
    ///   measures the pane's real content contribution clamped by its
    ///   min/max instead of the bare basis. The automatic minimum size
    ///   stays zero because `apply_overflow_props` already wrote an
    ///   explicit one.
    ///
    /// Panes under a growing / fixed-height / row parent keep the plain
    /// zero basis, so the scroll-pane-fills-its-slot layouts that motivated
    /// it are untouched.
    fn reconcile_content_sized_scroll_panes(&mut self) {
        let Self {
            tree: taffy,
            renderer_for_taffy,
            scroll_pane_overrides,
            ..
        } = self;

        fn is_column(style: &Style) -> bool {
            style.display == Display::Flex
                && matches!(
                    style.flex_direction,
                    FlexDirection::Column | FlexDirection::ColumnReverse
                )
        }

        // Parent is sized by its own content along a vertical main axis.
        let content_sized_column_parent = |taffy: &TaffyTree<NodeContext>, node: NodeId| {
            let Some(parent) = taffy.parent(node) else {
                return false;
            };
            let Some(grand) = taffy.parent(parent) else {
                return false;
            };
            let (Ok(p), Ok(g)) = (taffy.style(parent), taffy.style(grand)) else {
                return false;
            };
            is_column(p)
                && p.position != Position::Absolute
                && p.size.height.is_auto()
                && p.flex_grow == 0.0
                && p.aspect_ratio.is_none()
                && is_column(g)
        };

        // Restore panes that no longer qualify. A restyle rebuilt the
        // node's style from scratch (zero basis + `Scroll` again), in
        // which case there is nothing to undo, only bookkeeping.
        let tracked: Vec<NodeId> = scroll_pane_overrides.keys().copied().collect();
        for node in tracked {
            let Ok(style) = taffy.style(node) else {
                scroll_pane_overrides.remove(&node);
                continue;
            };
            if style.flex_basis != Dimension::percent(0.0) {
                scroll_pane_overrides.remove(&node);
                continue;
            }
            if style.flex_grow > 0.0
                && style.position != Position::Absolute
                && content_sized_column_parent(taffy, node)
            {
                continue;
            }
            let Some(original) = scroll_pane_overrides.remove(&node) else {
                continue;
            };
            let mut next = style.clone();
            next.flex_basis = Dimension::length(0.0);
            next.overflow = original;
            let _ = taffy.set_style(node, next);
        }

        for &node in renderer_for_taffy.keys() {
            if scroll_pane_overrides.contains_key(&node) {
                continue;
            }
            // Reject by reference before cloning: almost no node is a
            // growing vertical scroll pane.
            match taffy.style(node) {
                Ok(style)
                    if style.overflow.y == Overflow::Scroll
                        && style.flex_grow > 0.0
                        && style.flex_basis == Dimension::length(0.0)
                        && style.position != Position::Absolute => {}
                _ => continue,
            }
            if !content_sized_column_parent(taffy, node) {
                continue;
            }
            let Ok(style) = taffy.style(node) else {
                continue;
            };
            let original = style.overflow;
            let mut next = style.clone();
            next.flex_basis = Dimension::percent(0.0);
            let clip = |o: Overflow| {
                if o == Overflow::Scroll {
                    Overflow::Clip
                } else {
                    o
                }
            };
            next.overflow = taffy::Point {
                x: clip(original.x),
                y: clip(original.y),
            };
            if taffy.set_style(node, next).is_ok() {
                scroll_pane_overrides.insert(node, original);
            }
        }
    }

    fn reconcile_cross_axis_width_demand(&mut self, tree: &Tree) {
        // Disjoint field borrows so the walk can read `renderer_for_taffy`
        // while mutating the Taffy tree. The previous version sidestepped
        // the borrow by cloning the whole mapping into a `Vec<(NodeId,
        // String)>` first — one heap allocation per node, every layout
        // pass, purely to satisfy the borrow checker.
        let Self {
            tree: taffy,
            renderer_for_taffy,
            ..
        } = self;
        // Fixpoint: promoting one node to `Stretch` can make its parent
        // demand width too. Converges in a couple of rounds in practice;
        // the bound is a backstop, and the `changed` early-out is what
        // actually ends it.
        for _ in 0..renderer_for_taffy.len().max(1) {
            let mut changed = false;
            for (tid, rid) in renderer_for_taffy.iter() {
                let Some(node) = tree.get(rid) else { continue };
                if node.element_type.eq_ignore_ascii_case("Row") {
                    continue;
                }
                // Reject by reference. `Style` is a large struct and this
                // walk visits every node in the tree on every pass, so
                // cloning one before checking whether the node is even a
                // candidate was most of this stage's cost.
                match taffy.style(*tid) {
                    Ok(style)
                        if style.size.width == Dimension::auto()
                            && style.align_self != Some(AlignSelf::Stretch) => {}
                    _ => continue,
                }
                let demands_width = taffy
                    .children(*tid)
                    .unwrap_or_default()
                    .iter()
                    .any(|child| {
                        taffy.style(*child).is_ok_and(|child_style| {
                            child_style.size.width.into_raw().uses_percentage()
                                || child_style.align_self == Some(AlignSelf::Stretch)
                        })
                    });
                if demands_width {
                    let Ok(mut style) = taffy.style(*tid).cloned() else {
                        continue;
                    };
                    style.align_self = Some(AlignSelf::Stretch);
                    let _ = taffy.set_style(*tid, style);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
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
        // Unchanged viewport → the root style would be byte-identical;
        // skip the set_style so the root's layout cache survives and a
        // clean frame's compute stays a cache walk.
        if self.last_root_viewport == Some(viewport) {
            return;
        }
        self.last_root_viewport = Some(viewport);
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
fn taffy_structure_key(scale: f32, safe_area: SafeAreaInsets) -> u64 {
    use std::hash::{Hash, Hasher};
    // Deliberately NOT the viewport. This key means "something changed
    // that every node's style depends on", and only scale (which
    // multiplies every length token) and the safe-area insets qualify.
    //
    // The viewport used to be here — width in, height out, on the stated
    // grounds that "no token resolves against" height. That was wrong
    // (`vh`, `vmin` and `vmax` all do), and it was wrong in both
    // directions: it forced a whole-tree restyle on every width step for
    // trees where nothing read the width, and skipped one on every height
    // step for the nodes that did read the height. Viewport changes are
    // now handled per node from the axes each style resolution actually
    // read — see `TaffyState::viewport_deps`.
    let mut h = std::collections::hash_map::DefaultHasher::new();
    scale.to_bits().hash(&mut h);
    // Safe-area insets bake into every SafeArea node's padding, so an
    // embedder changing them mid-session has to restyle for the same
    // reason a scale change does.
    safe_area.hash_into(&mut h);
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

    /// [`Self::compute`] with embedder-configured safe-area insets —
    /// the one-shot counterpart of [`TaffyState::set_safe_area_insets`],
    /// for tests and pre-renders that don't retain a `TaffyState`.
    pub fn compute_with_insets(
        tree: &Tree,
        text: &mut TextEngine,
        viewport: (u32, u32),
        scale: f32,
        insets: SafeAreaInsets,
    ) -> Self {
        let mut state = TaffyState::new();
        state.set_safe_area_insets(insets);
        Self::compute_inner_state(
            &mut state,
            tree,
            text,
            viewport,
            scale,
            0.0,
            &HashMap::new(),
            0,
            false,
        )
    }

    /// [`Self::compute_with_insets`] that also sets the window's
    /// platform safe-area insets (see
    /// [`TaffyState::set_platform_safe_area`]) — for tests and
    /// pre-renders exercising a decoration setup, e.g.
    /// [`window_controls_platform_insets`]`(true, true)` to lay out as
    /// under the macOS unified titlebar on any host OS.
    pub fn compute_with_safe_area(
        tree: &Tree,
        text: &mut TextEngine,
        viewport: (u32, u32),
        scale: f32,
        insets: SafeAreaInsets,
        platform: crate::style::Padding,
    ) -> Self {
        let mut state = TaffyState::new();
        state.set_safe_area_insets(insets);
        state.set_platform_safe_area(platform);
        Self::compute_inner_state(
            &mut state,
            tree,
            text,
            viewport,
            scale,
            0.0,
            &HashMap::new(),
            0,
            false,
        )
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

    /// Re-emit the visible item window from an already-computed retained
    /// Taffy tree. Sustained scrolling periodically moves beyond the cached
    /// cull window; rebuilding item membership must happen then, but rerunning
    /// flex layout and text measurement is wasted work because no style,
    /// structure, viewport, or intrinsic input changed. Keeping this path
    /// separate removes the half-viewport hitch without weakening culling.
    pub(crate) fn reemit_with_state(
        state: &TaffyState,
        tree: &Tree,
        viewport: (u32, u32),
        scale: f32,
        scroll_y: f32,
        scrolls: &HashMap<String, f32>,
    ) -> Self {
        debug_assert!(state.root_initialised);
        let viewport_logical = logical_viewport(viewport, scale);
        let mut items = Vec::new();
        let mut content_size = (0.0_f32, 0.0_f32);
        let cull_viewport = Some(Rect {
            x: 0.0,
            y: scroll_y,
            w: viewport.0 as f32,
            h: viewport.1 as f32,
        });
        emit_items(
            &state.tree,
            state.root,
            0.0,
            0.0,
            0.0,
            tree,
            &state.renderer_for_taffy,
            viewport_logical,
            scale,
            scrolls,
            &mut items,
            &mut content_size,
            cull_viewport,
            None,
            0.0,
            None,
        );

        if scroll_y != 0.0 {
            for item in &mut items {
                item.rect.y -= scroll_y;
                if let Some(clip) = item.clip_to.as_mut() {
                    clip.y -= scroll_y;
                }
            }
        }

        if tree.has_opacity_props() {
            let mut memo: HashMap<String, f32> = HashMap::new();
            for item in &mut items {
                item.opacity = effective_opacity(tree, &item.node_id, viewport_logical, &mut memo);
            }
        }
        compute_item_transforms_gated(
            tree,
            &mut items,
            viewport_logical,
            scale,
            tree.has_transform_props(),
        );

        let indexes = build_item_indexes(&items);
        let (a11y, a11y_hash) = collect_item_semantics(tree, &items);
        Self {
            items,
            content_size,
            by_node_id: indexes.by_node_id,
            actionable_ids: indexes.actionable_ids,
            focusable_ids: indexes.focusable_ids,
            scrollable_ids: indexes.scrollable_ids,
            hoverable_ids: indexes.hoverable_ids,
            a11y,
            a11y_hash,
        }
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
        let key = taffy_structure_key(scale, state.effective_safe_area());
        // Which viewport axes moved since the last pass. Feeds the
        // per-node restyle below; `None` on the first pass, where the
        // build path resolves everything anyway.
        let viewport_axes_changed = match state.last_style_viewport {
            Some(prev) => {
                let mut axes = 0u8;
                if prev.0 != viewport.0 {
                    axes |= crate::style::viewport_trace::WIDTH;
                }
                if prev.1 != viewport.1 {
                    axes |= crate::style::viewport_trace::HEIGHT;
                }
                axes
            }
            None => 0,
        };
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
        let image_load_generation = crate::paint::image::image_load_generation();
        let image_intrinsics_changed = image_load_generation != state.image_load_generation;
        let needs_rebuild = state.needs_bulk_rebuild || image_intrinsics_changed;
        // The build / restyle paths read `state.interaction`; clone it
        // up front so the `&mut state.tree` borrow during the bulk
        // rebuild doesn't conflict with the immutable read.
        let interaction = state.interaction.clone();
        // Same reason — `build_subtree` takes it by value while
        // `&mut state.tree` is borrowed. Effective values: embedder
        // overrides merged over the window's platform insets.
        let safe_area = state.effective_safe_area();

        if needs_rebuild {
            // Cold start or out-of-sync after an unhandled patch.
            // Wipe and rebuild from the renderer Tree.
            state.tree = TaffyTree::new();
            state.renderer_for_taffy.clear();
            state.node_map.clear();
            // NodeIds from the old tree are meaningless in the new one.
            // EVERY `NodeId`-keyed map has to be dropped here: a fresh
            // `TaffyTree` re-issues the SAME id sequence from the start,
            // so a surviving entry does not merely go stale — it silently
            // re-points at whichever node now occupies that slot.
            state.fit_widths.clear();
            state.text_height_overrides.clear();
            state.wrapped_probes.clear();
            // `build_subtree` allocates every node below WITHOUT going
            // through `resolve_node_style`, so nothing here is traced.
            // Note this branch is reachable without `mark_needs_rebuild`
            // — `image_intrinsics_changed` arrives here on its own — so
            // the flag has to be cleared at the branch, not only in the
            // function that usually precedes it.
            state.viewport_deps.clear();
            state.deps_complete = false;
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
                    safe_area,
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
            state.last_root_viewport = Some(viewport);
            state.needs_bulk_rebuild = false;
            state.image_load_generation = image_load_generation;
        } else if style_changed
            || interaction_changed
            || !state.root_initialised
            || (viewport_axes_changed != 0 && !state.deps_complete)
        {
            // Something every node's style depends on moved (scale, the
            // safe-area insets), or an interaction transition toggled a
            // layout-affecting state variant — either way walk the whole
            // tree. Also taken on the first viewport change after nodes
            // were created, to re-establish the `viewport_deps` invariant
            // (see `deps_complete`).
            state.restyle_all(tree, scale, viewport);
            state.structure_key = key;
        } else {
            // Nothing global moved. If the viewport did, restyle exactly
            // the nodes whose resolution read the axis that changed —
            // a `vh`/`vmin` length or a breakpoint variant. On the
            // overwhelmingly common tree that is a handful of nodes or
            // none at all, where this used to be either the whole tree
            // (any width step) or nothing (any height step, which is how
            // `vh` lengths came to go stale).
            if viewport_axes_changed != 0 {
                state.restyle_viewport_dependents(tree, scale, viewport, viewport_axes_changed);
            }
            // The root's own `min_size.height = viewport.h` follows the
            // viewport regardless of what any node's style reads.
            state.refresh_root_size(scale, viewport);
        }
        state.last_style_viewport = Some(viewport);
        state.interaction_key = interaction_key;
        if needs_rebuild || style_changed || interaction_changed {
            state.fit_pass_dirty = true;
        }
        // One flag now gates BOTH full-tree style-derivation walks. They
        // are invalidated by exactly the same events — a bulk rebuild, a
        // `restyle_all`, or a batch carrying a layout-affecting patch —
        // because both derive extra constraints from the per-node styles
        // and nothing else can move them.
        //
        // `reconcile_cross_axis_width_demand` used to run unconditionally.
        // It walks every node in the tree (twice, until its fixpoint
        // settles) and it was the largest single stage of a window-HEIGHT
        // drag, where by construction not one style has changed: the
        // structure key deliberately excludes height, so `restyle_all`
        // never runs and there is nothing for the walk to discover. Its
        // `align_self: Stretch` writes persist in the Taffy tree between
        // passes, and the walk only ever adds them, so a skipped pass
        // leaves the tree exactly as the last one left it.
        let style_inputs_dirty = std::mem::take(&mut state.fit_pass_dirty);
        if style_inputs_dirty {
            state.reconcile_cross_axis_width_demand(tree);
            state.reconcile_content_sized_scroll_panes();
        }
        let root = state.root;
        let fit_pass_dirty = style_inputs_dirty;
        let fit_widths = &mut state.fit_widths;
        clear_wrapped_text_height_overrides(&mut state.tree, &mut state.text_height_overrides);
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
        let mut measure = |known: Size<Option<f32>>,
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
            let (w, measured_h) = text.measure_weighted_line_height(
                text_content,
                ctx.font_size,
                wrap_width,
                ctx.font_weight,
                ctx.line_height,
            );
            let h = ctx
                .max_lines
                .map(|lines| measured_h.min(ctx.line_height * lines as f32))
                .unwrap_or(measured_h);
            Size {
                width: known.width.unwrap_or(w),
                height: known.height.unwrap_or(h),
            }
        };

        if let Err(e) = taffy.compute_layout_with_measure(root, available, &mut measure) {
            log::warn!("taffy layout failed: {e:?}");
        }

        // Content-sized flex containers (`alignSelf(center)` heroes and
        // friends) need a second pass — see `apply_fit_content_widths`
        // for why Taffy can't get their width right on its own. The
        // pre-pass reads the parent widths the layout above resolved,
        // probes each candidate's max-content width, and writes a
        // definite width; the re-layout below then places it.
        if fit_pass_dirty && apply_fit_content_widths(taffy, root, &mut measure, fit_widths) {
            if let Err(e) = taffy.compute_layout_with_measure(root, available, &mut measure) {
                log::warn!("taffy relayout failed: {e:?}");
            }
        }

        // Flex sizing may reduce a Text leaf after its max-content measure.
        // Taffy 0.10 does not reliably remeasure that leaf at the final width,
        // leaving the box one line tall while the painter wraps two lines.
        // Reconcile only affected text nodes, then run one bounded relayout.
        if apply_wrapped_text_heights(
            taffy,
            renderer_for_taffy.keys().copied(),
            &mut measure,
            &mut state.text_height_overrides,
            &mut state.wrapped_probes,
        ) {
            if let Err(e) = taffy.compute_layout_with_measure(root, available, &mut measure) {
                log::warn!("taffy wrapped-text relayout failed: {e:?}");
            }
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
            0.0,
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
        // O(1) post-pass gates: the Tree maintains live counters of
        // opacity / transform prop keys (see `Tree::has_opacity_props`),
        // replacing what used to be a full per-frame prop scan — ~1.4 ms
        // on an 11k-node tree, the largest single per-total-node frame
        // tax after the fit-pass gating.
        let has_opacity = tree.has_opacity_props();
        let has_transform = tree.has_transform_props();
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
        // rects. Gated on the combined scan above.
        compute_item_transforms_gated(tree, &mut items, viewport_logical, scale, has_transform);

        let indexes = build_item_indexes(&items);
        let (a11y, a11y_hash) = collect_item_semantics(tree, &items);
        let ItemIndexes {
            by_node_id,
            actionable_ids,
            focusable_ids,
            scrollable_ids,
            hoverable_ids,
        } = indexes;

        Self {
            items,
            content_size,
            by_node_id,
            actionable_ids,
            focusable_ids,
            scrollable_ids,
            hoverable_ids,
            a11y,
            a11y_hash,
        }
    }

    /// O(1) item lookup by renderer node id.
    pub fn item_by_id(&self, id: &str) -> Option<&LayoutItem> {
        self.by_node_id.get(id).map(|&i| &self.items[i])
    }

    /// The emitted scrollable-container items, in document order —
    /// O(n_scrollables) via the side index, not a full item scan.
    pub fn scrollable_items(&self) -> impl Iterator<Item = &LayoutItem> {
        self.scrollable_ids.iter().map(move |&i| &self.items[i])
    }

    /// O(1) mutable item lookup by renderer node id. Used for in-place
    /// patches of paint-only item state (e.g. a Scrubber's drag preview)
    /// that must reach paint before the next full layout pass without
    /// dropping the cached pass.
    pub fn item_by_id_mut(&mut self, id: &str) -> Option<&mut LayoutItem> {
        let &i = self.by_node_id.get(id)?;
        self.items.get_mut(i)
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

    /// In-place paint refresh for a patch batch the window classified
    /// as paint-only (`window::paint_only_affected_ids` returned
    /// `Some`): re-resolve every affected item's paint fields from the
    /// (already-mutated) tree, then re-run the opacity and transform
    /// post-passes and rebuild the derived indexes — WITHOUT dropping
    /// the pass or re-running Taffy / emit. Sound because the
    /// classifier guarantees no patch in the batch could change
    /// geometry: no structural patch, no layout-affecting prop (so
    /// every `rect`, `clip_to`, `subtree_root`, `content_size` and the
    /// item SET are byte-identical to what a full recompute would
    /// produce), no essential-snap restyles, no media nodes, no
    /// scrub-owned nodes.
    ///
    /// `affected` ids without an emitted item (culled / detached) are
    /// skipped — the next full pass re-resolves them from the same
    /// tree when they re-enter the window. The post-passes and index
    /// rebuild run over ALL items (not just affected) because opacity
    /// and transforms inherit downward and the indexes are positional;
    /// both are O(items) with O(1) gates, the same cost every full
    /// compute already pays.
    ///
    /// The a11y semantics map is rebuilt from the tree wholesale:
    /// `SetSemantics` patches qualify as paint-only but do NOT
    /// contribute ids to `affected`, so a per-id refresh would miss
    /// them.
    pub fn refresh_paint_only(
        &mut self,
        tree: &Tree,
        affected: &std::collections::HashSet<String>,
        viewport: Viewport,
        scale: f32,
    ) {
        for id in affected {
            let Some(&idx) = self.by_node_id.get(id) else {
                continue;
            };
            let Some(node) = tree.get(id) else {
                continue;
            };
            refresh_item_paint(&mut self.items[idx], node, tree, viewport);
        }
        // Same post-pass recipe as `compute_inner_state`, including the
        // gate-closed reset: if the batch REMOVED the tree's last
        // opacity / transform prop, stale non-default values must
        // return to their defaults, exactly as a fresh emit would.
        if tree.has_opacity_props() {
            let mut memo: HashMap<String, f32> = HashMap::new();
            for it in self.items.iter_mut() {
                it.opacity = effective_opacity(tree, &it.node_id, viewport, &mut memo);
            }
        } else {
            for it in self.items.iter_mut() {
                it.opacity = 1.0;
            }
        }
        compute_item_transforms_gated(
            tree,
            &mut self.items,
            viewport,
            scale,
            tree.has_transform_props(),
        );
        // Paint-only writes can still flip derived-index membership
        // (adding `onClick` makes an item actionable AND focusable;
        // adding `.onHover` makes it hoverable), so rebuild them with
        // the same shared helper `compute_inner_state` uses.
        let indexes = build_item_indexes(&self.items);
        self.by_node_id = indexes.by_node_id;
        self.actionable_ids = indexes.actionable_ids;
        self.focusable_ids = indexes.focusable_ids;
        self.scrollable_ids = indexes.scrollable_ids;
        self.hoverable_ids = indexes.hoverable_ids;
        let (a11y, a11y_hash) = collect_item_semantics(tree, &self.items);
        self.a11y = a11y;
        self.a11y_hash = a11y_hash;
    }

    /// Container-scroll fast path: shift the emitted rects of
    /// `container_id`'s descendants by `delta` (positive = scrolled
    /// down = content moves up) IN PLACE, instead of re-running Taffy
    /// + emit. The container-scroll analogue of `App::redraw`'s
    /// page-scroll shift. Sound within the cull buffer: the caller
    /// (redraw) forces a full re-emit once `|live - emitted_offset|`
    /// exceeds [`SCROLL_REEMIT_THRESHOLD_VH`], and the emit walk
    /// culls against the page viewport ± [`CULL_BUFFER_VH`], so
    /// every rect this shift can move into view was emitted.
    ///
    /// What shifts and what doesn't:
    /// - STRICT descendants of the container shift; the container's
    ///   own row (bg / border / rect) does not move.
    /// - `clip_to` shifts only when the clip's OWNER (the item's
    ///   nearest scrollable ancestor) is itself a descendant of the
    ///   scrolled container (nested scrollables) — clips anchored to
    ///   the scrolled container itself stay put, that container
    ///   isn't moving.
    /// - Cumulative transforms are recomputed exactly against the
    ///   shifted rects (gated O(1) when the tree has no transform
    ///   props) rather than conjugated: ancestors ABOVE the
    ///   container don't shift, so the page path's uniform
    ///   conjugation identity doesn't hold here.
    /// - `baked_offset` advances by `delta` so drift consumers
    ///   (focus reveal, the next shift) stay calibrated;
    ///   `emitted_offset` deliberately does NOT move — it anchors
    ///   the re-emit threshold to the cull window's origin.
    ///
    /// `content_size`, membership, and every derived index are
    /// untouched: a within-buffer container scroll changes only
    /// where existing items sit.
    pub fn shift_container_scroll(
        &mut self,
        tree: &Tree,
        container_id: &str,
        delta: f32,
        viewport: Viewport,
        scale: f32,
    ) {
        if delta == 0.0 {
            return;
        }
        // Strict-descendant test, memoized per node id across the
        // item loop (ancestor chains overlap heavily in a feed).
        let mut desc_memo: HashMap<String, bool> = HashMap::new();
        fn is_strict_descendant(
            tree: &Tree,
            id: &str,
            container: &str,
            memo: &mut HashMap<String, bool>,
        ) -> bool {
            if let Some(&v) = memo.get(id) {
                return v;
            }
            let v = match tree.parent_of(id) {
                Some(p) if p == container => true,
                Some(p) if p == crate::tree::ROOT_ID => false,
                Some(p) => {
                    let p = p.to_string();
                    is_strict_descendant(tree, &p, container, memo)
                }
                None => false,
            };
            memo.insert(id.to_string(), v);
            v
        }
        let mut shifted_any = false;
        for it in self.items.iter_mut() {
            if !is_strict_descendant(tree, &it.node_id, container_id, &mut desc_memo) {
                continue;
            }
            shifted_any = true;
            it.rect.y -= delta;
        }
        // `clip_to` is the intersection of every clipping ancestor, not a
        // rectangle owned by exactly one ancestor. Shifting that intersection
        // blindly is wrong when one edge belongs to the stationary scroller
        // and another belongs to a moving rounded card: the stationary edge
        // drifts, content disappears, then snaps back on the next full emit.
        // Rebuild the effective intersections from the newly-shifted ancestor
        // rects instead. This is still an O(visible-items) scroll fast path and
        // is exactly equivalent to a fresh emit for partially clipped cards.
        if shifted_any {
            self.refresh_effective_clips(tree, viewport, scale);
        }
        // Exact transform refresh against the shifted rects. Gated:
        // the no-transform tree resets to identity in O(items).
        compute_item_transforms_gated(
            tree,
            &mut self.items,
            viewport,
            scale,
            tree.has_transform_props(),
        );
        // Advance the rect baseline ONLY when rects actually moved: a
        // container with no emitted descendants (or one that left the
        // tree while the pass stayed alive) must not desynchronise
        // `baked_offset` from what the rects reflect — that would
        // silently suppress every future shift for it. Leaving the
        // anchor put re-detects the same drift next frame (a cheap
        // no-op walk) until a real emit re-bases it.
        if shifted_any {
            if let Some(item) = self.item_by_id_mut(container_id) {
                if let Some(meta) = item.scrollable.as_mut() {
                    meta.baked_offset += delta;
                }
            }
        }
    }

    /// Rebuild each emitted item's single effective clip from all clipping
    /// ancestors. `emit_items` performs the same intersection while walking
    /// top-down; the container-scroll fast path calls this after it changes
    /// cached rects so fixed and moving clip edges cannot drift apart.
    fn refresh_effective_clips(&mut self, tree: &Tree, viewport: Viewport, scale: f32) {
        // Resolve against the pass's existing O(1) id index. Building a fresh
        // String-keyed map here allocated once per visible item per wheel
        // frame, which is measurable on image-heavy feeds in debug builds.
        // Compute into a compact side vector first, then apply it in one
        // mutable pass so no renderer ids need to be cloned.
        let effective: Vec<Option<(Rect, f32)>> = self
            .items
            .iter()
            .map(|item| {
                let mut clip: Option<(Rect, f32)> = None;
                let mut ancestor = tree.parent_of(&item.node_id);
                while let Some(id) = ancestor {
                    if id == crate::tree::ROOT_ID {
                        break;
                    }
                    if let (Some(node), Some(&idx)) = (tree.get(id), self.by_node_id.get(id)) {
                        if is_scrollable_node(node, viewport) || clips_overflow_node(node, viewport)
                        {
                            let ancestor_item = &self.items[idx];
                            let next = (ancestor_item.rect, ancestor_item.border.radius * scale);
                            clip = Some(match clip {
                                None => next,
                                Some((current, current_radius)) => {
                                    intersect_clip_rects(current, current_radius, next.0, next.1)
                                }
                            });
                        }
                    }
                    ancestor = tree.parent_of(id);
                }
                clip
            })
            .collect();

        for (item, clip) in self.items.iter_mut().zip(effective) {
            match clip {
                Some((rect, radius)) => {
                    item.clip_to = Some(rect);
                    item.clip_radius = radius;
                }
                None => {
                    item.clip_to = None;
                    item.clip_radius = 0.0;
                }
            }
        }
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
    pub fn hit_scrollable_excluding<'a>(
        &'a self,
        x: f32,
        y: f32,
        excluded: &'a dyn Fn(&str) -> bool,
    ) -> Option<&'a LayoutItem> {
        self.scrollable_hits_excluding(x, y, excluded).next()
    }

    /// Every scrollable under the pointer, innermost/topmost first.
    /// Wheel routing uses the full chain so a horizontal rail or a vertical
    /// scroller already at its boundary can bubble the delta to its parent.
    pub fn scrollable_hits_excluding<'a>(
        &'a self,
        x: f32,
        y: f32,
        excluded: &'a dyn Fn(&str) -> bool,
    ) -> impl Iterator<Item = &'a LayoutItem> + 'a {
        self.scrollable_ids
            .iter()
            .rev()
            .map(|&i| &self.items[i])
            .filter(move |it| it.hit_contains(x, y) && !excluded(&it.node_id))
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
    /// (Buttons, Cards, Links), renderer-local `.videoIntent(...)`
    /// controls (Enter / Space performs the intent), text inputs, and
    /// Scrubbers
    /// (which take Left / Right to seek, so they must be reachable
    /// without a pointer). A Scrubber outside any Video renders inert
    /// per the spec — disabled, not focusable, no commits — so only a
    /// wired one takes focus.
    pub fn is_focusable(&self) -> bool {
        self.action.is_some()
            || self.video_intent.is_some()
            || (matches!(self.kind, ItemKind::Input { .. }) && !self.state_variants.disabled)
            || matches!(
                self.kind,
                ItemKind::Scrubber {
                    video_id: Some(_),
                    ..
                }
            )
    }

    /// The enclosing player id when this item is a `Scrubber` wired to
    /// one. `None` for every other kind, and for an inert Scrubber
    /// outside a Video.
    pub fn scrubber_video_id(&self) -> Option<&str> {
        match &self.kind {
            ItemKind::Scrubber { video_id, .. } => video_id.as_deref(),
            _ => None,
        }
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
            return self.rect.contains(x, y) && self.hit_geometry(x, y);
        }
        match self.transform.inverse() {
            Some(inv) => {
                let (lx, ly) = inv.apply(x, y);
                self.rect.contains(lx, ly) && self.hit_geometry(lx, ly)
            }
            None => false,
        }
    }

    /// Sub-rectangle refinement of [`LayoutItem::hit_contains`]. Every
    /// ordinary item fills its rect, so this is `true`; a chart mark is a
    /// polyline / bar / circle inside the chart's box and answers from its
    /// own device-pixel geometry, so the pointer lands on the mark the user
    /// can actually see rather than anywhere in the plot.
    fn hit_geometry(&self, x: f32, y: f32) -> bool {
        match &self.kind {
            ItemKind::ChartMark(mark) => mark.hit(x, y).is_some(),
            _ => true,
        }
    }

    /// The payload to dispatch for a pointer event on this item at
    /// `pointer` (viewport-space device pixels; `None` for an
    /// assistive-technology activation, which carries no position).
    ///
    /// Ordinary items just carry their static action arguments. A chart
    /// mark merges `{series, index, x, y, datum}` — the datum in DATA
    /// units — on top of them, and the chart host merges the pointer
    /// position `{x, y}` in data units. Static args always win nothing:
    /// the contract puts the resolved datum on top.
    pub fn action_payload_at(&self, pointer: Option<(f32, f32)>) -> Option<serde_json::Value> {
        let chart_fields = match &self.kind {
            ItemKind::ChartMark(mark) => {
                Some(mark.payload(pointer.map(|(x, y)| self.to_local(x, y))))
            }
            ItemKind::Chart(scene) => pointer.map(|(x, y)| {
                let (lx, ly) = self.to_local(x, y);
                scene.payload(lx, ly)
            }),
            _ => None,
        };
        let Some(fields) = chart_fields else {
            return self.action_payload.clone();
        };
        let mut obj = match self.action_payload.clone() {
            Some(serde_json::Value::Object(map)) => map,
            _ => serde_json::Map::new(),
        };
        for (key, value) in fields {
            obj.insert(key, value);
        }
        Some(serde_json::Value::Object(obj))
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
// Content-sized flex containers (CSS `fit-content` in the cross axis).
// ---------------------------------------------------------------------------

/// A flex container whose cross size (width) is content-derived rather
/// than stretched, plus the parent it draws its available width from.
struct FitCandidate {
    node: NodeId,
    parent: NodeId,
}

/// True when `dim` is a definite zero (`Length(0)` or `Percent(0)`) —
/// the flex-basis `flex: <n>` lowers to.
fn is_definite_zero(dim: Dimension) -> bool {
    dim == Dimension::length(0.0) || dim == Dimension::percent(0.0)
}

/// True when a child with `child_style` inside a container with
/// `parent_style` is stretched along the container's cross axis (and so
/// gets a definite cross size handed down rather than a content-derived
/// one). `align-self` wins over the container's `align-items`; the CSS
/// initial value for both is `stretch`.
fn is_cross_stretched(parent_align_items: Option<AlignItems>, child_style: &Style) -> bool {
    let align = child_style.align_self.or(parent_align_items);
    matches!(align, None | Some(AlignItems::Stretch))
}

/// Compute a definite width for every content-sized flex row that Taffy
/// would otherwise collapse, writing it into the node's style. Returns
/// `true` if any node was probed (in which case the caller MUST re-run
/// the root layout — probing overwrites the subtree's stored layout).
///
/// ## Why this exists
///
/// A `Row` that opts out of its parent Column's cross-axis stretch —
/// `.alignSelf("center")`, or a parent with `items-center` — is sized by
/// its content: CSS says `width: fit-content`, i.e.
/// `clamp(min-content, stretch-fit, max-content)`.
///
/// Taffy 0.10 does implement §9.9.1 (the "max-content flex fraction"
/// walk) — but only when the container is probed with
/// `AvailableSpace::MinContent | MaxContent`. A non-stretched flex item
/// is measured through `determine_hypothetical_cross_size`, which hands
/// the container the parent's *definite* available cross space, so
/// `determine_container_main_size` takes its `AvailableSpace::Definite`
/// shortcut instead:
///
/// ```text
/// sum over items of (flex_basis.max(style_min_size.main) + margin).max(padding + border)
/// ```
///
/// That sum uses the flex **base** size, not the item's max-content
/// contribution. `flex: 1` lowers to `flex-basis: 0` (see
/// `set_flex_shorthand`), so every growable child contributes *zero* and
/// the row collapses to roughly its fixed-size children plus padding.
/// The Hypeflix hero — `Row { Column.tw("flex-1 min-w-0 …"), Image
/// .tw("w-28 shrink-0") }.maxWidth(1200).alignSelf("center")` — came out
/// 170px wide with a 16px text column, so the blurb wrapped one word per
/// line and spilled out underneath the poster.
///
/// The fix is to give Taffy the answer it refuses to compute: probe the
/// container standalone with `MaxContent` / `MinContent` available space
/// (which *does* route through §9.9.1), then set an explicit
/// `size.width = clamp(min-content, available, max-content)`. The node's
/// own `max_size.width` (`.maxWidth(1200)`) still clamps on top, exactly
/// as it would for an author-written width.
fn apply_fit_content_widths<M>(
    taffy: &mut TaffyTree<NodeContext>,
    root: NodeId,
    measure: &mut M,
    overrides: &mut HashMap<NodeId, f32>,
) -> bool
where
    M: FnMut(
        Size<Option<f32>>,
        Size<AvailableSpace>,
        NodeId,
        Option<&mut NodeContext>,
        &Style,
    ) -> Size<f32>,
{
    // Undo last frame's overrides so candidate detection sees the
    // authored (auto-width) style again. Skip nodes whose width has
    // since been replaced by a real authored value or a restyle.
    for (node, width) in std::mem::take(overrides) {
        let Ok(style) = taffy.style(node) else {
            continue;
        };
        if style.size.width != Dimension::length(width) {
            continue;
        }
        let mut style = style.clone();
        style.size.width = Dimension::auto();
        let _ = taffy.set_style(node, style);
    }

    let mut candidates = Vec::new();
    collect_fit_candidates(taffy, root, &mut candidates);
    if candidates.is_empty() {
        return false;
    }

    // Outermost-first so a nested candidate reads a parent width that
    // already reflects the enclosing container's resolved size.
    let mut settled: Vec<(NodeId, f32)> = Vec::new();
    for FitCandidate { node, parent } in candidates {
        // A candidate nested inside one we already sized reads its
        // available width out of a subtree that still carries the
        // pre-pass layout. Re-lay that ancestor at its new width first.
        if let Some(&(ancestor, width)) = settled
            .iter()
            .find(|(a, _)| is_descendant_of(taffy, node, *a))
        {
            let _ = taffy.compute_layout_with_measure(
                ancestor,
                Size {
                    width: AvailableSpace::Definite(width),
                    height: AvailableSpace::MaxContent,
                },
                &mut *measure,
            );
        }
        // Available cross space = the parent's content box minus this
        // node's own margins, straight off the layout the caller just
        // computed (margins are only stale if the parent itself moved,
        // which dirties this pass again anyway).
        let Ok(parent_layout) = taffy.layout(parent) else {
            continue;
        };
        let parent_inner = parent_layout.size.width
            - parent_layout.padding.left
            - parent_layout.padding.right
            - parent_layout.border.left
            - parent_layout.border.right
            - parent_layout.scrollbar_size.width;
        let Ok(own_layout) = taffy.layout(node) else {
            continue;
        };
        let avail = (parent_inner - own_layout.margin.left - own_layout.margin.right).max(0.0);

        // `compute_layout_with_measure` on a subtree root routes through
        // the intrinsic-sizing branch of the flex algorithm, which is the
        // one that honours §9.9.1.
        let mut probe =
            |taffy: &mut TaffyTree<NodeContext>, space: AvailableSpace| -> Option<f32> {
                taffy
                    .compute_layout_with_measure(
                        node,
                        Size {
                            width: space,
                            height: AvailableSpace::MaxContent,
                        },
                        &mut *measure,
                    )
                    .ok()?;
                taffy.layout(node).ok().map(|l| l.size.width)
            };
        let Some(max_content) = probe(taffy, AvailableSpace::MaxContent) else {
            continue;
        };
        let min_content = probe(taffy, AvailableSpace::MinContent).unwrap_or(0.0);
        // CSS fit-content: shrink to max-content, never past min-content.
        let fit = max_content.min(avail).max(min_content);

        let Ok(style) = taffy.style(node) else {
            continue;
        };
        let mut style = style.clone();
        style.size.width = Dimension::length(fit);
        let _ = taffy.set_style(node, style);
        overrides.insert(node, fit);
        settled.insert(0, (node, fit));
    }
    true
}

/// True when `node` sits anywhere under `ancestor`.
fn is_descendant_of(taffy: &TaffyTree<NodeContext>, node: NodeId, ancestor: NodeId) -> bool {
    let mut cursor = node;
    while let Some(parent) = taffy.parent(cursor) {
        if parent == ancestor {
            return true;
        }
        cursor = parent;
    }
    false
}

/// Remove wrapped-text minimums written by the previous frame. A wider
/// viewport can unwrap the text, so retaining the old minimum would leave a
/// stale tall pill even though the text now fits on one line.
fn clear_wrapped_text_height_overrides(
    taffy: &mut TaffyTree<NodeContext>,
    overrides: &mut HashMap<NodeId, (Dimension, f32)>,
) {
    for (node, (authored, applied)) in std::mem::take(overrides) {
        let Ok(style) = taffy.style(node) else {
            continue;
        };
        if style.min_size.height != Dimension::length(applied) {
            continue;
        }
        let mut style = style.clone();
        style.min_size.height = authored;
        let _ = taffy.set_style(node, style);
    }
}

/// Ensure a flex-shrunk Text leaf is tall enough for the lines produced at
/// its final content width. Returns true when at least one style changed.
fn apply_wrapped_text_heights<M, I>(
    taffy: &mut TaffyTree<NodeContext>,
    nodes: I,
    measure: &mut M,
    overrides: &mut HashMap<NodeId, (Dimension, f32)>,
    probes: &mut HashMap<NodeId, (f32, f32)>,
) -> bool
where
    I: IntoIterator<Item = NodeId>,
    M: FnMut(
        Size<Option<f32>>,
        Size<AvailableSpace>,
        NodeId,
        Option<&mut NodeContext>,
        &Style,
    ) -> Size<f32>,
{
    let mut changed = false;
    for node in nodes {
        // Reject by reference before cloning anything. This pass is
        // handed EVERY node in the tree, and the great majority are
        // not wrappable text — but the old order cloned the context
        // (which owns the text `String`), the `Layout` and the
        // `Style` for all of them and only then looked at whether
        // the node qualified. On a 13k-node tree that made this the
        // single most expensive stage of a resize frame, larger than
        // the Taffy solve it exists to correct.
        match taffy.get_node_context(node) {
            Some(ctx) if ctx.text.is_some() && !matches!(ctx.max_lines, Some(1)) => {}
            _ => continue,
        }
        // An explicit height is authoritative; wrapping follows the normal
        // overflow/max-lines contract rather than growing the box.
        match taffy.style(node) {
            Ok(style) if style.size.height == Dimension::auto() => {}
            _ => continue,
        }
        let Some(mut context) = taffy.get_node_context(node).cloned() else {
            continue;
        };
        let Ok(layout) = taffy.layout(node).cloned() else {
            continue;
        };
        let Ok(style) = taffy.style(node).cloned() else {
            continue;
        };
        let content_width = (layout.size.width
            - layout.padding.left
            - layout.padding.right
            - layout.border.left
            - layout.border.right)
            .max(0.0);
        // The measure is a pure function of the node's context and the
        // width it is being wrapped to, so a pass that did not move
        // either re-derives the identical answer. Reuse it rather than
        // re-shaping through cosmic-text — whose cache lookup has to
        // hash the node's full text just to find the hit. A window
        // HEIGHT drag changes no content width at all, so on that path
        // every node takes this branch. `probes` is dropped wholesale
        // whenever a context could have changed (see the field docs).
        let chrome =
            layout.padding.top + layout.padding.bottom + layout.border.top + layout.border.bottom;
        //
        // Only the measured TEXT height is memoised; the padding and
        // border are re-added from this pass's layout every time. They
        // can move without the content width moving (a breakpoint that
        // widens the box and its padding by the same amount, say), and
        // baking them into the cached value would carry a stale box
        // across that case.
        let measured_h = match probes.get(&node) {
            Some(&(probed_width, measured_h))
                if probed_width.to_bits() == content_width.to_bits() =>
            {
                measured_h
            }
            _ => {
                let measured = measure(
                    Size {
                        width: Some(content_width),
                        height: None,
                    },
                    Size {
                        width: AvailableSpace::Definite(content_width),
                        height: AvailableSpace::MaxContent,
                    },
                    node,
                    Some(&mut context),
                    &style,
                );
                probes.insert(node, (content_width, measured.height));
                measured.height
            }
        };
        let required = measured_h + chrome;
        if required <= layout.size.height + 0.5 {
            continue;
        }
        let authored = style.min_size.height;
        let applied = if authored.is_auto() {
            required
        } else if let Some(value) = authored.into_option() {
            required.max(value)
        } else {
            // A percentage minimum is parent-relative; do not replace an
            // authored constraint whose absolute value is unavailable here.
            continue;
        };
        let mut next = style;
        next.min_size.height = Dimension::length(applied);
        if taffy.set_style(node, next).is_ok() {
            overrides.insert(node, (authored, applied));
            changed = true;
        }
    }
    changed
}

/// Walk the Taffy tree collecting flex containers that are (a) sized by
/// their content in the inline axis and (b) contain a horizontal flex
/// line with a zero-basis growable item — the exact shape Taffy's
/// `AvailableSpace::Definite` shortcut under-measures.
///
/// The container that needs the definite width is not necessarily the
/// collapsing Row itself: Hypeflix's marathon banner is a `Button`
/// (column-direction) with `alignSelf("center")` wrapping a stretched
/// Row, and the Button's content-derived cross size is what pulls the
/// collapsed Row width up the tree. So candidacy is about the *outer*
/// content-sized box; the trigger is looked for anywhere below it.
fn collect_fit_candidates(
    taffy: &TaffyTree<NodeContext>,
    node: NodeId,
    out: &mut Vec<FitCandidate>,
) {
    // Copy out only the two fields the child check needs — cloning the
    // whole `Style` (grid template Vecs included) for every node on
    // every fit pass was pure allocation churn.
    let (column_parent, parent_align_items) = {
        let Ok(parent_style) = taffy.style(node) else {
            return;
        };
        (
            parent_style.display == Display::Flex
                && matches!(
                    parent_style.flex_direction,
                    FlexDirection::Column | FlexDirection::ColumnReverse
                ),
            parent_style.align_items,
        )
    };
    // Index-based iteration: `taffy.children()` clones a Vec per
    // container, and this walk covers the whole tree every time the
    // fit pass is dirty.
    let n = taffy.child_count(node);
    for idx in 0..n {
        let Ok(child) = taffy.child_at_index(node, idx) else {
            continue;
        };
        if column_parent {
            if let Ok(child_style) = taffy.style(child) {
                if child_style.display == Display::Flex
                    && child_style.position != Position::Absolute
                    && child_style.size.width.is_auto()
                    && !is_cross_stretched(parent_align_items, child_style)
                    && has_zero_basis_growable_row(taffy, child)
                {
                    out.push(FitCandidate {
                        node: child,
                        parent: node,
                    });
                }
            }
        }
        collect_fit_candidates(taffy, child, out);
    }
}

/// True when `node` — or any flex box below it — lays children out
/// horizontally and has one that grows from a definite-zero basis. That
/// child contributes 0 to Taffy's definite-space content-size shortcut
/// no matter how wide its own content is.
fn has_zero_basis_growable_row(taffy: &TaffyTree<NodeContext>, node: NodeId) -> bool {
    let Ok(style) = taffy.style(node) else {
        return false;
    };
    let is_row = style.display == Display::Flex
        && matches!(
            style.flex_direction,
            FlexDirection::Row | FlexDirection::RowReverse
        );
    let n = taffy.child_count(node);
    (0..n).any(|idx| {
        let Ok(child) = taffy.child_at_index(node, idx) else {
            return false;
        };
        if is_row
            && taffy.style(child).is_ok_and(|s| {
                s.flex_grow > 0.0 && s.size.width.is_auto() && is_definite_zero(s.flex_basis)
            })
        {
            return true;
        }
        has_zero_basis_growable_row(taffy, child)
    })
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
    safe_area: SafeAreaInsets,
) -> Option<NodeId> {
    let node = tree.get(node_id)?;
    // Per-node active interaction states for layout-affecting state
    // variants. Empty (fast path) unless this node is the hovered /
    // pressed / focused subject or is disabled.
    let vs = VariantState::paint(viewport, interaction.active_states_for(node_id, node));

    match node.element_type.as_str() {
        et if IMAGE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
            // See `image_style` for the sizing rules.
            let mut style = image_style(node, &vs, scale);
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            let id = taffy.new_leaf(style).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et if CONTROL_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
            let (default_width, default_height) = if et.eq_ignore_ascii_case("Audio") {
                (300.0, 54.0)
            } else if et.eq_ignore_ascii_case("Checkbox") {
                (20.0, 20.0)
            } else if et.eq_ignore_ascii_case("Switch") {
                (44.0, 24.0)
            } else if et.eq_ignore_ascii_case("Slider") {
                (200.0, 20.0)
            } else if et.eq_ignore_ascii_case("Progress") || et.eq_ignore_ascii_case("ProgressBar")
            {
                (200.0, 8.0)
            } else if et.eq_ignore_ascii_case("Select") {
                (200.0, 32.0)
            } else {
                let size = prop_f32_with(node, "size", &vs).unwrap_or(24.0);
                (size, size)
            };
            let mut style = Style {
                display: Display::Flex,
                size: Size {
                    width: Dimension::length(default_width * scale),
                    height: Dimension::length(default_height * scale),
                },
                flex_shrink: 0.0,
                margin: margin_to_taffy(margin_with(node, &vs), scale),
                ..Default::default()
            };
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            let id = taffy.new_leaf(style).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et if MEDIA_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
            // Video: sized like Image, but with a 16:9 default aspect
            // (poster natural aspect when already loaded) instead of a
            // square fallback — see `media_style` for the rules.
            let mut style = media_style(node, &vs, scale);
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            // Video v2 composition slots: `.slot(name)`-tagged children
            // are built as absolutely-positioned, inset-0 overlays of
            // the video's own box, stacked in declaration order. They
            // contribute nothing to the player's size (absolute children
            // are out of flow), so the 16:9 / poster-aspect sizing above
            // is undisturbed. Untagged children stay invalid per the
            // spec ("Video is a leaf for ordinary children") — they are
            // built but forced `display: none` so a stray child can't
            // silently paint over the surface.
            let mut children = Vec::new();
            for child_id in tree.children_of(node_id) {
                if let Some(c) = build_subtree(
                    taffy,
                    tree,
                    child_id,
                    scale,
                    viewport,
                    renderer_for_taffy,
                    interaction,
                    safe_area,
                ) {
                    let tagged = tree
                        .get(child_id)
                        .and_then(crate::video_v2::node_slot)
                        .is_some();
                    if let Ok(mut s) = taffy.style(c).cloned() {
                        apply_slot_overlay_style(&mut s, tagged);
                        let _ = taffy.set_style(c, s);
                    }
                    children.push(c);
                }
            }
            let id = taffy.new_with_children(style, &children).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et if crate::chart::is_chart_type(et) => {
            // A chart is a leaf-like block: default height 200, width
            // fills the parent. Its MARKS are laid out by the chart
            // itself (see `crate::chart::build_scene`), so none of them
            // is built into the Taffy tree — with the single exception
            // of `Marker`, whose children are ordinary Hypen components
            // that need a real box. Those are built as absolutely-
            // positioned children here and moved onto their data point
            // by the emit pass, so they contribute nothing to the
            // chart's own size.
            let mut style = chart_style(node, &vs, scale);
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            let mut children = Vec::new();
            for child_id in tree.children_of(node_id) {
                if let Some(c) = build_subtree(
                    taffy,
                    tree,
                    child_id,
                    scale,
                    viewport,
                    renderer_for_taffy,
                    interaction,
                    safe_area,
                ) {
                    children.push(c);
                }
            }
            let id = taffy.new_with_children(style, &children).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et if crate::chart::MarkKind::from_element_type(et).is_some() => {
            // Marks are the chart's business, not Taffy's. A `Marker`
            // directly under a chart is the exception: it hosts real
            // Hypen children, so it builds like an out-of-flow container
            // (the chart pins it to its data point at emit time). Every
            // other mark — and any mark that strayed outside a chart —
            // contributes no box at all, which is also what makes a
            // decorative mark pointer-transparent.
            let is_marker = crate::chart::MarkKind::from_element_type(et)
                == Some(crate::chart::MarkKind::Marker);
            let inside_chart = tree
                .parent_of(node_id)
                .and_then(|parent| tree.get(parent))
                .is_some_and(|parent| crate::chart::is_chart_type(&parent.element_type));
            if !(is_marker && inside_chart) {
                return None;
            }
            let pad = padding_with(node, &vs);
            let mut style = Style {
                display: Display::Flex,
                flex_direction: FlexDirection::Column,
                position: Position::Absolute,
                inset: Rect_ {
                    top: LengthPercentageAuto::length(0.0),
                    right: LengthPercentageAuto::auto(),
                    bottom: LengthPercentageAuto::auto(),
                    left: LengthPercentageAuto::length(0.0),
                },
                padding: Rect_ {
                    left: length(pad.left * scale),
                    right: length(pad.right * scale),
                    top: length(pad.top * scale),
                    bottom: length(pad.bottom * scale),
                },
                border: border_to_taffy(border_with(node, &vs), scale),
                ..Default::default()
            };
            apply_flex_props(&mut style, node, &vs, scale);
            apply_size_props(&mut style, node, &vs, scale);
            let mut children = Vec::new();
            for child_id in tree.children_of(node_id) {
                if let Some(c) = build_subtree(
                    taffy,
                    tree,
                    child_id,
                    scale,
                    viewport,
                    renderer_for_taffy,
                    interaction,
                    safe_area,
                ) {
                    children.push(c);
                }
            }
            let id = taffy.new_with_children(style, &children).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et if SCRUBBER_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
            let mut style = scrubber_style(node, &vs, scale);
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            let id = taffy.new_leaf(style).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et if TEXT_INPUT_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
            // Inputs / Textareas are leaf flex nodes. Match the DOM reset:
            // there is no implicit frame or padding, but explicit
            // `.padding(...)` and `.border(...)` use the ordinary box model.
            let mut style = text_input_style(node, &vs, scale);
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            let id = taffy.new_leaf(style).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        "Text" => {
            let font_size = inherited_text_font_size(tree, node_id, viewport) * scale;
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
            if tree
                .parent_of(node_id)
                .and_then(|parent| tree.get(parent))
                .is_some_and(|parent| parent.element_type.eq_ignore_ascii_case("Heading"))
            {
                style.flex_shrink = 0.0;
            }
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            let id = taffy
                .new_leaf_with_context(
                    style,
                    NodeContext {
                        text: Some(content),
                        font_size,
                        line_height: resolved_line_height(node, font_size / scale, viewport)
                            * scale,
                        max_lines: resolve_max_lines(node, viewport),
                        font_weight: inherited_text_font_weight(tree, node_id, viewport),
                    },
                )
                .ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et if et.eq_ignore_ascii_case("Spacer") => {
            let mut style = Style {
                display: Display::Flex,
                flex_grow: 1.0,
                flex_shrink: 1.0,
                flex_basis: Dimension::length(0.0),
                min_size: Size {
                    width: Dimension::length(0.0),
                    height: Dimension::length(0.0),
                },
                ..Default::default()
            };
            apply_size_props(&mut style, node, &vs, scale);
            let id = taffy.new_leaf(style).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et if et.eq_ignore_ascii_case("Center") => {
            let pad = padding_with(node, &vs);
            let mut style = Style {
                display: Display::Flex,
                flex_direction: FlexDirection::Column,
                align_items: Some(AlignItems::Center),
                justify_content: Some(JustifyContent::Center),
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
            let children = tree
                .children_of(node_id)
                .iter()
                .filter_map(|child_id| {
                    build_subtree(
                        taffy,
                        tree,
                        child_id,
                        scale,
                        viewport,
                        renderer_for_taffy,
                        interaction,
                        safe_area,
                    )
                })
                .collect::<Vec<_>>();
            let id = taffy.new_with_children(style, &children).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et if et.eq_ignore_ascii_case("Badge") => {
            let mut style = badge_style(node, &vs, scale);
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            let children = tree
                .children_of(node_id)
                .iter()
                .filter_map(|child_id| {
                    build_subtree(
                        taffy,
                        tree,
                        child_id,
                        scale,
                        viewport,
                        renderer_for_taffy,
                        interaction,
                        safe_area,
                    )
                })
                .collect::<Vec<_>>();
            let id = taffy.new_with_children(style, &children).ok()?;
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
                // DOM Button/Card surfaces are content-width flex items by
                // default. `.fillMaxWidth(true)` or an explicit alignment can
                // still opt into cross-axis stretch in the passes below.
                align_self: Some(AlignSelf::Start),
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
                if let Some(c) = build_subtree(
                    taffy,
                    tree,
                    child_id,
                    scale,
                    viewport,
                    renderer_for_taffy,
                    interaction,
                    safe_area,
                ) {
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
                // Stack uses a single full-width track. Column direction
                // makes cross-axis stretch horizontal (matching the DOM
                // grid implementation) while later children remain absolute
                // overlays.
                flex_direction: FlexDirection::Column,
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
            apply_stack_fill_min_size(&mut style);
            let mut children = Vec::new();
            for child_id in tree.children_of(node_id) {
                if let Some(c) = build_subtree(
                    taffy,
                    tree,
                    child_id,
                    scale,
                    viewport,
                    renderer_for_taffy,
                    interaction,
                    safe_area,
                ) {
                    children.push(c);
                }
            }
            // Mark every child after the first as absolute. Their
            // existing margins resolve into `inset` for the absolute
            // positioning, so `.marginTop(36).marginLeft(36)` on a
            // badge overlay anchors at +36/+36 from the parent's
            // top-left instead of pushing into flex flow.
            let center_overlays = style.align_items == Some(AlignItems::Center)
                && style.justify_content == Some(JustifyContent::Center);
            for &child in children.iter().skip(1) {
                if let Ok(mut s) = taffy.style(child).cloned() {
                    make_stack_overlay_absolute(&mut s, center_overlays);
                    let _ = taffy.set_style(child, s);
                }
            }
            for (&child, child_id) in children.iter().zip(tree.children_of(node_id)) {
                if tree
                    .get(child_id)
                    .is_some_and(text_requests_stack_track_width)
                {
                    if let Ok(mut s) = taffy.style(child).cloned() {
                        s.align_self = Some(AlignSelf::Stretch);
                        let _ = taffy.set_style(child, s);
                    }
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
                    .map(|_| taffy::style_helpers::flex::<f32, _>(1.0))
                    .collect(),
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
            };
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            apply_overflow_props(&mut style, node, viewport);
            apply_position_props(&mut style, node, &vs, scale);
            let mut children = Vec::new();
            for child_id in tree.children_of(node_id) {
                if let Some(c) = build_subtree(
                    taffy,
                    tree,
                    child_id,
                    scale,
                    viewport,
                    renderer_for_taffy,
                    interaction,
                    safe_area,
                ) {
                    if let (Some(child_node), Ok(mut child_style)) =
                        (tree.get(child_id), taffy.style(c).cloned())
                    {
                        apply_grid_image_stretch(child_node, &mut child_style);
                        let child_vs = VariantState::paint(
                            viewport,
                            interaction.active_states_for(child_id, child_node),
                        );
                        apply_grid_placement_props(child_node, &child_vs, &mut child_style);
                        let _ = taffy.set_style(c, child_style);
                    }
                    children.push(c);
                }
            }
            let id = taffy.new_with_children(style, &children).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
        et if et.eq_ignore_ascii_case(SAFE_AREA_TYPE) => {
            // Full-size vertical container that pads itself by the
            // effective safe-area insets on the edges its `edges` prop
            // selects — see `safe_area_style`. Zero insets by default
            // on desktop, so an unconfigured SafeArea lays out exactly
            // like a full-size Column.
            let mut style = safe_area_style(node, &vs, scale, safe_area);
            apply_flex_props(&mut style, node, &vs, scale);
            apply_alignment_props(&mut style, node, viewport);
            apply_size_props(&mut style, node, &vs, scale);
            apply_overflow_props(&mut style, node, viewport);
            apply_position_props(&mut style, node, &vs, scale);
            let mut children = Vec::new();
            for child_id in tree.children_of(node_id) {
                if let Some(c) = build_subtree(
                    taffy,
                    tree,
                    child_id,
                    scale,
                    viewport,
                    renderer_for_taffy,
                    interaction,
                    safe_area,
                ) {
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
                align_items: Some(AlignItems::Start),
                align_self: et.eq_ignore_ascii_case("Row").then_some(AlignSelf::Start),
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
            apply_divider_defaults(&mut style, node, &vs, scale);
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
                if let Some(c) = build_subtree(
                    taffy,
                    tree,
                    child_id,
                    scale,
                    viewport,
                    renderer_for_taffy,
                    interaction,
                    safe_area,
                ) {
                    children.push(c);
                }
            }
            if et.eq_ignore_ascii_case("Row") {
                apply_row_width_demand(node, &mut style, taffy, &children);
            } else if style.size.width == Dimension::auto()
                && children.iter().any(|child| {
                    taffy.style(*child).is_ok_and(|child_style| {
                        child_style.size.width.into_raw().uses_percentage()
                            || child_style.align_self == Some(AlignSelf::Stretch)
                    })
                })
            {
                // A percentage/fill descendant needs a finite immediate
                // content width. Carry that demand through wrapping Columns,
                // matching the DOM/Canvas ancestor propagation contract.
                style.align_self = Some(AlignSelf::Stretch);
            }
            let id = taffy.new_with_children(style, &children).ok()?;
            renderer_for_taffy.insert(id, node_id.to_string());
            Some(id)
        }
    }
}

/// True when `name` — a raw patch prop key, possibly variant/arg
/// decorated (`padding@md.0`) — names a layout-affecting prop once
/// stripped to its base, including the two structural-ish props the
/// plain [`is_layout_prop`] list doesn't carry: `slot` (flips a Video
/// child's visibility) and `scrollable` (changes overflow/clip
/// structure). Shared by the painter-cache paint-only gate
/// (`window::paint_only_affected_ids`) and the fit-pass dirty gate so
/// the two can never disagree about what counts as layout-affecting.
pub(crate) fn is_layout_prop_key(name: &str) -> bool {
    let base = hypen_engine::portable::parse_prop_key(name).base;
    is_layout_prop(&base) || matches!(base.as_str(), "slot" | "scrollable")
}

/// True when `patch` can change Taffy geometry or content sizing —
/// the condition for re-running the fit-content pre-pass. Structural
/// patches always can; prop writes only when the (decoration-
/// stripped) prop is layout-affecting; semantics and batch-animation
/// preludes never can.
pub(crate) fn patch_affects_layout(patch: &hypen_engine::Patch) -> bool {
    use hypen_engine::Patch;
    match patch {
        Patch::SetProp { name, .. } | Patch::RemoveProp { name, .. } => is_layout_prop_key(name),
        Patch::SetSemantics { .. } | Patch::BatchAnimation { .. } => false,
        _ => true,
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
            | "fillmaxwidth"
            | "fillmaxheight"
            | "fillmaxsize"
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
            // Textarea intrinsic height is `rows` lines of its line height.
            | "rows"
            | "lineheight"
            | "line-height"
            | "maxlines" // re-shapes wrap → measured height
            | "max-lines"
            // `line-clamp-N` aliases of `maxLines` (`resolve_max_lines`).
            | "webkitlineclamp"
            | "-webkit-line-clamp"
            | "lineclamp"
            | "line-clamp"
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
            | "aligncontent"
            | "align-content"
            | "justifycontent"
            | "justify-content"
            | "justifyself"
            | "justify-self"
            // The DSL-level alignment applicators lower to
            // justify_content / align_items exactly like the CSS
            // spellings above (`apply_alignment_props`).
            | "horizontalalignment"
            | "horizontal-alignment"
            | "verticalalignment"
            | "vertical-alignment"
            // `alignment` sets BOTH align_items and justify_content, and
            // `textAlign` sets align_items on a column container — same
            // function, same fields as their neighbours above. Both were
            // missing, so a runtime `.alignment("center")` /
            // `.textAlign("center")` wrote to the renderer tree and never
            // reached Taffy: the prop was inert until an unrelated
            // restyle (a width drag, a scale change) happened along.
            | "alignment"
            | "textalign"
            | "text-align"
            // Divider thickness IS the node's height when no explicit
            // height is set (`apply_divider_defaults`).
            | "thickness"
            | "display"
            | "flexdirection"
            | "flex-direction"
            | "gridcolumns"
            | "grid-columns"
            | "gridcolumn"
            | "grid-column"
            | "gridrow"
            | "grid-row"
            // SafeArea's edge mask — picks which safe-area insets land
            // in the node's Taffy padding (`safe_area_style`), so a
            // live change to it has to restyle like any other padding.
            | "edges"
            | "inset"
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
    safe_area: SafeAreaInsets,
) -> Style {
    let vs = VariantState::paint(viewport, active_states.to_vec());
    let et = node.element_type.as_str();
    let mut style = if IMAGE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) {
        image_style(node, &vs, scale)
    } else if CONTROL_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) {
        let (default_width, default_height) = if et.eq_ignore_ascii_case("Audio") {
            (300.0, 54.0)
        } else if et.eq_ignore_ascii_case("Checkbox") {
            (20.0, 20.0)
        } else if et.eq_ignore_ascii_case("Switch") {
            (44.0, 24.0)
        } else if et.eq_ignore_ascii_case("Slider") {
            (200.0, 20.0)
        } else if et.eq_ignore_ascii_case("Progress") || et.eq_ignore_ascii_case("ProgressBar") {
            (200.0, 8.0)
        } else if et.eq_ignore_ascii_case("Select") {
            (200.0, 32.0)
        } else {
            let size = prop_f32_with(node, "size", &vs).unwrap_or(24.0);
            (size, size)
        };
        Style {
            display: Display::Flex,
            size: Size {
                width: Dimension::length(default_width * scale),
                height: Dimension::length(default_height * scale),
            },
            flex_shrink: 0.0,
            margin: margin_to_taffy(margin_with(node, &vs), scale),
            ..Default::default()
        }
    } else if MEDIA_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) {
        media_style(node, &vs, scale)
    } else if crate::chart::is_chart_type(et) {
        chart_style(node, &vs, scale)
    } else if SCRUBBER_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) {
        scrubber_style(node, &vs, scale)
    } else if TEXT_INPUT_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) {
        text_input_style(node, &vs, scale)
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
    } else if et.eq_ignore_ascii_case("Spacer") {
        Style {
            display: Display::Flex,
            flex_grow: 1.0,
            flex_shrink: 1.0,
            flex_basis: Dimension::length(0.0),
            min_size: Size {
                width: Dimension::length(0.0),
                height: Dimension::length(0.0),
            },
            ..Default::default()
        }
    } else if et.eq_ignore_ascii_case("Center") {
        let pad = padding_with(node, &vs);
        Style {
            display: Display::Flex,
            flex_direction: FlexDirection::Column,
            align_items: Some(AlignItems::Center),
            justify_content: Some(JustifyContent::Center),
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
    } else if et.eq_ignore_ascii_case("Badge") {
        badge_style(node, &vs, scale)
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
            align_self: Some(AlignSelf::Start),
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
            flex_direction: FlexDirection::Column,
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
    } else if et.eq_ignore_ascii_case(SAFE_AREA_TYPE) {
        // Mirror of `build_subtree`'s SafeArea branch.
        safe_area_style(node, &vs, scale, safe_area)
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
            align_items: Some(AlignItems::Start),
            // DOM Column children wrap to intrinsic cross-axis width by
            // default (`align-items: flex-start`). Mark Rows explicitly so a
            // definite height / child fillMaxHeight does not accidentally
            // make the Row stretch across the viewport on Desktop.
            align_self: et.eq_ignore_ascii_case("Row").then_some(AlignSelf::Start),
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
    if et.eq_ignore_ascii_case("Stack") {
        apply_stack_fill_min_size(&mut style);
    }
    apply_divider_defaults(&mut style, node, &vs, scale);
    apply_overflow_props(&mut style, node, viewport);
    apply_position_props(&mut style, node, &vs, scale);
    apply_grid_placement_props(node, &vs, &mut style);
    style
}

/// Apply CSS-like Grid item placement emitted by the DSL. The calculator uses
/// `.gridColumn("span 2")` for its zero key; without this Taffy auto-places
/// every Desktop item into exactly one track and leaves the final row shifted.
fn apply_grid_placement_props(node: &crate::tree::Node, vs: &VariantState, style: &mut Style) {
    fn parse_span(raw: &str) -> Option<u16> {
        let trimmed = raw.trim();
        let value = trimmed
            .strip_prefix("span ")
            .or_else(|| trimmed.strip_prefix("SPAN "))
            .unwrap_or(trimmed)
            .trim()
            .parse::<u16>()
            .ok()?;
        Some(value.max(1))
    }

    if let Some(span) = prop_str_with(node, "gridColumn", vs).and_then(parse_span) {
        style.grid_column = Line {
            start: GridPlacement::Span(span),
            end: GridPlacement::Auto,
        };
    }
    if let Some(span) = prop_str_with(node, "gridRow", vs).and_then(parse_span) {
        style.grid_row = Line {
            start: GridPlacement::Span(span),
            end: GridPlacement::Auto,
        };
    }
}

/// Base Taffy style for a `SafeArea` container: a full-size vertical
/// stack (like `App` / a root `Container`) whose padding is the
/// effective safe-area inset on each included edge, on top of whatever
/// padding the node itself declares.
///
/// The insets are added to the user's padding rather than carried by a
/// separate wrapper node: Taffy expresses padding as one length per
/// edge on the node itself, so the sum produces exactly the geometry a
/// nested wrapper would (inset box outside, user padding inside) with
/// no second Taffy node per SafeArea, and `.padding(16)` keeps working
/// unchanged. The SafeArea's own background still fills the whole box
/// — padding is inside the border box — so it stays full-bleed under
/// the insets.
///
/// Both axes default to 100% of the parent; an explicit `width` /
/// `height` prop still wins because `apply_size_props` runs after this.
fn safe_area_style(
    node: &crate::tree::Node,
    vs: &VariantState,
    scale: f32,
    insets: SafeAreaInsets,
) -> Style {
    let pad = padding_with(node, vs);
    let inset = safe_area_padding(node, insets);
    let gap_v = prop_f32_with(node, "gap", vs).unwrap_or(DEFAULT_GAP_PX) * scale;
    Style {
        display: Display::Flex,
        flex_direction: FlexDirection::Column,
        size: Size {
            width: Dimension::percent(1.0),
            height: Dimension::percent(1.0),
        },
        padding: Rect_ {
            left: length((pad.left + inset.left) * scale),
            right: length((pad.right + inset.right) * scale),
            top: length((pad.top + inset.top) * scale),
            bottom: length((pad.bottom + inset.bottom) * scale),
        },
        margin: margin_to_taffy(margin_with(node, vs), scale),
        border: border_to_taffy(border_with(node, vs), scale),
        gap: Size {
            width: length(gap_v),
            height: length(gap_v),
        },
        ..Default::default()
    }
}

fn badge_style(node: &crate::tree::Node, vs: &VariantState, scale: f32) -> Style {
    let pad = padding_with(node, vs);
    let declares_padding = crate::style::declares_padding(node, vs);
    let fixed_box =
        prop_dim_with(node, "width", vs).is_some() && prop_dim_with(node, "height", vs).is_some();
    let (left, right, top, bottom) = if declares_padding {
        (pad.left, pad.right, pad.top, pad.bottom)
    } else if fixed_box {
        (0.0, 0.0, 0.0, 0.0)
    } else {
        (8.0, 8.0, 4.0, 4.0)
    };
    Style {
        display: Display::Flex,
        flex_direction: FlexDirection::Column,
        align_self: Some(AlignSelf::Start),
        padding: Rect_ {
            left: length(left * scale),
            right: length(right * scale),
            top: length(top * scale),
            bottom: length(bottom * scale),
        },
        margin: margin_to_taffy(margin_with(node, vs), scale),
        border: border_to_taffy(border_with(node, vs), scale),
        ..Default::default()
    }
}

/// Base Taffy style for a media (`Video`) leaf. Sized like `Image`
/// (`width` / `height` px-or-%, `.size(N)` fallback) with one
/// difference: the fallback aspect ratio. An `Image` with a single
/// dimension keeps its *natural* aspect via the bitmap; a video has no
/// natural aspect until its poster loads, so the chain is
/// explicit `aspectRatio` prop → poster natural aspect (when the
/// poster is already in the image cache) → 16:9. When neither axis is
/// constrained at all, the width defaults to
/// [`DEFAULT_VIDEO_WIDTH_PX`] (or `.size(N)`) with the height derived
/// from the same aspect chain.
fn media_style(node: &crate::tree::Node, vs: &VariantState, scale: f32) -> Style {
    let size_fallback = prop_f32_with(node, "size", vs);
    let w_dim = prop_dim_with(node, "width", vs);
    let h_dim = prop_dim_with(node, "height", vs);
    let explicit_ar = crate::style::prop_aspect_ratio_with(node, "aspectRatio", vs);
    let fallback_ar = explicit_ar
        .or_else(|| {
            resolve_media_poster(node, vs.viewport)
                .and_then(|p| crate::paint::image::loaded_natural_size(&p))
                .filter(|(_, h)| *h > 0.0)
                .map(|(w, h)| w / h)
        })
        .unwrap_or(DEFAULT_VIDEO_ASPECT);
    let (width, height, aspect_ratio) = match (w_dim, h_dim) {
        // Both axes explicit: aspect only applies when the author
        // asked for it (Taffy ignores it with two definite sizes
        // anyway; keep the prop for min/max interactions).
        (Some(w), Some(h)) => (
            dim_to_dimension(w, scale),
            dim_to_dimension(h, scale),
            explicit_ar,
        ),
        // One axis: derive the other through the aspect chain.
        (Some(w), None) => (
            dim_to_dimension(w, scale),
            Dimension::auto(),
            Some(fallback_ar),
        ),
        // Height-only with a definite length: resolve the width here
        // rather than leaving it `auto` + aspect-ratio — inside a
        // Column the cross axis is width, and flex's default
        // `align-items: stretch` would win over the aspect ratio and
        // stretch the video to the full column width.
        (None, Some(Dim::Length(h))) => (
            Dimension::length(h * fallback_ar * scale),
            Dimension::length(h * scale),
            None,
        ),
        (None, Some(h)) => (
            Dimension::auto(),
            dim_to_dimension(h, scale),
            Some(fallback_ar),
        ),
        // Unconstrained: default width + aspect-derived height.
        (None, None) => (
            Dimension::length(size_fallback.unwrap_or(DEFAULT_VIDEO_WIDTH_PX) * scale),
            Dimension::auto(),
            Some(fallback_ar),
        ),
    };
    Style {
        display: Display::Flex,
        size: Size { width, height },
        aspect_ratio,
        // Match Image: don't let sibling flex children crush the
        // media box to zero when its width is percent-based.
        flex_shrink: 0.0,
        margin: margin_to_taffy(margin_with(node, vs), scale),
        border: border_to_taffy(border_with(node, vs), scale),
        ..Default::default()
    }
}

/// Base Taffy style for a Video v2 `Scrubber` leaf. Grows along the main
/// axis (its natural home is a `Row` in the `controls` slot, where it
/// should eat the space between the transport button and the time label)
/// with a thumb-height fixed cross axis. Explicit `width` / `height`
/// props override both, through the shared `apply_size_props` pass.
fn scrubber_style(node: &crate::tree::Node, vs: &VariantState, scale: f32) -> Style {
    let w_dim = prop_dim_with(node, "width", vs);
    let h_dim = prop_dim_with(node, "height", vs);
    let width = match w_dim {
        Some(d) => dim_to_dimension(d, scale),
        None => Dimension::auto(),
    };
    let height = match h_dim {
        Some(d) => dim_to_dimension(d, scale),
        None => Dimension::length(DEFAULT_SCRUBBER_HEIGHT_PX * scale),
    };
    Style {
        display: Display::Flex,
        size: Size { width, height },
        min_size: Size {
            width: length(DEFAULT_SCRUBBER_MIN_W_PX * scale),
            height: length(SCRUBBER_TRACK_PX * scale),
        },
        // Fill the free space of its flex line unless the author pinned
        // a width. `flex_basis: 0` so two Scrubbers in one Row split the
        // space evenly rather than by content size (they have none).
        flex_grow: if w_dim.is_some() { 0.0 } else { 1.0 },
        flex_shrink: 1.0,
        margin: margin_to_taffy(margin_with(node, vs), scale),
        border: border_to_taffy(border_with(node, vs), scale),
        ..Default::default()
    }
}

/// `Chart` layout: a leaf-like block. Height defaults to
/// [`crate::chart::defaults::HEIGHT`] (200 logical px) because a chart has
/// no intrinsic content height; width fills the parent, like a `div` in the
/// DOM renderer. Explicit `width` / `height` props override both through
/// the shared `apply_size_props` pass, and `flex_shrink: 0` keeps a chart
/// in a `Row` from collapsing to nothing when it declares a percentage
/// width.
fn chart_style(node: &crate::tree::Node, vs: &VariantState, scale: f32) -> Style {
    let width = match prop_dim_with(node, "width", vs) {
        Some(d) => dim_to_dimension(d, scale),
        None => Dimension::percent(1.0),
    };
    let height = match prop_dim_with(node, "height", vs) {
        Some(d) => dim_to_dimension(d, scale),
        None => Dimension::length(crate::chart::defaults::HEIGHT * scale),
    };
    Style {
        display: Display::Flex,
        size: Size { width, height },
        min_size: Size {
            width: Dimension::length(0.0),
            height: Dimension::length(0.0),
        },
        flex_shrink: 0.0,
        margin: margin_to_taffy(margin_with(node, vs), scale),
        border: border_to_taffy(border_with(node, vs), scale),
        ..Default::default()
    }
}

/// Video v2 slot layout: a `.slot(name)`-tagged child of a Video becomes
/// a full-bleed overlay of the player's box — `position: absolute` with
/// all four insets pinned to 0 and both axes auto, which Taffy resolves
/// by stretching the child edge to edge. Any margin the author set is
/// dropped: "full-bleed" is normative, and a stray `.margin(8)` inherited
/// from a shared style would otherwise inset the chrome asymmetrically.
///
/// Untagged children are invalid per the spec and collapse to
/// `display: none` — present in the tree (so patches and state survive),
/// contributing no geometry and emitting no item.
fn apply_slot_overlay_style(style: &mut Style, tagged: bool) {
    if !tagged {
        style.display = Display::None;
        return;
    }
    style.position = Position::Absolute;
    style.inset = Rect_ {
        top: LengthPercentageAuto::length(0.0),
        right: LengthPercentageAuto::length(0.0),
        bottom: LengthPercentageAuto::length(0.0),
        left: LengthPercentageAuto::length(0.0),
    };
    style.margin = Rect_ {
        top: LengthPercentageAuto::length(0.0),
        right: LengthPercentageAuto::length(0.0),
        bottom: LengthPercentageAuto::length(0.0),
        left: LengthPercentageAuto::length(0.0),
    };
    style.size = Size {
        width: Dimension::auto(),
        height: Dimension::auto(),
    };
}

fn dim_to_dimension(d: Dim, scale: f32) -> Dimension {
    match d {
        Dim::Length(v) => Dimension::length(v * scale),
        Dim::Percent(p) => Dimension::percent(p),
    }
}

/// Resolve a Video node's `poster` prop. Empty / whitespace strings
/// collapse to `None` (a record with no poster serialises to `""`).
pub(crate) fn resolve_media_poster(node: &crate::tree::Node, viewport: Viewport) -> Option<String> {
    crate::style::prop_str_at(node, "poster", viewport)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Resolve a Video node's current track: `(src, playlist index)`.
/// Follows the cross-platform contract (`hypen-docs/content/docs/guide/components.mdx`):
/// a non-empty `playlist` supersedes `src` / `source` / positional
/// `0`, starting at `startIndex` clamped to the valid range. `index`
/// is `0` for single-src playback.
pub(crate) fn resolve_media_src(
    node: &crate::tree::Node,
    viewport: Viewport,
) -> (Option<String>, u64) {
    let playlist = node
        .props
        .get("playlist")
        .or_else(|| node.props.get("playlist.0"))
        .and_then(|v| v.as_array());
    if let Some(arr) = playlist {
        if !arr.is_empty() {
            let start = prop_f32_at(node, "startIndex", viewport)
                .filter(|v| v.is_finite() && *v >= 0.0)
                .unwrap_or(0.0) as usize;
            let idx = start.min(arr.len() - 1);
            let src = arr
                .get(idx)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            return (src, idx as u64);
        }
    }
    let src = crate::style::prop_str_at(node, "src", viewport)
        .or_else(|| crate::style::prop_str_at(node, "source", viewport))
        .or_else(|| node.props.get("0").and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    (src, 0)
}

/// Click behaviour for a Video surface: when an `onPlay` action is
/// wired, a click dispatches it with the contract payload
/// `{ type: "play", src, index }` (plus any static named args from
/// the applicator). Returns `None` when no `onPlay` is wired — the
/// caller falls back to a generic `onClick` if one exists. Kept OFF
/// [`ACTIONABLE_TYPES`] deliberately: that set implies button layout
/// chrome (default padding) and Button a11y, neither of which fits a
/// media surface.
fn resolve_video_play_action(
    node: &crate::tree::Node,
    src: Option<&str>,
    index: u64,
) -> Option<(String, serde_json::Value)> {
    let (action, payload) = resolve_named_event_action(node, "onPlay")?;
    let mut obj = match payload {
        serde_json::Value::Object(o) => o,
        _ => serde_json::Map::new(),
    };
    obj.insert("type".to_string(), serde_json::Value::from("play"));
    obj.insert(
        "src".to_string(),
        match src {
            Some(s) => serde_json::Value::from(s),
            None => serde_json::Value::Null,
        },
    );
    obj.insert("index".to_string(), serde_json::Value::from(index));
    Some((action, serde_json::Value::Object(obj)))
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
    //
    // Only replace the *automatic* minimum, though. An authored
    // `min-h-[300px]` / `.minHeight(...)` (already written by
    // `apply_size_props`, which runs first) is a real CSS constraint a
    // scroll container honours — clobbering it to 0 let the Files
    // app's `flex-1 min-h-[300px] overflow-y-auto` contents pane
    // collapse to ~130px inside its content-sized window, so the Grid
    // overflowed it and the last row's labels were cut off under the
    // status/details rows below.
    if style.overflow.x == Overflow::Scroll && style.min_size.width.is_auto() {
        style.min_size.width = length(0.0);
    }
    if style.overflow.y == Overflow::Scroll && style.min_size.height.is_auto() {
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
    viewport: Viewport,
) -> NodeContext {
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
            line_height: resolved_line_height(node, font_size / scale, viewport) * scale,
            max_lines: resolve_max_lines(node, viewport),
            font_weight,
        }
    } else {
        NodeContext::default()
    }
}

/// Decoded natural size of an `Image`'s `src` (logical px), once loaded.
/// `Icon` / `Avatar` have no natural size here.
fn image_natural_size(node: &crate::tree::Node) -> Option<(f32, f32)> {
    if !node.element_type.eq_ignore_ascii_case("Image") {
        return None;
    }
    node.props
        .get("src")
        .or_else(|| node.props.get("0"))
        .and_then(|value| value.as_str())
        .and_then(crate::paint::image::loaded_natural_size)
        .filter(|(w, h)| *w > 0.0 && *h > 0.0)
}

/// Base Taffy style for an [`IMAGE_TYPES`] leaf, shared by the bulk
/// build and the incremental restyle. Sized by `width` / `height` (px
/// or %), with `.size(N)` as the square fallback (icons use this), then
/// the decoded natural size, then the component default. The aspect
/// ratio is the authored `aspectRatio`, else the natural one.
fn image_style(node: &crate::tree::Node, vs: &VariantState, scale: f32) -> Style {
    let et = node.element_type.as_str();
    let size_fallback = prop_f32_with(node, "size", vs);
    let w_dim = prop_dim_with(node, "width", vs);
    let h_dim = prop_dim_with(node, "height", vs);
    let natural_size = image_natural_size(node);
    let aspect_ratio = crate::style::prop_aspect_ratio_with(node, "aspectRatio", vs)
        .or_else(|| natural_size.map(|(w, h)| w / h));

    // When neither axis is set, fall back to .size or default.
    let component_default = if et.eq_ignore_ascii_case("Avatar") {
        40.0
    } else {
        DEFAULT_IMAGE_SIZE_PX
    };
    let default_len = size_fallback.unwrap_or(component_default);
    // Percent maps to Taffy's `Dimension::Percent` so an Image with
    // `.width("100%")` fills its parent column.
    let width = match w_dim {
        Some(Dim::Length(v)) => Dimension::length(v * scale),
        Some(Dim::Percent(p)) => Dimension::percent(p),
        None => Dimension::length(
            size_fallback
                .or(natural_size.map(|(w, _)| w))
                .unwrap_or(default_len)
                * scale,
        ),
    };
    let height = match h_dim {
        Some(Dim::Length(v)) => Dimension::length(v * scale),
        Some(Dim::Percent(p)) => Dimension::percent(p),
        None if w_dim.is_some() && aspect_ratio.is_some() => Dimension::auto(),
        None => Dimension::length(
            size_fallback
                .or(natural_size.map(|(_, h)| h))
                .unwrap_or(default_len)
                * scale,
        ),
    };
    // `flex_shrink: 0` keeps the image from being shrunk to 0 by
    // sibling flex children when its width is `Percent` — without this
    // an image with `.width("100%")` collapses to its content size (0)
    // inside a horizontal flex parent.
    Style {
        display: Display::Flex,
        size: Size { width, height },
        aspect_ratio,
        flex_shrink: 0.0,
        margin: margin_to_taffy(margin_with(node, vs), scale),
        border: border_to_taffy(border_with(node, vs), scale),
        ..Default::default()
    }
}

/// Tree-aware Text measurement context. A Text nested in semantic wrappers
/// such as Heading inherits typography from that wrapper; retained-tree
/// restyles must preserve the same metrics used by the initial bulk build.
fn node_context_in_tree(
    tree: &Tree,
    id: &str,
    node: &crate::tree::Node,
    scale: f32,
    viewport: Viewport,
) -> NodeContext {
    if node.element_type != "Text" {
        return NodeContext::default();
    }
    let font_size = inherited_text_font_size(tree, id, viewport) * scale;
    NodeContext {
        text: Some(
            node.text_content()
                .map(|content| content.into_owned())
                .unwrap_or_default(),
        ),
        font_size,
        line_height: resolved_line_height(node, font_size / scale, viewport) * scale,
        max_lines: resolve_max_lines(node, viewport),
        font_weight: inherited_text_font_weight(tree, id, viewport),
    }
}

/// Read `maxLines` (or `max-lines`, the CSS-property form emitted by
/// the `truncate` Tailwind utility) off a Text node. `Some(n)` means
/// the renderer should keep at most `n` rendered lines; `None` means
/// "wrap freely". Falls back to `None` when the value isn't a positive
/// integer.
///
/// Tailwind's `line-clamp-N` lowers to `-webkit-line-clamp: N` (the
/// engine camel-cases it to `WebkitLineClamp`), which the DOM renderer
/// honours natively. Read it — and the unprefixed `lineClamp` — as the
/// same cap so a `line-clamp-2` label measures and paints at most two
/// lines here too instead of growing its row to every wrapped line.
/// `line-clamp-none` (`none`) is not a number and so stays unclamped.
pub(crate) fn resolve_max_lines(node: &crate::tree::Node, viewport: Viewport) -> Option<u32> {
    let v = [
        "maxLines",
        "max-lines",
        "WebkitLineClamp",
        "-webkit-line-clamp",
        "lineClamp",
        "line-clamp",
    ]
    .iter()
    .find_map(|name| prop_f32_at(node, name, viewport))?;
    if v >= 1.0 {
        Some(v as u32)
    } else {
        None
    }
}

fn resolve_box_shadow(node: &crate::tree::Node) -> Option<BoxShadow> {
    let object = node
        .props
        .get("shadow.0")
        .or_else(|| node.props.get("shadow"))?
        .as_object()?;
    let number = |name: &str| {
        object.get(name).and_then(|value| {
            value
                .as_f64()
                .map(|v| v as f32)
                .or_else(|| value.as_str().and_then(|v| v.parse::<f32>().ok()))
        })
    };
    Some(BoxShadow {
        x: number("x").unwrap_or(0.0),
        y: number("y").unwrap_or(0.0),
        blur: number("blur").unwrap_or(0.0).max(0.0),
        spread: number("spread").unwrap_or(0.0),
        color: object
            .get("color")
            .and_then(|value| value.as_str())
            .and_then(crate::style::parse_color)
            .unwrap_or(Rgba(0, 0, 0, 64)),
    })
}

fn resolved_line_height(node: &crate::tree::Node, font_size: f32, viewport: Viewport) -> f32 {
    match prop_f32_at(node, "lineHeight", viewport)
        .or_else(|| prop_f32_at(node, "line-height", viewport))
    {
        Some(value) if value <= 4.0 => (font_size * value).max(font_size),
        Some(value) => value.max(font_size),
        None => font_size,
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
fn make_stack_overlay_absolute(s: &mut Style, center_in_parent: bool) {
    s.position = Position::Absolute;
    let m = s.margin;
    // `node_style_with` has already lowered authored `top/right/bottom/left`
    // props into `inset`.  Preserve those values: Stack's parent-aware pass
    // should only synthesize an anchor for an otherwise-unpositioned overlay.
    // Overwriting the authored inset here pinned e.g. Food's bottom cart CTA
    // to the top-left even though it declared `left/right/bottom`.
    let has_authored_inset = s.inset.top != LengthPercentageAuto::auto()
        || s.inset.right != LengthPercentageAuto::auto()
        || s.inset.bottom != LengthPercentageAuto::auto()
        || s.inset.left != LengthPercentageAuto::auto();
    if has_authored_inset {
        // CSS keeps margins separate from absolute insets.  Nothing else to
        // synthesize in this branch.
        return;
    }
    if center_in_parent
        && m.top == LengthPercentageAuto::length(0.0)
        && m.left == LengthPercentageAuto::length(0.0)
    {
        s.inset = Rect_ {
            top: LengthPercentageAuto::auto(),
            right: LengthPercentageAuto::auto(),
            bottom: LengthPercentageAuto::auto(),
            left: LengthPercentageAuto::auto(),
        };
        s.align_self = Some(AlignSelf::Center);
        s.justify_self = Some(AlignSelf::Center);
    } else {
        s.inset = Rect_ {
            top: length_or_zero_lpa(m.top),
            right: LengthPercentageAuto::auto(),
            bottom: LengthPercentageAuto::auto(),
            left: length_or_zero_lpa(m.left),
        };
    }
    s.margin = Rect_ {
        top: LengthPercentageAuto::length(0.0),
        right: LengthPercentageAuto::length(0.0),
        bottom: LengthPercentageAuto::length(0.0),
        left: LengthPercentageAuto::length(0.0),
    };
}

/// A growing Stack (`flex-1` / `grow`) drops its automatic minimum size
/// — `min-width: 0; min-height: 0`, exactly what the DOM renderer's
/// Stack stylesheet sets (`hypen-web/packages/web/src/dom/components/stack.ts`).
///
/// Without it the Stack's `min-height: auto` resolves to its content's
/// min-content height, and a `w-full h-full` photo's min-content height
/// is its natural, aspect-derived height (Taffy treats the percentage
/// as `auto` while it can't resolve). The Hypengram story viewer's
/// `Stack { Image.tw("w-full h-full") … }.tw("flex-1")` therefore
/// refused to flex below 800 × 1920/1080 = 1422px inside a 700px
/// column: the photo rendered hugely zoomed with a scrollbar instead
/// of filling the viewport. With the minimum dropped the Stack flexes
/// to the slot, its post-flex height is definite, and the photo's
/// `h-full` resolves against it.
///
/// Scoped to growing Stacks: a content-sized Stack keeps `auto` so it
/// is never squashed below its content (an avatar-with-badge in a Row,
/// a card in an overflowing Column). An authored `min-w-*` / `min-h-*`
/// (already applied by `apply_size_props`) wins.
fn apply_stack_fill_min_size(style: &mut Style) {
    if style.flex_grow <= 0.0 {
        return;
    }
    if style.min_size.width.is_auto() {
        style.min_size.width = length(0.0);
    }
    if style.min_size.height.is_auto() {
        style.min_size.height = length(0.0);
    }
}

fn apply_grid_image_stretch(node: &crate::tree::Node, style: &mut Style) {
    if !IMAGE_TYPES
        .iter()
        .any(|kind| kind.eq_ignore_ascii_case(&node.element_type))
    {
        return;
    }

    // Any authored axis or square size wins. Check base and flattened
    // applicator keys; responsive values are still authored intent and are
    // resolved by `node_style_with` before this parent-aware adjustment.
    let declares_size = node.props.keys().any(|key| {
        let base = key
            .split('@')
            .next()
            .unwrap_or(key)
            .split('.')
            .next()
            .unwrap_or(key)
            .to_ascii_lowercase();
        matches!(base.as_str(), "width" | "height" | "size")
    });
    if declares_size {
        return;
    }

    style.size.width = Dimension::percent(1.0);
    style.size.height = Dimension::auto();
    style.aspect_ratio = Some(1.0);
    style.min_size.width = Dimension::length(0.0);
    style.justify_self = Some(AlignSelf::Stretch);
    style.align_self = Some(AlignSelf::Stretch);
}

fn apply_row_width_demand(
    node: &crate::tree::Node,
    style: &mut Style,
    taffy: &TaffyTree<NodeContext>,
    children: &[NodeId],
) {
    let explicitly_sized_or_aligned = node.props.keys().any(|key| {
        let base = key
            .split('@')
            .next()
            .unwrap_or(key)
            .split('.')
            .next()
            .unwrap_or(key)
            .to_ascii_lowercase();
        matches!(
            base.as_str(),
            "width" | "fillmaxwidth" | "fillmaxsize" | "alignself"
        )
    });
    if explicitly_sized_or_aligned {
        return;
    }

    let distributes_free_space = matches!(
        style.justify_content,
        Some(
            JustifyContent::Center
                | JustifyContent::End
                | JustifyContent::SpaceBetween
                | JustifyContent::SpaceAround
                | JustifyContent::SpaceEvenly
                | JustifyContent::Stretch
        )
    );
    let percent_tag = Dimension::percent(0.0).tag();
    let child_demands_finite_width = children.iter().any(|child| {
        taffy.style(*child).is_ok_and(|child_style| {
            child_style.flex_grow > 0.0 || child_style.size.width.tag() == percent_tag
        })
    });
    style.align_self = Some(if distributes_free_space || child_demands_finite_width {
        AlignSelf::Stretch
    } else {
        AlignSelf::Start
    });
}

/// Read `width` / `height` props (px or %) and apply to the Style's
/// `size`. Touches every container kind so explicit sizing on
/// generic Columns / Rows / Containers behaves like every other
/// renderer instead of always falling through to content size.
fn apply_size_props(style: &mut Style, node: &crate::tree::Node, vs: &VariantState, scale: f32) {
    // Fill applicators are relative to the parent's finite content box.
    // Apply them before explicit size/width/height so a definite dimension
    // wins when both are present. This also lets the app root inherit the
    // synthetic viewport wrapper instead of stopping at max-content height.
    if let Some(fraction) = prop_fill_fraction_with(node, "fillMaxSize", vs) {
        style.size.width = Dimension::percent(fraction);
        style.size.height = Dimension::percent(fraction);
        style.min_size.width = Dimension::length(0.0);
        style.align_self = Some(AlignSelf::Stretch);
    }
    if let Some(fraction) = prop_fill_fraction_with(node, "fillMaxWidth", vs) {
        style.size.width = Dimension::percent(fraction);
        style.min_size.width = Dimension::length(0.0);
        if (fraction - 1.0).abs() < f32::EPSILON {
            style.align_self = Some(AlignSelf::Stretch);
        }
    }
    if let Some(fraction) = prop_fill_fraction_with(node, "fillMaxHeight", vs) {
        style.size.height = Dimension::percent(fraction);
    }
    if let Some(size) = prop_dim_with(node, "size", vs) {
        let dimension = match size {
            Dim::Length(v) => Dimension::length(v * scale),
            Dim::Percent(p) => Dimension::percent(p),
        };
        style.size.width = dimension;
        style.size.height = dimension;
    }
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
    // `.aspectRatio(r)` on any element (Image/Video set theirs in
    // `media_style`): with one definite axis, Taffy derives the other —
    // a `w-full` square preview gets its height from its width.
    if style.aspect_ratio.is_none() {
        if let Some(r) = crate::style::prop_aspect_ratio_with(node, "aspectRatio", vs).filter(|r| r.is_finite() && *r > 0.0) {
            style.aspect_ratio = Some(r);
        }
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

/// Divider is a greedy, one-pixel horizontal rule unless explicitly sized.
/// Treating it as an ordinary empty Column made its auto size 0×0 on Desktop,
/// so both the raw rule and authored background-colour rules disappeared.
fn apply_divider_defaults(
    style: &mut Style,
    node: &crate::tree::Node,
    vs: &VariantState,
    scale: f32,
) {
    if !node.element_type.eq_ignore_ascii_case("Divider")
        && !node.element_type.eq_ignore_ascii_case("Separator")
    {
        return;
    }
    if prop_dim_with(node, "width", vs).is_none() {
        style.size.width = Dimension::percent(1.0);
        style.align_self = Some(AlignSelf::Stretch);
    }
    if prop_dim_with(node, "height", vs).is_none() {
        let thickness = prop_f32_with(node, "thickness", vs).unwrap_or(1.0);
        style.size.height = Dimension::length(thickness.max(0.0) * scale);
    }
    style.flex_shrink = 0.0;
}

/// Whether the author explicitly set a corner radius. Card's DOM component
/// has an 8px default, but `.cornerRadius(0)` must still be able to opt out.
fn declares_corner_radius(node: &crate::tree::Node) -> bool {
    const KEYS: &[&str] = &[
        "border.radius",
        "borderRadius",
        "borderRadius.0",
        "border-radius",
        "cornerRadius",
        "cornerRadius.0",
    ];
    KEYS.iter().any(|key| node.props.contains_key(*key))
        || node
            .props
            .get("border.0")
            .or_else(|| node.props.get("border"))
            .and_then(|value| value.as_object())
            .is_some_and(|object| object.contains_key("radius"))
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
    if let Some(alignment) = prop_str_at(node, "alignment", viewport) {
        let normalized = alignment.trim().to_ascii_lowercase();
        if normalized == "center" {
            style.align_items = Some(AlignItems::Center);
            style.justify_content = Some(JustifyContent::Center);
        }
    }
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
    // CSS text-align is inherited. For a vertical container, positioning the
    // child text boxes on the cross axis gives intrinsic Text children the
    // same visible left/center/right placement as DOM inline content.
    if column {
        if let Some(s) = prop_str_at(node, "textAlign", viewport) {
            match s.trim().to_ascii_lowercase().as_str() {
                "center" => style.align_items = Some(AlignItems::Center),
                "right" | "end" => style.align_items = Some(AlignItems::End),
                "left" | "start" | "justify" => style.align_items = Some(AlignItems::Start),
                _ => {}
            }
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
        // Hypen applicators use camelCase values while Tailwind/CSS emits
        // kebab-case. Lower-casing `spaceBetween` produces `spacebetween`,
        // so accept both protocol spellings here.
        "space-between" | "spacebetween" => Some(JustifyContent::SpaceBetween),
        "space-around" | "spacearound" => Some(JustifyContent::SpaceAround),
        "space-evenly" | "spaceevenly" => Some(JustifyContent::SpaceEvenly),
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
    // Hypen's platform-neutral alias for flex weight.
    if let Some(num) = prop_f32_with(node, "weight", vs) {
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
    let side = |bit: u8| length(border_side_px(b, bit, scale));
    Rect_ {
        left: side(crate::style::BORDER_SIDE_LEFT),
        right: side(crate::style::BORDER_SIDE_RIGHT),
        top: side(crate::style::BORDER_SIDE_TOP),
        bottom: side(crate::style::BORDER_SIDE_BOTTOM),
    }
}

/// Layout width (physical px) of one border side. A directional border
/// (`border-t`, `border-b`) only occupies the sides it draws — inflating
/// all four by the stroke width pushed content 1px in from the
/// undrawn edges too.
fn border_side_px(b: Border, side_bit: u8, scale: f32) -> f32 {
    if b.is_visible() && b.sides & side_bit != 0 {
        b.width * scale
    } else {
        0.0
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
    // Rounded outline belonging to `parent_clip_to`, already scaled to
    // physical pixels. Zero keeps the common rectangular clip fast path.
    parent_clip_radius: f32,
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

    // Viewport cull. When `cull_viewport` is `Some`, subtrees fully
    // outside the visible region plus [`CULL_BUFFER_VH`] of slack on
    // each side are skipped wholesale (no LayoutItem emit, no
    // recursion). The synthetic outer wrapper has no renderer node —
    // never cull it, otherwise the entire tree disappears for any
    // page taller than the viewport.
    let renderer_id = renderer_for_taffy.get(&node_id).cloned();
    if let (Some(v), Some(_)) = (cull_viewport, renderer_id.as_deref()) {
        let buffer = v.h * CULL_BUFFER_VH;
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
    // Set when THIS node is a `Chart`: the resolved scene, so the child
    // walk below can pin each visible `Marker` to its data point (and
    // skip the ones the chart hid).
    let mut chart_scene: Option<std::sync::Arc<crate::chart::ChartScene>> = None;
    // Clip rect handed down to children. Inherits `parent_clip_to`
    // by default; replaced with this node's own rect when the node
    // is itself scrollable, so descendants clip to *this* container.
    // The container's own row (bg / border) keeps `parent_clip_to`
    // — only its scrolling content gets clipped.
    let mut child_clip_to = parent_clip_to;
    let mut child_clip_radius = parent_clip_radius;

    if let Some(rid) = renderer_id.as_deref() {
        if let Some(node) = tree.get(rid) {
            let action = resolve_action(node);
            let action_payload = action.as_ref().and_then(|_| resolve_action_payload(node));
            // Renderer-local `.videoIntent(...)`: resolved once per node
            // (the enclosing-Video walk is what makes it inert outside a
            // player), then copied into whichever item kind we push.
            let video_intent = crate::video_v2::intent_for(tree, rid);
            let hover_action = resolve_hover_action(node);
            let hover_payload = hover_action
                .as_ref()
                .and_then(|_| resolve_hover_payload(node));
            let mut item_border = border_at(node, viewport);
            let is_badge = node.element_type.eq_ignore_ascii_case("Badge");
            let is_divider = node.element_type.eq_ignore_ascii_case("Divider")
                || node.element_type.eq_ignore_ascii_case("Separator");
            if is_badge && !declares_corner_radius(node) {
                item_border.radius = 4.0;
            }
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
            let shadow = resolve_box_shadow(node);
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
            // Layered `background` shorthand / radial gradients — the
            // stacks the two single-layer reads above can't express.
            let background_layers = crate::style::prop_background_layers(node);
            // Paint-time state-variant colour overrides (hover/focus/
            // active/disabled). Resolved once here for every item kind;
            // empty for the common plain-styled node so the painter's
            // fast path is undisturbed.
            let item_state_variants = crate::style::state_variants(node, viewport);
            let scrollable = is_scrollable_node(node, viewport);
            let scroll_off = scrolls.get(rid).copied().unwrap_or(0.0);
            if scrollable {
                child_scroll_shift_y = parent_scroll_shift_y + scroll_off;
            }
            if scrollable || clips_overflow_node(node, viewport) {
                // A LayoutItem carries one painter clip, so nested CSS clips
                // must be collapsed to their intersection. Replacing the
                // outer app-frame clip with an embedded app's own scroller
                // let Social/Home content paint over the launcher's header.
                // When one rectangle wholly owns the intersection we retain
                // its rounded outline; a partial overlap falls back to the
                // exact rectangular intersection because one rounded rect
                // cannot encode two independently clipped corner sets.
                let own_radius = item_border.radius * scale;
                match child_clip_to {
                    None => {
                        child_clip_to = Some(rect);
                        child_clip_radius = own_radius;
                    }
                    Some(parent_clip) => {
                        let (intersection, radius) =
                            intersect_clip_rects(parent_clip, child_clip_radius, rect, own_radius);
                        child_clip_to = Some(intersection);
                        child_clip_radius = radius;
                    }
                }
            }
            match node.element_type.as_str() {
                et if CONTROL_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
                    let bool_prop = |name: &str| {
                        node.props
                            .get(name)
                            .and_then(|value| {
                                value
                                    .as_bool()
                                    .or_else(|| value.as_str().map(|s| s == "true"))
                            })
                            .unwrap_or(false)
                    };
                    let number_prop = |name: &str, fallback: f32| {
                        node.props
                            .get(name)
                            .and_then(|value| {
                                value
                                    .as_f64()
                                    .map(|v| v as f32)
                                    .or_else(|| value.as_str().and_then(|s| s.parse::<f32>().ok()))
                            })
                            .unwrap_or(fallback)
                    };
                    let kind = if et.eq_ignore_ascii_case("Audio") {
                        ItemKind::Audio {
                            controls: node
                                .props
                                .get("controls")
                                .and_then(|value| value.as_bool())
                                .unwrap_or(true),
                        }
                    } else if et.eq_ignore_ascii_case("Checkbox") {
                        ItemKind::Checkbox {
                            checked: bool_prop("checked"),
                        }
                    } else if et.eq_ignore_ascii_case("Switch") {
                        ItemKind::Switch {
                            checked: bool_prop("checked"),
                        }
                    } else if et.eq_ignore_ascii_case("Slider") {
                        let min = number_prop("min", 0.0);
                        let max = number_prop("max", 100.0);
                        let value = number_prop("value", min);
                        let fraction = if max > min {
                            (value - min) / (max - min)
                        } else {
                            0.0
                        };
                        ItemKind::Slider {
                            fraction: fraction.clamp(0.0, 1.0),
                            disabled: bool_prop("disabled"),
                        }
                    } else if et.eq_ignore_ascii_case("Progress")
                        || et.eq_ignore_ascii_case("ProgressBar")
                    {
                        ItemKind::ProgressBar {
                            fraction: (number_prop("value", 0.0) / 100.0).clamp(0.0, 1.0),
                        }
                    } else if et.eq_ignore_ascii_case("Select") {
                        let first_option = tree.children_of(rid).iter().find_map(|child_id| {
                            tree.get(child_id)?
                                .text_content()
                                .map(|text| text.into_owned())
                        });
                        ItemKind::Select {
                            value: node
                                .props
                                .get("value")
                                .and_then(|v| v.as_str())
                                .map(str::to_string)
                                .or(first_option)
                                .unwrap_or_default(),
                            placeholder: node
                                .props
                                .get("placeholder")
                                .and_then(|v| v.as_str())
                                .unwrap_or("Select...")
                                .to_string(),
                        }
                    } else {
                        ItemKind::Spinner {
                            color: prop_color_at(node, "color", viewport)
                                .unwrap_or(Rgba(0x3b, 0x82, 0xf6, 0xff)),
                        }
                    };
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind,
                        rect,
                        action,
                        action_payload: action_payload.clone(),
                        hover_action: hover_action.clone(),
                        hover_payload: hover_payload.clone(),
                        video_intent,
                        background: background_explicit,
                        hover,
                        shadow,
                        border: item_border,
                        scrollable: None,
                        font_weight: 400,
                        clip_to: parent_clip_to,
                        clip_radius: parent_clip_radius,
                        subtree_root: subtree_root.map(str::to_string),
                        background_gradient: background_gradient.clone(),
                        background_layers: background_layers.clone(),
                        background_image: background_image.clone(),
                        state_variants: item_state_variants.clone(),
                        opacity: 1.0,
                        transform: Affine2::IDENTITY,
                    });
                }
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
                    let pad = padding_at(node, viewport);
                    let multiline = is_multiline_text_input(et);
                    let line_height = if multiline {
                        textarea_line_height(prop_f32_at(node, "lineHeight", viewport), font_size)
                    } else {
                        font_size
                    };
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind: ItemKind::Input {
                            value,
                            placeholder,
                            bind_path,
                            font_size,
                            line_height,
                            multiline,
                            color,
                            padding: (
                                pad.left * scale,
                                pad.top * scale,
                                pad.right * scale,
                                pad.bottom * scale,
                            ),
                        },
                        rect,
                        action: None,
                        action_payload: None,
                        hover_action: hover_action.clone(),
                        hover_payload: hover_payload.clone(),
                        video_intent,
                        background: background_explicit,
                        hover,
                        shadow,
                        border: item_border,
                        scrollable: None,
                        font_weight,
                        clip_to: parent_clip_to,
                        clip_radius: parent_clip_radius,
                        subtree_root: subtree_root.map(str::to_string),
                        background_gradient: background_gradient.clone(),
                        background_layers: background_layers.clone(),
                        background_image: background_image.clone(),
                        state_variants: item_state_variants.clone(),
                        opacity: 1.0,
                        transform: Affine2::IDENTITY,
                    });
                }
                "Text" => {
                    let font_size = inherited_text_font_size(tree, rid, viewport);
                    let line_height = resolved_line_height(node, font_size, viewport);
                    let font_weight = inherited_text_font_weight(tree, rid, viewport);
                    let color = inherited_text_color(tree, rid, viewport);
                    let content = node
                        .text_content()
                        .map(|c| c.into_owned())
                        .unwrap_or_default();
                    let align = inherited_text_align(tree, rid, viewport);
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
                            line_height,
                            color,
                            align,
                            max_lines,
                            padding: padding_phys,
                            line_through: has_line_through(node, viewport),
                        },
                        rect,
                        action,
                        action_payload: action_payload.clone(),
                        hover_action: hover_action.clone(),
                        hover_payload: hover_payload.clone(),
                        video_intent,
                        background: background_explicit,
                        hover,
                        shadow,
                        border: item_border,
                        scrollable: None,
                        font_weight,
                        clip_to: parent_clip_to,
                        clip_radius: parent_clip_radius,
                        subtree_root: subtree_root.map(str::to_string),
                        background_gradient: background_gradient.clone(),
                        background_layers: background_layers.clone(),
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
                            video_intent,
                            background: background_explicit,
                            hover,
                            shadow,
                            border: item_border,
                            scrollable: None,
                            font_weight: 400,
                            clip_to: parent_clip_to,
                            clip_radius: parent_clip_radius,
                            subtree_root: subtree_root.map(str::to_string),
                            background_gradient: background_gradient.clone(),
                            background_layers: background_layers.clone(),
                            background_image: background_image.clone(),
                            state_variants: item_state_variants.clone(),
                            opacity: 1.0,
                            transform: Affine2::IDENTITY,
                        });
                    } else {
                        if et.eq_ignore_ascii_case("Avatar") && !declares_corner_radius(node) {
                            item_border.radius = rect.w.min(rect.h) * 0.5 / scale;
                        }
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
                            video_intent,
                            background: background_explicit,
                            hover,
                            shadow,
                            border: item_border,
                            scrollable: None,
                            font_weight: 400,
                            clip_to: parent_clip_to,
                            clip_radius: parent_clip_radius,
                            subtree_root: subtree_root.map(str::to_string),
                            background_gradient: background_gradient.clone(),
                            background_layers: background_layers.clone(),
                            background_image: background_image.clone(),
                            state_variants: item_state_variants.clone(),
                            opacity: 1.0,
                            transform: Affine2::IDENTITY,
                        });
                    }
                }
                et if crate::chart::is_chart_type(et) => {
                    // The chart resolves its own domains, insets and mark
                    // geometry against the box Taffy gave it. One item
                    // carries the whole draw list; each INTERACTIVE mark
                    // gets an item of its own so it can be hit-tested,
                    // focused and dispatched through the ordinary paths.
                    // Decorative marks emit nothing and are therefore
                    // transparent to the pointer.
                    let scene = std::sync::Arc::new(crate::chart::build_scene(
                        tree, rid, rect, viewport, scale,
                    ));
                    chart_scene = Some(std::sync::Arc::clone(&scene));
                    let marks: Vec<std::sync::Arc<crate::chart::ResolvedMark>> = scene
                        .marks
                        .iter()
                        .cloned()
                        .map(std::sync::Arc::new)
                        .collect();
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind: ItemKind::Chart(scene),
                        rect,
                        action,
                        action_payload: action_payload.clone(),
                        hover_action: hover_action.clone(),
                        hover_payload: hover_payload.clone(),
                        video_intent,
                        background: background_explicit,
                        hover,
                        shadow,
                        border: item_border,
                        scrollable: None,
                        font_weight: 400,
                        clip_to: parent_clip_to,
                        clip_radius: parent_clip_radius,
                        subtree_root: subtree_root.map(str::to_string),
                        background_gradient: background_gradient.clone(),
                        background_layers: background_layers.clone(),
                        background_image: background_image.clone(),
                        state_variants: item_state_variants.clone(),
                        opacity: 1.0,
                        transform: Affine2::IDENTITY,
                    });
                    for mark in marks {
                        // The item's rect is the mark's own hit bounds so
                        // damage and a11y bounds stay tight; the precise
                        // geometry test lives in `hit_geometry`.
                        let Some(mark_rect) = mark.hit_bounds() else {
                            continue;
                        };
                        let (click_action, click_payload) = match mark.events.click.clone() {
                            Some((name, payload)) => (Some(name), Some(payload)),
                            None => (None, None),
                        };
                        let (mark_hover, mark_hover_payload) = match mark.events.hover.clone() {
                            Some((name, payload)) => (Some(name), Some(payload)),
                            None => (None, None),
                        };
                        out.push(LayoutItem {
                            node_id: mark.node_id.clone(),
                            kind: ItemKind::ChartMark(mark),
                            rect: mark_rect,
                            action: click_action,
                            action_payload: click_payload,
                            hover_action: mark_hover,
                            hover_payload: mark_hover_payload,
                            video_intent: None,
                            background: None,
                            hover: HoverStyle::default(),
                            shadow: None,
                            border: Border::default(),
                            scrollable: None,
                            font_weight: 400,
                            clip_to: parent_clip_to,
                            clip_radius: parent_clip_radius,
                            subtree_root: subtree_root.map(str::to_string),
                            background_gradient: None,
                            background_layers: None,
                            background_image: None,
                            state_variants: crate::style::StateVariants::default(),
                            opacity: 1.0,
                            transform: Affine2::IDENTITY,
                        });
                    }
                }
                et if SCRUBBER_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
                    // Wired to the enclosing player renderer-side: no
                    // module round trip for the thumb, and none for the
                    // drag either (only the release commits).
                    let video_id = crate::video_v2::enclosing_video(tree, rid);
                    let preview = crate::video_v2::scrub_preview(node);
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind: ItemKind::Scrubber { video_id, preview },
                        rect,
                        // Scrubbers dispatch through their own commit
                        // path (bind write / `onSeek`), never the
                        // generic click action — a tap that lands on the
                        // track is a seek, not an activation.
                        action: None,
                        action_payload: None,
                        hover_action: hover_action.clone(),
                        hover_payload: hover_payload.clone(),
                        video_intent,
                        background: background_explicit,
                        hover,
                        shadow,
                        border: item_border,
                        scrollable: None,
                        font_weight: 400,
                        clip_to: parent_clip_to,
                        clip_radius: parent_clip_radius,
                        subtree_root: subtree_root.map(str::to_string),
                        background_gradient: background_gradient.clone(),
                        background_layers: background_layers.clone(),
                        background_image: background_image.clone(),
                        state_variants: item_state_variants.clone(),
                        opacity: 1.0,
                        transform: Affine2::IDENTITY,
                    });
                }
                et if MEDIA_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
                    let poster = resolve_media_poster(node, viewport);
                    let (src, index) = resolve_media_src(node, viewport);
                    let state = crate::video_v2::player_state(node, viewport);
                    let slots = crate::video_v2::slot_presence(tree, rid);
                    // Click routing: an explicit `.onClick(...)` (already
                    // resolved into `action` above, allowed on any
                    // element) wins; otherwise a wired `onPlay` makes
                    // the surface clickable with the contract payload
                    // `{ type: "play", src, index }`. Deliberately NOT
                    // via ACTIONABLE_TYPES — that set implies Button
                    // layout chrome and button-ish semantics.
                    let (action, action_payload) = if action.is_some() {
                        (action, action_payload.clone())
                    } else if let Some((play, payload)) =
                        resolve_video_play_action(node, src.as_deref(), index)
                    {
                        (Some(play), Some(payload))
                    } else {
                        (None, None)
                    };
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind: ItemKind::Video {
                            poster,
                            src,
                            state,
                            slots,
                        },
                        rect,
                        action,
                        action_payload,
                        hover_action: hover_action.clone(),
                        hover_payload: hover_payload.clone(),
                        video_intent,
                        background: background_explicit,
                        hover,
                        shadow,
                        border: item_border,
                        scrollable: None,
                        font_weight: 400,
                        clip_to: parent_clip_to,
                        clip_radius: parent_clip_radius,
                        subtree_root: subtree_root.map(str::to_string),
                        background_gradient: background_gradient.clone(),
                        background_layers: background_layers.clone(),
                        background_image: background_image.clone(),
                        state_variants: item_state_variants.clone(),
                        opacity: 1.0,
                        transform: Affine2::IDENTITY,
                    });
                }
                et if ACTIONABLE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(et)) => {
                    // No implicit Button chrome — ghost/icon controls
                    // (e.g. Story close ✕) only paint what the DSL sets.
                    let is_card = et.eq_ignore_ascii_case("Card");
                    if is_card && !declares_corner_radius(node) {
                        item_border.radius = 8.0;
                    }
                    out.push(LayoutItem {
                        node_id: rid.to_string(),
                        kind: if is_card {
                            ItemKind::Card
                        } else {
                            ItemKind::Button
                        },
                        rect,
                        action,
                        action_payload: action_payload.clone(),
                        hover_action: hover_action.clone(),
                        hover_payload: hover_payload.clone(),
                        video_intent,
                        background: background_explicit
                            .or_else(|| is_card.then_some(Rgba(0xff, 0xff, 0xff, 0xff))),
                        hover,
                        shadow,
                        border: item_border,
                        scrollable: None,
                        font_weight: 400,
                        clip_to: parent_clip_to,
                        clip_radius: parent_clip_radius,
                        subtree_root: subtree_root.map(str::to_string),
                        background_gradient: background_gradient.clone(),
                        background_layers: background_layers.clone(),
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
                        video_intent,
                        background: background_explicit.or_else(|| {
                            if is_badge || is_divider {
                                Some(Rgba(0xe0, 0xe0, 0xe0, 0xff))
                            } else {
                                None
                            }
                        }),
                        hover,
                        shadow,
                        border: item_border,
                        // Filled in after children walk. content_h
                        // placeholder of 0.0 means "not scrollable yet"
                        // — only the Container branch ever back-fills.
                        scrollable: if scrollable {
                            Some(ScrollMeta {
                                content_h: 0.0,
                                baked_offset: scroll_off,
                                emitted_offset: scroll_off,
                            })
                        } else {
                            None
                        },
                        font_weight: 400,
                        clip_to: parent_clip_to,
                        clip_radius: parent_clip_radius,
                        subtree_root: subtree_root.map(str::to_string),
                        background_gradient: background_gradient.clone(),
                        background_layers: background_layers.clone(),
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
    // Video v2 slot visibility: when THIS node is a Video, its children
    // are composition slots and the normative table
    // (`video_v2::slot_visible`) decides which of them are emitted at
    // all this frame. Not emitting is exactly show/hide, not
    // mount/unmount: the nodes stay in the renderer tree (patches,
    // reconciliation, per-node renderer state all survive) — only their
    // painting, hit-testing and a11y publication pause. Untagged
    // children are invalid per the spec and never emit.
    let video_slot_state: Option<crate::video_v2::VideoPlayerState> =
        renderer_id.as_deref().and_then(|rid| {
            let node = tree.get(rid)?;
            MEDIA_TYPES
                .iter()
                .any(|t| t.eq_ignore_ascii_case(&node.element_type))
                .then(|| crate::video_v2::player_state(node, viewport))
        });
    // Paint flow children before absolutely-positioned overlays so an
    // in-flow sibling (e.g. Story's full-bleed Image) doesn't cover a
    // header declared earlier in the tree. Matches the canvas renderer
    // and CSS stacking: absolute overlays land on top of in-flow content.
    let children = if renderer_id
        .as_deref()
        .and_then(|rid| tree.get(rid))
        .is_some_and(|node| node.element_type.eq_ignore_ascii_case("Select"))
    {
        Vec::new()
    } else {
        taffy.children(node_id).unwrap_or_default()
    };
    let children: Vec<NodeId> = match video_slot_state {
        None => children,
        Some(state) => {
            // Visible slots only, stacked in the normative paint order
            // (`poster → loading → controls → error`, bottom-to-top)
            // rather than declaration order — co-visible pairs
            // (poster+loading in `loading`, poster+controls in
            // `idle`/`ended`) must stack the same way in every app. The
            // sort is stable, so several children tagged with the same
            // slot keep their declaration order among themselves.
            let mut slotted: Vec<(u8, NodeId)> = children
                .into_iter()
                .filter_map(|c| {
                    let slot = renderer_for_taffy
                        .get(&c)
                        .and_then(|rid| tree.get(rid))
                        .and_then(crate::video_v2::node_slot)?;
                    crate::video_v2::slot_visible(slot, state)
                        .then_some((crate::video_v2::slot_paint_rank(slot), c))
                })
                .collect();
            slotted.sort_by_key(|(rank, _)| *rank);
            slotted.into_iter().map(|(_, c)| c).collect()
        }
    };
    let is_stack = renderer_id
        .as_deref()
        .and_then(|rid| tree.get(rid))
        .is_some_and(|node| node.element_type.eq_ignore_ascii_case("Stack"));
    let mut children = children;
    if is_stack {
        children.sort_by(|a, b| {
            let z = |child: &NodeId| {
                renderer_for_taffy
                    .get(child)
                    .and_then(|rid| tree.get(rid))
                    .and_then(|node| prop_f32_at(node, "zIndex", viewport))
                    .unwrap_or(0.0)
            };
            z(a).partial_cmp(&z(b)).unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    let stack_paint_children = is_stack.then(|| children.clone());
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
    let paint_children: Vec<NodeId> = if let Some(sorted) = stack_paint_children {
        sorted
    } else {
        flow_children.into_iter().chain(overlay_children).collect()
    };
    for child in paint_children {
        let child_is_absolute = taffy
            .style(child)
            .map(|style| style.position == Position::Absolute)
            .unwrap_or(false);
        // Taffy's absolute inset is resolved from the Stack's border edge,
        // while CSS Grid/ZStack/Compose position overlays in the parent's
        // padded content box. Add that content-box origin only for Stack
        // overlays; normal flow children already include it in their Taffy
        // location.
        let child_parent_x = if is_stack && child_is_absolute {
            x + layout.padding.left
        } else {
            x
        };
        let child_parent_y = if is_stack && child_is_absolute {
            y_natural + layout.padding.top
        } else {
            y_natural
        };
        // Chart `Marker`: Taffy content-sized the box, the chart says where
        // it belongs. Re-origin the child so its rect lands on the data
        // point offset by the anchor rule — and skip it entirely when the
        // chart placed no marker for it (both coordinates missing, e.g. a
        // tooltip bound to a null hover), which is exactly "hidden".
        let (child_parent_x, child_parent_y) = match chart_scene.as_deref() {
            None => (child_parent_x, child_parent_y),
            Some(scene) => {
                let Some(place) = renderer_for_taffy
                    .get(&child)
                    .and_then(|child_rid| scene.marker(child_rid))
                else {
                    continue;
                };
                let Ok(child_layout) = taffy.layout(child) else {
                    continue;
                };
                let (dx, dy) = crate::chart::anchor_offset(
                    place.anchor,
                    child_layout.size.width,
                    child_layout.size.height,
                    crate::chart::defaults::MARKER_GAP * scale,
                );
                (
                    place.x + dx - child_layout.location.x,
                    place.y + dy + child_scroll_shift_y - child_layout.location.y,
                )
            }
        };
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
            child_parent_x,
            child_parent_y,
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
            child_clip_radius,
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

/// The positional side-indexes derived from an emitted item list.
/// Built by [`build_item_indexes`] — the ONE place that decides
/// membership — and consumed by both `compute_inner_state` (fresh
/// pass) and [`LayoutPass::refresh_paint_only`] (in-place refresh), so
/// the two paths can never disagree about what is actionable /
/// focusable / scrollable / hoverable.
pub(crate) struct ItemIndexes {
    pub(crate) by_node_id: HashMap<String, usize>,
    pub(crate) actionable_ids: Vec<usize>,
    pub(crate) focusable_ids: Vec<usize>,
    pub(crate) scrollable_ids: Vec<usize>,
    pub(crate) hoverable_ids: Vec<usize>,
}

pub(crate) fn build_item_indexes(items: &[LayoutItem]) -> ItemIndexes {
    let mut by_node_id = HashMap::with_capacity(items.len());
    let mut actionable_ids = Vec::new();
    let mut focusable_ids = Vec::new();
    let mut scrollable_ids = Vec::new();
    let mut hoverable_ids = Vec::new();
    for (idx, it) in items.iter().enumerate() {
        by_node_id.insert(it.node_id.clone(), idx);
        // A `.videoIntent(...)` node is actionable for hit-testing
        // purposes even with no `.onClick`: the renderer performs the
        // intent locally, so the item still has to be findable under
        // the pointer (and press/release-pairable) like any button.
        if it.action.is_some() || it.video_intent.is_some() {
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
    ItemIndexes {
        by_node_id,
        actionable_ids,
        focusable_ids,
        scrollable_ids,
        hoverable_ids,
    }
}

/// Engine-derived semantics for the items that have any, keyed by node
/// id, for the AccessKit translation — plus a content hash of the map
/// in item order. Shared by `compute_inner_state` and
/// [`LayoutPass::refresh_paint_only`]. The hash is computed HERE (runs
/// only on full compute / paint-only refresh) so the per-frame a11y
/// fingerprint (`window::a11y_fingerprint`, which runs on every
/// scroll-shift frame) folds in one u64 instead of Debug-formatting
/// every item's semantics per frame.
pub(crate) fn collect_item_semantics(
    tree: &Tree,
    items: &[LayoutItem],
) -> (HashMap<String, hypen_engine::ir::Semantics>, u64) {
    use std::hash::{Hash, Hasher};
    let mut a11y = HashMap::new();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for it in items {
        if let Some(node) = tree.get(&it.node_id) {
            if let Some(sem) = node.semantics.as_ref() {
                it.node_id.hash(&mut hasher);
                format!("{sem:?}").hash(&mut hasher);
                a11y.insert(it.node_id.clone(), sem.clone());
            }
        }
    }
    (a11y, hasher.finish())
}

/// Re-resolve one item's PAINT fields from its (already-mutated) tree
/// node, leaving geometry alone. This is `emit_items`'s per-node
/// resolution minus everything the paint-only classifier
/// (`is_layout_prop_key` + the structural gates) proves unchanged:
/// `rect`, `clip_to`, `subtree_root`, `scrollable`, `font_weight`
/// (`fontWeight` is a layout prop — it feeds text measurement), and
/// the layout-derived members of each `ItemKind` (Text content /
/// font size / max-lines / padding, Input font size). `opacity` and
/// `transform` are the post-passes' job, run by the caller
/// ([`LayoutPass::refresh_paint_only`]) over the whole item list since
/// both inherit downward.
///
/// Kept adjacent in spirit to `emit_items`: any prop resolution added
/// to an `emit_items` arm that is NOT layout-classified must be
/// mirrored here (the `refresh_matches_full_recompute` equivalence
/// tests in `layout_tests.rs` are the tripwire).
pub(crate) fn refresh_item_paint(
    item: &mut LayoutItem,
    node: &crate::tree::Node,
    tree: &Tree,
    viewport: Viewport,
) {
    // Trees containing media nodes never qualify as paint-only
    // (`has_media_nodes` gate) — player state transitions repaint on
    // registry changes no batch describes, and the Video arm's action
    // fallback (`onPlay`) is coupled to that machinery. The wholesale-
    // drop path owns Video repaints.
    if matches!(item.kind, ItemKind::Video { .. }) {
        return;
    }
    // Charts never reach here either: `paint_only_affected_ids` refuses
    // any batch touching a chart or a mark (`chart::is_chart_family_node`)
    // because their "paint" props resolve domains and geometry. The guard
    // is kept so a future classifier change degrades to a stale-free full
    // pass rather than a silently stale scene.
    if matches!(item.kind, ItemKind::Chart(_) | ItemKind::ChartMark(_)) {
        return;
    }

    let action = resolve_action(node);
    let action_payload = action.as_ref().and_then(|_| resolve_action_payload(node));
    item.video_intent = crate::video_v2::intent_for(tree, &item.node_id);
    item.hover_action = resolve_hover_action(node);
    item.hover_payload = item
        .hover_action
        .as_ref()
        .and_then(|_| resolve_hover_payload(node));
    let mut item_border = border_at(node, viewport);
    let background_explicit = prop_color_at(node, "backgroundColor", viewport);
    item.hover = HoverStyle {
        background: prop_color_at(node, "backgroundColor:hover", viewport),
        border_color: prop_color_at(node, "borderColor:hover", viewport),
    };
    item.background_gradient = crate::style::prop_linear_gradient(node, viewport);
    item.background_image = crate::style::prop_background_image_url(node);
    item.background_layers = crate::style::prop_background_layers(node);
    item.state_variants = crate::style::state_variants(node, viewport);
    let bool_prop = |name: &str| {
        node.props
            .get(name)
            .and_then(|value| {
                value
                    .as_bool()
                    .or_else(|| value.as_str().map(|text| text == "true"))
            })
            .unwrap_or(false)
    };
    let number_prop = |name: &str, fallback: f32| {
        node.props
            .get(name)
            .and_then(|value| {
                value
                    .as_f64()
                    .map(|number| number as f32)
                    .or_else(|| value.as_str().and_then(|text| text.parse::<f32>().ok()))
            })
            .unwrap_or(fallback)
    };

    // Kind-specific paint fields, mirroring the `emit_items` arms.
    match &mut item.kind {
        ItemKind::Input {
            value,
            placeholder,
            bind_path,
            color,
            ..
        } => {
            *value = node
                .props
                .get("value")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            *placeholder = node
                .props
                .get("placeholder")
                .or_else(|| node.props.get("placeholder.0"))
                .and_then(|v| v.as_str())
                .map(str::to_string);
            *bind_path = node
                .props
                .get("bind")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            *color = prop_color_at(node, "color", viewport).unwrap_or(Rgba::BLACK);
        }
        ItemKind::Text {
            color,
            align,
            line_through,
            ..
        } => {
            *color = prop_color_at(node, "color", viewport).unwrap_or(Rgba::BLACK);
            *align = parse_text_align(crate::style::prop_str_at(node, "textAlign", viewport));
            *line_through = has_line_through(node, viewport);
        }
        ItemKind::Icon { .. } | ItemKind::Image { .. } => {
            // Icon-vs-Image is prop-driven (`__iconPaths` presence),
            // not element-type-driven, so a paint-only write can flip
            // the kind — rebuild it wholesale exactly like emit does.
            let icon_paths = node
                .props
                .get("__iconPaths")
                .or_else(|| node.props.get("paths"))
                .map(crate::paint::icon::parse_paths)
                .unwrap_or_default();
            item.kind = if !icon_paths.is_empty() {
                let view_box_str = node
                    .props
                    .get("__iconViewBox")
                    .and_then(|v| v.as_str())
                    .or_else(|| node.props.get("viewBox").and_then(|v| v.as_str()));
                ItemKind::Icon {
                    paths: icon_paths,
                    view_box: crate::paint::icon::parse_view_box(view_box_str),
                    tint: prop_color_at(node, "color", viewport),
                }
            } else {
                ItemKind::Image {
                    src: crate::style::prop_str_at(node, "src", viewport).map(str::to_string),
                    fit: parse_object_fit(crate::style::prop_str_at(node, "objectFit", viewport)),
                }
            };
        }
        ItemKind::Scrubber { preview, .. } => {
            // `video_id` is structural (the enclosing-Video walk) —
            // unchanged under a paint-only batch. The preview rides
            // props, so refresh it.
            *preview = crate::video_v2::scrub_preview(node);
        }
        ItemKind::Checkbox { checked } | ItemKind::Switch { checked } => {
            *checked = bool_prop("checked");
        }
        ItemKind::Slider { fraction, disabled } => {
            let min = number_prop("min", 0.0);
            let max = number_prop("max", 100.0);
            let value = number_prop("value", min);
            *fraction = if max > min {
                ((value - min) / (max - min)).clamp(0.0, 1.0)
            } else {
                0.0
            };
            *disabled = bool_prop("disabled");
        }
        ItemKind::ProgressBar { fraction } => {
            *fraction = (number_prop("value", 0.0) / 100.0).clamp(0.0, 1.0);
        }
        ItemKind::Spinner { color } => {
            *color = prop_color_at(node, "color", viewport).unwrap_or(Rgba(0x3b, 0x82, 0xf6, 0xff));
        }
        ItemKind::Select { value, placeholder } => {
            let first_option = tree.children_of(&item.node_id).iter().find_map(|child_id| {
                tree.get(child_id)?
                    .text_content()
                    .map(|text| text.into_owned())
            });
            *value = node
                .props
                .get("value")
                .and_then(|entry| entry.as_str())
                .map(str::to_string)
                .or(first_option)
                .unwrap_or_default();
            *placeholder = node
                .props
                .get("placeholder")
                .and_then(|entry| entry.as_str())
                .unwrap_or("Select...")
                .to_string();
        }
        ItemKind::Audio { controls } => {
            *controls = node
                .props
                .get("controls")
                .and_then(|entry| entry.as_bool())
                .unwrap_or(true);
        }
        ItemKind::Video { .. } => unreachable!("early-returned above"),
        ItemKind::Chart(_) | ItemKind::ChartMark(_) => {
            unreachable!("early-returned above")
        }
        ItemKind::Button | ItemKind::Card | ItemKind::Container => {}
    }

    // Per-kind action / background / border specializations, mirroring
    // `emit_items`: Inputs and Scrubbers never carry the generic click
    // action (Inputs edit, Scrubbers seek through their own commit
    // path). Component-specific defaults must match `emit_items` exactly.
    let is_input = matches!(item.kind, ItemKind::Input { .. });
    if is_input || matches!(item.kind, ItemKind::Scrubber { .. }) {
        item.action = None;
        item.action_payload = None;
    } else {
        item.action = action;
        item.action_payload = action_payload;
    }
    let is_card = matches!(item.kind, ItemKind::Card);
    if is_card && !declares_corner_radius(node) {
        item_border.radius = 8.0;
    }
    item.background =
        background_explicit.or_else(|| is_card.then_some(Rgba(0xff, 0xff, 0xff, 0xff)));
    item.border = item_border;
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
    tree.has_transform_props()
}

/// Read a transform prop as f32. `prop_f32_at` handles numbers and
/// px-suffixed strings (breakpoint-variant-aware); the fallback strips
/// a `deg` suffix so `rotate: "45deg"` — the DOM-facing string form —
/// resolves too.
fn transform_f32(node: &crate::tree::Node, name: &str, viewport: Viewport) -> Option<f32> {
    if let Some(v) = prop_f32_at(node, name, viewport) {
        return Some(v);
    }
    let direct = crate::style::prop_str_at(node, name, viewport);
    let s = direct.or_else(|| {
        let compound = crate::style::prop_str_at(node, "transform", viewport)?;
        css_transform_value(compound, name)
    })?;
    let trimmed = s.trim();
    let stripped = trimmed.strip_suffix("deg").unwrap_or(trimmed);
    stripped
        .trim()
        .parse::<f32>()
        .ok()
        .filter(|v| v.is_finite())
}

fn css_transform_value<'a>(source: &'a str, name: &str) -> Option<&'a str> {
    let aliases: &[&str] = match name {
        "rotate" => &["rotate"],
        "scale" => &["scale"],
        "translateX" => &["translateX", "translatex"],
        "translateY" => &["translateY", "translatey"],
        _ => &[],
    };
    for alias in aliases {
        let needle = format!("{alias}(");
        if let Some(start) = source.find(&needle) {
            let value_start = start + needle.len();
            if let Some(end) = source[value_start..].find(')') {
                return Some(source[value_start..value_start + end].trim());
            }
        }
    }
    None
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
    // `translateX` / `translateY` resolve to 0 when absent AND when the
    // engine-injected pinboard binding resolves to JSON `null` (the
    // reserved `__dnd.<group>.<key>` path unset — DnD plan §3): a `null`
    // prop reads as `None` through `value_to_f32`, so it lands here as 0.
    // The drag-and-drop runtime's local offsets (`__dndDesktop.dx/dy`,
    // logical px — the ghost translate and sibling gap-opening shifts)
    // compose ON TOP of the node's own translate so a lifted pinboard
    // note keeps its base position under the drag.
    let (ldx, ldy) = local_drag_offset(node);
    let tx = (transform_f32(node, "translateX", viewport).unwrap_or(0.0) + ldx) * scale;
    let ty = (transform_f32(node, "translateY", viewport).unwrap_or(0.0) + ldy) * scale;
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

/// The drag-and-drop runtime's renderer-private local offset for a node
/// (logical px), `(0, 0)` for the overwhelmingly common node without one.
/// Read raw (no variant chain — the runtime writes exactly these keys).
fn local_drag_offset(node: &crate::tree::Node) -> (f32, f32) {
    let read = |key: &str| {
        node.props
            .get(key)
            .and_then(serde_json::Value::as_f64)
            .filter(|v| v.is_finite())
            .map(|v| v as f32)
            .unwrap_or(0.0)
    };
    (
        read(crate::dnd::LOCAL_DX_PROP),
        read(crate::dnd::LOCAL_DY_PROP),
    )
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
        (Some(node), Some(rect)) => {
            let mut pin = (0.0, 0.0);
            if node.props.contains_key("__dnd.pinX") || node.props.contains_key("__dnd.pinY") {
                let mut parent = tree.parent_of(id);
                while let Some(parent_id) = parent {
                    if let Some(board) = tree.get(parent_id) {
                        if board.props.contains_key("__dnd.pin") {
                            if let Some(box_rect) = rects.get(parent_id) {
                                let pad = crate::style::padding_at(board, viewport);
                                let border =
                                    crate::style::border_at(board, viewport).width.max(0.0);
                                let w = (box_rect.w
                                    - (pad.left + pad.right + 2.0 * border) * scale)
                                    .max(0.0);
                                let h = (box_rect.h
                                    - (pad.top + pad.bottom + 2.0 * border) * scale)
                                    .max(0.0);
                                let read = |key: &str| {
                                    node.props
                                        .get(key)
                                        .and_then(serde_json::Value::as_f64)
                                        .filter(|v| v.is_finite())
                                        .unwrap_or(0.0) as f32
                                };
                                pin = (read("__dnd.pinX") * w, read("__dnd.pinY") * h);
                            }
                            break;
                        }
                    }
                    parent = tree.parent_of(parent_id);
                }
            }
            Affine2::translate(pin.0, pin.1)
                .mul(&node_local_transform(node, *rect, viewport, scale))
        }
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
    compute_item_transforms_gated(tree, items, viewport, scale, tree_has_transform_props(tree));
}

/// [`compute_item_transforms`] with the transform-prop gate already
/// answered, so `compute_inner_state`'s combined flag scan isn't
/// repeated here.
pub(crate) fn compute_item_transforms_gated(
    tree: &Tree,
    items: &mut [LayoutItem],
    viewport: Viewport,
    scale: f32,
    has_transform: bool,
) {
    if !has_transform {
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
pub(crate) fn is_scrollable_node(node: &crate::tree::Node, viewport: Viewport) -> bool {
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

/// Whether descendants must be clipped to this node even when it is not
/// scrollable. CSS `overflow: hidden|clip` constrains paint without creating
/// scroll metadata or changing the scroll offset.
fn clips_overflow_node(node: &crate::tree::Node, viewport: Viewport) -> bool {
    ["overflow", "overflowX", "overflowY"]
        .into_iter()
        .any(|name| {
            matches!(
                crate::style::prop_str_at(node, name, viewport)
                    .map(str::trim)
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("hidden") | Some("clip")
            )
        })
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

fn inherited_text_font_size(tree: &Tree, id: &str, viewport: Viewport) -> f32 {
    let mut cursor = Some(id);
    let mut heading_level = None;
    let mut in_badge = false;
    while let Some(current) = cursor {
        let Some(node) = tree.get(current) else { break };
        if let Some(size) = prop_f32_at(node, "fontSize", viewport) {
            return size;
        }
        if node.element_type.eq_ignore_ascii_case("Heading") && heading_level.is_none() {
            heading_level = Some(
                prop_f32_at(node, "level", viewport)
                    .or_else(|| prop_f32_at(node, "0", viewport))
                    .unwrap_or(1.0) as u8,
            );
        }
        in_badge |= node.element_type.eq_ignore_ascii_case("Badge");
        cursor = tree.parent_of(current);
    }
    match heading_level.unwrap_or(0) {
        1 => 32.0,
        2 => 24.0,
        3 => 18.72,
        4 => 16.0,
        5 => 13.28,
        6 => 10.72,
        _ if in_badge => 12.0,
        _ => DEFAULT_FONT_SIZE_PX,
    }
}

fn inherited_text_font_weight(tree: &Tree, id: &str, viewport: Viewport) -> u16 {
    let mut cursor = Some(id);
    let mut in_heading = false;
    let mut in_badge = false;
    while let Some(current) = cursor {
        let Some(node) = tree.get(current) else { break };
        if node.props.contains_key("fontWeight") || node.props.contains_key("fontWeight.0") {
            return resolve_font_weight(node, viewport);
        }
        in_heading |= node.element_type.eq_ignore_ascii_case("Heading");
        in_badge |= node.element_type.eq_ignore_ascii_case("Badge");
        cursor = tree.parent_of(current);
    }
    if in_heading {
        700
    } else if in_badge {
        600
    } else {
        400
    }
}

pub(crate) fn inherited_text_color(tree: &Tree, id: &str, viewport: Viewport) -> Rgba {
    let mut cursor = Some(id);
    let mut in_link = false;
    let mut in_badge = false;
    while let Some(current) = cursor {
        let Some(node) = tree.get(current) else { break };
        if let Some(color) = prop_color_at(node, "color", viewport) {
            return color;
        }
        in_link |= node.element_type.eq_ignore_ascii_case("Link");
        in_badge |= node.element_type.eq_ignore_ascii_case("Badge");
        cursor = tree.parent_of(current);
    }
    if in_link {
        Rgba(0x00, 0x00, 0xee, 0xff)
    } else if in_badge {
        Rgba(0x33, 0x33, 0x33, 0xff)
    } else {
        Rgba::BLACK
    }
}

fn inherited_text_align(tree: &Tree, id: &str, viewport: Viewport) -> TextAlign {
    let mut cursor = Some(id);
    while let Some(current) = cursor {
        let Some(node) = tree.get(current) else { break };
        if let Some(value) = crate::style::prop_str_at(node, "textAlign", viewport) {
            return parse_text_align(Some(value));
        }
        cursor = tree.parent_of(current);
    }
    TextAlign::Start
}

fn has_line_through(node: &crate::tree::Node, viewport: Viewport) -> bool {
    crate::style::prop_str_at(node, "textDecoration", viewport)
        .or_else(|| crate::style::prop_str_at(node, "textDecorationLine", viewport))
        .is_some_and(|value| {
            value
                .split_ascii_whitespace()
                .any(|token| token.eq_ignore_ascii_case("line-through"))
        })
}

fn text_requests_stack_track_width(node: &crate::tree::Node) -> bool {
    node.element_type.eq_ignore_ascii_case("Text")
        && crate::style::prop_str(node, "textAlign").is_some()
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
