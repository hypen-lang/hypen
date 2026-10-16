//! List virtualization — the desktop side of the `__virt.window` contract
//! (`hypen-web/docs/virtualization.md` §1–§3).
//!
//! The engine materializes only a window `[start, end)` of a long list's
//! items and sets the reserved `__virt.window` prop on the list element.
//! This module:
//!
//! - ports the shared renderer math from `@hypen-space/core`
//!   (`packages/core/src/virtualization.ts`): [`parse_virt_window`],
//!   [`children_per_item`], [`window_rows`], [`item_size`],
//!   [`window_padding`], [`visible_range`], [`wanted_range`],
//!   [`should_report`] — its tests mirror
//!   `hypen-web/tests/virtualization-math.test.ts`;
//! - keeps `__virt.window` out of the renderer tree ([`VirtLists::ingest`]):
//!   the prop is consumed from each batch and replaced, at the END of the
//!   batch (after its structural patches), by a renderer-private
//!   [`VIRT_PAD_PROP`] carrying the stand-in padding. That prop is a layout
//!   prop like any other, so the Tree, the Taffy mirror, the paint-only
//!   classifier and the layout cache all see the change through their usual
//!   paths, and `layout::apply_virt_padding` adds it to the list's padding
//!   on the scroll axis;
//! - measures the materialized rows after each layout and re-pads when the
//!   average moves ([`VirtLists::remeasure`]), keeps the first visible row
//!   in place across window / padding changes ([`VirtLists::anchor_shift`]),
//!   and decides what to report ([`VirtLists::plan_report`]);
//! - gives every materialized row its place in the whole list for
//!   assistive tech ([`VirtLists::set_positions`], §2 Accessibility).
//!
//! Culling (`layout::emit_items`) composes with this unchanged: rows
//! outside the window do not exist, the padded list element's rect spans
//! the whole virtual extent (so it is never culled while any of it is in
//! view, and the page's content size covers every row), and rows inside
//! the window but off screen are culled like any other item. Measurement
//! reads Taffy geometry, not emitted items, so culled rows still count.
//!
//! All geometry here is in physical pixels along the list's scroll axis,
//! except the [`VIRT_PAD_PROP`] value, which is logical like every other
//! style prop (`node_style_with` multiplies by the scale factor).

use hypen_engine::Patch;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// Reserved prop the engine sets on a windowed list's element.
pub const VIRT_WINDOW_PROP: &str = "__virt.window";

/// Renderer-private prop carrying the stand-in padding,
/// `{"leading": px, "trailing": px}` in logical px. Never sent anywhere.
pub const VIRT_PAD_PROP: &str = "__virt.pad";

/// Size used for unmeasured items when nothing better is known.
pub const DEFAULT_ITEM_SIZE: f32 = 48.0;

/// Minimum overscan, in items, on each side of the visible range.
pub const MIN_OVERSCAN_ITEMS: usize = 5;

/// A padding change smaller than this (logical px) is not re-applied, so
/// sub-pixel measurement noise can't relayout every frame.
const PAD_EPSILON: f32 = 0.5;

/// The decoded `__virt.window` value: children are items `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VirtWindow {
    pub total: usize,
    pub start: usize,
    pub end: usize,
    pub estimated_size: Option<f32>,
}

/// An item range `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ItemRange {
    pub start: usize,
    pub end: usize,
}

fn as_count(v: Option<&Value>) -> Option<usize> {
    let v = v?;
    if let Some(u) = v.as_u64() {
        return usize::try_from(u).ok();
    }
    // `Number.isInteger(40.0)` holds in the reference; serde_json keeps
    // `40.0` as a float.
    let f = v.as_f64()?;
    (f.is_finite() && f >= 0.0 && f.fract() == 0.0 && f <= usize::MAX as f64).then_some(f as usize)
}

/// Decode a `__virt.window` prop value; `None` for anything malformed.
pub fn parse_virt_window(value: &Value) -> Option<VirtWindow> {
    let obj = value.as_object()?;
    let total = as_count(obj.get("total"))?;
    let start = as_count(obj.get("start"))?;
    let end = as_count(obj.get("end"))?;
    if start > end || end > total {
        return None;
    }
    let estimated_size = obj
        .get("estimatedSize")
        .and_then(Value::as_f64)
        .filter(|s| *s > 0.0)
        .map(|s| s as f32);
    Some(VirtWindow {
        total,
        start,
        end,
        estimated_size,
    })
}

/// Children per item (§1): a multi-node template renders several children
/// for each item. Never less than 1, so `start + child_index / n` is always
/// the item a child belongs to.
pub fn children_per_item(window: &VirtWindow, child_count: usize) -> usize {
    let items = window.end.saturating_sub(window.start);
    if items == 0 || child_count == 0 {
        return 1;
    }
    ((child_count as f64 / items as f64).round() as usize).max(1)
}

/// Rows the materialized items occupy: `end - start` for a list; for a grid
/// with `columns > 1`, every row any of them touches. The divisor for a
/// measured average ([`item_size`]).
pub fn window_rows(window: &VirtWindow, columns: usize) -> usize {
    let cols = columns.max(1);
    window.end.div_ceil(cols) - window.start / cols
}

/// Size to assume per item: the average measured size of the materialized
/// items, else the template's estimate, else [`DEFAULT_ITEM_SIZE`].
pub fn item_size(window: &VirtWindow, measured_total: f32, measured_count: f32) -> f32 {
    if measured_count > 0.0 && measured_total > 0.0 {
        return measured_total / measured_count;
    }
    window.estimated_size.unwrap_or(DEFAULT_ITEM_SIZE)
}

/// Padding standing in for the items before and after the window, as
/// `(leading, trailing)`. For a grid with `columns > 1`, items lay out in
/// rows of `columns` and `size` is a row's extent.
pub fn window_padding(window: &VirtWindow, size: f32, columns: usize) -> (f32, f32) {
    let cols = columns.max(1);
    let rows_before = window.start.div_ceil(cols);
    let rows_total = window.total.div_ceil(cols);
    let rows_after = rows_total.saturating_sub(rows_before + window_rows(window, cols));
    (rows_before as f32 * size, rows_after as f32 * size)
}

/// Items the user can see. `scrolled_past` is how far the scroll container
/// has scrolled past the list's leading edge (0 when it hasn't reached the
/// list); `viewport_extent` is the visible extent. [`VirtLists::visible`]
/// clips the extent to the list before calling this.
pub fn visible_range(
    total: usize,
    size: f32,
    scrolled_past: f32,
    viewport_extent: f32,
    columns: usize,
) -> ItemRange {
    let cols = columns.max(1) as f64;
    let s = if size > 0.0 {
        size as f64
    } else {
        DEFAULT_ITEM_SIZE as f64
    };
    let past = (scrolled_past as f64).max(0.0);
    let first_row = (past / s).floor();
    let last_row = ((past + (viewport_extent as f64).max(0.0)) / s).ceil();
    let clamp = |n: f64| n.clamp(0.0, total as f64) as usize;
    ItemRange {
        start: clamp(first_row * cols),
        end: clamp(last_row * cols),
    }
}

/// The range to ask the engine for: the visible range widened on both sides
/// by one viewport's worth of items, at least [`MIN_OVERSCAN_ITEMS`].
pub fn wanted_range(visible: ItemRange, total: usize) -> ItemRange {
    let overscan = MIN_OVERSCAN_ITEMS.max(visible.end.saturating_sub(visible.start));
    ItemRange {
        start: visible.start.saturating_sub(overscan).min(total),
        end: visible.end.saturating_add(overscan).min(total),
    }
}

/// Whether to report `wanted` given the current window and the last report:
/// when the visible range is not covered by the window, or the window is
/// more than three times what is wanted (shrink after a fling) — never the
/// same range twice in a row.
pub fn should_report(
    window: &VirtWindow,
    visible: ItemRange,
    wanted: ItemRange,
    last_reported: Option<ItemRange>,
) -> bool {
    if last_reported == Some(wanted) {
        return false;
    }
    let covered = visible.start >= window.start && visible.end <= window.end;
    let wanted_size = wanted.end.saturating_sub(wanted.start).max(1);
    let oversized = window.end - window.start > 3 * wanted_size;
    !covered || oversized
}

/// Grid column count of a list element (`Grid(columns: n)` reaches the
/// desktop as `gridColumns`; `columns` is accepted too). 1 for anything
/// that isn't a multi-column grid.
pub fn columns_of(node: &crate::tree::Node) -> usize {
    if !node.element_type.eq_ignore_ascii_case("Grid") {
        return 1;
    }
    ["gridColumns", "gridColumns.0", "columns", "columns.0"]
        .iter()
        .find_map(|k| node.props.get(*k).and_then(Value::as_f64))
        .map(|c| c.max(1.0) as usize)
        .unwrap_or(1)
}

/// Taffy geometry of a windowed list, along its scroll axis, in physical px
/// relative to the list's border box (scroll-independent).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ListGeometry {
    /// The list lays out (and scrolls) horizontally.
    pub horizontal: bool,
    /// Offset of the content edge — border + padding, the virtual leading
    /// padding included — from the border box's near edge.
    pub content_start: f32,
    /// Each child's `(id, near, extent)`, in child order.
    pub children: Vec<(String, f32, f32)>,
}

/// Average pitch of the materialized items, as `(measured_total,
/// measured_count)` for [`item_size`] — counted in rows for a grid. The
/// pitch includes the gap between items, so `start × size` matches the
/// extent the missing rows would have had. `None` when nothing is
/// materialized.
pub fn measure(window: &VirtWindow, geom: &ListGeometry, columns: usize) -> Option<(f32, f32)> {
    let items = window.end - window.start;
    if items == 0 || geom.children.is_empty() {
        return None;
    }
    let per_item = children_per_item(window, geom.children.len());
    let rows = window_rows(window, columns);
    let first_near = geom.children[0].1;
    let total = if rows > 1 {
        let last_first_child = ((items - 1) * per_item).min(geom.children.len() - 1);
        let last_near = geom.children[last_first_child].1;
        (last_near - first_near) / (rows - 1) as f32 * rows as f32
    } else {
        geom.children
            .iter()
            .map(|(_, near, extent)| near + extent)
            .fold(f32::MIN, f32::max)
            - first_near
    };
    (total > 0.0).then_some((total, rows as f32))
}

/// Where a list sits on screen along its axis (physical px).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ListViewport {
    /// Screen position of the list's border-box near edge.
    pub list_near: f32,
    /// The list's own scroll offset when it scrolls itself, else 0.
    pub own_scroll: f32,
    /// The visible band of its scroll container: the window clipped by
    /// every clipping ancestor (and by the list itself when it scrolls).
    pub vis_lo: f32,
    pub vis_hi: f32,
}

/// Renderer-side state of one windowed list.
#[derive(Debug, Clone)]
struct VirtList {
    window: VirtWindow,
    /// Grid columns (1 for a plain list), from the last measurement.
    columns: usize,
    /// Last measurement, `(total, count)` in physical px / rows.
    measured: Option<(f32, f32)>,
    /// Padding last requested, `(leading, trailing)` logical px.
    requested: Option<(f32, f32)>,
    /// Padding the tree holds (the last `__virt.pad` that left `ingest`),
    /// logical px.
    in_tree: Option<(f32, f32)>,
    last_reported: Option<ItemRange>,
    /// First visible materialized row and its content position in its scroll
    /// container, from the last sync.
    anchor: Option<(String, f32)>,
    /// A padding change reached the tree since the last sync: keep the
    /// anchor row where it was.
    anchor_pending: bool,
}

/// Every windowed list the renderer currently shows, by element id.
#[derive(Debug, Default)]
pub struct VirtLists {
    lists: HashMap<String, VirtList>,
}

impl VirtLists {
    pub fn is_empty(&self) -> bool {
        self.lists.is_empty()
    }

    /// Ids of the windowed lists.
    pub fn ids(&self) -> Vec<String> {
        self.lists.keys().cloned().collect()
    }

    /// The current window of `id`.
    pub fn window(&self, id: &str) -> Option<VirtWindow> {
        self.lists.get(id).map(|l| l.window)
    }

    /// Forget a list (its element left the tree).
    pub fn forget(&mut self, id: &str) {
        self.lists.remove(id);
    }

    /// Consume `__virt.window` from a batch before it reaches the tree:
    /// every `SetProp` / `RemoveProp` of it is dropped (and stripped from
    /// `Create` props), and a [`VIRT_PAD_PROP`] write for each list it
    /// touched is appended at the END of the batch, after the structural
    /// patches the window describes. `scale` converts measured (physical)
    /// sizes into the logical padding value.
    ///
    /// Every [`VIRT_PAD_PROP`] write that leaves here — one already in the
    /// batch (a re-pad queued by [`remeasure`](Self::remeasure)) or one
    /// appended for a new window — reaches the tree in this flush, so it is
    /// recorded as the list's current padding and arms scroll anchoring.
    pub fn ingest(&mut self, patches: &mut Vec<Patch>, scale: f32) {
        let mut touched: Vec<(String, Option<VirtWindow>)> = Vec::new();
        patches.retain_mut(|patch| match patch {
            Patch::SetProp { id, name, value } if name == VIRT_WINDOW_PROP => {
                // Malformed: keep the previous window.
                if let Some(w) = parse_virt_window(value) {
                    touched.push((id.to_string(), Some(w)));
                }
                false
            }
            Patch::RemoveProp { id, name } if name == VIRT_WINDOW_PROP => {
                touched.push((id.to_string(), None));
                false
            }
            Patch::SetProp { id, name, value } if name == VIRT_PAD_PROP => {
                if let Some(list) = self.lists.get_mut(id.as_ref()) {
                    list.landed(pad_of(value));
                }
                true
            }
            Patch::Create { id, props, .. } => {
                // A (re-)created element starts with no padding.
                if let Some(list) = self.lists.get_mut(id.as_ref()) {
                    list.in_tree = None;
                    list.requested = None;
                }
                if props.contains_key(VIRT_WINDOW_PROP) {
                    let value = Arc::make_mut(props).shift_remove(VIRT_WINDOW_PROP);
                    if let Some(w) = value.as_ref().and_then(parse_virt_window) {
                        touched.push((id.to_string(), Some(w)));
                    }
                }
                true
            }
            Patch::Remove { id, .. } => {
                self.lists.remove(id.as_ref());
                true
            }
            _ => true,
        });
        for (id, window) in touched {
            match window {
                Some(window) => {
                    let list = self
                        .lists
                        .entry(id.clone())
                        .or_insert_with(|| VirtList::new(window));
                    list.window = window;
                    // A new window answers (or supersedes) the last report:
                    // the next one may legitimately ask for the same range
                    // again (e.g. after a reconnect re-rendered the list).
                    list.last_reported = None;
                    if let Some(p) = list.pad_patch(&id, scale, true) {
                        list.landed(list.requested);
                        patches.push(p);
                    }
                }
                None => {
                    if self
                        .lists
                        .remove(&id)
                        .is_some_and(|l| l.requested.is_some())
                    {
                        patches.push(Patch::RemoveProp {
                            id: id.as_str().into(),
                            name: VIRT_PAD_PROP.into(),
                        });
                    }
                }
            }
        }
    }

    /// Record a fresh measurement of `id`'s materialized rows. Returns the
    /// [`VIRT_PAD_PROP`] write to queue when the padding moved by more than
    /// half a logical pixel.
    pub fn remeasure(
        &mut self,
        id: &str,
        geom: &ListGeometry,
        columns: usize,
        scale: f32,
    ) -> Option<Patch> {
        let list = self.lists.get_mut(id)?;
        list.columns = columns.max(1);
        if let Some(m) = measure(&list.window, geom, columns) {
            list.measured = Some(m);
        }
        list.pad_patch(id, scale, false)
    }

    /// Item size of `id` in physical px.
    pub fn item_size_px(&self, id: &str, scale: f32) -> Option<f32> {
        let list = self.lists.get(id)?;
        Some(list.size_px(scale))
    }

    /// Scroll correction keeping the first visible row in place after a
    /// padding change: `Some(delta)` (physical px, add it to the scroll
    /// container's offset) when a change reached the tree since the last
    /// sync and the anchor row is still materialized. `content_pos` maps a
    /// row id to its current content position in the scroll container.
    pub fn anchor_shift(&mut self, id: &str, content_pos: impl Fn(&str) -> Option<f32>) -> f32 {
        let Some(list) = self.lists.get_mut(id) else {
            return 0.0;
        };
        if !std::mem::take(&mut list.anchor_pending) {
            return 0.0;
        }
        match &list.anchor {
            Some((row, before)) => match content_pos(row) {
                Some(now) if (now - before).abs() > 0.5 => now - before,
                _ => 0.0,
            },
            None => 0.0,
        }
    }

    /// Remember the first visible row of `id` and its content position.
    pub fn set_anchor(&mut self, id: &str, anchor: Option<(String, f32)>) {
        if let Some(list) = self.lists.get_mut(id) {
            list.anchor = anchor;
        }
    }

    /// The visible range of `id` given where it sits on screen, or `None`
    /// when none of it is visible.
    pub fn visible(
        &self,
        id: &str,
        geom: &ListGeometry,
        columns: usize,
        vp: ListViewport,
        scale: f32,
    ) -> Option<ItemRange> {
        let list = self.lists.get(id)?;
        let size = list.size_px(scale);
        let leading = list.in_tree.map(|p| p.0 * scale).unwrap_or(0.0);
        let item0 = vp.list_near + geom.content_start - leading - vp.own_scroll;
        let rows_total = list.window.total.div_ceil(columns.max(1)) as f32;
        let lo = vp.vis_lo.max(item0);
        let hi = vp.vis_hi.min(item0 + rows_total * size);
        if hi <= lo {
            return None;
        }
        Some(visible_range(
            list.window.total,
            size,
            lo - item0,
            hi - lo,
            columns,
        ))
    }

    /// Every materialized row's place in its whole list, for assistive tech
    /// (§2 Accessibility): `(row id, position in set (1-based), set size)`.
    /// Rows are the list's children, grouped into items
    /// ([`children_per_item`]); every child of an item shares its position.
    /// Sorted by row id.
    pub fn set_positions(&self, tree: &crate::tree::Tree) -> Vec<(String, usize, usize)> {
        let mut out = Vec::new();
        for (id, list) in &self.lists {
            let w = list.window;
            let children = tree.children_of(id);
            let per = children_per_item(&w, children.len());
            for (i, child) in children.iter().enumerate() {
                let pos = (w.start + i / per + 1).min(w.total.max(1));
                out.push((child.clone(), pos, w.total));
            }
        }
        // Stable order (the lists are a HashMap): callers fingerprint it.
        out.sort_unstable();
        out
    }

    /// What to report for `id` given its visible range: the overscanned
    /// range, when [`should_report`] says so. Records it as reported.
    pub fn plan_report(&mut self, id: &str, visible: ItemRange) -> Option<ItemRange> {
        let list = self.lists.get_mut(id)?;
        let wanted = wanted_range(visible, list.window.total);
        if !should_report(&list.window, visible, wanted, list.last_reported) {
            return None;
        }
        list.last_reported = Some(wanted);
        Some(wanted)
    }
}

impl VirtList {
    fn new(window: VirtWindow) -> Self {
        Self {
            window,
            columns: 1,
            measured: None,
            requested: None,
            in_tree: None,
            last_reported: None,
            anchor: None,
            anchor_pending: false,
        }
    }

    /// A padding write reached the tree: remember it, and keep the anchor
    /// row in place on the next sync.
    fn landed(&mut self, pad: Option<(f32, f32)>) {
        self.in_tree = pad;
        self.anchor_pending = true;
    }

    fn size_px(&self, scale: f32) -> f32 {
        let (total, count) = self.measured.unwrap_or((0.0, 0.0));
        if count > 0.0 && total > 0.0 {
            return item_size(&self.window, total, count);
        }
        // The estimate and the default are logical px.
        item_size(&self.window, 0.0, 0.0) * scale.max(f32::EPSILON)
    }

    /// The padding write for the current window and size, if it differs
    /// from the last request (`force`: whenever it differs at all).
    fn pad_patch(&mut self, id: &str, scale: f32, force: bool) -> Option<Patch> {
        let scale = scale.max(f32::EPSILON);
        let size = self.size_px(scale) / scale;
        let pad = window_padding(&self.window, size, self.columns);
        let same = self.requested.is_some_and(|(l, t)| {
            let eps = if force { 0.0 } else { PAD_EPSILON };
            (l - pad.0).abs() <= eps && (t - pad.1).abs() <= eps
        });
        if same {
            return None;
        }
        self.requested = Some(pad);
        Some(Patch::SetProp {
            id: id.into(),
            name: VIRT_PAD_PROP.into(),
            value: json!({ "leading": pad.0, "trailing": pad.1 }),
        })
    }
}

/// Decode a [`VIRT_PAD_PROP`] value as `(leading, trailing)` logical px.
pub fn pad_of(value: &Value) -> Option<(f32, f32)> {
    let l = value.get("leading")?.as_f64()? as f32;
    let t = value.get("trailing")?.as_f64()? as f32;
    Some((l.max(0.0), t.max(0.0)))
}

#[cfg(test)]
#[path = "virt_tests.rs"]
mod tests;
