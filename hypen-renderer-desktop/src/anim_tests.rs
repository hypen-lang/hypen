//! Tests for `crate::anim`. Lives in its own file via `#[path]` so
//! `anim.rs` stays focused on the runtime.
//!
//! All tests are headless: they drive a [`DesktopAnimator`] with the
//! injectable manual clock against a plain renderer [`Tree`] (the same
//! pattern `layout_tests.rs` uses to drive layout without a window), and
//! the geometry-follows-animation tests run a real `LayoutPass` over the
//! ticked tree.

use super::*;
use crate::tree::{Tree, ROOT_ID};
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::sync::Arc;

fn props(entries: &[(&str, Value)]) -> Arc<IndexMap<String, Value>> {
    let mut map = IndexMap::new();
    for (k, v) in entries {
        map.insert((*k).to_string(), v.clone());
    }
    Arc::new(map)
}

fn create(id: &str, element_type: &str, entries: &[(&str, Value)]) -> Patch {
    Patch::Create {
        id: id.to_string(),
        element_type: element_type.to_string(),
        props: props(entries),
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

fn remove(id: &str, transition: bool) -> Patch {
    Patch::Remove {
        id: id.to_string(),
        transition,
    }
}

/// Fresh animator at manual time 0 with the first batch already flushed
/// (so enters are no longer first-batch-suppressed), holding one Column
/// node `"col"` under the root.
fn armed() -> (DesktopAnimator, Tree) {
    let mut animator = DesktopAnimator::new();
    // Tests must not depend on the ambient environment.
    animator.reduced_motion = false;
    animator.set_manual_time_ms(0.0);
    let mut tree = Tree::new();
    let batch = vec![create("col", "Column", &[]), insert(ROOT_ID, "col")];
    animator.ingest(&batch, &mut tree);
    (animator, tree)
}

fn prop_f64(tree: &Tree, id: &str, name: &str) -> Option<f64> {
    tree.get(id)?.props.get(name)?.as_f64()
}

fn prop_str(tree: &Tree, id: &str, name: &str) -> Option<String> {
    Some(tree.get(id)?.props.get(name)?.as_str()?.to_string())
}

// ---------------------------------------------------------------
// Curve solver (pinned against the shipped control points)
// ---------------------------------------------------------------

#[test]
fn easing_endpoints_are_exact() {
    for curve in ["linear", "easeIn", "easeOut", "easeInOut", "spring"] {
        let e = curve_easing(curve);
        assert_eq!(e.eval(0.0), 0.0, "{curve} f(0)");
        assert_eq!(e.eval(1.0), 1.0, "{curve} f(1)");
        assert_eq!(e.eval(-0.5), 0.0, "{curve} clamps below");
        assert_eq!(e.eval(1.5), 1.0, "{curve} clamps above");
    }
}

#[test]
fn ease_out_midpoint_matches_css_bezier() {
    // cubic-bezier(0, 0, 0.58, 1) at x = 0.5 ≈ 0.6828 (CSS ease-out).
    let v = curve_easing("easeOut").eval(0.5);
    assert!((v - 0.6828).abs() < 0.01, "easeOut(0.5) = {v}");
    // ease-in is its mirror: easeIn(0.5) ≈ 1 - 0.6828.
    let v_in = curve_easing("easeIn").eval(0.5);
    assert!((v_in - (1.0 - 0.6828)).abs() < 0.01, "easeIn(0.5) = {v_in}");
}

#[test]
fn spring_overshoots_past_one_mid_range() {
    // cubic-bezier(0.34, 1.56, 0.64, 1): y exceeds 1 in the back half.
    let e = curve_easing("spring");
    let max = (1..100)
        .map(|i| e.eval(i as f64 / 100.0))
        .fold(f64::MIN, f64::max);
    assert!(max > 1.05, "spring must overshoot, max eased = {max}");
}

#[test]
fn unknown_curve_degrades_to_linear() {
    assert_eq!(curve_easing("bounce").eval(0.25), 0.25);
}

// ---------------------------------------------------------------
// .transition — midpoint, settle, retarget
// ---------------------------------------------------------------

fn transition_spec(duration: u64, curve: &str) -> Value {
    json!({ "duration": duration, "curve": curve })
}

#[test]
fn transition_interpolates_midpoint_and_settles_exactly() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "box",
                "Container",
                &[
                    ("width.0", json!(100.0)),
                    ("__anim.transition", transition_spec(200, "linear")),
                ],
            ),
            insert("col", "box"),
        ],
        &mut tree,
    );
    // Retarget width 100 → 200 in a later batch.
    animator.ingest(&[set_prop("box", "width.0", json!(200.0))], &mut tree);
    // The rewind keeps the previous value in the tree until the first tick.
    assert_eq!(prop_f64(&tree, "box", "width.0"), Some(100.0));

    animator.set_manual_time_ms(100.0);
    let out = animator.tick(&mut tree);
    assert!(out.wrote);
    let mid = prop_f64(&tree, "box", "width.0").unwrap();
    assert!((mid - 150.0).abs() < 1e-6, "linear midpoint, got {mid}");

    animator.set_manual_time_ms(200.0);
    animator.tick(&mut tree);
    // Settle writes the EXACT raw target, not an interpolated epsilon.
    assert_eq!(prop_f64(&tree, "box", "width.0"), Some(200.0));
    assert!(!animator.has_active(&tree), "settled → stands down");
}

#[test]
fn transition_retargets_from_current_interpolated_value() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "box",
                "Container",
                &[
                    ("width.0", json!(0.0)),
                    ("__anim.transition", transition_spec(100, "linear")),
                ],
            ),
            insert("col", "box"),
        ],
        &mut tree,
    );
    animator.ingest(&[set_prop("box", "width.0", json!(100.0))], &mut tree);
    animator.set_manual_time_ms(50.0);
    animator.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "box", "width.0"), Some(50.0));

    // Mid-flight retarget to 0: the new animation starts from the last
    // interpolated value (50), not the original target.
    animator.ingest(&[set_prop("box", "width.0", json!(0.0))], &mut tree);
    assert_eq!(prop_f64(&tree, "box", "width.0"), Some(50.0));
    animator.set_manual_time_ms(100.0); // halfway through the new 100ms run
    animator.tick(&mut tree);
    let v = prop_f64(&tree, "box", "width.0").unwrap();
    assert!((v - 25.0).abs() < 1e-6, "50 → 0 at half: {v}");
    animator.set_manual_time_ms(150.0);
    animator.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "box", "width.0"), Some(0.0));
}

#[test]
fn transition_interpolates_colors_in_rgba_hex() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "box",
                "Container",
                &[
                    ("backgroundColor", json!("#000000")),
                    ("__anim.transition", transition_spec(100, "linear")),
                ],
            ),
            insert("col", "box"),
        ],
        &mut tree,
    );
    animator.ingest(
        &[set_prop("box", "backgroundColor", json!("#ffffff"))],
        &mut tree,
    );
    animator.set_manual_time_ms(50.0);
    animator.tick(&mut tree);
    let mid = prop_str(&tree, "box", "backgroundColor").unwrap();
    // 0 → 255 midpoint rounds to 0x80 (127.5 → 128); the format is the
    // desktop parser's own #rrggbbaa so paint can consume every frame.
    assert_eq!(mid, "#808080ff");
    assert!(crate::style::parse_color(&mid).is_some());
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    // Settle restores the engine's exact raw value.
    assert_eq!(prop_str(&tree, "box", "backgroundColor").unwrap(), "#ffffff");
}

#[test]
fn transform_props_transition_on_desktop() {
    // The Vello painter now composes per-item transforms (and every
    // hit path reads them), so translateX/translateY/scale/rotate
    // interpolate honestly instead of snapping.
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "box",
                "Container",
                &[
                    ("translateX", json!(0.0)),
                    ("rotate", json!(0.0)),
                    ("__anim.transition", transition_spec(200, "linear")),
                ],
            ),
            insert("col", "box"),
        ],
        &mut tree,
    );
    animator.ingest(
        &[
            set_prop("box", "translateX", json!(50.0)),
            set_prop("box", "rotate", json!(90.0)),
        ],
        &mut tree,
    );
    assert!(animator.has_active(&tree), "transform transition in flight");
    // First paint still shows the previous pose (rewound).
    assert_eq!(prop_f64(&tree, "box", "translateX"), Some(0.0));
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "box", "translateX"), Some(25.0));
    assert_eq!(prop_f64(&tree, "box", "rotate"), Some(45.0));
    animator.set_manual_time_ms(200.0);
    animator.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "box", "translateX"), Some(50.0));
    assert_eq!(prop_f64(&tree, "box", "rotate"), Some(90.0));
    assert!(!animator.has_active(&tree));
}

#[test]
fn scoped_props_filter_limits_the_transition() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "box",
                "Container",
                &[
                    ("width.0", json!(0.0)),
                    ("height.0", json!(0.0)),
                    (
                        "__anim.transition",
                        json!({ "duration": 100, "curve": "linear", "props": ["width"] }),
                    ),
                ],
            ),
            insert("col", "box"),
        ],
        &mut tree,
    );
    animator.ingest(
        &[
            set_prop("box", "width.0", json!(100.0)),
            set_prop("box", "height.0", json!(100.0)),
        ],
        &mut tree,
    );
    // width glides (rewound to 0); height snapped (outside the scope).
    assert_eq!(prop_f64(&tree, "box", "width.0"), Some(0.0));
    assert_eq!(prop_f64(&tree, "box", "height.0"), Some(100.0));
}

#[test]
fn same_batch_created_node_never_transitions() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "box",
                "Container",
                &[
                    ("width.0", json!(0.0)),
                    ("__anim.transition", transition_spec(100, "linear")),
                ],
            ),
            insert("col", "box"),
            // Same-batch SetProp on the fresh node: snaps (no previous
            // computed value exists before first paint — DOM parity).
            set_prop("box", "width.0", json!(100.0)),
        ],
        &mut tree,
    );
    assert_eq!(prop_f64(&tree, "box", "width.0"), Some(100.0));
    assert!(!animator.has_active(&tree));
}

// ---------------------------------------------------------------
// Epoch/Taffy contract: layout-affecting animation restyles + re-solves
// ---------------------------------------------------------------

#[test]
fn layout_affecting_animation_reports_restyle_and_moves_real_geometry() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "box",
                "Container",
                &[
                    ("width.0", json!(100.0)),
                    ("height.0", json!(50.0)),
                    ("__anim.transition", transition_spec(200, "linear")),
                ],
            ),
            insert("col", "box"),
        ],
        &mut tree,
    );
    animator.ingest(&[set_prop("box", "width.0", json!(300.0))], &mut tree);
    animator.set_manual_time_ms(100.0);
    let out = animator.tick(&mut tree);
    // The tick reports the node for a Taffy restyle (the window bumps
    // the patch epoch and restyles exactly these ids).
    assert!(out.wrote);
    assert!(out.restyle.contains(&"box".to_string()), "restyle: {:?}", out.restyle);

    // And the REAL layout geometry follows: a fresh LayoutPass over the
    // ticked tree solves the interpolated width, so hit-testing tracks
    // the animated box, not the target.
    let mut text = crate::text::TextEngine::new();
    let pass = crate::layout::LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = pass
        .items
        .iter()
        .find(|it| it.node_id == "box")
        .expect("box item");
    assert!(
        (item.rect.w - 200.0).abs() < 1.0,
        "midpoint width must reach Taffy, got {}",
        item.rect.w
    );

    // Color-only animation writes but needs no restyle.
    let (mut animator2, mut tree2) = armed();
    animator2.ingest(
        &[
            create(
                "box2",
                "Container",
                &[
                    ("backgroundColor", json!("#000000")),
                    ("__anim.transition", transition_spec(100, "linear")),
                ],
            ),
            insert("col", "box2"),
        ],
        &mut tree2,
    );
    animator2.ingest(
        &[set_prop("box2", "backgroundColor", json!("#ffffff"))],
        &mut tree2,
    );
    animator2.set_manual_time_ms(50.0);
    let out2 = animator2.tick(&mut tree2);
    assert!(out2.wrote);
    assert!(out2.restyle.is_empty(), "colors are paint-only: {:?}", out2.restyle);
}

// ---------------------------------------------------------------
// .enter — first-batch suppression, fade playback, attach exemption
// ---------------------------------------------------------------

fn enter_fade(duration: u64) -> Value {
    json!({ "presets": ["fade"], "duration": duration, "curve": "linear" })
}

#[test]
fn enter_suppressed_on_first_batch_then_plays() {
    let mut animator = DesktopAnimator::new();
    animator.reduced_motion = false;
    animator.set_manual_time_ms(0.0);
    let mut tree = Tree::new();
    // FIRST-EVER batch: enter must not play (no initial-render cascade).
    animator.ingest(
        &[
            create("col", "Column", &[]),
            insert(ROOT_ID, "col"),
            create("a", "Text", &[("0", json!("hi")), ("__anim.enter", enter_fade(100))]),
            insert("col", "a"),
        ],
        &mut tree,
    );
    assert!(!tree.get("a").unwrap().props.contains_key("opacity"));
    assert!(!animator.has_active(&tree), "first batch: nothing plays");

    // Second batch: the enter plays — hidden pose (opacity 0) lands
    // immediately so the batch's first paint shows it.
    animator.ingest(
        &[
            create("b", "Text", &[("0", json!("yo")), ("__anim.enter", enter_fade(100))]),
            insert("col", "b"),
        ],
        &mut tree,
    );
    assert_eq!(prop_f64(&tree, "b", "opacity"), Some(0.0));
    assert!(animator.has_active(&tree));

    animator.set_manual_time_ms(50.0);
    animator.tick(&mut tree);
    let mid = prop_f64(&tree, "b", "opacity").unwrap();
    assert!((mid - 0.5).abs() < 1e-6, "fade midpoint, got {mid}");

    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    // Settle restores the original prop exactly — absent before, absent
    // after (the node is fully opaque again by default).
    assert!(!tree.get("b").unwrap().props.contains_key("opacity"));
    assert!(!animator.has_active(&tree));
}

#[test]
fn attach_never_enter_animates() {
    let (mut animator, mut tree) = armed();
    // Create + insert in one batch: plays. Then detach and re-attach:
    // the Attach path must NOT replay the enter.
    animator.ingest(
        &[
            create("a", "Text", &[("__anim.enter", enter_fade(100))]),
            insert("col", "a"),
        ],
        &mut tree,
    );
    animator.set_manual_time_ms(200.0);
    animator.tick(&mut tree); // settle the real enter
    animator.ingest(&[Patch::Detach { id: "a".into() }], &mut tree);
    animator.ingest(
        &[Patch::Attach {
            parent_id: "col".into(),
            id: "a".into(),
            before_id: None,
        }],
        &mut tree,
    );
    assert!(
        !tree.get("a").unwrap().props.contains_key("opacity"),
        "attach must not restart the enter"
    );
    assert!(!animator.has_active(&tree));
}

#[test]
fn slide_only_enter_plays_translate_x() {
    // Slide is paintable now (per-item transforms): default direction
    // `leading` in LTR hides at translateX = -24 and glides to base.
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "a",
                "Text",
                &[(
                    "__anim.enter",
                    json!({ "presets": ["slide"], "duration": 100, "curve": "linear" }),
                )],
            ),
            insert("col", "a"),
        ],
        &mut tree,
    );
    // Hidden pose lands at flush so the first paint shows it.
    assert_eq!(prop_f64(&tree, "a", "translateX"), Some(-SLIDE_OFFSET_PX));
    assert!(animator.has_active(&tree));
    animator.set_manual_time_ms(50.0);
    animator.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "a", "translateX"), Some(-SLIDE_OFFSET_PX / 2.0));
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    // Settle restores the pre-playback prop exactly (absent here).
    assert!(!tree.get("a").unwrap().props.contains_key("translateX"));
    assert!(!animator.has_active(&tree));
}

#[test]
fn slide_direction_and_rtl_flip_the_axis() {
    // `from: top` slides on translateY; `trailing` under an RTL
    // ancestor flips sign (canvas `slideAxis` parity).
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "t",
                "Text",
                &[(
                    "__anim.enter",
                    json!({ "presets": ["slide"], "duration": 100, "curve": "linear", "from": "top" }),
                )],
            ),
            insert("col", "t"),
            create("rtl-wrap", "Column", &[("dir", json!("rtl"))]),
            insert("col", "rtl-wrap"),
            create(
                "r",
                "Text",
                &[(
                    "__anim.enter",
                    json!({ "presets": ["slide"], "duration": 100, "curve": "linear", "from": "trailing" }),
                )],
            ),
            insert("rtl-wrap", "r"),
        ],
        &mut tree,
    );
    assert_eq!(prop_f64(&tree, "t", "translateY"), Some(-SLIDE_OFFSET_PX));
    assert!(!tree.get("t").unwrap().props.contains_key("translateX"));
    // trailing in RTL = -SLIDE_OFFSET_PX (mirrored).
    assert_eq!(prop_f64(&tree, "r", "translateX"), Some(-SLIDE_OFFSET_PX));
}

#[test]
fn scale_enter_hides_at_ninety_five_percent() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "s",
                "Text",
                &[(
                    "__anim.enter",
                    json!({ "presets": ["scale"], "duration": 100, "curve": "linear" }),
                )],
            ),
            insert("col", "s"),
        ],
        &mut tree,
    );
    assert_eq!(prop_f64(&tree, "s", "scale"), Some(SCALE_HIDDEN_FACTOR));
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    assert!(!tree.get("s").unwrap().props.contains_key("scale"));
}

// ---------------------------------------------------------------
// .exit — deferral, hit-test exclusion, settle + overdue finalize,
// descendant deferral
// ---------------------------------------------------------------

fn exit_fade(duration: u64) -> Value {
    json!({ "presets": ["fade"], "duration": duration, "curve": "linear" })
}

/// Build an exiting card with one child under `col`. Returns after the
/// flagged remove was ingested.
fn exiting_card(animator: &mut DesktopAnimator, tree: &mut Tree) {
    animator.ingest(
        &[
            create("card", "Container", &[("__anim.exit", exit_fade(150))]),
            insert("col", "card"),
            create("label", "Text", &[("0", json!("bye"))]),
            insert("card", "label"),
        ],
        tree,
    );
    // Flagged root FIRST, then the descendant as a plain Remove — the
    // wire ordering contract.
    let forwarded = animator
        .ingest(&[remove("card", true), remove("label", false)], tree)
        .forwarded;
    assert!(
        forwarded.is_empty(),
        "both removes must be withheld while the exit plays: {forwarded:?}"
    );
}

#[test]
fn flagged_remove_defers_teardown_and_excludes_hit_testing() {
    let (mut animator, mut tree) = armed();
    exiting_card(&mut animator, &mut tree);

    // Subtree still alive (painted) …
    assert!(tree.get("card").is_some());
    assert!(tree.get("label").is_some());
    // … but excluded from hit-testing immediately, root and descendant.
    assert!(animator.is_exit_excluded(&tree, "card"));
    assert!(animator.is_exit_excluded(&tree, "label"));
    assert!(!animator.is_exit_excluded(&tree, "col"));

    // The fade is playing.
    animator.set_manual_time_ms(75.0);
    animator.tick(&mut tree);
    let mid = prop_f64(&tree, "card", "opacity").unwrap();
    assert!((mid - 0.5).abs() < 1e-6, "exit fade midpoint, got {mid}");

    // Settle: teardown finalizes, removal patches surface for Taffy.
    animator.set_manual_time_ms(150.0);
    let out = animator.tick(&mut tree);
    assert_eq!(out.finalized.len(), 2, "root + descendant: {:?}", out.finalized);
    assert!(tree.get("card").is_none());
    assert!(tree.get("label").is_none());
    assert!(!animator.has_active(&tree), "ticker stands down after finalize");
    assert!(!animator.is_exit_excluded(&tree, "card"));
}

#[test]
fn overdue_backbone_finalizes_a_stalled_exit() {
    let (mut animator, mut tree) = armed();
    exiting_card(&mut animator, &mut tree);

    // The ticker never runs (occluded window). Before the grace window
    // elapses nothing happens…
    animator.set_manual_time_ms(150.0 + EXIT_SETTLE_GRACE_MS - 1.0);
    assert!(animator.finalize_overdue(&mut tree).is_empty());
    assert!(tree.get("card").is_some());
    // …past duration + delay + 80ms the flush-path backbone tears down.
    animator.set_manual_time_ms(150.0 + EXIT_SETTLE_GRACE_MS);
    let finalized = animator.finalize_overdue(&mut tree);
    assert_eq!(finalized.len(), 2);
    assert!(tree.get("card").is_none());
    assert!(tree.get("label").is_none());
}

#[test]
fn slide_only_exit_defers_and_animates_translate() {
    // Slide paints now: a slide-only exit DEFERS teardown and glides
    // translateX from base toward the hidden offset, finalizing on
    // settle — no more all-unpaintable snap for engine presets.
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "card",
                "Container",
                &[(
                    "__anim.exit",
                    json!({ "presets": ["slide"], "duration": 150, "curve": "linear" }),
                )],
            ),
            insert("col", "card"),
        ],
        &mut tree,
    );
    let forwarded = animator.ingest(&[remove("card", true)], &mut tree).forwarded;
    assert!(forwarded.is_empty(), "flagged remove withheld for the exit");
    assert!(tree.get("card").is_some(), "corpse still painted mid-exit");
    assert!(animator.is_exit_excluded(&tree, "card"));
    animator.set_manual_time_ms(75.0);
    animator.tick(&mut tree);
    assert_eq!(
        prop_f64(&tree, "card", "translateX"),
        Some(-SLIDE_OFFSET_PX / 2.0),
        "exit slides toward the leading hidden offset"
    );
    animator.set_manual_time_ms(150.0);
    let out = animator.tick(&mut tree);
    assert_eq!(out.finalized.len(), 1);
    assert!(tree.get("card").is_none());
}

#[test]
fn create_for_exiting_id_finalizes_the_corpse_first() {
    let (mut animator, mut tree) = armed();
    exiting_card(&mut animator, &mut tree);
    // A new node under the same id arrives while the exit plays: the
    // old subtree finalizes immediately so the corpse can't shadow it.
    let forwarded = animator
        .ingest(
            &[create("card", "Container", &[]), insert("col", "card")],
            &mut tree,
        )
        .forwarded;
    // Finalized removals surface BEFORE the create in the forwarded
    // stream so the Taffy mirror tears down before re-creating.
    assert!(matches!(forwarded[0], Patch::Remove { .. }));
    assert!(tree.get("card").is_some());
    assert!(!animator.is_exit_excluded(&tree, "card"));
    assert!(tree.get("label").is_none(), "old descendant went with the corpse");
}

// ---------------------------------------------------------------
// .animate presets
// ---------------------------------------------------------------

#[test]
fn pulse_loop_advances_and_keeps_ticker_armed() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "dot",
                "Container",
                &[(
                    "__anim.animate",
                    json!({ "preset": "pulse", "duration": 1000, "repeat": "loop", "curve": "linear" }),
                )],
            ),
            insert("col", "dot"),
        ],
        &mut tree,
    );
    assert!(animator.has_active(&tree), "looping ambient keeps frames coming");
    // Pulse keyframes: opacity 1 → 0.5 → 1; at 1/4 duration the linear
    // curve puts us halfway down the first leg (0.75).
    animator.set_manual_time_ms(250.0);
    animator.tick(&mut tree);
    let v = prop_f64(&tree, "dot", "opacity").unwrap();
    assert!((v - 0.75).abs() < 1e-6, "pulse @250ms of 1000ms, got {v}");
    // Trough at half duration.
    animator.set_manual_time_ms(500.0);
    animator.tick(&mut tree);
    assert!((prop_f64(&tree, "dot", "opacity").unwrap() - 0.5).abs() < 1e-6);
    // Loops: iteration 3, same phase as 250ms.
    animator.set_manual_time_ms(3250.0);
    animator.tick(&mut tree);
    assert!((prop_f64(&tree, "dot", "opacity").unwrap() - 0.75).abs() < 1e-6);
    assert!(animator.has_active(&tree), "loop never exhausts");
}

#[test]
fn finite_preset_completes_restores_and_never_replays() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "dot",
                "Container",
                &[
                    ("opacity", json!(0.8)),
                    (
                        "__anim.animate",
                        json!({ "preset": "pulse", "duration": 100, "repeat": 2, "curve": "linear" }),
                    ),
                ],
            ),
            insert("col", "dot"),
        ],
        &mut tree,
    );
    animator.set_manual_time_ms(50.0);
    animator.tick(&mut tree);
    // Base opacity 0.8 scales the pulse trough: 0.8 * 0.5.
    assert!((prop_f64(&tree, "dot", "opacity").unwrap() - 0.4).abs() < 1e-6);
    // Two iterations exhaust at 200ms: original restored, stands down.
    animator.set_manual_time_ms(200.0);
    animator.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "dot", "opacity"), Some(0.8));
    assert!(!animator.has_active(&tree), "finite preset stands down");
    // Reduced-motion off-toggle (a restart trigger elsewhere) never
    // replays an exhausted finite preset.
    animator.set_reduced_motion(true, &mut tree);
    animator.set_reduced_motion(false, &mut tree);
    assert!(!animator.has_active(&tree), "exhausted preset must not replay");
}

#[test]
fn spin_and_shake_play_shimmer_stays_a_noop() {
    let (mut animator, mut tree) = armed();
    for (id, preset) in [("s1", "spin"), ("s2", "shimmer"), ("s3", "shake")] {
        animator.ingest(
            &[
                create(
                    id,
                    "Container",
                    &[(
                        "__anim.animate",
                        json!({ "preset": preset, "duration": 800, "repeat": "loop", "curve": "linear" }),
                    )],
                ),
                insert("col", id),
            ],
            &mut tree,
        );
    }
    // spin + shake own transform props now; shimmer (DOM gradient
    // overlay, no desktop equivalent) never starts.
    assert!(animator.has_active(&tree), "spin/shake keep the ticker armed");
    animator.set_manual_time_ms(400.0);
    animator.tick(&mut tree);
    // spin: rotate = 360 × eased(0.5) = 180 under linear.
    assert_eq!(prop_f64(&tree, "s1", "rotate"), Some(180.0));
    // shake at p = 0.5: midway between the 0.4 (+6) and 0.6 (−4) stops = +1.
    assert_eq!(prop_f64(&tree, "s3", "translateX"), Some(1.0));
    assert!(!tree.get("s2").unwrap().props.keys().any(|k| k != "__anim.animate"));
    // spin advances frame over frame (0.25 → rotate 90).
    animator.set_manual_time_ms(1000.0);
    animator.tick(&mut tree);
    assert_eq!(
        prop_f64(&tree, "s1", "rotate"),
        Some(90.0),
        "loop iteration 2 at p = 0.25"
    );
}

#[test]
fn detached_subtree_holds_its_ambient() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "dot",
                "Container",
                &[(
                    "__anim.animate",
                    json!({ "preset": "pulse", "duration": 1000, "repeat": "loop", "curve": "linear" }),
                )],
            ),
            insert("col", "dot"),
        ],
        &mut tree,
    );
    assert!(animator.has_active(&tree));
    // Router cache detach: not painted → not ticked → no runaway frames.
    animator.ingest(&[Patch::Detach { id: "dot".into() }], &mut tree);
    assert!(!animator.has_active(&tree), "detached ambient must stand down");
    // Re-attach resumes.
    animator.ingest(
        &[Patch::Attach {
            parent_id: "col".into(),
            id: "dot".into(),
            before_id: None,
        }],
        &mut tree,
    );
    assert!(animator.has_active(&tree));
}

// ---------------------------------------------------------------
// batchAnimation (Option D transaction scope)
// ---------------------------------------------------------------

fn batch_animation(duration: u64, curve: &str) -> Patch {
    Patch::BatchAnimation {
        spec: json!({ "curve": curve, "duration": duration }),
    }
}

#[test]
fn batch_animation_glides_nodes_without_a_transition() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create("box", "Container", &[("width.0", json!(0.0))]),
            insert("col", "box"),
        ],
        &mut tree,
    );
    // Stamped batch: the node has NO .transition of its own, but the
    // prelude scopes the whole batch.
    animator.ingest(
        &[
            batch_animation(100, "linear"),
            set_prop("box", "width.0", json!(100.0)),
        ],
        &mut tree,
    );
    animator.set_manual_time_ms(50.0);
    animator.tick(&mut tree);
    assert!((prop_f64(&tree, "box", "width.0").unwrap() - 50.0).abs() < 1e-6);
}

#[test]
fn batch_animation_overrides_node_transition() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "box",
                "Container",
                &[
                    ("width.0", json!(0.0)),
                    // Node spec says 1000ms; the transaction's 100ms wins.
                    ("__anim.transition", transition_spec(1000, "linear")),
                ],
            ),
            insert("col", "box"),
        ],
        &mut tree,
    );
    animator.ingest(
        &[
            batch_animation(100, "linear"),
            set_prop("box", "width.0", json!(100.0)),
        ],
        &mut tree,
    );
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    // Under the node's own 1000ms spec this would be 10; the
    // transaction's 100ms spec has fully settled.
    assert_eq!(prop_f64(&tree, "box", "width.0"), Some(100.0));
}

#[test]
fn batch_animation_is_head_only_and_cleared_per_batch() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create("box", "Container", &[("width.0", json!(0.0))]),
            insert("col", "box"),
        ],
        &mut tree,
    );
    // Prelude NOT at index 0: not a stamp for this batch → snap.
    animator.ingest(
        &[
            set_prop("box", "width.0", json!(50.0)),
            batch_animation(100, "linear"),
            set_prop("box", "width.0", json!(100.0)),
        ],
        &mut tree,
    );
    assert_eq!(prop_f64(&tree, "box", "width.0"), Some(100.0));
    assert!(!animator.has_active(&tree));

    // A stamped batch, then an UNSTAMPED one: the stamp must not leak.
    animator.ingest(
        &[
            batch_animation(100, "linear"),
            set_prop("box", "width.0", json!(200.0)),
        ],
        &mut tree,
    );
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree); // settle the stamped glide
    animator.ingest(&[set_prop("box", "width.0", json!(300.0))], &mut tree);
    assert_eq!(
        prop_f64(&tree, "box", "width.0"),
        Some(300.0),
        "unstamped follow-up batch must snap"
    );
}

#[test]
fn batch_animation_prelude_is_not_forwarded_to_taffy() {
    let (mut animator, mut tree) = armed();
    let forwarded = animator
        .ingest(
            &[
                batch_animation(100, "linear"),
                create("box", "Container", &[]),
                insert("col", "box"),
            ],
            &mut tree,
        )
        .forwarded;
    assert_eq!(forwarded.len(), 2, "prelude consumed by the animator");
    assert!(!forwarded
        .iter()
        .any(|p| matches!(p, Patch::BatchAnimation { .. })));
}

// ---------------------------------------------------------------
// Reduced motion + .motion(essential)
// ---------------------------------------------------------------

#[test]
fn reduced_motion_snaps_transitions_enters_and_exits() {
    let (mut animator, mut tree) = armed();
    animator.set_reduced_motion(true, &mut tree);
    animator.ingest(
        &[
            create(
                "box",
                "Container",
                &[
                    ("width.0", json!(0.0)),
                    ("__anim.transition", transition_spec(200, "linear")),
                    ("__anim.enter", enter_fade(100)),
                    ("__anim.exit", exit_fade(150)),
                ],
            ),
            insert("col", "box"),
        ],
        &mut tree,
    );
    // Enter skipped entirely.
    assert!(!tree.get("box").unwrap().props.contains_key("opacity"));
    // Transition snaps.
    animator.ingest(&[set_prop("box", "width.0", json!(100.0))], &mut tree);
    assert_eq!(prop_f64(&tree, "box", "width.0"), Some(100.0));
    assert!(!animator.has_active(&tree));
    // Flagged remove finalizes immediately (forwarded, tree torn down).
    let forwarded = animator.ingest(&[remove("box", true)], &mut tree).forwarded;
    assert_eq!(forwarded.len(), 1);
    assert!(tree.get("box").is_none());
}

#[test]
fn motion_essential_exempts_a_node_from_reduced_motion() {
    let (mut animator, mut tree) = armed();
    animator.set_reduced_motion(true, &mut tree);
    animator.ingest(
        &[
            create(
                "box",
                "Container",
                &[
                    ("width.0", json!(0.0)),
                    ("__anim.transition", transition_spec(100, "linear")),
                    ("__anim.motion", json!({ "essential": true })),
                ],
            ),
            insert("col", "box"),
        ],
        &mut tree,
    );
    animator.ingest(&[set_prop("box", "width.0", json!(100.0))], &mut tree);
    // The essential node still glides under reduced motion.
    assert_eq!(prop_f64(&tree, "box", "width.0"), Some(0.0));
    animator.set_manual_time_ms(50.0);
    animator.tick(&mut tree);
    assert!((prop_f64(&tree, "box", "width.0").unwrap() - 50.0).abs() < 1e-6);
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "box", "width.0"), Some(100.0));
}

#[test]
fn live_toggle_on_snaps_in_flight_work_except_essential() {
    let (mut animator, mut tree) = armed();
    let spec = &[
        ("width.0", json!(0.0)),
        ("__anim.transition", transition_spec(100, "linear")),
    ];
    let mut essential_props = spec.to_vec();
    essential_props.push(("__anim.motion", json!({ "essential": true })));
    animator.ingest(
        &[
            create("plain", "Container", spec),
            insert("col", "plain"),
            create("vital", "Container", &essential_props),
            insert("col", "vital"),
        ],
        &mut tree,
    );
    animator.ingest(
        &[
            set_prop("plain", "width.0", json!(100.0)),
            set_prop("vital", "width.0", json!(100.0)),
        ],
        &mut tree,
    );
    animator.set_manual_time_ms(50.0);
    animator.tick(&mut tree);

    let out = animator.set_reduced_motion(true, &mut tree);
    assert!(out.wrote);
    // Non-essential snapped to its final value; essential still mid-glide.
    assert_eq!(prop_f64(&tree, "plain", "width.0"), Some(100.0));
    assert!((prop_f64(&tree, "vital", "width.0").unwrap() - 50.0).abs() < 1e-6);
    assert!(animator.has_active(&tree), "essential work keeps ticking");
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "vital", "width.0"), Some(100.0));
}

#[test]
fn reduced_motion_toggle_off_restarts_loops() {
    let (mut animator, mut tree) = armed();
    animator.set_reduced_motion(true, &mut tree);
    animator.ingest(
        &[
            create(
                "dot",
                "Container",
                &[(
                    "__anim.animate",
                    json!({ "preset": "pulse", "duration": 1000, "repeat": "loop", "curve": "linear" }),
                )],
            ),
            insert("col", "dot"),
        ],
        &mut tree,
    );
    assert!(!animator.has_active(&tree), "reduced motion: preset never starts");
    animator.set_reduced_motion(false, &mut tree);
    assert!(animator.has_active(&tree), "toggle-off starts the cached spec");
}

#[test]
fn env_var_seeds_the_reduced_motion_default() {
    // Construction reads HYPEN_REDUCED_MOTION once. Two animators built
    // under different env values must disagree.
    //
    // ISOLATION INVARIANT: this test mutates PROCESS-GLOBAL environment
    // state while the test harness runs other tests concurrently on
    // sibling threads. That is safe only because every other test that
    // constructs a `DesktopAnimator` immediately overrides the
    // env-seeded default — `armed()` and the direct constructions set
    // `reduced_motion` explicitly (or toggle via `set_reduced_motion`)
    // before asserting anything. Any NEW test must do the same; a test
    // that relies on the constructor's env-derived default will flake
    // against this one.
    std::env::set_var("HYPEN_REDUCED_MOTION", "1");
    let on = DesktopAnimator::new();
    std::env::set_var("HYPEN_REDUCED_MOTION", "off");
    let off = DesktopAnimator::new();
    std::env::remove_var("HYPEN_REDUCED_MOTION");
    let unset = DesktopAnimator::new();
    assert!(on.reduced_motion());
    assert!(!off.reduced_motion());
    assert!(!unset.reduced_motion());
}

// ---------------------------------------------------------------
// Ticker stand-down (no runaway redraws)
// ---------------------------------------------------------------

#[test]
fn ticker_stands_down_when_everything_settles() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "box",
                "Container",
                &[
                    ("width.0", json!(0.0)),
                    ("__anim.transition", transition_spec(100, "linear")),
                    ("__anim.enter", enter_fade(100)),
                ],
            ),
            insert("col", "box"),
        ],
        &mut tree,
    );
    assert!(animator.has_active(&tree), "enter pending");
    animator.ingest(&[set_prop("box", "width.0", json!(100.0))], &mut tree);
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    assert!(!animator.has_active(&tree), "all settled — loop must stand down");
    // A further tick writes nothing (no phantom work).
    animator.set_manual_time_ms(200.0);
    let out = animator.tick(&mut tree);
    assert!(!out.wrote && out.finalized.is_empty() && out.restyle.is_empty());
}

// ---------------------------------------------------------------
// Spec parsing edges
// ---------------------------------------------------------------

#[test]
fn malformed_specs_degrade_to_snap() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "box",
                "Container",
                &[
                    ("width.0", json!(0.0)),
                    // Unknown curve → channel malformed → snap.
                    ("__anim.transition", json!({ "duration": 100, "curve": "bouncy" })),
                ],
            ),
            insert("col", "box"),
        ],
        &mut tree,
    );
    animator.ingest(&[set_prop("box", "width.0", json!(100.0))], &mut tree);
    assert_eq!(prop_f64(&tree, "box", "width.0"), Some(100.0));
    assert!(!animator.has_active(&tree));
}

#[test]
fn animatable_base_prop_resolution() {
    assert_eq!(animatable_base_prop("width.0"), Some("width"));
    assert_eq!(animatable_base_prop("backgroundColor"), Some("backgroundColor"));
    assert_eq!(animatable_base_prop("paddingTop.0"), Some("paddingTop"));
    assert_eq!(animatable_base_prop("width@md.0"), None, "breakpoint variant");
    assert_eq!(animatable_base_prop("color:hover"), None, "state variant");
    assert_eq!(animatable_base_prop("fontFamily"), None, "off-whitelist");
}

#[test]
fn removed_transition_channel_stops_future_glides() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "box",
                "Container",
                &[
                    ("width.0", json!(0.0)),
                    ("__anim.transition", transition_spec(100, "linear")),
                ],
            ),
            insert("col", "box"),
        ],
        &mut tree,
    );
    animator.ingest(
        &[Patch::RemoveProp {
            id: "box".into(),
            name: "__anim.transition".into(),
        }],
        &mut tree,
    );
    animator.ingest(&[set_prop("box", "width.0", json!(100.0))], &mut tree);
    assert_eq!(prop_f64(&tree, "box", "width.0"), Some(100.0), "channel cleared → snap");
}

// ---------------------------------------------------------------
// Engine-key vs playback-key reconciliation. The style fallback chain
// prefers plain "opacity" over the engine applicator key "opacity.0",
// so a playback/ambient writing the plain key must migrate onto the
// engine's key the moment an engine write arrives there — a retired
// playback's plain write left behind would strand the node at the
// mid-fade value forever.
// ---------------------------------------------------------------

#[test]
fn engine_dotted_write_mid_enter_lands_engine_value_and_cleans_plain_key() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create("b", "Text", &[("0", json!("yo")), ("__anim.enter", enter_fade(100))]),
            insert("col", "b"),
        ],
        &mut tree,
    );
    animator.set_manual_time_ms(50.0);
    animator.tick(&mut tree); // mid-fade: plain "opacity" ≈ 0.5
    assert!(tree.get("b").unwrap().props.contains_key("opacity"));

    // Engine styles the node via the applicator key mid-fade.
    animator.ingest(&[set_prop("b", "opacity.0", json!(0.3))], &mut tree);
    // The playback migrated onto the engine's key: its plain-key write
    // is undone NOW, not just at settle — nothing shadows "opacity.0".
    assert!(
        !tree.get("b").unwrap().props.contains_key("opacity"),
        "plain key cleaned on migration"
    );

    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree); // settle
    assert!(!tree.get("b").unwrap().props.contains_key("opacity"));
    assert_eq!(prop_f64(&tree, "b", "opacity.0"), Some(0.3), "engine value wins");
    // The style chain resolves to the engine's value (this is what the
    // probe caught stranded at the mid-fade value pre-fix).
    assert_eq!(crate::style::prop_f32(tree.get("b").unwrap(), "opacity"), Some(0.3));
    assert!(!animator.has_active(&tree));
}

#[test]
fn engine_dotted_write_mid_enter_with_transition_snaps_clean() {
    // Same shape but the node ALSO carries `.transition`: the engine
    // write retires the enter playback and (with no previous value on
    // the engine's key) snaps — the retired playback's plain write must
    // still be gone.
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "b",
                "Text",
                &[
                    ("0", json!("yo")),
                    ("__anim.enter", enter_fade(100)),
                    ("__anim.transition", transition_spec(100, "linear")),
                ],
            ),
            insert("col", "b"),
        ],
        &mut tree,
    );
    animator.set_manual_time_ms(50.0);
    animator.tick(&mut tree); // mid-fade
    animator.ingest(&[set_prop("b", "opacity.0", json!(0.3))], &mut tree);
    animator.set_manual_time_ms(200.0);
    animator.tick(&mut tree);
    assert!(
        !tree.get("b").unwrap().props.contains_key("opacity"),
        "retired playback's plain write cleaned"
    );
    assert_eq!(crate::style::prop_f32(tree.get("b").unwrap(), "opacity"), Some(0.3));
    assert!(!animator.has_active(&tree));
}

#[test]
fn engine_dotted_write_mid_pulse_follows_the_engine_key() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "dot",
                "Container",
                &[(
                    "__anim.animate",
                    json!({ "preset": "pulse", "duration": 1000, "repeat": "loop", "curve": "linear" }),
                )],
            ),
            insert("col", "dot"),
        ],
        &mut tree,
    );
    animator.set_manual_time_ms(250.0);
    animator.tick(&mut tree); // pulse writes plain "opacity" (no key on the node)
    assert!(tree.get("dot").unwrap().props.contains_key("opacity"));

    // Engine styles the node's opacity via the applicator key mid-pulse.
    animator.ingest(&[set_prop("dot", "opacity.0", json!(0.5))], &mut tree);
    assert!(
        !tree.get("dot").unwrap().props.contains_key("opacity"),
        "ambient's plain write undone; the engine's key wins"
    );

    // Subsequent ticks write the engine's key (pulse trough × new base).
    animator.set_manual_time_ms(500.0);
    animator.tick(&mut tree);
    assert!((prop_f64(&tree, "dot", "opacity.0").unwrap() - 0.25).abs() < 1e-6);
    assert!(!tree.get("dot").unwrap().props.contains_key("opacity"));

    // Stopping the preset restores the ENGINE's value on the engine's
    // key; later engine writes are never shadowed by a stale plain key.
    animator.ingest(
        &[Patch::RemoveProp {
            id: "dot".into(),
            name: "__anim.animate".into(),
        }],
        &mut tree,
    );
    assert_eq!(prop_f64(&tree, "dot", "opacity.0"), Some(0.5));
    assert!(!tree.get("dot").unwrap().props.contains_key("opacity"));
    animator.ingest(&[set_prop("dot", "opacity.0", json!(1.0))], &mut tree);
    assert_eq!(crate::style::prop_f32(tree.get("dot").unwrap(), "opacity"), Some(1.0));
}

// ---------------------------------------------------------------
// End-of-batch essential snaps must surface their Taffy-relevant
// side effects through the ingest outcome (dropping them left Taffy
// on mid-flight geometry until an unrelated restyle).
// ---------------------------------------------------------------

#[test]
fn essential_snap_at_flush_reports_restyle() {
    let (mut animator, mut tree) = armed();
    animator.set_reduced_motion(true, &mut tree);
    animator.ingest(
        &[
            create(
                "box",
                "Container",
                &[
                    ("width.0", json!(0.0)),
                    ("__anim.transition", transition_spec(100, "linear")),
                    ("__anim.motion", json!({ "essential": true })),
                ],
            ),
            insert("col", "box"),
        ],
        &mut tree,
    );
    animator.ingest(&[set_prop("box", "width.0", json!(100.0))], &mut tree);
    animator.set_manual_time_ms(50.0);
    animator.tick(&mut tree); // essential node mid-glide at 50
    // Dropping the essential flag under reduced motion snaps the node's
    // in-flight work at the END of the batch: the layout-affecting
    // write must reach the caller through `IngestOutcome::restyle`.
    let out = animator.ingest(
        &[Patch::RemoveProp {
            id: "box".into(),
            name: "__anim.motion".into(),
        }],
        &mut tree,
    );
    assert_eq!(prop_f64(&tree, "box", "width.0"), Some(100.0), "snapped to target");
    assert!(
        out.restyle.contains(&"box".to_string()),
        "flush-time snap restyle must surface: {:?}",
        out.restyle
    );
    assert!(!animator.has_active(&tree));
}

#[test]
fn essential_snap_at_flush_forwards_finalized_exit_removals() {
    let (mut animator, mut tree) = armed();
    animator.set_reduced_motion(true, &mut tree);
    animator.ingest(
        &[
            create(
                "card",
                "Container",
                &[
                    ("__anim.exit", exit_fade(150)),
                    ("__anim.motion", json!({ "essential": true })),
                ],
            ),
            insert("col", "card"),
        ],
        &mut tree,
    );
    let out = animator.ingest(&[remove("card", true)], &mut tree);
    assert!(out.forwarded.is_empty(), "essential exit defers under reduced motion");
    assert!(animator.is_exit_excluded(&tree, "card"));
    // Dropping the essential flag mid-exit finalizes the exit at flush:
    // the withheld Remove was applied to the tree just now and MUST
    // surface in `forwarded` for the caller's Taffy mirror.
    let out = animator.ingest(
        &[Patch::RemoveProp {
            id: "card".into(),
            name: "__anim.motion".into(),
        }],
        &mut tree,
    );
    assert!(tree.get("card").is_none(), "exit finalized at flush");
    assert!(
        out.forwarded
            .iter()
            .any(|p| matches!(p, Patch::Remove { id, .. } if id == "card")),
        "withheld removal must surface for Taffy: {:?}",
        out.forwarded
    );
}

// ---------------------------------------------------------------
// Paint-side opacity plumbing (the honest half of fade/pulse)
// ---------------------------------------------------------------

#[test]
fn layout_items_carry_inherited_opacity() {
    let mut tree = Tree::new();
    tree.apply_batch(&[
        create("outer", "Column", &[("opacity", json!(0.5))]),
        insert(ROOT_ID, "outer"),
        create("inner", "Container", &[("opacity", json!(0.5))]),
        insert("outer", "inner"),
        create("t", "Text", &[("0", json!("hi"))]),
        insert("inner", "t"),
    ]);
    let mut text = crate::text::TextEngine::new();
    let pass = crate::layout::LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let outer = pass.items.iter().find(|i| i.node_id == "outer").unwrap();
    let inner = pass.items.iter().find(|i| i.node_id == "inner").unwrap();
    let t = pass.items.iter().find(|i| i.node_id == "t").unwrap();
    assert!((outer.opacity - 0.5).abs() < 1e-6);
    assert!((inner.opacity - 0.25).abs() < 1e-6, "multiplies down the tree");
    assert!((t.opacity - 0.25).abs() < 1e-6, "children inherit");
}

// ---------------------------------------------------------------
// .layout — FLIP on Move patches (DOM playFlip semantics: invert via
// transform, zero-delta skip, exit wins, reduced motion per node)
// ---------------------------------------------------------------

fn move_patch(parent: &str, id: &str) -> Patch {
    Patch::Move {
        parent_id: parent.to_string(),
        id: id.to_string(),
        before_id: None,
    }
}

fn layout_spec_node(id: &str) -> Patch {
    create(
        id,
        "Container",
        &[(
            "__anim.layout",
            json!({ "duration": 200, "curve": "linear" }),
        )],
    )
}

#[test]
fn flip_inverts_from_first_to_last_and_settles_to_base() {
    let (mut animator, mut tree) = armed();
    animator.ingest(&[layout_spec_node("a"), insert("col", "a")], &mut tree);
    let mv = move_patch("col", "a");
    animator.prepare_moves(&tree, std::slice::from_ref(&mv), |id| (id == "a").then_some((10.0, 100.0)));
    assert!(animator.has_pending_flips());
    animator.ingest(&[mv], &mut tree);
    // Post-batch layout: the node landed 40px right, 30px down.
    let played =
        animator.play_pending_flips(&mut tree, 1.0, |id| (id == "a").then_some((50.0, 130.0)));
    assert!(played);
    // The invert pose lands immediately — this frame paints at First.
    assert_eq!(prop_f64(&tree, "a", "translateX"), Some(-40.0));
    assert_eq!(prop_f64(&tree, "a", "translateY"), Some(-30.0));
    assert!(animator.has_active(&tree));
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "a", "translateX"), Some(-20.0));
    assert_eq!(prop_f64(&tree, "a", "translateY"), Some(-15.0));
    animator.set_manual_time_ms(200.0);
    animator.tick(&mut tree);
    // Settle restores the pre-flip props exactly (absent here).
    assert!(!tree.get("a").unwrap().props.contains_key("translateX"));
    assert!(!tree.get("a").unwrap().props.contains_key("translateY"));
    assert!(!animator.has_active(&tree));
}

#[test]
fn flip_zero_delta_skips_and_without_spec_never_snapshots() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            layout_spec_node("a"),
            insert("col", "a"),
            create("plain", "Container", &[]),
            insert("col", "plain"),
        ],
        &mut tree,
    );
    // No `.layout` spec → no snapshot at all.
    animator.prepare_moves(&tree, &[move_patch("col", "plain")], |_| Some((0.0, 0.0)));
    assert!(!animator.has_pending_flips());
    // Sub-half-pixel delta → snapshot taken but the play skips.
    let mv = move_patch("col", "a");
    animator.prepare_moves(&tree, std::slice::from_ref(&mv), |_| Some((10.0, 10.0)));
    animator.ingest(&[mv], &mut tree);
    let played =
        animator.play_pending_flips(&mut tree, 1.0, |_| Some((10.3, 10.4)));
    assert!(!played, "zero-delta FLIP must skip (DOM parity)");
    assert!(!tree.get("a").unwrap().props.contains_key("translateX"));
    assert!(!animator.has_active(&tree));
}

#[test]
fn exit_wins_over_flip() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "a",
                "Container",
                &[
                    (
                        "__anim.layout",
                        json!({ "duration": 200, "curve": "linear" }),
                    ),
                    (
                        "__anim.exit",
                        json!({ "presets": ["fade"], "duration": 150, "curve": "linear" }),
                    ),
                ],
            ),
            insert("col", "a"),
        ],
        &mut tree,
    );
    let mv = move_patch("col", "a");
    animator.prepare_moves(&tree, std::slice::from_ref(&mv), |_| Some((0.0, 0.0)));
    assert!(animator.has_pending_flips());
    // The flagged remove begins the exit — the pending FLIP dies with it.
    animator.ingest(&[mv, remove("a", true)], &mut tree);
    assert!(
        !animator.has_pending_flips(),
        "beginning an exit drops the node's pending FLIP"
    );
    let played = animator.play_pending_flips(&mut tree, 1.0, |_| Some((100.0, 0.0)));
    assert!(!played);
    // And a snapshot taken while ALREADY exiting is refused up front.
    animator.prepare_moves(&tree, &[move_patch("col", "a")], |_| Some((0.0, 0.0)));
    assert!(!animator.has_pending_flips());
}

#[test]
fn flip_scale_converts_physical_deltas_to_logical_props() {
    // Rect deltas are physical px; the prop channel is logical px (the
    // transform post-pass multiplies by the HiDPI scale on read).
    let (mut animator, mut tree) = armed();
    animator.ingest(&[layout_spec_node("a"), insert("col", "a")], &mut tree);
    let mv = move_patch("col", "a");
    animator.prepare_moves(&tree, std::slice::from_ref(&mv), |_| Some((0.0, 0.0)));
    animator.ingest(&[mv], &mut tree);
    let played = animator.play_pending_flips(&mut tree, 2.0, |_| Some((80.0, 0.0)));
    assert!(played);
    assert_eq!(
        prop_f64(&tree, "a", "translateX"),
        Some(-40.0),
        "80 physical px at 2× = 40 logical px"
    );
}

#[test]
fn reduced_motion_skips_flip_unless_essential() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            layout_spec_node("a"),
            insert("col", "a"),
            create(
                "e",
                "Container",
                &[
                    (
                        "__anim.layout",
                        json!({ "duration": 200, "curve": "linear" }),
                    ),
                    ("__anim.motion", json!({ "essential": true })),
                ],
            ),
            insert("col", "e"),
        ],
        &mut tree,
    );
    animator.set_reduced_motion(true, &mut tree);
    let moves = [move_patch("col", "a"), move_patch("col", "e")];
    animator.prepare_moves(&tree, &moves, |_| Some((0.0, 0.0)));
    animator.ingest(&moves, &mut tree);
    let played = animator.play_pending_flips(&mut tree, 1.0, |_| Some((100.0, 0.0)));
    assert!(played, "the essential node still plays");
    assert!(
        !tree.get("a").unwrap().props.contains_key("translateX"),
        "non-essential node snapped (no invert written)"
    );
    assert_eq!(
        prop_f64(&tree, "e", "translateX"),
        Some(-100.0),
        ".motion(essential) exempts the node from the reduced-motion skip"
    );
}

#[test]
fn flip_suspends_conflicting_shake_and_resumes_on_settle() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "a",
                "Container",
                &[
                    (
                        "__anim.layout",
                        json!({ "duration": 100, "curve": "linear" }),
                    ),
                    (
                        "__anim.animate",
                        json!({ "preset": "shake", "duration": 800, "repeat": "loop", "curve": "linear" }),
                    ),
                ],
            ),
            insert("col", "a"),
        ],
        &mut tree,
    );
    let mv = move_patch("col", "a");
    animator.prepare_moves(&tree, std::slice::from_ref(&mv), |_| Some((0.0, 0.0)));
    animator.ingest(&[mv], &mut tree);
    assert!(animator.play_pending_flips(&mut tree, 1.0, |_| Some((50.0, 0.0))));
    // Mid-flight: the FLIP owns translateX, shake is suspended.
    animator.set_manual_time_ms(50.0);
    animator.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "a", "translateX"), Some(-25.0));
    // Settle: FLIP restores, shake resumes ownership on later ticks.
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    animator.set_manual_time_ms(260.0);
    animator.tick(&mut tree);
    let shaken = prop_f64(&tree, "a", "translateX");
    assert!(shaken.is_some(), "resumed shake writes translateX again");
}

// ---------------------------------------------------------------
// #146 removal-sibling FLIP: a removed node reflows its same-parent
// `.layout` siblings, which get no `Move` patch of their own. Desktop
// mirrors the DOM (collectRemovalSiblingFlips): plain removes snapshot
// at patch time, flagged/exit removes at exit finalize; non-`.layout`
// siblings snap.
// ---------------------------------------------------------------

#[test]
fn plain_remove_slides_layout_siblings_via_flip() {
    let (mut animator, mut tree) = armed();
    // `a` (plain, to be removed) sits above `b` (a `.layout` sibling).
    animator.ingest(
        &[
            create("a", "Container", &[]),
            insert("col", "a"),
            layout_spec_node("b"),
            insert("col", "b"),
        ],
        &mut tree,
    );
    // FLIP pre-pass sees the plain Remove of `a` and snapshots `b`'s
    // First off the pre-batch layout — `b` has no Move patch of its own.
    let rm = remove("a", false);
    animator.prepare_moves(&tree, std::slice::from_ref(&rm), |id| match id {
        "a" => Some((0.0, 0.0)),   // the removed node is on-screen
        "b" => Some((0.0, 100.0)), // b's First, 100px below a
        _ => None,
    });
    assert!(
        animator.has_pending_flips(),
        "removing `a` snapshots its `.layout` sibling `b`"
    );
    animator.ingest(&[rm], &mut tree);
    // Post-batch layout: `b` reflowed up into the gap (y 100 → 0).
    let played =
        animator.play_pending_flips(&mut tree, 1.0, |id| (id == "b").then_some((0.0, 0.0)));
    assert!(played, "`b` FLIPs to cover the gap the removal left");
    // Invert lands NOW: `b` paints at its First (100px down) this frame.
    assert_eq!(prop_f64(&tree, "b", "translateY"), Some(100.0));
    // ...and settles back to base.
    animator.set_manual_time_ms(200.0);
    animator.tick(&mut tree);
    assert!(!tree.get("b").unwrap().props.contains_key("translateY"));
}

#[test]
fn flagged_remove_flips_siblings_at_exit_finalize_not_patch_time() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "a",
                "Container",
                &[(
                    "__anim.exit",
                    json!({ "presets": ["fade"], "duration": 100, "curve": "linear" }),
                )],
            ),
            insert("col", "a"),
            layout_spec_node("b"),
            insert("col", "b"),
        ],
        &mut tree,
    );
    let rm = remove("a", true);
    // Pre-pass snapshots `b`, but the flagged remove keeps `a` in flow
    // this batch, so `b` measures a zero delta and does NOT FLIP yet.
    animator.prepare_moves(&tree, std::slice::from_ref(&rm), |id| match id {
        "a" => Some((0.0, 0.0)),
        "b" => Some((0.0, 100.0)),
        _ => None,
    });
    animator.ingest(&[rm], &mut tree); // begins the exit, defers the remove
    let played =
        animator.play_pending_flips(&mut tree, 1.0, |id| (id == "b").then_some((0.0, 100.0)));
    assert!(
        !played,
        "while the exit plays, `a` holds flow and `b` stays put — no FLIP yet"
    );
    assert!(!tree.get("b").unwrap().props.contains_key("translateY"));
    // Exit settles → finalize tears `a` out and records `b` as a
    // removal-sibling FLIP candidate.
    animator.set_manual_time_ms(200.0);
    animator.tick(&mut tree);
    // The window resolves the candidate off the pre-teardown layout
    // (`b` still at its old y=100)...
    animator.queue_removal_sibling_flips(|id| (id == "b").then_some((0.0, 100.0)));
    assert!(
        animator.has_pending_flips(),
        "exit finalize queued `b`'s removal-sibling FLIP"
    );
    // ...then the fresh post-teardown layout supplies Last (`b` at y=0).
    let played =
        animator.play_pending_flips(&mut tree, 1.0, |id| (id == "b").then_some((0.0, 0.0)));
    assert!(played, "`b` FLIPs only now, at exit finalize (DOM parity)");
    assert_eq!(prop_f64(&tree, "b", "translateY"), Some(100.0));
}

#[test]
fn removal_does_not_flip_non_layout_siblings() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create("a", "Container", &[]),
            insert("col", "a"),
            create("c", "Container", &[]), // NO `.layout` spec → snaps
            insert("col", "c"),
        ],
        &mut tree,
    );
    let rm = remove("a", false);
    animator.prepare_moves(&tree, std::slice::from_ref(&rm), |_| Some((0.0, 0.0)));
    assert!(
        !animator.has_pending_flips(),
        "a sibling without `.layout` is never snapshotted — it snaps"
    );
    animator.ingest(&[rm], &mut tree);
    let played = animator.play_pending_flips(&mut tree, 1.0, |_| Some((0.0, 50.0)));
    assert!(!played);
    assert!(!tree.get("c").unwrap().props.contains_key("translateY"));
}

// ---------------------------------------------------------------
// .sharedElement — cross-route FLIP over the Router Detach/Attach seam
// (Option H). Mirrors the DOM `prepareShared`/`collectSharedFlips`/
// `playSharedFlip` five-step protocol. Drives the animator directly with
// closure rect resolvers, the same headless pattern the `.layout` FLIP
// tests use.
// ---------------------------------------------------------------

fn detach(id: &str) -> Patch {
    Patch::Detach { id: id.to_string() }
}

/// A keyed shared-element node. `spec` adds the `__anim.shared` timing
/// (350ms would be the lowering default; tests use 300/linear for clean
/// midpoints). Sources need only a key; incoming nodes need both.
fn shared_node(id: &str, key: &str, spec: bool) -> Patch {
    let mut entries: Vec<(&str, Value)> = vec![("__anim.sharedKey", json!(key))];
    if spec {
        entries.push(("__anim.shared", json!({ "duration": 300, "curve": "linear" })));
    }
    create(id, "Container", &entries)
}

/// Build the outgoing route: a detachable `page1` container under `col`
/// holding one keyed `thumb`. Returns the animator/tree ready for a nav.
fn with_source_route(key: &str) -> (DesktopAnimator, Tree) {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create("page1", "Container", &[]),
            insert("col", "page1"),
            shared_node("thumb", key, false),
            insert("page1", "thumb"),
        ],
        &mut tree,
    );
    (animator, tree)
}

#[test]
fn shared_match_flips_incoming_from_outgoing_rect_and_settles() {
    let (mut animator, mut tree) = with_source_route("hero");
    // Navigation: page1 leaves, `detail` (same key) arrives.
    let nav = vec![
        detach("page1"),
        shared_node("detail", "hero", true),
        insert("col", "detail"),
    ];
    // Step 1: snapshot the source `thumb` (under the detach root) off the
    // PRE-batch layout — (10,20) size 100×50.
    animator.prepare_shared(&tree, &nav, |id| (id == "thumb").then_some((10.0, 20.0, 100.0, 50.0)));
    assert!(animator.has_pending_shared(), "navigation shape → pending shared");
    animator.ingest(&nav, &mut tree);
    // Step 3: post-batch, `detail`'s Last rect is (60,120) size 200×100.
    let played =
        animator.play_shared_flips(&mut tree, 1.0, |id| (id == "detail").then_some((60.0, 120.0, 200.0, 100.0)));
    assert!(played, "matched key must FLIP");
    // s = mean(100/200, 50/100) = 0.5.
    // dx = (src_cx - last_cx) = (10+50) - (60+100) = -100.
    // dy = (src_cy - last_cy) = (20+25) - (120+50) = -125.
    assert_eq!(prop_f64(&tree, "detail", "translateX"), Some(-100.0));
    assert_eq!(prop_f64(&tree, "detail", "translateY"), Some(-125.0));
    assert_eq!(prop_f64(&tree, "detail", "scale"), Some(0.5));
    assert!(animator.has_active(&tree));
    // Consuming the batch clears the pending shared state.
    assert!(!animator.has_pending_shared());
    // Midpoint (linear, 150/300): halfway back to base.
    animator.set_manual_time_ms(150.0);
    animator.tick(&mut tree);
    assert_eq!(prop_f64(&tree, "detail", "translateX"), Some(-50.0));
    assert_eq!(prop_f64(&tree, "detail", "scale"), Some(0.75));
    // Settle restores the base transform exactly (absent here).
    animator.set_manual_time_ms(300.0);
    animator.tick(&mut tree);
    assert!(!tree.get("detail").unwrap().props.contains_key("translateX"));
    assert!(!tree.get("detail").unwrap().props.contains_key("translateY"));
    assert!(!tree.get("detail").unwrap().props.contains_key("scale"));
    assert!(!animator.has_active(&tree));
}

#[test]
fn shared_match_suppresses_the_incoming_nodes_own_enter() {
    let (mut animator, mut tree) = with_source_route("hero");
    // Incoming carries BOTH a matching shared key AND a fade enter.
    let detail = create(
        "detail",
        "Container",
        &[
            ("__anim.sharedKey", json!("hero")),
            ("__anim.shared", json!({ "duration": 300, "curve": "linear" })),
            ("__anim.enter", json!({ "presets": ["fade"], "duration": 200, "curve": "linear" })),
        ],
    );
    let nav = vec![detach("page1"), detail, insert("col", "detail")];
    animator.prepare_shared(&tree, &nav, |id| (id == "thumb").then_some((10.0, 20.0, 100.0, 50.0)));
    animator.ingest(&nav, &mut tree);
    // The fade enter would have written the hidden opacity pose (0.0) at
    // flush; a shared match suppresses it — one motion, not two.
    assert!(
        !tree.get("detail").unwrap().props.contains_key("opacity"),
        "matched node's own enter must be suppressed (no hidden pose)"
    );
    // The FLIP itself still plays.
    let played =
        animator.play_shared_flips(&mut tree, 1.0, |id| (id == "detail").then_some((60.0, 20.0, 100.0, 50.0)));
    assert!(played);
    assert_eq!(prop_f64(&tree, "detail", "translateX"), Some(-50.0));
}

#[test]
fn shared_unmatched_key_is_plain_navigation_and_warns_once() {
    let (mut animator, mut tree) = with_source_route("hero");
    // Incoming node carries NO key: the source key "hero" is one-sided.
    let nav = vec![
        detach("page1"),
        create("detail", "Container", &[]),
        insert("col", "detail"),
    ];
    animator.prepare_shared(&tree, &nav, |id| (id == "thumb").then_some((10.0, 20.0, 100.0, 50.0)));
    animator.ingest(&nav, &mut tree);
    let played = animator.play_shared_flips(&mut tree, 1.0, |_| Some((0.0, 0.0, 100.0, 50.0)));
    assert!(!played, "no incoming target → plain navigation");
    assert!(!tree.get("detail").unwrap().props.contains_key("translateX"));
    assert_eq!(animator.shared_warned_count(), 1, "one-sided key warns once");

    // A second identical navigation must not re-warn (dedup per key).
    let (mut animator, mut tree) = with_source_route("hero");
    let nav2 = vec![
        detach("page1"),
        create("detail", "Container", &[]),
        insert("col", "detail"),
    ];
    animator.prepare_shared(&tree, &nav2, |id| (id == "thumb").then_some((10.0, 20.0, 100.0, 50.0)));
    animator.ingest(&nav2, &mut tree);
    animator.play_shared_flips(&mut tree, 1.0, |_| Some((0.0, 0.0, 100.0, 50.0)));
    animator.prepare_shared(&tree, &nav2, |id| (id == "thumb").then_some((10.0, 20.0, 100.0, 50.0)));
    animator.play_shared_flips(&mut tree, 1.0, |_| Some((0.0, 0.0, 100.0, 50.0)));
    assert_eq!(animator.shared_warned_count(), 1, "same key never re-warns");
}

#[test]
fn shared_detach_root_scoping_ignores_a_persistent_shell_source() {
    let (mut animator, mut tree) = with_source_route("hero");
    // A persistent app-shell node OUTSIDE the detach subtree also carries
    // key "hero" — it must never source (or shadow) the FLIP.
    animator.ingest(
        &[shared_node("shell", "hero", false), insert("col", "shell")],
        &mut tree,
    );
    let nav = vec![
        detach("page1"),
        shared_node("detail", "hero", true),
        insert("col", "detail"),
    ];
    // Only `thumb` (under page1) is a valid source; `shell` sits at a very
    // different rect. If scoping failed and `shell` won, the delta would
    // be enormous.
    animator.prepare_shared(&tree, &nav, |id| match id {
        "thumb" => Some((10.0, 20.0, 100.0, 50.0)),
        "shell" => Some((500.0, 500.0, 100.0, 50.0)),
        _ => None,
    });
    animator.ingest(&nav, &mut tree);
    let played =
        animator.play_shared_flips(&mut tree, 1.0, |id| (id == "detail").then_some((60.0, 120.0, 100.0, 50.0)));
    assert!(played);
    // From `thumb`: dx = (10+50)-(60+50) = -50, dy = (20+25)-(120+25) = -100.
    // (From `shell` it would be +440 / +405.) s = 1 → scale untouched.
    assert_eq!(prop_f64(&tree, "detail", "translateX"), Some(-50.0));
    assert_eq!(prop_f64(&tree, "detail", "translateY"), Some(-100.0));
    assert!(!tree.get("detail").unwrap().props.contains_key("scale"), "unit scale is not written");
}

#[test]
fn shared_interruption_retargets_from_the_current_presentation_rect() {
    // Nav 1: source A → `detail`, a 300ms linear FLIP.
    let (mut animator, mut tree) = with_source_route("hero");
    let nav1 = vec![
        detach("page1"),
        shared_node("detail", "hero", true),
        insert("col", "detail"),
    ];
    animator.prepare_shared(&tree, &nav1, |id| (id == "thumb").then_some((0.0, 0.0, 100.0, 100.0)));
    animator.ingest(&nav1, &mut tree);
    // `detail` Last at (200,0): dx = (0+50)-(200+50) = -200.
    animator.play_shared_flips(&mut tree, 1.0, |id| (id == "detail").then_some((200.0, 0.0, 100.0, 100.0)));
    assert_eq!(prop_f64(&tree, "detail", "translateX"), Some(-200.0));
    // Mid-flight (150/300): translateX is halfway back → -100.
    animator.set_manual_time_ms(150.0);
    animator.tick(&mut tree);
    let tx = prop_f64(&tree, "detail", "translateX").unwrap();
    assert!((tx - (-100.0)).abs() < 1e-6, "mid-flight tx = {tx}");
    // Its PRESENTATION rect is the natural rect shifted by the live
    // transform — what `visual_rect` reports and the window snapshots.
    let pres_x = 200.0 + tx as f32; // scale 1, natural x 200
    // Nav 2 interrupts: `detail` now leaves, `detail2` (same key) arrives.
    let nav2 = vec![
        detach("detail"),
        shared_node("detail2", "hero", true),
        insert("col", "detail2"),
    ];
    animator.prepare_shared(&tree, &nav2, |id| (id == "detail").then_some((pres_x, 0.0, 100.0, 100.0)));
    animator.ingest(&nav2, &mut tree);
    let played =
        animator.play_shared_flips(&mut tree, 1.0, |id| (id == "detail2").then_some((300.0, 0.0, 100.0, 100.0)));
    assert!(played);
    // Retargeted from the PRESENTATION rect (pres_x=100), not original A(0):
    // dx = (100+50) - (300+50) = -200. (From A it would be -300.)
    let expected = (pres_x + 50.0) as f64 - (300.0 + 50.0);
    assert_eq!(prop_f64(&tree, "detail2", "translateX"), Some(expected));
    assert!((expected - (-200.0)).abs() < 1e-6, "retarget dx = {expected}");
}

#[test]
fn shared_reduced_motion_skips_the_flip_globally() {
    let (mut animator, mut tree) = with_source_route("hero");
    animator.reduced_motion = true;
    let nav = vec![
        detach("page1"),
        shared_node("detail", "hero", true),
        insert("col", "detail"),
    ];
    // Reduced motion takes no snapshot — so the batch is never treated as
    // a shared navigation (cross-route continuity is globally decorative).
    animator.prepare_shared(&tree, &nav, |id| (id == "thumb").then_some((10.0, 20.0, 100.0, 50.0)));
    assert!(!animator.has_pending_shared(), "reduced motion → no shared snapshot");
    animator.ingest(&nav, &mut tree);
    let played =
        animator.play_shared_flips(&mut tree, 1.0, |id| (id == "detail").then_some((60.0, 120.0, 200.0, 100.0)));
    assert!(!played, "reduced motion FLIPs nothing");
    assert!(!tree.get("detail").unwrap().props.contains_key("translateX"));
}

// ---------------------------------------------------------------
// `.onAnimationComplete` completion dispatch (Option F / Shipped v1)
//
// A node carrying an `onAnimationComplete` action prop dispatches
// `{ animation, state? }` (merged over any static applicator args) when a
// playback settles NATURALLY. Interrupted / superseded / reduced-motion /
// looping / no-prop cases dispatch NOTHING. All firing points are asserted
// at the animator seam via `take_completions()` — the same (action,
// payload) pair the window forwards to `module.dispatch_action`.
// ---------------------------------------------------------------

/// The `onAnimationComplete` action prop as the engine flattens it
/// (`.onAnimationComplete(@actions.x)` → `onAnimationComplete.0`).
fn on_complete(action: &str) -> (&'static str, Value) {
    ("onAnimationComplete.0", json!(action))
}

/// Assert exactly one completion was queued and return its (action, payload).
fn one_completion(animator: &mut DesktopAnimator) -> (String, Value) {
    let mut c = animator.take_completions();
    assert_eq!(c.len(), 1, "expected exactly one completion, got {c:?}");
    let c = c.remove(0);
    (c.action, c.payload)
}

#[test]
fn enter_settle_fires_enter_completion() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create("a", "Text", &[on_complete("@actions.done"), ("__anim.enter", enter_fade(100))]),
            insert("col", "a"),
        ],
        &mut tree,
    );
    // Mid-flight: nothing has settled yet.
    animator.set_manual_time_ms(50.0);
    animator.tick(&mut tree);
    assert!(animator.take_completions().is_empty(), "no fire before settle");
    // Natural settle → { animation: "enter" }.
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    let (action, payload) = one_completion(&mut animator);
    assert_eq!(action, "done");
    assert_eq!(payload, json!({ "animation": "enter" }));
}

#[test]
fn exit_settle_fires_exit_completion_before_finalize() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create("card", "Container", &[on_complete("@actions.gone"), ("__anim.exit", exit_fade(150))]),
            insert("col", "card"),
        ],
        &mut tree,
    );
    animator.ingest(&[remove("card", true)], &mut tree);
    // Settle finalizes the exit AND fires the completion (node still present
    // when queued, torn down in the same tick).
    animator.set_manual_time_ms(150.0);
    let out = animator.tick(&mut tree);
    assert_eq!(out.finalized.len(), 1, "exit torn down");
    let (action, payload) = one_completion(&mut animator);
    assert_eq!(action, "gone");
    assert_eq!(payload, json!({ "animation": "exit" }));
}

#[test]
fn finite_preset_completion_fires_preset_name() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "dot",
                "Container",
                &[
                    on_complete("@actions.pulsed"),
                    ("opacity", json!(1.0)),
                    ("__anim.animate", json!({ "preset": "pulse", "duration": 100, "repeat": 2, "curve": "linear" })),
                ],
            ),
            insert("col", "dot"),
        ],
        &mut tree,
    );
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    assert!(animator.take_completions().is_empty(), "no fire mid-run");
    // Two iterations exhaust at 200ms → { animation: "pulse" }.
    animator.set_manual_time_ms(200.0);
    animator.tick(&mut tree);
    let (action, payload) = one_completion(&mut animator);
    assert_eq!(action, "pulsed");
    assert_eq!(payload, json!({ "animation": "pulse" }));
}

#[test]
fn looping_preset_never_fires_completion() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "spinner",
                "Container",
                &[
                    on_complete("@actions.never"),
                    ("opacity", json!(1.0)),
                    ("__anim.animate", json!({ "preset": "pulse", "duration": 100, "repeat": "loop", "curve": "linear" })),
                ],
            ),
            insert("col", "spinner"),
        ],
        &mut tree,
    );
    // Many iterations — a looping preset never completes.
    for t in [100.0, 250.0, 1000.0, 5000.0] {
        animator.set_manual_time_ms(t);
        animator.tick(&mut tree);
    }
    assert!(animator.take_completions().is_empty(), "looping preset must never fire");
}

#[test]
fn states_settle_fires_states_completion_with_label() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create("chip", "Container", &[on_complete("@actions.posed"), ("__anim.transition", transition_spec(200, "linear"))]),
            insert("col", "chip"),
        ],
        &mut tree,
    );
    // A pose switch: the engine writes the active `.states` label as the
    // OBJECT shape it actually lowers (`{"label": "<label>"}`) — never a bare
    // string. Driving the real shape here guards the object-shape read.
    animator.ingest(
        &[set_prop("chip", "__anim.states", json!({ "label": "active" }))],
        &mut tree,
    );
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    assert!(animator.take_completions().is_empty(), "no fire before the window elapses");
    // Window (duration 200) elapses → { animation: "states", state: "active" }.
    animator.set_manual_time_ms(200.0);
    animator.tick(&mut tree);
    let (action, payload) = one_completion(&mut animator);
    assert_eq!(action, "posed");
    assert_eq!(payload, json!({ "animation": "states", "state": "active" }));
}

#[test]
fn states_superseding_label_change_fires_only_the_latest() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create("chip", "Container", &[on_complete("@actions.posed"), ("__anim.transition", transition_spec(200, "linear"))]),
            insert("col", "chip"),
        ],
        &mut tree,
    );
    animator.ingest(
        &[set_prop("chip", "__anim.states", json!({ "label": "hover" }))],
        &mut tree,
    );
    // Before the first window elapses, a new pose supersedes it.
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    animator.ingest(
        &[set_prop("chip", "__anim.states", json!({ "label": "active" }))],
        &mut tree,
    );
    // The superseded `hover` window would have fired at 300; it must not.
    animator.set_manual_time_ms(300.0);
    animator.tick(&mut tree);
    let (action, payload) = one_completion(&mut animator);
    assert_eq!(action, "posed");
    assert_eq!(payload, json!({ "animation": "states", "state": "active" }), "only the latest pose reports");
}

#[test]
fn states_settle_fires_from_engine_object_shape_end_to_end() {
    // Regression: the engine lowers `__anim.states` as the JSON object
    // `{"label": "<label>"}` (expand.rs `StateSwitch` synthesis), NEVER a
    // bare string. A prior read via `Value::as_str()` returned `None` on this
    // shape, so the settle window never opened and the states completion
    // never fired on real apps. Drive the exact object shape end-to-end.
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "chip",
                "Container",
                &[on_complete("@actions.posed"), ("__anim.transition", transition_spec(200, "linear"))],
            ),
            insert("col", "chip"),
        ],
        &mut tree,
    );
    animator.ingest(
        &[set_prop("chip", "__anim.states", json!({ "label": "expanded" }))],
        &mut tree,
    );
    // The window must be armed by the object-shape label alone.
    assert!(animator.has_active(&tree), "object-shape label must open the settle window");
    animator.set_manual_time_ms(200.0);
    animator.tick(&mut tree);
    let (action, payload) = one_completion(&mut animator);
    assert_eq!(action, "posed");
    assert_eq!(payload, json!({ "animation": "states", "state": "expanded" }));
}

#[test]
fn states_settle_tolerates_bare_string_label() {
    // Defensive parity with DOM/core `parseStatesLabel`: a host that passes
    // the label through as a bare string (Remote UI) still opens the window.
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "chip",
                "Container",
                &[on_complete("@actions.posed"), ("__anim.transition", transition_spec(200, "linear"))],
            ),
            insert("col", "chip"),
        ],
        &mut tree,
    );
    animator.ingest(&[set_prop("chip", "__anim.states", json!("active"))], &mut tree);
    animator.set_manual_time_ms(200.0);
    animator.tick(&mut tree);
    let (action, payload) = one_completion(&mut animator);
    assert_eq!(action, "posed");
    assert_eq!(payload, json!({ "animation": "states", "state": "active" }));
}

#[test]
fn shared_element_settle_fires_shared_completion() {
    let (mut animator, mut tree) = with_source_route("hero");
    let detail = create(
        "detail",
        "Container",
        &[
            on_complete("@actions.flew"),
            ("__anim.sharedKey", json!("hero")),
            ("__anim.shared", json!({ "duration": 300, "curve": "linear" })),
        ],
    );
    let nav = vec![detach("page1"), detail, insert("col", "detail")];
    animator.prepare_shared(&tree, &nav, |id| (id == "thumb").then_some((10.0, 20.0, 100.0, 50.0)));
    animator.ingest(&nav, &mut tree);
    let played = animator.play_shared_flips(&mut tree, 1.0, |id| (id == "detail").then_some((60.0, 120.0, 200.0, 100.0)));
    assert!(played, "non-zero delta FLIPs");
    assert!(animator.take_completions().is_empty(), "no fire until the FLIP settles");
    animator.set_manual_time_ms(300.0);
    animator.tick(&mut tree);
    let (action, payload) = one_completion(&mut animator);
    assert_eq!(action, "flew");
    assert_eq!(payload, json!({ "animation": "sharedElement" }));
}

#[test]
fn shared_element_zero_delta_fires_immediately() {
    let (mut animator, mut tree) = with_source_route("hero");
    let detail = create(
        "detail",
        "Container",
        &[
            on_complete("@actions.flew"),
            ("__anim.sharedKey", json!("hero")),
            ("__anim.shared", json!({ "duration": 300, "curve": "linear" })),
        ],
    );
    let nav = vec![detach("page1"), detail, insert("col", "detail")];
    // Source and target measure identical rects → zero delta.
    animator.prepare_shared(&tree, &nav, |id| (id == "thumb").then_some((10.0, 20.0, 100.0, 50.0)));
    animator.ingest(&nav, &mut tree);
    let played = animator.play_shared_flips(&mut tree, 1.0, |id| (id == "detail").then_some((10.0, 20.0, 100.0, 50.0)));
    assert!(!played, "zero delta plays no transform");
    // …but the shared element settled immediately, so it fires now.
    let (action, payload) = one_completion(&mut animator);
    assert_eq!(action, "flew");
    assert_eq!(payload, json!({ "animation": "sharedElement" }));
}

#[test]
fn interrupted_enter_fires_nothing_while_superseding_exit_fires_its_own() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "card",
                "Container",
                &[
                    on_complete("@actions.x"),
                    ("__anim.enter", enter_fade(100)),
                    ("__anim.exit", exit_fade(150)),
                ],
            ),
            insert("col", "card"),
        ],
        &mut tree,
    );
    // The enter is mid-flight …
    animator.set_manual_time_ms(50.0);
    animator.tick(&mut tree);
    // … when an exit supersedes it.
    animator.ingest(&[remove("card", true)], &mut tree);
    // Settle the exit (150 from t=50).
    animator.set_manual_time_ms(200.0);
    animator.tick(&mut tree);
    let completions = animator.take_completions();
    assert_eq!(completions.len(), 1, "exactly one fire: the exit, never the interrupted enter");
    assert_eq!(completions[0].action, "x");
    assert_eq!(completions[0].payload, json!({ "animation": "exit" }));
}

#[test]
fn node_without_the_prop_dispatches_nothing() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create("a", "Text", &[("__anim.enter", enter_fade(100))]),
            insert("col", "a"),
        ],
        &mut tree,
    );
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    assert!(animator.take_completions().is_empty(), "no onAnimationComplete prop → no dispatch");
}

#[test]
fn reduced_motion_enter_skip_fires_nothing() {
    let (mut animator, mut tree) = armed();
    animator.reduced_motion = true;
    animator.ingest(
        &[
            create("a", "Text", &[on_complete("@actions.done"), ("__anim.enter", enter_fade(100))]),
            insert("col", "a"),
        ],
        &mut tree,
    );
    // Reduced motion snaps the enter — no playback, so no settle.
    for t in [0.0, 50.0, 100.0, 200.0] {
        animator.set_manual_time_ms(t);
        animator.tick(&mut tree);
    }
    assert!(animator.take_completions().is_empty(), "reduced-motion skip fires nothing");
}

#[test]
fn completion_merges_static_applicator_args_under_the_animation_field() {
    let (mut animator, mut tree) = armed();
    animator.ingest(
        &[
            create(
                "a",
                "Text",
                &[
                    ("onAnimationComplete.0", json!("@actions.done")),
                    // Static applicator args ride under the payload …
                    ("onAnimationComplete.source", json!("hero")),
                    // … but a custom `animation` arg can NEVER shadow the
                    // completion channel (fields written last).
                    ("onAnimationComplete.animation", json!("bogus")),
                    ("__anim.enter", enter_fade(100)),
                ],
            ),
            insert("col", "a"),
        ],
        &mut tree,
    );
    animator.set_manual_time_ms(100.0);
    animator.tick(&mut tree);
    let (action, payload) = one_completion(&mut animator);
    assert_eq!(action, "done");
    assert_eq!(payload, json!({ "source": "hero", "animation": "enter" }));
}
