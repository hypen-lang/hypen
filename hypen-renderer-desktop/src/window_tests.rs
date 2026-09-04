//! Tests for `crate::window`. Lives in its own file via `#[path]` so
//! `window.rs` itself stays focused on App / event-loop wiring
//! without ~200 lines of pure-helper test fixtures.

use super::*;

fn pos(x: f64, y: f64) -> winit::dpi::PhysicalPosition<f64> {
    winit::dpi::PhysicalPosition::new(x, y)
}

mod paint_only_gate {
    use super::*;
    use serde_json::json;

    /// Tree: root → col → { text, row → leaf }.
    fn gate_tree() -> Tree {
        let mut tree = Tree::new();
        for (id, et, parent) in [
            ("col", "Column", "root"),
            ("text", "Text", "col"),
            ("row", "Row", "col"),
            ("leaf", "Text", "row"),
        ] {
            tree.apply(&Patch::Create {
                id: id.into(),
                element_type: et.to_string(),
                props: std::sync::Arc::new(indexmap::IndexMap::new()),
                semantics: None,
            });
            tree.apply(&Patch::Insert {
                parent_id: parent.into(),
                id: id.into(),
                before_id: None,
            });
        }
        tree
    }

    fn set_prop(id: &str, name: &str) -> Patch {
        Patch::SetProp {
            id: id.into(),
            name: name.into(),
            value: json!("x"),
        }
    }

    #[test]
    fn paint_only_props_scope_to_node_and_descendants() {
        let tree = gate_tree();
        let affected =
            paint_only_affected_ids(&[set_prop("row", "backgroundColor")], &[], &tree, false, false)
                .expect("paint-only batch qualifies");
        assert!(affected.contains("row"), "patched node included");
        assert!(affected.contains("leaf"), "descendants included");
        assert!(!affected.contains("text"), "siblings excluded");
        assert!(!affected.contains("col"), "ancestors excluded");
    }

    #[test]
    fn variant_and_dotted_keys_resolve_to_their_base() {
        let tree = gate_tree();
        // Paint prop under variant/arg decoration still qualifies …
        assert!(paint_only_affected_ids(
            &[set_prop("text", "backgroundColor:hover.0")],
            &[],
            &tree,
            false,
            false
        )
        .is_some());
        // … while a decorated LAYOUT prop still disqualifies.
        assert!(paint_only_affected_ids(
            &[set_prop("text", "padding@md.0")],
            &[],
            &tree,
            false,
            false
        )
        .is_none());
    }

    #[test]
    fn layout_props_structural_patches_and_denylist_force_full_drop() {
        let tree = gate_tree();
        for name in ["width", "padding", "fontSize", "0", "slot", "scrollable"] {
            assert!(
                paint_only_affected_ids(&[set_prop("text", name)], &[], &tree, false, false)
                    .is_none(),
                "{name} must force the wholesale drop"
            );
        }
        let structural = Patch::Remove {
            id: "leaf".into(),
            transition: false,
        };
        assert!(paint_only_affected_ids(&[structural], &[], &tree, false, false).is_none());
        // A mixed batch is disqualified by its structural member.
        let mixed = [
            set_prop("text", "color"),
            Patch::Insert {
                parent_id: "col".into(),
                id: "text".into(),
                before_id: None,
            },
        ];
        assert!(paint_only_affected_ids(&mixed, &[], &tree, false, false).is_none());
    }

    #[test]
    fn restyle_media_and_scrub_force_full_drop() {
        let tree = gate_tree();
        let batch = [set_prop("text", "color")];
        assert!(
            paint_only_affected_ids(&batch, &["text".to_string()], &tree, false, false).is_none(),
            "essential-snap restyles disqualify"
        );
        assert!(
            paint_only_affected_ids(&batch, &[], &tree, true, false).is_none(),
            "media trees disqualify"
        );
        assert!(
            paint_only_affected_ids(&batch, &[], &tree, false, true).is_none(),
            "scrub-owned nodes disqualify"
        );
        assert!(paint_only_affected_ids(&batch, &[], &tree, false, false).is_some());
    }

    #[test]
    fn set_semantics_is_paint_neutral() {
        let tree = gate_tree();
        let batch = [Patch::SetSemantics {
            id: "text".into(),
            semantics: None,
        }];
        let affected = paint_only_affected_ids(&batch, &[], &tree, false, false)
            .expect("semantics-only batch qualifies");
        assert!(affected.is_empty(), "semantics repaint nothing");
    }
}

#[test]
fn next_click_count_first_click_is_one() {
    let now = std::time::Instant::now();
    assert_eq!(
        next_click_count(0, None, now, pos(0.0, 0.0), pos(10.0, 10.0)),
        1
    );
}

#[test]
fn next_click_count_close_in_time_and_space_increments() {
    let t0 = std::time::Instant::now();
    let t1 = t0 + std::time::Duration::from_millis(100);
    // 1 → 2 → 3 → wraps back to 1.
    assert_eq!(
        next_click_count(1, Some(t0), t1, pos(50.0, 50.0), pos(51.0, 51.0)),
        2
    );
    assert_eq!(
        next_click_count(2, Some(t0), t1, pos(50.0, 50.0), pos(51.0, 51.0)),
        3
    );
    assert_eq!(
        next_click_count(3, Some(t0), t1, pos(50.0, 50.0), pos(51.0, 51.0)),
        1
    );
}

#[test]
fn next_click_count_far_in_space_resets_to_one() {
    let t0 = std::time::Instant::now();
    let t1 = t0 + std::time::Duration::from_millis(50);
    assert_eq!(
        next_click_count(1, Some(t0), t1, pos(0.0, 0.0), pos(50.0, 50.0)),
        1
    );
}

#[test]
fn next_click_count_far_in_time_resets_to_one() {
    let t0 = std::time::Instant::now();
    let t1 = t0 + std::time::Duration::from_millis(700);
    assert_eq!(
        next_click_count(1, Some(t0), t1, pos(50.0, 50.0), pos(51.0, 50.0)),
        1
    );
}

#[test]
fn prev_boundary_steps_back_one_ascii_char() {
    assert_eq!(prev_char_boundary("hello", 5), 4);
    assert_eq!(prev_char_boundary("hello", 1), 0);
    assert_eq!(prev_char_boundary("hello", 0), 0);
}

#[test]
fn prev_boundary_steps_over_multibyte() {
    let s = "é";
    assert_eq!(s.len(), 2);
    assert_eq!(prev_char_boundary(s, 2), 0);
}

#[test]
fn next_boundary_steps_forward_one_ascii_char() {
    assert_eq!(next_char_boundary("hello", 0), 1);
    assert_eq!(next_char_boundary("hello", 4), 5);
    assert_eq!(next_char_boundary("hello", 5), 5);
}

#[test]
fn next_boundary_steps_over_multibyte() {
    let s = "é";
    assert_eq!(next_char_boundary(s, 0), 2);
}

#[test]
fn boundary_helpers_handle_emoji_correctly() {
    let s = "ab😀cd";
    assert_eq!(next_char_boundary(s, 2), 6);
    assert_eq!(prev_char_boundary(s, 6), 2);
}

#[test]
fn clamp_scroll_pins_to_zero_when_content_fits() {
    assert_eq!(clamp_scroll(0.0, 100.0, 600.0), 0.0);
    assert_eq!(clamp_scroll(50.0, 100.0, 600.0), 0.0);
}

#[test]
fn clamp_scroll_caps_at_max_offset() {
    assert_eq!(clamp_scroll(0.0, 1200.0, 600.0), 0.0);
    assert_eq!(clamp_scroll(300.0, 1200.0, 600.0), 300.0);
    assert_eq!(clamp_scroll(600.0, 1200.0, 600.0), 600.0);
    assert_eq!(clamp_scroll(900.0, 1200.0, 600.0), 600.0);
}

#[test]
fn clamp_scroll_rejects_negative() {
    assert_eq!(clamp_scroll(-10.0, 1200.0, 600.0), 0.0);
}

// ---------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------

#[test]
fn selection_caret_collapses_anchor_and_head() {
    let s = Selection::caret(5);
    assert_eq!(s.anchor, 5);
    assert_eq!(s.head, 5);
    assert!(s.is_collapsed());
    assert_eq!(s.min(), 5);
    assert_eq!(s.max(), 5);
}

#[test]
fn selection_range_min_max_normalise_order() {
    let forward = Selection::range(2, 7);
    assert_eq!(forward.min(), 2);
    assert_eq!(forward.max(), 7);
    assert!(!forward.is_collapsed());

    let backward = Selection::range(7, 2);
    assert_eq!(backward.min(), 2);
    assert_eq!(backward.max(), 7);
    assert!(!backward.is_collapsed());
}

#[test]
fn selection_clamped_pins_each_field_to_max() {
    assert_eq!(
        Selection::range(5, 100).clamped(10),
        Selection::range(5, 10),
    );
    assert_eq!(
        Selection::range(20, 30).clamped(10),
        Selection::range(10, 10),
    );
    assert!(Selection::range(20, 30).clamped(10).is_collapsed());
}

// ---------------------------------------------------------------
// replace_selection_with
// ---------------------------------------------------------------

#[test]
fn replace_inserts_at_caret_when_collapsed() {
    let (new, sel) = App::replace_selection_with("hello", Selection::caret(5), " world");
    assert_eq!(new, "hello world");
    assert_eq!(sel, Selection::caret(11));
}

#[test]
fn replace_at_zero_prepends() {
    let (new, sel) = App::replace_selection_with("world", Selection::caret(0), "hello ");
    assert_eq!(new, "hello world");
    assert_eq!(sel, Selection::caret(6));
}

#[test]
fn replace_substitutes_a_range() {
    let (new, sel) = App::replace_selection_with("hello world", Selection::range(0, 5), "yo");
    assert_eq!(new, "yo world");
    assert_eq!(sel, Selection::caret(2));
}

#[test]
fn replace_handles_reversed_anchor_head() {
    let (new, sel) = App::replace_selection_with("hello world", Selection::range(11, 6), "");
    assert_eq!(new, "hello ");
    assert_eq!(sel, Selection::caret(6));
}

#[test]
fn replace_with_empty_deletes_the_selected_range() {
    let (new, sel) = App::replace_selection_with("abcde", Selection::range(1, 4), "");
    assert_eq!(new, "ae");
    assert_eq!(sel, Selection::caret(1));
}

#[test]
fn replace_clamps_indices_past_value_length() {
    // Defensive against external state changes that shrank the
    // value before the editor caught up — past-the-end indices
    // collapse to value.len() and the replacement appends.
    let (new, sel) = App::replace_selection_with("abc", Selection::range(10, 20), "xy");
    assert_eq!(new, "abcxy");
    assert_eq!(sel, Selection::caret(5));
}

#[test]
fn replace_handles_multibyte_correctly() {
    // "héllo" — h(1) é(2) l(1) l(1) o(1) = 6 bytes.
    // Selecting the "é" (bytes 1..3) and replacing with "i".
    let (new, sel) = App::replace_selection_with("héllo", Selection::range(1, 3), "i");
    assert_eq!(new, "hillo");
    assert_eq!(sel, Selection::caret(2));
}

#[test]
fn typing_sequence_preserves_character_order() {
    // Regression for "test" → "estt" / "rust" → "ustr": each
    // keystroke threads the caret forward via `replace_selection_with`
    // using the *previously-typed* caret position. Before the
    // `about_to_wait` clamping pass was removed, the stored
    // selection would race-reset to 0 between keystrokes (the
    // layout still reflected the pre-typing value while the
    // optimistic stored caret had moved forward), so the second
    // letter would insert at position 0 and reorder characters.
    //
    // This test simulates the per-keystroke flow that
    // `handle_keyboard` runs: read the layout's current value,
    // look up the (correctly advancing) stored caret, replace at
    // the caret, write the new caret back. If anything in between
    // clobbers the caret, the result reorders.
    for input in &["test", "rust", "hello world"] {
        let mut value = String::new();
        let mut sel = Selection::caret(0);
        for ch in input.chars() {
            let mut buf = [0u8; 4];
            let ch_str = ch.encode_utf8(&mut buf);
            let (new_value, new_sel) = App::replace_selection_with(&value, sel, ch_str);
            value = new_value;
            sel = new_sel;
        }
        assert_eq!(
            value, *input,
            "typing {input:?} character by character must produce {input:?} \
             (any reorder means a caret-clamping race re-entered the path)",
        );
        assert_eq!(sel, Selection::caret(input.len()));
    }
}

// -----------------------------------------------------------------
// Layout-cache-key guard for layout-affecting interaction-state
// variants. The free `layout_cache_key_inner` carries the gate so it's
// testable without a GPU-backed `App`.
// -----------------------------------------------------------------

#[test]
fn cache_key_ignores_hover_without_layout_state_variants() {
    // (c) With NO layout-affecting state variants in the tree, the key
    // is identical regardless of hover / press / focus — so an
    // interaction transition never forces a relayout (no regression on
    // the common path).
    let scrollables = HashMap::new();
    let base = layout_cache_key_inner(7, 800, 600, 1.0, &scrollables, false, None, None, None, 0);
    let hovered =
        layout_cache_key_inner(7, 800, 600, 1.0, &scrollables, false, Some("btn"), None, None, 0);
    let pressed =
        layout_cache_key_inner(7, 800, 600, 1.0, &scrollables, false, None, Some("btn"), None, 0);
    let focused =
        layout_cache_key_inner(7, 800, 600, 1.0, &scrollables, false, None, None, Some("btn"), 0);
    assert_eq!(base, hovered);
    assert_eq!(base, pressed);
    assert_eq!(base, focused);
}

#[test]
fn cache_key_changes_on_hover_with_layout_state_variants() {
    // (d) When the tree DOES carry a layout-affecting state variant, a
    // hover/press/focus transition bumps the key, forcing `redraw` to
    // recompute the LayoutPass with the new active states.
    let scrollables = HashMap::new();
    let none = layout_cache_key_inner(7, 800, 600, 1.0, &scrollables, true, None, None, None, 0);
    let hovered =
        layout_cache_key_inner(7, 800, 600, 1.0, &scrollables, true, Some("btn"), None, None, 0);
    assert_ne!(none, hovered, "hover must bump the key");
    // Hover moving to a different node also changes the key.
    let other =
        layout_cache_key_inner(7, 800, 600, 1.0, &scrollables, true, Some("other"), None, None, 0);
    assert_ne!(hovered, other);
    // Press / focus likewise.
    let pressed =
        layout_cache_key_inner(7, 800, 600, 1.0, &scrollables, true, None, Some("btn"), None, 0);
    assert_ne!(none, pressed);
    let focused =
        layout_cache_key_inner(7, 800, 600, 1.0, &scrollables, true, None, None, Some("btn"), 0);
    assert_ne!(none, focused);
}

#[test]
fn cache_key_with_variants_matches_baseline_when_no_interaction() {
    // The gate only *adds* hashing when an interaction is present; with
    // all-`None` interaction the keyed-on and keyed-off variants agree,
    // confirming the fold is purely additive (hashing `None` thrice is
    // what the disabled branch skips, but with no interaction the
    // resulting key still differs only by that — so we assert the
    // enabled-but-idle key is stable across calls).
    let scrollables = HashMap::new();
    let a = layout_cache_key_inner(3, 1024, 768, 2.0, &scrollables, true, None, None, None, 0);
    let b = layout_cache_key_inner(3, 1024, 768, 2.0, &scrollables, true, None, None, None, 0);
    assert_eq!(a, b);
}

// -----------------------------------------------------------------

// -----------------------------------------------------------------
// Headless animation wiring harness. Drives the SAME glue the window
// uses — the extracted `drive_animation_frame` /
// `drive_reduced_motion_toggle` / `evict_detached_backstop` /
// `clear_focus_if_exiting` free functions — against a real Tree,
// retained TaffyState, and LayoutPass. No GPU, no event loop: this is
// what pins the wiring the 36 animator-only tests can't see (the F1
// toggle case lived exactly in that gap).
// -----------------------------------------------------------------

use crate::text::TextEngine;
use crate::tree::{Tree, ROOT_ID};
use hypen_engine::Patch;
use indexmap::IndexMap;

fn wprops(entries: &[(&str, serde_json::Value)]) -> Arc<IndexMap<String, serde_json::Value>> {
    let mut map = IndexMap::new();
    for (k, v) in entries {
        map.insert((*k).to_string(), v.clone());
    }
    Arc::new(map)
}

fn wcreate(id: &str, et: &str, entries: &[(&str, serde_json::Value)]) -> Patch {
    Patch::Create {
        id: id.into(),
        element_type: et.to_string(),
        props: wprops(entries),
        semantics: None,
    }
}

fn winsert(parent: &str, id: &str) -> Patch {
    Patch::Insert {
        parent_id: parent.into(),
        id: id.into(),
        before_id: None,
    }
}

fn wset(id: &str, name: &str, value: serde_json::Value) -> Patch {
    Patch::SetProp {
        id: id.into(),
        name: name.to_string(),
        value,
    }
}

const HARNESS_SCALE: f32 = 1.0;
const HARNESS_VIEWPORT: (u32, u32) = (800, 600);

/// The harness surface as a logical viewport. `HARNESS_SCALE` is the
/// same conversion the window applies, so tests exercise the real
/// physical -> logical path rather than asserting against raw pixels.
fn harness_viewport() -> crate::style::Viewport {
    crate::layout::logical_viewport(HARNESS_VIEWPORT, HARNESS_SCALE)
}

/// Animator at manual time 0 (reduced motion explicitly OFF — never
/// depend on the ambient `HYPEN_REDUCED_MOTION`, see the env-var
/// test's isolation invariant in `anim_tests`), a tree holding one
/// `col` Column, and a retained TaffyState mirroring it — the same
/// trio `App` owns.
fn harness() -> (DesktopAnimator, Tree, TaffyState) {
    let mut animator = DesktopAnimator::new();
    let mut tree = Tree::new();
    let _ = animator.set_reduced_motion(false, &mut tree);
    animator.set_manual_time_ms(0.0);
    let mut taffy = TaffyState::new();
    mirror_ingest(
        &mut animator,
        &mut tree,
        &mut taffy,
        &[wcreate("col", "Column", &[]), winsert(ROOT_ID, "col")],
    );
    (animator, tree, taffy)
}

/// The `App::flush_patches` wiring in miniature: ingest through the
/// animator, mirror the forwarded patches into Taffy, restyle the
/// flush-time snap writes.
fn mirror_ingest(
    animator: &mut DesktopAnimator,
    tree: &mut Tree,
    taffy: &mut TaffyState,
    patches: &[Patch],
) {
    let out = animator.ingest(patches, tree);
    if !taffy.apply_patches(&out.forwarded, tree, HARNESS_SCALE, harness_viewport()) {
        taffy.mark_needs_rebuild();
    }
    for id in &out.restyle {
        taffy.restyle_node(id, tree, HARNESS_SCALE, harness_viewport());
    }
}

/// The `App::redraw` layout step: compute the LayoutPass off the
/// retained TaffyState — always AFTER `drive_animation_frame`, the
/// same tick-before-layout ordering `redraw` pins.
fn harness_layout(
    taffy: &mut TaffyState,
    tree: &Tree,
    text: &mut TextEngine,
    generation: u64,
) -> LayoutPass {
    LayoutPass::compute_with_state(
        taffy,
        tree,
        text,
        HARNESS_VIEWPORT,
        HARNESS_SCALE,
        0.0,
        &HashMap::new(),
        generation,
    )
}

#[test]
fn animation_frame_restyles_retained_taffy_before_layout() {
    let (mut animator, mut tree, mut taffy) = harness();
    let mut text = TextEngine::new();
    mirror_ingest(
        &mut animator,
        &mut tree,
        &mut taffy,
        &[
            wcreate(
                "box",
                "Container",
                &[
                    ("width.0", json!(100.0)),
                    ("height.0", json!(40.0)),
                    (
                        "__anim.transition",
                        json!({ "duration": 200, "curve": "linear" }),
                    ),
                ],
            ),
            winsert("col", "box"),
        ],
    );
    let pass = harness_layout(&mut taffy, &tree, &mut text, 1);
    assert!((pass.item_by_id("box").unwrap().rect.w - 100.0).abs() < 0.5);

    // Engine retargets width mid-session; the animator rewinds and
    // glides. At the halfway tick the frame must (a) write the
    // interpolated value into the tree BEFORE layout and (b) push it
    // through TaffyState::restyle_node so the retained Taffy re-solves
    // — without (b) the rect stays at 100 until an unrelated restyle.
    mirror_ingest(
        &mut animator,
        &mut tree,
        &mut taffy,
        &[wset("box", "width.0", json!(200.0))],
    );
    animator.set_manual_time_ms(100.0);
    let frame = drive_animation_frame(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
    );
    assert!(frame.invalidate, "mid-glide tick wrote into the tree");
    assert!(frame.rearm, "in-flight work must keep the ticker armed");
    let pass = harness_layout(&mut taffy, &tree, &mut text, 2);
    let w = pass.item_by_id("box").unwrap().rect.w;
    assert!(
        (w - 150.0).abs() < 0.5,
        "layout after the tick must see the restyled midpoint, got {w}"
    );

    // Settle, then one idle frame: the ticker stands down.
    animator.set_manual_time_ms(200.0);
    let frame = drive_animation_frame(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
    );
    assert!(frame.invalidate, "settle writes the exact target");
    assert!(!frame.rearm, "settled → no vsync re-arm");
    let pass = harness_layout(&mut taffy, &tree, &mut text, 3);
    assert!((pass.item_by_id("box").unwrap().rect.w - 200.0).abs() < 0.5);
    let frame = drive_animation_frame(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
    );
    assert!(
        !frame.invalidate && !frame.rearm,
        "idle frame: nothing written, nothing re-armed"
    );
}

#[test]
fn reduced_motion_toggle_off_rearms_the_ticker() {
    // The F1 regression: pulses stayed frozen on an idle window after
    // toggling reduced motion OFF, because the toggle's empty outcome
    // skipped the redraw request. `rearm` must come from `has_active`.
    let (mut animator, mut tree, mut taffy) = harness();
    let frame = drive_reduced_motion_toggle(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
        true,
    );
    assert!(!frame.invalidate && !frame.rearm, "nothing in flight yet");
    mirror_ingest(
        &mut animator,
        &mut tree,
        &mut taffy,
        &[
            wcreate(
                "dot",
                "Container",
                &[(
                    "__anim.animate",
                    json!({ "preset": "pulse", "duration": 1000, "repeat": "loop", "curve": "linear" }),
                )],
            ),
            winsert("col", "dot"),
        ],
    );
    assert!(!animator.has_active(&tree), "reduced motion: preset never starts");

    let frame = drive_reduced_motion_toggle(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
        false,
    );
    assert!(
        !frame.invalidate,
        "restart writes nothing at toggle time (the outcome is empty)"
    );
    assert!(
        frame.rearm,
        "restarted ambients need frames — an idle window must wake"
    );
    // And the next driven frame actually writes the pulse.
    animator.set_manual_time_ms(250.0);
    let frame = drive_animation_frame(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
    );
    assert!(frame.invalidate, "restarted pulse writes on the next frame");
    assert!(frame.rearm);
}

#[test]
fn reduced_motion_toggle_on_snaps_and_invalidates() {
    let (mut animator, mut tree, mut taffy) = harness();
    mirror_ingest(
        &mut animator,
        &mut tree,
        &mut taffy,
        &[
            wcreate(
                "box",
                "Container",
                &[
                    ("width.0", json!(0.0)),
                    (
                        "__anim.transition",
                        json!({ "duration": 100, "curve": "linear" }),
                    ),
                ],
            ),
            winsert("col", "box"),
        ],
    );
    mirror_ingest(
        &mut animator,
        &mut tree,
        &mut taffy,
        &[wset("box", "width.0", json!(100.0))],
    );
    animator.set_manual_time_ms(50.0);
    let _ = drive_animation_frame(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
    );
    let frame = drive_reduced_motion_toggle(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
        true,
    );
    assert!(frame.invalidate, "toggle-on snap writes final values");
    assert!(!frame.rearm, "everything snapped — stand down");
    let mut text = TextEngine::new();
    let pass = harness_layout(&mut taffy, &tree, &mut text, 9);
    assert!(
        (pass.item_by_id("box").unwrap().rect.w - 100.0).abs() < 0.5,
        "snap's restyle reached the retained Taffy"
    );
}

#[test]
fn evict_backstop_forgets_animator_state() {
    let (mut animator, mut tree, mut taffy) = harness();
    let baseline = animator.tracked_record_count();
    mirror_ingest(
        &mut animator,
        &mut tree,
        &mut taffy,
        &[
            wcreate(
                "dot",
                "Container",
                &[(
                    "__anim.animate",
                    json!({ "preset": "pulse", "duration": 1000, "repeat": "loop", "curve": "linear" }),
                )],
            ),
            winsert("col", "dot"),
        ],
    );
    assert!(animator.tracked_record_count() > baseline, "spec + ambient tracked");
    mirror_ingest(
        &mut animator,
        &mut tree,
        &mut taffy,
        &[Patch::Detach { id: "dot".into() }],
    );

    // Backstop eviction (cap 0 forces it) must drop the animator's
    // records along with the node — before the fix, evicted ids left
    // their specs/ambients in the maps for the process lifetime.
    let evicted = evict_detached_backstop(&mut tree, &mut taffy, &mut animator, 0);
    assert!(evicted.contains(&"dot".to_string()));
    assert!(tree.get("dot").is_none());
    assert_eq!(
        animator.tracked_record_count(),
        baseline,
        "forget must fully drop the evicted id"
    );
}

// -----------------------------------------------------------------
// F4: exit exclusion beyond the pointer paths — keyboard dispatch and
// focus lifecycle.
// -----------------------------------------------------------------

#[test]
fn focused_dispatch_skips_exit_excluded_ids() {
    let mut tree = Tree::new();
    tree.apply(&wcreate("btn", "Button", &[("action", json!("@actions.save"))]));
    tree.apply(&winsert(ROOT_ID, "btn"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let hit = focused_dispatch(&pass, Some("btn"), &|_| false);
    assert_eq!(hit.map(|(a, _)| a), Some("save".to_string()));
    // Enter/Space on a focused button mid-exit must dispatch NOTHING —
    // the id is engine-side dead (parity with the pointer exclusion).
    assert!(focused_dispatch(&pass, Some("btn"), &|id| id == "btn").is_none());
    assert!(focused_dispatch(&pass, None, &|_| false).is_none());
}

#[test]
fn focus_clears_when_its_subtree_begins_exiting() {
    let (mut animator, mut tree, mut taffy) = harness();
    mirror_ingest(
        &mut animator,
        &mut tree,
        &mut taffy,
        &[
            wcreate(
                "card",
                "Container",
                &[(
                    "__anim.exit",
                    json!({ "presets": ["fade"], "duration": 150, "curve": "linear" }),
                )],
            ),
            winsert("col", "card"),
            wcreate("btn", "Button", &[("action", json!("@actions.save"))]),
            winsert("card", "btn"),
        ],
    );
    let mut focused = Some("btn".to_string());
    let mut ring = true;
    assert!(
        !clear_focus_if_exiting(&animator, &tree, &mut focused, &mut ring),
        "no exit yet: focus stays"
    );
    assert_eq!(focused.as_deref(), Some("btn"));

    // The card's flagged Remove begins a deferred exit; focus sits on a
    // descendant and must clear immediately (and never be restored).
    mirror_ingest(
        &mut animator,
        &mut tree,
        &mut taffy,
        &[Patch::Remove {
            id: "card".into(),
            transition: true,
        }],
    );
    assert!(animator.is_exit_excluded(&tree, "btn"));
    assert!(clear_focus_if_exiting(&animator, &tree, &mut focused, &mut ring));
    assert_eq!(focused, None, "focus cleared at exit begin");
    assert!(!ring, "focus ring cleared with it");
}

// -----------------------------------------------------------------
// Transform stage: slide/scale/spin/FLIP end-to-end through the SAME
// wiring the window runs — prepare_moves before ingest (flush_patches),
// tick before layout (redraw), play_pending_flips + refresh_transforms
// after layout (redraw's cache-miss branch) — asserting that painted
// transforms and hit targets move identically (constraint #5).
// -----------------------------------------------------------------

fn wmove(parent: &str, id: &str, before: Option<&str>) -> Patch {
    Patch::Move {
        parent_id: parent.into(),
        id: id.into(),
        before_id: before.map(Into::into),
    }
}

#[test]
fn slide_enter_moves_pixels_and_hit_targets_together() {
    let (mut animator, mut tree, mut taffy) = harness();
    let mut text = TextEngine::new();
    mirror_ingest(
        &mut animator,
        &mut tree,
        &mut taffy,
        &[
            wcreate(
                "btn",
                "Button",
                &[
                    ("action", json!("@actions.go")),
                    ("width.0", json!(100.0)),
                    ("height.0", json!(40.0)),
                    (
                        "__anim.enter",
                        json!({ "presets": ["slide"], "duration": 100, "curve": "linear" }),
                    ),
                ],
            ),
            winsert("col", "btn"),
        ],
    );
    // Flush played the enter: hidden pose (translateX = -24) is in the
    // tree, and the first layout pass composes it into the item.
    let pass = harness_layout(&mut taffy, &tree, &mut text, 1);
    let btn = pass.item_by_id("btn").unwrap().clone();
    assert!(!btn.transform.is_identity(), "hidden slide pose paints");
    let (cx, cy) = (btn.rect.x + 50.0, btn.rect.y + 20.0);
    assert!(
        pass.hit(cx - 24.0, cy).map(|it| it.node_id.clone()).as_deref() == Some("btn"),
        "hit target sits at the slid position"
    );
    // The trailing 24px sliver of the un-slid rect is empty space now.
    assert!(pass.hit(btn.rect.x + 99.0, cy).is_none());

    // Mid-animation tick: pixels and hit targets advance in lockstep.
    animator.set_manual_time_ms(50.0);
    let frame = drive_animation_frame(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
    );
    assert!(frame.invalidate && frame.rearm);
    let pass = harness_layout(&mut taffy, &tree, &mut text, 2);
    let vr = pass.item_by_id("btn").unwrap().visual_rect();
    assert!(
        (vr.x - (btn.rect.x - 12.0)).abs() < 0.5,
        "midpoint visual rect at -12px, got {vr:?}"
    );
    assert!(pass.hit(cx - 12.0, cy).is_some(), "mid-flight hit follows");

    // Settle: transform retires, hit target back at the layout rect.
    animator.set_manual_time_ms(100.0);
    drive_animation_frame(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
    );
    let pass = harness_layout(&mut taffy, &tree, &mut text, 3);
    assert!(pass.item_by_id("btn").unwrap().transform.is_identity());
    assert!(pass.hit(cx, cy).is_some());
}

#[test]
fn slide_exit_stays_excluded_while_transformed() {
    // Exit-excluded + transformed combined: the corpse paints mid-slide
    // but every hit path must skip it — at the OLD position and at the
    // TRANSFORMED one.
    let (mut animator, mut tree, mut taffy) = harness();
    let mut text = TextEngine::new();
    mirror_ingest(
        &mut animator,
        &mut tree,
        &mut taffy,
        &[
            wcreate(
                "btn",
                "Button",
                &[
                    ("action", json!("@actions.go")),
                    ("width.0", json!(100.0)),
                    ("height.0", json!(40.0)),
                    (
                        "__anim.exit",
                        json!({ "presets": ["slide"], "duration": 100, "curve": "linear" }),
                    ),
                ],
            ),
            winsert("col", "btn"),
        ],
    );
    mirror_ingest(
        &mut animator,
        &mut tree,
        &mut taffy,
        &[Patch::Remove {
            id: "btn".into(),
            transition: true,
        }],
    );
    assert!(animator.is_exit_excluded(&tree, "btn"));
    animator.set_manual_time_ms(50.0);
    drive_animation_frame(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
    );
    let pass = harness_layout(&mut taffy, &tree, &mut text, 2);
    let btn = pass.item_by_id("btn").expect("corpse still painted");
    assert!(!btn.transform.is_identity(), "exit slide is painting");
    let vr = btn.visual_rect();
    let (tx, ty) = (vr.x + vr.w * 0.5, vr.y + vr.h * 0.5);
    // Without the exclusion the transformed point WOULD hit...
    assert!(pass.hit(tx, ty).is_some());
    // ...and with it (the window's real predicate) nothing hits, at
    // either position.
    let excluded = |id: &str| animator.is_exit_excluded(&tree, id);
    assert!(pass.hit_excluding(tx, ty, &excluded).is_none());
    let (ox, oy) = (btn.rect.x + 50.0, btn.rect.y + 20.0);
    assert!(pass.hit_excluding(ox, oy, &excluded).is_none());
    // Settle finalizes the removal through the same glue.
    animator.set_manual_time_ms(100.0);
    let frame = drive_animation_frame(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
    );
    assert!(frame.invalidate);
    assert!(tree.get("btn").is_none());
}

#[test]
fn spin_advances_the_item_transform_frame_over_frame() {
    let (mut animator, mut tree, mut taffy) = harness();
    let mut text = TextEngine::new();
    mirror_ingest(
        &mut animator,
        &mut tree,
        &mut taffy,
        &[
            wcreate(
                "icon",
                "Container",
                &[
                    ("width.0", json!(200.0)),
                    ("height.0", json!(20.0)),
                    (
                        "__anim.animate",
                        json!({ "preset": "spin", "duration": 1000, "repeat": "loop", "curve": "linear" }),
                    ),
                ],
            ),
            winsert("col", "icon"),
        ],
    );
    assert!(animator.has_active(&tree), "spin keeps the ticker armed");
    animator.set_manual_time_ms(250.0);
    let frame = drive_animation_frame(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
    );
    assert!(frame.invalidate && frame.rearm);
    let pass = harness_layout(&mut taffy, &tree, &mut text, 2);
    let icon = pass.item_by_id("icon").unwrap();
    // Quarter turn: the 200×20 box's visual AABB swaps axes.
    let vr = icon.visual_rect();
    assert!(
        (vr.w - 20.0).abs() < 0.5 && (vr.h - 200.0).abs() < 0.5,
        "rotate(90) AABB, got {vr:?}"
    );
    // Half turn next frame: AABB back to 200×20 (upside down).
    animator.set_manual_time_ms(500.0);
    drive_animation_frame(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
    );
    let pass = harness_layout(&mut taffy, &tree, &mut text, 3);
    let vr = pass.item_by_id("icon").unwrap().visual_rect();
    assert!((vr.w - 200.0).abs() < 0.5 && (vr.h - 20.0).abs() < 0.5);
}

#[test]
fn flip_on_move_plays_through_the_window_glue() {
    // The full window sequence for a `.layout` Move: First off the
    // pre-batch layout (flush_patches' pre-pass), ingest, fresh layout
    // (redraw's cache-miss), Last + playback (play_pending_flips),
    // refresh_transforms — then ticks settle back to base.
    let (mut animator, mut tree, mut taffy) = harness();
    let mut text = TextEngine::new();
    mirror_ingest(
        &mut animator,
        &mut tree,
        &mut taffy,
        &[
            wcreate("a", "Container", &[("height.0", json!(40.0))]),
            winsert("col", "a"),
            wcreate(
                "b",
                "Container",
                &[
                    ("height.0", json!(60.0)),
                    (
                        "__anim.layout",
                        json!({ "duration": 100, "curve": "linear" }),
                    ),
                ],
            ),
            winsert("col", "b"),
        ],
    );
    let pass1 = harness_layout(&mut taffy, &tree, &mut text, 1);
    let first_b = pass1.item_by_id("b").unwrap().rect;
    assert!((first_b.y - 40.0).abs() < 0.5, "b starts below a: {first_b:?}");

    // flush_patches in miniature, FLIP pre-pass included.
    let batch = [wmove("col", "b", Some("a"))];
    animator.prepare_moves(&tree, &batch, |id| {
        pass1.item_by_id(id).map(|it| (it.rect.x, it.rect.y))
    });
    assert!(animator.has_pending_flips());
    mirror_ingest(&mut animator, &mut tree, &mut taffy, &batch);

    // redraw in miniature: fresh layout off the retained TaffyState,
    // then Last measurement + playback + transform refresh.
    let mut pass2 = harness_layout(&mut taffy, &tree, &mut text, 2);
    let last_b = pass2.item_by_id("b").unwrap().rect;
    assert!(last_b.y.abs() < 0.5, "b re-laid-out to the top: {last_b:?}");
    let played = animator.play_pending_flips(&mut tree, HARNESS_SCALE, |id| {
        pass2.item_by_id(id).map(|it| (it.rect.x, it.rect.y))
    });
    assert!(played, "Move with retained TaffyState geometry FLIPs");
    pass2.refresh_transforms(&tree, harness_viewport(), HARNESS_SCALE);
    let b = pass2.item_by_id("b").unwrap();
    let vr = b.visual_rect();
    assert!(
        (vr.y - first_b.y).abs() < 0.5,
        "invert frame paints b back at First (y = {}), got {vr:?}",
        first_b.y
    );

    // Halfway: the transform has played half the delta back.
    animator.set_manual_time_ms(50.0);
    let frame = drive_animation_frame(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
    );
    assert!(frame.invalidate && frame.rearm);
    let pass3 = harness_layout(&mut taffy, &tree, &mut text, 3);
    let vr = pass3.item_by_id("b").unwrap().visual_rect();
    assert!((vr.y - 20.0).abs() < 0.5, "half-played FLIP, got {vr:?}");

    // Settle: props restored, geometry rests at Last.
    animator.set_manual_time_ms(100.0);
    let frame = drive_animation_frame(
        &mut animator,
        &mut tree,
        &mut taffy,
        HARNESS_SCALE,
        harness_viewport(),
    );
    assert!(!frame.rearm);
    assert!(!tree.get("b").unwrap().props.contains_key("translateY"));
    let pass4 = harness_layout(&mut taffy, &tree, &mut text, 4);
    assert!(pass4.item_by_id("b").unwrap().transform.is_identity());
    assert!(pass4.item_by_id("b").unwrap().rect.y.abs() < 0.5);
}

// ---------------------------------------------------------------
// Video poster onError dispatch (pure scan)
// ---------------------------------------------------------------

mod media_errors {
    use super::*;
    use crate::paint::image::LoadFailure;
    use crate::style::Viewport;
    use crate::tree::{Tree, ROOT_ID};
    use hypen_engine::Patch;
    use serde_json::{json, Value};
    use std::collections::HashSet;

    fn video_tree(props: &[(&str, Value)]) -> Tree {
        let mut map = indexmap::IndexMap::new();
        for (k, v) in props {
            map.insert((*k).to_string(), v.clone());
        }
        let mut tree = Tree::new();
        tree.apply(&Patch::Create {
            id: "vid".into(),
            element_type: "Video".to_string(),
            props: std::sync::Arc::new(map),
            semantics: None,
        });
        tree.apply(&Patch::Insert {
            parent_id: ROOT_ID.into(),
            id: "vid".into(),
            before_id: None,
        });
        tree
    }

    fn failing_403(poster: &'static str) -> impl Fn(&str) -> Option<LoadFailure> {
        move |src: &str| {
            (src == poster).then(|| LoadFailure {
                status: 403,
                message: format!("HTTP 403 fetching {src}"),
            })
        }
    }

    #[test]
    fn failed_poster_dispatches_onerror_with_status_once() {
        let tree = video_tree(&[
            ("src", json!("https://cdn/clip.mp4")),
            ("poster", json!("https://cdn/frame.jpg")),
            ("onError.0", json!("@actions.playbackFailed")),
        ]);
        let mut dispatched = HashSet::new();
        let lookup = failing_403("https://cdn/frame.jpg");

        let out = collect_media_error_dispatches(
            &tree,
            Viewport::new(800.0, 600.0),
            &mut dispatched,
            &lookup,
        );
        assert_eq!(out.len(), 1, "exactly one onError dispatch expected");
        let (action, payload) = &out[0];
        assert_eq!(action, "playbackFailed");
        assert_eq!(payload["type"], json!("error"));
        assert_eq!(payload["src"], json!("https://cdn/clip.mp4"));
        assert_eq!(payload["index"], json!(0));
        assert_eq!(payload["status"], json!(403));
        assert!(payload["message"].as_str().unwrap().contains("403"));

        // Second scan (next Wake): deduped, no re-dispatch.
        let out2 = collect_media_error_dispatches(
            &tree,
            Viewport::new(800.0, 600.0),
            &mut dispatched,
            &lookup,
        );
        assert!(out2.is_empty(), "sticky failure must dispatch only once");
    }

    #[test]
    fn poster_only_video_reports_the_poster_as_src() {
        let tree = video_tree(&[
            ("poster", json!("https://cdn/frame.jpg")),
            ("onError.0", json!("@actions.err")),
        ]);
        let mut dispatched = HashSet::new();
        let lookup = failing_403("https://cdn/frame.jpg");
        let out = collect_media_error_dispatches(
            &tree,
            Viewport::new(800.0, 600.0),
            &mut dispatched,
            &lookup,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].1["src"], json!("https://cdn/frame.jpg"));
    }

    #[test]
    fn no_onerror_wired_means_no_dispatch() {
        let tree = video_tree(&[("poster", json!("https://cdn/frame.jpg"))]);
        let mut dispatched = HashSet::new();
        let lookup = failing_403("https://cdn/frame.jpg");
        let out = collect_media_error_dispatches(
            &tree,
            Viewport::new(800.0, 600.0),
            &mut dispatched,
            &lookup,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn healthy_poster_means_no_dispatch() {
        let tree = video_tree(&[
            ("poster", json!("https://cdn/ok.jpg")),
            ("onError.0", json!("@actions.err")),
        ]);
        let mut dispatched = HashSet::new();
        let lookup = |_: &str| None;
        let out = collect_media_error_dispatches(
            &tree,
            Viewport::new(800.0, 600.0),
            &mut dispatched,
            &lookup,
        );
        assert!(out.is_empty());
    }
}

// ---------------------------------------------------------------------------
// Video v2: `playback` bind reports, Scrubber commit, slot-driven cache key
// (hypen-docs/content/docs/guide/components.mdx §"Playback control & composition slots")
// ---------------------------------------------------------------------------

use crate::video_v2::{VideoPlayerState, PLAYBACK_REPORT_INTERVAL_MS};
use crate::window::window_video::{
    plan_playback_write, playback_reports, scrub_commit_dispatch, scrub_fraction_at,
    PlaybackReport, PlaybackWritePlan,
};

fn report_at(
    state: VideoPlayerState,
    position: f64,
    duration: f64,
    at: std::time::Instant,
) -> PlaybackReport {
    PlaybackReport {
        position,
        duration,
        playing: state.play_intent(),
        state,
        position_reported_at: at,
    }
}

fn paths(reports: &[crate::window::window_video::PlaybackFieldReport]) -> Vec<&str> {
    reports.iter().map(|r| r.path.as_str()).collect()
}

#[test]
fn first_playback_report_pushes_every_field() {
    let now = std::time::Instant::now();
    let reports = playback_reports("pb", None, VideoPlayerState::Playing, 0.0, 12.0, now);
    assert_eq!(
        paths(&reports),
        vec!["pb.state", "pb.playing", "pb.duration", "pb.position"]
    );
    assert_eq!(reports[0].value, json!("playing"));
    assert_eq!(reports[1].value, json!(true));
    assert_eq!(reports[2].value, json!(12.0));
}

#[test]
fn loading_with_intent_reports_playing_true() {
    // R3: the bind's `playing` field reports play INTENT. A pipeline in
    // preroll / no-frame-yet `loading` that intends to play (not paused,
    // not ended) reports `playing: true` while `state` reports
    // `"loading"` — a bound toggle must not flicker during a stall.
    let now = std::time::Instant::now();
    let reports = playback_reports("pb", None, VideoPlayerState::Loading, 0.0, 0.0, now);
    assert_eq!(paths(&reports), vec!["pb.state", "pb.playing", "pb.position"]);
    assert_eq!(reports[0].value, json!("loading"));
    assert_eq!(
        reports[1].value,
        json!(true),
        "loading-with-intent must report playing: true"
    );
}

#[test]
fn rebuffer_transition_keeps_playing_true_and_flips_only_state() {
    // playing → loading (rebuffer): `state` reports the transition but
    // `playing` stays true, so nothing about the play intent changes.
    let t0 = std::time::Instant::now();
    let last = report_at(VideoPlayerState::Playing, 5.0, 60.0, t0);
    let reports = playback_reports(
        "pb",
        Some(&last),
        VideoPlayerState::Loading,
        5.0,
        60.0,
        t0 + std::time::Duration::from_millis(10),
    );
    assert_eq!(paths(&reports), vec!["pb.state"]);
    assert_eq!(reports[0].value, json!("loading"));
    // And coming back out of the stall flips only `state` again.
    let stalled = report_at(VideoPlayerState::Loading, 5.0, 60.0, t0);
    let resumed = playback_reports(
        "pb",
        Some(&stalled),
        VideoPlayerState::Playing,
        5.0,
        60.0,
        t0 + std::time::Duration::from_millis(10),
    );
    assert_eq!(paths(&resumed), vec!["pb.state"]);
}

#[test]
fn position_reports_are_throttled_to_250ms_while_playing() {
    let t0 = std::time::Instant::now();
    let last = report_at(VideoPlayerState::Playing, 1.0, 12.0, t0);
    // 100 ms later, position moved — still inside the throttle window.
    let early = playback_reports(
        "pb",
        Some(&last),
        VideoPlayerState::Playing,
        1.1,
        12.0,
        t0 + std::time::Duration::from_millis(100),
    );
    assert!(early.is_empty(), "sub-250ms progress must not report");
    // At exactly the interval it goes out.
    let due = playback_reports(
        "pb",
        Some(&last),
        VideoPlayerState::Playing,
        1.3,
        12.0,
        t0 + std::time::Duration::from_millis(PLAYBACK_REPORT_INTERVAL_MS),
    );
    assert_eq!(paths(&due), vec!["pb.position"]);
    assert_eq!(due[0].value, json!(1.3));
}

#[test]
fn transitions_report_immediately_regardless_of_the_throttle() {
    let t0 = std::time::Instant::now();
    let last = report_at(VideoPlayerState::Playing, 1.0, 12.0, t0);
    // Pause 10 ms in: state + playing + the position it stopped at all
    // go out at once, throttle notwithstanding.
    let reports = playback_reports(
        "pb",
        Some(&last),
        VideoPlayerState::Paused,
        1.05,
        12.0,
        t0 + std::time::Duration::from_millis(10),
    );
    assert_eq!(
        paths(&reports),
        vec!["pb.state", "pb.playing", "pb.position"]
    );
    assert_eq!(reports[0].value, json!("paused"));
    assert_eq!(reports[1].value, json!(false));
}

#[test]
fn duration_reports_once_when_it_becomes_known() {
    let t0 = std::time::Instant::now();
    let unknown = report_at(VideoPlayerState::Loading, 0.0, 0.0, t0);
    let learned = playback_reports(
        "pb",
        Some(&unknown),
        VideoPlayerState::Loading,
        0.0,
        30.0,
        t0 + std::time::Duration::from_millis(400),
    );
    assert_eq!(paths(&learned), vec!["pb.duration"]);
    // Same duration again: silent.
    let known = report_at(VideoPlayerState::Loading, 0.0, 30.0, t0);
    let quiet = playback_reports(
        "pb",
        Some(&known),
        VideoPlayerState::Loading,
        0.0,
        30.0,
        t0 + std::time::Duration::from_millis(400),
    );
    assert!(quiet.is_empty());
}

#[test]
fn steady_state_playback_reports_nothing_when_nothing_moved() {
    let t0 = std::time::Instant::now();
    let last = report_at(VideoPlayerState::Paused, 4.0, 12.0, t0);
    let reports = playback_reports(
        "pb",
        Some(&last),
        VideoPlayerState::Paused,
        4.0,
        12.0,
        t0 + std::time::Duration::from_secs(5),
    );
    assert!(
        reports.is_empty(),
        "a parked player must not keep writing state"
    );
}

#[test]
fn seek_epsilon_is_one_second() {
    // The write-side guard: `apply_playback_write` seeks only when the
    // written position differs from the actual one by MORE than the
    // epsilon, which is what stops the 250 ms progress reports from
    // echoing back around as seeks.
    let actual = 10.0_f64;
    for (written, should_seek) in [
        (10.2, false),
        (10.9, false),
        (11.0, false),
        (11.5, true),
        (0.0, true),
    ] {
        assert_eq!(
            (written - actual).abs() > crate::video_v2::PLAYBACK_SEEK_EPSILON_S,
            should_seek,
            "written={written}"
        );
    }
}

// --- Inbound playback writes (plan_playback_write) --------------------------

fn playback_obj(fields: &[(&str, serde_json::Value)]) -> serde_json::Map<String, serde_json::Value> {
    fields
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect()
}

#[test]
fn first_bind_application_is_positive_intent_only() {
    // Spec: "The first application of a freshly-bound struct carries
    // positive intent only … an initialized `playing: false` cannot
    // cancel `autoplay`." The required init `{playing: false, …}` lands
    // in the same flush that started the autoplay pipeline (state =
    // loading, intent to play) and must NOT pause it.
    let obj = playback_obj(&[("playing", json!(false)), ("position", json!(0.0))]);
    let plan = plan_playback_write(&obj, true, None, VideoPlayerState::Loading, 0.0, 0.0);
    assert_eq!(
        plan,
        PlaybackWritePlan::default(),
        "an initialized playing:false must not cancel same-flush autoplay"
    );

    // Positive intent DOES apply on the first application: playing:true
    // plays, and a position (the resume point) seeks.
    let obj = playback_obj(&[("playing", json!(true)), ("position", json!(545.0))]);
    let plan = plan_playback_write(&obj, true, None, VideoPlayerState::Idle, 0.0, 600.0);
    assert_eq!(plan.set_playing, Some(true));
    assert_eq!(plan.seek_to, Some(545.0), "the first application's position seeks");

    // A negative init still lets its accompanying resume position seek.
    let obj = playback_obj(&[("playing", json!(false)), ("position", json!(120.0))]);
    let plan = plan_playback_write(&obj, true, None, VideoPlayerState::Loading, 0.0, 600.0);
    assert_eq!(plan.set_playing, None);
    assert_eq!(plan.seek_to, Some(120.0));
}

#[test]
fn later_playing_false_writes_are_authoritative() {
    // "Every later write is authoritative in both directions": a genuine
    // pause request (not an echo — the last report said playing: true)
    // must reach the pipeline.
    let t0 = std::time::Instant::now();
    let last = report_at(VideoPlayerState::Playing, 5.0, 60.0, t0);
    let obj = playback_obj(&[("playing", json!(false))]);
    let plan =
        plan_playback_write(&obj, false, Some(&last), VideoPlayerState::Playing, 5.0, 60.0);
    assert_eq!(plan.set_playing, Some(false));
}

#[test]
fn echoed_playback_reports_do_not_touch_the_pipeline() {
    // The renderer's own pause report comes back around the state loop:
    // both fields match what was last reported / the actual position —
    // nothing may reach the pipeline.
    let t0 = std::time::Instant::now();
    let last = report_at(VideoPlayerState::Paused, 5.0, 60.0, t0);
    let obj = playback_obj(&[("playing", json!(false)), ("position", json!(5.0))]);
    let plan =
        plan_playback_write(&obj, false, Some(&last), VideoPlayerState::Paused, 5.0, 60.0);
    assert_eq!(plan, PlaybackWritePlan::default());
}

#[test]
fn restart_from_ended_yields_to_an_accompanying_seek() {
    // `{playing: true, position: 37}` on an ended player: the restart
    // (whose implementation seeks to zero inside `media::set_playing`)
    // runs first and the explicit seek lands after — the plan carries
    // both, so the player resumes at 37, not 0.
    let t0 = std::time::Instant::now();
    let last = report_at(VideoPlayerState::Ended, 60.0, 60.0, t0);
    let obj = playback_obj(&[("playing", json!(true)), ("position", json!(37.0))]);
    let plan =
        plan_playback_write(&obj, false, Some(&last), VideoPlayerState::Ended, 60.0, 60.0);
    assert_eq!(plan.set_playing, Some(true), "playing:true on ended restarts");
    assert_eq!(
        plan.seek_to,
        Some(37.0),
        "the explicit seek must win over the restart's seek-to-zero"
    );
}

#[test]
fn position_writes_clamp_and_respect_the_epsilon() {
    let obj = playback_obj(&[("position", json!(10.5))]);
    let plan = plan_playback_write(&obj, false, None, VideoPlayerState::Playing, 10.0, 60.0);
    assert_eq!(plan.seek_to, None, "within the 1 s epsilon: a progress echo");
    let obj = playback_obj(&[("position", json!(999.0))]);
    let plan = plan_playback_write(&obj, false, None, VideoPlayerState::Playing, 10.0, 60.0);
    assert_eq!(plan.seek_to, Some(60.0), "clamped to the known duration");
    let obj = playback_obj(&[("position", json!(-8.0))]);
    let plan = plan_playback_write(&obj, false, None, VideoPlayerState::Playing, 10.0, 60.0);
    assert_eq!(plan.seek_to, Some(0.0), "clamped at zero");
}

// --- Scrubber commit ------------------------------------------------------

fn scrub_tree(bind: Option<&str>, on_seek: Option<&str>) -> Tree {
    scrub_tree_with_own_bind(bind, None, on_seek)
}

fn scrub_tree_with_own_bind(
    video_bind: Option<&str>,
    scrubber_bind: Option<&str>,
    on_seek: Option<&str>,
) -> Tree {
    let mut tree = Tree::new();
    let mut vprops: indexmap::IndexMap<String, serde_json::Value> = indexmap::IndexMap::new();
    if let Some(b) = video_bind {
        vprops.insert("bind".into(), json!(b));
    }
    tree.apply(&hypen_engine::Patch::Create {
        id: "vid".into(),
        element_type: "Video".into(),
        props: std::sync::Arc::new(vprops),
        semantics: None,
    });
    tree.apply(&hypen_engine::Patch::Insert {
        parent_id: "root".into(),
        id: "vid".into(),
        before_id: None,
    });
    let mut sprops: indexmap::IndexMap<String, serde_json::Value> = indexmap::IndexMap::new();
    if let Some(b) = scrubber_bind {
        sprops.insert("bind".into(), json!(b));
    }
    if let Some(a) = on_seek {
        sprops.insert("onSeek".into(), json!(a));
    }
    tree.apply(&hypen_engine::Patch::Create {
        id: "sc".into(),
        element_type: "Scrubber".into(),
        props: std::sync::Arc::new(sprops),
        semantics: None,
    });
    tree.apply(&hypen_engine::Patch::Insert {
        parent_id: "vid".into(),
        id: "sc".into(),
        before_id: None,
    });
    tree
}

#[test]
fn scrubber_commits_through_the_enclosing_videos_bind() {
    let tree = scrub_tree(Some("playback"), Some("@actions.seek"));
    let (action, payload) =
        scrub_commit_dispatch(&tree, "sc", Some("vid"), 42.5).expect("a commit dispatch");
    assert_eq!(action, "__hypen_bind");
    assert_eq!(payload["path"], json!("playback.position"));
    assert_eq!(payload["value"], json!(42.5));
}

#[test]
fn scrubbers_own_bind_wins_over_the_enclosing_videos_bind() {
    // R2 commit precedence: own bind → enclosing Video's bind → onSeek.
    let tree =
        scrub_tree_with_own_bind(Some("playback"), Some("scrub.pb"), Some("@actions.seek"));
    let (action, payload) =
        scrub_commit_dispatch(&tree, "sc", Some("vid"), 12.0).expect("a commit dispatch");
    assert_eq!(action, "__hypen_bind");
    assert_eq!(
        payload["path"],
        json!("scrub.pb.position"),
        "the Scrubber's OWN bind must win over the enclosing Video's"
    );
    assert_eq!(payload["value"], json!(12.0));
}

#[test]
fn scrubbers_own_bind_commits_even_when_the_player_is_bindless() {
    let tree = scrub_tree_with_own_bind(None, Some("scrub.pb"), Some("@actions.seek"));
    let (action, payload) =
        scrub_commit_dispatch(&tree, "sc", Some("vid"), 3.5).expect("a commit dispatch");
    assert_eq!(action, "__hypen_bind");
    assert_eq!(payload["path"], json!("scrub.pb.position"));
    assert_eq!(payload["value"], json!(3.5));
}

#[test]
fn scrubber_falls_back_to_its_own_on_seek_when_the_player_is_bindless() {
    let tree = scrub_tree(None, Some("@actions.seek"));
    let (action, payload) =
        scrub_commit_dispatch(&tree, "sc", Some("vid"), 7.0).expect("a commit dispatch");
    assert_eq!(action, "seek", "the `@actions.` prefix is stripped at resolve time");
    assert_eq!(payload["type"], json!("seek"));
    assert_eq!(payload["position"], json!(7.0));
}

#[test]
fn bindless_scrubber_without_on_seek_dispatches_nothing() {
    let tree = scrub_tree(None, None);
    assert!(scrub_commit_dispatch(&tree, "sc", Some("vid"), 7.0).is_none());
    // Outside a Video, with no onSeek either: inert.
    assert!(scrub_commit_dispatch(&tree, "sc", None, 7.0).is_none());
}

#[test]
fn scrub_pointer_mapping_clamps_to_the_track() {
    let rect = crate::layout::Rect {
        x: 100.0,
        y: 0.0,
        w: 200.0,
        h: 16.0,
    };
    assert_eq!(scrub_fraction_at(rect, 100.0), 0.0);
    assert_eq!(scrub_fraction_at(rect, 200.0), 0.5);
    assert_eq!(scrub_fraction_at(rect, 300.0), 1.0);
    // Dragging past either end pins rather than wrapping.
    assert_eq!(scrub_fraction_at(rect, -50.0), 0.0);
    assert_eq!(scrub_fraction_at(rect, 9000.0), 1.0);
    // Degenerate rect: no division by zero.
    assert_eq!(
        scrub_fraction_at(
            crate::layout::Rect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0
            },
            5.0
        ),
        0.0
    );
}

// --- Layout cache key -----------------------------------------------------

#[test]
fn player_state_transitions_bump_the_layout_cache_key() {
    // Slot visibility is derived from the registry, not from tree props,
    // so without folding the state into the key a play→pause would reuse
    // a cached layout and never show/hide the slots.
    let scrollables = HashMap::new();
    let idle = layout_cache_key_inner(7, 800, 600, 1.0, &scrollables, false, None, None, None, 11);
    let playing =
        layout_cache_key_inner(7, 800, 600, 1.0, &scrollables, false, None, None, None, 22);
    assert_ne!(idle, playing);
}

#[test]
fn video_state_key_is_zero_without_any_video_node() {
    let mut tree = Tree::new();
    tree.apply(&hypen_engine::Patch::Create {
        id: "col".into(),
        element_type: "Column".into(),
        props: std::sync::Arc::new(indexmap::IndexMap::new()),
        semantics: None,
    });
    tree.apply(&hypen_engine::Patch::Insert {
        parent_id: "root".into(),
        id: "col".into(),
        before_id: None,
    });
    assert_eq!(
        crate::window::video_state_key_for(&tree, crate::style::vp(800.0)),
        0,
        "non-media apps must keep a key byte-identical to the pre-feature one"
    );
}

#[test]
fn video_state_key_tracks_the_derived_state() {
    let tree = scrub_tree(Some("playback"), None);
    let viewport = crate::style::vp(800.0);
    crate::video_v2::clear_test_states();
    crate::video_v2::set_test_state("vid", VideoPlayerState::Playing);
    let playing = crate::window::video_state_key_for(&tree, viewport);
    crate::video_v2::set_test_state("vid", VideoPlayerState::Paused);
    let paused = crate::window::video_state_key_for(&tree, viewport);
    assert_ne!(playing, paused);
    assert_ne!(playing, 0);
    crate::video_v2::clear_test_states();
}

#[test]
fn controls_slot_suppresses_the_builtin_tap_toggle() {
    use crate::window::window_video::tap_suppressed;
    // Without a controls slot the surface keeps today's tap-to-toggle.
    let bare = scrub_tree(None, None);
    assert!(!tap_suppressed(&bare, "vid"));

    // With one, the author's own transport chrome owns playback and the
    // built-in toggle stands down — in every player state, since slot
    // PRESENCE (not visibility) is what replaces a built-in.
    let mut with_controls = scrub_tree(None, None);
    with_controls.apply(&hypen_engine::Patch::Create {
        id: "ctl".into(),
        element_type: "Row".into(),
        props: std::sync::Arc::new(indexmap::IndexMap::from([(
            "slot.0".to_string(),
            json!("controls"),
        )])),
        semantics: None,
    });
    with_controls.apply(&hypen_engine::Patch::Insert {
        parent_id: "vid".into(),
        id: "ctl".into(),
        before_id: None,
    });
    assert!(tap_suppressed(&with_controls, "vid"));

    // A non-controls slot leaves the tap affordance alone.
    let mut poster_only = scrub_tree(None, None);
    poster_only.apply(&hypen_engine::Patch::Create {
        id: "post".into(),
        element_type: "Image".into(),
        props: std::sync::Arc::new(indexmap::IndexMap::from([(
            "slot.0".to_string(),
            json!("poster"),
        )])),
        semantics: None,
    });
    poster_only.apply(&hypen_engine::Patch::Insert {
        parent_id: "vid".into(),
        id: "post".into(),
        before_id: None,
    });
    assert!(!tap_suppressed(&poster_only, "vid"));
}
