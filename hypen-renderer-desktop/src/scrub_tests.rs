//! Headless tests for [`DesktopScrubber`] (Option G scrub bindings).
//!
//! Mirrors the DOM reference suite (`hypen-web/tests/dom.scrub.test.ts`):
//! synthetic pointer/wheel calls drive the scrubber directly, the clock is
//! injected via `set_manual_time_ms` (the animator's deterministic-clock
//! pattern), and every deadline (settle, no-flash cleanup, scroll rest,
//! quiescence) is advanced by ticking at a chosen time. Pose interpolation is
//! read straight off the real [`Tree`] props the window paints from, and the
//! `__hypen_bind` settle write is asserted via the drained bind queue (the
//! completion-drain seam).

use super::*;
use crate::layout::LayoutPass;
use crate::text::TextEngine;
use crate::tree::{Tree, ROOT_ID};
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::collections::HashMap;
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
        id: id.to_string(),
        element_type: element_type.to_string(),
        props: Arc::new(map),
        semantics: None,
    }
}

fn insert(parent: &str, id: &str) -> Patch {
    Patch::Insert {
        parent_id: parent.to_string(),
        id: id.to_string(),
        before_id: None,
    }
}

fn set_prop(id: &str, name: &str, value: Value) -> Patch {
    Patch::SetProp {
        id: id.to_string(),
        name: name.to_string(),
        value,
    }
}

/// Route a batch through the scrubber's `pre_ingest` (registration +
/// deferral + cleanup) then apply the surviving patches to the tree — the
/// window's `pre_ingest` → `animator.ingest` order, minus the animator.
fn feed(scrubber: &mut DesktopScrubber, tree: &mut Tree, patches: &[Patch]) {
    let mut v = patches.to_vec();
    scrubber.pre_ingest(&mut v, tree);
    for p in &v {
        tree.apply(p);
    }
}

fn prop_f64(tree: &Tree, id: &str, name: &str) -> Option<f64> {
    tree.get(id)?.props.get(name)?.as_f64()
}

fn prop_str(tree: &Tree, id: &str, name: &str) -> Option<String> {
    Some(tree.get(id)?.props.get(name)?.as_str()?.to_string())
}

/// A bottom-sheet gesture scrub over the closed/open poses (DOM parity).
fn gesture_props(over: [i64; 2]) -> Vec<(&'static str, Value)> {
    vec![
        ("translateY.0", json!(400)),
        (
            "__anim.scrub",
            json!({
                "from": "closed", "to": "open", "source": "gesture",
                "axis": "y", "over": over, "rubberBand": 0.4,
            }),
        ),
        ("__anim.scrubSettle", json!({ "curve": "linear", "duration": 100 })),
        ("__anim.scrubBind", json!("sheetPhase")),
        (
            "__anim.scrubPoses",
            json!({
                "translateY.0": [400, 0],
                "opacity.0": [0.5, 1.0],
                "backgroundColor.0": ["#000000", "#ffffff"],
            }),
        ),
        ("__anim.states", json!({ "label": "closed" })),
    ]
}

fn new_scrubber() -> DesktopScrubber {
    let mut s = DesktopScrubber::new();
    s.set_reduced_motion(false); // never depend on the ambient env var
    s.set_manual_time_ms(0.0);
    s
}

/// Mount a scrub sheet under the root and return `(scrubber, tree)`.
fn mount_sheet(entries: Vec<(&'static str, Value)>) -> (DesktopScrubber, Tree) {
    let mut scrubber = new_scrubber();
    let mut tree = Tree::new();
    feed(
        &mut scrubber,
        &mut tree,
        &[create("sheet", "Column", entries), insert(ROOT_ID, "sheet")],
    );
    (scrubber, tree)
}

fn about(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

// ---------------------------------------------------------------------------
// Gesture drag interpolation
// ---------------------------------------------------------------------------

#[test]
fn drag_writes_interpolated_pose_props_for_every_scrubbed_key() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(400.0)); // base

    s.pointer_down_on("sheet", 0.0, 100.0);
    s.pointer_move(&mut tree, 0.0, 200.0); // travel 100 → p 0.25

    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(300.0));
    assert!(about(prop_f64(&tree, "sheet", "opacity.0").unwrap(), 0.625));
    // Core RGBA interpolation, desktop `#rrggbbaa` format: #000→#fff @0.25.
    assert_eq!(prop_str(&tree, "sheet", "backgroundColor.0").as_deref(), Some("#404040ff"));

    s.pointer_move(&mut tree, 0.0, 300.0); // p 0.5
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(200.0));
    assert!(about(prop_f64(&tree, "sheet", "opacity.0").unwrap(), 0.75));
    assert_eq!(prop_str(&tree, "sheet", "backgroundColor.0").as_deref(), Some("#808080ff"));
}

#[test]
fn over_is_directed_upward_travel_maps_to_forward_progress() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, -400]));
    s.pointer_down_on("sheet", 0.0, 500.0);
    s.pointer_move(&mut tree, 0.0, 300.0); // travel -200 → p 0.5
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(200.0));

    s.pointer_move(&mut tree, 0.0, 100.0); // travel -400 → p 1
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(0.0));

    // Wrong-direction travel is progress < 0 (rubber-banded):
    // raw -0.25 → p' -0.1 → translateY = 400 + (0-400)·(-0.1) = 440.
    s.pointer_move(&mut tree, 0.0, 600.0);
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(440.0));
}

#[test]
fn beyond_the_range_the_rubber_band_resists() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.pointer_down_on("sheet", 0.0, 0.0);
    s.pointer_move(&mut tree, 0.0, 500.0); // raw 1.25 → p' 1.1
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(-40.0));
    // Unit props clamp the interpolation RESULT, not progress.
    assert_eq!(prop_f64(&tree, "sheet", "opacity.0"), Some(1.0));
}

#[test]
fn zero_engine_traffic_during_the_drag() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.pointer_down_on("sheet", 0.0, 0.0);
    let mut y = 20.0;
    while y <= 300.0 {
        s.pointer_move(&mut tree, 0.0, y);
        y += 20.0;
    }
    assert!(s.take_binds().is_empty());
}

// ---------------------------------------------------------------------------
// Velocity-projected settle + bind write
// ---------------------------------------------------------------------------

#[test]
fn slow_release_below_the_midpoint_settles_to_from_and_writes_its_label() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.set_manual_time_ms(0.0);
    s.pointer_down_on("sheet", 0.0, 0.0);
    for i in 1..=5 {
        s.set_manual_time_ms((i * 10) as f64);
        s.pointer_move(&mut tree, 0.0, 120.0); // rest at p 0.3
    }
    s.set_manual_time_ms(50.0);
    s.pointer_up(&mut tree);
    assert!(s.take_binds().is_empty()); // settling, not arrived

    s.set_manual_time_ms(150.0);
    s.tick(&mut tree); // full settle duration
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(400.0));
    assert_eq!(
        s.take_binds(),
        vec![ScrubBind { path: "sheetPhase".into(), value: "closed".into() }]
    );
}

#[test]
fn fast_flick_at_p_0_3_projects_to_the_far_endpoint() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.set_manual_time_ms(0.0);
    s.pointer_down_on("sheet", 0.0, 0.0);
    s.set_manual_time_ms(10.0);
    s.pointer_move(&mut tree, 0.0, 120.0); // p 0.3 in 10ms → v 0.03/ms
    s.pointer_up(&mut tree); // p* = 0.3 + 0.03·150 = 4.8 → open

    s.set_manual_time_ms(60.0);
    s.tick(&mut tree); // linear settle halfway: 0.3 + 0.7·0.5 = 0.65
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(140.0));
    assert!(s.take_binds().is_empty()); // no write before arrival

    s.set_manual_time_ms(110.0);
    s.tick(&mut tree); // arrival
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(0.0));
    assert_eq!(prop_f64(&tree, "sheet", "opacity.0"), Some(1.0));
    assert_eq!(
        s.take_binds(),
        vec![ScrubBind { path: "sheetPhase".into(), value: "open".into() }]
    );
}

#[test]
fn projected_progress_of_exactly_0_5_settles_to_the_to_pose() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.set_manual_time_ms(0.0);
    s.pointer_down_on("sheet", 0.0, 0.0);
    for i in 1..=5 {
        s.set_manual_time_ms((i * 10) as f64);
        s.pointer_move(&mut tree, 0.0, 200.0); // rest at exactly p 0.5
    }
    s.pointer_up(&mut tree); // v = 0 → p* = 0.5 → to (>= contract)
    s.set_manual_time_ms(200.0);
    s.tick(&mut tree);
    assert_eq!(
        s.take_binds(),
        vec![ScrubBind { path: "sheetPhase".into(), value: "open".into() }]
    );
}

#[test]
fn drag_hold_release_discards_the_stale_burst_and_settles_nearest() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.set_manual_time_ms(0.0);
    s.pointer_down_on("sheet", 0.0, 0.0);
    s.set_manual_time_ms(10.0);
    s.pointer_move(&mut tree, 0.0, 120.0); // fast burst to p 0.3
    s.set_manual_time_ms(2000.0); // hold ~2s
    s.pointer_up(&mut tree);
    // Every sample older than the 100ms window → v = 0 → nearest (from).
    s.set_manual_time_ms(2100.0);
    s.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(400.0));
    assert_eq!(
        s.take_binds(),
        vec![ScrubBind { path: "sheetPhase".into(), value: "closed".into() }]
    );
}

// ---------------------------------------------------------------------------
// Post-settle cleanup (no-flash contract)
// ---------------------------------------------------------------------------

/// Flick open and settle to `open`, leaving the sheet in awaitingCleanup.
fn settle_to_open(s: &mut DesktopScrubber, tree: &mut Tree) {
    s.set_manual_time_ms(0.0);
    s.pointer_down_on("sheet", 0.0, 0.0);
    s.set_manual_time_ms(10.0);
    s.pointer_move(tree, 0.0, 120.0);
    s.pointer_up(tree);
    s.set_manual_time_ms(110.0);
    s.tick(tree);
    let _ = s.take_binds();
}

#[test]
fn matching_states_label_clears_scrub_props_and_applies_deferred_writes() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    settle_to_open(&mut s, &mut tree);
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(0.0)); // held

    // The engine's re-render: pose SetProps (deferred — scrub owns the node)
    // then the states label matching the winning pose.
    feed(
        &mut s,
        &mut tree,
        &[
            set_prop("sheet", "translateY.0", json!(0)),
            set_prop("sheet", "opacity.0", json!(1)),
            set_prop("sheet", "__anim.states", json!({ "label": "open" })),
        ],
    );

    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(0.0)); // deferred write
    assert_eq!(prop_f64(&tree, "sheet", "opacity.0"), Some(1.0));
    assert!(!s.owns_node("sheet"));
}

#[test]
fn any_states_label_during_awaiting_cleanup_cleans_up() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    settle_to_open(&mut s, &mut tree);

    // A raced NON-matching label still proves the re-render landed: cleanup
    // runs now (base restored, extras cleared) rather than holding stale
    // visuals for the timeout.
    feed(
        &mut s,
        &mut tree,
        &[set_prop("sheet", "__anim.states", json!({ "label": "peek" }))],
    );
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(400.0)); // restored base
    assert!(!tree.get("sheet").unwrap().props.contains_key("opacity.0"));
    assert!(!s.owns_node("sheet"));
}

#[test]
fn timeout_fallback_cleans_up_with_no_states_feed() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    settle_to_open(&mut s, &mut tree);
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(0.0)); // still held

    // No deferred transform write arrived; the captured base is restored and
    // the inline extras cleared when the 500ms fallback elapses.
    s.set_manual_time_ms(110.0 + 500.0 + 1.0);
    s.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(400.0));
    assert!(!tree.get("sheet").unwrap().props.contains_key("opacity.0"));
    assert!(!s.owns_node("sheet"));
}

// ---------------------------------------------------------------------------
// Engine-write conflicts (gesture wins)
// ---------------------------------------------------------------------------

#[test]
fn mid_drag_setprops_to_scrubbed_keys_defer_others_flow_applied_at_cleanup() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.pointer_down_on("sheet", 0.0, 0.0);
    s.pointer_move(&mut tree, 0.0, 200.0); // p 0.5
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(200.0));

    feed(
        &mut s,
        &mut tree,
        &[
            set_prop("sheet", "translateY.0", json!(123)), // scrubbed → deferred
            set_prop("sheet", "translateY.0", json!(77)),  // latest wins
            set_prop("sheet", "width.0", json!(55)),       // not scrubbed → flows
        ],
    );
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(200.0)); // drag owns it
    assert_eq!(prop_f64(&tree, "sheet", "width.0"), Some(55.0));

    // Release at rest (v = 0 at p 0.5 → projects to open), settle, then the
    // timeout fallback flushes the deferred write.
    for i in 1..=5 {
        s.set_manual_time_ms((i * 10) as f64);
        s.pointer_move(&mut tree, 0.0, 200.0);
    }
    s.pointer_up(&mut tree);
    s.set_manual_time_ms(200.0);
    s.tick(&mut tree);
    let _ = s.take_binds();
    s.set_manual_time_ms(200.0 + 500.0 + 1.0);
    s.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(77.0));
}

#[test]
fn a_scrub_active_node_is_excluded_from_transaction_application() {
    // Option G precedence (scrub > transaction): the animator, told the node
    // is scrub-active, snaps a batchAnimation-stamped prop instead of gliding.
    let (mut scrubber, mut tree) = mount_sheet(gesture_props([0, 400]));
    scrubber.pointer_down_on("sheet", 0.0, 0.0);
    scrubber.pointer_move(&mut tree, 0.0, 100.0); // claim
    assert!(scrubber.owns_node("sheet"));

    let mut animator = DesktopAnimator::new();
    animator.set_manual_time_ms(0.0);
    animator.set_reduced_motion(false, &mut tree);
    // Register a transition spec on the node, then sync scrub ownership.
    feed_animator(
        &mut animator,
        &mut tree,
        &[set_prop("sheet", "__anim.transition", json!({ "duration": 200, "curve": "linear" }))],
    );
    animator.set_scrub_active(scrubber.owned_ids());
    feed_animator(
        &mut animator,
        &mut tree,
        &[
            Patch::BatchAnimation { spec: json!({ "curve": "linear", "duration": 120 }) },
            set_prop("sheet", "width.0", json!(300)),
        ],
    );
    animator.set_manual_time_ms(60.0);
    animator.tick(&mut tree);
    // Snapped to the target immediately (no mid-glide value).
    assert_eq!(prop_f64(&tree, "sheet", "width.0"), Some(300.0));
    assert!(!animator.has_active(&tree));
}

fn feed_animator(animator: &mut DesktopAnimator, tree: &mut Tree, patches: &[Patch]) {
    animator.ingest(patches, tree);
}

// ---------------------------------------------------------------------------
// Relative drag anchoring
// ---------------------------------------------------------------------------

#[test]
fn a_second_drag_after_a_settle_anchors_at_the_settled_pose() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    settle_to_open(&mut s, &mut tree);
    feed(
        &mut s,
        &mut tree,
        &[set_prop("sheet", "__anim.states", json!({ "label": "open" }))],
    );
    assert!(!s.owns_node("sheet"));

    // Grabbing the OPEN sheet must not snap it closed: p = 1 + travel/span.
    s.set_manual_time_ms(200.0);
    s.pointer_down_on("sheet", 0.0, 400.0);
    s.pointer_move(&mut tree, 0.0, 350.0); // travel -50 → p 0.875
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(50.0));

    s.pointer_up(&mut tree);
    s.set_manual_time_ms(400.0);
    s.tick(&mut tree);
    assert_eq!(
        s.take_binds(),
        vec![ScrubBind { path: "sheetPhase".into(), value: "open".into() }]
    );
}

#[test]
fn a_grab_mid_settle_catches_at_live_progress_no_jump() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.set_manual_time_ms(0.0);
    s.pointer_down_on("sheet", 0.0, 0.0);
    s.set_manual_time_ms(10.0);
    s.pointer_move(&mut tree, 0.0, 120.0); // flick → open
    s.pointer_up(&mut tree);
    s.set_manual_time_ms(60.0);
    s.tick(&mut tree); // linear settle halfway: p = 0.65
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(140.0));

    // A settling element claims immediately (no slop wait); the settle stops
    // at its live progress.
    s.pointer_down_on("sheet", 0.0, 100.0);
    s.set_manual_time_ms(200.0);
    s.tick(&mut tree); // stray settle frames are inert
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(140.0)); // held
    assert!(s.take_binds().is_empty()); // interrupted settle never wrote

    s.pointer_move(&mut tree, 0.0, 60.0); // travel -40 → p 0.55
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(180.0));
}

#[test]
fn a_node_created_in_its_to_pose_drags_from_progress_1() {
    let mut props = gesture_props([0, 400]);
    // Replace the states label with the `to` pose.
    *props.last_mut().unwrap() = ("__anim.states", json!({ "label": "open" }));
    let (mut s, mut tree) = mount_sheet(props);

    s.pointer_down_on("sheet", 0.0, 200.0);
    s.pointer_move(&mut tree, 0.0, 100.0); // travel -100 → p 0.75
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(100.0));
}

#[test]
fn an_over_range_not_starting_at_zero_does_not_jump_at_drag_start() {
    let (mut s, mut tree) = mount_sheet(gesture_props([100, 500]));
    s.pointer_down_on("sheet", 0.0, 0.0);
    s.pointer_move(&mut tree, 0.0, 10.0); // travel 10 → p 10/400
    assert!(about(prop_f64(&tree, "sheet", "translateY.0").unwrap(), 390.0));
}

// ---------------------------------------------------------------------------
// Tap slop (gesture claim) + pass-through
// ---------------------------------------------------------------------------

#[test]
fn a_below_slop_tap_is_a_total_no_op_and_passes_through() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.pointer_down_on("sheet", 0.0, 100.0);
    s.pointer_move(&mut tree, 0.0, 103.0); // 3px < slop
    let up = s.pointer_up(&mut tree);

    assert_eq!(up, ScrubPointerUp::NoOp); // click passes through to children
    assert!(s.take_binds().is_empty());
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(400.0)); // untouched
    assert!(!s.owns_node("sheet"));

    // The gesture source still works afterwards.
    s.pointer_down_on("sheet", 0.0, 100.0);
    s.pointer_move(&mut tree, 0.0, 150.0);
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(350.0));
}

#[test]
fn travel_past_the_slop_claims_the_gesture() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.pointer_down_on("sheet", 0.0, 100.0);
    s.pointer_move(&mut tree, 0.0, 110.0); // 10px ≥ slop
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(390.0));
    assert!(s.owns_node("sheet"));
    let up = s.pointer_up(&mut tree);
    assert_eq!(up, ScrubPointerUp::Claimed);
}

#[test]
fn gesture_target_finds_the_scrub_node_by_bounds_through_the_real_layout() {
    // The real hit path: build a laid-out scene and confirm a press inside
    // the scrub node's bounds opens the drag (and a press outside does not).
    let mut s = new_scrubber();
    let mut tree = Tree::new();
    feed(
        &mut s,
        &mut tree,
        &[
            create("root0", "Column", vec![("width.0", json!(400)), ("height.0", json!(600))]),
            insert(ROOT_ID, "root0"),
            create(
                "sheet",
                "Column",
                {
                    let mut p = gesture_props([0, 400]);
                    // Give the node explicit bounds and a resting base pose so
                    // its rect sits under the press point.
                    p[0] = ("translateY.0", json!(0));
                    p.push(("width.0", json!(200)));
                    p.push(("height.0", json!(120)));
                    p
                },
            ),
            insert("root0", "sheet"),
        ],
    );
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    // Outside the sheet's rect: no drag opens.
    assert!(!s.pointer_down(&pass, 300.0, 400.0));
    // Inside: a drag opens.
    assert!(s.pointer_down(&pass, 10.0, 10.0));
    s.pointer_move(&mut tree, 0.0, 60.0); // claim
    assert!(s.owns_node("sheet"));
}

// ---------------------------------------------------------------------------
// Multi-pointer (single cursor on desktop)
// ---------------------------------------------------------------------------

#[test]
fn a_second_pointer_down_is_ignored_while_a_drag_owns_the_cursor() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.pointer_down_on("sheet", 0.0, 0.0);
    s.pointer_move(&mut tree, 0.0, 100.0); // p 0.25
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(300.0));

    // A second down while a drag is active is noise (one cursor).
    assert!(!s.pointer_down_on("sheet", 0.0, 999.0));
    s.pointer_move(&mut tree, 0.0, 200.0); // the FIRST drag continues
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(200.0));
}

// ---------------------------------------------------------------------------
// Mid-drag teardown + channel invalidation
// ---------------------------------------------------------------------------

#[test]
fn a_remove_mid_drag_cancels_everything() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.pointer_down_on("sheet", 0.0, 0.0);
    s.pointer_move(&mut tree, 0.0, 100.0);
    assert!(s.owns_node("sheet"));

    feed(&mut s, &mut tree, &[Patch::Remove { id: "sheet".into(), transition: false }]);
    assert!(!s.owns_node("sheet"));
    // Fully forgotten: a stray move is inert (no panic, no write).
    s.pointer_move(&mut tree, 0.0, 300.0);
    assert!(tree.get("sheet").is_none());
}

#[test]
fn a_detach_mid_drag_cancels_and_restores_the_nodes_props() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.pointer_down_on("sheet", 0.0, 0.0);
    s.pointer_move(&mut tree, 0.0, 100.0);
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(300.0));

    feed(&mut s, &mut tree, &[Patch::Detach { id: "sheet".into() }]);
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(400.0)); // base restored
    assert!(!s.owns_node("sheet"));
}

#[test]
fn removing_the_scrub_channel_mid_drag_runs_the_full_cleanup() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.pointer_down_on("sheet", 0.0, 0.0);
    s.pointer_move(&mut tree, 0.0, 200.0); // p 0.5
    feed(&mut s, &mut tree, &[set_prop("sheet", "translateY.0", json!(77))]); // deferred
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(200.0));

    feed(
        &mut s,
        &mut tree,
        &[Patch::RemoveProp { id: "sheet".into(), name: "__anim.scrub".into() }],
    );
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(77.0)); // deferred flushed
    assert!(!tree.get("sheet").unwrap().props.contains_key("opacity.0"));
    assert!(!s.owns_node("sheet"));

    // Fully disarmed: a stray move is inert.
    s.pointer_move(&mut tree, 0.0, 300.0);
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(77.0));
}

#[test]
fn focus_loss_mid_drag_settles_and_frees_the_grab_for_new_gestures() {
    // The winit analog of the DOM's `pointercancel`: the window forwards a
    // `Focused(false)` mid-drag to `pointer_up` (DOM parity — the DOM binds
    // pointercancel to its pointer-up settle). Regression guard for the
    // strand: without releasing the grab, `active_pointer` stays set and the
    // node holds its mid-drag pose forever (the ticker is not armed during a
    // drag, so nothing self-heals).
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.set_manual_time_ms(0.0);
    s.pointer_down_on("sheet", 0.0, 0.0);
    for i in 1..=5 {
        s.set_manual_time_ms((i * 10) as f64);
        s.pointer_move(&mut tree, 0.0, 200.0); // rest at p 0.5
    }
    assert!(s.owns_node("sheet"));

    // Focus loss → the window's forwarded pointer_up. A claimed drag settles.
    assert_eq!(s.pointer_up(&mut tree), ScrubPointerUp::Claimed);
    s.set_manual_time_ms(200.0);
    s.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(0.0)); // settled to `to`
    assert_eq!(
        s.take_binds(),
        vec![ScrubBind { path: "sheetPhase".into(), value: "open".into() }]
    );

    // The grab is freed: a brand-new gesture can start (a stranded
    // `active_pointer` would make this `pointer_down` a no-op).
    s.set_manual_time_ms(300.0);
    // Land the matching states label so the node returns fully to idle.
    feed(
        &mut s,
        &mut tree,
        &[set_prop("sheet", "__anim.states", json!({ "label": "open" }))],
    );
    assert!(!s.owns_node("sheet"));
    assert!(s.pointer_down_on("sheet", 0.0, 400.0));
}

#[test]
fn focus_loss_with_a_pending_below_slop_drag_is_a_noop_that_frees_the_grab() {
    // A pending (unclaimed) drag interrupted by focus loss is discarded with
    // no bind write, and the grab is freed so the next gesture works.
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.pointer_down_on("sheet", 0.0, 100.0);
    s.pointer_move(&mut tree, 0.0, 103.0); // 3px < slop → still pending
    assert_eq!(s.pointer_up(&mut tree), ScrubPointerUp::NoOp);
    assert!(s.take_binds().is_empty());
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(400.0)); // untouched
    assert!(!s.owns_node("sheet"));
    assert!(s.pointer_down_on("sheet", 0.0, 100.0)); // grab is free
}

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

#[test]
fn reduced_motion_drags_live_but_settles_instantly_and_writes() {
    let (mut s, mut tree) = mount_sheet(gesture_props([0, 400]));
    s.set_reduced_motion(true);

    // Direct manipulation is exempt — the drag tracks the finger.
    s.pointer_down_on("sheet", 0.0, 0.0);
    s.pointer_move(&mut tree, 0.0, 200.0);
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(200.0));

    // Release: NO settle animation — instant arrival at the target, then
    // write. (A no-flash cleanup window is still pending, so `has_active` is
    // true; the point is the pose is ALREADY at the target, not gliding.)
    s.pointer_up(&mut tree); // p 0.5 → to
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(0.0));
    s.set_manual_time_ms(50.0);
    s.tick(&mut tree); // no settle to advance — value stays put
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(0.0));
    assert_eq!(
        s.take_binds(),
        vec![ScrubBind { path: "sheetPhase".into(), value: "open".into() }]
    );
}

#[test]
fn motion_essential_release_settle_animates_under_reduced_motion() {
    let mut props = gesture_props([0, 400]);
    props.push(("__anim.motion", json!({ "essential": true })));
    let (mut s, mut tree) = mount_sheet(props);
    s.set_reduced_motion(true);

    s.set_manual_time_ms(0.0);
    s.pointer_down_on("sheet", 0.0, 0.0);
    s.pointer_move(&mut tree, 0.0, 200.0);

    s.pointer_up(&mut tree); // settle ANIMATES (essential exemption)
    assert!(s.has_active());
    assert!(s.take_binds().is_empty()); // not arrived yet

    s.set_manual_time_ms(50.0);
    s.tick(&mut tree);
    let mid = prop_f64(&tree, "sheet", "translateY.0").unwrap();
    assert!(mid != 200.0 && mid != 0.0); // between grab and target

    s.set_manual_time_ms(200.0);
    s.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(0.0));
    assert_eq!(
        s.take_binds(),
        vec![ScrubBind { path: "sheetPhase".into(), value: "open".into() }]
    );
}

// ---------------------------------------------------------------------------
// Base transform composition
// ---------------------------------------------------------------------------

#[test]
fn a_static_non_scrubbed_transform_prop_survives_the_drag() {
    let mut props = gesture_props([0, 400]);
    props.push(("rotate.0", json!(45)));
    let (mut s, mut tree) = mount_sheet(props);
    assert_eq!(prop_f64(&tree, "sheet", "rotate.0"), Some(45.0));

    s.pointer_down_on("sheet", 0.0, 0.0);
    s.pointer_move(&mut tree, 0.0, 100.0); // p 0.25
    // The scrub only owns translateY; the static rotation is a separate prop,
    // untouched (desktop composes transforms from real props, so no explicit
    // base-composition bookkeeping is needed).
    assert_eq!(prop_f64(&tree, "sheet", "translateY.0"), Some(300.0));
    assert_eq!(prop_f64(&tree, "sheet", "rotate.0"), Some(45.0));
}

// ---------------------------------------------------------------------------
// Scroll source
// ---------------------------------------------------------------------------

fn scroll_header_props(of: Option<&str>) -> Vec<(&'static str, Value)> {
    let mut scrub = json!({
        "from": "expanded", "to": "collapsed", "source": "scroll",
        "axis": "y", "over": [0, 120], "rubberBand": 0.4,
    });
    if let Some(of) = of {
        scrub.as_object_mut().unwrap().insert("of".into(), json!(of));
    }
    vec![
        ("height.0", json!(120)),
        ("__anim.scrub", scrub),
        ("__anim.scrubSettle", json!({ "curve": "linear", "duration": 100 })),
        ("__anim.scrubBind", json!("headerMode")),
        ("__anim.scrubPoses", json!({ "height.0": [120, 48] })),
        ("__anim.states", json!({ "label": "expanded" })),
    ]
}

/// Build a scrollable-container scene: root → scroller(scrollable) → header.
fn mount_scroll_scene(header_props: Vec<(&'static str, Value)>) -> (DesktopScrubber, Tree, LayoutPass) {
    let mut s = new_scrubber();
    let mut tree = Tree::new();
    feed(
        &mut s,
        &mut tree,
        &[
            create(
                "scroller",
                "Column",
                vec![
                    ("scrollable.0", json!(true)),
                    ("width.0", json!(300)),
                    ("height.0", json!(200)),
                ],
            ),
            insert(ROOT_ID, "scroller"),
            create("header", "Column", header_props),
            insert("scroller", "header"),
        ],
    );
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    (s, tree, pass)
}

#[test]
fn scroll_offset_maps_through_over_and_writes_only_after_resting_at_endpoint() {
    let (mut s, mut tree, pass) = mount_scroll_scene(scroll_header_props(None));
    let mut scrollables: HashMap<String, f32> = HashMap::new();

    scrollables.insert("scroller".into(), 60.0);
    assert!(s.on_scroll(&mut tree, &pass, &scrollables)); // p 0.5
    assert_eq!(prop_f64(&tree, "header", "height.0"), Some(84.0));

    scrollables.insert("scroller".into(), 120.0);
    s.set_manual_time_ms(10.0);
    s.on_scroll(&mut tree, &pass, &scrollables); // p 1
    assert_eq!(prop_f64(&tree, "header", "height.0"), Some(48.0));
    assert!(s.take_binds().is_empty()); // not yet rested

    s.set_manual_time_ms(200.0); // past the rest debounce
    s.tick(&mut tree);
    assert_eq!(
        s.take_binds(),
        vec![ScrubBind { path: "headerMode".into(), value: "collapsed".into() }]
    );
}

#[test]
fn leaving_the_endpoint_before_the_debounce_cancels_the_write() {
    let (mut s, mut tree, pass) = mount_scroll_scene(scroll_header_props(None));
    let mut scrollables: HashMap<String, f32> = HashMap::new();

    scrollables.insert("scroller".into(), 120.0);
    s.on_scroll(&mut tree, &pass, &scrollables); // at endpoint → debounce armed
    scrollables.insert("scroller".into(), 60.0);
    s.set_manual_time_ms(10.0);
    s.on_scroll(&mut tree, &pass, &scrollables); // back inside → debounce cancelled

    s.set_manual_time_ms(500.0);
    s.tick(&mut tree);
    assert!(s.take_binds().is_empty());
}

#[test]
fn of_matches_the_ancestor_whose_id_prop_equals_the_string() {
    // outer(id=lister) → inner(scrollable) → header(of: lister). The `of`
    // container must win over the nearer scrollable.
    let mut s = new_scrubber();
    let mut tree = Tree::new();
    feed(
        &mut s,
        &mut tree,
        &[
            create("outer", "Column", vec![("id", json!("lister")), ("scrollable.0", json!(true)), ("width.0", json!(300)), ("height.0", json!(200))]),
            insert(ROOT_ID, "outer"),
            create("inner", "Column", vec![("scrollable.0", json!(true)), ("width.0", json!(300)), ("height.0", json!(150))]),
            insert("outer", "inner"),
            create("header", "Column", scroll_header_props(Some("lister"))),
            insert("inner", "header"),
        ],
    );
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let mut scrollables: HashMap<String, f32> = HashMap::new();

    scrollables.insert("outer".into(), 60.0);
    scrollables.insert("inner".into(), 120.0); // the nearer scroller — must NOT win
    s.on_scroll(&mut tree, &pass, &scrollables);
    assert_eq!(prop_f64(&tree, "header", "height.0"), Some(84.0)); // read outer=60 → p 0.5
}

#[test]
fn scroll_quiescence_flushes_deferred_and_releases_ownership() {
    let (mut s, mut tree, pass) = mount_scroll_scene(scroll_header_props(None));
    let mut scrollables: HashMap<String, f32> = HashMap::new();

    s.set_manual_time_ms(0.0);
    scrollables.insert("scroller".into(), 60.0);
    s.on_scroll(&mut tree, &pass, &scrollables); // p 0.5
    assert_eq!(prop_f64(&tree, "header", "height.0"), Some(84.0));

    // Engine write to a scrubbed key while input is live → deferred.
    feed(&mut s, &mut tree, &[set_prop("header", "height.0", json!(100))]);
    assert_eq!(prop_f64(&tree, "header", "height.0"), Some(84.0));
    assert!(s.owns_node("header"));

    // Scroll quiescence: after the debounce with no new event, the deferred
    // write is conceded and ownership releases.
    s.set_manual_time_ms(200.0);
    s.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "header", "height.0"), Some(100.0));
    assert!(!s.owns_node("header"));
}

#[test]
fn a_detached_route_stops_scrubbing_via_the_persistent_scroller() {
    // root → scroller(persistent) → route → header(scroll scrub). Detaching
    // the route severs the parent chain, so the header can no longer resolve
    // the scroller and goes inert (never writes into the inactive module).
    let mut s = new_scrubber();
    let mut tree = Tree::new();
    feed(
        &mut s,
        &mut tree,
        &[
            create("scroller", "Column", vec![("scrollable.0", json!(true)), ("width.0", json!(300)), ("height.0", json!(200))]),
            insert(ROOT_ID, "scroller"),
            create("route", "Column", vec![]),
            insert("scroller", "route"),
            create("header", "Column", scroll_header_props(None)),
            insert("route", "header"),
        ],
    );
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let mut scrollables: HashMap<String, f32> = HashMap::new();

    scrollables.insert("scroller".into(), 60.0);
    s.on_scroll(&mut tree, &pass, &scrollables);
    assert_eq!(prop_f64(&tree, "header", "height.0"), Some(84.0));

    // The detach names only the route ROOT — the descendant header's scroll
    // source must stop too (its entry survives for a re-attach).
    feed(&mut s, &mut tree, &[Patch::Detach { id: "route".into() }]);
    assert_eq!(prop_f64(&tree, "header", "height.0"), Some(120.0)); // restored

    scrollables.insert("scroller".into(), 120.0);
    s.set_manual_time_ms(300.0);
    s.on_scroll(&mut tree, &pass, &scrollables); // off-document: inert
    s.tick(&mut tree);
    assert!(s.take_binds().is_empty()); // no write into the inactive module
}
