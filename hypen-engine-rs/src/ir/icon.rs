use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// A single SVG path within an icon.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IconPath {
    /// SVG path data (the `d` attribute)
    pub d: String,
    /// Fill color (default: "none")
    #[serde(default = "default_fill")]
    pub fill: String,
    /// Stroke color (default: "currentColor")
    #[serde(default = "default_stroke")]
    pub stroke: String,
    /// Stroke width (default: 2.0)
    #[serde(default = "default_stroke_width")]
    pub stroke_width: f64,
    /// Stroke line cap (default: "round")
    #[serde(default = "default_stroke_linecap")]
    pub stroke_linecap: String,
    /// Stroke line join (default: "round")
    #[serde(default = "default_stroke_linejoin")]
    pub stroke_linejoin: String,
}

fn default_fill() -> String {
    "none".to_string()
}
fn default_stroke() -> String {
    "currentColor".to_string()
}
fn default_stroke_width() -> f64 {
    2.0
}
fn default_stroke_linecap() -> String {
    "round".to_string()
}
fn default_stroke_linejoin() -> String {
    "round".to_string()
}

/// A resolved icon containing its SVG path data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IconData {
    /// SVG viewBox (default: "0 0 24 24")
    #[serde(default = "default_viewbox")]
    pub view_box: String,
    /// SVG paths making up this icon
    pub paths: Vec<IconPath>,
}

fn default_viewbox() -> String {
    "0 0 24 24".to_string()
}

/// Registry that maps resource names to their SVG data.
///
/// Resources are a flat name → parsed SVG map. The engine resolves
/// `Icon("heart")` or `Icon(@resources.heart)` into concrete SVG paths
/// at render time, so the patch sent to the client carries pre-resolved data.
#[derive(Debug, Default)]
pub struct ResourceRegistry {
    /// Resources indexed by name
    resources: IndexMap<String, IconData>,
}

impl ResourceRegistry {
    pub fn new() -> Self {
        Self {
            resources: IndexMap::new(),
        }
    }

    /// Register a single resource from raw SVG content.
    pub fn register(&mut self, name: &str, svg: &str) {
        self.resources.insert(name.to_string(), parse_svg(svg));
    }

    /// Register multiple resources from a name → SVG map.
    pub fn register_map(&mut self, map: IndexMap<String, String>) {
        for (name, svg) in map {
            self.resources.insert(name, parse_svg(&svg));
        }
    }

    /// Resolve a resource by name.
    pub fn resolve(&self, name: &str) -> Option<&IconData> {
        self.resources.get(name)
    }

    /// Convert resolved icon data to props that will be sent in the Create patch.
    /// Returns a serde_json::Value map containing `paths`, `viewBox`, etc.
    pub fn to_props(icon: &IconData) -> serde_json::Value {
        let paths: Vec<serde_json::Value> = icon
            .paths
            .iter()
            .map(|p| {
                serde_json::json!({
                    "d": p.d,
                    "fill": p.fill,
                    "stroke": p.stroke,
                    "strokeWidth": p.stroke_width,
                    "strokeLinecap": p.stroke_linecap,
                    "strokeLinejoin": p.stroke_linejoin,
                })
            })
            .collect();

        serde_json::json!({
            "paths": paths,
            "viewBox": icon.view_box,
        })
    }

    /// Check if the registry has any registered resources.
    pub fn is_empty(&self) -> bool {
        self.resources.is_empty()
    }
}

// ── SVG Parsing ─────────────────────────────────────────────────────────

/// Parse an SVG string and extract icon data (viewBox + paths).
///
/// Extracts `<path>` elements and converts `<circle>`, `<rect>`, `<line>`,
/// `<polyline>`, and `<polygon>` to path equivalents.
///
/// ```rust
/// # use hypen_engine::ir::icon::parse_svg;
/// let svg = r#"<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>"#;
/// let icon = parse_svg(svg);
/// assert_eq!(icon.view_box, "0 0 24 24");
/// assert_eq!(icon.paths.len(), 1);
/// assert_eq!(icon.paths[0].d, "M5 12h14");
/// ```
pub fn parse_svg(svg: &str) -> IconData {
    let root = RootDefaults::extract(svg);
    let view_box = root
        .view_box
        .clone()
        .unwrap_or_else(|| "0 0 24 24".to_string());
    let mut paths = Vec::new();

    // Extract <path> elements
    for cap in RegexLite::new(r#"<path\s+([^>]*?)/?>(?:</path>)?"#, svg) {
        if let Some(attrs) = cap {
            if let Some(path) = parse_path_attrs(&attrs, &root) {
                paths.push(path);
            }
        }
    }

    // Extract <circle> elements
    for cap in RegexLite::new(r#"<circle\s+([^>]*?)/?>(?:</circle>)?"#, svg) {
        if let Some(attrs) = cap {
            if let Some(path) = circle_to_path(&attrs, &root) {
                paths.push(path);
            }
        }
    }

    // Extract <line> elements
    for cap in RegexLite::new(r#"<line\s+([^>]*?)/?>(?:</line>)?"#, svg) {
        if let Some(attrs) = cap {
            if let Some(path) = line_to_path(&attrs, &root) {
                paths.push(path);
            }
        }
    }

    // Extract <rect> elements
    for cap in RegexLite::new(r#"<rect\s+([^>]*?)/?>(?:</rect>)?"#, svg) {
        if let Some(attrs) = cap {
            if let Some(path) = rect_to_path(&attrs, &root) {
                paths.push(path);
            }
        }
    }

    IconData { view_box, paths }
}

/// Presentation attributes extracted from the `<svg>` root element.
///
/// SVG allows presentation attributes like `stroke-width` on the root to
/// apply as defaults to any child element that doesn't specify its own.
/// Heroicons v2 relies on this — the `<path>` elements are bare and all
/// styling lives on `<svg>`. Without inheritance the child defaults kick
/// in (e.g. `stroke_width = 2.0`) and icons render at the wrong weight.
#[derive(Debug, Default, Clone)]
struct RootDefaults {
    view_box: Option<String>,
    fill: Option<String>,
    stroke: Option<String>,
    stroke_width: Option<f64>,
    stroke_linecap: Option<String>,
    stroke_linejoin: Option<String>,
}

impl RootDefaults {
    /// Extract presentation attributes from the `<svg ...>` opening tag.
    ///
    /// Scoping matters: `extract_attr` does a plain substring search over its
    /// input, so calling it on the whole SVG would match the first occurrence
    /// of e.g. `stroke-width=` — which might live on a child `<path>` element.
    /// We isolate the opening-tag substring first so root lookups only see
    /// root attributes.
    fn extract(svg: &str) -> Self {
        let lower = svg.to_lowercase();
        let Some(svg_start) = lower.find("<svg") else {
            return Self::default();
        };
        let after = &svg[svg_start + 4..];
        // Find the end of the opening tag. `>` always terminates it; `/>`
        // also terminates it but is a prefix of `>`, so `find('>')` catches
        // both cases correctly.
        let Some(end) = after.find('>') else {
            return Self::default();
        };
        let root_attrs = &after[..end];

        Self {
            view_box: extract_attr(root_attrs, "viewBox"),
            fill: extract_attr(root_attrs, "fill"),
            stroke: extract_attr(root_attrs, "stroke"),
            stroke_width: extract_attr(root_attrs, "stroke-width").and_then(|s| s.parse().ok()),
            stroke_linecap: extract_attr(root_attrs, "stroke-linecap"),
            stroke_linejoin: extract_attr(root_attrs, "stroke-linejoin"),
        }
    }
}

/// Load an icon pack from a directory of SVG files.
///
// ── SVG Parsing Helpers ─────────────────────────────────────────────

/// Minimal regex-like matcher for SVG attribute extraction.
/// We avoid pulling in the regex crate by using simple string searching.
struct RegexLite<'a> {
    tag_start: &'a str,
    source: &'a str,
    pos: usize,
}

impl<'a> RegexLite<'a> {
    fn new(pattern: &'a str, source: &'a str) -> Self {
        // Extract the tag name from pattern like `<path\s+...`
        let tag_start = if pattern.contains("<path") {
            "<path"
        } else if pattern.contains("<circle") {
            "<circle"
        } else if pattern.contains("<line") {
            "<line"
        } else if pattern.contains("<rect") {
            "<rect"
        } else {
            "<unknown"
        };
        Self {
            tag_start,
            source,
            pos: 0,
        }
    }
}

impl<'a> Iterator for RegexLite<'a> {
    type Item = Option<String>;

    fn next(&mut self) -> Option<Self::Item> {
        let remaining = &self.source[self.pos..];
        // Case-insensitive search for tag
        let lower = remaining.to_lowercase();
        let tag_lower = self.tag_start.to_lowercase();

        if let Some(start) = lower.find(&tag_lower) {
            let abs_start = self.pos + start + self.tag_start.len();
            let after = &self.source[abs_start..];

            // Find the end of the tag (either /> or >)
            if let Some(end) = after.find("/>").or_else(|| after.find('>')) {
                let attrs = after[..end].trim().to_string();
                self.pos = abs_start + end + 2;
                Some(Some(attrs))
            } else {
                self.pos = self.source.len();
                None
            }
        } else {
            None
        }
    }
}

fn extract_attr(source: &str, name: &str) -> Option<String> {
    // Look for name="value" or name='value'
    let patterns = [format!("{}=\"", name), format!("{}='", name)];

    for pattern in &patterns {
        if let Some(start) = source.find(pattern.as_str()) {
            let value_start = start + pattern.len();
            let delim = if pattern.ends_with('"') { '"' } else { '\'' };
            if let Some(end) = source[value_start..].find(delim) {
                return Some(source[value_start..value_start + end].to_string());
            }
        }
    }
    None
}

/// Resolve a string presentation attribute with element → root → fallback precedence.
fn resolve_str(attrs: &str, name: &str, root: Option<&String>, fallback: &str) -> String {
    extract_attr(attrs, name)
        .or_else(|| root.cloned())
        .unwrap_or_else(|| fallback.to_string())
}

/// Resolve stroke-width with element → root → fallback precedence.
fn resolve_stroke_width(attrs: &str, root: Option<f64>) -> f64 {
    extract_attr(attrs, "stroke-width")
        .and_then(|s| s.parse().ok())
        .or(root)
        .unwrap_or(2.0)
}

fn parse_path_attrs(attrs: &str, root: &RootDefaults) -> Option<IconPath> {
    let d = extract_attr(attrs, "d")?;
    if d.is_empty() {
        return None;
    }

    Some(IconPath {
        d,
        fill: resolve_str(attrs, "fill", root.fill.as_ref(), "none"),
        stroke: resolve_str(attrs, "stroke", root.stroke.as_ref(), "currentColor"),
        stroke_width: resolve_stroke_width(attrs, root.stroke_width),
        stroke_linecap: resolve_str(
            attrs,
            "stroke-linecap",
            root.stroke_linecap.as_ref(),
            "round",
        ),
        stroke_linejoin: resolve_str(
            attrs,
            "stroke-linejoin",
            root.stroke_linejoin.as_ref(),
            "round",
        ),
    })
}

fn circle_to_path(attrs: &str, root: &RootDefaults) -> Option<IconPath> {
    let cx: f64 = extract_attr(attrs, "cx")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    let cy: f64 = extract_attr(attrs, "cy")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    let r: f64 = extract_attr(attrs, "r")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    if r <= 0.0 {
        return None;
    }

    let d = format!(
        "M{},{} a{},{} 0 1,0 {},0 a{},{} 0 1,0 -{},0",
        cx - r,
        cy,
        r,
        r,
        r * 2.0,
        r,
        r,
        r * 2.0
    );

    Some(IconPath {
        d,
        fill: resolve_str(attrs, "fill", root.fill.as_ref(), "none"),
        stroke: resolve_str(attrs, "stroke", root.stroke.as_ref(), "currentColor"),
        stroke_width: resolve_stroke_width(attrs, root.stroke_width),
        stroke_linecap: resolve_str(
            attrs,
            "stroke-linecap",
            root.stroke_linecap.as_ref(),
            "round",
        ),
        stroke_linejoin: resolve_str(
            attrs,
            "stroke-linejoin",
            root.stroke_linejoin.as_ref(),
            "round",
        ),
    })
}

fn line_to_path(attrs: &str, root: &RootDefaults) -> Option<IconPath> {
    let x1 = extract_attr(attrs, "x1").unwrap_or_else(|| "0".to_string());
    let y1 = extract_attr(attrs, "y1").unwrap_or_else(|| "0".to_string());
    let x2 = extract_attr(attrs, "x2").unwrap_or_else(|| "0".to_string());
    let y2 = extract_attr(attrs, "y2").unwrap_or_else(|| "0".to_string());

    let d = format!("M{},{}L{},{}", x1, y1, x2, y2);

    Some(IconPath {
        d,
        fill: resolve_str(attrs, "fill", root.fill.as_ref(), "none"),
        stroke: resolve_str(attrs, "stroke", root.stroke.as_ref(), "currentColor"),
        stroke_width: resolve_stroke_width(attrs, root.stroke_width),
        stroke_linecap: resolve_str(
            attrs,
            "stroke-linecap",
            root.stroke_linecap.as_ref(),
            "round",
        ),
        stroke_linejoin: resolve_str(
            attrs,
            "stroke-linejoin",
            root.stroke_linejoin.as_ref(),
            "round",
        ),
    })
}

fn rect_to_path(attrs: &str, root: &RootDefaults) -> Option<IconPath> {
    let x: f64 = extract_attr(attrs, "x")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    let y: f64 = extract_attr(attrs, "y")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    let w: f64 = extract_attr(attrs, "width")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    let h: f64 = extract_attr(attrs, "height")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    if w <= 0.0 || h <= 0.0 {
        return None;
    }

    let d = format!("M{},{}h{}v{}h-{}z", x, y, w, h, w);

    Some(IconPath {
        d,
        fill: resolve_str(attrs, "fill", root.fill.as_ref(), "none"),
        stroke: resolve_str(attrs, "stroke", root.stroke.as_ref(), "currentColor"),
        stroke_width: resolve_stroke_width(attrs, root.stroke_width),
        stroke_linecap: resolve_str(
            attrs,
            "stroke-linecap",
            root.stroke_linecap.as_ref(),
            "round",
        ),
        stroke_linejoin: resolve_str(
            attrs,
            "stroke-linejoin",
            root.stroke_linejoin.as_ref(),
            "round",
        ),
    })
}

/// Walk an IR tree and resolve all `Icon` elements and `@resources` references
/// against the given resource registry.
///
/// For each `Icon` element found, this extracts the icon name from:
/// - Static string: `Icon("heart")` → positional arg "0" or named "name"
/// - Resource reference: `Icon(@resources.heart)` → `Value::Resource("heart")`
///
/// Then resolves via the registry and injects `__iconPaths` and `__iconViewBox`
/// props so the renderer receives pre-resolved SVG path data in the patch.
///
/// This is the shared implementation used by all engine variants (WASM, WASI,
/// native Rust, UniFFI).
pub fn resolve_icons_in_ir(registry: &ResourceRegistry, node: &mut super::IRNode) {
    use super::{IRNode, Value};

    crate::ir::walk::walk_ir_mut(node, &mut |n| {
        let IRNode::Element(element) = n else { return };
        if element.element_type != "Icon" {
            return;
        }

        // Extract icon name from:
        // 1. Resource reference: Icon(@resources.heart) → Value::Resource("heart")
        // 2. Static string: Icon("heart") → Value::Static("heart")
        let icon_name = element
            .props
            .get("0")
            .or_else(|| element.props.get("name"))
            .and_then(|v| match v {
                Value::Resource(name) => Some(name.clone()),
                Value::Static(serde_json::Value::String(s)) => Some(s.clone()),
                _ => None,
            });

        let Some(name) = icon_name else { return };
        let Some(icon_data) = registry.resolve(&name) else {
            return;
        };
        let icon_props = ResourceRegistry::to_props(icon_data);

        if let Some(paths) = icon_props.get("paths") {
            element
                .props
                .insert("__iconPaths".to_string(), Value::Static(paths.clone()));
        }

        if let Some(view_box) = icon_props.get("viewBox") {
            element
                .props
                .insert("__iconViewBox".to_string(), Value::Static(view_box.clone()));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_svg_inherits_root_presentation_attributes() {
        // Heroicons v2 layout: all presentation attributes on <svg>, bare <path>.
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"/></svg>"#;
        let icon = parse_svg(svg);
        assert_eq!(icon.paths.len(), 1);
        let p = &icon.paths[0];
        assert_eq!(
            p.stroke_width, 1.5,
            "stroke-width=1.5 from <svg> root should be inherited, got {}",
            p.stroke_width
        );
        assert_eq!(p.stroke, "currentColor");
        assert_eq!(p.fill, "none");
        assert_eq!(p.stroke_linecap, "round");
        assert_eq!(p.stroke_linejoin, "round");
    }

    #[test]
    fn test_parse_svg_child_attributes_override_root() {
        // When a child element has its own presentation attributes, they must
        // win over the inherited root values.
        let svg = r#"<svg viewBox="0 0 24 24" stroke="red" stroke-width="1.5"><path d="M0 0L10 10" stroke="blue" stroke-width="3"/></svg>"#;
        let icon = parse_svg(svg);
        assert_eq!(icon.paths[0].stroke, "blue");
        assert_eq!(icon.paths[0].stroke_width, 3.0);
    }

    #[test]
    fn test_parse_svg_root_scoping_does_not_leak_from_children() {
        // If root-attribute extraction ran over the whole document instead of
        // the opening-tag substring, this path's `stroke-width="5"` would
        // incorrectly become the "root" default for other children.
        let svg = r#"<svg viewBox="0 0 24 24"><path d="M0 0L10 10" stroke-width="5"/><path d="M1 1L2 2"/></svg>"#;
        let icon = parse_svg(svg);
        assert_eq!(icon.paths.len(), 2);
        assert_eq!(
            icon.paths[0].stroke_width, 5.0,
            "first path carries its own width"
        );
        assert_eq!(
            icon.paths[1].stroke_width, 2.0,
            "second path must fall back to hardcoded 2.0, not inherit from sibling"
        );
    }

    #[test]
    fn test_parse_svg_no_root_tag_falls_back_to_defaults() {
        // Defensive: a fragment with no <svg> wrapper should still parse, with
        // all presentation attributes falling back to hardcoded defaults.
        let svg = r#"<path d="M5 12h14"/>"#;
        let icon = parse_svg(svg);
        assert_eq!(icon.paths.len(), 1);
        assert_eq!(icon.paths[0].stroke_width, 2.0);
        assert_eq!(icon.paths[0].stroke, "currentColor");
        assert_eq!(icon.paths[0].fill, "none");
    }

    #[test]
    fn test_register_and_resolve() {
        let mut registry = ResourceRegistry::new();

        // Register from raw SVG
        registry.register(
            "heart",
            r#"<svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" stroke="currentColor"/></svg>"#,
        );

        // Resolve by name
        let icon = registry.resolve("heart");
        assert!(icon.is_some());
        assert_eq!(icon.unwrap().paths.len(), 1);

        // Missing resource
        let icon = registry.resolve("missing");
        assert!(icon.is_none());
    }

    #[test]
    fn test_register_map() {
        let mut registry = ResourceRegistry::new();
        let mut map = IndexMap::new();
        map.insert(
            "arrow".to_string(),
            r#"<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>"#.to_string(),
        );
        map.insert(
            "star".to_string(),
            r#"<svg viewBox="0 0 24 24"><path d="M12 2l3 7h7"/></svg>"#.to_string(),
        );
        registry.register_map(map);

        assert!(registry.resolve("arrow").is_some());
        assert!(registry.resolve("star").is_some());
        assert!(registry.resolve("missing").is_none());
    }

    #[test]
    fn test_to_props() {
        let icon = IconData {
            view_box: "0 0 24 24".to_string(),
            paths: vec![IconPath {
                d: "M5 12h14".to_string(),
                fill: "none".to_string(),
                stroke: "currentColor".to_string(),
                stroke_width: 2.0,
                stroke_linecap: "round".to_string(),
                stroke_linejoin: "round".to_string(),
            }],
        };

        let props = ResourceRegistry::to_props(&icon);
        assert_eq!(props["viewBox"], "0 0 24 24");
        assert!(props["paths"].is_array());
        assert_eq!(props["paths"][0]["d"], "M5 12h14");
        assert_eq!(props["paths"][0]["stroke"], "currentColor");
    }

    #[test]
    fn test_parse_svg_basic_path() {
        let svg = r#"<svg viewBox="0 0 24 24"><path d="M5 12h14" stroke="currentColor"/></svg>"#;
        let icon = parse_svg(svg);
        assert_eq!(icon.view_box, "0 0 24 24");
        assert_eq!(icon.paths.len(), 1);
        assert_eq!(icon.paths[0].d, "M5 12h14");
    }

    #[test]
    fn test_parse_svg_multiple_paths() {
        let svg = r#"<svg viewBox="0 0 24 24">
            <path d="M5 12h14" stroke="currentColor"/>
            <path d="M12 5v14" stroke="red" stroke-width="3"/>
        </svg>"#;
        let icon = parse_svg(svg);
        assert_eq!(icon.paths.len(), 2);
        assert_eq!(icon.paths[0].d, "M5 12h14");
        assert_eq!(icon.paths[1].d, "M12 5v14");
        assert_eq!(icon.paths[1].stroke, "red");
        assert_eq!(icon.paths[1].stroke_width, 3.0);
    }

    #[test]
    fn test_parse_svg_default_viewbox() {
        let svg = r#"<svg><path d="M0 0L10 10"/></svg>"#;
        let icon = parse_svg(svg);
        assert_eq!(icon.view_box, "0 0 24 24");
    }

    #[test]
    fn test_parse_svg_circle() {
        let svg = r#"<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>"#;
        let icon = parse_svg(svg);
        assert_eq!(icon.paths.len(), 1);
        assert!(icon.paths[0].d.starts_with("M2,12"));
    }

    #[test]
    fn test_parse_svg_rect() {
        let svg = r#"<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20"/></svg>"#;
        let icon = parse_svg(svg);
        assert_eq!(icon.paths.len(), 1);
        assert_eq!(icon.paths[0].d, "M2,2h20v20h-20z");
    }

    #[test]
    fn test_parse_svg_line() {
        let svg = r#"<svg viewBox="0 0 24 24"><line x1="0" y1="0" x2="24" y2="24"/></svg>"#;
        let icon = parse_svg(svg);
        assert_eq!(icon.paths.len(), 1);
        assert_eq!(icon.paths[0].d, "M0,0L24,24");
    }

    #[test]
    fn test_parse_svg_empty_path_skipped() {
        let svg = r#"<svg><path d=""/></svg>"#;
        let icon = parse_svg(svg);
        assert_eq!(icon.paths.len(), 0);
    }

    #[test]
    fn test_parse_svg_zero_radius_circle_skipped() {
        let svg = r#"<svg><circle cx="12" cy="12" r="0"/></svg>"#;
        let icon = parse_svg(svg);
        assert_eq!(icon.paths.len(), 0);
    }

    #[test]
    fn test_resolve_icon_via_resource_reference() {
        use crate::ir::{Element, IRNode, Value};

        let mut registry = ResourceRegistry::new();
        registry.register(
            "heart",
            r#"<svg viewBox="0 0 24 24"><path d="M20 4.6L12 21z" stroke="currentColor"/></svg>"#,
        );

        // Simulate Icon(@resources.heart) — prop "0" is Value::Resource("heart")
        let mut element = Element::new("Icon");
        element
            .props
            .insert("0".to_string(), Value::Resource("heart".to_string()));
        let mut node = IRNode::Element(element);

        resolve_icons_in_ir(&registry, &mut node);

        if let IRNode::Element(el) = &node {
            assert!(
                el.props.contains_key("__iconPaths"),
                "Should inject __iconPaths"
            );
            assert!(
                el.props.contains_key("__iconViewBox"),
                "Should inject __iconViewBox"
            );
            match el.props.get("__iconViewBox").unwrap() {
                Value::Static(v) => assert_eq!(v, "0 0 24 24"),
                other => panic!("Expected Static viewBox, got: {:?}", other),
            }
        } else {
            panic!("Expected Element");
        }
    }

    #[test]
    fn test_resolve_icon_via_static_string() {
        use crate::ir::{Element, IRNode, Value};

        let mut registry = ResourceRegistry::new();
        registry.register(
            "star",
            r#"<svg viewBox="0 0 24 24"><path d="M12 2l3 7h7"/></svg>"#,
        );

        // Simulate Icon("star") — prop "0" is Value::Static("star")
        let mut element = Element::new("Icon");
        element
            .props
            .insert("0".to_string(), Value::Static(serde_json::json!("star")));
        let mut node = IRNode::Element(element);

        resolve_icons_in_ir(&registry, &mut node);

        if let IRNode::Element(el) = &node {
            assert!(el.props.contains_key("__iconPaths"));
        } else {
            panic!("Expected Element");
        }
    }

    #[test]
    fn test_resolve_icon_missing_resource() {
        use crate::ir::{Element, IRNode, Value};

        let registry = ResourceRegistry::new(); // empty

        let mut element = Element::new("Icon");
        element
            .props
            .insert("0".to_string(), Value::Resource("nonexistent".to_string()));
        let mut node = IRNode::Element(element);

        resolve_icons_in_ir(&registry, &mut node);

        if let IRNode::Element(el) = &node {
            assert!(
                !el.props.contains_key("__iconPaths"),
                "Should not inject paths for missing resource"
            );
        } else {
            panic!("Expected Element");
        }
    }
}
