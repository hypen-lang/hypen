//! Chart family — data-space drawing for the desktop renderer.
//!
//! `Chart` owns a coordinate space. Its children are *marks* (`Line`,
//! `Area`, `Bars`, `Points`, `Axis`, `Rule`, `Marker`, `Path`) whose props
//! are written in DATA units, never pixels. The chart resolves the x / y
//! domains — explicit `x: [min, max]` / `y: [min, max]` ranges, or the union
//! of its marks' data — then projects every mark into the plot rectangle.
//! Nothing in the DSL names a pixel.
//!
//! This module is the pure half: normalisation, domains, nice ticks, insets,
//! geometry and payload resolution all live here as plain functions over
//! plain data, mirroring `paint::image`'s geometry helpers (`scrubber_geometry`
//! and friends). [`build_scene`] turns a renderer subtree into a
//! [`ChartScene`]: a flat list of device-pixel [`ChartShape`]s the painter
//! draws without any further thinking, plus a list of [`ResolvedMark`]s the
//! hit-tester consults to turn a pointer position into
//! `{series, index, x, y, datum}`.
//!
//! The reference implementation is the web DOM renderer's `chart.ts`; the
//! numbers in [`defaults`] are ported from its `CHART_DEFAULTS` so a chart
//! looks the same on both.
//!
//! Layout contract:
//!
//! - `chart` is a leaf-like block: default height 200, width fills the
//!   parent. Marks are laid out by the chart, not by Taffy — the only mark
//!   built into the Taffy tree is `Marker`, whose Hypen children are
//!   ordinary components positioned at a data point (see
//!   [`anchor_offset`]).
//! - A mark WITHOUT an event applicator emits no layout item at all, so it
//!   is pointer-transparent by construction: a tooltip's `Points` / `Marker`
//!   can never steal the pointer from the `Line` underneath.

use crate::layout::Rect;
use crate::style::{parse_color, Rgba, Viewport};
use crate::tree::{Node, Tree};
use serde_json::{Map, Value};

// ---------------------------------------------------------------------------
// Element types
// ---------------------------------------------------------------------------

/// The chart host's element type. Matched case-insensitively like every
/// other element type in this renderer, so the engine's PascalCase
/// `Chart` on the wire resolves here.
pub const CHART_TYPE: &str = "chart";

/// The mark element types, in the registration order the contract lists.
pub const CHART_MARK_TYPES: &[&str] = &[
    "line", "area", "bars", "points", "axis", "rule", "marker", "path",
];

/// True for the chart host element type.
pub fn is_chart_type(element_type: &str) -> bool {
    element_type.eq_ignore_ascii_case(CHART_TYPE)
}

/// True when `node_id` is a chart host or one of its marks.
///
/// The chart family is excluded from the renderer's paint-only fast path:
/// a mark's `points` / `data` / `stroke` are not layout props by the shared
/// classifier's reckoning, but they DO move geometry — the chart resolves
/// its domains from them. Any prop change on a chart or a mark therefore
/// re-lays the whole chart out, exactly as the contract says.
pub fn is_chart_family_node(tree: &Tree, node_id: &str) -> bool {
    let Some(node) = tree.get(node_id) else {
        return false;
    };
    if is_chart_type(&node.element_type) {
        return true;
    }
    MarkKind::from_element_type(&node.element_type).is_some()
        && tree
            .parent_of(node_id)
            .and_then(|parent| tree.get(parent))
            .is_some_and(|parent| is_chart_type(&parent.element_type))
}

/// The kinds of mark a `Chart` can host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MarkKind {
    Line,
    Area,
    Bars,
    Points,
    Axis,
    Rule,
    Marker,
    Path,
}

impl MarkKind {
    /// Resolve an element type to a mark kind. Case-insensitive, like the
    /// rest of the renderer's element-type matching.
    pub fn from_element_type(element_type: &str) -> Option<Self> {
        for (name, kind) in [
            ("line", MarkKind::Line),
            ("area", MarkKind::Area),
            ("bars", MarkKind::Bars),
            ("points", MarkKind::Points),
            ("axis", MarkKind::Axis),
            ("rule", MarkKind::Rule),
            ("marker", MarkKind::Marker),
            ("path", MarkKind::Path),
        ] {
            if element_type.eq_ignore_ascii_case(name) {
                return Some(kind);
            }
        }
        None
    }

    /// Lowercase name — the default `series` for an unnamed mark.
    pub fn as_str(self) -> &'static str {
        match self {
            MarkKind::Line => "line",
            MarkKind::Area => "area",
            MarkKind::Bars => "bars",
            MarkKind::Points => "points",
            MarkKind::Axis => "axis",
            MarkKind::Rule => "rule",
            MarkKind::Marker => "marker",
            MarkKind::Path => "path",
        }
    }

    /// Marks that carry data and therefore take part in domain resolution
    /// (and in datum-carrying event payloads).
    pub fn is_data(self) -> bool {
        matches!(
            self,
            MarkKind::Line | MarkKind::Area | MarkKind::Bars | MarkKind::Points
        )
    }
}

/// Visual + interaction defaults, ported from the DOM renderer's
/// `CHART_DEFAULTS`. All lengths are LOGICAL pixels — multiply by the
/// window's scale factor before they reach device space.
pub mod defaults {
    /// Fallback host width when nothing constrains the chart.
    pub const WIDTH: f32 = 320.0;
    /// Default host height. Width fills the parent; height does not.
    pub const HEIGHT: f32 = 200.0;
    /// Plot inset when no axis asks for label room (sparkline mode).
    pub const BARE_INSET: f32 = 4.0;
    pub const INSET_TOP: f32 = 10.0;
    pub const INSET_RIGHT: f32 = 12.0;
    /// Room for a y axis' tick labels.
    pub const INSET_LEFT: f32 = 44.0;
    /// Room for an x axis' tick labels.
    pub const INSET_BOTTOM: f32 = 28.0;
    pub const TICKS: usize = 5;
    pub const POINT_RADIUS: f32 = 3.5;
    /// Invisible touch target radius around a point or line vertex.
    pub const HIT_RADIUS: f32 = 12.0;
    pub const BAR_WIDTH: f32 = 0.7;
    pub const DIMMED_OPACITY: f32 = 0.45;
    pub const FONT_SIZE: f32 = 11.0;
    /// Gap between a `Marker`'s data point and its anchored content.
    pub const MARKER_GAP: f32 = 8.0;
    /// Default `glow(...)` radius — `drop-shadow(0 0 6px currentColor)`.
    pub const GLOW_RADIUS: f32 = 6.0;
    /// Axis tick mark length.
    pub const TICK_LEN: f32 = 4.0;
    /// Minimum pointer half-width for hitting a thin mark's stroke.
    pub const STROKE_HIT_SLOP: f32 = 6.0;
    /// `onLongPress` hold duration.
    pub const LONG_PRESS_MS: u64 = 500;
    /// `onMove` dispatch throttle (~one frame at 30fps).
    pub const MOVE_THROTTLE_MS: u64 = 32;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/// An x coordinate: numeric, or a category name (a string x anywhere in the
/// chart switches the x scale to bands).
#[derive(Debug, Clone, PartialEq)]
pub enum DataX {
    Num(f64),
    Cat(String),
}

impl DataX {
    /// JSON value form, for the event payload.
    pub fn to_value(&self) -> Value {
        match self {
            DataX::Num(n) => number_value(*n),
            DataX::Cat(s) => Value::String(s.clone()),
        }
    }

    /// The string a band scale keys on — JS `String(value)`.
    pub fn key(&self) -> String {
        match self {
            DataX::Num(n) => format_number(*n),
            DataX::Cat(s) => s.clone(),
        }
    }
}

/// One normalised row.
#[derive(Debug, Clone, PartialEq)]
pub struct Datum {
    pub x: DataX,
    pub y: f64,
    /// Position in the bound array, BEFORE unusable rows were dropped.
    pub index: usize,
    /// The original row, untouched — travels in the event payload.
    pub raw: Value,
}

fn number_value(n: f64) -> Value {
    serde_json::Number::from_f64(n)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// JS `String(n)` for a finite number: integers lose the decimal point.
fn format_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn to_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|v| v.is_finite()),
        Value::String(s) if !s.trim().is_empty() => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// x keeps strings (categories); anything else must be numeric.
fn to_x(value: &Value) -> Option<DataX> {
    if let Some(n) = to_number(value) {
        return Some(DataX::Num(n));
    }
    match value {
        Value::String(s) if !s.is_empty() => Some(DataX::Cat(s.clone())),
        _ => None,
    }
}

/// Prop lookup with the engine's `name` → `name.0` fallback. Applicator
/// arguments land under the dotted key; positional ones under `"0"`.
fn raw_prop<'a>(node: &'a Node, name: &str) -> Option<&'a Value> {
    node.props
        .get(name)
        .or_else(|| node.props.get(&format!("{name}.0")))
}

fn str_prop<'a>(node: &'a Node, name: &str) -> Option<&'a str> {
    raw_prop(node, name).and_then(Value::as_str)
}

fn f32_prop(node: &Node, name: &str) -> Option<f32> {
    raw_prop(node, name).and_then(to_number).map(|v| v as f32)
}

fn bool_prop(node: &Node, name: &str) -> bool {
    match raw_prop(node, name) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s == "true",
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
        _ => false,
    }
}

/// The mark's list prop: `points` / `data` / `values` / positional `"0"`.
/// A JSON-encoded array (the remote wire form) is parsed.
fn read_list(node: &Node) -> Vec<Value> {
    for name in ["points", "data", "values", "0"] {
        let Some(value) = effect_prop(node, name) else {
            continue;
        };
        match value.as_ref() {
            Value::Array(list) => return list.clone(),
            Value::String(s) => {
                if let Ok(Value::Array(list)) = serde_json::from_str::<Value>(s) {
                    return list;
                }
            }
            _ => {}
        }
    }
    Vec::new()
}

/// Normalise a mark's list prop into `{x, y}` rows.
///
/// Three shapes are accepted and all collapse to the same thing: a bare
/// number uses its index as x, an `[x, y]` tuple reads positionally, and an
/// object reads the field names given by `x:` / `y:` (`Bars` also accepts
/// `label:` / `value:`). Rows without a numeric y are dropped, not zeroed.
pub fn normalize_data(node: &Node) -> Vec<Datum> {
    let list = read_list(node);
    let x_field = str_prop(node, "x")
        .or_else(|| str_prop(node, "label"))
        .unwrap_or("x")
        .to_string();
    let y_field = str_prop(node, "y")
        .or_else(|| str_prop(node, "value"))
        .unwrap_or("y")
        .to_string();

    let mut out = Vec::with_capacity(list.len());
    for (index, raw) in list.into_iter().enumerate() {
        let (x, y) = match &raw {
            Value::Array(tuple) => (
                tuple.first().and_then(to_x),
                tuple.get(1).and_then(to_number),
            ),
            Value::Object(row) => {
                let mut x = row.get(&x_field).and_then(to_x);
                if x.is_none() && !row.contains_key(&x_field) {
                    x = Some(DataX::Num(index as f64));
                }
                (x, row.get(&y_field).and_then(to_number))
            }
            other => (Some(DataX::Num(index as f64)), to_number(other)),
        };
        if let (Some(x), Some(y)) = (x, y) {
            out.push(Datum { x, y, index, raw });
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScaleKind {
    Linear,
    Band,
}

/// A data → pixel mapping for one axis. `y` runs bottom→top, so its range
/// is `(bottom, top)` with `range.0 > range.1`.
#[derive(Debug, Clone)]
pub struct Scale {
    pub kind: ScaleKind,
    pub min: f64,
    pub max: f64,
    pub categories: Vec<String>,
    pub range: (f32, f32),
    /// Width of one categorical band, or the pixel step implied by the bar
    /// count on a numeric scale.
    pub band: f32,
}

impl Scale {
    pub fn linear(min: f64, max: f64, range: (f32, f32)) -> Self {
        Scale {
            kind: ScaleKind::Linear,
            min,
            max,
            categories: Vec::new(),
            range,
            band: 0.0,
        }
    }

    pub fn band(categories: Vec<String>, range: (f32, f32)) -> Self {
        let n = categories.len().max(1) as f32;
        let band = (range.1 - range.0) / n;
        Scale {
            kind: ScaleKind::Band,
            min: 0.0,
            max: categories.len().max(1) as f64,
            categories,
            range,
            band,
        }
    }

    /// Data → pixel. `None` for a category the scale does not know, or a
    /// non-numeric value on a linear scale.
    pub fn map(&self, value: &DataX) -> Option<f32> {
        match self.kind {
            ScaleKind::Linear => match value {
                DataX::Num(n) => Some(self.map_num(*n)),
                DataX::Cat(_) => None,
            },
            ScaleKind::Band => {
                let key = value.key();
                let index = self.categories.iter().position(|c| *c == key)?;
                Some(self.range.0 + (index as f32 + 0.5) * self.band)
            }
        }
    }

    /// Linear projection. Meaningless on a band scale — callers that can
    /// see a category go through [`Scale::map`].
    pub fn map_num(&self, value: f64) -> f32 {
        let span = if self.max - self.min == 0.0 {
            1.0
        } else {
            self.max - self.min
        };
        let px = (self.range.1 - self.range.0) as f64;
        (self.range.0 as f64 + ((value - self.min) / span) * px) as f32
    }

    /// Pixel → data (a numeric position; a fractional band index for a
    /// categorical scale).
    pub fn invert(&self, px: f32) -> f64 {
        match self.kind {
            ScaleKind::Linear => {
                let span = if self.max - self.min == 0.0 {
                    1.0
                } else {
                    self.max - self.min
                };
                let range_px = (self.range.1 - self.range.0) as f64;
                let range_px = if range_px == 0.0 { 1.0 } else { range_px };
                self.min + ((px - self.range.0) as f64 / range_px) * span
            }
            ScaleKind::Band => {
                let band = if self.band == 0.0 { 1.0 } else { self.band };
                ((px - self.range.0) / band) as f64
            }
        }
    }
}

/// Round a domain out to tick-friendly bounds. A degenerate domain
/// (`min == max`) is padded so the mark has somewhere to live.
pub fn nice_domain(min: f64, max: f64, count: usize) -> (f64, f64) {
    if min == max {
        let pad = if min == 0.0 { 1.0 } else { min.abs() * 0.1 };
        return (min - pad, max + pad);
    }
    let step = nice_step(min, max, count);
    ((min / step).floor() * step, (max / step).ceil() * step)
}

/// The 1 / 2 / 5 / 10 step whose tick count lands nearest `count`.
pub fn nice_step(min: f64, max: f64, count: usize) -> f64 {
    let raw = (max - min) / count.max(1) as f64;
    if raw <= 0.0 || !raw.is_finite() {
        return 1.0;
    }
    let magnitude = 10f64.powf(raw.log10().floor());
    let normalised = raw / magnitude;
    let nice = if normalised < 1.5 {
        1.0
    } else if normalised < 3.0 {
        2.0
    } else if normalised < 7.0 {
        5.0
    } else {
        10.0
    };
    nice * magnitude
}

/// Tick values inside `[min, max]`, spaced by [`nice_step`].
pub fn ticks(min: f64, max: f64, count: usize) -> Vec<f64> {
    if min == max {
        return vec![min];
    }
    let step = nice_step(min, max, count);
    let mut out = Vec::new();
    let mut value = (min / step).ceil() * step;
    // Guard against a pathological step producing an unbounded loop.
    let mut guard = 0;
    while value <= max + step * 1e-9 && guard < 10_000 {
        out.push(round_sig(value));
        value += step;
        guard += 1;
    }
    out
}

/// JS `Number(v.toPrecision(12))` — kills the float noise that
/// accumulating a step introduces without changing any real digit.
fn round_sig(v: f64) -> f64 {
    if v.abs() < 1e-9 {
        return 0.0;
    }
    let digits = 11 - v.abs().log10().floor() as i32;
    if !(-300..=300).contains(&digits) {
        return v;
    }
    let factor = 10f64.powi(digits);
    (v * factor).round() / factor
}

/// Tick label text: integers plain, everything else to 3 decimals.
pub fn format_tick(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        return format!("{}", v as i64);
    }
    format_number((v * 1000.0).round() / 1000.0)
}

/// Read a `[min, max]` domain prop. Accepts a JSON array or its
/// string-encoded wire form, and orders the pair.
pub fn read_range(value: Option<&Value>) -> Option<(f64, f64)> {
    let value = value?;
    let owned;
    let list = match value {
        Value::Array(list) => list,
        Value::String(s) => {
            owned = serde_json::from_str::<Value>(s).ok()?;
            owned.as_array()?
        }
        _ => return None,
    };
    if list.len() < 2 {
        return None;
    }
    let a = to_number(&list[0])?;
    let b = to_number(&list[1])?;
    Some(if a <= b { (a, b) } else { (b, a) })
}

/// `highlight` = index | [indices] | null.
fn highlight_set(value: Option<&Value>) -> Option<Vec<usize>> {
    let value = value?;
    let owned;
    let items: &[Value] = match value {
        Value::Null | Value::Bool(false) => return None,
        Value::Array(list) => list,
        Value::String(s) if s.is_empty() => return None,
        Value::String(s) => {
            owned = serde_json::from_str::<Value>(s).ok()?;
            match &owned {
                Value::Array(list) => list,
                other => std::slice::from_ref(other),
            }
        }
        other => std::slice::from_ref(other),
    };
    let mut out = Vec::new();
    for item in items {
        if let Some(n) = to_number(item) {
            if n >= 0.0 {
                out.push(n as usize);
            }
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Insets
// ---------------------------------------------------------------------------

/// Plot insets in LOGICAL pixels: `padding` on the chart wins; otherwise a
/// chart with no `Axis` child is drawn edge to edge (sparkline) and one
/// with axes reserves label room on the sides that ask for it.
pub fn insets(padding: Option<f32>, has_x_axis: bool, has_y_axis: bool) -> (f32, f32, f32, f32) {
    if let Some(p) = padding {
        return (p, p, p, p);
    }
    if !has_x_axis && !has_y_axis {
        let b = defaults::BARE_INSET;
        return (b, b, b, b);
    }
    (
        defaults::INSET_TOP,
        defaults::INSET_RIGHT,
        if has_x_axis {
            defaults::INSET_BOTTOM
        } else {
            defaults::BARE_INSET
        },
        if has_y_axis {
            defaults::INSET_LEFT
        } else {
            defaults::BARE_INSET
        },
    )
}

// ---------------------------------------------------------------------------
// Marker anchoring
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Anchor {
    /// Content sits above the point (the default).
    #[default]
    Top,
    Bottom,
    Left,
    Right,
    Center,
}

impl Anchor {
    pub fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("bottom") => Anchor::Bottom,
            Some("left") => Anchor::Left,
            Some("right") => Anchor::Right,
            Some("center") | Some("centre") => Anchor::Center,
            _ => Anchor::Top,
        }
    }
}

/// Top-left offset of a `w × h` box anchored at a data point, in the same
/// units as `w` / `h` / `gap`. Mirrors the DOM stylesheet's transforms:
/// `top` is `translate(-50%, calc(-100% - 8px))`, and so on.
pub fn anchor_offset(anchor: Anchor, w: f32, h: f32, gap: f32) -> (f32, f32) {
    match anchor {
        Anchor::Top => (-w * 0.5, -h - gap),
        Anchor::Bottom => (-w * 0.5, gap),
        Anchor::Left => (-w - gap, -h * 0.5),
        Anchor::Right => (gap, -h * 0.5),
        Anchor::Center => (-w * 0.5, -h * 0.5),
    }
}

// ---------------------------------------------------------------------------
// Paint description
// ---------------------------------------------------------------------------

/// A soft shadow behind a mark's geometry. `glow(...)` is the zero-offset
/// form; `shadow` / `boxShadow` / `elevation` on a mark mean the same thing
/// (a box shadow would be invisible on a path).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MarkGlow {
    pub color: Rgba,
    /// Blur radius in device pixels.
    pub radius: f32,
    pub dx: f32,
    pub dy: f32,
}

/// How one [`ChartShape`] is painted. Colours already have every opacity
/// factor folded in, so the painter fills and strokes exactly what it is
/// handed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ShapePaint {
    pub fill: Option<Rgba>,
    pub stroke: Option<Rgba>,
    /// Device-pixel stroke width.
    pub width: f32,
    /// `(on, off)` dash pattern in device pixels.
    pub dash: Option<(f32, f32)>,
    pub round_cap: bool,
    pub glow: Option<MarkGlow>,
}

/// Horizontal placement of a chart label around its anchor point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LabelAlign {
    Start,
    Middle,
    End,
}

/// One drawable primitive, in absolute device pixels.
#[derive(Debug, Clone)]
pub enum ChartShape {
    /// Polyline. `smooth` interpolates Catmull-Rom → cubic; `close_to_y`
    /// drops both ends to that baseline and closes the figure (Area).
    Path {
        points: Vec<(f32, f32)>,
        smooth: bool,
        close_to_y: Option<f32>,
        paint: ShapePaint,
    },
    Rect {
        rect: Rect,
        radius: f32,
        paint: ShapePaint,
    },
    Circle {
        cx: f32,
        cy: f32,
        r: f32,
        paint: ShapePaint,
    },
    Segment {
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        paint: ShapePaint,
    },
    /// An axis label / title. `(x, y)` is the anchor; the baseline sits at
    /// `y` and `align` says where the text sits horizontally.
    Label {
        x: f32,
        y: f32,
        text: String,
        size: f32,
        color: Rgba,
        align: LabelAlign,
        /// Rotated a quarter turn anticlockwise about `(x, y)` — the y
        /// axis title.
        rotated: bool,
    },
    /// A `Path(d:)` mark: an SVG path string whose coordinates are data
    /// units, drawn through one affine `[a, b, c, d, e, f]` transform with a
    /// non-scaling stroke.
    SvgPath {
        d: String,
        transform: [f32; 6],
        paint: ShapePaint,
    },
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

/// The event applicators a mark understands. Each is `(action, static args)`
/// exactly as the engine flattened it.
#[derive(Debug, Clone, Default)]
pub struct MarkEvents {
    pub click: Option<(String, Value)>,
    pub long_press: Option<(String, Value)>,
    pub hover: Option<(String, Value)>,
    pub mouse_move: Option<(String, Value)>,
    pub mouse_leave: Option<(String, Value)>,
}

impl MarkEvents {
    /// A mark with no event applicator is pointer-transparent.
    pub fn is_interactive(&self) -> bool {
        self.click.is_some()
            || self.long_press.is_some()
            || self.hover.is_some()
            || self.mouse_move.is_some()
            || self.mouse_leave.is_some()
    }

    fn from_node(node: &Node) -> Self {
        let read = |event: &str| crate::layout::resolve_named_event_action(node, event);
        MarkEvents {
            // `.onPress` is the touch spelling of `.onClick`; either wires
            // the same tap.
            click: read("onClick").or_else(|| read("onPress")),
            long_press: read("onLongPress"),
            hover: read("onHover"),
            mouse_move: read("onMove"),
            mouse_leave: read("onMouseLeave"),
        }
    }
}

/// A mark as the hit-tester sees it: the projected geometry plus enough
/// data to answer `{series, index, x, y, datum}`.
#[derive(Debug, Clone)]
pub struct ResolvedMark {
    pub node_id: String,
    pub kind: MarkKind,
    /// `series:` / `name:` prop, else the mark kind.
    pub series: String,
    pub data: Vec<Datum>,
    /// Projected device-pixel position of each datum that landed inside
    /// the scales, paired with its index into `data`.
    pub points: Vec<(f32, f32, usize)>,
    /// Bar rectangles, paired with their index into `data`.
    pub bars: Vec<(Rect, usize)>,
    /// Invisible touch radius around a vertex / point.
    pub hit_radius: f32,
    /// Half-width of the polyline body's hit band. Zero when the mark has
    /// no line to hit.
    pub stroke_half: f32,
    /// Baseline y of an `Area`'s filled region — the region between the
    /// polyline and this line is hittable.
    pub area_base: Option<f32>,
    /// Fallback hit region (a `Path` mark's bounding box).
    pub bounds: Option<Rect>,
    /// A single hittable line (`Rule`, `Axis`).
    pub segment: Option<(f32, f32, f32, f32)>,
    pub events: MarkEvents,
}

/// Outcome of hit-testing a mark: whether it was hit at all, and whether
/// the hit named a specific row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkHit {
    /// A bar / point / vertex — this exact row.
    Datum(usize),
    /// Somewhere else on the mark: the row is resolved by nearest x.
    Region,
}

impl ResolvedMark {
    /// Device-pixel bounding box of everything hittable on this mark,
    /// already padded by the touch radius. `None` when the mark projected
    /// no geometry at all.
    pub fn hit_bounds(&self) -> Option<Rect> {
        let mut min_x = f32::INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        let mut include = |x: f32, y: f32| {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        };
        let pad = self.hit_radius.max(self.stroke_half);
        for (x, y, _) in &self.points {
            include(*x - pad, *y - pad);
            include(*x + pad, *y + pad);
        }
        for (rect, _) in &self.bars {
            include(rect.x, rect.y);
            include(rect.x + rect.w, rect.y + rect.h);
        }
        if let Some(base) = self.area_base {
            for (x, _, _) in &self.points {
                include(*x, base);
            }
        }
        if let Some(r) = self.bounds {
            include(r.x - pad, r.y - pad);
            include(r.x + r.w + pad, r.y + r.h + pad);
        }
        if let Some((x1, y1, x2, y2)) = self.segment {
            let slop = self.stroke_half.max(1.0);
            include(x1.min(x2) - slop, y1.min(y2) - slop);
            include(x1.max(x2) + slop, y1.max(y2) + slop);
        }
        if !min_x.is_finite() || !min_y.is_finite() {
            return None;
        }
        Some(Rect {
            x: min_x,
            y: min_y,
            w: (max_x - min_x).max(0.0),
            h: (max_y - min_y).max(0.0),
        })
    }

    /// Hit-test a device-pixel point against this mark's geometry.
    ///
    /// A bar, a point, or a line vertex resolves that row directly (points
    /// and vertices carry an invisible [`defaults::HIT_RADIUS`] target so
    /// fingers work). Anything else on the mark is a `Region` hit, which
    /// the payload resolver turns into the row nearest the pointer along x.
    pub fn hit(&self, px: f32, py: f32) -> Option<MarkHit> {
        for (rect, index) in &self.bars {
            if px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h {
                return Some(MarkHit::Datum(*index));
            }
        }
        let r2 = self.hit_radius * self.hit_radius;
        let mut best: Option<(f32, usize)> = None;
        for (x, y, index) in &self.points {
            let d2 = (px - x) * (px - x) + (py - y) * (py - y);
            if d2 <= r2 && best.map(|(b, _)| d2 < b).unwrap_or(true) {
                best = Some((d2, *index));
            }
        }
        if let Some((_, index)) = best {
            return Some(MarkHit::Datum(index));
        }
        if self.stroke_half > 0.0 && self.points.len() > 1 {
            for pair in self.points.windows(2) {
                let (x1, y1, _) = pair[0];
                let (x2, y2, _) = pair[1];
                if distance_to_segment(px, py, x1, y1, x2, y2) <= self.stroke_half {
                    return Some(MarkHit::Region);
                }
            }
        }
        if let Some(base) = self.area_base {
            if point_in_area(px, py, &self.points, base) {
                return Some(MarkHit::Region);
            }
        }
        if let Some((x1, y1, x2, y2)) = self.segment {
            if distance_to_segment(px, py, x1, y1, x2, y2) <= self.stroke_half.max(1.0) {
                return Some(MarkHit::Region);
            }
        }
        if let Some(r) = self.bounds {
            let pad = self.stroke_half;
            if px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad
            {
                return Some(MarkHit::Region);
            }
        }
        None
    }

    /// The event payload for a hit at `pointer` (device pixels), merged on
    /// top of the mark's static action arguments by the caller.
    ///
    /// `None` pointer — an assistive-technology activation, which carries no
    /// position — resolves the series only, exactly like a DOM event with
    /// neither a target index nor client coordinates.
    pub fn payload(&self, pointer: Option<(f32, f32)>) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("series".into(), Value::String(self.series.clone()));
        if !self.kind.is_data() || self.data.is_empty() {
            return out;
        }
        let Some((px, py)) = pointer else {
            return out;
        };
        let datum = match self.hit(px, py) {
            Some(MarkHit::Datum(index)) => self.data.iter().find(|d| d.index == index),
            _ => self.nearest_by_x(px),
        };
        if let Some(d) = datum {
            out.insert("index".into(), Value::from(d.index));
            out.insert("x".into(), d.x.to_value());
            out.insert("y".into(), number_value(d.y));
            out.insert("datum".into(), d.raw.clone());
        }
        out
    }

    /// The row nearest the pointer along x. A pointer past the last vertex
    /// therefore clamps to the last datum.
    pub fn nearest_by_x(&self, px: f32) -> Option<&Datum> {
        let mut best: Option<(f32, usize)> = None;
        for (x, _, index) in &self.points {
            let dist = (px - x).abs();
            if best.map(|(b, _)| dist < b).unwrap_or(true) {
                best = Some((dist, *index));
            }
        }
        let index = best?.1;
        self.data.iter().find(|d| d.index == index)
    }
}

fn distance_to_segment(px: f32, py: f32, x1: f32, y1: f32, x2: f32, y2: f32) -> f32 {
    let dx = x2 - x1;
    let dy = y2 - y1;
    let len2 = dx * dx + dy * dy;
    if len2 <= f32::EPSILON {
        return ((px - x1).powi(2) + (py - y1).powi(2)).sqrt();
    }
    let t = (((px - x1) * dx + (py - y1) * dy) / len2).clamp(0.0, 1.0);
    let cx = x1 + t * dx;
    let cy = y1 + t * dy;
    ((px - cx).powi(2) + (py - cy).powi(2)).sqrt()
}

/// Is the point inside the band between the polyline and its baseline?
/// The region is x-monotone by construction (points are projected in data
/// order), so a vertical span test per segment is exact enough.
fn point_in_area(px: f32, py: f32, points: &[(f32, f32, usize)], base: f32) -> bool {
    if points.len() < 2 {
        return false;
    }
    for pair in points.windows(2) {
        let (x1, y1, _) = pair[0];
        let (x2, y2, _) = pair[1];
        let (lo, hi) = if x1 <= x2 { (x1, x2) } else { (x2, x1) };
        if px < lo || px > hi {
            continue;
        }
        let t = if (x2 - x1).abs() <= f32::EPSILON {
            0.0
        } else {
            (px - x1) / (x2 - x1)
        };
        let top = y1 + t * (y2 - y1);
        let (a, b) = if top <= base {
            (top, base)
        } else {
            (base, top)
        };
        if py >= a && py <= b {
            return true;
        }
    }
    false
}

/// Where a `Marker`'s Hypen children go: the data point, in absolute device
/// pixels, plus the anchor that positions the content around it.
#[derive(Debug, Clone)]
pub struct MarkerPlacement {
    pub node_id: String,
    pub x: f32,
    pub y: f32,
    pub anchor: Anchor,
}

/// A laid-out chart: everything the painter and the hit-tester need, with
/// no further reference to the renderer tree.
#[derive(Debug, Clone)]
pub struct ChartScene {
    /// The plot rectangle in absolute device pixels (the host rect minus
    /// the resolved insets).
    pub plot: Rect,
    pub x: Scale,
    pub y: Scale,
    /// Draw list, in paint order.
    pub shapes: Vec<ChartShape>,
    /// Interactive marks only — a mark without an event applicator emits no
    /// layout item and so is transparent to the pointer.
    pub marks: Vec<ResolvedMark>,
    /// Placed `Marker` children. A marker missing both coordinates is
    /// absent from this list, which hides it.
    pub markers: Vec<MarkerPlacement>,
}

impl ChartScene {
    /// Chart-level payload: the pointer position in data units. A band x
    /// resolves to the category name.
    pub fn payload(&self, px: f32, py: f32) -> Map<String, Value> {
        let mut out = Map::new();
        let x_value = self.x.invert(px);
        let x = match self.x.kind {
            ScaleKind::Band => {
                if self.x.categories.is_empty() {
                    Value::Null
                } else {
                    let index = (x_value.floor() as i64)
                        .clamp(0, self.x.categories.len() as i64 - 1)
                        as usize;
                    Value::String(self.x.categories[index].clone())
                }
            }
            ScaleKind::Linear => number_value(x_value),
        };
        out.insert("x".into(), x);
        out.insert("y".into(), number_value(self.y.invert(py)));
        out
    }

    /// The placement of a specific `Marker` child, if it is visible.
    pub fn marker(&self, node_id: &str) -> Option<&MarkerPlacement> {
        self.markers.iter().find(|m| m.node_id == node_id)
    }
}

// ---------------------------------------------------------------------------
// Style resolution
// ---------------------------------------------------------------------------

/// Multiply a colour's alpha by `factor`.
fn with_alpha(color: Rgba, factor: f32) -> Rgba {
    let a = (color.3 as f32 * factor.clamp(0.0, 1.0))
        .round()
        .clamp(0.0, 255.0) as u8;
    Rgba(color.0, color.1, color.2, a)
}

/// `strokeDasharray` — a list, a number, or a whitespace / comma separated
/// string. Only the leading `on off` pair is honoured; that covers every
/// dash the mark set uses.
fn parse_dash(value: Option<&Value>) -> Option<(f32, f32)> {
    let value = value?;
    let numbers: Vec<f32> = match value {
        Value::Array(list) => list
            .iter()
            .filter_map(to_number)
            .map(|v| v as f32)
            .collect(),
        Value::Number(n) => vec![n.as_f64()? as f32],
        Value::String(s) => s
            .split([' ', ','])
            .filter(|t| !t.is_empty())
            .filter_map(|t| t.parse::<f32>().ok())
            .collect(),
        _ => return None,
    };
    match numbers.len() {
        0 => None,
        1 if numbers[0] > 0.0 => Some((numbers[0], numbers[0])),
        1 => None,
        _ if numbers[0] > 0.0 => Some((numbers[0], numbers[1])),
        _ => None,
    }
}

/// `glow(color | radius | {color, radius})`, plus the shape-shadow family
/// (`shadow`, `boxShadow`, `dropShadow`, `elevation`) which means the same
/// thing on a mark — a box shadow would be invisible on a path.
fn effect_prop<'a>(node: &'a Node, name: &str) -> Option<std::borrow::Cow<'a, Value>> {
    if let Some(value) = raw_prop(node, name) {
        return Some(std::borrow::Cow::Borrowed(value));
    }
    let prefix = format!("{name}.");
    let fields: serde_json::Map<String, Value> = node.props.iter()
        .filter_map(|(key, value)| key.strip_prefix(&prefix).map(|field| (field.to_owned(), value.clone())))
        .collect();
    (!fields.is_empty()).then(|| std::borrow::Cow::Owned(Value::Object(fields)))
}

fn resolve_glow(node: &Node, base: Rgba, scale: f32) -> Option<MarkGlow> {
    if let Some(value) = effect_prop(node, "glow") {
        let (color, radius) = match value.as_ref() {
            Value::Null | Value::Bool(false) => return None,
            Value::Object(map) => (
                map.get("color")
                    .and_then(Value::as_str)
                    .and_then(parse_color)
                    .unwrap_or(base),
                map.get("radius")
                    .and_then(to_number)
                    .map(|v| v as f32)
                    .unwrap_or(defaults::GLOW_RADIUS),
            ),
            Value::Number(n) => (base, n.as_f64().unwrap_or(0.0) as f32),
            Value::String(s) => match s.parse::<f32>() {
                Ok(r) => (base, r),
                Err(_) => (parse_color(s).unwrap_or(base), defaults::GLOW_RADIUS),
            },
            _ => (base, defaults::GLOW_RADIUS),
        };
        if radius > 0.0 {
            return Some(MarkGlow {
                color,
                radius: radius * scale,
                dx: 0.0,
                dy: 0.0,
            });
        }
    }
    for name in ["shadow", "dropShadow", "boxShadow"] {
        let Some(value) = effect_prop(node, name) else {
            continue;
        };
        match value.as_ref() {
            Value::Object(map) => {
                let number = |key: &str| map.get(key).and_then(to_number).map(|v| v as f32);
                return Some(MarkGlow {
                    color: map
                        .get("color")
                        .and_then(Value::as_str)
                        .and_then(parse_color)
                        .unwrap_or(Rgba(0, 0, 0, 64)),
                    radius: number("blur").unwrap_or(0.0).max(0.0) * scale,
                    dx: number("x").unwrap_or(0.0) * scale,
                    dy: number("y").unwrap_or(0.0) * scale,
                });
            }
            Value::String(s) => {
                if let Some(glow) = parse_shadow_shorthand(s, scale) {
                    return Some(glow);
                }
            }
            _ => {}
        }
    }
    if let Some(level) = f32_prop(node, "elevation") {
        if level > 0.0 {
            // Matches the DOM's `drop-shadow(0 2px 3px …)` elevation ramp.
            return Some(MarkGlow {
                color: Rgba(0, 0, 0, 64),
                radius: 3.0 * scale,
                dx: 0.0,
                dy: 2.0 * scale,
            });
        }
    }
    None
}

/// `"0 0 4px red"` — the CSS box-shadow shorthand, in the offset / blur /
/// colour order every Hypen example writes it.
fn parse_shadow_shorthand(text: &str, scale: f32) -> Option<MarkGlow> {
    let mut lengths = Vec::new();
    let mut color = None;
    for token in text.split_whitespace() {
        let numeric = token.trim_end_matches("px");
        match numeric.parse::<f32>() {
            Ok(v) => lengths.push(v),
            Err(_) => color = color.or_else(|| parse_color(token)),
        }
    }
    if lengths.is_empty() && color.is_none() {
        return None;
    }
    Some(MarkGlow {
        color: color.unwrap_or(Rgba(0, 0, 0, 64)),
        radius: lengths.get(2).copied().unwrap_or(0.0).max(0.0) * scale,
        dx: lengths.first().copied().unwrap_or(0.0) * scale,
        dy: lengths.get(1).copied().unwrap_or(0.0) * scale,
    })
}

/// The resolved geometry paint of one mark: the applicator values on top of
/// the per-kind presentation defaults, with the inherited text colour
/// standing in for an unset stroke / fill.
#[derive(Debug, Clone)]
struct MarkStyle {
    /// The colour the mark's geometry defaults to — the inherited text
    /// colour, or whatever `stroke:` / `fill:` named. An axis' grid lines
    /// are drawn from this at a fixed 0.15 opacity, independent of the
    /// axis line's own stroke-opacity.
    base: Rgba,
    stroke: Option<Rgba>,
    fill: Option<Rgba>,
    width: f32,
    dash: Option<(f32, f32)>,
    round_cap: bool,
    glow: Option<MarkGlow>,
    /// Opacity multiplier applied to the dimmed rows of a highlighted mark.
    dim: f32,
}

impl MarkStyle {
    fn resolve(node: &Node, kind: MarkKind, base: Rgba, scale: f32) -> Self {
        // Per-kind presentation defaults, ported from the DOM renderer's
        // MARK_DEFAULT_ATTRS. Inline CSS (an applicator) overrides them.
        let (
            default_stroke,
            default_fill,
            default_width,
            default_fill_opacity,
            default_stroke_opacity,
        ) = match kind {
            MarkKind::Line => (true, false, 2.0, 1.0, 1.0),
            MarkKind::Area => (false, true, 0.0, 0.15, 1.0),
            MarkKind::Bars | MarkKind::Points => (false, true, 0.0, 1.0, 1.0),
            MarkKind::Axis => (true, true, 1.0, 0.75, 0.5),
            MarkKind::Rule => (true, false, 1.0, 1.0, 0.7),
            MarkKind::Path => (true, false, 2.0, 1.0, 1.0),
            MarkKind::Marker => (false, false, 0.0, 1.0, 1.0),
        };

        let explicit_stroke = str_prop(node, "stroke").and_then(parse_color);
        let explicit_fill = str_prop(node, "fill").and_then(parse_color);
        let stroke_none = matches!(str_prop(node, "stroke"), Some("none") | Some("transparent"));
        let fill_none = matches!(str_prop(node, "fill"), Some("none") | Some("transparent"));

        let opacity = f32_prop(node, "opacity").unwrap_or(1.0).clamp(0.0, 1.0);
        let fill_opacity = f32_prop(node, "fillOpacity")
            .unwrap_or(default_fill_opacity)
            .clamp(0.0, 1.0);
        let stroke_opacity = f32_prop(node, "strokeOpacity")
            .unwrap_or(default_stroke_opacity)
            .clamp(0.0, 1.0);

        let stroke = if stroke_none {
            None
        } else {
            explicit_stroke
                .or(if default_stroke { Some(base) } else { None })
                .map(|c| with_alpha(c, stroke_opacity * opacity))
        };
        let fill = if fill_none {
            None
        } else {
            explicit_fill
                .or(if default_fill { Some(base) } else { None })
                .map(|c| with_alpha(c, fill_opacity * opacity))
        };
        let width = f32_prop(node, "strokeWidth").unwrap_or(default_width) * scale;
        let dash = parse_dash(raw_prop(node, "strokeDasharray"))
            .map(|(on, off)| (on * scale, off * scale))
            .or(if kind == MarkKind::Rule {
                Some((4.0 * scale, 4.0 * scale))
            } else {
                None
            });
        let round_cap = match str_prop(node, "strokeLinecap") {
            Some(cap) => cap.eq_ignore_ascii_case("round"),
            None => kind == MarkKind::Line,
        };
        MarkStyle {
            base: explicit_stroke.or(explicit_fill).unwrap_or(base),
            stroke,
            fill,
            width,
            dash,
            round_cap,
            glow: resolve_glow(node, base, scale),
            dim: defaults::DIMMED_OPACITY,
        }
    }

    fn paint(&self) -> ShapePaint {
        ShapePaint {
            fill: self.fill,
            stroke: self.stroke,
            width: self.width,
            dash: self.dash,
            round_cap: self.round_cap,
            glow: self.glow,
        }
    }

    /// The same paint with the fill dimmed — the treatment every row of a
    /// highlighted mark that is NOT in the highlight set gets.
    fn dimmed(&self) -> ShapePaint {
        let mut paint = self.paint();
        paint.fill = paint.fill.map(|c| with_alpha(c, self.dim));
        paint.stroke = paint.stroke.map(|c| with_alpha(c, self.dim));
        paint
    }
}

/// Everything read off one mark node, before projection.
struct MarkSpec {
    node_id: String,
    kind: MarkKind,
    series: String,
    data: Vec<Datum>,
    style: MarkStyle,
    events: MarkEvents,
    // Line / Area
    smooth: bool,
    // Bars / Points
    highlight: Option<Vec<usize>>,
    bar_width: f32,
    radius: f32,
    // Axis
    axis_is_y: bool,
    ticks: usize,
    label: Option<String>,
    grid: bool,
    // Rule / Marker
    at_x: Option<DataX>,
    at_y: Option<f64>,
    anchor: Anchor,
    // Path
    d: Option<String>,
}

impl MarkSpec {
    fn from_node(node: &Node, kind: MarkKind, base: Rgba, scale: f32) -> Self {
        let axis_raw = str_prop(node, "axis").or_else(|| str_prop(node, "0"));
        // `Rule(x: …)` / `Marker(x: …)` name a coordinate; on a data mark
        // a string `x:` names a FIELD, and is not a coordinate at all.
        let coordinate_x = matches!(kind, MarkKind::Rule | MarkKind::Marker)
            .then(|| raw_prop(node, "x").and_then(to_x))
            .flatten();
        let coordinate_y = matches!(kind, MarkKind::Rule | MarkKind::Marker)
            .then(|| raw_prop(node, "y").and_then(to_number))
            .flatten();
        MarkSpec {
            node_id: node.id.clone(),
            kind,
            series: str_prop(node, "series")
                .or_else(|| str_prop(node, "name"))
                .filter(|s| !s.is_empty())
                .unwrap_or(kind.as_str())
                .to_string(),
            data: if kind.is_data() {
                normalize_data(node)
            } else {
                Vec::new()
            },
            style: MarkStyle::resolve(node, kind, base, scale),
            events: MarkEvents::from_node(node),
            smooth: bool_prop(node, "smooth"),
            highlight: highlight_set(raw_prop(node, "highlight")),
            bar_width: f32_prop(node, "barWidth").unwrap_or(defaults::BAR_WIDTH),
            radius: f32_prop(node, "radius").unwrap_or(match kind {
                MarkKind::Points => defaults::POINT_RADIUS,
                _ => 0.0,
            }),
            axis_is_y: axis_raw.is_some_and(|a| a.eq_ignore_ascii_case("y")),
            ticks: f32_prop(node, "ticks")
                .map(|v| v.max(1.0) as usize)
                .unwrap_or(defaults::TICKS),
            label: str_prop(node, "label")
                .filter(|_| kind == MarkKind::Axis)
                .map(str::to_string),
            grid: bool_prop(node, "grid"),
            at_x: coordinate_x,
            at_y: coordinate_y,
            anchor: Anchor::parse(str_prop(node, "anchor")),
            d: str_prop(node, "d")
                .or_else(|| str_prop(node, "0"))
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string),
        }
    }
}

// ---------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------

/// Resolve the x / y scales over the plot rectangle: explicit chart ranges
/// win, otherwise the union of the marks' data (plus `Rule` / `Marker`
/// coordinates). A string x anywhere switches x to bands; `Bars` force y to
/// include zero so bar heights stay honest.
fn resolve_scales(
    explicit_x: Option<(f64, f64)>,
    explicit_y: Option<(f64, f64)>,
    marks: &[MarkSpec],
    plot: Rect,
) -> (Scale, Scale) {
    let x_range = (plot.x, plot.x + plot.w);
    let y_range = (plot.y + plot.h, plot.y);

    let mut categories: Vec<String> = Vec::new();
    let mut x_min = f64::INFINITY;
    let mut x_max = f64::NEG_INFINITY;
    let mut y_min = f64::INFINITY;
    let mut y_max = f64::NEG_INFINITY;
    let mut any_data = false;
    let mut bars = 0usize;

    for mark in marks {
        if mark.kind == MarkKind::Bars {
            bars = bars.max(mark.data.len());
            y_min = y_min.min(0.0);
            y_max = y_max.max(0.0);
        }
        if mark.kind.is_data() {
            for d in &mark.data {
                any_data = true;
                match &d.x {
                    DataX::Cat(c) => {
                        if !categories.iter().any(|seen| seen == c) {
                            categories.push(c.clone());
                        }
                    }
                    DataX::Num(n) => {
                        x_min = x_min.min(*n);
                        x_max = x_max.max(*n);
                    }
                }
                y_min = y_min.min(d.y);
                y_max = y_max.max(d.y);
            }
        }
        if matches!(mark.kind, MarkKind::Rule | MarkKind::Marker) {
            if let Some(y) = mark.at_y {
                y_min = y_min.min(y);
                y_max = y_max.max(y);
            }
            if let Some(DataX::Num(n)) = mark.at_x {
                x_min = x_min.min(n);
                x_max = x_max.max(n);
            }
        }
    }

    let x = if !categories.is_empty() {
        Scale::band(categories, x_range)
    } else {
        let (mut lo, mut hi) = explicit_x.unwrap_or(if x_min.is_finite() {
            (x_min, x_max)
        } else {
            (0.0, 1.0)
        });
        if lo == hi {
            lo -= 1.0;
            hi += 1.0;
        }
        let mut scale = Scale::linear(lo, hi, x_range);
        // Numeric bars need a step to size their width from.
        scale.band = match bars {
            0 => 0.0,
            1 => (x_range.1 - x_range.0) / 2.0,
            n => (x_range.1 - x_range.0) / n as f32,
        };
        scale
    };

    let y = if let Some((lo, hi)) = explicit_y {
        Scale::linear(lo, hi, y_range)
    } else if y_min.is_finite() {
        let (lo, hi) = if any_data || bars > 0 {
            nice_domain(y_min, y_max, defaults::TICKS)
        } else {
            (y_min, y_max)
        };
        Scale::linear(lo, hi, y_range)
    } else {
        Scale::linear(0.0, 1.0, y_range)
    };
    (x, y)
}

/// Project a mark's data into device pixels, dropping rows the scales
/// cannot place (an unknown category, say).
fn project(data: &[Datum], x: &Scale, y: &Scale) -> Vec<(f32, f32, usize)> {
    let mut out = Vec::with_capacity(data.len());
    for d in data {
        let (Some(px), Some(py)) = (x.map(&d.x), Some(y.map_num(d.y))) else {
            continue;
        };
        out.push((px, py, d.index));
    }
    out
}

/// Lay a chart subtree out: resolve the insets, the scales and every
/// mark's geometry against `rect` (the host's absolute device-pixel box).
///
/// `scale` is the window's logical → physical factor: every constant in
/// [`defaults`] is a logical length and is multiplied by it here, so a chart
/// looks identical on a HiDPI display.
pub fn build_scene(
    tree: &Tree,
    chart_id: &str,
    rect: Rect,
    viewport: Viewport,
    scale: f32,
) -> ChartScene {
    let base = tree
        .get(chart_id)
        .map(|_| crate::layout::inherited_text_color(tree, chart_id, viewport))
        .unwrap_or(Rgba::BLACK);

    let marks: Vec<MarkSpec> = tree
        .children_of(chart_id)
        .iter()
        .filter_map(|child_id| {
            let node = tree.get(child_id)?;
            let kind = MarkKind::from_element_type(&node.element_type)?;
            Some(MarkSpec::from_node(node, kind, base, scale))
        })
        .collect();

    let chart_node = tree.get(chart_id);
    let padding = chart_node.and_then(|n| f32_prop(n, "padding"));
    let has_x_axis = marks
        .iter()
        .any(|m| m.kind == MarkKind::Axis && !m.axis_is_y);
    let has_y_axis = marks
        .iter()
        .any(|m| m.kind == MarkKind::Axis && m.axis_is_y);
    let (top, right, bottom, left) = insets(padding, has_x_axis, has_y_axis);
    let plot = Rect {
        x: rect.x + left * scale,
        y: rect.y + top * scale,
        w: (rect.w - (left + right) * scale).max(1.0),
        h: (rect.h - (top + bottom) * scale).max(1.0),
    };

    let (x, y) = resolve_scales(
        chart_node.and_then(|n| read_range(raw_prop(n, "x"))),
        chart_node.and_then(|n| read_range(raw_prop(n, "y"))),
        &marks,
        plot,
    );

    let mut scene = ChartScene {
        plot,
        x,
        y,
        shapes: Vec::new(),
        marks: Vec::new(),
        markers: Vec::new(),
    };
    for mark in &marks {
        render_mark(mark, rect, scale, &mut scene);
    }
    scene
}

/// The y pixel of the zero line, clamped into the y domain — where bars
/// grow from and areas close down to.
fn zero_line(y: &Scale) -> f32 {
    y.map_num(0.0f64.max(y.min).min(y.max))
}

fn render_mark(mark: &MarkSpec, host: Rect, scale: f32, scene: &mut ChartScene) {
    let points = project(&mark.data, &scene.x, &scene.y);
    let hit_radius = defaults::HIT_RADIUS * scale;
    let mut resolved = ResolvedMark {
        node_id: mark.node_id.clone(),
        kind: mark.kind,
        series: mark.series.clone(),
        data: mark.data.clone(),
        points: points.clone(),
        bars: Vec::new(),
        hit_radius,
        stroke_half: 0.0,
        area_base: None,
        bounds: None,
        segment: None,
        events: mark.events.clone(),
    };

    match mark.kind {
        MarkKind::Line => {
            if !points.is_empty() {
                let mut paint = mark.style.paint();
                paint.fill = None;
                scene.shapes.push(ChartShape::Path {
                    points: points.iter().map(|(x, y, _)| (*x, *y)).collect(),
                    smooth: mark.smooth,
                    close_to_y: None,
                    paint,
                });
            }
            resolved.stroke_half = (mark.style.width * 0.5).max(defaults::STROKE_HIT_SLOP * scale);
        }
        MarkKind::Area => {
            if !points.is_empty() {
                let base = zero_line(&scene.y);
                let mut paint = mark.style.paint();
                paint.stroke = None;
                scene.shapes.push(ChartShape::Path {
                    points: points.iter().map(|(x, y, _)| (*x, *y)).collect(),
                    smooth: mark.smooth,
                    close_to_y: Some(base),
                    paint,
                });
                resolved.area_base = Some(base);
            }
        }
        MarkKind::Bars => {
            let step = if scene.x.band > 0.0 {
                scene.x.band
            } else {
                scene.plot.w / points.len().max(1) as f32
            };
            let width = (step * mark.bar_width.clamp(0.05, 1.0)).max(1.0);
            let zero = zero_line(&scene.y);
            let radius = mark.radius * scale;
            for (px, py, index) in &points {
                let top = py.min(zero);
                let height = (zero - py).abs();
                let rect = Rect {
                    x: px - width * 0.5,
                    y: top,
                    w: width,
                    h: height,
                };
                let paint = match &mark.highlight {
                    Some(set) if !set.contains(index) => mark.style.dimmed(),
                    _ => mark.style.paint(),
                };
                scene.shapes.push(ChartShape::Rect {
                    rect,
                    radius,
                    paint,
                });
                resolved.bars.push((rect, *index));
            }
            // A bar IS its own touch target. The projected tops stay in
            // `points` so the touch radius still forgives a tap just past
            // the tip — and so a zero-height bar (a row sitting exactly on
            // the zero line) is reachable at all.
        }
        MarkKind::Points => {
            let r = (mark.radius * scale).max(0.0);
            for (px, py, index) in &points {
                let paint = match &mark.highlight {
                    Some(set) if !set.contains(index) => mark.style.dimmed(),
                    _ => mark.style.paint(),
                };
                scene.shapes.push(ChartShape::Circle {
                    cx: *px,
                    cy: *py,
                    r,
                    paint,
                });
            }
            resolved.hit_radius = hit_radius.max(r);
        }
        MarkKind::Axis => render_axis(mark, host, scale, scene, &mut resolved),
        MarkKind::Rule => {
            let plot = scene.plot;
            let paint = mark.style.paint();
            if let Some(y) = mark.at_y {
                let py = scene.y.map_num(y);
                scene.shapes.push(ChartShape::Segment {
                    x1: plot.x,
                    y1: py,
                    x2: plot.x + plot.w,
                    y2: py,
                    paint,
                });
                resolved.segment = Some((plot.x, py, plot.x + plot.w, py));
            } else if let Some(x) = mark.at_x.as_ref().and_then(|x| scene.x.map(x)) {
                scene.shapes.push(ChartShape::Segment {
                    x1: x,
                    y1: plot.y,
                    x2: x,
                    y2: plot.y + plot.h,
                    paint,
                });
                resolved.segment = Some((x, plot.y, x, plot.y + plot.h));
            }
            resolved.stroke_half = (mark.style.width * 0.5).max(defaults::STROKE_HIT_SLOP * scale);
        }
        MarkKind::Marker => {
            let plot = scene.plot;
            // No coordinates at all (a tooltip bound to `state.hover` while
            // it is null) hides the marker: it is simply absent from the
            // placement list, and the layout pass emits nothing for it.
            if mark.at_x.is_none() && mark.at_y.is_none() {
                return;
            }
            let px = match mark.at_x.as_ref() {
                Some(x) => scene.x.map(x),
                None => Some(plot.x + plot.w * 0.5),
            };
            let py = match mark.at_y {
                Some(y) => Some(scene.y.map_num(y)),
                None => Some(plot.y + plot.h * 0.5),
            };
            if let (Some(px), Some(py)) = (px, py) {
                scene.markers.push(MarkerPlacement {
                    node_id: mark.node_id.clone(),
                    x: px,
                    y: py,
                    anchor: mark.anchor,
                });
            }
            return;
        }
        MarkKind::Path => {
            let Some(d) = mark.d.as_ref() else { return };
            // Data → pixel as one affine transform; y flips because the
            // device space grows downward.
            let sx = (scene.x.range.1 - scene.x.range.0) / denominator(scene.x.max - scene.x.min);
            let sy = (scene.y.range.1 - scene.y.range.0) / denominator(scene.y.max - scene.y.min);
            let tx = scene.x.range.0 - scene.x.min as f32 * sx;
            let ty = scene.y.range.0 - scene.y.min as f32 * sy;
            scene.shapes.push(ChartShape::SvgPath {
                d: d.clone(),
                transform: [sx, 0.0, 0.0, sy, tx, ty],
                paint: mark.style.paint(),
            });
            resolved.bounds = Some(scene.plot);
            resolved.stroke_half = (mark.style.width * 0.5).max(1.0);
        }
    }

    if mark.events.is_interactive() {
        scene.marks.push(resolved);
    }
}

fn denominator(span: f64) -> f32 {
    if span == 0.0 {
        1.0
    } else {
        span as f32
    }
}

fn render_axis(
    mark: &MarkSpec,
    host: Rect,
    scale: f32,
    scene: &mut ChartScene,
    resolved: &mut ResolvedMark,
) {
    let plot = scene.plot;
    let font_size = defaults::FONT_SIZE * scale;
    let tick_len = defaults::TICK_LEN * scale;
    let line_paint = mark.style.paint();
    let label_color = mark.style.fill.unwrap_or(Rgba::BLACK);
    let mut grid_paint = line_paint.clone();
    grid_paint.stroke = Some(with_alpha(mark.style.base, 0.15));
    grid_paint.dash = None;

    if !mark.axis_is_y {
        let y = plot.y + plot.h;
        scene.shapes.push(ChartShape::Segment {
            x1: plot.x,
            y1: y,
            x2: plot.x + plot.w,
            y2: y,
            paint: line_paint.clone(),
        });
        resolved.segment = Some((plot.x, y, plot.x + plot.w, y));
        let entries: Vec<(f32, String)> = match scene.x.kind {
            ScaleKind::Band => scene
                .x
                .categories
                .iter()
                .map(|c| {
                    (
                        scene.x.map(&DataX::Cat(c.clone())).unwrap_or(0.0),
                        c.clone(),
                    )
                })
                .collect(),
            ScaleKind::Linear => ticks(scene.x.min, scene.x.max, mark.ticks)
                .into_iter()
                .map(|v| (scene.x.map_num(v), format_tick(v)))
                .collect(),
        };
        for (px, text) in entries {
            scene.shapes.push(ChartShape::Segment {
                x1: px,
                y1: y,
                x2: px,
                y2: y + tick_len,
                paint: line_paint.clone(),
            });
            if mark.grid {
                scene.shapes.push(ChartShape::Segment {
                    x1: px,
                    y1: plot.y,
                    x2: px,
                    y2: y,
                    paint: grid_paint.clone(),
                });
            }
            scene.shapes.push(ChartShape::Label {
                x: px,
                y: y + 6.0 * scale,
                text,
                size: font_size,
                color: label_color,
                align: LabelAlign::Middle,
                rotated: false,
            });
        }
        if let Some(title) = mark.label.as_ref() {
            scene.shapes.push(ChartShape::Label {
                x: plot.x + plot.w * 0.5,
                y: (y + 8.0 * scale + font_size).min(host.y + host.h - font_size),
                text: title.clone(),
                size: font_size,
                color: label_color,
                align: LabelAlign::Middle,
                rotated: false,
            });
        }
    } else {
        let x = plot.x;
        scene.shapes.push(ChartShape::Segment {
            x1: x,
            y1: plot.y,
            x2: x,
            y2: plot.y + plot.h,
            paint: line_paint.clone(),
        });
        resolved.segment = Some((x, plot.y, x, plot.y + plot.h));
        for value in ticks(scene.y.min, scene.y.max, mark.ticks) {
            let py = scene.y.map_num(value);
            scene.shapes.push(ChartShape::Segment {
                x1: x - tick_len,
                y1: py,
                x2: x,
                y2: py,
                paint: line_paint.clone(),
            });
            if mark.grid {
                scene.shapes.push(ChartShape::Segment {
                    x1: x,
                    y1: py,
                    x2: plot.x + plot.w,
                    y2: py,
                    paint: grid_paint.clone(),
                });
            }
            scene.shapes.push(ChartShape::Label {
                x: x - 7.0 * scale,
                y: py - font_size * 0.5,
                text: format_tick(value),
                size: font_size,
                color: label_color,
                align: LabelAlign::End,
                rotated: false,
            });
        }
        if let Some(title) = mark.label.as_ref() {
            scene.shapes.push(ChartShape::Label {
                x: host.x + font_size,
                y: plot.y + plot.h * 0.5,
                text: title.clone(),
                size: font_size,
                color: label_color,
                align: LabelAlign::Middle,
                rotated: true,
            });
        }
    }
    resolved.stroke_half = (mark.style.width * 0.5).max(defaults::STROKE_HIT_SLOP * scale);
}

/// Is an `.onMove` dispatch due? `since_last_ms` is the time since this
/// mark's last dispatch — `None` when the pointer just entered it, which
/// always dispatches. Throttled to [`defaults::MOVE_THROTTLE_MS`] (about a
/// frame) because every dispatch is a module round trip: a tooltip bound to
/// `.onMove` would otherwise re-render once per motion event.
pub fn move_due(since_last_ms: Option<u64>) -> bool {
    since_last_ms.is_none_or(|ms| ms >= defaults::MOVE_THROTTLE_MS)
}

/// Has a press been held long enough to be an `.onLongPress`?
pub fn long_press_matured(held_ms: u64) -> bool {
    held_ms >= defaults::LONG_PRESS_MS
}

/// One cubic Bézier segment: `(control 1, control 2, end point)`. The
/// start point is the previous segment's end, or `points[0]` for the first.
pub type CubicSegment = ((f32, f32), (f32, f32), (f32, f32));

/// Expand a polyline into cubic Bézier segments with the usual
/// Catmull-Rom construction — the `smooth: true` curve. Empty for fewer
/// than three points, where a straight polyline IS the curve.
pub fn smooth_segments(points: &[(f32, f32)]) -> Vec<CubicSegment> {
    let mut out = Vec::new();
    if points.len() < 3 {
        return out;
    }
    for i in 0..points.len() - 1 {
        let p0 = points[i.saturating_sub(1)];
        let p1 = points[i];
        let p2 = points[i + 1];
        let p3 = points[(i + 2).min(points.len() - 1)];
        out.push((
            (p1.0 + (p2.0 - p0.0) / 6.0, p1.1 + (p2.1 - p0.1) / 6.0),
            (p2.0 - (p3.0 - p1.0) / 6.0, p2.1 - (p3.1 - p1.1) / 6.0),
            p2,
        ));
    }
    out
}

#[cfg(test)]
#[path = "chart_tests.rs"]
mod tests;
