//! Headless tests for [`DesktopDnd`] (DnD plan §6).
//!
//! Same idiom as `scrub_tests.rs`: `Create` / `Insert` patches carrying the
//! byte-exact `__dnd.*` wire (see `engine-compatibility-tests/fixtures/dnd/`)
//! build a real [`Tree`], a real [`LayoutPass`] provides the rects the
//! runtime hit-tests against, synthetic pointer calls drive the gesture,
//! the clock is injected, and every outcome is read off the tree props the
//! window paints from plus the drained dispatch queue (the seam the window
//! forwards to `module.dispatch_action`).

use super::*;
use crate::layout::{logical_viewport, LayoutPass};
use crate::text::TextEngine;
use crate::tree::{Tree, ROOT_ID};
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

fn create(id: &str, element_type: &str, entries: Vec<(&str, Value)>) -> Patch {
    let mut map = IndexMap::new();
    for (k, v) in entries {
        map.insert(k.to_string(), v);
    }
    Patch::Create {
        id: id.into(),
        element_type: element_type.to_string(),
        props: Arc::new(map),
        semantics: None,
    }
}

fn insert(parent: &str, id: &str) -> Patch {
    Patch::Insert {
        parent_id: parent.into(),
        id: id.into(),
        before_id: None,
    }
}

fn set_prop(id: &str, name: &str, value: Value) -> Patch {
    Patch::SetProp {
        id: id.into(),
        name: name.to_string(),
        value,
    }
}

/// Route a batch through `pre_ingest` then apply the survivors — the
/// window's flush order, minus the scrubber and the animator.
fn feed(dnd: &mut DesktopDnd, tree: &mut Tree, patches: &[Patch]) {
    let mut v = patches.to_vec();
    dnd.pre_ingest(&mut v, tree);
    for p in &v {
        tree.apply(p);
    }
}

fn layout(tree: &Tree) -> LayoutPass {
    let mut text = TextEngine::new();
    LayoutPass::compute(tree, &mut text, (800, 600), 1.0)
}

fn vp() -> Viewport {
    logical_viewport((800, 600), 1.0)
}

fn center(pass: &LayoutPass, id: &str) -> (f64, f64) {
    let r = pass
        .item_by_id(id)
        .unwrap_or_else(|| panic!("{id} laid out"))
        .rect;
    ((r.x + r.w / 2.0) as f64, (r.y + r.h / 2.0) as f64)
}

/// Centre of the item's RENDERED rect (its layout rect under its own
/// translate) — where the user actually sees, and presses, a pinned note.
fn visual_center(pass: &LayoutPass, id: &str) -> (f64, f64) {
    let r = pass
        .item_by_id(id)
        .unwrap_or_else(|| panic!("{id} laid out"))
        .visual_rect();
    ((r.x + r.w / 2.0) as f64, (r.y + r.h / 2.0) as f64)
}

fn prop(tree: &Tree, id: &str, name: &str) -> Option<Value> {
    tree.get(id)?.props.get(name).cloned()
}

fn new_dnd() -> DesktopDnd {
    let mut d = DesktopDnd::new();
    d.set_manual_time_ms(0.0);
    d
}

fn source_spec() -> Value {
    json!({ "group": null, "handle": false, "activation": "auto" })
}

/// The `sortable-lowering` fixture shape: `Column.sortable(axis: y)
/// .bind(@state.tasks)` over `ForEach { Row { Text().draggable(payload:
/// @item) } }` — the draggable sits BELOW the row root, the Row wrapper is
/// the ghost item.
fn sortable_patches(list: &str, bind: &str, group: Value, keys: &[&str]) -> Vec<Patch> {
    let mut p = vec![
        create(
            list,
            "Column",
            vec![
                ("__dnd.sort", json!({ "group": group, "axis": "y" })),
                ("bind", json!(bind)),
                ("onSort.0", json!("@reorder")),
                ("width.0", json!(200)),
            ],
        ),
        insert(ROOT_ID, list),
    ];
    for k in keys {
        let row = format!("{list}-row-{k}");
        let txt = format!("{list}-txt-{k}");
        p.push(create(
            &row,
            "Row",
            vec![("height.0", json!(40)), ("width.0", json!(200))],
        ));
        p.push(insert(list, &row));
        p.push(create(
            &txt,
            "Text",
            vec![
                ("0", json!(k)),
                ("__dnd.key", json!(k)),
                ("__dnd.source", source_spec()),
                ("__dnd.sourcePayload", json!({ "id": k })),
                ("onDragStart.0", json!("@started")),
                ("onDragEnd.0", json!("@ended")),
            ],
        ));
        p.push(insert(&row, &txt));
    }
    p
}

fn mount_sortable() -> (DesktopDnd, Tree, LayoutPass) {
    let mut dnd = new_dnd();
    let mut tree = Tree::new();
    feed(
        &mut dnd,
        &mut tree,
        &sortable_patches("list", "tasks", Value::Null, &["t1", "t2", "t3"]),
    );
    let pass = layout(&tree);
    (dnd, tree, pass)
}

/// Press on `id`, travel past slop, then move to `to`.
fn drag_to(dnd: &mut DesktopDnd, tree: &mut Tree, pass: &LayoutPass, id: &str, to: (f64, f64)) {
    let from = center(pass, id);
    assert!(
        dnd.pointer_down(tree, pass, from.0, from.1, 1.0),
        "press opens a drag"
    );
    dnd.pointer_move(tree, Some(pass), vp(), from.0 + 10.0, from.1); // claim (slop)
    dnd.pointer_move(tree, Some(pass), vp(), to.0, to.1);
}

fn actions(dispatches: &[DndDispatch]) -> Vec<&str> {
    dispatches.iter().map(|d| d.action.as_str()).collect()
}

// ---------------------------------------------------------------------------
// Sortable
// ---------------------------------------------------------------------------

#[test]
fn sortable_reorder_dispatches_reserved_write_then_events_in_order() {
    let (mut dnd, mut tree, pass) = mount_sortable();
    let rows: Vec<crate::layout::Rect> = ["list-row-t1", "list-row-t2", "list-row-t3"]
        .iter()
        .map(|id| pass.item_by_id(id).expect("row").rect)
        .collect();
    assert!(
        rows[1].y > rows[0].y && rows[2].y > rows[1].y,
        "rows stack top-down"
    );

    let from = center(&pass, "list-txt-t1");
    assert!(dnd.pointer_down(&mut tree, &pass, from.0, from.1, 1.0));
    // Below slop: still pending, nothing written, nothing dispatched.
    dnd.pointer_move(&mut tree, Some(&pass), vp(), from.0 + 3.0, from.1);
    assert!(!dnd.is_active());
    assert!(dnd.take_outcomes().is_empty());
    assert!(prop(&tree, "list-row-t1", LOCAL_DY_PROP).is_none());

    // Past slop: the row (the sortable's direct child) lifts and the
    // opted-in `.onDragStart` fires on the source with the §4.2 payload.
    dnd.pointer_move(&mut tree, Some(&pass), vp(), from.0 + 10.0, from.1);
    assert!(dnd.is_dragging());
    assert!(dnd.owns_node("list-row-t1") && dnd.owns_node("list-txt-t1"));
    let started = dnd.take_outcomes();
    assert_eq!(actions(&started), vec!["started"]);
    assert_eq!(
        started[0].payload,
        json!({
            "item": "t1",
            "payload": { "id": "t1" },
            "from": { "zone": "list", "index": 0 },
            "to": { "zone": "list", "index": 0 },
        })
    );

    // Drag down to the third row's centre: the ghost follows the pointer,
    // the two rows it passes shift UP by one slot to open the gap, and
    // NOTHING reaches the engine.
    let to = (from.0, center(&pass, "list-row-t3").1);
    dnd.pointer_move(&mut tree, Some(&pass), vp(), to.0, to.1);
    let ghost_dy = prop(&tree, "list-row-t1", LOCAL_DY_PROP)
        .and_then(|v| v.as_f64())
        .expect("ghost offset");
    assert!(
        (ghost_dy - (to.1 - from.1)).abs() < 1e-3,
        "ghost dy {ghost_dy}"
    );
    let slot = (rows[1].y - rows[0].y) as f64;
    for id in ["list-row-t2", "list-row-t3"] {
        let dy = prop(&tree, id, LOCAL_DY_PROP)
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        assert!(
            (dy + slot).abs() < 1e-3,
            "{id} shifts up one slot, got {dy}"
        );
    }
    assert!(
        prop(&tree, "list-txt-t1", LOCAL_DY_PROP).is_none(),
        "the source itself is not offset"
    );
    assert!(
        dnd.take_outcomes().is_empty(),
        "zero engine traffic during the drag"
    );

    // Release: reserved write, then `.onSort` on the destination, then
    // `.onDragEnd {dropped: true}` — in that order.
    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);
    let drop = dnd.take_outcomes();
    assert_eq!(actions(&drop), vec![REORDER_ACTION, "reorder", "ended"]);
    assert_eq!(
        drop[0].payload,
        json!({ "path": "tasks", "from": 0, "to": 2 })
    );
    let expected = json!({
        "item": "t1",
        "payload": { "id": "t1" },
        "from": { "zone": "list", "index": 0 },
        "to": { "zone": "list", "index": 2 },
    });
    assert_eq!(drop[1].payload, expected);
    let mut end = expected.clone();
    end["dropped"] = json!(true);
    assert_eq!(drop[2].payload, end);

    // Hold: the local transforms survive the release until the engine's
    // `Move` for the dragged row lands — then everything clears at once.
    assert!(prop(&tree, "list-row-t1", LOCAL_DY_PROP).is_some(), "held");
    assert!(prop(&tree, "list-row-t3", LOCAL_DY_PROP).is_some(), "held");
    assert!(dnd.owns_node("list-row-t1"));
    feed(
        &mut dnd,
        &mut tree,
        &[Patch::Move {
            parent_id: "list".into(),
            id: "list-row-t1".into(),
            before_id: None,
        }],
    );
    for id in ["list-row-t1", "list-row-t2", "list-row-t3"] {
        assert!(prop(&tree, id, LOCAL_DX_PROP).is_none(), "{id} released");
        assert!(prop(&tree, id, LOCAL_DY_PROP).is_none(), "{id} released");
    }
    assert!(!dnd.is_active());
    assert!(dnd.take_outcomes().is_empty());
    assert_eq!(
        tree.children_of("list").last().map(String::as_str),
        Some("list-row-t1")
    );
}

#[test]
fn hold_falls_back_to_the_timeout_when_no_move_arrives() {
    let (mut dnd, mut tree, pass) = mount_sortable();
    let to = (
        center(&pass, "list-txt-t1").0,
        center(&pass, "list-row-t3").1,
    );
    drag_to(&mut dnd, &mut tree, &pass, "list-txt-t1", to);
    dnd.set_manual_time_ms(1000.0);
    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);
    let _ = dnd.take_outcomes();
    assert!(dnd.has_active(), "the hold deadline arms the ticker");

    dnd.set_manual_time_ms(1400.0);
    dnd.tick(&mut tree, Some(&pass));
    assert!(
        prop(&tree, "list-row-t1", LOCAL_DY_PROP).is_some(),
        "still held before the deadline"
    );

    dnd.set_manual_time_ms(1500.0);
    dnd.tick(&mut tree, Some(&pass));
    assert!(
        prop(&tree, "list-row-t1", LOCAL_DY_PROP).is_none(),
        "released at the deadline"
    );
    assert!(prop(&tree, "list-row-t2", LOCAL_DY_PROP).is_none());
    assert!(!dnd.is_active() && !dnd.has_active());
}

#[test]
fn a_drop_back_on_the_origin_slot_writes_nothing_and_only_ends() {
    let (mut dnd, mut tree, pass) = mount_sortable();
    let from = center(&pass, "list-txt-t1");
    drag_to(
        &mut dnd,
        &mut tree,
        &pass,
        "list-txt-t1",
        (from.0 + 20.0, from.1 + 4.0),
    );
    let _ = dnd.take_outcomes();
    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);
    let drop = dnd.take_outcomes();
    assert_eq!(actions(&drop), vec!["ended"]);
    assert_eq!(drop[0].payload["dropped"], json!(true));
    assert_eq!(drop[0].payload["to"], json!({ "zone": "list", "index": 0 }));
    // Nothing changed: no hold, released immediately.
    assert!(!dnd.is_active());
    assert!(prop(&tree, "list-row-t1", LOCAL_DY_PROP).is_none());
}

#[test]
fn cross_list_drop_dispatches_from_and_to_paths_and_sorts_on_the_destination() {
    let mut dnd = new_dnd();
    let mut tree = Tree::new();
    let mut patches = sortable_patches("a", "todo", json!("g"), &["a1", "a2"]);
    patches.extend(sortable_patches("b", "done", json!("g"), &["b1", "b2"]));
    feed(&mut dnd, &mut tree, &patches);
    let pass = layout(&tree);

    // Drop a1 onto b's second row (below its midpoint → index 2 = the end).
    let b2 = pass.item_by_id("b-row-b2").expect("b2").rect;
    let to = (center(&pass, "b-txt-b2").0, (b2.y + b2.h - 2.0) as f64);
    drag_to(&mut dnd, &mut tree, &pass, "a-txt-a1", to);
    let _ = dnd.take_outcomes();
    // Foreign list preview: rows at/after the insertion point shift down
    // (none here — we insert at the end), the origin closes its gap.
    assert!(prop(&tree, "b-row-b1", LOCAL_DY_PROP).is_none());
    assert!(
        prop(&tree, "a-row-a2", LOCAL_DY_PROP).is_none(),
        "origin gap closed on a foreign target"
    );

    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);
    let drop = dnd.take_outcomes();
    assert_eq!(actions(&drop), vec![REORDER_ACTION, "reorder", "ended"]);
    assert_eq!(
        drop[0].payload,
        json!({ "fromPath": "todo", "from": 0, "toPath": "done", "to": 2 })
    );
    assert_eq!(drop[1].payload["from"], json!({ "zone": "g", "index": 0 }));
    assert_eq!(drop[1].payload["to"], json!({ "zone": "g", "index": 2 }));
}

// ---------------------------------------------------------------------------
// Tap / cancel paths
// ---------------------------------------------------------------------------

#[test]
fn a_tap_is_a_total_no_op() {
    let (mut dnd, mut tree, pass) = mount_sortable();
    let from = center(&pass, "list-txt-t1");
    assert!(dnd.pointer_down(&mut tree, &pass, from.0, from.1, 1.0));
    assert!(!dnd.is_active());
    assert_eq!(
        dnd.pointer_up(&mut tree, None),
        DndPointerUp::NoOp,
        "the click passes through"
    );
    assert!(dnd.take_outcomes().is_empty());
    assert!(!dnd.take_dirty().any());
    for id in ["list-row-t1", "list-txt-t1"] {
        assert!(prop(&tree, id, LOCAL_DX_PROP).is_none());
        assert!(prop(&tree, id, LOCAL_DY_PROP).is_none());
    }
    // A press outside every source opens nothing.
    assert!(!dnd.pointer_down(&mut tree, &pass, 700.0, 590.0, 1.0));
    // A below-slop wiggle is still a tap.
    assert!(dnd.pointer_down(&mut tree, &pass, from.0, from.1, 1.0));
    dnd.pointer_move(&mut tree, Some(&pass), vp(), from.0 + 4.0, from.1 + 4.0);
    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::NoOp);
    assert!(dnd.take_outcomes().is_empty());
}

#[test]
fn a_remove_of_the_dragged_row_mid_drag_cancels_with_no_dispatch() {
    let (mut dnd, mut tree, pass) = mount_sortable();
    let to = (
        center(&pass, "list-txt-t1").0,
        center(&pass, "list-row-t3").1,
    );
    drag_to(&mut dnd, &mut tree, &pass, "list-txt-t1", to);
    assert_eq!(actions(&dnd.take_outcomes()), vec!["started"]);
    assert!(prop(&tree, "list-row-t2", LOCAL_DY_PROP).is_some());

    feed(
        &mut dnd,
        &mut tree,
        &[Patch::Remove {
            id: "list-row-t1".into(),
            transition: false,
        }],
    );
    assert!(!dnd.is_active());
    assert!(
        dnd.take_outcomes().is_empty(),
        "Remove mid-drag dispatches nothing — not even onDragEnd"
    );
    assert!(tree.get("list-row-t1").is_none());
    for id in ["list-row-t2", "list-row-t3"] {
        assert!(
            prop(&tree, id, LOCAL_DY_PROP).is_none(),
            "{id} sibling shift restored"
        );
    }
    // Stray follow-up events are inert.
    dnd.pointer_move(&mut tree, Some(&pass), vp(), to.0, to.1 + 30.0);
    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::NoOp);
    assert!(dnd.take_outcomes().is_empty());
}

#[test]
fn a_detach_of_an_ancestor_mid_drag_cancels_with_no_dispatch() {
    let (mut dnd, mut tree, pass) = mount_sortable();
    let to = (
        center(&pass, "list-txt-t1").0,
        center(&pass, "list-row-t3").1,
    );
    drag_to(&mut dnd, &mut tree, &pass, "list-txt-t1", to);
    let _ = dnd.take_outcomes();
    feed(&mut dnd, &mut tree, &[Patch::Detach { id: "list".into() }]);
    assert!(!dnd.is_active());
    assert!(dnd.take_outcomes().is_empty());
    assert!(prop(&tree, "list-row-t1", LOCAL_DY_PROP).is_none());
}

#[test]
fn rows_inserted_under_the_origin_mid_drag_retarget_the_slots_and_the_from() {
    // A dwell handler inserting rows into the origin list mid-drag (the
    // "open folder" case): the cached slots and the reserved write's
    // `from` must follow the engine's re-render, not the lift-time list.
    let mut dnd = new_dnd();
    let mut tree = Tree::new();
    feed(
        &mut dnd,
        &mut tree,
        &sortable_patches("list", "entries", Value::Null, &["folder", "a", "b", "f"]),
    );
    let pass = layout(&tree);
    let row_h = pass.item_by_id("list-row-a").expect("row").rect.h as f64;
    assert!((row_h - 40.0).abs() < 1e-3, "40px rows, got {row_h}");

    // Lift `f` (origin_index 3) and hover y=70: with the lift-time rects
    // (folder 0-40, a 40-80, b 80-120) that is slot 2.
    let x = center(&pass, "list-txt-f").0;
    drag_to(&mut dnd, &mut tree, &pass, "list-txt-f", (x, 70.0));
    assert_eq!(actions(&dnd.take_outcomes()), vec!["started"]);
    assert_eq!(dnd.drag.as_ref().and_then(|d| d.origin_index), Some(3));
    assert!(matches!(
        dnd.drag.as_ref().and_then(|d| d.target.clone()),
        Some(DropTarget::Sort { index: 2, .. })
    ));
    assert!(!dnd.has_active(), "nothing pending before the insert");

    // The engine inserts two 20px rows before `a`: [folder, n1, n2, a, b, f].
    let mut batch = Vec::new();
    for k in ["n1", "n2"] {
        let row = format!("list-row-{k}");
        let txt = format!("list-txt-{k}");
        batch.push(create(
            &row,
            "Row",
            vec![("height.0", json!(20)), ("width.0", json!(200))],
        ));
        batch.push(Patch::Insert {
            parent_id: "list".into(),
            id: row.as_str().into(),
            before_id: Some("list-row-a".into()),
        });
        batch.push(create(
            &txt,
            "Text",
            vec![
                ("0", json!(k)),
                ("__dnd.key", json!(k)),
                ("__dnd.source", source_spec()),
            ],
        ));
        batch.push(insert(&row, &txt));
    }
    feed(&mut dnd, &mut tree, &batch);
    assert_eq!(
        tree.children_of("list"),
        &[
            "list-row-folder",
            "list-row-n1",
            "list-row-n2",
            "list-row-a",
            "list-row-b",
            "list-row-f"
        ]
        .map(String::from)
    );
    assert!(dnd.is_dragging(), "an origin-list insert is not a cancel");
    assert!(
        dnd.has_active(),
        "a stale list keeps the ticker armed for the post-layout rebuild"
    );

    // The window's move before the relayout (no layout yet): the rebuild
    // waits, but `from` already tracks the live tree.
    dnd.pointer_move(&mut tree, None, vp(), x, 70.0);
    assert_eq!(dnd.drag.as_ref().and_then(|d| d.origin_index), Some(5));
    assert!(dnd.has_active(), "rects still wait for a layout");

    // The frame after the fresh layout: the slots rebuild (folder 0-40,
    // n1 40-60, n2 60-80, a 80-120, b 120-160) and the target re-resolves
    // at the last pointer position WITHOUT a new move — y=70 is now slot 3.
    let pass2 = layout(&tree);
    assert!((pass2.item_by_id("list-row-n2").expect("n2").rect.y - 60.0).abs() < 1e-3);
    dnd.tick(&mut tree, Some(&pass2));
    assert!(!dnd.has_active(), "stale mark consumed");
    assert!(matches!(
        dnd.drag.as_ref().and_then(|d| d.target.clone()),
        Some(DropTarget::Sort { index: 3, .. })
    ));
    // The gap preview follows the rebuilt slots: the rows at-or-after the
    // new slot (a, b) shift down; the rows before it (folder, n1, n2) stay.
    for id in ["list-row-a", "list-row-b"] {
        let dy = prop(&tree, id, LOCAL_DY_PROP).and_then(|v| v.as_f64());
        assert!(
            dy.is_some_and(|dy| dy > 0.0),
            "{id} shifts down, got {dy:?}"
        );
    }
    for id in ["list-row-folder", "list-row-n1", "list-row-n2"] {
        assert!(prop(&tree, id, LOCAL_DY_PROP).is_none(), "{id} stays");
    }
    assert!(dnd.take_outcomes().is_empty(), "no engine traffic");

    // Drop: the reserved write names the dragged item's LIVE slot as
    // `from` and the fresh-rect slot as `to`; the event `from` stays the
    // lift location (§4.2).
    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);
    let drop = dnd.take_outcomes();
    assert_eq!(actions(&drop), vec![REORDER_ACTION, "reorder", "ended"]);
    assert_eq!(
        drop[0].payload,
        json!({ "path": "entries", "from": 5, "to": 3 })
    );
    assert_eq!(
        drop[1].payload["from"],
        json!({ "zone": "list", "index": 3 })
    );
    assert_eq!(drop[1].payload["to"], json!({ "zone": "list", "index": 3 }));
}

#[test]
fn a_row_removed_from_the_origin_mid_drag_shifts_the_from_down() {
    let (mut dnd, mut tree, pass) = mount_sortable();
    let x = center(&pass, "list-txt-t3").0;
    // Hover above the first row's midpoint (y=10 of a 40px row): slot 0.
    drag_to(&mut dnd, &mut tree, &pass, "list-txt-t3", (x, 10.0));
    assert_eq!(actions(&dnd.take_outcomes()), vec!["started"]);
    assert_eq!(dnd.drag.as_ref().and_then(|d| d.origin_index), Some(2));
    assert!(matches!(
        dnd.drag.as_ref().and_then(|d| d.target.clone()),
        Some(DropTarget::Sort { index: 0, .. })
    ));
    // t1 and t2 shifted down to open the gap at slot 0.
    assert!(prop(&tree, "list-row-t1", LOCAL_DY_PROP).is_some());
    assert!(prop(&tree, "list-row-t2", LOCAL_DY_PROP).is_some());

    feed(
        &mut dnd,
        &mut tree,
        &[Patch::Remove {
            id: "list-row-t2".into(),
            transition: false,
        }],
    );
    assert!(dnd.is_dragging(), "a sibling remove is not a cancel");
    let pass2 = layout(&tree);
    dnd.tick(&mut tree, Some(&pass2));
    assert_eq!(dnd.drag.as_ref().and_then(|d| d.origin_index), Some(1));
    assert!(matches!(
        dnd.drag.as_ref().and_then(|d| d.target.clone()),
        Some(DropTarget::Sort { index: 0, .. })
    ));
    let list = dnd
        .drag
        .as_ref()
        .and_then(|d| d.lists.get("list"))
        .expect("origin list cached");
    assert_eq!(
        list.items,
        vec!["list-row-t1".to_string(), "list-row-t3".to_string()]
    );
    assert!(
        prop(&tree, "list-row-t1", LOCAL_DY_PROP).is_some(),
        "t1 still shifted"
    );

    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);
    let drop = dnd.take_outcomes();
    assert_eq!(actions(&drop), vec![REORDER_ACTION, "reorder", "ended"]);
    assert_eq!(
        drop[0].payload,
        json!({ "path": "tasks", "from": 1, "to": 0 })
    );
}

#[test]
fn escape_and_focus_loss_cancel_with_drag_end_dropped_false() {
    let (mut dnd, mut tree, pass) = mount_sortable();
    let to = (
        center(&pass, "list-txt-t1").0,
        center(&pass, "list-row-t3").1,
    );
    drag_to(&mut dnd, &mut tree, &pass, "list-txt-t1", to);
    let _ = dnd.take_outcomes();
    assert!(dnd.escape(&mut tree));
    let end = dnd.take_outcomes();
    assert_eq!(actions(&end), vec!["ended"]);
    assert_eq!(end[0].payload["dropped"], json!(false));
    assert_eq!(end[0].payload["to"], json!({ "zone": "list", "index": 2 }));
    assert!(!dnd.is_active());
    assert!(prop(&tree, "list-row-t1", LOCAL_DY_PROP).is_none());
    assert!(!dnd.escape(&mut tree), "Esc with no drag is not consumed");

    // Focus loss is the winit `pointercancel`.
    drag_to(&mut dnd, &mut tree, &pass, "list-txt-t2", to);
    let _ = dnd.take_outcomes();
    dnd.pointer_cancel(&mut tree);
    let end = dnd.take_outcomes();
    assert_eq!(actions(&end), vec!["ended"]);
    assert_eq!(end[0].payload["dropped"], json!(false));
}

#[test]
fn a_release_over_nothing_cancels_with_drag_end_dropped_false() {
    let (mut dnd, mut tree, pass) = mount_sortable();
    drag_to(&mut dnd, &mut tree, &pass, "list-txt-t1", (700.0, 590.0));
    let _ = dnd.take_outcomes();
    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);
    let end = dnd.take_outcomes();
    assert_eq!(actions(&end), vec!["ended"]);
    assert_eq!(end[0].payload["dropped"], json!(false));
    assert_eq!(
        end[0].payload["to"],
        json!({ "zone": "list", "index": 0 }),
        "to falls back to from"
    );
    assert!(prop(&tree, "list-row-t1", LOCAL_DY_PROP).is_none());
}

#[test]
fn a_disabled_or_malformed_source_never_lifts() {
    let mut dnd = new_dnd();
    let mut tree = Tree::new();
    feed(
        &mut dnd,
        &mut tree,
        &[
            create(
                "off",
                "Row",
                vec![
                    ("width.0", json!(100)),
                    ("height.0", json!(40)),
                    ("__dnd.source", source_spec()),
                    ("__dnd.sourceEnabled", json!(false)),
                ],
            ),
            insert(ROOT_ID, "off"),
            create(
                "bad",
                "Row",
                vec![
                    ("width.0", json!(100)),
                    ("height.0", json!(40)),
                    ("__dnd.source", json!("nonsense")),
                ],
            ),
            insert(ROOT_ID, "bad"),
        ],
    );
    let pass = layout(&tree);
    let off = center(&pass, "off");
    let bad = center(&pass, "bad");
    assert!(!dnd.pointer_down(&mut tree, &pass, off.0, off.1, 1.0));
    assert!(!dnd.pointer_down(&mut tree, &pass, bad.0, bad.1, 1.0));
    // Re-enabling through the bindable piece arms it.
    feed(
        &mut dnd,
        &mut tree,
        &[set_prop("off", "__dnd.sourceEnabled", json!(true))],
    );
    assert!(dnd.pointer_down(&mut tree, &pass, off.0, off.1, 1.0));
}

// ---------------------------------------------------------------------------
// Drop zones + poses
// ---------------------------------------------------------------------------

fn mount_zone_scene() -> (DesktopDnd, Tree, LayoutPass) {
    let mut dnd = new_dnd();
    let mut tree = Tree::new();
    feed(
        &mut dnd,
        &mut tree,
        &[
            create(
                "root0",
                "Column",
                vec![("width.0", json!(400)), ("height.0", json!(600))],
            ),
            insert(ROOT_ID, "root0"),
            create(
                "card",
                "Row",
                vec![
                    ("width.0", json!(100)),
                    ("height.0", json!(40)),
                    ("opacity.0", json!(1)),
                    (
                        "__dnd.source",
                        json!({ "group": "cards", "handle": false, "activation": "auto" }),
                    ),
                    ("__anim.states", json!({ "label": null, "runtime": true })),
                    (
                        "__anim.statePoses",
                        json!({ "lifted": { "opacity.0": 0.6, "scale.0": 1.04 } }),
                    ),
                ],
            ),
            insert("root0", "card"),
            create(
                "trash",
                "Row",
                vec![
                    ("width.0", json!(400)),
                    ("height.0", json!(100)),
                    ("__dnd.zone", json!({ "group": "cards", "band": 0.5 })),
                    ("__dnd.zoneId", json!("trash")),
                    ("__dnd.zoneEnabled", json!(true)),
                    ("onDrop.0", json!("@dropped")),
                    ("onDragOver.0", json!("@peek")),
                    ("onDragOver.dwell", json!(200)),
                    ("__anim.states", json!({ "label": null, "runtime": true })),
                    (
                        "__anim.statePoses",
                        json!({ "over": { "backgroundColor.0": "#eee" } }),
                    ),
                ],
            ),
            insert("root0", "trash"),
            create(
                "other",
                "Row",
                vec![
                    ("width.0", json!(400)),
                    ("height.0", json!(100)),
                    ("__dnd.zone", json!({ "group": "files", "band": 0.5 })),
                    ("onDrop.0", json!("@wrong")),
                ],
            ),
            insert("root0", "other"),
        ],
    );
    let pass = layout(&tree);
    (dnd, tree, pass)
}

#[test]
fn drop_zone_into_fires_on_drop_and_the_labels_drive_the_headerless_poses() {
    let (mut dnd, mut tree, pass) = mount_zone_scene();
    let from = center(&pass, "card");
    let over = center(&pass, "trash");
    assert!(dnd.pointer_down(&mut tree, &pass, from.0, from.1, 1.0));
    dnd.pointer_move(&mut tree, Some(&pass), vp(), from.0 + 10.0, from.1);
    // `lifted` overlays the pose props onto the source's own props …
    assert_eq!(prop(&tree, "card", "opacity.0"), Some(json!(0.6)));
    assert_eq!(prop(&tree, "card", "scale.0"), Some(json!(1.04)));
    assert!(
        dnd.take_outcomes().is_empty(),
        "no onDragStart wired → nothing dispatched"
    );

    // … and `over` lands on the hovered, group-compatible zone only.
    dnd.pointer_move(&mut tree, Some(&pass), vp(), over.0, over.1);
    assert_eq!(
        prop(&tree, "trash", "backgroundColor.0"),
        Some(json!("#eee"))
    );
    let ghost_dy = prop(&tree, "card", LOCAL_DY_PROP)
        .and_then(|v| v.as_f64())
        .unwrap();
    assert!((ghost_dy - (over.1 - from.1)).abs() < 1e-3);

    // The dwell fires `.onDragOver` after `dwell` ms, with `dwell` stripped.
    dnd.set_manual_time_ms(100.0);
    dnd.tick(&mut tree, Some(&pass));
    assert!(dnd.take_outcomes().is_empty());
    dnd.set_manual_time_ms(200.0);
    dnd.tick(&mut tree, Some(&pass));
    let peek = dnd.take_outcomes();
    assert_eq!(actions(&peek), vec!["peek"]);
    assert_eq!(
        peek[0].payload,
        json!({
            "item": "card",
            "from": { "zone": "root0", "index": null },
            "to": { "zone": "trash", "index": null },
        })
    );

    // A group-incompatible zone is never a target: hovering it clears `over`.
    let elsewhere = center(&pass, "other");
    dnd.pointer_move(&mut tree, Some(&pass), vp(), elsewhere.0, elsewhere.1);
    assert!(
        prop(&tree, "trash", "backgroundColor.0").is_none(),
        "over pose restored (base was absent)"
    );
    dnd.pointer_move(&mut tree, Some(&pass), vp(), over.0, over.1);

    // Drop: `.onDrop` on the zone with `to.index = null` ("into"); no
    // `.onDragEnd` is wired, so nothing else fires.
    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);
    let drop = dnd.take_outcomes();
    assert_eq!(actions(&drop), vec!["dropped"]);
    assert_eq!(
        drop[0].payload,
        json!({
            "item": "card",
            "from": { "zone": "root0", "index": null },
            "to": { "zone": "trash", "index": null },
        })
    );
    // Held until the timeout (a zone drop has no Move to wait for), then
    // both poses restore to the base.
    assert_eq!(prop(&tree, "card", "opacity.0"), Some(json!(0.6)), "held");
    dnd.set_manual_time_ms(800.0);
    dnd.tick(&mut tree, Some(&pass));
    assert_eq!(prop(&tree, "card", "opacity.0"), Some(json!(1)));
    assert!(prop(&tree, "card", "scale.0").is_none());
    assert!(prop(&tree, "trash", "backgroundColor.0").is_none());
    assert!(prop(&tree, "card", LOCAL_DY_PROP).is_none());
}

#[test]
fn an_engine_write_to_a_pose_overridden_key_lands_when_the_label_clears() {
    let (mut dnd, mut tree, pass) = mount_zone_scene();
    let from = center(&pass, "card");
    drag_to(&mut dnd, &mut tree, &pass, "card", (from.0 + 30.0, from.1));
    assert_eq!(prop(&tree, "card", "opacity.0"), Some(json!(0.6)));
    feed(
        &mut dnd,
        &mut tree,
        &[set_prop("card", "opacity.0", json!(0.3))],
    );
    assert_eq!(
        prop(&tree, "card", "opacity.0"),
        Some(json!(0.6)),
        "pose wins while lifted"
    );
    assert!(dnd.escape(&mut tree));
    assert_eq!(
        prop(&tree, "card", "opacity.0"),
        Some(json!(0.3)),
        "deferred write applied at clear"
    );
}

// ---------------------------------------------------------------------------
// Pinboard (reserved-state mode)
// ---------------------------------------------------------------------------

fn pinboard_patches(grid: Value, bounds: &str, units: &str) -> Vec<Patch> {
    let note = |id: &str, tx: Value, ty: Value| {
        create(
            id,
            "Row",
            vec![
                ("width.0", json!(50)),
                ("height.0", json!(30)),
                ("__dnd.key", json!(id)),
                ("__dnd.pinGroup", json!("board")),
                ("__dnd.source", source_spec()),
                ("translateX.0", tx),
                ("translateY.0", ty),
            ],
        )
    };
    vec![
        create(
            "board",
            "Stack",
            vec![
                ("width.0", json!(400)),
                ("height.0", json!(300)),
                (
                    "__dnd.pin",
                    json!({
                        "group": "board", "xKey": "x", "yKey": "y",
                        "grid": grid, "bounds": bounds, "units": units,
                    }),
                ),
                ("onPin.0", json!("@pinned")),
            ],
        ),
        insert(ROOT_ID, "board"),
        note("n1", Value::Null, Value::Null),
        insert("board", "n1"),
        note("n2", json!(100), json!(50)),
        insert("board", "n2"),
    ]
}

#[test]
fn pinboard_reserved_mode_dispatches_pin_then_holds_for_the_translate_setprop() {
    let mut dnd = new_dnd();
    let mut tree = Tree::new();
    feed(
        &mut dnd,
        &mut tree,
        &pinboard_patches(Value::Null, "clamp", "px"),
    );
    let pass = layout(&tree);

    // Injected bindings that resolve to `null` read as 0 (§3).
    assert!(
        pass.item_by_id("n1").expect("n1").transform.is_identity(),
        "null translate = 0"
    );
    let n2 = pass.item_by_id("n2").expect("n2");
    let n1_rect = pass.item_by_id("n1").expect("n1").rect;
    let (x2, y2) = n2.transform.apply(n2.rect.x, n2.rect.y);
    assert!((x2 - (n1_rect.x + 100.0)).abs() < 1e-3 && (y2 - (n1_rect.y + 50.0)).abs() < 1e-3);

    let from = center(&pass, "n1");
    drag_to(
        &mut dnd,
        &mut tree,
        &pass,
        "n1",
        (from.0 + 120.0, from.1 + 80.0),
    );
    assert!(dnd.take_outcomes().is_empty(), "no onDragStart wired");
    assert!(dnd.owns_node("n1"));

    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);
    let drop = dnd.take_outcomes();
    assert_eq!(actions(&drop), vec![PIN_ACTION, "pinned"]);
    assert_eq!(
        drop[0].payload,
        json!({ "path": "__dnd.board.n1", "x": 120.0, "y": 80.0, "xKey": "x", "yKey": "y" })
    );
    assert_eq!(
        drop[1].payload,
        json!({
            "item": "n1",
            "from": { "zone": "board", "index": 0 },
            "to": { "zone": "board", "index": 0 },
            "x": 120.0,
            "y": 80.0,
        })
    );

    // Hold: the ghost stays at the resolved position until the engine's
    // translate re-render lands on the node — then it releases and the
    // SetProps flow through (the engine's value replaces the local offset).
    assert_eq!(prop(&tree, "n1", LOCAL_DX_PROP), Some(json!(120.0)));
    assert_eq!(
        prop(&tree, "n1", "translateX.0"),
        Some(Value::Null),
        "engine base untouched during the hold"
    );
    feed(
        &mut dnd,
        &mut tree,
        &[
            set_prop("n1", "translateX.0", json!(120)),
            set_prop("n1", "translateY.0", json!(80)),
        ],
    );
    assert!(!dnd.is_active());
    assert!(
        prop(&tree, "n1", LOCAL_DX_PROP).is_none() && prop(&tree, "n1", LOCAL_DY_PROP).is_none()
    );
    assert_eq!(prop(&tree, "n1", "translateX.0"), Some(json!(120)));
    assert_eq!(prop(&tree, "n1", "translateY.0"), Some(json!(80)));
}

#[test]
fn pinboard_grid_snap_and_clamp_bound_the_pin() {
    let mut dnd = new_dnd();
    let mut tree = Tree::new();
    feed(
        &mut dnd,
        &mut tree,
        &pinboard_patches(json!(8), "clamp", "px"),
    );
    let pass = layout(&tree);
    let from = center(&pass, "n1");
    // The item overhangs the board (pointer still inside it): snapped
    // (370 → 368, 275 → 272) then clamped to the content box minus the
    // item size (350, 270).
    drag_to(
        &mut dnd,
        &mut tree,
        &pass,
        "n1",
        (from.0 + 370.0, from.1 + 275.0),
    );
    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);
    let drop = dnd.take_outcomes();
    assert_eq!(drop[0].payload["x"], json!(350.0));
    assert_eq!(drop[0].payload["y"], json!(270.0));
    // The ghost snaps to the resolved position for the hold.
    assert_eq!(prop(&tree, "n1", LOCAL_DX_PROP), Some(json!(350.0)));
    dnd.set_manual_time_ms(1000.0);
    dnd.tick(&mut tree, Some(&pass));

    // Grid: 43 → 40, 21 → 24.
    let pass = layout(&tree);
    let from = center(&pass, "n1");
    drag_to(
        &mut dnd,
        &mut tree,
        &pass,
        "n1",
        (from.0 + 43.0, from.1 + 21.0),
    );
    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);
    let drop = dnd.take_outcomes();
    assert_eq!(drop[0].payload["x"], json!(40.0));
    assert_eq!(drop[0].payload["y"], json!(24.0));
}

/// §6.11 "Pinboard drop geometry": a re-pin of an already-positioned note
/// starts from the note's RENDERED top-left (layout rect + its current
/// translate), so the dispatched x/y is base + delta, and the held ghost
/// sits exactly where the engine's follow-up translate write will land.
#[test]
fn pinboard_repin_of_a_positioned_note_adds_the_existing_translate() {
    let mut dnd = new_dnd();
    let mut tree = Tree::new();
    feed(
        &mut dnd,
        &mut tree,
        &pinboard_patches(Value::Null, "clamp", "px"),
    );
    let pass = layout(&tree);
    let board = pass.item_by_id("board").expect("board").rect;
    let n2_before = pass.item_by_id("n2").expect("n2").visual_rect();
    assert!(
        (n2_before.x - (board.x + 100.0)).abs() < 1e-3
            && (n2_before.y - (board.y + 50.0)).abs() < 1e-3,
        "n2 renders at its translate (100, 50)"
    );

    // Press where n2 is PAINTED (the untransformed slot is n1's).
    let from = visual_center(&pass, "n2");
    assert!(dnd.pointer_down(&mut tree, &pass, from.0, from.1, 1.0));
    dnd.pointer_move(&mut tree, Some(&pass), vp(), from.0 + 10.0, from.1);
    dnd.pointer_move(&mut tree, Some(&pass), vp(), from.0 + 10.0, from.1 + 10.0);
    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);

    let drop = dnd.take_outcomes();
    assert_eq!(actions(&drop), vec![PIN_ACTION, "pinned"]);
    assert_eq!(
        drop[0].payload,
        json!({ "path": "__dnd.board.n2", "x": 110.0, "y": 60.0, "xKey": "x", "yKey": "y" }),
        "base translate (100, 50) + delta (10, 10)"
    );
    assert_eq!(drop[1].payload["x"], json!(110.0));
    assert_eq!(drop[1].payload["y"], json!(60.0));
    assert_eq!(drop[1].payload["item"], json!("n2"));

    // The held ghost's local offset is relative to the rendered origin…
    assert_eq!(prop(&tree, "n2", LOCAL_DX_PROP), Some(json!(10.0)));
    assert_eq!(prop(&tree, "n2", LOCAL_DY_PROP), Some(json!(10.0)));
    // …so the ghost paints exactly at the dispatched position.
    let held = layout(&tree).item_by_id("n2").expect("n2").visual_rect();
    assert!(
        (held.x - (board.x + 110.0)).abs() < 1e-3 && (held.y - (board.y + 60.0)).abs() < 1e-3,
        "held ghost at (110, 60), got ({}, {})",
        held.x - board.x,
        held.y - board.y
    );

    // The engine's translate write lands on the same pixels: no jump.
    feed(
        &mut dnd,
        &mut tree,
        &[
            set_prop("n2", "translateX.0", json!(110)),
            set_prop("n2", "translateY.0", json!(60)),
        ],
    );
    assert!(!dnd.is_active());
    assert!(prop(&tree, "n2", LOCAL_DX_PROP).is_none());
    let after = layout(&tree).item_by_id("n2").expect("n2").visual_rect();
    assert!(
        (after.x - held.x).abs() < 1e-3 && (after.y - held.y).abs() < 1e-3,
        "the engine value replaces the local offset without moving the note"
    );
}

/// Same rule with a grid: the snap composes on top of the base translate
/// and the held ghost still lands on the snapped value.
#[test]
fn pinboard_repin_grid_snaps_from_the_rendered_origin() {
    let mut dnd = new_dnd();
    let mut tree = Tree::new();
    feed(
        &mut dnd,
        &mut tree,
        &pinboard_patches(json!(8), "clamp", "px"),
    );
    let pass = layout(&tree);
    let board = pass.item_by_id("board").expect("board").rect;
    let from = visual_center(&pass, "n2");
    assert!(dnd.pointer_down(&mut tree, &pass, from.0, from.1, 1.0));
    dnd.pointer_move(&mut tree, Some(&pass), vp(), from.0 + 10.0, from.1);
    // (100 + 13, 50 + 5) = (113, 55) → snapped (112, 56).
    dnd.pointer_move(&mut tree, Some(&pass), vp(), from.0 + 13.0, from.1 + 5.0);
    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);
    let drop = dnd.take_outcomes();
    assert_eq!(drop[0].payload["x"], json!(112.0));
    assert_eq!(drop[0].payload["y"], json!(56.0));
    assert_eq!(prop(&tree, "n2", LOCAL_DX_PROP), Some(json!(12.0)));
    assert_eq!(prop(&tree, "n2", LOCAL_DY_PROP), Some(json!(6.0)));
    let held = layout(&tree).item_by_id("n2").expect("n2").visual_rect();
    assert!((held.x - (board.x + 112.0)).abs() < 1e-3 && (held.y - (board.y + 56.0)).abs() < 1e-3);
}

/// User-field mode (`pinboard-user-field-lowering` fixture): `bind` present,
/// the author's own `translateX(@item.x)` numbers, no `__dnd.pinGroup`; the
/// write path is `<bind>.<index>` and the geometry rule is the same.
#[test]
fn pinboard_user_field_mode_repins_from_the_authored_translate() {
    let mut dnd = new_dnd();
    let mut tree = Tree::new();
    let seat = |id: &str, tx: i64, ty: i64| {
        create(
            id,
            "Seat",
            vec![
                ("width.0", json!(50)),
                ("height.0", json!(30)),
                ("__dnd.key", json!(id)),
                ("__dnd.source", source_spec()),
                ("translateX.0", json!(tx)),
                ("translateY.0", json!(ty)),
            ],
        )
    };
    feed(
        &mut dnd,
        &mut tree,
        &[
            create(
                "plan",
                "Stack",
                vec![
                    ("width.0", json!(400)),
                    ("height.0", json!(300)),
                    (
                        "__dnd.pin",
                        json!({ "group": null, "xKey": "x", "yKey": "y", "grid": 8, "bounds": "clamp", "units": "px" }),
                    ),
                    ("bind", json!("seats")),
                    ("onPin.0", json!("@seated")),
                ],
            ),
            insert(ROOT_ID, "plan"),
            seat("s1", 10, 20),
            insert("plan", "s1"),
            seat("s2", 200, 100),
            insert("plan", "s2"),
        ],
    );
    let pass = layout(&tree);
    let from = visual_center(&pass, "s2");
    assert!(dnd.pointer_down(&mut tree, &pass, from.0, from.1, 1.0));
    dnd.pointer_move(&mut tree, Some(&pass), vp(), from.0 + 10.0, from.1);
    // (200 + 20, 100 - 30) = (220, 70) → snapped (224, 72).
    dnd.pointer_move(&mut tree, Some(&pass), vp(), from.0 + 20.0, from.1 - 30.0);
    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);
    let drop = dnd.take_outcomes();
    assert_eq!(actions(&drop), vec![PIN_ACTION, "seated"]);
    assert_eq!(
        drop[0].payload,
        json!({ "path": "seats.1", "x": 224.0, "y": 72.0, "xKey": "x", "yKey": "y" })
    );
    assert_eq!(
        drop[1].payload["from"],
        json!({ "zone": "plan", "index": 1 })
    );
    assert_eq!(drop[1].payload["x"], json!(224.0));
    assert_eq!(drop[1].payload["y"], json!(72.0));
    // The author's re-render carries the new item fields; hold releases.
    feed(
        &mut dnd,
        &mut tree,
        &[
            set_prop("s2", "translateX.0", json!(224)),
            set_prop("s2", "translateY.0", json!(72)),
        ],
    );
    assert!(!dnd.is_active());
    let plan = pass.item_by_id("plan").expect("plan").rect;
    let after = layout(&tree).item_by_id("s2").expect("s2").visual_rect();
    assert!((after.x - (plan.x + 224.0)).abs() < 1e-3 && (after.y - (plan.y + 72.0)).abs() < 1e-3);
}

#[test]
fn pinboard_fraction_units_divide_by_the_content_box() {
    let mut dnd = new_dnd();
    let mut tree = Tree::new();
    feed(
        &mut dnd,
        &mut tree,
        &pinboard_patches(Value::Null, "free", "fraction"),
    );
    let pass = layout(&tree);
    let from = center(&pass, "n1");
    drag_to(
        &mut dnd,
        &mut tree,
        &pass,
        "n1",
        (from.0 + 100.0, from.1 + 150.0),
    );
    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);
    let drop = dnd.take_outcomes();
    assert_eq!(drop[0].payload["x"], json!(0.25));
    assert_eq!(drop[0].payload["y"], json!(0.5));
}

#[test]
fn an_engine_translate_write_on_the_lifted_node_is_deferred_until_release() {
    let mut dnd = new_dnd();
    let mut tree = Tree::new();
    feed(
        &mut dnd,
        &mut tree,
        &pinboard_patches(Value::Null, "clamp", "px"),
    );
    let pass = layout(&tree);
    let from = center(&pass, "n1");
    drag_to(&mut dnd, &mut tree, &pass, "n1", (from.0 + 40.0, from.1));
    feed(
        &mut dnd,
        &mut tree,
        &[set_prop("n1", "translateX.0", json!(999))],
    );
    assert_eq!(
        prop(&tree, "n1", "translateX.0"),
        Some(Value::Null),
        "swallowed while lifted"
    );
    assert!(dnd.escape(&mut tree));
    assert_eq!(
        prop(&tree, "n1", "translateX.0"),
        Some(json!(999)),
        "replayed at release"
    );
    assert!(prop(&tree, "n1", LOCAL_DX_PROP).is_none());
}

#[test]
fn a_foreign_pinboard_is_a_plain_into_zone() {
    let mut dnd = new_dnd();
    let mut tree = Tree::new();
    let mut patches = pinboard_patches(Value::Null, "clamp", "px");
    patches.extend([
        create(
            "board2",
            "Stack",
            vec![
                ("width.0", json!(400)),
                ("height.0", json!(200)),
                (
                    "__dnd.pin",
                    json!({ "group": "board", "xKey": "x", "yKey": "y", "grid": null, "bounds": "clamp", "units": "px" }),
                ),
                ("onDrop.0", json!("@moved")),
            ],
        ),
        insert(ROOT_ID, "board2"),
    ]);
    feed(&mut dnd, &mut tree, &patches);
    let pass = layout(&tree);
    let to = center(&pass, "board2");
    drag_to(&mut dnd, &mut tree, &pass, "n1", to);
    assert_eq!(dnd.pointer_up(&mut tree, None), DndPointerUp::Claimed);
    let drop = dnd.take_outcomes();
    assert_eq!(
        actions(&drop),
        vec!["moved"],
        "no pin write for a foreign board"
    );
    assert_eq!(
        drop[0].payload["to"],
        json!({ "zone": "board", "index": null })
    );
}

// ---------------------------------------------------------------------------
// Paint-side plumbing
// ---------------------------------------------------------------------------

#[test]
fn raised_ids_cover_the_lifted_item_subtree_and_transforms_follow_the_offsets() {
    let (mut dnd, mut tree, pass) = mount_sortable();
    assert!(dnd.raised_ids(&tree).is_empty());
    let from = center(&pass, "list-txt-t1");
    let sibling = pass.item_by_id("list-row-t2").unwrap().rect;
    let target_y = (sibling.y + sibling.h * 0.75) as f64;
    let delta_y = (target_y - from.1) as f32;
    drag_to(
        &mut dnd,
        &mut tree,
        &pass,
        "list-txt-t1",
        (from.0, target_y),
    );
    let raised = dnd.raised_ids(&tree);
    assert!(raised.contains("list-row-t1") && raised.contains("list-txt-t1"));
    assert!(!raised.contains("list-row-t2"));
    // The offsets reach the layout transform post-pass (paint AND hit-test).
    let pass2 = layout(&tree);
    let row = pass2.item_by_id("list-row-t1").unwrap();
    let (_, ty) = row.transform.apply(row.rect.x, row.rect.y);
    assert!(
        (ty - (row.rect.y + delta_y)).abs() < 1e-3,
        "ghost follows the pointer delta"
    );
    let base = pass.item_by_id("list-row-t2").unwrap().rect;
    let shifted = pass2.item_by_id("list-row-t2").unwrap();
    let (_, sy) = shifted.transform.apply(shifted.rect.x, shifted.rect.y);
    assert!(
        sy < base.y - 1.0,
        "the passed sibling paints in the gap above"
    );
    assert!(
        shifted.hit_contains(shifted.rect.x + 5.0, sy + 5.0),
        "hit target moved with the pixels"
    );
}

// Gesture tests inspect semantic outcomes; routing tests inspect the envelope.
impl DesktopDnd {
    fn take_outcomes(&mut self) -> Vec<DndDispatch> {
        self.take_dispatches()
            .into_iter()
            .map(|d| {
                if d.action == hypen_engine::action_routing::UI_ACTION {
                    DndDispatch {
                        action: d.payload["action"].as_str().unwrap().into(),
                        payload: d.payload["payload"].clone(),
                    }
                } else {
                    d
                }
            })
            .collect()
    }
}

#[test]
fn fractional_pins_project_in_layout_and_follow_board_resize() {
    let mut dnd = new_dnd();
    let mut tree = Tree::new();
    let mut patches = pinboard_patches(Value::Null, "clamp", "fraction");
    patches.push(set_prop("n1", "__dnd.pinX", json!(0.5)));
    patches.push(set_prop("n1", "__dnd.pinY", json!(0.25)));
    feed(&mut dnd, &mut tree, &patches);
    let pass = layout(&tree);
    let item = pass.item_by_id("n1").unwrap();
    let visible = item.transform.aabb_of(item.rect);
    assert!((visible.x - item.rect.x - 200.0).abs() < 0.01);
    assert!((visible.y - item.rect.y - 75.0).abs() < 0.01);
    feed(
        &mut dnd,
        &mut tree,
        &[set_prop("board", "width.0", json!(600))],
    );
    let pass = layout(&tree);
    let item = pass.item_by_id("n1").unwrap();
    assert!((item.transform.aabb_of(item.rect).x - item.rect.x - 300.0).abs() < 0.01);
    assert!(dnd.take_dispatches().is_empty());
}

// ---------------------------------------------------------------------------
// Files from the OS (`.dropZone(files: true, accept:)`)
// ---------------------------------------------------------------------------

use super::files::{accept_matches, HoveredKind};
use std::path::Path;

fn kinds(paths: &[&str]) -> Vec<HoveredKind> {
    paths
        .iter()
        .map(|p| HoveredKind::from_path(Path::new(p)))
        .collect()
}

fn files_zone(accept: Value) -> Value {
    json!({ "group": null, "band": 0.5, "files": true, "accept": accept })
}

fn over_pose() -> (&'static str, Value) {
    (
        "__anim.statePoses",
        json!({ "over": { "backgroundColor.0": "#eef" } }),
    )
}

/// outer (400×300, any file, `@outerEnter`) ⊃ inner (200×100, `image/*`,
/// `@upload`); then a pdf-only zone, a DISABLED files zone, and an in-app-
/// only zone — each 400 wide, stacked below.
fn mount_files_scene() -> (DesktopDnd, Tree, LayoutPass) {
    let mut dnd = new_dnd();
    let mut tree = Tree::new();
    let runtime = ("__anim.states", json!({ "label": null, "runtime": true }));
    feed(
        &mut dnd,
        &mut tree,
        &[
            create(
                "root0",
                "Column",
                vec![("width.0", json!(400)), ("height.0", json!(600))],
            ),
            insert(ROOT_ID, "root0"),
            create(
                "outer",
                "Column",
                vec![
                    ("width.0", json!(400)),
                    ("height.0", json!(300)),
                    ("__dnd.zone", files_zone(Value::Null)),
                    ("onFileDragEnter.0", json!("@outerEnter")),
                    runtime.clone(),
                    over_pose(),
                ],
            ),
            insert("root0", "outer"),
            create(
                "inner",
                "Row",
                vec![
                    ("width.0", json!(200)),
                    ("height.0", json!(100)),
                    ("__dnd.zone", files_zone(json!("image/*"))),
                    ("onFileDragEnter.0", json!("@upload")),
                    runtime.clone(),
                    over_pose(),
                ],
            ),
            insert("outer", "inner"),
            create(
                "pdf",
                "Row",
                vec![
                    ("width.0", json!(400)),
                    ("height.0", json!(100)),
                    ("__dnd.zone", files_zone(json!("application/pdf"))),
                    runtime.clone(),
                    over_pose(),
                ],
            ),
            insert("root0", "pdf"),
            create(
                "off",
                "Row",
                vec![
                    ("width.0", json!(400)),
                    ("height.0", json!(50)),
                    ("__dnd.zone", files_zone(Value::Null)),
                    ("__dnd.zoneEnabled", json!(false)),
                    runtime.clone(),
                    over_pose(),
                ],
            ),
            insert("root0", "off"),
            create(
                "plain",
                "Row",
                vec![
                    ("width.0", json!(400)),
                    ("height.0", json!(50)),
                    ("__dnd.zone", json!({ "group": null, "band": 0.5 })),
                    runtime,
                    over_pose(),
                ],
            ),
            insert("root0", "plain"),
        ],
    );
    let pass = layout(&tree);
    (dnd, tree, pass)
}

fn bg(tree: &Tree, id: &str) -> Option<Value> {
    prop(tree, id, "backgroundColor.0")
}

#[test]
fn files_zone_spec_parses_files_and_accept() {
    let z =
        parse_zone(&json!({ "group": null, "band": 0.5, "files": true, "accept": "image/*,.pdf" }))
            .unwrap();
    assert!(z.files);
    assert_eq!(z.accept.as_deref(), Some("image/*,.pdf"));

    let z =
        parse_zone(&json!({ "group": null, "band": 0.5, "files": true, "accept": null })).unwrap();
    assert!(z.files);
    assert_eq!(z.accept, None);

    // Old wire: no `files` key ⇒ in-app only.
    let z = parse_zone(&json!({ "group": "cards", "band": 0.3 })).unwrap();
    assert!(!z.files);
    assert_eq!(z.accept, None);
    assert_eq!(z.group.as_deref(), Some("cards"));

    // `accept` without `files: true` is ignored; an empty filter is "any".
    let z = parse_zone(&json!({ "group": null, "band": 0.5, "accept": "image/*" })).unwrap();
    assert!(!z.files && z.accept.is_none());
    let z =
        parse_zone(&json!({ "group": null, "band": 0.5, "files": true, "accept": "  " })).unwrap();
    assert!(z.files && z.accept.is_none());

    // The Remote UI string encoding parses the same.
    let z = parse_zone(&json!(
        r#"{"group":null,"band":0.5,"files":true,"accept":".pdf"}"#
    ))
    .unwrap();
    assert!(z.files);
    assert_eq!(z.accept.as_deref(), Some(".pdf"));
}

#[test]
fn accept_matches_by_extension_and_guessed_mime() {
    let png = kinds(&["/Users/me/Pictures/cat.PNG"]);
    let pdf = kinds(&["/tmp/report.pdf"]);
    let odd = kinds(&["/tmp/data.xyz"]);
    let folder = kinds(&["/Users/me/Folder"]);

    assert!(accept_matches(None, &png));
    assert!(accept_matches(Some(""), &pdf));
    assert!(accept_matches(Some("image/*"), &png));
    assert!(!accept_matches(Some("image/*"), &pdf));
    assert!(accept_matches(Some("application/pdf"), &pdf));
    assert!(!accept_matches(Some("application/pdf"), &png));
    assert!(accept_matches(Some(".pdf"), &pdf));
    assert!(accept_matches(Some(".PDF"), &pdf), "case-insensitive");
    assert!(accept_matches(Some("Image/*"), &png), "case-insensitive");
    assert!(accept_matches(Some("image/png"), &png));
    assert!(!accept_matches(Some("image/jpeg"), &png));
    assert!(accept_matches(Some("image/*, .pdf"), &pdf), "comma list");
    assert!(accept_matches(Some("*/*"), &pdf));
    // At least ONE item must match.
    let mixed = kinds(&["/a/notes.docx", "/a/photo.jpeg"]);
    assert!(accept_matches(Some("image/*"), &mixed));
    assert!(!accept_matches(Some("video/*"), &mixed));
    // A type that can't be told before the drop counts as a MIME match,
    // but an `.ext` token compares the name.
    assert!(accept_matches(Some("image/*"), &odd));
    assert!(!accept_matches(Some(".pdf"), &odd));
    assert!(accept_matches(Some("application/pdf"), &folder));
    assert!(!accept_matches(Some(".pdf"), &folder));
    // No items known ⇒ match.
    assert!(accept_matches(Some("image/*"), &[]));
}

#[test]
fn file_hover_resolves_the_innermost_enabled_matching_zone() {
    let (mut dnd, mut tree, pass) = mount_files_scene();
    let inner = center(&pass, "inner");
    let outer_only = (350.0, inner.1);
    dnd.file_hover_enter(Path::new("/Users/me/cat.png"));
    assert!(dnd.is_file_hovering());
    assert!(
        dnd.file_hover_zone().is_none(),
        "nothing resolves before an update"
    );

    // Innermost wins; only one zone is `over`.
    dnd.file_hover_update(&mut tree, Some(&pass), Some(inner));
    assert_eq!(dnd.file_hover_zone(), Some("inner"));
    assert_eq!(bg(&tree, "inner"), Some(json!("#eef")));
    assert!(bg(&tree, "outer").is_none());

    // Outside the inner zone → the outer one.
    dnd.file_hover_update(&mut tree, Some(&pass), Some(outer_only));
    assert_eq!(dnd.file_hover_zone(), Some("outer"));
    assert!(bg(&tree, "inner").is_none(), "previous zone restored");
    assert_eq!(bg(&tree, "outer"), Some(json!("#eef")));

    // An accept mismatch, a disabled zone and an in-app-only zone are
    // transparent.
    for id in ["pdf", "off", "plain"] {
        dnd.file_hover_update(&mut tree, Some(&pass), Some(center(&pass, id)));
        assert_eq!(
            dnd.file_hover_zone(),
            None,
            "{id} is not a target for a png"
        );
        assert!(bg(&tree, id).is_none());
    }
    assert!(bg(&tree, "outer").is_none());

    // `None` keeps the last seen position; no layout resolves nothing.
    dnd.file_hover_update(&mut tree, Some(&pass), Some(inner));
    dnd.file_hover_update(&mut tree, Some(&pass), None);
    assert_eq!(dnd.file_hover_zone(), Some("inner"));
    dnd.file_hover_update(&mut tree, None, Some(outer_only));
    assert_eq!(dnd.file_hover_zone(), Some("inner"), "held until a layout");
}

#[test]
fn file_hover_pdf_lights_the_pdf_zone_but_not_the_image_zone() {
    let (mut dnd, mut tree, pass) = mount_files_scene();
    dnd.file_hover_enter(Path::new("/tmp/report.pdf"));
    dnd.file_hover_update(&mut tree, Some(&pass), Some(center(&pass, "pdf")));
    assert_eq!(dnd.file_hover_zone(), Some("pdf"));
    // Over the image-only inner zone, the enclosing any-file zone wins.
    dnd.file_hover_update(&mut tree, Some(&pass), Some(center(&pass, "inner")));
    assert_eq!(dnd.file_hover_zone(), Some("outer"));
}

#[test]
fn file_hover_without_a_position_picks_only_a_sole_files_zone() {
    // Several files zones laid out: no position ⇒ no zone, never a guess.
    let (mut dnd, mut tree, pass) = mount_files_scene();
    dnd.file_hover_enter(Path::new("/tmp/cat.png"));
    dnd.file_hover_update(&mut tree, Some(&pass), None);
    assert_eq!(dnd.file_hover_zone(), None);
    assert!(dnd.take_outcomes().is_empty());

    // Exactly one enabled files zone (the disabled one doesn't count).
    let sole = |accept: Value| {
        let mut dnd = new_dnd();
        let mut tree = Tree::new();
        feed(
            &mut dnd,
            &mut tree,
            &[
                create(
                    "z",
                    "Column",
                    vec![
                        ("width.0", json!(300)),
                        ("height.0", json!(200)),
                        ("__dnd.zone", files_zone(accept)),
                        ("onFileDragEnter.0", json!("@upload")),
                        ("__anim.states", json!({ "label": null, "runtime": true })),
                        over_pose(),
                    ],
                ),
                insert(ROOT_ID, "z"),
                create(
                    "off",
                    "Row",
                    vec![
                        ("width.0", json!(300)),
                        ("height.0", json!(50)),
                        ("__dnd.zone", files_zone(Value::Null)),
                        ("__dnd.zoneEnabled", json!(false)),
                    ],
                ),
                insert(ROOT_ID, "off"),
            ],
        );
        let pass = layout(&tree);
        (dnd, tree, pass)
    };
    let (mut dnd, mut tree, pass) = sole(json!("image/*"));
    dnd.file_hover_enter(Path::new("/tmp/cat.png"));
    dnd.file_hover_update(&mut tree, Some(&pass), None);
    assert_eq!(dnd.file_hover_zone(), Some("z"));
    assert_eq!(bg(&tree, "z"), Some(json!("#eef")));
    assert_eq!(actions(&dnd.take_outcomes()), vec!["upload"]);

    // … but not when its `accept` rejects the drag.
    let (mut dnd, mut tree, pass) = sole(json!("application/pdf"));
    dnd.file_hover_enter(Path::new("/tmp/cat.png"));
    dnd.file_hover_update(&mut tree, Some(&pass), None);
    assert_eq!(dnd.file_hover_zone(), None);
    assert!(dnd.take_outcomes().is_empty());
}

#[test]
fn file_hover_pose_clears_on_leave_cancel_and_drop() {
    let (mut dnd, mut tree, pass) = mount_files_scene();
    let inner = center(&pass, "inner");

    // Cancel (HoveredFileCancelled): pose restored, hover gone.
    dnd.file_hover_enter(Path::new("/tmp/cat.png"));
    dnd.file_hover_update(&mut tree, Some(&pass), Some(inner));
    assert_eq!(bg(&tree, "inner"), Some(json!("#eef")));
    assert!(dnd.take_dirty().props);
    dnd.file_hover_end(&mut tree);
    assert!(!dnd.is_file_hovering());
    assert!(bg(&tree, "inner").is_none());
    assert!(dnd.take_dirty().props);

    // Drop (DroppedFile, once per file): the first clears, the rest are
    // no-ops, nothing but the entry signal is ever dispatched.
    dnd.take_outcomes();
    dnd.file_hover_enter(Path::new("/tmp/cat.png"));
    dnd.file_hover_enter(Path::new("/tmp/dog.png"));
    dnd.file_hover_update(&mut tree, Some(&pass), Some(inner));
    assert_eq!(actions(&dnd.take_outcomes()), vec!["outerEnter", "upload"]);
    dnd.file_hover_end(&mut tree);
    dnd.file_hover_end(&mut tree);
    assert!(bg(&tree, "inner").is_none());
    assert!(dnd.take_outcomes().is_empty(), "a release delivers nothing");

    // Leaving every zone clears too.
    dnd.file_hover_enter(Path::new("/tmp/cat.png"));
    dnd.file_hover_update(&mut tree, Some(&pass), Some(inner));
    dnd.file_hover_update(&mut tree, Some(&pass), Some((790.0, 590.0)));
    assert_eq!(dnd.file_hover_zone(), None);
    assert!(bg(&tree, "inner").is_none() && bg(&tree, "outer").is_none());

    // A base value is restored, not removed.
    feed(
        &mut dnd,
        &mut tree,
        &[set_prop("outer", "backgroundColor.0", json!("#fff"))],
    );
    let pass = layout(&tree);
    dnd.file_hover_update(&mut tree, Some(&pass), Some((350.0, inner.1)));
    assert_eq!(bg(&tree, "outer"), Some(json!("#eef")));
    dnd.file_hover_end(&mut tree);
    assert_eq!(bg(&tree, "outer"), Some(json!("#fff")));
}

#[test]
fn file_drag_enter_fires_once_per_entry_with_the_count_only() {
    let (mut dnd, mut tree, pass) = mount_files_scene();
    let inner = center(&pass, "inner");
    let outer_only = (350.0, inner.1);
    let secret = "/Users/me/Secret Folder/tax-return.png";
    dnd.file_hover_enter(Path::new(secret));
    dnd.file_hover_enter(Path::new("/Users/me/b.jpg"));

    // Entering the inner zone directly enters the outer one too (outer
    // first) — one dispatch each, counting the whole burst.
    dnd.file_hover_update(&mut tree, Some(&pass), Some(inner));
    let raw = dnd.take_dispatches();
    assert_eq!(raw.len(), 2);
    assert_eq!(raw[1].action, hypen_engine::action_routing::UI_ACTION);
    assert_eq!(raw[1].payload["node"], json!("inner"));
    assert_eq!(raw[1].payload["action"], json!("upload"));
    let payload = raw[1].payload["payload"].as_object().unwrap();
    assert_eq!(payload["type"], json!("filedragenter"));
    assert_eq!(payload["items"], json!(2));
    assert!(payload["timestamp"].as_u64().is_some_and(|t| t > 0));
    assert_eq!(payload.len(), 3, "only type / timestamp / items");
    let wire = format!("{raw:?}");
    for leak in ["Secret", "tax-return", "b.jpg", "/Users"] {
        assert!(!wire.contains(leak), "no names or paths: {leak}");
    }

    // Holding still, wandering inside, or stepping out to the enclosing
    // zone and back never re-fires.
    dnd.file_hover_update(&mut tree, Some(&pass), Some(inner));
    dnd.file_hover_update(&mut tree, Some(&pass), Some((inner.0 + 5.0, inner.1)));
    dnd.file_hover_update(&mut tree, Some(&pass), Some(outer_only));
    assert!(dnd.take_outcomes().is_empty());
    // Re-entering the inner zone after leaving it IS a new entry for it
    // (the outer one was never left).
    dnd.file_hover_update(&mut tree, Some(&pass), Some(inner));
    assert_eq!(actions(&dnd.take_outcomes()), vec!["upload"]);

    // Leave everything and come back: both fire again.
    dnd.file_hover_update(&mut tree, Some(&pass), Some((790.0, 590.0)));
    dnd.file_hover_update(&mut tree, Some(&pass), Some(inner));
    assert_eq!(actions(&dnd.take_outcomes()), vec!["outerEnter", "upload"]);

    // A new drag is a new entry.
    dnd.file_hover_end(&mut tree);
    dnd.file_hover_enter(Path::new("/tmp/c.gif"));
    dnd.file_hover_update(&mut tree, Some(&pass), Some(inner));
    let again = dnd.take_outcomes();
    assert_eq!(actions(&again), vec!["outerEnter", "upload"]);
    assert_eq!(again[1].payload["items"], json!(1));
}

#[test]
fn file_drag_enter_custom_args_replace_the_payload() {
    let (mut dnd, mut tree, pass) = mount_files_scene();
    feed(
        &mut dnd,
        &mut tree,
        &[set_prop("inner", "onFileDragEnter.slot", json!("avatar"))],
    );
    dnd.file_hover_enter(Path::new("/tmp/cat.png"));
    dnd.file_hover_update(&mut tree, Some(&pass), Some(center(&pass, "inner")));
    let out = dnd.take_outcomes();
    assert_eq!(actions(&out), vec!["outerEnter", "upload"]);
    assert_eq!(out[1].payload, json!({ "slot": "avatar" }));
}

#[test]
fn a_zone_disabled_mid_hover_drops_its_pose() {
    let (mut dnd, mut tree, pass) = mount_files_scene();
    let inner = center(&pass, "inner");
    dnd.file_hover_enter(Path::new("/tmp/cat.png"));
    dnd.file_hover_update(&mut tree, Some(&pass), Some(inner));
    assert_eq!(dnd.file_hover_zone(), Some("inner"));
    feed(
        &mut dnd,
        &mut tree,
        &[set_prop("inner", "__dnd.zoneEnabled", json!(false))],
    );
    dnd.file_hover_update(&mut tree, Some(&pass), None);
    assert_eq!(dnd.file_hover_zone(), Some("outer"));
    assert!(bg(&tree, "inner").is_none());
}

#[test]
fn file_drag_enter_fires_only_on_enabled_accept_matching_zones() {
    let (mut dnd, mut tree, pass) = mount_files_scene();
    let inner = center(&pass, "inner");
    // A pdf over the image-only zone: its `.onFileDragEnter` stays silent;
    // only the enclosing any-file zone (which lights `over`) fires.
    dnd.file_hover_enter(Path::new("/tmp/report.pdf"));
    dnd.file_hover_update(&mut tree, Some(&pass), Some(inner));
    assert_eq!(actions(&dnd.take_outcomes()), vec!["outerEnter"]);
    assert_eq!(dnd.file_hover_zone(), Some("outer"));
    dnd.file_hover_end(&mut tree);

    // A disabled zone carrying `.onFileDragEnter` never fires either.
    feed(
        &mut dnd,
        &mut tree,
        &[
            set_prop("off", "onFileDragEnter.0", json!("@offEnter")),
            set_prop("inner", "__dnd.zoneEnabled", json!(false)),
        ],
    );
    dnd.file_hover_enter(Path::new("/tmp/cat.png"));
    dnd.file_hover_update(&mut tree, Some(&pass), Some(center(&pass, "off")));
    assert!(dnd.take_outcomes().is_empty());
    dnd.file_hover_update(&mut tree, Some(&pass), Some(inner));
    assert_eq!(actions(&dnd.take_outcomes()), vec!["outerEnter"]);
}

/// The `.onFileDragEnter` envelope names the zone by the ENGINE's own node
/// id, so the engine that rendered the tree resolves it to the module's
/// handler (`ui_node_scope`: the id parses, exists, and is attached up to
/// the root). Real engine → real patches → the runtime → the engine's
/// router. Hosts that namespace ids (hypen-browser's `a<n>:` / `e<n>:`)
/// must strip their prefix before forwarding — see hypen-browser's
/// `embedded_file_drag_enter_envelope_resolves_in_the_owning_engine`.
#[test]
fn file_drag_enter_envelope_resolves_against_the_real_engine() {
    use hypen_engine::lifecycle::{Module, ModuleInstance};
    use std::sync::Mutex;
    let mut engine = hypen_engine::Engine::new();
    engine.set_module(ModuleInstance::new(Module::new("Files"), json!({})));
    engine.on_action("uploadFiles", |_| {});
    let collected: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = collected.clone();
    engine.set_render_callback(move |patches| {
        sink.lock().unwrap().extend(patches.iter().cloned());
    });
    let ast = hypen_parser::parse_component(
        r#"Column {
            Text("Header")
            Column { Text("Drop files") }
                .size(300, 200)
                .dropZone(group: "os-files", files: true)
                .onFileDragEnter(@actions.uploadFiles)
        }"#,
    )
    .expect("parse");
    engine.render_ir_node(&hypen_engine::ast_to_ir_node(&ast));
    let raw = std::mem::take(&mut *collected.lock().unwrap());
    let mut tree = Tree::new();
    let mut dnd = DesktopDnd::new();
    feed(
        &mut dnd,
        &mut tree,
        &hypen_engine::TemplateExpander::new().expand(raw),
    );
    let pass = layout(&tree);

    dnd.file_hover_enter(Path::new("/tmp/a.png"));
    dnd.file_hover_enter(Path::new("/tmp/b.pdf"));
    dnd.file_hover_update(&mut tree, Some(&pass), None);
    let mut sent = dnd.take_dispatches();
    assert_eq!(sent.len(), 1);
    // The window forwards this to the device host (pick → drop surface).
    assert!(dnd.take_file_drag_signal());
    assert!(!dnd.take_file_drag_signal(), "consumed");
    let zone = dnd.file_hover_zone().expect("over").to_string();

    // A host modal covers the app: the pose clears, nothing fires; once
    // it's gone the zone lights up and fires again.
    dnd.file_hover_suspend(&mut tree);
    assert!(dnd.file_hover_zone().is_none());
    assert!(dnd.is_file_hovering());
    dnd.file_hover_update(&mut tree, Some(&pass), None);
    assert_eq!(dnd.file_hover_zone(), Some(zone.as_str()));
    assert_eq!(dnd.take_dispatches().len(), 1);

    let d = sent.remove(0);
    let routed = engine
        .resolve_ui_action(hypen_engine::dispatch::Action::new(d.action).with_payload(d.payload))
        .expect("the zone id is a live engine node");
    assert_eq!(routed.name, "uploadFiles");
    let payload = routed.payload.expect("payload");
    assert_eq!(payload["type"], json!("filedragenter"));
    assert_eq!(payload["items"], json!(2));
}
