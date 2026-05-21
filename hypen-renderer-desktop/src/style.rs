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
