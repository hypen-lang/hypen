//! SVG icon rasterisation.
//!
//! The engine pre-parses `Icon` resources into a structured shape:
//! a `viewBox` plus a list of paths whose `d` attribute is the SVG
//! path-data string and whose fill / stroke / stroke-width are
//! already resolved. We render each path with `tiny-skia` after
//! parsing the `d` via `svgtypes`.
//!
//! Phase 15 v1 supports the path commands every Hypen-bundled icon
//! set uses: `M`, `L`, `H`, `V`, `C`, `S`, `Q`, `T`, `A`, `Z` (both
//! cases). Anything else is silently dropped.

use crate::layout::Rect as LayoutRect;
use crate::style::Rgba;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use indexmap::IndexMap;
use svgtypes::PathSegment;
use tiny_skia::{
    FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, PixmapPaint, PixmapRef, Stroke,
    Transform,
};

/// Cap on cached icon rasterisations. ~128 unique
/// (paths, viewBox, tint, w, h) combinations covers a busy chrome
/// (every header / nav / action icon once); avg pixmap ~3 KB so
/// memory is bounded near 400 KB.
const ICON_RASTER_CACHE_CAP: usize = 128;

/// Per-painter cache of pre-rasterised icon pixmaps. Lives on the
/// painter so the cache lifetime matches the surface; freed at the
/// same time `Pixmap` reallocs would invalidate stale renders.
#[derive(Default)]
pub struct IconRasterCache {
    /// Insertion-ordered for FIFO single-entry eviction at cap.
    entries: IndexMap<u64, Pixmap>,
}

impl IconRasterCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

/// One stroked / filled path inside an SVG icon. Mirrors the engine's
/// `IconPath` so we can deserialise straight from the `paths` prop.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconPath {
    pub d: String,
    #[serde(default)]
    pub fill: Option<String>,
    #[serde(default)]
    pub stroke: Option<String>,
    #[serde(default)]
    pub stroke_width: Option<f32>,
    #[serde(default)]
    pub stroke_linecap: Option<String>,
    #[serde(default)]
    pub stroke_linejoin: Option<String>,
}

/// Read the `paths` prop on an `Icon` node and decode it into our
/// local `IconPath` list. Returns an empty vec when the prop is
/// missing / wrong-shaped — the painter then renders a placeholder.
pub fn parse_paths(value: &Value) -> Vec<IconPath> {
    serde_json::from_value(value.clone()).unwrap_or_default()
}

/// Read `viewBox` ("min-x min-y width height") into a tuple. Defaults
/// to `0 0 24 24` when missing or malformed — the usual Hypen /
/// Lucide / Heroicons box.
pub fn parse_view_box(s: Option<&str>) -> (f32, f32, f32, f32) {
    let default = (0.0_f32, 0.0_f32, 24.0_f32, 24.0_f32);
    let Some(s) = s else { return default };
    let mut it = s.split_ascii_whitespace().filter_map(|t| t.parse::<f32>().ok());
    match (it.next(), it.next(), it.next(), it.next()) {
        (Some(a), Some(b), Some(c), Some(d)) if c > 0.0 && d > 0.0 => (a, b, c, d),
        _ => default,
    }
}

/// Convert one SVG path's `d` string into a tiny-skia [`Path`].
/// Returns `None` if the path data is empty or doesn't produce a
/// closeable shape (which tiny-skia rejects).
pub fn build_path(d: &str) -> Option<tiny_skia::Path> {
    let mut pb = PathBuilder::new();
    let mut cx = 0.0_f32;
    let mut cy = 0.0_f32;
    let mut subpath_start = (0.0_f32, 0.0_f32);
    // Track the previous control point for `S` / `T` smoothing.
    let mut last_cubic_ctrl: Option<(f32, f32)> = None;
    let mut last_quad_ctrl: Option<(f32, f32)> = None;

    for seg in svgtypes::PathParser::from(d).flatten() {
        match seg {
            PathSegment::MoveTo { abs, x, y } => {
                let (x, y) = absify(abs, cx, cy, x as f32, y as f32);
                pb.move_to(x, y);
                cx = x;
                cy = y;
                subpath_start = (x, y);
                last_cubic_ctrl = None;
                last_quad_ctrl = None;
            }
            PathSegment::LineTo { abs, x, y } => {
                let (x, y) = absify(abs, cx, cy, x as f32, y as f32);
                pb.line_to(x, y);
                cx = x;
                cy = y;
                last_cubic_ctrl = None;
                last_quad_ctrl = None;
            }
            PathSegment::HorizontalLineTo { abs, x } => {
                let nx = if abs { x as f32 } else { cx + x as f32 };
                pb.line_to(nx, cy);
                cx = nx;
                last_cubic_ctrl = None;
                last_quad_ctrl = None;
            }
            PathSegment::VerticalLineTo { abs, y } => {
                let ny = if abs { y as f32 } else { cy + y as f32 };
                pb.line_to(cx, ny);
                cy = ny;
                last_cubic_ctrl = None;
                last_quad_ctrl = None;
            }
            PathSegment::CurveTo { abs, x1, y1, x2, y2, x, y } => {
                let (x1, y1) = absify(abs, cx, cy, x1 as f32, y1 as f32);
                let (x2, y2) = absify(abs, cx, cy, x2 as f32, y2 as f32);
                let (x, y) = absify(abs, cx, cy, x as f32, y as f32);
                pb.cubic_to(x1, y1, x2, y2, x, y);
                cx = x;
                cy = y;
                last_cubic_ctrl = Some((x2, y2));
                last_quad_ctrl = None;
            }
            PathSegment::SmoothCurveTo { abs, x2, y2, x, y } => {
                // Reflect previous cubic control point through current
                // position; if we don't have one, use current as the
                // first control (per SVG spec).
                let (x1, y1) = match last_cubic_ctrl {
                    Some((px, py)) => (2.0 * cx - px, 2.0 * cy - py),
                    None => (cx, cy),
                };
                let (x2, y2) = absify(abs, cx, cy, x2 as f32, y2 as f32);
                let (x, y) = absify(abs, cx, cy, x as f32, y as f32);
                pb.cubic_to(x1, y1, x2, y2, x, y);
                cx = x;
                cy = y;
                last_cubic_ctrl = Some((x2, y2));
                last_quad_ctrl = None;
            }
            PathSegment::Quadratic { abs, x1, y1, x, y } => {
                let (x1, y1) = absify(abs, cx, cy, x1 as f32, y1 as f32);
                let (x, y) = absify(abs, cx, cy, x as f32, y as f32);
                pb.quad_to(x1, y1, x, y);
                cx = x;
                cy = y;
                last_quad_ctrl = Some((x1, y1));
                last_cubic_ctrl = None;
            }
            PathSegment::SmoothQuadratic { abs, x, y } => {
                let (x1, y1) = match last_quad_ctrl {
                    Some((px, py)) => (2.0 * cx - px, 2.0 * cy - py),
                    None => (cx, cy),
                };
                let (x, y) = absify(abs, cx, cy, x as f32, y as f32);
                pb.quad_to(x1, y1, x, y);
                cx = x;
                cy = y;
                last_quad_ctrl = Some((x1, y1));
                last_cubic_ctrl = None;
            }
            PathSegment::EllipticalArc { abs, x, y, .. } => {
                // Approximation: Hypen's bundled icon sets don't emit
                // arcs in any path we've seen; approximate as a
                // straight line so we don't drop the segment entirely.
                let (x, y) = absify(abs, cx, cy, x as f32, y as f32);
                pb.line_to(x, y);
                cx = x;
                cy = y;
                last_cubic_ctrl = None;
                last_quad_ctrl = None;
            }
            PathSegment::ClosePath { .. } => {
                pb.close();
                cx = subpath_start.0;
                cy = subpath_start.1;
                last_cubic_ctrl = None;
                last_quad_ctrl = None;
            }
        }
    }

    pb.finish()
}

#[inline]
fn absify(abs: bool, cx: f32, cy: f32, x: f32, y: f32) -> (f32, f32) {
    if abs {
        (x, y)
    } else {
        (cx + x, cy + y)
    }
}

/// Fill / stroke `paths` into `rect` on `pixmap`. The `view_box` is
/// (min_x, min_y, w, h); we compute a uniform-scale + centring
/// transform so the icon fits the rect with its aspect preserved.
pub fn paint_icon(
    pixmap: &mut Pixmap,
    rect: LayoutRect,
    paths: &[IconPath],
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
    let scale = (rect.w / vw).min(rect.h / vh);
    // Centre the icon inside the rect.
    let dx = rect.x + (rect.w - vw * scale) * 0.5 - vx * scale;
    let dy = rect.y + (rect.h - vh * scale) * 0.5 - vy * scale;
    let transform = Transform::from_scale(scale, scale).post_translate(dx, dy);

    for p in paths {
        let path = match build_path(&p.d) {
            Some(path) => path,
            None => continue,
        };

        // Fill. SVG semantics: a path with `fill="none"` is *not*
        // filled, even when the user supplied a `.color(...)` tint —
        // tint replaces fill colour, it does not introduce one. Same
        // gate for `currentColor` (delegate to tint) and missing
        // (treat as if the user said "use the default fill").
        // Lucide-style outline icons all set `fill="none"`; without
        // this gate, tinting them would also fill every path,
        // producing solid blobs and triggering tiny-skia "horizontal
        // line cannot be filled" warnings on H / V strokes.
        let fill_attr = p.fill.as_deref();
        let fill_disabled = matches!(fill_attr, Some("none") | Some("transparent"));
        let fill_color = if fill_disabled {
            None
        } else if matches!(fill_attr, None | Some("currentColor")) {
            tint
        } else {
            tint.or_else(|| fill_attr.and_then(crate::style::parse_color))
        };
        if let Some(fill_color) = fill_color {
            if fill_color.3 > 0 {
                let mut paint = Paint::default();
                let [r, g, b, a] = fill_color.premultiplied();
                paint.set_color(
                    tiny_skia::Color::from_rgba(
                        r as f32 / 255.0,
                        g as f32 / 255.0,
                        b as f32 / 255.0,
                        a as f32 / 255.0,
                    )
                    .unwrap_or(tiny_skia::Color::BLACK),
                );
                paint.anti_alias = true;
                pixmap.fill_path(&path, &paint, FillRule::Winding, transform, None);
            }
        }

        // Stroke. Symmetric to fill: `stroke="none"` opts out, even
        // when tint is set; `currentColor` and missing both delegate
        // to tint (with a sensible BLACK fallback — Lucide icons
        // ship with `stroke="currentColor"` and rely entirely on the
        // host to colour them).
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
        if let Some(stroke_color) = stroke_color {
            if stroke_color.3 > 0 {
                let width = p.stroke_width.unwrap_or(1.0);
                if width > 0.0 {
                    let mut paint = Paint::default();
                    let [r, g, b, a] = stroke_color.premultiplied();
                    paint.set_color(
                        tiny_skia::Color::from_rgba(
                            r as f32 / 255.0,
                            g as f32 / 255.0,
                            b as f32 / 255.0,
                            a as f32 / 255.0,
                        )
                        .unwrap_or(tiny_skia::Color::BLACK),
                    );
                    paint.anti_alias = true;
                    let stroke = Stroke {
                        width,
                        line_cap: line_cap_from(p.stroke_linecap.as_deref()),
                        line_join: line_join_from(p.stroke_linejoin.as_deref()),
                        ..Default::default()
                    };
                    pixmap.stroke_path(&path, &paint, &stroke, transform, None);
                }
            }
        }
    }
}

/// Composite a cached icon raster onto `pixmap` if one exists for
/// the given inputs; otherwise rasterise into a fresh small pixmap
/// (sized to the rect), cache it, and composite.
///
/// Cache key: `(paths shape + colours + widths, viewBox, tint, w, h)`.
/// Subsequent paints of the same icon at the same size become a single
/// `draw_pixmap` instead of re-parsing every `d`-string + retessellating
/// every path. On a typical Lucide-icon-heavy header that's ~10
/// `tiny-skia` `stroke_path` calls per icon collapsed to one bilinear
/// blit.
pub fn paint_icon_cached(
    pixmap: &mut Pixmap,
    rect: LayoutRect,
    paths: &[IconPath],
    view_box: (f32, f32, f32, f32),
    tint: Option<Rgba>,
    cache: &mut IconRasterCache,
) {
    if rect.w <= 0.0 || rect.h <= 0.0 || paths.is_empty() {
        return;
    }
    let cw = rect.w.ceil().max(1.0) as u32;
    let ch = rect.h.ceil().max(1.0) as u32;
    let key = icon_cache_key(paths, view_box, tint, cw, ch);
    if !cache.entries.contains_key(&key) {
        let mut tile = match Pixmap::new(cw, ch) {
            Some(p) => p,
            None => {
                paint_icon(pixmap, rect, paths, view_box, tint);
                return;
            }
        };
        // Render at origin (0,0) of the tile, dimensions `(cw, ch)`.
        let local_rect = LayoutRect {
            x: 0.0,
            y: 0.0,
            w: cw as f32,
            h: ch as f32,
        };
        paint_icon(&mut tile, local_rect, paths, view_box, tint);
        if cache.entries.len() >= ICON_RASTER_CACHE_CAP {
            // FIFO single-entry eviction. Wholesale clear caused
            // big re-tessellation bursts whenever the cache filled.
            cache.entries.shift_remove_index(0);
        }
        cache.entries.insert(key, tile);
    }
    let tile = cache.entries.get(&key).expect("inserted above");
    // Integer translate keeps the alpha-anti-aliased icon edges
    // crisp; fractional offsets force a sampler resample and blur.
    let transform = Transform::from_translate(rect.x.round(), rect.y.round());
    pixmap.draw_pixmap(
        0,
        0,
        PixmapRef::from_bytes(tile.data(), tile.width(), tile.height())
            .expect("tile bytes valid"),
        &PixmapPaint::default(),
        transform,
        None,
    );
}

fn icon_cache_key(
    paths: &[IconPath],
    view_box: (f32, f32, f32, f32),
    tint: Option<Rgba>,
    w: u32,
    h: u32,
) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    paths.len().hash(&mut hasher);
    for p in paths {
        p.d.hash(&mut hasher);
        p.fill.hash(&mut hasher);
        p.stroke.hash(&mut hasher);
        p.stroke_width.map(f32::to_bits).hash(&mut hasher);
        p.stroke_linecap.hash(&mut hasher);
        p.stroke_linejoin.hash(&mut hasher);
    }
    view_box.0.to_bits().hash(&mut hasher);
    view_box.1.to_bits().hash(&mut hasher);
    view_box.2.to_bits().hash(&mut hasher);
    view_box.3.to_bits().hash(&mut hasher);
    if let Some(c) = tint {
        u32::from_le_bytes([c.0, c.1, c.2, c.3]).hash(&mut hasher);
    } else {
        u32::MAX.hash(&mut hasher);
    }
    w.hash(&mut hasher);
    h.hash(&mut hasher);
    hasher.finish()
}

fn line_cap_from(s: Option<&str>) -> LineCap {
    match s {
        Some("round") => LineCap::Round,
        Some("square") => LineCap::Square,
        _ => LineCap::Butt,
    }
}

fn line_join_from(s: Option<&str>) -> LineJoin {
    match s {
        Some("round") => LineJoin::Round,
        Some("bevel") => LineJoin::Bevel,
        _ => LineJoin::Miter,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_view_box_handles_well_formed() {
        assert_eq!(parse_view_box(Some("0 0 24 24")), (0.0, 0.0, 24.0, 24.0));
        assert_eq!(parse_view_box(Some("-1 -2 30 40")), (-1.0, -2.0, 30.0, 40.0));
        assert_eq!(
            parse_view_box(Some("  0   0   16   16  ")),
            (0.0, 0.0, 16.0, 16.0)
        );
    }

    #[test]
    fn parse_view_box_falls_back_for_garbage() {
        let dft = (0.0, 0.0, 24.0, 24.0);
        assert_eq!(parse_view_box(None), dft);
        assert_eq!(parse_view_box(Some("")), dft);
        assert_eq!(parse_view_box(Some("0 0 -10 10")), dft);
        assert_eq!(parse_view_box(Some("0 0 24")), dft);
        assert_eq!(parse_view_box(Some("not numeric")), dft);
    }

    #[test]
    fn parse_paths_decodes_engine_wire_shape() {
        let raw = serde_json::json!([
            {
                "d": "M5 12h14",
                "fill": "none",
                "stroke": "#000",
                "strokeWidth": 2.0,
                "strokeLinecap": "round",
                "strokeLinejoin": "round"
            },
            {
                "d": "M12 5v14",
                "stroke": "#1a1a1f"
            }
        ]);
        let parsed = parse_paths(&raw);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].d, "M5 12h14");
        assert_eq!(parsed[0].stroke.as_deref(), Some("#000"));
        assert_eq!(parsed[0].stroke_width, Some(2.0));
        assert_eq!(parsed[0].stroke_linecap.as_deref(), Some("round"));
        assert_eq!(parsed[1].stroke.as_deref(), Some("#1a1a1f"));
    }

    #[test]
    fn build_path_accepts_simple_move_lineto() {
        // Two points joined by a line — a valid path.
        let p = build_path("M0 0 L10 10").expect("simple ML");
        // Path has at least one segment.
        assert!(p.bounds().width() > 0.0 && p.bounds().height() > 0.0);
    }

    #[test]
    fn paint_icon_cached_matches_uncached_pixels() {
        // Cache hit must produce visually identical output to the
        // direct path. Render via `paint_icon_cached` twice (miss
        // then hit) and via `paint_icon` once into a separate pixmap.
        let paths = vec![IconPath {
            d: "M0 0 H10 V10 H0 Z".into(),
            fill: Some("#000000".into()),
            stroke: None,
            stroke_width: None,
            stroke_linecap: None,
            stroke_linejoin: None,
        }];
        let rect = LayoutRect { x: 0.0, y: 0.0, w: 32.0, h: 32.0 };
        let view_box = (0.0, 0.0, 10.0, 10.0);

        let mut a = Pixmap::new(48, 48).unwrap();
        a.fill(tiny_skia::Color::WHITE);
        let mut b = Pixmap::new(48, 48).unwrap();
        b.fill(tiny_skia::Color::WHITE);

        let mut cache = IconRasterCache::new();
        paint_icon_cached(&mut a, rect, &paths, view_box, None, &mut cache);
        paint_icon(&mut b, rect, &paths, view_box, None);
        // Cache miss render path goes through `paint_icon` against a
        // fresh tile and then composites; the `a` pixels must equal
        // the `b` pixels, modulo nothing.
        assert_eq!(a.data(), b.data(), "cached miss-render should match uncached");

        // Second call → cache hit, still must match.
        let mut c = Pixmap::new(48, 48).unwrap();
        c.fill(tiny_skia::Color::WHITE);
        paint_icon_cached(&mut c, rect, &paths, view_box, None, &mut cache);
        assert_eq!(a.data(), c.data(), "cached hit-render should match miss");
    }

    #[test]
    fn paint_icon_cached_empty_paths_or_zero_rect_is_noop() {
        let mut cache = IconRasterCache::new();
        let mut pm = Pixmap::new(20, 20).unwrap();
        pm.fill(tiny_skia::Color::WHITE);
        let before = pm.data().to_vec();

        paint_icon_cached(
            &mut pm,
            LayoutRect { x: 0.0, y: 0.0, w: 20.0, h: 20.0 },
            &[],
            (0.0, 0.0, 24.0, 24.0),
            None,
            &mut cache,
        );
        assert_eq!(pm.data(), before.as_slice(), "empty paths must no-op");

        paint_icon_cached(
            &mut pm,
            LayoutRect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 },
            &[IconPath {
                d: "M0 0 L1 1".into(),
                fill: Some("#000".into()),
                stroke: None,
                stroke_width: None,
                stroke_linecap: None,
                stroke_linejoin: None,
            }],
            (0.0, 0.0, 24.0, 24.0),
            None,
            &mut cache,
        );
        assert_eq!(pm.data(), before.as_slice(), "zero rect must no-op");
    }

    #[test]
    fn build_path_handles_relative_commands() {
        // `m 5,5 l 10,0 l 0,10 z` — a square.
        let p = build_path("m 5,5 l 10,0 l 0,10 z").expect("rel square");
        let b = p.bounds();
        // Bounds should span 10x10 starting near (5,5).
        assert!((b.width() - 10.0).abs() < 0.5);
        assert!((b.height() - 10.0).abs() < 0.5);
        assert!((b.left() - 5.0).abs() < 0.5);
        assert!((b.top() - 5.0).abs() < 0.5);
    }

    #[test]
    fn build_path_returns_none_for_empty_input() {
        assert!(build_path("").is_none());
        assert!(build_path("   ").is_none());
    }

    #[test]
    fn paint_icon_writes_pixels_for_a_simple_filled_square() {
        // A 10x10 black square at (0,0). Painting it into a 50x50
        // pixmap should leave a chunk of dark pixels.
        let paths = vec![IconPath {
            d: "M0 0 H10 V10 H0 Z".into(),
            fill: Some("#000000".into()),
            stroke: None,
            stroke_width: None,
            stroke_linecap: None,
            stroke_linejoin: None,
        }];
        let mut pm = Pixmap::new(50, 50).unwrap();
        pm.fill(tiny_skia::Color::WHITE);
        paint_icon(
            &mut pm,
            LayoutRect {
                x: 0.0,
                y: 0.0,
                w: 50.0,
                h: 50.0,
            },
            &paths,
            (0.0, 0.0, 10.0, 10.0),
            None,
        );
        let centre = pm.pixel(25, 25).expect("centre pixel");
        assert!(
            centre.red() < 50 && centre.green() < 50 && centre.blue() < 50,
            "icon fill should darken the centre; got R={} G={} B={}",
            centre.red(),
            centre.green(),
            centre.blue(),
        );
    }

    #[test]
    fn paint_icon_tint_overrides_path_fill() {
        // Path says fill = #00ff00 (green). Tint with red should win.
        let paths = vec![IconPath {
            d: "M0 0 H10 V10 H0 Z".into(),
            fill: Some("#00ff00".into()),
            stroke: None,
            stroke_width: None,
            stroke_linecap: None,
            stroke_linejoin: None,
        }];
        let mut pm = Pixmap::new(50, 50).unwrap();
        pm.fill(tiny_skia::Color::WHITE);
        paint_icon(
            &mut pm,
            LayoutRect {
                x: 0.0,
                y: 0.0,
                w: 50.0,
                h: 50.0,
            },
            &paths,
            (0.0, 0.0, 10.0, 10.0),
            Some(Rgba(0xff, 0, 0, 0xff)),
        );
        let centre = pm.pixel(25, 25).expect("centre pixel");
        assert!(
            centre.red() > centre.green() + 50,
            "tint should win over path fill; got R={} G={} B={}",
            centre.red(),
            centre.green(),
            centre.blue(),
        );
    }

    #[test]
    fn paint_icon_does_not_fill_when_path_fill_is_none_even_with_tint() {
        // Regression: tint used to override path fill unconditionally,
        // including for `fill="none"` lucide-style outline icons. That
        // produced solid filled blobs on every outline icon and
        // triggered tiny-skia "horizontal lines cannot be filled"
        // warnings on H/V strokes. Tint replaces fill colour, it
        // doesn't introduce fill where there was none.
        let paths = vec![IconPath {
            d: "M0 0 H10 V10 H0 Z".into(),
            fill: Some("none".into()),
            stroke: Some("currentColor".into()),
            stroke_width: Some(2.0),
            stroke_linecap: None,
            stroke_linejoin: None,
        }];
        let mut pm = Pixmap::new(50, 50).unwrap();
        pm.fill(tiny_skia::Color::WHITE);
        paint_icon(
            &mut pm,
            LayoutRect {
                x: 0.0,
                y: 0.0,
                w: 50.0,
                h: 50.0,
            },
            &paths,
            (0.0, 0.0, 10.0, 10.0),
            Some(Rgba(0xff, 0, 0, 0xff)),
        );
        // Centre should stay (mostly) white because the path is only
        // stroked, not filled. Allow slight anti-aliasing bleed from
        // the surrounding strokes.
        let centre = pm.pixel(25, 25).expect("centre pixel");
        assert!(
            centre.red() > 240 && centre.green() > 240 && centre.blue() > 240,
            "fill=none should leave centre unfilled even with tint; got R={} G={} B={}",
            centre.red(),
            centre.green(),
            centre.blue(),
        );
    }

    #[test]
    fn paint_icon_no_op_for_empty_paths_or_zero_rect() {
        let mut pm = Pixmap::new(20, 20).unwrap();
        pm.fill(tiny_skia::Color::WHITE);
        let before = pm.data().to_vec();

        paint_icon(
            &mut pm,
            LayoutRect {
                x: 0.0,
                y: 0.0,
                w: 20.0,
                h: 20.0,
            },
            &[],
            (0.0, 0.0, 24.0, 24.0),
            None,
        );
        assert_eq!(pm.data(), before.as_slice(), "empty paths must no-op");

        paint_icon(
            &mut pm,
            LayoutRect {
                x: 5.0,
                y: 5.0,
                w: 0.0,
                h: 0.0,
            },
            &[IconPath {
                d: "M0 0 L1 1".into(),
                fill: Some("#000".into()),
                stroke: None,
                stroke_width: None,
                stroke_linecap: None,
                stroke_linejoin: None,
            }],
            (0.0, 0.0, 24.0, 24.0),
            None,
        );
        assert_eq!(pm.data(), before.as_slice(), "zero-size rect must no-op");
    }
}
