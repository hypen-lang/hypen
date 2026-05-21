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

/// Read a number prop, checking both `name` and `name.0` (the engine
/// rewrites single-positional applicators to the latter form).
pub fn prop_f32(node: &Node, name: &str) -> Option<f32> {
    let direct = node.props.get(name);
    let dotted = node.props.get(&format!("{name}.0"));
    direct.or(dotted).and_then(value_to_f32)
}

/// Read a string prop, same fallback logic as [`prop_f32`].
pub fn prop_str<'a>(node: &'a Node, name: &str) -> Option<&'a str> {
    let direct = node.props.get(name);
    let dotted = node.props.get(&format!("{name}.0"));
    direct.or(dotted).and_then(Value::as_str)
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

/// Shared box-model reader for `padding` / `margin`. The Hypen DSL gives
/// both shorthand and per-side applicators that all collapse to the same
/// 4-edge `Padding` shape; the precedence ordering matches `padding`'s
/// doc-comment.
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

/// Resolved border style for a node.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Border {
    pub width: f32,
    pub color: Rgba,
    pub radius: f32,
}

impl Border {
    pub fn is_visible(&self) -> bool {
        self.width > 0.0 && self.color.3 > 0
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
    }
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
fn parse_length(s: &str) -> Option<f32> {
    let trimmed = s.trim();
    let stripped = trimmed.strip_suffix("px").unwrap_or(trimmed);
    stripped.trim().parse::<f32>().ok()
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
}
