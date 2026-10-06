//! Drag-and-drop runtime — the desktop consumer of the engine's `__dnd.*`
//! wire (`hypen-web/docs/dnd.md`).
//!
//! [`DesktopDnd`] is renderer-resident, the twin of the DOM's `DomDnd`
//! (`hypen-web/packages/web/src/dom/dnd.ts`) ported to the desktop model
//! and structured after the scrub source ([`crate::anim::DesktopScrubber`]):
//!
//! * **Zero engine traffic during a drag.** The window feeds it winit
//!   pointer events; the ghost, the sibling gap-opening shifts, and the
//!   `lifted` / `over` poses are all local. Only the opted-in
//!   `.onDragStart` / `.onDragOver` events and the drop outcome cross the
//!   boundary, queued as [`DndDispatch`]es the window drains into
//!   `module.dispatch_action` (the scrubber's `take_binds` seam).
//! * **Local offsets ride the transform post-pass.** The dragged item and
//!   every shifted sibling carry two renderer-private props
//!   ([`LOCAL_DX_PROP`] / [`LOCAL_DY_PROP`], logical px) that
//!   `layout::node_local_transform` folds into the node's own
//!   `translateX` / `translateY` — so the Vello painter, every `hit_*`
//!   path, AccessKit bounds, and `visual_rect` all move together
//!   (constraint #5). The engine never sees these keys: they are written
//!   with `set_prop_raw`, never through a patch.
//! * **Poses write the real props.** A runtime `.states` label overlays
//!   `__anim.statePoses[label]` onto the node's props (the lowered keys —
//!   `opacity.0`, `scale.0`, …) through the ordinary per-prop resolution
//!   and restores the captured base (or absence) when the label clears.
//! * **Deadlines, not timers.** The press activation, the `onDragOver`
//!   dwell, and the post-drop hold window are deadlines checked against an
//!   injectable clock in [`DesktopDnd::tick`]; [`DesktopDnd::has_active`]
//!   keeps the demand-driven redraw ticker armed.
//! * **Precedence (dnd > scrub > playbacks > transaction).** The window
//!   unions [`DesktopDnd::owned_ids`] into the animator's scrub-active set,
//!   and engine `SetProp`s to a lifted node's translate keys are deferred
//!   until release ([`DesktopDnd::pre_ingest`]).
//!
//! NARROWINGS vs the DOM reference (recorded in the capability matrix):
//! a single OS cursor stands in for pointer capture (one drag at a time,
//! every move routes to it until release — `pointercancel` is the window's
//! focus loss); no touch source (winit `Touch` is not wired, so the
//! cross-axis / long-press `auto` rules never apply — mouse `auto` is slop);
//! the keyboard path (`KeyboardDragMachine`) is omitted (Esc cancels a
//! pointer drag, nothing lifts from the keyboard); pose switches and
//! sibling shifts snap (the synthesized `__anim.transition` is not
//! honoured for the runtime label); `.onDragOver` `animate:` and other
//! extra named args merge under the payload exactly like clicks.

use crate::layout::{LayoutPass, Rect};
use crate::style::Viewport;
use crate::tree::{Tree, ROOT_ID};
use hypen_engine::ir::dnd as wire;
use hypen_engine::Patch;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

/// Axis travel (px) below which a gesture is a tap, not a drag claim.
pub const DND_SLOP_PX: f64 = 6.0;
/// Long-press activation delay for `activation: press`.
pub const DND_PRESS_MS: f64 = 300.0;
/// Default `.onDragOver` dwell when `dwell:` is not given.
pub const DND_DEFAULT_DWELL_MS: f64 = 500.0;
/// Post-drop hold window before local transforms are released when no
/// engine re-render (Move / translate SetProp) lands (§6.3).
const DND_DEFAULT_CLEANUP_MS: f64 = 500.0;

/// Renderer-private prop prefix for the local drag offsets. Distinct from
/// the engine's `__dnd.` namespace so a `starts_with("__dnd.")` router can
/// never confuse the two.
pub const LOCAL_PROP_PREFIX: &str = "__dndDesktop.";
/// Local x offset (logical px) of a dragged item / shifted sibling.
pub const LOCAL_DX_PROP: &str = "__dndDesktop.dx";
/// Local y offset (logical px) of a dragged item / shifted sibling.
pub const LOCAL_DY_PROP: &str = "__dndDesktop.dy";

/// `__anim.statePoses` — the header-less `.states` poses (§2.1).
pub const ANIM_STATE_POSES_PROP: &str = "__anim.statePoses";
/// Reserved reorder action (§4.1).
pub const REORDER_ACTION: &str = "__hypen_reorder";
/// Reserved pin action (§4.1).
pub const PIN_ACTION: &str = "__hypen_pin";
/// Runtime label on the dragged source while lifted.
pub const LABEL_LIFTED: &str = "lifted";
/// Runtime label on a zone while a compatible drag hovers it.
pub const LABEL_OVER: &str = "over";

// ---------------------------------------------------------------------------
// Public surface types
// ---------------------------------------------------------------------------

/// What a runtime call wrote into the tree. `transforms` — only local
/// offsets moved (the window refreshes the per-item transforms in place);
/// `props` — pose props or deferred writes landed (wholesale relayout).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DndDirty {
    pub transforms: bool,
    pub props: bool,
}

impl DndDirty {
    pub fn any(self) -> bool {
        self.transforms || self.props
    }
}

/// One queued module dispatch (`action`, payload), drained by the window
/// in order — reserved writes and `.on*` events alike.
#[derive(Debug, Clone, PartialEq)]
pub struct DndDispatch {
    pub action: String,
    pub payload: Value,
}

/// Result of a pointer release: `Claimed` means a drag owned the pointer
/// (the window must suppress the click); `NoOp` means a below-slop tap /
/// no drag — the ordinary click path runs untouched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DndPointerUp {
    Claimed,
    NoOp,
}

// ---------------------------------------------------------------------------
// Wire specs (desktop re-parse of the `__dnd.*` JSON; warn-and-degrade)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Activation {
    Auto,
    Slop,
    Press,
    Immediate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Axis {
    X,
    Y,
}

#[derive(Debug, Clone)]
struct SourceSpec {
    group: Option<String>,
    activation: Activation,
}

#[derive(Debug, Clone)]
struct ZoneSpec {
    group: Option<String>,
    band: f64,
    /// `.dropZone(files: true)` — also reacts to OS file drags (see
    /// [`files`]). Absent on the wire ⇒ `false` (in-app-only zone).
    files: bool,
    /// The `<input accept>` filter of a files zone (`None` = any). Only
    /// read when `files` is set.
    accept: Option<String>,
}

#[derive(Debug, Clone)]
struct SortSpec {
    group: Option<String>,
    axis: Axis,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PinBounds {
    Clamp,
    Free,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PinUnits {
    Px,
    Fraction,
}

#[derive(Debug, Clone)]
struct PinSpec {
    group: Option<String>,
    x_key: String,
    y_key: String,
    grid: Option<f64>,
    bounds: PinBounds,
    units: PinUnits,
}

/// A channel object: a JSON object, or a JSON string encoding one (Remote
/// UI hosts may pass the object through as text).
fn channel_object(value: &Value) -> Option<Map<String, Value>> {
    match value {
        Value::Object(m) => Some(m.clone()),
        Value::String(s) => serde_json::from_str::<Value>(s)
            .ok()
            .and_then(|v| v.as_object().cloned()),
        _ => None,
    }
}

fn opt_group(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// A bindable string piece (`__dnd.key`, `__dnd.zoneId`, `__dnd.pinGroup`,
/// the `id` prop). Numbers stringify (an `id: 42` zone label); anything
/// else is "absent".
fn parse_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// A bindable enabled flag: absent / null ⇒ true.
fn parse_enabled(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => {
            !matches!(s.trim().to_ascii_lowercase().as_str(), "false" | "0" | "")
        }
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(_) => true,
    }
}

fn parse_source(value: &Value) -> Option<SourceSpec> {
    let obj = channel_object(value)?;
    let activation = match obj.get("activation").and_then(Value::as_str) {
        Some("slop") => Activation::Slop,
        Some("press") => Activation::Press,
        Some("immediate") => Activation::Immediate,
        _ => Activation::Auto,
    };
    // `handle` needs no desktop-side state: the lift surface is always the
    // source's own laid-out bounds (a press inside its subtree), which is
    // exactly what `handle: true` asks for.
    Some(SourceSpec {
        group: opt_group(obj.get("group")),
        activation,
    })
}

fn parse_zone(value: &Value) -> Option<ZoneSpec> {
    let obj = channel_object(value)?;
    let band = obj
        .get("band")
        .and_then(Value::as_f64)
        .filter(|b| b.is_finite() && (0.0..=1.0).contains(b))
        .unwrap_or(wire::DEFAULT_BAND);
    let files = obj.get("files").and_then(Value::as_bool).unwrap_or(false);
    let accept = if files {
        obj.get("accept")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    } else {
        None
    };
    Some(ZoneSpec {
        group: opt_group(obj.get("group")),
        band,
        files,
        accept,
    })
}

fn parse_sort(value: &Value) -> Option<SortSpec> {
    let obj = channel_object(value)?;
    let axis = match obj.get("axis").and_then(Value::as_str) {
        Some("x") => Axis::X,
        _ => Axis::Y,
    };
    Some(SortSpec {
        group: opt_group(obj.get("group")),
        axis,
    })
}

fn parse_pin(value: &Value) -> Option<PinSpec> {
    let obj = channel_object(value)?;
    let key = |name: &str, default: &str| {
        obj.get(name)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(default)
            .to_string()
    };
    let grid = obj
        .get("grid")
        .and_then(Value::as_f64)
        .filter(|g| g.is_finite() && *g > 0.0);
    let bounds = match obj.get("bounds").and_then(Value::as_str) {
        Some("free") => PinBounds::Free,
        _ => PinBounds::Clamp,
    };
    let units = match obj.get("units").and_then(Value::as_str) {
        Some("fraction") => PinUnits::Fraction,
        _ => PinUnits::Px,
    };
    Some(PinSpec {
        group: opt_group(obj.get("group")),
        x_key: key("xKey", "x"),
        y_key: key("yKey", "y"),
        grid,
        bounds,
        units,
    })
}

/// `__anim.statePoses`: `{ label: { loweredKey: value } }`. Malformed
/// labels are skipped; a non-object channel is "no poses".
fn parse_poses(value: &Value) -> Option<HashMap<String, Map<String, Value>>> {
    let obj = channel_object(value)?;
    let mut out = HashMap::new();
    for (label, pose) in obj {
        if let Value::Object(m) = pose {
            out.insert(label, m);
        }
    }
    Some(out)
}

/// Base applicator name of a lowered prop key (`translateX@md.0` →
/// `translateX`), via the shared portable key parser.
fn base_of(name: &str) -> String {
    hypen_engine::portable::parse_prop_key(name).base
}

fn is_translate_base(base: &str) -> bool {
    base == "translateX" || base == "translateY"
}

/// Band rule for a `.dropZone` on a sortable item (core `resolveBand`):
/// the middle `band` fraction along the axis is "into", the outer edges
/// reorder before / after (half-open bands).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Band {
    Before,
    Into,
    After,
}

fn resolve_band(pos: f32, start: f32, length: f32, band: f64) -> Band {
    let b = band.clamp(0.0, 1.0) as f32;
    let length = if length.is_finite() && length > 0.0 {
        length
    } else {
        0.0
    };
    let outer = (1.0 - b) / 2.0;
    let before_end = start + length * outer;
    let after_start = start + length * (1.0 - outer);
    if pos < before_end {
        Band::Before
    } else if pos >= after_start {
        Band::After
    } else {
        Band::Into
    }
}

/// Snap to the nearest multiple of `grid` (no grid ⇒ unchanged).
fn snap_to_grid(v: f64, grid: Option<f64>) -> f64 {
    match grid {
        Some(g) if g.is_finite() && g > 0.0 && v.is_finite() => (v / g).round() * g,
        _ => v,
    }
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

// ---------------------------------------------------------------------------
// Per-node records
// ---------------------------------------------------------------------------

/// A captured pre-overlay prop value: restore exactly (delete if absent)
/// when the label clears.
#[derive(Debug, Clone)]
struct Stored {
    present: bool,
    value: Value,
}

fn capture(tree: &Tree, id: &str, key: &str) -> Stored {
    match tree.get(id).and_then(|n| n.props.get(key)) {
        Some(v) => Stored {
            present: true,
            value: v.clone(),
        },
        None => Stored {
            present: false,
            value: Value::Null,
        },
    }
}

fn apply_stored(tree: &mut Tree, id: &str, key: &str, stored: &Stored) {
    if stored.present {
        tree.set_prop_raw(id, key, stored.value.clone());
    } else {
        tree.remove_prop_raw(id, key);
    }
}

/// Everything the runtime knows about one node carrying `__dnd.*` channels
/// (or header-less `.states` poses).
#[derive(Debug, Clone)]
struct DndNode {
    source: Option<SourceSpec>,
    has_payload: bool,
    payload: Value,
    source_enabled: bool,
    key: Option<String>,
    zone: Option<ZoneSpec>,
    zone_id: Option<String>,
    zone_enabled: bool,
    sort: Option<SortSpec>,
    pin: Option<PinSpec>,
    /// The node's own `bind` prop (the reorder / pin write target).
    bind: Option<String>,
    /// The node's resolved `id` prop (zone-label fallback).
    id_prop: Option<String>,
    poses: Option<HashMap<String, Map<String, Value>>>,
    /// Runtime label currently overlaid (`lifted` / `over`), if any.
    pose_label: Option<String>,
    /// Pre-overlay props, restored when the label clears. Engine writes to
    /// an overridden key while the label is live land HERE (deferred).
    pose_saved: HashMap<String, Stored>,
    warned_variant_pose: bool,
}

impl DndNode {
    fn new() -> Self {
        Self {
            source: None,
            has_payload: false,
            payload: Value::Null,
            source_enabled: true,
            key: None,
            zone: None,
            zone_id: None,
            zone_enabled: true,
            sort: None,
            pin: None,
            bind: None,
            id_prop: None,
            poses: None,
            pose_label: None,
            pose_saved: HashMap::new(),
            warned_variant_pose: false,
        }
    }

    fn is_container(&self) -> bool {
        self.sort.is_some() || self.pin.is_some()
    }

    fn is_zone_like(&self) -> bool {
        self.zone.is_some() || self.is_container()
    }

    fn container_group(&self) -> Option<&str> {
        self.sort
            .as_ref()
            .and_then(|s| s.group.as_deref())
            .or_else(|| self.pin.as_ref().and_then(|p| p.group.as_deref()))
    }
}

// ---------------------------------------------------------------------------
// The active drag
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Pending,
    Dragging,
    Holding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArmedActivation {
    Immediate,
    Slop,
    Press,
}

#[derive(Debug, Clone, PartialEq)]
struct Location {
    zone: String,
    index: Option<usize>,
}

impl Location {
    fn to_json(&self) -> Value {
        json!({ "zone": self.zone, "index": self.index })
    }
}

#[derive(Debug, Clone)]
enum DropTarget {
    Sort {
        container: String,
        index: usize,
    },
    Zone {
        node: String,
    },
    Pin {
        container: String,
        /// The board's content box (physical px), captured at target time.
        content_box: Rect,
    },
}

impl DropTarget {
    fn node_id(&self) -> &str {
        match self {
            DropTarget::Sort { container, .. } | DropTarget::Pin { container, .. } => container,
            DropTarget::Zone { node } => node,
        }
    }
}

/// Cached geometry + live shifts of one sortable list during a drag. Rects
/// are the BASE layout rects (physical px) — shifts are transforms, so the
/// rects never move under the gesture.
#[derive(Debug, Clone)]
struct ListPreview {
    axis: Axis,
    items: Vec<String>,
    rects: Vec<Rect>,
    /// Estimated inter-item gap along the axis.
    gap: f32,
    shifts: Vec<f32>,
}

#[derive(Debug, Clone)]
struct ActiveDrag {
    phase: Phase,
    source: String,
    /// The node that moves: the sortable's direct child containing the
    /// source, else the source itself.
    item: String,
    /// Enclosing sortable / pinboard, if any.
    origin: Option<String>,
    origin_index: Option<usize>,
    from: Location,
    start: (f64, f64),
    activation: ArmedActivation,
    press_deadline: Option<f64>,
    /// Ghost offset (physical px).
    dx: f32,
    dy: f32,
    /// Item base rect at lift (physical px) — the UNTRANSFORMED Taffy
    /// geometry; sortable gap-opening arithmetic runs in this space.
    item_rect: Rect,
    /// Item RENDERED rect at lift (physical px): `item_rect` under the
    /// item's cumulative transform (its own `translateX`/`translateY` —
    /// the engine-injected pin position or the author's `@item.x` — plus
    /// any transformed ancestor). Pinboard drop geometry (§6.5 / §6.11)
    /// runs in this space: a re-pin of an already-positioned note must
    /// add the note's existing translate, not start over from the slot.
    rendered_rect: Rect,
    scale: f32,
    ghost_engaged: bool,
    target: Option<DropTarget>,
    over_node: Option<String>,
    dwell_deadline: Option<f64>,
    lists: HashMap<String, ListPreview>,
    /// A structural patch landed under a cached list (the origin
    /// included) mid-drag: its items / rects / `origin_index` are stale
    /// and rebuild from the live tree on the next laid-out call
    /// (`pre_ingest` runs BEFORE the tree applies the batch, so the
    /// rebuild is lazy).
    stale: bool,
    /// The last pointer position + viewport a move resolved against, so
    /// a rebuild can re-run the target resolution without a new move.
    last_pointer: Option<(f32, f32, Viewport)>,
    hold_deadline: Option<f64>,
    /// Deferred engine writes to the dragged node's translate keys.
    deferred: HashMap<String, HashMap<String, Value>>,
}

enum Clock {
    Real(std::time::Instant),
    Manual(f64),
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

fn is_at_or_under(tree: &Tree, id: &str, root: &str) -> bool {
    let mut current = Some(id);
    while let Some(cur) = current {
        if cur == root {
            return true;
        }
        current = tree.parent_of(cur);
    }
    false
}

fn depth_of(tree: &Tree, id: &str) -> usize {
    let mut d = 0;
    let mut current = tree.parent_of(id);
    while let Some(cur) = current {
        d += 1;
        current = tree.parent_of(cur);
    }
    d
}

/// The container's direct child that is (or contains) `id`.
fn item_of(tree: &Tree, container: &str, id: &str) -> Option<String> {
    let mut cur = id;
    loop {
        let parent = tree.parent_of(cur)?;
        if parent == container {
            return Some(cur.to_string());
        }
        cur = parent;
    }
}

fn axis_start(rect: Rect, axis: Axis) -> f32 {
    match axis {
        Axis::X => rect.x,
        Axis::Y => rect.y,
    }
}

fn axis_length(rect: Rect, axis: Axis) -> f32 {
    match axis {
        Axis::X => rect.w,
        Axis::Y => rect.h,
    }
}

/// Estimated inter-item gap along the axis (first two slots).
fn gap_of(rects: &[Rect], axis: Axis) -> f32 {
    if rects.len() >= 2 {
        (axis_start(rects[1], axis) - (axis_start(rects[0], axis) + axis_length(rects[0], axis)))
            .max(0.0)
    } else {
        0.0
    }
}

/// Write (or clear) a node's local offset props. Values are logical px
/// (the transform post-pass multiplies by the HiDPI scale like
/// `translateX`), trimmed to 3 decimals.
fn write_offset(tree: &mut Tree, id: &str, dx: f32, dy: f32, scale: f32) {
    let s = if scale > 0.0 { scale } else { 1.0 };
    if dx == 0.0 && dy == 0.0 {
        tree.remove_prop_raw(id, LOCAL_DX_PROP);
        tree.remove_prop_raw(id, LOCAL_DY_PROP);
        return;
    }
    tree.set_prop_raw(id, LOCAL_DX_PROP, Value::from(round3((dx / s) as f64)));
    tree.set_prop_raw(id, LOCAL_DY_PROP, Value::from(round3((dy / s) as f64)));
}

fn clear_offset(tree: &mut Tree, id: &str) {
    tree.remove_prop_raw(id, LOCAL_DX_PROP);
    tree.remove_prop_raw(id, LOCAL_DY_PROP);
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/// The renderer-resident drag-and-drop runtime. See the module header.
pub struct DesktopDnd {
    nodes: HashMap<String, DndNode>,
    drag: Option<ActiveDrag>,
    clock: Clock,
    pending: Vec<DndDispatch>,
    dirty: DndDirty,
    cleanup_timeout_ms: f64,
    press_delay_ms: f64,
    slop_px: f64,
    warned_mixed_bind: bool,
    /// An OS file drag hovering the window (`files: true` zones), if any.
    file_hover: Option<files::FileHover>,
}

impl Default for DesktopDnd {
    fn default() -> Self {
        Self::new()
    }
}

impl DesktopDnd {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            drag: None,
            clock: Clock::Real(std::time::Instant::now()),
            pending: Vec::new(),
            dirty: DndDirty::default(),
            cleanup_timeout_ms: DND_DEFAULT_CLEANUP_MS,
            press_delay_ms: DND_PRESS_MS,
            slop_px: DND_SLOP_PX,
            warned_mixed_bind: false,
            file_hover: None,
        }
    }

    fn now(&self) -> f64 {
        match self.clock {
            Clock::Real(start) => start.elapsed().as_secs_f64() * 1000.0,
            Clock::Manual(t) => t,
        }
    }

    /// Inject an absolute clock value (tests) — the animator / scrubber
    /// deterministic-clock pattern.
    pub fn set_manual_time_ms(&mut self, t: f64) {
        self.clock = Clock::Manual(t);
    }

    /// Drain the queued dispatches, in order (the window forwards each to
    /// `module.dispatch_action(action, Some(payload))`).
    pub fn take_dispatches(&mut self) -> Vec<DndDispatch> {
        std::mem::take(&mut self.pending)
    }

    /// Drain the accumulated tree-write flags since the last call.
    pub fn take_dirty(&mut self) -> DndDirty {
        std::mem::take(&mut self.dirty)
    }

    /// A drag past activation is in flight (dragging or holding).
    pub fn is_active(&self) -> bool {
        self.drag
            .as_ref()
            .is_some_and(|d| d.phase != Phase::Pending)
    }

    /// A claimed drag follows the pointer right now.
    pub fn is_dragging(&self) -> bool {
        self.drag
            .as_ref()
            .is_some_and(|d| d.phase == Phase::Dragging)
    }

    /// Does the drag own `id` — the dragged source / item (dragging or
    /// holding) or a sibling holding a preview shift? The window unions
    /// these into the animator's scrub-active set (dnd > scrub >
    /// playbacks > transaction).
    pub fn owns_node(&self, id: &str) -> bool {
        let Some(drag) = self.drag.as_ref() else {
            return false;
        };
        if drag.phase == Phase::Pending {
            return false;
        }
        if id == drag.source || id == drag.item {
            return true;
        }
        drag.lists.values().any(|list| {
            list.items
                .iter()
                .zip(list.shifts.iter())
                .any(|(item, shift)| *shift != 0.0 && item == id)
        })
    }

    /// The set of currently-owned node ids (see [`Self::owns_node`]).
    pub fn owned_ids(&self) -> HashSet<String> {
        let mut out = HashSet::new();
        let Some(drag) = self.drag.as_ref() else {
            return out;
        };
        if drag.phase == Phase::Pending {
            return out;
        }
        out.insert(drag.source.clone());
        out.insert(drag.item.clone());
        for list in drag.lists.values() {
            for (item, shift) in list.items.iter().zip(list.shifts.iter()) {
                if *shift != 0.0 {
                    out.insert(item.clone());
                }
            }
        }
        out
    }

    /// Any live deadline (press / dwell / hold) — keeps the redraw ticker
    /// armed so [`Self::tick`] gets to fire it.
    pub fn has_active(&self) -> bool {
        self.drag.as_ref().is_some_and(|d| {
            d.press_deadline.is_some()
                || d.dwell_deadline.is_some()
                || d.hold_deadline.is_some()
                // A stale list wants one more frame: the redraw that
                // computes the fresh layout ticks before it, so the
                // rebuild lands on the frame after.
                || (d.stale && d.phase == Phase::Dragging)
        })
    }

    /// The dragged item and its whole subtree while a drag is lifted or
    /// held — the painter draws these LAST so the ghost floats above its
    /// siblings (§6.2 "raise it above siblings").
    pub fn raised_ids(&self, tree: &Tree) -> HashSet<String> {
        let mut out = HashSet::new();
        let Some(drag) = self.drag.as_ref() else {
            return out;
        };
        if drag.phase == Phase::Pending {
            return out;
        }
        let mut stack = vec![drag.item.clone()];
        while let Some(id) = stack.pop() {
            for child in tree.children_of(&id) {
                stack.push(child.clone());
            }
            out.insert(id);
        }
        out
    }

    // ---------------------------------------------------------------------
    // Batch observation (runs BEFORE the scrubber and the animator)
    // ---------------------------------------------------------------------

    /// Observe a patch batch: register `__dnd.*` channels (+ `bind`, `id`,
    /// `__anim.statePoses`) off Creates, route their SetProp/RemoveProp
    /// re-resolves, release a post-drop hold when the engine's re-render
    /// lands (a Move/Insert under the origin or destination, a translate
    /// SetProp on the dragged node), cancel on Remove/Detach of a drag
    /// participant with NO dispatch, and — drag wins — swallow engine
    /// SetProps to the lifted node's translate keys (latest value replayed
    /// at release) and to a pose-overridden key while its label is live.
    pub fn pre_ingest(&mut self, patches: &mut Vec<Patch>, tree: &mut Tree) {
        let mut kept: Vec<Patch> = Vec::with_capacity(patches.len());
        for patch in patches.drain(..) {
            match &patch {
                Patch::Create { id, props, .. } => {
                    self.register_create(id, props.as_ref(), tree);
                    kept.push(patch);
                }
                Patch::SetProp { id, name, value } => {
                    if (name == "__dnd.pinX" || name == "__dnd.pinY")
                        && self.defer_engine_prop(id, name, value, tree)
                    {
                        continue;
                    }
                    if name.starts_with(wire::DND_PROP_PREFIX) {
                        self.set_channel(id, name, Some(value), tree);
                        kept.push(patch);
                    } else if name == ANIM_STATE_POSES_PROP {
                        self.set_poses(id, Some(value), tree);
                        kept.push(patch);
                    } else if name == "bind" || name == "id" || name == "id.0" {
                        self.note_prop(id, name, Some(value));
                        kept.push(patch);
                    } else if self.defer_engine_prop(id, name, value, tree) {
                        // Swallowed: the drag / pose owns this key.
                    } else {
                        kept.push(patch);
                    }
                }
                Patch::RemoveProp { id, name } => {
                    if name.starts_with(wire::DND_PROP_PREFIX) {
                        self.set_channel(id, name, None, tree);
                    } else if name == ANIM_STATE_POSES_PROP {
                        self.set_poses(id, None, tree);
                    } else if name == "bind" || name == "id" || name == "id.0" {
                        self.note_prop(id, name, None);
                    } else if self.defer_engine_remove(id, name) {
                        continue;
                    }
                    kept.push(patch);
                }
                Patch::Insert { parent_id, id, .. }
                | Patch::Move { parent_id, id, .. }
                | Patch::Attach { parent_id, id, .. } => {
                    self.note_structural(tree, Some(parent_id), id);
                    kept.push(patch);
                }
                Patch::Remove { id, .. } => {
                    self.note_structural(tree, None, id);
                    self.cancel_subtree(tree, id);
                    self.forget_subtree(tree, id);
                    kept.push(patch);
                }
                Patch::Detach { id } => {
                    self.note_structural(tree, None, id);
                    self.cancel_subtree(tree, id);
                    kept.push(patch);
                }
                _ => kept.push(patch),
            }
        }
        *patches = kept;
    }

    fn register_create(
        &mut self,
        id: &str,
        props: &indexmap::IndexMap<String, Value>,
        tree: &mut Tree,
    ) {
        let has_dnd = props.keys().any(|k| k.starts_with(wire::DND_PROP_PREFIX));
        let poses = props.get(ANIM_STATE_POSES_PROP);
        if !has_dnd && poses.is_none() {
            return;
        }
        // A re-Create of a live id replaces the node: any overlay is gone
        // with the old props.
        if let Some(existing) = self.nodes.get_mut(id) {
            existing.pose_label = None;
            existing.pose_saved.clear();
        }
        let node = self
            .nodes
            .entry(id.to_string())
            .or_insert_with(DndNode::new);
        node.bind = props
            .get("bind")
            .and_then(Value::as_str)
            .map(str::to_string);
        node.id_prop = props
            .get("id.0")
            .or_else(|| props.get("id"))
            .and_then(parse_string);
        for (key, value) in props.iter() {
            if key.starts_with(wire::DND_PROP_PREFIX) {
                assign_channel(node, id, key, Some(value));
            }
        }
        if let Some(p) = poses {
            node.poses = parse_poses(p);
        }
        self.reconfigure(id, tree);
    }

    fn set_channel(&mut self, id: &str, name: &str, value: Option<&Value>, tree: &mut Tree) {
        let node = self
            .nodes
            .entry(id.to_string())
            .or_insert_with(DndNode::new);
        assign_channel(node, id, name, value);
        self.reconfigure(id, tree);
    }

    fn set_poses(&mut self, id: &str, value: Option<&Value>, tree: &mut Tree) {
        if !self.nodes.contains_key(id) && value.is_none() {
            return;
        }
        if self.nodes.get(id).is_some_and(|n| n.pose_label.is_some()) {
            self.clear_pose(tree, id);
        }
        let node = self
            .nodes
            .entry(id.to_string())
            .or_insert_with(DndNode::new);
        node.poses = value.and_then(parse_poses);
    }

    fn note_prop(&mut self, id: &str, name: &str, value: Option<&Value>) {
        let Some(node) = self.nodes.get_mut(id) else {
            return;
        };
        match name {
            "bind" => node.bind = value.and_then(Value::as_str).map(str::to_string),
            _ => node.id_prop = value.and_then(parse_string),
        }
    }

    /// After any channel change: a source going away (or disabled)
    /// mid-drag cancels cleanly with no dispatch (a hold is left to run).
    fn reconfigure(&mut self, id: &str, tree: &mut Tree) {
        let live_source = self
            .nodes
            .get(id)
            .is_some_and(|n| n.source.is_some() && n.source_enabled);
        if live_source {
            return;
        }
        let is_source = self
            .drag
            .as_ref()
            .is_some_and(|d| d.source == id && d.phase != Phase::Holding);
        if is_source {
            self.cancel_drag(tree, false);
        }
    }

    /// Deferral gate (drag wins). Returns `true` when the SetProp is
    /// swallowed. A translate write on the dragged node DURING the hold is
    /// the engine's re-render (a pin position): it releases the hold and
    /// flows through.
    fn defer_engine_prop(&mut self, id: &str, name: &str, value: &Value, tree: &mut Tree) -> bool {
        let base = base_of(name);
        let mut release_now = false;
        if let Some(drag) = self.drag.as_mut() {
            if drag.phase != Phase::Pending
                && (is_translate_base(&base) || name == "__dnd.pinX" || name == "__dnd.pinY")
                && (id == drag.source || id == drag.item)
            {
                if drag.phase == Phase::Holding {
                    release_now = true;
                } else {
                    drag.deferred
                        .entry(id.to_string())
                        .or_default()
                        .insert(name.to_string(), value.clone());
                    return true;
                }
            }
        }
        if release_now {
            // Release restores the pre-drag base; this very write then
            // applies through the flush (kept in the batch).
            self.release(tree);
            return false;
        }
        if let Some(node) = self.nodes.get_mut(id) {
            if let (Some(label), Some(poses)) = (node.pose_label.as_deref(), node.poses.as_ref()) {
                let overridden = poses
                    .get(label)
                    .is_some_and(|pose| pose.keys().any(|k| base_of(k) == base));
                if overridden {
                    // Land it in the restore set so the clear applies it.
                    node.pose_saved.insert(
                        name.to_string(),
                        Stored {
                            present: true,
                            value: value.clone(),
                        },
                    );
                    return true;
                }
            }
        }
        false
    }

    /// RemoveProp counterpart of [`Self::defer_engine_prop`] for a
    /// pose-overridden key: the restore set records the absence.
    fn defer_engine_remove(&mut self, id: &str, name: &str) -> bool {
        let base = base_of(name);
        let Some(node) = self.nodes.get_mut(id) else {
            return false;
        };
        let (Some(label), Some(poses)) = (node.pose_label.as_deref(), node.poses.as_ref()) else {
            return false;
        };
        let overridden = poses
            .get(label)
            .is_some_and(|pose| pose.keys().any(|k| base_of(k) == base));
        if overridden {
            node.pose_saved.insert(
                name.to_string(),
                Stored {
                    present: false,
                    value: Value::Null,
                },
            );
            return true;
        }
        false
    }

    /// A structural change touched `parent` / `id`. During a hold under
    /// the origin or destination (or on the dragged node itself) this is
    /// the re-render landing — release. During a live drag a foreign list
    /// that changed shape drops its cached preview so the next move
    /// re-measures it.
    fn note_structural(&mut self, tree: &mut Tree, parent: Option<&str>, id: &str) {
        let Some(drag) = self.drag.as_ref() else {
            return;
        };
        match drag.phase {
            Phase::Pending => {}
            Phase::Holding => {
                let target_id = drag.target.as_ref().map(|t| t.node_id().to_string());
                let under_lists = parent.is_some_and(|p| {
                    drag.origin.as_deref() == Some(p) || target_id.as_deref() == Some(p)
                });
                if id == drag.item || id == drag.source || under_lists {
                    self.release(tree);
                }
            }
            Phase::Dragging => {
                let drag = self.drag.as_mut().expect("checked above");
                if let Some(p) = parent {
                    let foreign = drag.origin.as_deref() != Some(p) && drag.lists.contains_key(p);
                    if foreign {
                        if let Some(mut list) = drag.lists.remove(p) {
                            restore_list(tree, &mut list);
                            self.dirty.transforms = true;
                        }
                    }
                }
                // Any surviving cached list (the origin included) that
                // `parent` sits at-or-under, or that holds `id`, changed
                // shape: its slots — and the reserved write's `from` —
                // must track the engine's re-render. The tree has not
                // applied the batch yet, so rebuild lazily.
                let touched = drag.lists.iter().any(|(container, list)| {
                    parent.is_some_and(|p| is_at_or_under(tree, p, container))
                        || list.items.iter().any(|it| it == id)
                });
                if touched {
                    drag.stale = true;
                }
            }
        }
    }

    /// A detaching / removed subtree rooted at `root`: a drag whose source
    /// or item lives at-or-under it cancels cleanly and dispatches NOTHING
    /// (§6.6). A pending drag is simply abandoned.
    fn cancel_subtree(&mut self, tree: &mut Tree, root: &str) {
        let participant = self.drag.as_ref().is_some_and(|d| {
            is_at_or_under(tree, &d.source, root) || is_at_or_under(tree, &d.item, root)
        });
        if participant {
            self.cancel_drag(tree, false);
        }
    }

    fn forget_subtree(&mut self, tree: &Tree, root: &str) {
        let ids: Vec<String> = self
            .nodes
            .keys()
            .filter(|id| is_at_or_under(tree, id, root))
            .cloned()
            .collect();
        for id in ids {
            self.nodes.remove(&id);
        }
    }

    /// Drop all state for `id` (a removed / evicted node). Cancels any drag
    /// it participates in without dispatching.
    pub fn forget(&mut self, id: &str, tree: &mut Tree) {
        self.cancel_subtree(tree, id);
        self.nodes.remove(id);
    }

    /// Cancel any in-flight drag (no dispatch) and drop every record.
    pub fn reset(&mut self, tree: &mut Tree) {
        if self.drag.is_some() {
            self.cancel_drag(tree, false);
        }
        self.file_hover_end(tree);
        self.nodes.clear();
        self.pending.clear();
    }

    // ---------------------------------------------------------------------
    // Pose overlay (§2.1 runtime labels)
    // ---------------------------------------------------------------------

    fn apply_pose(&mut self, tree: &mut Tree, id: &str, label: &str) {
        let has_label = self
            .nodes
            .get(id)
            .and_then(|n| n.pose_label.as_deref())
            .map(|l| l == label);
        match has_label {
            Some(true) => return,
            Some(false) => self.clear_pose(tree, id),
            None => {}
        }
        let Some(node) = self.nodes.get_mut(id) else {
            return;
        };
        let Some(pose) = node.poses.as_ref().and_then(|p| p.get(label)).cloned() else {
            return;
        };
        node.pose_saved.clear();
        let mut entries: Vec<(String, Value)> = Vec::with_capacity(pose.len());
        for (key, value) in pose {
            let base = base_of(&key);
            if base.contains('@') || base.contains(':') {
                // Variant-qualified pose keys resolve through the same
                // variant chain as any prop, but a breakpoint / state
                // overlay has no single base to restore — skipped, warned
                // once (DOM parity).
                if !node.warned_variant_pose {
                    node.warned_variant_pose = true;
                    log::warn!(
                        "dnd: variant-qualified pose key \"{key}\" on node {id} is not applied by the runtime"
                    );
                }
                continue;
            }
            node.pose_saved
                .entry(key.clone())
                .or_insert_with(|| capture(tree, id, &key));
            entries.push((key, value));
        }
        node.pose_label = Some(label.to_string());
        for (key, value) in entries {
            tree.set_prop_raw(id, &key, value);
        }
        self.dirty.props = true;
    }

    fn clear_pose(&mut self, tree: &mut Tree, id: &str) {
        let Some(node) = self.nodes.get_mut(id) else {
            return;
        };
        if node.pose_label.take().is_none() {
            return;
        }
        let saved: Vec<(String, Stored)> = node.pose_saved.drain().collect();
        for (key, stored) in saved {
            apply_stored(tree, id, &key, &stored);
        }
        self.dirty.props = true;
    }

    // ---------------------------------------------------------------------
    // Geometry: origins, items, lists
    // ---------------------------------------------------------------------

    /// Nearest enclosing sortable / pinboard of a source (parent walk).
    fn find_origin(&self, tree: &Tree, source: &str) -> Option<String> {
        let mut current = tree.parent_of(source);
        while let Some(cur) = current {
            if self.nodes.get(cur).is_some_and(DndNode::is_container) {
                return Some(cur.to_string());
            }
            current = tree.parent_of(cur);
        }
        None
    }

    /// Direct children of a container that carry (or contain) a source, in
    /// child order.
    fn draggable_items(&self, tree: &Tree, container: &str) -> Vec<String> {
        let mut members: HashSet<String> = HashSet::new();
        for (id, node) in &self.nodes {
            if node.source.is_none() || id == container {
                continue;
            }
            if let Some(item) = item_of(tree, container, id) {
                members.insert(item);
            }
        }
        tree.children_of(container)
            .iter()
            .filter(|c| members.contains(*c))
            .cloned()
            .collect()
    }

    fn index_of(&self, tree: &Tree, container: &str, item: &str) -> Option<usize> {
        self.draggable_items(tree, container)
            .iter()
            .position(|i| i == item)
    }

    fn container_label(&self, id: &str) -> String {
        self.nodes
            .get(id)
            .and_then(|n| {
                n.container_group()
                    .map(str::to_string)
                    .or_else(|| n.id_prop.clone())
            })
            .unwrap_or_else(|| id.to_string())
    }

    /// §4.2 `zone` label of a drop target: a sortable / pinboard reads as
    /// its group, else its `id` prop, else the node id (even when it is hit
    /// as a plain "into" zone — a foreign pinboard); a `.dropZone` reads as
    /// its `zoneId`, else its `id` prop, else the node id.
    fn zone_label(&self, id: &str) -> String {
        if self.nodes.get(id).is_some_and(DndNode::is_container) {
            return self.container_label(id);
        }
        self.nodes
            .get(id)
            .and_then(|n| n.zone_id.clone().or_else(|| n.id_prop.clone()))
            .unwrap_or_else(|| id.to_string())
    }

    /// `from.zone` for a source outside any sortable / pinboard: the
    /// nearest enclosing zone's label, else the parent node id, else the
    /// source id.
    fn loose_zone_label(&self, tree: &Tree, source: &str) -> String {
        let mut current = tree.parent_of(source);
        while let Some(cur) = current {
            if self.nodes.get(cur).is_some_and(|n| n.zone.is_some()) {
                return self.zone_label(cur);
            }
            current = tree.parent_of(cur);
        }
        match tree.parent_of(source) {
            Some(p) if p != ROOT_ID => p.to_string(),
            _ => source.to_string(),
        }
    }

    /// A bare `.draggable()` inside a `.sortable` / `.pinboard` inherits the
    /// container's group (design §4.2): the source's own group wins.
    fn effective_group(&self, source: &str, origin: Option<&str>) -> Option<String> {
        if let Some(g) = self
            .nodes
            .get(source)
            .and_then(|n| n.source.as_ref())
            .and_then(|s| s.group.clone())
        {
            return Some(g);
        }
        origin
            .and_then(|o| self.nodes.get(o))
            .and_then(|n| n.container_group().map(str::to_string))
    }

    /// Group compatibility. A sortable / pinboard always accepts its own
    /// children and, with a group, any source of that group. A drop zone
    /// with a group accepts that group; an ungrouped zone accepts ungrouped
    /// sources and its own descendants.
    fn accepts(&self, tree: &Tree, zone: &str, source: &str, origin: Option<&str>) -> bool {
        let Some(z) = self.nodes.get(zone) else {
            return false;
        };
        let is_descendant = is_at_or_under(tree, source, zone);
        let source_group = self.effective_group(source, origin);
        if z.is_container() {
            let group = z.container_group();
            return is_descendant || (group.is_some() && source_group.as_deref() == group);
        }
        if !z.zone_enabled {
            return false;
        }
        match z.zone.as_ref().and_then(|s| s.group.as_deref()) {
            Some(group) => source_group.as_deref() == Some(group),
            None => source_group.is_none() || is_descendant,
        }
    }

    /// Every zone (dropZone / sortable / pinboard) a drag from `source` may
    /// target. A source is never a zone for itself — nor is anything under
    /// the dragged item.
    fn candidate_zones(&self, tree: &Tree, drag: &ActiveDrag) -> Vec<String> {
        let mut out = Vec::new();
        for (id, node) in &self.nodes {
            if !node.is_zone_like() || *id == drag.source {
                continue;
            }
            if is_at_or_under(tree, id, &drag.item) {
                continue;
            }
            if !self.accepts(tree, id, &drag.source, drag.origin.as_deref()) {
                continue;
            }
            out.push(id.clone());
        }
        out
    }

    fn list_for<'a>(
        &self,
        drag: &'a mut ActiveDrag,
        tree: &Tree,
        layout: &LayoutPass,
        container: &str,
    ) -> &'a mut ListPreview {
        if !drag.lists.contains_key(container) {
            let axis = self
                .nodes
                .get(container)
                .and_then(|n| n.sort.as_ref())
                .map(|s| s.axis)
                .unwrap_or(Axis::Y);
            let items = self.draggable_items(tree, container);
            let rects: Vec<Rect> = items
                .iter()
                .map(|it| {
                    if *it == drag.item {
                        drag.item_rect
                    } else {
                        layout.item_by_id(it).map(|i| i.rect).unwrap_or(Rect {
                            x: 0.0,
                            y: 0.0,
                            w: 0.0,
                            h: 0.0,
                        })
                    }
                })
                .collect();
            let gap = gap_of(&rects, axis);
            let shifts = vec![0.0; items.len()];
            drag.lists.insert(
                container.to_string(),
                ListPreview {
                    axis,
                    items,
                    rects,
                    gap,
                    shifts,
                },
            );
        }
        drag.lists.get_mut(container).expect("inserted above")
    }

    /// Re-derive one cached list from the live tree: the current
    /// draggable children, their BASE rects off the fresh layout (shifts
    /// are transforms, so no un-shifting), the dragged item's lift rect,
    /// and each surviving item's carried shift. Items that left the list
    /// drop their offset. Returns `true` when an offset was cleared.
    fn rebuild_list(
        &self,
        tree: &mut Tree,
        layout: &LayoutPass,
        drag: &ActiveDrag,
        container: &str,
        list: &mut ListPreview,
    ) -> bool {
        let items = self.draggable_items(tree, container);
        let mut rects = Vec::with_capacity(items.len());
        let mut shifts = Vec::with_capacity(items.len());
        for it in &items {
            let prev = list.items.iter().position(|p| p == it);
            shifts.push(prev.map(|p| list.shifts[p]).unwrap_or(0.0));
            rects.push(if *it == drag.item {
                drag.item_rect
            } else {
                layout.item_by_id(it).map(|i| i.rect).unwrap_or(Rect {
                    x: 0.0,
                    y: 0.0,
                    w: 0.0,
                    h: 0.0,
                })
            });
        }
        let mut cleared = false;
        for (old, shift) in list.items.iter().zip(list.shifts.iter()) {
            if *shift != 0.0 && !items.contains(old) {
                clear_offset(tree, old);
                cleared = true;
            }
        }
        list.gap = gap_of(&rects, list.axis);
        list.items = items;
        list.rects = rects;
        list.shifts = shifts;
        cleared
    }

    /// Consume a stale mark: with a fresh layout every cached list
    /// rebuilds ([`Self::rebuild_list`]); with or without one the origin's
    /// `origin_index` re-derives from the live tree so the reserved
    /// write's `from` names the dragged item's CURRENT slot. Without a
    /// layout the mark stays (the rects wait for the next laid-out call).
    /// Returns `true` when a stale drag was refreshed.
    fn rebuild_stale_lists(&mut self, tree: &mut Tree, layout: Option<&LayoutPass>) -> bool {
        let Some(mut drag) = self.drag.take() else {
            return false;
        };
        let stale = drag.stale && drag.phase == Phase::Dragging;
        if stale {
            if let Some(layout) = layout {
                let containers: Vec<String> = drag.lists.keys().cloned().collect();
                for container in containers {
                    let mut list = drag.lists.remove(&container).expect("key");
                    if self.rebuild_list(tree, layout, &drag, &container, &mut list) {
                        self.dirty.transforms = true;
                    }
                    drag.lists.insert(container, list);
                }
                drag.stale = false;
            }
            if let Some(o) = drag.origin.as_deref() {
                if let Some(live) = self.index_of(tree, o, &drag.item) {
                    drag.origin_index = Some(live);
                }
            }
        }
        self.drag = Some(drag);
        stale
    }

    /// [`Self::rebuild_stale_lists`], then re-resolve the drop target
    /// against the last pointer position so the gap preview and the
    /// pending `to` follow the rebuilt slots without a new move.
    fn refresh_stale(&mut self, tree: &mut Tree, layout: Option<&LayoutPass>) {
        if !self.rebuild_stale_lists(tree, layout) {
            return;
        }
        let last = self.drag.as_ref().and_then(|d| d.last_pointer);
        if let (Some(layout), Some((x, y, viewport))) = (layout, last) {
            self.resolve_target(tree, layout, viewport, x, y);
        }
    }

    /// The board's RENDERED content box (physical px): the item rect inset
    /// by border width + padding (both logical, scaled), under the board's
    /// cumulative transform.
    fn content_box(
        &self,
        tree: &Tree,
        layout: &LayoutPass,
        viewport: Viewport,
        scale: f32,
        id: &str,
    ) -> Option<Rect> {
        let it = layout.item_by_id(id)?;
        let node = tree.get(id)?;
        let pad = crate::style::padding_at(node, viewport);
        let bw = it.border.width.max(0.0);
        let x = it.rect.x + (bw + pad.left) * scale;
        let y = it.rect.y + (bw + pad.top) * scale;
        let w = (it.rect.w - (2.0 * bw + pad.left + pad.right) * scale).max(0.0);
        let h = (it.rect.h - (2.0 * bw + pad.top + pad.bottom) * scale).max(0.0);
        // RENDERED content box (the board's cumulative transform applied),
        // the same space as the dragged item's `rendered_rect`.
        Some(it.transform.aabb_of(Rect { x, y, w, h }))
    }

    // ---------------------------------------------------------------------
    // Pointer source (winit)
    // ---------------------------------------------------------------------

    /// A press inside an enabled source's laid-out bounds opens a PENDING
    /// drag (topmost source wins, paint order). `immediate` claims at once;
    /// `press` arms the long-press deadline; `auto` / `slop` wait for 6px
    /// of travel. It stays pending until it claims, so the window's
    /// press / focus bookkeeping still runs — a below-slop tap remains an
    /// ordinary click. Returns `true` when a drag opened.
    pub fn pointer_down(
        &mut self,
        tree: &mut Tree,
        layout: &LayoutPass,
        x: f64,
        y: f64,
        scale: f32,
    ) -> bool {
        if self.drag.is_some() {
            return false; // one cursor, one drag (also: a hold is not interruptible)
        }
        let (px, py) = (x as f32, y as f32);
        let mut best: Option<String> = None;
        for item in layout.items.iter() {
            let Some(node) = self.nodes.get(&item.node_id) else {
                continue;
            };
            if node.source.is_none() || !node.source_enabled {
                continue;
            }
            if item.hit_contains(px, py) {
                best = Some(item.node_id.clone());
            }
        }
        let Some(source) = best else {
            return false;
        };
        let activation = match self
            .nodes
            .get(&source)
            .and_then(|n| n.source.as_ref())
            .map(|s| s.activation)
            .unwrap_or(Activation::Auto)
        {
            Activation::Immediate => ArmedActivation::Immediate,
            Activation::Press => ArmedActivation::Press,
            // Mouse `auto` is slop (the touch cross-axis / long-press rules
            // never apply: no touch source on desktop).
            Activation::Auto | Activation::Slop => ArmedActivation::Slop,
        };
        let origin = self.find_origin(tree, &source);
        let item = match origin.as_deref() {
            Some(o) if self.nodes.get(o).is_some_and(|n| n.sort.is_some()) => {
                item_of(tree, o, &source).unwrap_or_else(|| source.clone())
            }
            _ => source.clone(),
        };
        let origin_index = origin
            .as_deref()
            .and_then(|o| self.index_of(tree, o, &item));
        let from = match origin.as_deref() {
            Some(o) => Location {
                zone: self.container_label(o),
                index: origin_index,
            },
            None => Location {
                zone: self.loose_zone_label(tree, &source),
                index: None,
            },
        };
        let (item_rect, rendered_rect) = layout
            .item_by_id(&item)
            .map(|it| (it.rect, it.visual_rect()))
            .unwrap_or_else(|| {
                let r = Rect {
                    x: px,
                    y: py,
                    w: 0.0,
                    h: 0.0,
                };
                (r, r)
            });
        let now = self.now();
        self.drag = Some(ActiveDrag {
            phase: Phase::Pending,
            source,
            item,
            origin,
            origin_index,
            from,
            start: (x, y),
            activation,
            press_deadline: if activation == ArmedActivation::Press {
                Some(now + self.press_delay_ms)
            } else {
                None
            },
            dx: 0.0,
            dy: 0.0,
            item_rect,
            rendered_rect,
            scale: if scale > 0.0 { scale } else { 1.0 },
            ghost_engaged: false,
            target: None,
            over_node: None,
            dwell_deadline: None,
            lists: HashMap::new(),
            stale: false,
            last_pointer: None,
            hold_deadline: None,
            deferred: HashMap::new(),
        });
        if activation == ArmedActivation::Immediate {
            self.claim(tree, Some(layout));
        }
        true
    }

    /// Drive the active drag. A pending drag claims on its activation rule
    /// (or abandons silently on scroll-like travel before a press fires);
    /// a claimed drag moves the ghost and re-resolves the drop target.
    /// Writes are reported through [`Self::take_dirty`].
    pub fn pointer_move(
        &mut self,
        tree: &mut Tree,
        layout: Option<&LayoutPass>,
        viewport: Viewport,
        x: f64,
        y: f64,
    ) {
        let Some(drag) = self.drag.as_mut() else {
            return;
        };
        let dx = x - drag.start.0;
        let dy = y - drag.start.1;
        match drag.phase {
            Phase::Holding => return,
            Phase::Pending => {
                let travel = dx.abs().max(dy.abs());
                match drag.activation {
                    ArmedActivation::Slop => {
                        if travel < self.slop_px {
                            return;
                        }
                    }
                    ArmedActivation::Press => {
                        // Travel before the press fires is a scroll / pan:
                        // abandon silently.
                        if travel >= self.slop_px {
                            self.drag = None;
                        }
                        return;
                    }
                    ArmedActivation::Immediate => return, // already claimed
                }
                self.claim(tree, layout);
                if !self.is_dragging() {
                    return;
                }
            }
            Phase::Dragging => {}
        }
        let Some(drag) = self.drag.as_mut() else {
            return;
        };
        drag.dx = dx as f32;
        drag.dy = dy as f32;
        drag.last_pointer = Some((x as f32, y as f32, viewport));
        let (item, gdx, gdy, scale) = (drag.item.clone(), drag.dx, drag.dy, drag.scale);
        write_offset(tree, &item, gdx, gdy, scale);
        self.dirty.transforms = true;
        // A list that changed shape since the last move rebuilds against
        // this layout BEFORE the target resolves against it.
        self.rebuild_stale_lists(tree, layout);
        if let Some(layout) = layout {
            self.resolve_target(tree, layout, viewport, x as f32, y as f32);
        }
    }

    /// Pointer released: a pending (below-slop / pre-press) drag is a TOTAL
    /// no-op and the click passes through; a claimed drag drops on its
    /// current target (§4.2 ordering) or cancels when over nothing. A
    /// list that changed shape since the last move re-resolves against
    /// `layout` first, so the drop names the live slots.
    pub fn pointer_up(&mut self, tree: &mut Tree, layout: Option<&LayoutPass>) -> DndPointerUp {
        self.refresh_stale(tree, layout);
        let Some(drag) = self.drag.as_ref() else {
            return DndPointerUp::NoOp;
        };
        match drag.phase {
            Phase::Pending => {
                self.drag = None;
                DndPointerUp::NoOp
            }
            Phase::Holding => DndPointerUp::NoOp,
            Phase::Dragging => {
                match drag.target.clone() {
                    Some(target) => self.commit(tree, target),
                    None => self.cancel_drag(tree, true),
                }
                DndPointerUp::Claimed
            }
        }
    }

    /// The window's `pointercancel` (focus loss): a pending drag is
    /// discarded, a claimed drag cancels with `.onDragEnd {dropped: false}`.
    pub fn pointer_cancel(&mut self, tree: &mut Tree) {
        match self.drag.as_ref().map(|d| d.phase) {
            Some(Phase::Pending) => self.drag = None,
            Some(Phase::Dragging) => self.cancel_drag(tree, true),
            _ => {}
        }
    }

    /// Esc during a claimed drag cancels it (`.onDragEnd {dropped:
    /// false}`). Returns `true` when consumed.
    pub fn escape(&mut self, tree: &mut Tree) -> bool {
        if self.is_dragging() {
            self.cancel_drag(tree, true);
            return true;
        }
        false
    }

    /// Activation threshold met: the gesture claims the node — lift the
    /// ghost, apply the `lifted` pose, cache the origin list, and fire the
    /// opted-in `.onDragStart`.
    fn claim(&mut self, tree: &mut Tree, layout: Option<&LayoutPass>) {
        let Some(drag) = self.drag.as_mut() else {
            return;
        };
        if drag.phase != Phase::Pending {
            return;
        }
        drag.phase = Phase::Dragging;
        drag.press_deadline = None;
        drag.ghost_engaged = true;
        let (source, origin, from) = (drag.source.clone(), drag.origin.clone(), drag.from.clone());
        let (item, dx, dy, scale) = (drag.item.clone(), drag.dx, drag.dy, drag.scale);
        write_offset(tree, &item, dx, dy, scale);
        self.dirty.transforms = true;
        self.apply_pose(tree, &source, LABEL_LIFTED);
        if let (Some(o), Some(layout)) = (origin.as_deref(), layout) {
            if self.nodes.get(o).is_some_and(|n| n.sort.is_some()) {
                let mut drag = self.drag.take().expect("claimed");
                self.list_for(&mut drag, tree, layout, o); // cache rects before any shift
                self.drag = Some(drag);
            }
        }
        let payload = self.payload(&from);
        self.dispatch_event(
            tree,
            &[Some(source.as_str()), origin.as_deref()],
            "onDragStart",
            &payload,
        );
    }

    // ---------------------------------------------------------------------
    // Zone resolution (§6.4)
    // ---------------------------------------------------------------------

    fn resolve_target(
        &mut self,
        tree: &mut Tree,
        layout: &LayoutPass,
        viewport: Viewport,
        x: f32,
        y: f32,
    ) {
        let Some(mut drag) = self.drag.take() else {
            return;
        };
        let mut innermost: Option<(usize, String)> = None;
        for zone in self.candidate_zones(tree, &drag) {
            let hit = layout
                .item_by_id(&zone)
                .is_some_and(|it| it.hit_contains(x, y));
            if !hit {
                continue;
            }
            let depth = depth_of(tree, &zone);
            let deeper = match innermost.as_ref() {
                None => true,
                Some((d, _)) => depth > *d,
            };
            if deeper {
                innermost = Some((depth, zone));
            }
        }
        let target = match innermost {
            None => None,
            Some((_, zone)) => {
                let node = self.nodes.get(&zone).expect("candidate");
                if let Some(sort) = node.sort.as_ref() {
                    let axis = sort.axis;
                    let dragged = drag.item.clone();
                    let list = self.list_for(&mut drag, tree, layout, &zone);
                    let pos = if axis == Axis::X { x } else { y };
                    let index = insertion_index(list, &dragged, pos);
                    Some(DropTarget::Sort {
                        container: zone,
                        index,
                    })
                } else if node.pin.is_some() {
                    if drag.origin.as_deref() == Some(zone.as_str()) {
                        let content_box = self
                            .content_box(tree, layout, viewport, drag.scale, &zone)
                            .unwrap_or(Rect {
                                x: 0.0,
                                y: 0.0,
                                w: 0.0,
                                h: 0.0,
                            });
                        Some(DropTarget::Pin {
                            container: zone,
                            content_box,
                        })
                    } else {
                        Some(DropTarget::Zone { node: zone })
                    }
                } else {
                    Some(self.resolve_band_target(&mut drag, tree, layout, &zone, x, y))
                }
            }
        };
        self.drag = Some(drag);
        self.set_target(tree, target);
    }

    /// A dropZone on a sortable item: band rule; elsewhere a plain "into".
    fn resolve_band_target(
        &self,
        drag: &mut ActiveDrag,
        tree: &Tree,
        layout: &LayoutPass,
        zone: &str,
        x: f32,
        y: f32,
    ) -> DropTarget {
        let into = DropTarget::Zone {
            node: zone.to_string(),
        };
        // Nearest enclosing sortable of the zone that accepts the source.
        let mut sortable: Option<String> = None;
        let mut current = tree.parent_of(zone);
        while let Some(cur) = current {
            if self.nodes.get(cur).is_some_and(|n| n.sort.is_some())
                && self.accepts(tree, cur, &drag.source, drag.origin.as_deref())
            {
                sortable = Some(cur.to_string());
                break;
            }
            current = tree.parent_of(cur);
        }
        let Some(sortable) = sortable else {
            return into;
        };
        let Some(item) = item_of(tree, &sortable, zone) else {
            return into;
        };
        let band = self
            .nodes
            .get(zone)
            .and_then(|n| n.zone.as_ref())
            .map(|z| z.band)
            .unwrap_or(wire::DEFAULT_BAND);
        let dragged = drag.item.clone();
        let list = self.list_for(drag, tree, layout, &sortable);
        let Some(i) = list.items.iter().position(|it| *it == item) else {
            return into;
        };
        let rect = list.rects[i];
        let pos = if list.axis == Axis::X { x } else { y };
        match resolve_band(
            pos,
            axis_start(rect, list.axis),
            axis_length(rect, list.axis),
            band,
        ) {
            Band::Into => into,
            b => {
                let others = list.items[..i].iter().filter(|it| **it != dragged).count();
                DropTarget::Sort {
                    container: sortable,
                    index: if b == Band::Before {
                        others
                    } else {
                        others + 1
                    },
                }
            }
        }
    }

    fn target_location(&self, drag: &ActiveDrag, target: Option<&DropTarget>) -> Location {
        match target {
            None => drag.from.clone(),
            Some(DropTarget::Sort { container, index }) => Location {
                zone: self.container_label(container),
                index: Some(*index),
            },
            Some(DropTarget::Zone { node }) => Location {
                zone: self.zone_label(node),
                index: None,
            },
            Some(DropTarget::Pin { container, .. }) => Location {
                zone: self.container_label(container),
                index: drag.origin_index,
            },
        }
    }

    fn set_target(&mut self, tree: &mut Tree, target: Option<DropTarget>) {
        let Some(mut drag) = self.drag.take() else {
            return;
        };
        let prev_node = drag.target.as_ref().map(|t| t.node_id().to_string());
        let next_node = target.as_ref().map(|t| t.node_id().to_string());
        // Sortable preview: shift the hovered list; reset lists no longer
        // hovered. Leaving the origin list closes its gap only when hovering
        // a foreign target; hovering nothing keeps the last preview.
        let origin = drag.origin.clone();
        let origin_is_sort = origin
            .as_deref()
            .is_some_and(|o| self.nodes.get(o).is_some_and(|n| n.sort.is_some()));
        let origin_index = drag.origin_index.unwrap_or(0);
        let dragged = drag.item.clone();
        let item_rect = drag.item_rect;
        let scale = drag.scale;
        let mut shifted = false;
        for (container, list) in drag.lists.iter_mut() {
            let to = match &target {
                Some(DropTarget::Sort {
                    container: c,
                    index,
                }) if c == container => Some(*index),
                _ if origin.as_deref() == Some(container.as_str()) && origin_is_sort => {
                    if target.is_some() {
                        Some(origin_index)
                    } else {
                        None
                    }
                }
                _ => Some(usize::MAX),
            };
            if let Some(to) = to {
                shifted |= preview_list(tree, list, &dragged, item_rect, to, scale);
            }
        }
        if shifted {
            self.dirty.transforms = true;
        }
        if next_node != prev_node {
            if let Some(prev) = prev_node.as_deref() {
                if self.nodes.get(prev).and_then(|n| n.pose_label.as_deref()) == Some(LABEL_OVER) {
                    self.clear_pose(tree, prev);
                }
            }
            drag.dwell_deadline = None;
            if let Some(next) = next_node.as_deref() {
                self.apply_pose(tree, next, LABEL_OVER);
                drag.dwell_deadline = self.dwell_for(tree, next).map(|ms| self.now() + ms);
            }
        }
        drag.target = target;
        drag.over_node = next_node;
        self.drag = Some(drag);
    }

    /// The `.onDragOver` dwell for a zone: `onDragOver.dwell` (non-negative
    /// number; a malformed value warns and falls back to the default), or
    /// `None` when the zone has no `onDragOver` binding.
    fn dwell_for(&self, tree: &Tree, zone: &str) -> Option<f64> {
        let node = tree.get(zone)?;
        crate::layout::resolve_named_event_action(node, "onDragOver")?;
        let raw = node.props.get("onDragOver.dwell");
        let dwell = match raw {
            None => DND_DEFAULT_DWELL_MS,
            Some(v) => {
                let n = match v {
                    Value::Number(n) => n.as_f64(),
                    Value::String(s) => s.trim().parse::<f64>().ok(),
                    _ => None,
                };
                match n.filter(|n| n.is_finite() && *n >= 0.0) {
                    Some(n) => n,
                    None => {
                        log::warn!("dnd: onDragOver dwell must be a non-negative number, got {v}; using the default");
                        DND_DEFAULT_DWELL_MS
                    }
                }
            }
        };
        Some(dwell)
    }

    // ---------------------------------------------------------------------
    // Drop / cancel / release
    // ---------------------------------------------------------------------

    /// §4.2 event payload: `{item, payload?, from, to}`.
    fn payload(&self, to: &Location) -> Map<String, Value> {
        let mut out = Map::new();
        let Some(drag) = self.drag.as_ref() else {
            return out;
        };
        let node = self.nodes.get(&drag.source);
        let item = node
            .and_then(|n| n.key.clone())
            .unwrap_or_else(|| drag.source.clone());
        out.insert("item".into(), Value::String(item));
        if let Some(n) = node.filter(|n| n.has_payload) {
            out.insert("payload".into(), n.payload.clone());
        }
        out.insert("from".into(), drag.from.to_json());
        out.insert("to".into(), to.to_json());
        out
    }

    /// Dispatch `name` to the first candidate node carrying that binding.
    /// Extra named arguments merge UNDER the §4.2 payload (the payload
    /// fields win); `dwell` is stripped from `onDragOver`.
    fn dispatch_event(
        &mut self,
        tree: &Tree,
        candidates: &[Option<&str>],
        name: &str,
        payload: &Map<String, Value>,
    ) {
        for cand in candidates.iter().flatten() {
            let Some(node) = tree.get(cand) else {
                continue;
            };
            let Some((action, args)) = crate::layout::resolve_named_event_action(node, name) else {
                continue;
            };
            let mut merged = match args {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            if name == "onDragOver" {
                merged.remove("dwell");
            }
            for (k, v) in payload {
                merged.insert(k.clone(), v.clone());
            }
            self.pending.push(DndDispatch {
                action: hypen_engine::action_routing::UI_ACTION.into(),
                payload: json!({"node": cand, "fromNode": self.drag.as_ref().and_then(|d| d.origin.as_ref()), "action": action, "payload": merged}),
            });
            return;
        }
    }

    fn dispatch_reserved(&mut self, action: &str, payload: Value) {
        let Some(drag) = self.drag.as_ref() else {
            return;
        };
        let owner = match &drag.target {
            Some(DropTarget::Sort { container, .. }) => Some(container),
            _ => {
                if drag
                    .origin
                    .as_ref()
                    .and_then(|id| self.nodes.get(id))
                    .and_then(|n| n.bind.as_ref())
                    .is_some()
                {
                    drag.origin.as_ref()
                } else {
                    Some(&drag.source)
                }
            }
        };
        let Some(owner) = owner else { return };
        self.pending.push(DndDispatch {
            action: hypen_engine::action_routing::UI_ACTION.into(),
            payload: json!({"node": owner, "fromNode": drag.origin, "action": action, "payload": payload}),
        });
    }

    /// Resolve a drop (§4.2 ordering): (1) the reserved write when a write
    /// target exists, (2) `.onSort` / `.onPin` / `.onDrop`, (3) `.onDragEnd
    /// {dropped: true}`; then hold the local transforms until the engine's
    /// re-render lands (or the cleanup timeout).
    fn commit(&mut self, tree: &mut Tree, target: DropTarget) {
        let (source, origin, origin_index) = {
            let Some(drag) = self.drag.as_mut() else {
                return;
            };
            drag.dwell_deadline = None;
            // Enter the hold BEFORE dispatching: the re-render's Move /
            // SetProp must find the hold to release.
            drag.phase = Phase::Holding;
            drag.target = Some(target.clone());
            (drag.source.clone(), drag.origin.clone(), drag.origin_index)
        };
        let to = {
            let drag = self.drag.as_ref().expect("holding");
            self.target_location(drag, Some(&target))
        };
        let base = self.payload(&to);
        let mut wrote_or_changed = true;
        match &target {
            DropTarget::Sort { container, index } => {
                let same_list = origin.as_deref() == Some(container.as_str());
                if same_list && origin_index == Some(*index) {
                    wrote_or_changed = false;
                } else {
                    let from_path = origin
                        .as_deref()
                        .and_then(|o| self.nodes.get(o))
                        .and_then(|n| n.bind.clone());
                    let to_path = self.nodes.get(container).and_then(|n| n.bind.clone());
                    match (same_list, from_path, to_path, origin_index) {
                        (true, _, Some(path), Some(from)) => self.dispatch_reserved(
                            REORDER_ACTION,
                            json!({ "path": path, "from": from, "to": index }),
                        ),
                        (false, Some(from_path), Some(to_path), Some(from)) => self.dispatch_reserved(
                            REORDER_ACTION,
                            json!({ "fromPath": from_path, "from": from, "toPath": to_path, "to": index }),
                        ),
                        (false, from_path, to_path, _) if from_path.is_some() != to_path.is_some() => {
                            if !self.warned_mixed_bind {
                                self.warned_mixed_bind = true;
                                log::warn!(
                                    "dnd: cross-list reorder between a bound and an unbound sortable; no reserved write dispatched"
                                );
                            }
                        }
                        _ => {}
                    }
                    let container = container.clone();
                    self.dispatch_event(tree, &[Some(container.as_str())], "onSort", &base);
                }
            }
            DropTarget::Zone { node } => {
                let node = node.clone();
                self.dispatch_event(tree, &[Some(node.as_str())], "onDrop", &base);
            }
            DropTarget::Pin {
                container,
                content_box,
            } => {
                let board = container.clone();
                let Some(spec) = self.nodes.get(&board).and_then(|n| n.pin.clone()) else {
                    self.release(tree);
                    return;
                };
                let (item_rect, dx, dy, scale, item) = {
                    let d = self.drag.as_ref().expect("holding");
                    (d.rendered_rect, d.dx, d.dy, d.scale, d.item.clone())
                };
                let s = scale as f64;
                // Source RENDERED top-left (layout rect under the item's own
                // translate — §6.11) plus the drag delta, minus the board's
                // rendered content-box origin, in LOGICAL px. Both sides sit
                // in viewport space, so a transformed common ancestor cancels.
                let raw_x = (item_rect.x + dx - content_box.x) as f64 / s;
                let raw_y = (item_rect.y + dy - content_box.y) as f64 / s;
                let mut px = snap_to_grid(raw_x, spec.grid);
                let mut py = snap_to_grid(raw_y, spec.grid);
                let (box_w, box_h) = (content_box.w as f64 / s, content_box.h as f64 / s);
                if spec.bounds == PinBounds::Clamp {
                    let (iw, ih) = (item_rect.w as f64 / s, item_rect.h as f64 / s);
                    px = px.clamp(0.0, (box_w - iw).max(0.0));
                    py = py.clamp(0.0, (box_h - ih).max(0.0));
                }
                // Snap the ghost to the resolved position so the hold shows it:
                // the local offset is relative to the same rendered origin, so
                // the held ghost and the dispatched value agree even when a
                // grid snap / clamp moved the pin off the raw drop point.
                let gdx = (px as f32) * scale + content_box.x - item_rect.x;
                let gdy = (py as f32) * scale + content_box.y - item_rect.y;
                write_offset(tree, &item, gdx, gdy, scale);
                self.dirty.transforms = true;
                if let Some(d) = self.drag.as_mut() {
                    d.dx = gdx;
                    d.dy = gdy;
                }
                let (x, y) = match spec.units {
                    PinUnits::Fraction => (
                        round3(if box_w > 0.0 { px / box_w } else { 0.0 }),
                        round3(if box_h > 0.0 { py / box_h } else { 0.0 }),
                    ),
                    PinUnits::Px => (round3(px), round3(py)),
                };
                let board_node = self.nodes.get(&board).expect("pin spec came from it");
                let path = match (board_node.bind.as_deref(), spec.group.as_deref()) {
                    (Some(bind), _) => origin_index.map(|i| format!("{bind}.{i}")),
                    (None, Some(group)) => {
                        let key = self
                            .nodes
                            .get(&source)
                            .and_then(|n| n.key.clone())
                            .unwrap_or_else(|| source.clone());
                        Some(format!("{}.{group}.{key}", wire::DND_STATE_KEY))
                    }
                    (None, None) => None,
                };
                if let Some(path) = path {
                    self.dispatch_reserved(
                        PIN_ACTION,
                        json!({ "path": path, "x": x, "y": y, "xKey": spec.x_key, "yKey": spec.y_key }),
                    );
                }
                let mut pin_payload = base.clone();
                pin_payload.insert("x".into(), Value::from(x));
                pin_payload.insert("y".into(), Value::from(y));
                self.dispatch_event(tree, &[Some(board.as_str())], "onPin", &pin_payload);
            }
        }
        let mut end = base;
        end.insert("dropped".into(), Value::Bool(true));
        if wrote_or_changed {
            let deadline = self.now() + self.cleanup_timeout_ms;
            if let Some(d) = self.drag.as_mut() {
                d.hold_deadline = Some(deadline);
            }
        } else {
            self.release(tree);
        }
        self.dispatch_event(
            tree,
            &[Some(source.as_str()), origin.as_deref()],
            "onDragEnd",
            &end,
        );
    }

    /// Abandon a claimed drag: restore everything. With `dispatch_end`
    /// (user cancel: Esc, focus loss, drop over nothing) only `.onDragEnd
    /// {dropped: false}` fires; without it (Remove / Detach) NOTHING does.
    fn cancel_drag(&mut self, tree: &mut Tree, dispatch_end: bool) {
        let Some(drag) = self.drag.as_ref() else {
            return;
        };
        if drag.phase == Phase::Pending {
            self.drag = None;
            return;
        }
        let end = if dispatch_end && drag.phase == Phase::Dragging {
            let to = self.target_location(drag, drag.target.as_ref());
            let mut payload = self.payload(&to);
            payload.insert("dropped".into(), Value::Bool(false));
            Some((drag.source.clone(), drag.origin.clone(), payload))
        } else {
            None
        };
        self.release(tree);
        if let Some((source, origin, payload)) = end {
            self.dispatch_event(
                tree,
                &[Some(source.as_str()), origin.as_deref()],
                "onDragEnd",
                &payload,
            );
        }
    }

    /// Hand every touched node back to the engine and forget the drag.
    fn release(&mut self, tree: &mut Tree) {
        let Some(mut drag) = self.drag.take() else {
            return;
        };
        for list in drag.lists.values_mut() {
            restore_list(tree, list);
        }
        if let Some(over) = drag.over_node.as_deref() {
            if self.nodes.get(over).and_then(|n| n.pose_label.as_deref()) == Some(LABEL_OVER) {
                self.clear_pose(tree, over);
            }
        }
        if drag.ghost_engaged {
            clear_offset(tree, &drag.item);
            self.clear_pose(tree, &drag.source);
        }
        // Deferred translate writes land on the released node now.
        for (id, bucket) in drag.deferred.drain() {
            for (name, value) in bucket {
                tree.set_prop_raw(&id, &name, value);
            }
        }
        self.dirty.props = true;
    }

    // ---------------------------------------------------------------------
    // Frame tick (press / dwell / hold deadlines)
    // ---------------------------------------------------------------------

    /// Fire elapsed deadlines: a long-press claim, an `.onDragOver` dwell
    /// dispatch, the post-drop hold release. Writes are reported through
    /// [`Self::take_dirty`], dispatches through [`Self::take_dispatches`].
    pub fn tick(&mut self, tree: &mut Tree, layout: Option<&LayoutPass>) {
        if !self.has_active() {
            return;
        }
        let now = self.now();
        // Long-press claim.
        let claim_now = {
            let Some(drag) = self.drag.as_mut() else {
                return;
            };
            let due = drag.press_deadline.is_some_and(|dl| now >= dl);
            if due {
                drag.press_deadline = None;
            }
            due && drag.phase == Phase::Pending
        };
        if claim_now {
            self.claim(tree, layout);
        }
        // A list that changed shape under the drag (an `.onDragOver`
        // handler inserting rows, say) rebuilds once the fresh layout
        // exists and re-previews at the last pointer position.
        self.refresh_stale(tree, layout);
        // `.onDragOver` dwell.
        let dwell_zone = {
            let Some(drag) = self.drag.as_mut() else {
                return;
            };
            let due = drag.dwell_deadline.is_some_and(|dl| now >= dl);
            if due {
                drag.dwell_deadline = None;
            }
            if due && drag.phase == Phase::Dragging {
                drag.over_node.clone()
            } else {
                None
            }
        };
        if let Some(zone) = dwell_zone {
            let to = {
                let drag = self.drag.as_ref().expect("checked above");
                self.target_location(drag, drag.target.as_ref())
            };
            let payload = self.payload(&to);
            self.dispatch_event(tree, &[Some(zone.as_str())], "onDragOver", &payload);
        }
        // Post-drop hold timeout.
        let release_now = {
            let Some(drag) = self.drag.as_mut() else {
                return;
            };
            let due = drag.hold_deadline.is_some_and(|dl| now >= dl);
            if due {
                drag.hold_deadline = None;
            }
            due && drag.phase == Phase::Holding
        };
        if release_now {
            self.release(tree);
        }
    }
}

/// Channel assignment (shared by Create registration and SetProp routing).
/// Malformed channels warn and degrade to "no such role" — never an error.
fn assign_channel(node: &mut DndNode, id: &str, name: &str, value: Option<&Value>) {
    match name {
        wire::DND_SOURCE_PROP => {
            node.source = value.and_then(parse_source);
            if value.is_some() && node.source.is_none() {
                log::warn!("dnd: malformed __dnd.source on node {id}; not draggable");
            }
        }
        wire::DND_SOURCE_PAYLOAD_PROP => {
            node.has_payload = value.is_some();
            node.payload = value.cloned().unwrap_or(Value::Null);
        }
        wire::DND_SOURCE_ENABLED_PROP => node.source_enabled = parse_enabled(value),
        wire::DND_KEY_PROP => node.key = value.and_then(parse_string),
        wire::DND_ZONE_PROP => {
            node.zone = value.and_then(parse_zone);
            if value.is_some() && node.zone.is_none() {
                log::warn!("dnd: malformed __dnd.zone on node {id}; not a drop zone");
            }
        }
        wire::DND_ZONE_ID_PROP => node.zone_id = value.and_then(parse_string),
        wire::DND_ZONE_ENABLED_PROP => node.zone_enabled = parse_enabled(value),
        wire::DND_SORT_PROP => {
            node.sort = value.and_then(parse_sort);
            if value.is_some() && node.sort.is_none() {
                log::warn!("dnd: malformed __dnd.sort on node {id}; not sortable");
            }
        }
        wire::DND_PIN_PROP => {
            node.pin = value.and_then(parse_pin);
            if value.is_some() && node.pin.is_none() {
                log::warn!("dnd: malformed __dnd.pin on node {id}; not a pinboard");
            }
        }
        // `__dnd.pinGroup` only feeds the engine's translate injection; the
        // runtime derives the reserved path from the board spec itself.
        // Unknown `__dnd.*` channels (version drift) are ignored: static UI.
        _ => {}
    }
}

/// Final insertion index of the dragged item for a pointer position along
/// the axis: the count of OTHER items whose midpoint lies before it.
fn insertion_index(list: &ListPreview, dragged: &str, pos: f32) -> usize {
    let mut index = 0;
    for (item, rect) in list.items.iter().zip(list.rects.iter()) {
        if item == dragged {
            continue;
        }
        let mid = axis_start(*rect, list.axis) + axis_length(*rect, list.axis) / 2.0;
        if pos >= mid {
            index += 1;
        }
    }
    index
}

/// Shift siblings to open the gap for the dragged item at `to`
/// (`usize::MAX` closes every gap). Returns `true` when any shift changed.
fn preview_list(
    tree: &mut Tree,
    list: &mut ListPreview,
    dragged: &str,
    item_rect: Rect,
    to: usize,
    scale: f32,
) -> bool {
    let size = axis_length(item_rect, list.axis) + list.gap;
    let from = list.items.iter().position(|it| it == dragged);
    let mut others = 0usize;
    let mut changed = false;
    for i in 0..list.items.len() {
        if list.items[i] == dragged {
            continue;
        }
        let shift = match from {
            None => {
                if others >= to {
                    size
                } else {
                    0.0
                }
            }
            Some(f) if f < to => {
                if i > f && others < to {
                    -size
                } else {
                    0.0
                }
            }
            Some(f) if to < f => {
                if i < f && others >= to {
                    size
                } else {
                    0.0
                }
            }
            Some(_) => 0.0,
        };
        others += 1;
        if list.shifts[i] != shift {
            list.shifts[i] = shift;
            let (dx, dy) = match list.axis {
                Axis::X => (shift, 0.0),
                Axis::Y => (0.0, shift),
            };
            write_offset(tree, &list.items[i], dx, dy, scale);
            changed = true;
        }
    }
    changed
}

fn restore_list(tree: &mut Tree, list: &mut ListPreview) {
    for (item, shift) in list.items.iter().zip(list.shifts.iter_mut()) {
        if *shift != 0.0 {
            clear_offset(tree, item);
            *shift = 0.0;
        }
    }
}

#[path = "dnd_files.rs"]
pub mod files;

#[cfg(test)]
#[path = "dnd_tests.rs"]
mod tests;
