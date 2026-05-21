//! Style props extracted from a renderer [`Node`].
//!
//! Hypen applicators land in props as dotted keys: `.padding(16)` →
//! `padding.0 = 16`; `.padding(top: 8)` → `padding.top = 8`. Helpers in
//! this module read those keys (with sensible fallbacks) so layout and
//! painter both see the same resolved style without re-implementing the
//! lookup rules.
//!
//! Phase 3 covers the 80% applicators: padding (uniform + directional),
//! gap, color, backgroundColor, fontSize, fontWeight. Borders, margins,
//! transforms, gradients, and tw classes land in later phases.

use crate::tree::Node;
use serde_json::Value;

/// RGBA, premultiplied-friendly straight-alpha at the source. Used as
/// input to tiny-skia's `PremultipliedColorU8`. The `Default` is
/// fully transparent black.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rgba(pub u8, pub u8, pub u8, pub u8);

impl Rgba {
    pub const BLACK: Rgba = Rgba(0, 0, 0, 0xff);
    pub const TRANSPARENT: Rgba = Rgba(0, 0, 0, 0);

    /// Pre-multiply alpha into RGB. tiny-skia's PremultipliedColorU8
    /// expects pre-multiplied bytes.
    pub fn premultiplied(self) -> [u8; 4] {
        let Rgba(r, g, b, a) = self;
        let a = a as u32;
        [
            ((r as u32 * a + 127) / 255) as u8,
            ((g as u32 * a + 127) / 255) as u8,
            ((b as u32 * a + 127) / 255) as u8,
            a as u8,
        ]
    }
}

/// Box-model padding in physical pixels.
#[derive(Debug, Clone, Copy, Default)]
pub struct Padding {
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub left: f32,
}

impl Padding {
    pub fn uniform(v: f32) -> Self {
        Self {
            top: v,
            right: v,
            bottom: v,
            left: v,
        }
    }
}

/// Convert a camelCase prop name to its CSS kebab-case equivalent.
/// `backgroundColor` → `background-color`. Used by [`prop_str`] /
/// [`prop_f32`] to fall back onto props that arrive via `.tw(...)`
/// (the engine's tailwind expander emits CSS-style kebab names) when
/// no explicit applicator was set.
fn camel_to_kebab(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 2);
    for ch in name.chars() {
        if ch.is_ascii_uppercase() {
            if !out.is_empty() {
                out.push('-');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// Read a number prop. Lookup order: explicit applicator
/// (`backgroundColor`), single-arg form (`backgroundColor.0`), then
/// the kebab-case fallback (`background-color`) for tw-expanded
/// classes.
pub fn prop_f32(node: &Node, name: &str) -> Option<f32> {
    let direct = node.props.get(name);
    let dotted = node.props.get(&format!("{name}.0"));
    let kebab_name = camel_to_kebab(name);
    let kebab = if kebab_name != name {
        node.props.get(&kebab_name)
    } else {
        None
    };
    direct.or(dotted).or(kebab).and_then(value_to_f32)
}

/// Read a string prop, same fallback chain as [`prop_f32`].
pub fn prop_str<'a>(node: &'a Node, name: &str) -> Option<&'a str> {
    let direct = node.props.get(name);
    let dotted = node.props.get(&format!("{name}.0"));
    let kebab_name = camel_to_kebab(name);
    let kebab = if kebab_name != name {
        node.props.get(&kebab_name)
    } else {
        None
    };
    direct.or(dotted).or(kebab).and_then(Value::as_str)
}

/// Tailwind-style breakpoint thresholds (px). Matches the defaults the
/// engine's `hypen-tailwind-parse` emits in `name@bp` keys.
const BREAKPOINTS_DESC: &[(&str, f32)] = &[
    ("2xl", 1536.0),
    ("xl", 1280.0),
    ("lg", 1024.0),
    ("md", 768.0),
    ("sm", 640.0),
];

/// Walk breakpoint suffixes from largest-active down to base, returning
/// the first existing prop value. Used by [`prop_str_at`] /
/// [`prop_f32_at`] so layout can resolve `padding@md = "2rem"` etc.
fn lookup_breakpoint<'a>(
    node: &'a Node,
    name: &str,
    viewport_w: f32,
) -> Option<&'a Value> {
    for (bp, threshold) in BREAKPOINTS_DESC {
        if viewport_w >= *threshold {
            let key = format!("{name}@{bp}");
            if let Some(v) = node.props.get(&key) {
                return Some(v);
            }
        }
    }
    None
}

/// Read a string prop honouring Tailwind breakpoints. Lookup order:
/// largest-active `@bp` suffix → direct → `name.0` → kebab. The
/// non-breakpoint variant ([`prop_str`]) is the right call for paths
/// that don't have a viewport handy (e.g. accessibility serialisation).
pub fn prop_str_at<'a>(
    node: &'a Node,
    name: &str,
    viewport_w: f32,
) -> Option<&'a str> {
    if let Some(v) = lookup_breakpoint(node, name, viewport_w).and_then(Value::as_str) {
        return Some(v);
    }
    prop_str(node, name)
}

/// Numeric counterpart of [`prop_str_at`].
pub fn prop_f32_at(node: &Node, name: &str, viewport_w: f32) -> Option<f32> {
    if let Some(v) = lookup_breakpoint(node, name, viewport_w).and_then(value_to_f32) {
        return Some(v);
    }
    prop_f32(node, name)
}

/// Colour counterpart of [`prop_str_at`] — same fallback chain, then
/// runs the result through [`parse_color`].
pub fn prop_color_at(node: &Node, name: &str, viewport_w: f32) -> Option<Rgba> {
    prop_str_at(node, name, viewport_w).and_then(parse_color)
}

/// Read a colour prop and parse it. Accepts CSS hex (`#rgb`, `#rgba`,
/// `#rrggbb`, `#rrggbbaa`) and a small set of named colours.
pub fn prop_color(node: &Node, name: &str) -> Option<Rgba> {
    prop_str(node, name).and_then(parse_color)
}

/// Resolve `.padding(...)` plus the directional shorthand variants into
/// a single Padding. Order of precedence (per side):
/// 1. `.paddingTop(N)` → `paddingTop.0`
/// 2. `.padding(top: N)` → `padding.top`
/// 3. `.paddingVertical(N)` → `paddingVertical.0` (top + bottom)
///    / `.paddingHorizontal(N)` → `paddingHorizontal.0` (left + right)
/// 4. `.padding(N)` → `padding.0` (all sides)
pub fn padding(node: &Node) -> Padding {
    read_box_props(node, "padding")
}

/// Margin counterpart of [`padding`] — same precedence and key
/// conventions, just with a `margin` prefix.
pub fn margin(node: &Node) -> Padding {
    read_box_props(node, "margin")
}

/// Viewport-aware [`padding`] — honours `padding@md` etc. tw classes.
pub fn padding_at(node: &Node, viewport_w: f32) -> Padding {
    read_box_props_at(node, "padding", viewport_w)
}

/// Viewport-aware [`margin`].
pub fn margin_at(node: &Node, viewport_w: f32) -> Padding {
    read_box_props_at(node, "margin", viewport_w)
}

/// Shared box-model reader for `padding` / `margin`. The Hypen DSL gives
/// both shorthand and per-side applicators that all collapse to the same
/// 4-edge `Padding` shape; the precedence ordering matches `padding`'s
/// doc-comment.
/// Viewport-aware variant of [`read_box_props`]. Mirrors the same
/// precedence chain but every `prop_f32` lookup goes through the
/// breakpoint-aware [`prop_f32_at`].
fn read_box_props_at(node: &Node, prefix: &str, viewport_w: f32) -> Padding {
    let mut p = Padding::default();
    if let Some(v) = prop_f32_at(node, prefix, viewport_w) {
        p = Padding::uniform(v);
    }
    if let Some(v) = prop_f32_at(node, &format!("{prefix}Horizontal"), viewport_w) {
        p.left = v;
        p.right = v;
    }
    if let Some(v) = prop_f32_at(node, &format!("{prefix}Vertical"), viewport_w) {
        p.top = v;
        p.bottom = v;
    }
    if let Some(v) = node
        .props
        .get(&format!("{prefix}.top"))
        .and_then(value_to_f32)
    {
        p.top = v;
    }
    if let Some(v) = node
        .props
        .get(&format!("{prefix}.right"))
        .and_then(value_to_f32)
    {
        p.right = v;
    }
    if let Some(v) = node
        .props
        .get(&format!("{prefix}.bottom"))
        .and_then(value_to_f32)
    {
        p.bottom = v;
    }
    if let Some(v) = node
        .props
        .get(&format!("{prefix}.left"))
        .and_then(value_to_f32)
    {
        p.left = v;
    }
    if let Some(v) = prop_f32_at(node, &format!("{prefix}Top"), viewport_w) {
        p.top = v;
    }
    if let Some(v) = prop_f32_at(node, &format!("{prefix}Bottom"), viewport_w) {
        p.bottom = v;
    }
    if let Some(v) = prop_f32_at(node, &format!("{prefix}Left"), viewport_w) {
        p.left = v;
    }
    if let Some(v) = prop_f32_at(node, &format!("{prefix}Right"), viewport_w) {
        p.right = v;
    }
    p
}

fn read_box_props(node: &Node, prefix: &str) -> Padding {
    let mut p = Padding::default();

    if let Some(v) = prop_f32(node, prefix) {
        p = Padding::uniform(v);
    }
    if let Some(v) = prop_f32(node, &format!("{prefix}Horizontal")) {
        p.left = v;
        p.right = v;
    }
    if let Some(v) = prop_f32(node, &format!("{prefix}Vertical")) {
        p.top = v;
        p.bottom = v;
    }
    if let Some(v) = node
        .props
        .get(&format!("{prefix}.top"))
        .and_then(value_to_f32)
    {
        p.top = v;
    }
    if let Some(v) = node
        .props
        .get(&format!("{prefix}.right"))
        .and_then(value_to_f32)
    {
        p.right = v;
    }
    if let Some(v) = node
        .props
        .get(&format!("{prefix}.bottom"))
        .and_then(value_to_f32)
    {
        p.bottom = v;
    }
    if let Some(v) = node
        .props
        .get(&format!("{prefix}.left"))
        .and_then(value_to_f32)
    {
        p.left = v;
    }
    if let Some(v) = prop_f32(node, &format!("{prefix}Top")) {
        p.top = v;
    }
    if let Some(v) = prop_f32(node, &format!("{prefix}Bottom")) {
        p.bottom = v;
    }
    if let Some(v) = prop_f32(node, &format!("{prefix}Left")) {
        p.left = v;
    }
    if let Some(v) = prop_f32(node, &format!("{prefix}Right")) {
        p.right = v;
    }

    p
}

/// Per-side bitmask: 1=top, 2=right, 4=bottom, 8=left.
pub const BORDER_SIDE_TOP: u8 = 1;
pub const BORDER_SIDE_RIGHT: u8 = 2;
pub const BORDER_SIDE_BOTTOM: u8 = 4;
pub const BORDER_SIDE_LEFT: u8 = 8;
pub const BORDER_SIDES_ALL: u8 = BORDER_SIDE_TOP | BORDER_SIDE_RIGHT | BORDER_SIDE_BOTTOM | BORDER_SIDE_LEFT;

/// Resolved border style for a node.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Border {
    pub width: f32,
    pub color: Rgba,
    pub radius: f32,
    /// Bitmask of which sides this border draws on. `BORDER_SIDES_ALL`
    /// (the default) is the standard "stroke the full rounded rect"
    /// path. A subset means tw `border-b` / `border-t` etc. — those
    /// expand to per-side keys (`border-bottom-width: 1px`) which
    /// the layout reads here, then the painter strokes only the set
    /// sides as thin un-rounded fill rects.
    pub sides: u8,
}

impl Default for Border {
    fn default() -> Self {
        Self {
            width: 0.0,
            color: Rgba::TRANSPARENT,
            radius: 0.0,
            sides: BORDER_SIDES_ALL,
        }
    }
}

impl Border {
    pub fn is_visible(&self) -> bool {
        self.width > 0.0 && self.color.3 > 0 && self.sides != 0
    }

    /// True when only some of the four sides are flagged. Painter
    /// uses this to fall back from `stroke_rect` (which draws all
    /// four edges of the rounded rect) to a per-side fill_rect path.
    pub fn is_partial(&self) -> bool {
        self.sides != 0 && self.sides != BORDER_SIDES_ALL
    }
}

/// Resolve border / borderWidth / borderColor / borderRadius / cornerRadius.
///
/// Precedence (per attribute):
/// 1. `.borderWidth(N)` / `.borderColor(...)` / `.borderRadius(N)` /
///    `.cornerRadius(N)` (highest — explicit per-attribute setter).
/// 2. `.border(width: N, color: ..., radius: N)` (named-object form).
/// 3. `.border(N)` (single positional → width only).
pub fn border(node: &Node) -> Border {
    let mut width = 0.0_f32;
    let mut radius = 0.0_f32;
    // Track colour explicitly so an opaque-black default only kicks in
    // when no `.borderColor(...)` / `.border(color: ...)` was set —
    // otherwise an explicit `.borderColor("transparent")` would be
    // silently rewritten to black (Rgba::TRANSPARENT == Rgba::default()).
    let mut color: Option<Rgba> = None;

    if let Some(v) = prop_f32(node, "border") {
        width = v;
    }
    if let Some(v) = node.props.get("border.width").and_then(value_to_f32) {
        width = v;
    }
    if let Some(v) = node
        .props
        .get("border.color")
        .and_then(Value::as_str)
        .and_then(parse_color)
    {
        color = Some(v);
    }
    if let Some(v) = node.props.get("border.radius").and_then(value_to_f32) {
        radius = v;
    }
    if let Some(v) = prop_f32(node, "borderWidth") {
        width = v;
    }
    if let Some(v) = prop_color(node, "borderColor") {
        color = Some(v);
    }
    if let Some(v) = prop_f32(node, "borderRadius") {
        radius = v;
    }
    // Compose-flavoured alias for borderRadius.
    if let Some(v) = prop_f32(node, "cornerRadius") {
        radius = v;
    }

    Border {
        width,
        // A width without an explicit colour falls back to opaque black —
        // matches the DOM applicator's "default solid black" behaviour.
        color: color.unwrap_or(if width > 0.0 { Rgba::BLACK } else { Rgba::TRANSPARENT }),
        radius,
        sides: BORDER_SIDES_ALL,
    }
}

/// Viewport-aware [`border`] — honours `borderWidth@md` etc.
pub fn border_at(node: &Node, viewport_w: f32) -> Border {
    let mut width = 0.0_f32;
    let mut radius = 0.0_f32;
    let mut color: Option<Rgba> = None;
    let mut uniform_set = false;
    // Per-side widths feed `sides` and the eventual stroke width
    // — set when tw `border-b` / `border-t` / etc. emits a directional
    // key (e.g. `border-bottom-width: 1px`).
    let mut top: Option<f32> = None;
    let mut right: Option<f32> = None;
    let mut bottom: Option<f32> = None;
    let mut left: Option<f32> = None;

    if let Some(v) = prop_f32_at(node, "border", viewport_w) {
        width = v;
        uniform_set = true;
    }
    if let Some(v) = node.props.get("border.width").and_then(value_to_f32) {
        width = v;
        uniform_set = true;
    }
    if let Some(v) = node
        .props
        .get("border.color")
        .and_then(Value::as_str)
        .and_then(parse_color)
    {
        color = Some(v);
    }
    if let Some(v) = node.props.get("border.radius").and_then(value_to_f32) {
        radius = v;
    }
    if let Some(v) = prop_f32_at(node, "borderWidth", viewport_w) {
        width = v;
        uniform_set = true;
    }
    if let Some(v) = prop_color_at(node, "borderColor", viewport_w) {
        color = Some(v);
    }
    if let Some(v) = prop_f32_at(node, "borderRadius", viewport_w) {
        radius = v;
    }
    if let Some(v) = prop_f32_at(node, "cornerRadius", viewport_w) {
        radius = v;
    }
    // Per-side: tw `border-b` → `border-bottom-width: 1px`. We accept
    // both camelCase + kebab via the standard `prop_f32_at` chain.
    top = prop_f32_at(node, "borderTopWidth", viewport_w);
    right = prop_f32_at(node, "borderRightWidth", viewport_w);
    bottom = prop_f32_at(node, "borderBottomWidth", viewport_w);
    left = prop_f32_at(node, "borderLeftWidth", viewport_w);

    let sides = if uniform_set {
        BORDER_SIDES_ALL
    } else if top.is_some() || right.is_some() || bottom.is_some() || left.is_some() {
        // Only the explicitly-set sides draw. Width is the max of the
        // per-side widths (uniform stroke per visible side).
        let mut s = 0u8;
        if top.is_some_and(|w| w > 0.0) {
            s |= BORDER_SIDE_TOP;
        }
        if right.is_some_and(|w| w > 0.0) {
            s |= BORDER_SIDE_RIGHT;
        }
        if bottom.is_some_and(|w| w > 0.0) {
            s |= BORDER_SIDE_BOTTOM;
        }
        if left.is_some_and(|w| w > 0.0) {
            s |= BORDER_SIDE_LEFT;
        }
        width = [top, right, bottom, left]
            .iter()
            .filter_map(|v| *v)
            .fold(0.0_f32, |a, b| a.max(b));
        s
    } else {
        BORDER_SIDES_ALL
    };

    Border {
        width,
        color: color.unwrap_or(if width > 0.0 { Rgba::BLACK } else { Rgba::TRANSPARENT }),
        radius,
        sides,
    }
}

/// True if the user supplied any border-* prop on this node — even
/// if it resolved to `width: 0` (e.g. `.tw("border-0")`). Used by
/// Input's default frame logic to distinguish "user opted out" from
/// "user didn't say anything".
pub fn has_explicit_border(node: &Node) -> bool {
    const KEYS: &[&str] = &[
        "border",
        "border.0",
        "border.width",
        "border.color",
        "border.radius",
        "borderWidth",
        "borderWidth.0",
        "border-width",
        "borderColor",
        "borderColor.0",
        "border-color",
        "borderRadius",
        "borderRadius.0",
        "border-radius",
        "cornerRadius",
        "cornerRadius.0",
    ];
    KEYS.iter().any(|k| node.props.contains_key(*k))
}

fn value_to_f32(v: &Value) -> Option<f32> {
    match v {
        Value::Number(n) => n.as_f64().map(|f| f as f32),
        Value::String(s) => parse_length(s),
        _ => None,
    }
}

/// Parse a CSS-ish length: `"16"`, `"16px"`. Phase 3 doesn't honour `%`
/// or `em` — Taffy will deal with those once we expose width/height.
///
/// Accepts:
/// - `"16"`, `"16.5"` — bare numbers (treated as px).
/// - `"16px"` — explicit px.
/// - `"1rem"`, `"1.5rem"` — root-em, treated as 16px per rem (CSS
///   default; Hypen doesn't expose a custom root font size yet).
/// - `"1em"`, `"1.25em"` — same conversion as `rem` for now (we don't
///   track parent font-size during layout build).
fn parse_length(s: &str) -> Option<f32> {
    let trimmed = s.trim();
    if let Some(num) = trimmed.strip_suffix("rem") {
        return num.trim().parse::<f32>().ok().map(|v| v * 16.0);
    }
    if let Some(num) = trimmed.strip_suffix("em") {
        return num.trim().parse::<f32>().ok().map(|v| v * 16.0);
    }
    let stripped = trimmed.strip_suffix("px").unwrap_or(trimmed);
    stripped.trim().parse::<f32>().ok()
}

/// Parse a dimension prop that may carry a `%` unit. Returns the
/// numeric portion in [0, 1] for percent; `None` for length-only or
/// unparseable. Callers should fall through to `parse_length` /
/// `prop_f32_at` when this returns `None`.
pub(crate) fn parse_percent(s: &str) -> Option<f32> {
    let trimmed = s.trim();
    let num = trimmed.strip_suffix('%')?;
    num.trim().parse::<f32>().ok().map(|v| v * 0.01)
}

/// Parse a CSS-style aspect-ratio value: `"1 / 1"`, `"16 / 9"`, or a
/// bare `"1.5"`. Returns the numeric ratio (`width / height`). Tailwind
/// `aspect-square` expands to `aspect-ratio: "1 / 1"`, which
/// `parse_length` can't handle (the slash trips it up) — so without
/// this helper every `aspect-square` Image silently dropped its
/// aspect-ratio and fell back to the default 60px square.
pub fn parse_aspect_ratio(s: &str) -> Option<f32> {
    let s = s.trim();
    if let Some((num, den)) = s.split_once('/') {
        let num = num.trim().parse::<f32>().ok()?;
        let den = den.trim().parse::<f32>().ok()?;
        if den > 0.0 {
            return Some(num / den);
        }
        return None;
    }
    s.parse::<f32>().ok()
}

/// Read an aspect-ratio prop the same way `prop_f32_at` reads other
/// numerics, but with the CSS slash form (`"1 / 1"`) accepted on
/// strings. Falls back to the bare-number reader so explicit
/// `.aspectRatio(1.5)` still works.
pub fn prop_aspect_ratio_at(
    node: &Node,
    name: &str,
    viewport_w: f32,
) -> Option<f32> {
    // String form (the kebab path that tw emits) — try every key
    // variant `prop_f32_at` would check, but route through
    // `parse_aspect_ratio` so `"X / Y"` resolves.
    if let Some(s) = prop_str_at(node, name, viewport_w) {
        if let Some(v) = parse_aspect_ratio(s) {
            return Some(v);
        }
    }
    prop_f32_at(node, name, viewport_w)
}

// ---------------------------------------------------------------------------
// Linear gradient parser
//
// The Tailwind parser emits `background-image: linear-gradient(<dir>, var(--tw-
// gradient-stops))` plus three CSS custom properties — `--tw-gradient-from`,
// `--tw-gradient-via` (optional), `--tw-gradient-to` — that hold the stop
// colours. This module substitutes the `var()` chain and parses the
// resulting CSS gradient string into a `LinearGradient` the painter can
// hand to Vello.
// ---------------------------------------------------------------------------

/// A single stop in a linear gradient: a colour and an optional offset
/// in the range `0.0..=1.0`. Stops without an explicit offset get
/// auto-distributed by the painter (or by the test that hits
/// `LinearGradient::resolved_offsets`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GradientStop {
    pub color: Rgba,
    pub offset: Option<f32>,
}

/// CSS-style direction for a linear gradient. Either a cardinal-ish
/// keyword (`to right`, `to bottom right`, …) or an angle in degrees
/// where `0deg` points up and rotation is clockwise — matching the CSS
/// spec.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GradientDirection {
    ToTop,
    ToTopRight,
    ToRight,
    ToBottomRight,
    ToBottom,
    ToBottomLeft,
    ToLeft,
    ToTopLeft,
    /// CSS-degrees: 0 = up, 90 = right, 180 = down, 270 = left.
    Angle(f32),
}

impl GradientDirection {
    /// Compute the linear-gradient axis endpoints `(start, end)` in
    /// the rect's coordinate space. For keyword directions this maps
    /// to the rect's corners / mid-edges; for `Angle(θ)` it projects
    /// the diagonal that crosses the rect along the direction the
    /// CSS spec defines (perpendicular to the gradient line, passing
    /// through the rect centre, intersecting the two edges).
    pub fn axis(&self, x: f32, y: f32, w: f32, h: f32) -> ((f32, f32), (f32, f32)) {
        let cx = x + w * 0.5;
        let cy = y + h * 0.5;
        match self {
            GradientDirection::ToTop => ((cx, y + h), (cx, y)),
            GradientDirection::ToBottom => ((cx, y), (cx, y + h)),
            GradientDirection::ToRight => ((x, cy), (x + w, cy)),
            GradientDirection::ToLeft => ((x + w, cy), (x, cy)),
            GradientDirection::ToTopRight => ((x, y + h), (x + w, y)),
            GradientDirection::ToBottomRight => ((x, y), (x + w, y + h)),
            GradientDirection::ToBottomLeft => ((x + w, y), (x, y + h)),
            GradientDirection::ToTopLeft => ((x + w, y + h), (x, y)),
            GradientDirection::Angle(deg) => {
                // CSS: 0deg = up, clockwise. The axis goes through
                // the centre; its length is set so the endpoints
                // land on the projection of the rect's bbox onto
                // the gradient line — that's what makes the visible
                // colour transition span the rect exactly once
                // regardless of the angle.
                let rad = deg.to_radians();
                let dx = rad.sin();
                let dy = -rad.cos();
                let half_w = w * 0.5;
                let half_h = h * 0.5;
                let len = (dx.abs() * half_w) + (dy.abs() * half_h);
                let sx = cx - dx * len;
                let sy = cy - dy * len;
                let ex = cx + dx * len;
                let ey = cy + dy * len;
                ((sx, sy), (ex, ey))
            }
        }
    }
}

/// Resolved linear gradient ready for the painter.
#[derive(Debug, Clone, PartialEq)]
pub struct LinearGradient {
    pub direction: GradientDirection,
    pub stops: Vec<GradientStop>,
}

impl LinearGradient {
    /// Return `stops` with any `None` offsets distributed evenly
    /// between the first/last fixed stops, falling back to the CSS
    /// default of (0, 1) for the bare two-stop case and even spacing
    /// otherwise. Used by the painter when handing stops to Vello,
    /// which requires explicit offsets.
    pub fn resolved_offsets(&self) -> Vec<(f32, Rgba)> {
        let n = self.stops.len();
        if n == 0 {
            return Vec::new();
        }
        if n == 1 {
            // CSS treats a single stop as a flat fill — emit it at
            // 0 and 1 so Vello has a valid gradient.
            let s = self.stops[0];
            let off = s.offset.unwrap_or(0.0);
            return vec![(off, s.color), (1.0, s.color)];
        }
        let mut out: Vec<(f32, Rgba)> = Vec::with_capacity(n);
        for (i, s) in self.stops.iter().enumerate() {
            let off = match s.offset {
                Some(o) => o,
                None => i as f32 / (n - 1) as f32,
            };
            out.push((off, s.color));
        }
        // Ensure non-decreasing offsets (CSS clamps to previous max).
        for i in 1..out.len() {
            if out[i].0 < out[i - 1].0 {
                out[i].0 = out[i - 1].0;
            }
        }
        out
    }
}

/// Parse a CSS `linear-gradient(<direction>, <stop>, <stop>, ...)` value.
/// Returns `None` for any other CSS value (radial-gradient, plain colour,
/// `url()`, malformed input). Whitespace-tolerant, case-insensitive on
/// the `linear-gradient` keyword.
pub fn parse_linear_gradient(s: &str) -> Option<LinearGradient> {
    let s = s.trim();
    let lower = s.to_ascii_lowercase();
    let s = if let Some(rest) = lower.strip_prefix("linear-gradient(") {
        // Recover the original-case args slice — `lower` was only for
        // the prefix sniff. Length is the same; just use the same
        // index into the original string.
        let start = "linear-gradient(".len();
        let inner_orig = &s[start..];
        let inner_orig = inner_orig.strip_suffix(')')?;
        let _ = rest; // keep `lower` from being flagged as unused
        inner_orig
    } else {
        return None;
    };

    let parts = split_top_level_commas(s);
    if parts.is_empty() {
        return None;
    }
    let first = parts[0].trim();
    let (direction, stops_start) = if let Some(dir) = parse_direction(first) {
        (dir, 1)
    } else {
        // CSS defaults to `to bottom` when no direction is given —
        // the first comma-separated chunk is then a stop.
        (GradientDirection::ToBottom, 0)
    };

    let stops: Vec<GradientStop> = parts[stops_start..]
        .iter()
        .filter_map(|p| parse_stop(p.trim()))
        .collect();
    if stops.len() < 1 {
        return None;
    }
    Some(LinearGradient { direction, stops })
}

/// Split `s` on commas at depth-0 only, so commas inside nested
/// `rgb(... , ... , ...)` / `var(...)` don't terminate a stop.
fn split_top_level_commas(s: &str) -> Vec<String> {
    let mut depth: i32 = 0;
    let mut current = String::new();
    let mut out: Vec<String> = Vec::new();
    for c in s.chars() {
        match c {
            '(' => {
                depth += 1;
                current.push(c);
            }
            ')' => {
                depth -= 1;
                current.push(c);
            }
            ',' if depth == 0 => {
                out.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    if !current.trim().is_empty() {
        out.push(current);
    }
    out
}

fn parse_direction(s: &str) -> Option<GradientDirection> {
    let lower = s.to_ascii_lowercase();
    match lower.as_str() {
        "to top" => Some(GradientDirection::ToTop),
        "to top right" | "to right top" => Some(GradientDirection::ToTopRight),
        "to right" => Some(GradientDirection::ToRight),
        "to bottom right" | "to right bottom" => Some(GradientDirection::ToBottomRight),
        "to bottom" => Some(GradientDirection::ToBottom),
        "to bottom left" | "to left bottom" => Some(GradientDirection::ToBottomLeft),
        "to left" => Some(GradientDirection::ToLeft),
        "to top left" | "to left top" => Some(GradientDirection::ToTopLeft),
        _ => {
            // Angle form: `<number>deg` (also accept rad/grad/turn).
            if let Some(num) = lower.strip_suffix("deg") {
                num.trim().parse::<f32>().ok().map(GradientDirection::Angle)
            } else if let Some(num) = lower.strip_suffix("turn") {
                num.trim()
                    .parse::<f32>()
                    .ok()
                    .map(|t| GradientDirection::Angle(t * 360.0))
            } else if let Some(num) = lower.strip_suffix("rad") {
                num.trim()
                    .parse::<f32>()
                    .ok()
                    .map(|r| GradientDirection::Angle(r.to_degrees()))
            } else {
                None
            }
        }
    }
}

fn parse_stop(s: &str) -> Option<GradientStop> {
    // Stop syntax: `<color>` or `<color> <position>` where position
    // is a percent (`50%`) or a length (we treat as 0..=1 fraction
    // by interpreting bare numbers as fractions in 0..1 — Tailwind
    // doesn't emit lengths here, only colours and percents).
    //
    // Splitting on whitespace is tricky because `rgb(255, 0, 0)`
    // contains spaces inside parens. Find the last whitespace at
    // depth 0; if the trailing token parses as a percent that's our
    // offset, otherwise treat the whole thing as a colour.
    let (color_part, offset_part) = split_color_offset(s);
    let color = parse_color(color_part.trim())?;
    let offset = offset_part.and_then(|o| {
        let trimmed = o.trim();
        if let Some(p) = trimmed.strip_suffix('%') {
            p.trim().parse::<f32>().ok().map(|v| v * 0.01)
        } else {
            trimmed.parse::<f32>().ok()
        }
    });
    Some(GradientStop { color, offset })
}

fn split_color_offset(s: &str) -> (&str, Option<&str>) {
    let mut depth: i32 = 0;
    let mut last_ws_at_zero: Option<usize> = None;
    for (i, c) in s.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            c if depth == 0 && c.is_whitespace() => last_ws_at_zero = Some(i),
            _ => {}
        }
    }
    match last_ws_at_zero {
        Some(idx) => {
            let head = s[..idx].trim_end();
            let tail = s[idx..].trim_start();
            // Verify the tail looks like an offset — a percent OR a
            // bare number. Without this, multi-word colour values
            // (just hypothetical here — `rgb(...)` has parens, not
            // spaces, but defence-in-depth) would lose their
            // trailing token.
            if tail.ends_with('%') || tail.parse::<f32>().is_ok() {
                (head, Some(tail))
            } else {
                (s, None)
            }
        }
        None => (s, None),
    }
}

/// Read a node's gradient background. Two paths, in priority order:
///
/// 1. The first-class `.linearGradient(direction, colors)` applicator —
///    a direct DSL hook that bypasses Tailwind's `var(--tw-…)`
///    indirection entirely. The engine flattens applicators into
///    namespaced props (single-positional → `.0`; named →
///    `.<key>`), so we accept either form. The colors argument is a
///    list literal; each entry is parsed via `parse_color`.
///
/// 2. The Tailwind path: `background-image: linear-gradient(...)` with
///    `var(--tw-gradient-stops/from/via/to)` references. Resolved by
///    `substitute_tw_gradient_vars`, then parsed.
///
/// Returns `None` when neither path produces a gradient.
pub fn prop_linear_gradient(node: &Node, viewport_w: f32) -> Option<LinearGradient> {
    let _ = viewport_w; // gradients aren't viewport-keyed (yet)
    if let Some(g) = read_linear_gradient_applicator(node) {
        return Some(g);
    }
    let raw = node
        .props
        .get("background-image")
        .or_else(|| node.props.get("backgroundImage"))
        .and_then(|v| v.as_str())?;
    let resolved = substitute_tw_gradient_vars(node, raw);
    parse_linear_gradient(&resolved)
}

/// First-class applicator path: read `.linearGradient(direction,
/// colors)` props off the node. Engine flattens applicators to
/// `linearGradient.0` (first positional) and `linearGradient.1`
/// (second positional) or `linearGradient.direction` /
/// `linearGradient.colors` if the user used named args. Both forms
/// are accepted.
fn read_linear_gradient_applicator(node: &Node) -> Option<LinearGradient> {
    let dir_str = node
        .props
        .get("linearGradient.direction")
        .or_else(|| node.props.get("linearGradient.0"))
        .and_then(|v| v.as_str())?;
    let colors_val = node
        .props
        .get("linearGradient.colors")
        .or_else(|| node.props.get("linearGradient.1"))?;
    let direction = parse_direction(dir_str.trim())?;
    let colors = colors_val.as_array()?;
    let stops: Vec<GradientStop> = colors
        .iter()
        .filter_map(|c| {
            let s = c.as_str()?;
            Some(GradientStop {
                color: parse_color(s)?,
                offset: None,
            })
        })
        .collect();
    if stops.is_empty() {
        return None;
    }
    Some(LinearGradient { direction, stops })
}

/// Lex-substitute `var(--tw-gradient-stops)`, then
/// `var(--tw-gradient-from)`, `var(--tw-gradient-via)`,
/// `var(--tw-gradient-to)` references using the node's props. Two
/// passes — `--tw-gradient-stops` itself expands to a list that
/// then contains the per-colour vars — so we just loop until no
/// more `var(--tw-` substring remains or the substitution count
/// hits a sanity cap. Lex substitution is fine because the
/// Tailwind output is grammar-free (string interpolation only).
pub fn substitute_tw_gradient_vars(node: &Node, raw: &str) -> String {
    fn read_var(node: &Node, name: &str) -> Option<String> {
        node.props
            .get(name)
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }
    let mut s = raw.to_string();
    for _ in 0..4 {
        // Each loop replaces one `var(--tw-gradient-…)`. The
        // capped count guards against pathological recursion that
        // a buggy emitter could produce; in practice 2 iterations
        // suffice (stops → from/via/to).
        let mut replaced = false;
        for name in &[
            "--tw-gradient-stops",
            "--tw-gradient-from",
            "--tw-gradient-via",
            "--tw-gradient-to",
        ] {
            let needle = format!("var({})", name);
            if let Some(idx) = s.find(&needle) {
                let value = read_var(node, name).unwrap_or_default();
                s.replace_range(idx..idx + needle.len(), &value);
                replaced = true;
                break;
            }
        }
        if !replaced {
            break;
        }
    }
    s
}

/// Read `name` (with viewport-aware tw breakpoint resolution) as a
/// `Dim`. Strings carrying `%` resolve to `Dim::Percent`; everything
/// else (numbers, `"16px"`, `"1rem"`) resolves to `Dim::Length`.
/// Returns `None` when the prop is absent or unparseable.
pub fn prop_dim_at(node: &Node, name: &str, viewport_w: f32) -> Option<Dim> {
    // Percent strings are only meaningful as raw values; check the
    // bare prop and the dotted positional first. If neither is a
    // string with `%`, fall through to the standard `prop_f32_at`
    // chain (which honours camelCase + dotted + kebab + tw
    // breakpoints) as a length.
    if let Some(s) = node.props.get(name).and_then(|v| v.as_str()) {
        if let Some(pct) = parse_percent(s) {
            return Some(Dim::Percent(pct));
        }
    }
    let dotted = format!("{name}.0");
    if let Some(s) = node.props.get(&dotted).and_then(|v| v.as_str()) {
        if let Some(pct) = parse_percent(s) {
            return Some(Dim::Percent(pct));
        }
    }
    // Kebab-case fallback: tw("w-1/2") emits `width: "50%"` and the
    // engine flattens that under the kebab key for CSS-style props.
    // Without this branch, percent dimensions from Tailwind silently
    // fell through to prop_f32_at → parse_length, which rejects `%`,
    // and the width/height was dropped.
    let kebab_name = camel_to_kebab(name);
    if kebab_name != name {
        if let Some(s) = node.props.get(&kebab_name).and_then(|v| v.as_str()) {
            if let Some(pct) = parse_percent(s) {
                return Some(Dim::Percent(pct));
            }
        }
    }
    prop_f32_at(node, name, viewport_w).map(Dim::Length)
}

/// Length / percent / auto resolution for sizing props on Image and
/// future percent-aware containers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Dim {
    Length(f32),
    Percent(f32),
}

/// Best-effort CSS-ish colour parser.
pub fn parse_color(s: &str) -> Option<Rgba> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix('#') {
        return parse_hex(hex);
    }
    Some(match s.to_ascii_lowercase().as_str() {
        "transparent" => Rgba::TRANSPARENT,
        "black" => Rgba(0, 0, 0, 0xff),
        "white" => Rgba(0xff, 0xff, 0xff, 0xff),
        "red" => Rgba(0xff, 0, 0, 0xff),
        "green" => Rgba(0, 0x80, 0, 0xff),
        "blue" => Rgba(0, 0, 0xff, 0xff),
        "gray" | "grey" => Rgba(0x80, 0x80, 0x80, 0xff),
        "lightgray" | "lightgrey" => Rgba(0xd3, 0xd3, 0xd3, 0xff),
        "darkgray" | "darkgrey" => Rgba(0xa9, 0xa9, 0xa9, 0xff),
        "yellow" => Rgba(0xff, 0xff, 0, 0xff),
        "orange" => Rgba(0xff, 0xa5, 0, 0xff),
        "purple" => Rgba(0x80, 0, 0x80, 0xff),
        "pink" => Rgba(0xff, 0xc0, 0xcb, 0xff),
        "cyan" | "aqua" => Rgba(0, 0xff, 0xff, 0xff),
        "magenta" | "fuchsia" => Rgba(0xff, 0, 0xff, 0xff),
        _ => return None,
    })
}

fn parse_hex(hex: &str) -> Option<Rgba> {
    let bytes: Vec<u8> = hex
        .chars()
        .map(|c| c.to_digit(16).map(|d| d as u8))
        .collect::<Option<Vec<_>>>()?;
    Some(match bytes.len() {
        3 => Rgba(bytes[0] * 0x11, bytes[1] * 0x11, bytes[2] * 0x11, 0xff),
        4 => Rgba(
            bytes[0] * 0x11,
            bytes[1] * 0x11,
            bytes[2] * 0x11,
            bytes[3] * 0x11,
        ),
        6 => Rgba(
            bytes[0] * 16 + bytes[1],
            bytes[2] * 16 + bytes[3],
            bytes[4] * 16 + bytes[5],
            0xff,
        ),
        8 => Rgba(
            bytes[0] * 16 + bytes[1],
            bytes[2] * 16 + bytes[3],
            bytes[4] * 16 + bytes[5],
            bytes[6] * 16 + bytes[7],
        ),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn node_with(props: &[(&str, Value)]) -> Node {
        let mut map = HashMap::new();
        for (k, v) in props {
            map.insert((*k).to_string(), v.clone());
        }
        Node {
            id: "test".into(),
            element_type: "Container".into(),
            props: map,
        }
    }

    // ----------------------------------------------------------------
    // Linear gradient parser + Tailwind var resolution
    // ----------------------------------------------------------------

    #[test]
    fn parse_linear_gradient_to_right_two_stops() {
        let g = parse_linear_gradient("linear-gradient(to right, #ff0000, #0000ff)")
            .expect("parses");
        assert_eq!(g.direction, GradientDirection::ToRight);
        assert_eq!(g.stops.len(), 2);
        assert_eq!(g.stops[0].color, Rgba(0xff, 0, 0, 0xff));
        assert_eq!(g.stops[1].color, Rgba(0, 0, 0xff, 0xff));
        // No explicit offsets — `resolved_offsets` distributes 0..1.
        let res = g.resolved_offsets();
        assert_eq!(res[0].0, 0.0);
        assert_eq!(res[1].0, 1.0);
    }

    #[test]
    fn parse_linear_gradient_to_bottom_right_three_stops() {
        let g = parse_linear_gradient(
            "linear-gradient(to bottom right, #ff0000, #00ff00, #0000ff)",
        )
        .expect("parses");
        assert_eq!(g.direction, GradientDirection::ToBottomRight);
        assert_eq!(g.stops.len(), 3);
        let res = g.resolved_offsets();
        assert_eq!(res[0].0, 0.0);
        assert!((res[1].0 - 0.5).abs() < 1e-4);
        assert_eq!(res[2].0, 1.0);
    }

    #[test]
    fn parse_linear_gradient_with_explicit_percent_offsets() {
        let g = parse_linear_gradient(
            "linear-gradient(to right, #ff0000 10%, #0000ff 80%)",
        )
        .expect("parses");
        let res = g.resolved_offsets();
        assert!((res[0].0 - 0.10).abs() < 1e-4);
        assert!((res[1].0 - 0.80).abs() < 1e-4);
    }

    #[test]
    fn parse_linear_gradient_angle_form() {
        let g = parse_linear_gradient("linear-gradient(45deg, #fff, #000)")
            .expect("parses");
        match g.direction {
            GradientDirection::Angle(a) => assert!((a - 45.0).abs() < 1e-4),
            _ => panic!("expected angle"),
        }
    }

    #[test]
    fn parse_linear_gradient_no_direction_defaults_to_bottom() {
        // CSS spec: default direction is `to bottom` when no
        // direction prefix is given. The first comma chunk is then
        // a stop, not a direction.
        let g = parse_linear_gradient("linear-gradient(#fff, #000)").expect("parses");
        assert_eq!(g.direction, GradientDirection::ToBottom);
        assert_eq!(g.stops.len(), 2);
    }

    #[test]
    fn parse_linear_gradient_rejects_non_linear() {
        assert!(parse_linear_gradient("radial-gradient(#fff, #000)").is_none());
        assert!(parse_linear_gradient("#ff0000").is_none());
        assert!(parse_linear_gradient("").is_none());
    }

    #[test]
    fn parse_linear_gradient_case_insensitive_keyword() {
        let g = parse_linear_gradient("LINEAR-GRADIENT(TO RIGHT, #ff0000, #0000ff)")
            .expect("parses");
        assert_eq!(g.direction, GradientDirection::ToRight);
    }

    #[test]
    fn gradient_axis_to_right_spans_horizontal_midline() {
        let dir = GradientDirection::ToRight;
        let ((sx, sy), (ex, ey)) = dir.axis(10.0, 20.0, 200.0, 100.0);
        assert_eq!((sx, sy), (10.0, 70.0));
        assert_eq!((ex, ey), (210.0, 70.0));
    }

    #[test]
    fn gradient_axis_to_bottom_spans_vertical_midline() {
        let dir = GradientDirection::ToBottom;
        let ((sx, sy), (ex, ey)) = dir.axis(0.0, 0.0, 100.0, 50.0);
        assert_eq!((sx, sy), (50.0, 0.0));
        assert_eq!((ex, ey), (50.0, 50.0));
    }

    #[test]
    fn gradient_axis_angle_0_points_up() {
        // 0deg = up in CSS — start at bottom-centre, end at top-centre.
        let dir = GradientDirection::Angle(0.0);
        let ((sx, sy), (ex, ey)) = dir.axis(0.0, 0.0, 100.0, 200.0);
        // Centre is (50, 100); axis half-length on a w=100,h=200
        // rect with dx=0, dy=-1 is |0|·50 + |-1|·100 = 100.
        assert!((sx - 50.0).abs() < 1e-3);
        assert!((sy - 200.0).abs() < 1e-3);
        assert!((ex - 50.0).abs() < 1e-3);
        assert!((sy - 200.0).abs() < 1e-3);
        let _ = ey; // already covered by sy assertion symmetry
    }

    #[test]
    fn prop_linear_gradient_resolves_tailwind_var_chain() {
        // Exact shape `tailwind-parse` produces for
        // `.tw("bg-gradient-to-r from-blue-500 to-pink-500")`. The
        // engine flattens these onto the renderer node as kebab-case
        // CSS-custom-property keys; `prop_linear_gradient` is the
        // gate that resolves the `var()` indirection.
        let node = node_with(&[
            (
                "background-image",
                Value::String(
                    "linear-gradient(to right, var(--tw-gradient-stops))".into(),
                ),
            ),
            (
                "--tw-gradient-stops",
                Value::String(
                    "var(--tw-gradient-from), var(--tw-gradient-to)".into(),
                ),
            ),
            ("--tw-gradient-from", Value::String("#3b82f6".into())),
            ("--tw-gradient-to", Value::String("#ec4899".into())),
        ]);
        let g = prop_linear_gradient(&node, 800.0).expect("resolves");
        assert_eq!(g.direction, GradientDirection::ToRight);
        assert_eq!(g.stops.len(), 2);
        assert_eq!(g.stops[0].color, Rgba(0x3b, 0x82, 0xf6, 0xff));
        assert_eq!(g.stops[1].color, Rgba(0xec, 0x48, 0x99, 0xff));
    }

    #[test]
    fn prop_linear_gradient_resolves_three_stop_via_chain() {
        // `.tw("bg-gradient-to-br from-blue-500 via-purple-500 to-pink-500")`.
        // The `via-*` utility replaces the `--tw-gradient-stops` var
        // with a three-colour list that itself uses
        // `var(--tw-gradient-from)` / `var(--tw-gradient-to)` — our
        // substitution loop must handle the nested case.
        let node = node_with(&[
            (
                "background-image",
                Value::String(
                    "linear-gradient(to bottom right, var(--tw-gradient-stops))"
                        .into(),
                ),
            ),
            (
                "--tw-gradient-stops",
                Value::String(
                    "var(--tw-gradient-from), #a855f7, var(--tw-gradient-to)".into(),
                ),
            ),
            ("--tw-gradient-from", Value::String("#3b82f6".into())),
            ("--tw-gradient-to", Value::String("#ec4899".into())),
        ]);
        let g = prop_linear_gradient(&node, 800.0).expect("resolves");
        assert_eq!(g.direction, GradientDirection::ToBottomRight);
        assert_eq!(g.stops.len(), 3);
        assert_eq!(g.stops[0].color, Rgba(0x3b, 0x82, 0xf6, 0xff));
        assert_eq!(g.stops[1].color, Rgba(0xa8, 0x55, 0xf7, 0xff));
        assert_eq!(g.stops[2].color, Rgba(0xec, 0x48, 0x99, 0xff));
    }

    #[test]
    fn prop_linear_gradient_returns_none_without_background_image() {
        // Solid-colour node — gradient path is opt-in.
        let node = node_with(&[(
            "background-color",
            Value::String("#ffffff".into()),
        )]);
        assert!(prop_linear_gradient(&node, 800.0).is_none());
    }

    #[test]
    fn prop_linear_gradient_reads_applicator_positional() {
        // `.linearGradient("to right", ["#3b82f6", "#ec4899"])` —
        // engine flattens the two positional args to
        // `linearGradient.0` (direction) + `linearGradient.1` (colors).
        let node = node_with(&[
            (
                "linearGradient.0",
                Value::String("to right".into()),
            ),
            (
                "linearGradient.1",
                serde_json::json!(["#3b82f6", "#ec4899"]),
            ),
        ]);
        let g = prop_linear_gradient(&node, 800.0).expect("resolves");
        assert_eq!(g.direction, GradientDirection::ToRight);
        assert_eq!(g.stops.len(), 2);
        assert_eq!(g.stops[0].color, Rgba(0x3b, 0x82, 0xf6, 0xff));
        assert_eq!(g.stops[1].color, Rgba(0xec, 0x48, 0x99, 0xff));
    }

    #[test]
    fn prop_linear_gradient_reads_applicator_named() {
        // `.linearGradient(direction: "45deg", colors: [...])` —
        // engine flattens named args under the key name directly.
        let node = node_with(&[
            (
                "linearGradient.direction",
                Value::String("45deg".into()),
            ),
            (
                "linearGradient.colors",
                serde_json::json!(["#ff0000", "#00ff00", "#0000ff"]),
            ),
        ]);
        let g = prop_linear_gradient(&node, 800.0).expect("resolves");
        match g.direction {
            GradientDirection::Angle(a) => assert!((a - 45.0).abs() < 1e-4),
            _ => panic!("expected angle"),
        }
        assert_eq!(g.stops.len(), 3);
    }

    #[test]
    fn prop_linear_gradient_applicator_beats_tailwind_path() {
        // If both an explicit `.linearGradient(...)` AND tw classes
        // are on the same node, the applicator wins. (Predictable
        // override semantics — easier to reason about than mixing.)
        let node = node_with(&[
            (
                "linearGradient.0",
                Value::String("to bottom".into()),
            ),
            (
                "linearGradient.1",
                serde_json::json!(["#000000", "#ffffff"]),
            ),
            (
                "background-image",
                Value::String(
                    "linear-gradient(to right, var(--tw-gradient-stops))".into(),
                ),
            ),
            (
                "--tw-gradient-stops",
                Value::String("#ff0000, #0000ff".into()),
            ),
        ]);
        let g = prop_linear_gradient(&node, 800.0).expect("resolves");
        assert_eq!(g.direction, GradientDirection::ToBottom);
        assert_eq!(g.stops[0].color, Rgba(0, 0, 0, 0xff));
        assert_eq!(g.stops[1].color, Rgba(0xff, 0xff, 0xff, 0xff));
    }

    #[test]
    fn parse_linear_gradient_single_stop_extends_to_full_range() {
        // CSS treats a single-stop gradient as a flat fill; we
        // duplicate the stop at offset 0 and 1 so Vello has a valid
        // two-point ramp. Without this, Vello rejects the gradient.
        let g = parse_linear_gradient("linear-gradient(to right, #ff0000)")
            .expect("parses");
        let res = g.resolved_offsets();
        assert_eq!(res.len(), 2);
        assert_eq!(res[0].1, Rgba(0xff, 0, 0, 0xff));
        assert_eq!(res[1].1, Rgba(0xff, 0, 0, 0xff));
    }

    #[test]
    fn padding_uniform_from_padding_zero() {
        let node = node_with(&[("padding.0", serde_json::json!(16))]);
        let p = padding(&node);
        assert_eq!(p.top, 16.0);
        assert_eq!(p.right, 16.0);
        assert_eq!(p.bottom, 16.0);
        assert_eq!(p.left, 16.0);
    }

    #[test]
    fn padding_uniform_from_padding_directional_object() {
        let node = node_with(&[
            ("padding.top", serde_json::json!(8)),
            ("padding.right", serde_json::json!(4)),
        ]);
        let p = padding(&node);
        assert_eq!(p.top, 8.0);
        assert_eq!(p.right, 4.0);
        assert_eq!(p.bottom, 0.0);
        assert_eq!(p.left, 0.0);
    }

    #[test]
    fn padding_horizontal_overrides_uniform_on_left_right() {
        let node = node_with(&[
            ("padding.0", serde_json::json!(16)),
            ("paddingHorizontal.0", serde_json::json!(8)),
        ]);
        let p = padding(&node);
        assert_eq!(p.left, 8.0);
        assert_eq!(p.right, 8.0);
        assert_eq!(p.top, 16.0);
        assert_eq!(p.bottom, 16.0);
    }

    #[test]
    fn padding_vertical_overrides_uniform_on_top_bottom() {
        let node = node_with(&[
            ("padding.0", serde_json::json!(16)),
            ("paddingVertical.0", serde_json::json!(8)),
        ]);
        let p = padding(&node);
        assert_eq!(p.top, 8.0);
        assert_eq!(p.bottom, 8.0);
        assert_eq!(p.left, 16.0);
        assert_eq!(p.right, 16.0);
    }

    #[test]
    fn padding_top_named_overrides_uniform() {
        let node = node_with(&[
            ("padding.0", serde_json::json!(16)),
            ("padding.top", serde_json::json!(4)),
        ]);
        let p = padding(&node);
        assert_eq!(p.top, 4.0);
        assert_eq!(p.right, 16.0);
        assert_eq!(p.bottom, 16.0);
        assert_eq!(p.left, 16.0);
    }

    #[test]
    fn padding_top_applicator_overrides_named() {
        let node = node_with(&[
            ("padding.0", serde_json::json!(16)),
            ("padding.top", serde_json::json!(4)),
            ("paddingTop.0", serde_json::json!(1)),
        ]);
        let p = padding(&node);
        assert_eq!(p.top, 1.0);
        assert_eq!(p.right, 16.0);
        assert_eq!(p.bottom, 16.0);
        assert_eq!(p.left, 16.0);
    }

    #[test]
    fn padding_zero_when_no_props() {
        let node = node_with(&[]);
        let p = padding(&node);
        assert_eq!(p.top, 0.0);
        assert_eq!(p.right, 0.0);
        assert_eq!(p.bottom, 0.0);
        assert_eq!(p.left, 0.0);
    }

    #[test]
    fn padding_accepts_string_with_px() {
        let node = node_with(&[("padding.0", serde_json::json!("16px"))]);
        let p = padding(&node);
        assert_eq!(p.top, 16.0);
        assert_eq!(p.right, 16.0);
        assert_eq!(p.bottom, 16.0);
        assert_eq!(p.left, 16.0);
    }

    #[test]
    fn prop_color_reads_dotted_or_direct() {
        let dotted = node_with(&[("color.0", serde_json::json!("red"))]);
        assert_eq!(prop_color(&dotted, "color"), Some(Rgba(0xff, 0, 0, 0xff)));

        let direct = node_with(&[("color", serde_json::json!("blue"))]);
        assert_eq!(prop_color(&direct, "color"), Some(Rgba(0, 0, 0xff, 0xff)));
    }

    #[test]
    fn prop_f32_reads_dotted_or_direct_for_numbers() {
        let dotted = node_with(&[("fontSize.0", serde_json::json!(18))]);
        assert_eq!(prop_f32(&dotted, "fontSize"), Some(18.0));

        let direct = node_with(&[("fontSize", serde_json::json!(24))]);
        assert_eq!(prop_f32(&direct, "fontSize"), Some(24.0));
    }

    #[test]
    fn parses_named_and_hex_colors() {
        assert_eq!(parse_color("red"), Some(Rgba(0xff, 0, 0, 0xff)));
        assert_eq!(parse_color("#fff"), Some(Rgba(0xff, 0xff, 0xff, 0xff)));
        assert_eq!(
            parse_color("#1a2b3c"),
            Some(Rgba(0x1a, 0x2b, 0x3c, 0xff))
        );
        assert_eq!(
            parse_color("#1a2b3c80"),
            Some(Rgba(0x1a, 0x2b, 0x3c, 0x80))
        );
        assert_eq!(parse_color("not-a-color"), None);
    }

    #[test]
    fn parses_lengths_with_px_suffix() {
        assert_eq!(parse_length("16"), Some(16.0));
        assert_eq!(parse_length("16px"), Some(16.0));
        assert_eq!(parse_length("  20px  "), Some(20.0));
    }

    #[test]
    fn premultiplies_alpha_correctly() {
        // Fully transparent → all zero
        assert_eq!(Rgba(0xff, 0xff, 0xff, 0).premultiplied(), [0, 0, 0, 0]);
        // Opaque white → unchanged
        assert_eq!(
            Rgba(0xff, 0xff, 0xff, 0xff).premultiplied(),
            [0xff, 0xff, 0xff, 0xff]
        );
        // 50% red ≈ (128,0,0,128)
        let p = Rgba(0xff, 0, 0, 0x80).premultiplied();
        assert!((p[0] as i32 - 0x80).abs() <= 1);
        assert_eq!(p[3], 0x80);
    }

    // ---------------------------------------------------------------
    // margin: mirrors the padding precedence tests above.
    // ---------------------------------------------------------------

    #[test]
    fn margin_uniform_from_margin_zero() {
        let node = node_with(&[("margin.0", serde_json::json!(12))]);
        let m = margin(&node);
        assert_eq!(m.top, 12.0);
        assert_eq!(m.right, 12.0);
        assert_eq!(m.bottom, 12.0);
        assert_eq!(m.left, 12.0);
    }

    #[test]
    fn margin_horizontal_overrides_uniform() {
        let node = node_with(&[
            ("margin.0", serde_json::json!(12)),
            ("marginHorizontal.0", serde_json::json!(4)),
        ]);
        let m = margin(&node);
        assert_eq!(m.left, 4.0);
        assert_eq!(m.right, 4.0);
        assert_eq!(m.top, 12.0);
        assert_eq!(m.bottom, 12.0);
    }

    #[test]
    fn margin_top_named_overrides_uniform() {
        let node = node_with(&[
            ("margin.0", serde_json::json!(12)),
            ("margin.top", serde_json::json!(2)),
        ]);
        let m = margin(&node);
        assert_eq!(m.top, 2.0);
        assert_eq!(m.right, 12.0);
        assert_eq!(m.bottom, 12.0);
        assert_eq!(m.left, 12.0);
    }

    #[test]
    fn margin_top_applicator_overrides_named() {
        let node = node_with(&[
            ("margin.0", serde_json::json!(12)),
            ("margin.top", serde_json::json!(2)),
            ("marginTop.0", serde_json::json!(1)),
        ]);
        let m = margin(&node);
        assert_eq!(m.top, 1.0);
        assert_eq!(m.right, 12.0);
        assert_eq!(m.bottom, 12.0);
        assert_eq!(m.left, 12.0);
    }

    #[test]
    fn margin_zero_when_no_props() {
        let node = node_with(&[]);
        let m = margin(&node);
        assert_eq!(m.top, 0.0);
        assert_eq!(m.right, 0.0);
        assert_eq!(m.bottom, 0.0);
        assert_eq!(m.left, 0.0);
    }

    // ---------------------------------------------------------------
    // border: width/colour/radius resolution + visibility gate.
    // ---------------------------------------------------------------

    #[test]
    fn border_width_only() {
        let node = node_with(&[("border.0", serde_json::json!(2))]);
        let b = border(&node);
        assert_eq!(b.width, 2.0);
        assert_eq!(b.color, Rgba::BLACK);
        assert_eq!(b.radius, 0.0);
        assert!(b.is_visible());
    }

    #[test]
    fn border_named_object_form() {
        let node = node_with(&[
            ("border.width", serde_json::json!(2)),
            ("border.color", serde_json::json!("red")),
            ("border.radius", serde_json::json!(6)),
        ]);
        let b = border(&node);
        assert_eq!(b.width, 2.0);
        assert_eq!(b.color, Rgba(0xff, 0, 0, 0xff));
        assert_eq!(b.radius, 6.0);
    }

    #[test]
    fn border_width_color_radius_setters_override_object() {
        let node = node_with(&[
            ("border.width", serde_json::json!(1)),
            ("border.color", serde_json::json!("red")),
            ("border.radius", serde_json::json!(4)),
            ("borderWidth.0", serde_json::json!(3)),
            ("borderColor.0", serde_json::json!("blue")),
            ("borderRadius.0", serde_json::json!(8)),
        ]);
        let b = border(&node);
        assert_eq!(b.width, 3.0);
        assert_eq!(b.color, Rgba(0, 0, 0xff, 0xff));
        assert_eq!(b.radius, 8.0);
    }

    #[test]
    fn border_corner_radius_alias() {
        let node = node_with(&[("cornerRadius.0", serde_json::json!(12))]);
        let b = border(&node);
        assert_eq!(b.radius, 12.0);
    }

    #[test]
    fn border_zero_width_is_not_visible() {
        let node = node_with(&[]);
        let b = border(&node);
        assert!(!b.is_visible());
    }

    #[test]
    fn border_with_transparent_colour_is_not_visible() {
        // Regression: `Rgba::TRANSPARENT == Rgba::default()`, so the
        // earlier "default to black when colour unset" branch couldn't
        // tell `borderColor("transparent")` from "no colour set". Fixed
        // by tracking an `Option<Rgba>` during resolution.
        let node = node_with(&[
            ("border.0", serde_json::json!(2)),
            ("border.color", serde_json::json!("transparent")),
        ]);
        let b = border(&node);
        assert_eq!(b.width, 2.0);
        assert_eq!(b.color.3, 0);
        assert!(!b.is_visible());
    }

    // -----------------------------------------------------------------
    // Phase 12: kebab-case + rem fallbacks (tw-class compatibility)
    // -----------------------------------------------------------------

    #[test]
    fn camel_to_kebab_handles_common_css_names() {
        assert_eq!(camel_to_kebab("backgroundColor"), "background-color");
        assert_eq!(camel_to_kebab("borderColor"), "border-color");
        assert_eq!(camel_to_kebab("fontSize"), "font-size");
        assert_eq!(camel_to_kebab("borderRadius"), "border-radius");
        // No-op when there's no uppercase.
        assert_eq!(camel_to_kebab("color"), "color");
        assert_eq!(camel_to_kebab(""), "");
    }

    #[test]
    fn prop_color_falls_back_to_kebab_for_tw_classes() {
        // .tw("bg-white") expands to `background-color: "#ffffff"` —
        // a kebab-case prop with no `.0` suffix. The renderer must
        // pick it up so cards from tw classes get filled.
        let node = node_with(&[("background-color", serde_json::json!("#ffffff"))]);
        assert_eq!(prop_color(&node, "backgroundColor"), Some(Rgba(0xff, 0xff, 0xff, 0xff)));
    }

    #[test]
    fn explicit_applicator_wins_over_kebab_fallback() {
        // .backgroundColor(red) AND a stale tw-emitted background-color
        // — the explicit applicator's value should win.
        let node = node_with(&[
            ("backgroundColor.0", serde_json::json!("red")),
            ("background-color", serde_json::json!("blue")),
        ]);
        assert_eq!(prop_color(&node, "backgroundColor"), Some(Rgba(0xff, 0, 0, 0xff)));
    }

    #[test]
    fn prop_f32_reads_kebab_font_size_from_tw() {
        // tw `text-lg` → `font-size: "1.125rem"`. The renderer reads
        // it through the kebab fallback and parse_length resolves rem.
        let node = node_with(&[("font-size", serde_json::json!("1.125rem"))]);
        assert!((prop_f32(&node, "fontSize").unwrap() - 18.0).abs() < 0.01);
    }

    #[test]
    fn parse_length_accepts_rem_units() {
        assert_eq!(parse_length("1rem"), Some(16.0));
        assert_eq!(parse_length("1.5rem"), Some(24.0));
        assert_eq!(parse_length("0.5rem"), Some(8.0));
        assert_eq!(parse_length(" 2rem "), Some(32.0));
    }

    #[test]
    fn parse_length_accepts_em_units() {
        assert_eq!(parse_length("1em"), Some(16.0));
        assert_eq!(parse_length("1.25em"), Some(20.0));
    }

    #[test]
    fn parse_length_accepts_bare_and_px() {
        assert_eq!(parse_length("16"), Some(16.0));
        assert_eq!(parse_length("16px"), Some(16.0));
        assert_eq!(parse_length("16.5"), Some(16.5));
    }

    #[test]
    fn parse_length_rejects_unknown_units() {
        // Not yet supported: %, vh, vw, ch.
        assert_eq!(parse_length("50%"), None);
        assert_eq!(parse_length("1vh"), None);
    }

    #[test]
    fn padding_picks_up_tw_kebab_with_rem() {
        // .tw("p-4") → padding: "1rem". Whole-padding shorthand via
        // kebab + rem resolves to 16px on every side.
        let node = node_with(&[("padding", serde_json::json!("1rem"))]);
        let p = padding(&node);
        assert_eq!(p.top, 16.0);
        assert_eq!(p.right, 16.0);
        assert_eq!(p.bottom, 16.0);
        assert_eq!(p.left, 16.0);
    }

    // -----------------------------------------------------------------
    // Phase 15: tw breakpoint resolution
    // -----------------------------------------------------------------

    #[test]
    fn breakpoint_at_returns_base_when_no_bp_keys_present() {
        let node = node_with(&[("padding.0", serde_json::json!(8))]);
        // Any viewport — without any `padding@x` overlays, falls back
        // to the existing chain (returns base 8).
        assert_eq!(prop_f32_at(&node, "padding", 320.0), Some(8.0));
        assert_eq!(prop_f32_at(&node, "padding", 1920.0), Some(8.0));
    }

    #[test]
    fn breakpoint_md_kicks_in_at_768_and_above() {
        // Base 8, override at md (≥768) → 16.
        let node = node_with(&[
            ("padding.0", serde_json::json!(8)),
            ("padding@md", serde_json::json!(16)),
        ]);
        assert_eq!(prop_f32_at(&node, "padding", 320.0), Some(8.0));
        assert_eq!(prop_f32_at(&node, "padding", 767.0), Some(8.0));
        assert_eq!(prop_f32_at(&node, "padding", 768.0), Some(16.0));
        assert_eq!(prop_f32_at(&node, "padding", 1024.0), Some(16.0));
    }

    #[test]
    fn breakpoint_largest_active_wins() {
        // Base 8, md 16, lg 32, xl 64. At 1024px viewport (≥lg, <xl)
        // we want lg=32 — not md, not xl.
        let node = node_with(&[
            ("padding.0", serde_json::json!(8)),
            ("padding@md", serde_json::json!(16)),
            ("padding@lg", serde_json::json!(32)),
            ("padding@xl", serde_json::json!(64)),
            ("padding@2xl", serde_json::json!(128)),
        ]);
        assert_eq!(prop_f32_at(&node, "padding", 320.0), Some(8.0));
        assert_eq!(prop_f32_at(&node, "padding", 768.0), Some(16.0));
        assert_eq!(prop_f32_at(&node, "padding", 1024.0), Some(32.0));
        assert_eq!(prop_f32_at(&node, "padding", 1280.0), Some(64.0));
        assert_eq!(prop_f32_at(&node, "padding", 1536.0), Some(128.0));
    }

    #[test]
    fn breakpoint_skips_intermediate_when_only_md_set() {
        // Base 8, only md set. lg / xl viewports still see md=16,
        // not the base 8 (largest-active fallback).
        let node = node_with(&[
            ("padding.0", serde_json::json!(8)),
            ("padding@md", serde_json::json!(16)),
        ]);
        assert_eq!(prop_f32_at(&node, "padding", 1024.0), Some(16.0));
        assert_eq!(prop_f32_at(&node, "padding", 1920.0), Some(16.0));
    }

    #[test]
    fn breakpoint_str_resolves_color_at_breakpoint() {
        let node = node_with(&[
            ("backgroundColor.0", serde_json::json!("white")),
            ("backgroundColor@md", serde_json::json!("blue")),
        ]);
        assert_eq!(
            prop_color_at(&node, "backgroundColor", 320.0),
            Some(Rgba(0xff, 0xff, 0xff, 0xff))
        );
        assert_eq!(
            prop_color_at(&node, "backgroundColor", 800.0),
            Some(Rgba(0x00, 0x00, 0xff, 0xff))
        );
    }

    #[test]
    fn breakpoint_padding_at_routes_through_resolver() {
        // .tw("p-4 md:p-8") → padding=1rem, padding@md=2rem.
        // At md+ viewport, padding_at picks up the 32px breakpoint
        // value and the kebab+rem decode lands as 32.0.
        let node = node_with(&[
            ("padding", serde_json::json!("1rem")),
            ("padding@md", serde_json::json!("2rem")),
        ]);
        let small = padding_at(&node, 400.0);
        assert_eq!(small.top, 16.0);
        let medium = padding_at(&node, 800.0);
        assert_eq!(medium.top, 32.0);
    }
}
