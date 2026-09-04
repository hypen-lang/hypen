//! Tests for `crate::layout`. Lives in its own file via `#[path]` so
//! `layout.rs` itself stays focused on the build / walk / API surface
//! without the editor-buffer weight of ~1.2k lines of test helpers
//! and patch-stream fixtures.

use super::*;
use crate::style::vp;
use crate::tree::Tree;
use hypen_engine::Patch;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::sync::Arc;

/// Build a `Patch::Create` with the given props (k/v pairs of `&str` →
/// `serde_json::Value`).
fn create_patch(id: &str, element_type: &str, props: &[(&str, Value)]) -> Patch {
    let mut map: IndexMap<String, Value> = IndexMap::new();
    for (k, v) in props {
        map.insert((*k).into(), v.clone());
    }
    Patch::Create {
        id: id.into(),
        element_type: element_type.into(),
        props: Arc::new(map),
        semantics: None,
    }
}

fn insert_patch(parent_id: &str, id: &str) -> Patch {
    Patch::Insert {
        parent_id: parent_id.into(),
        id: id.into(),
        before_id: None,
    }
}

/// Convenience: build a Text node with positional content under the given
/// parent.
fn add_text(tree: &mut Tree, parent: &str, id: &str, content: &str) {
    tree.apply(&create_patch(id, "Text", &[("0", json!(content))]));
    tree.apply(&insert_patch(parent, id));
}

fn find_item<'a>(pass: &'a LayoutPass, node_id: &str) -> &'a LayoutItem {
    pass.items
        .iter()
        .find(|it| it.node_id == node_id)
        .unwrap_or_else(|| panic!("expected layout item for node `{node_id}`"))
}

#[test]
fn column_stacks_two_texts_vertically() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    add_text(&mut tree, "col", "t1", "First");
    add_text(&mut tree, "col", "t2", "Second");

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let first = find_item(&pass, "t1");
    let second = find_item(&pass, "t2");
    assert!(
        second.rect.y > first.rect.y + first.rect.h - 1.0,
        "expected second text below first; got first={:?} second={:?}",
        first.rect,
        second.rect
    );
}

#[test]
fn row_stacks_two_texts_horizontally() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("row", "Row", &[]));
    tree.apply(&insert_patch("root", "row"));
    add_text(&mut tree, "row", "t1", "First");
    add_text(&mut tree, "row", "t2", "Second");

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let first = find_item(&pass, "t1");
    let second = find_item(&pass, "t2");
    assert!(
        second.rect.x > first.rect.x + first.rect.w - 1.0,
        "expected second text to the right of first; got first={:?} second={:?}",
        first.rect,
        second.rect
    );
}

#[test]
fn text_rect_size_is_nonzero() {
    let mut tree = Tree::new();
    add_text(&mut tree, "root", "t1", "Hello");

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let item = find_item(&pass, "t1");
    assert!(
        item.rect.w > 0.0 && item.rect.h > 0.0,
        "expected non-zero text rect, got {:?}",
        item.rect
    );
}

#[test]
fn button_emits_button_kind_with_resolved_action() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "btn",
        "Button",
        &[("action", json!("@actions.increment"))],
    ));
    tree.apply(&insert_patch("root", "btn"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let item = find_item(&pass, "btn");
    assert!(
        matches!(item.kind, ItemKind::Button),
        "expected ItemKind::Button, got {:?}",
        item.kind
    );
    assert_eq!(item.action.as_deref(), Some("increment"));
}

#[test]
fn button_action_strips_at_actions_prefix() {
    let mut tree = Tree::new();
    // Three buttons in a Column so they're all distinct, separately
    // discoverable items.
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    tree.apply(&create_patch(
        "b_full",
        "Button",
        &[("action", json!("@actions.foo"))],
    ));
    tree.apply(&insert_patch("col", "b_full"));
    tree.apply(&create_patch(
        "b_at",
        "Button",
        &[("action", json!("@foo"))],
    ));
    tree.apply(&insert_patch("col", "b_at"));
    tree.apply(&create_patch(
        "b_bare",
        "Button",
        &[("action", json!("foo"))],
    ));
    tree.apply(&insert_patch("col", "b_bare"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    for id in ["b_full", "b_at", "b_bare"] {
        let item = find_item(&pass, id);
        assert_eq!(
            item.action.as_deref(),
            Some("foo"),
            "button `{id}` should resolve to action `foo`",
        );
    }
}

#[test]
fn hit_returns_topmost_actionable() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    tree.apply(&create_patch(
        "b1",
        "Button",
        &[("action", json!("@actions.first"))],
    ));
    tree.apply(&insert_patch("col", "b1"));
    add_text(&mut tree, "b1", "b1_label", "First");
    tree.apply(&create_patch(
        "b2",
        "Button",
        &[("action", json!("@actions.second"))],
    ));
    tree.apply(&insert_patch("col", "b2"));
    add_text(&mut tree, "b2", "b2_label", "Second");

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let second = find_item(&pass, "b2");
    assert!(
        second.rect.w > 0.0 && second.rect.h > 0.0,
        "second button should have a non-zero rect, got {:?}",
        second.rect
    );
    let cx = second.rect.x + second.rect.w / 2.0;
    let cy = second.rect.y + second.rect.h / 2.0;
    let hit = pass
        .hit(cx, cy)
        .expect("expected a hit at the second button's center");
    assert_eq!(hit.node_id, "b2");
    assert_eq!(hit.action.as_deref(), Some("second"));
}

#[test]
fn text_inside_button_is_not_actionable() {
    // Regression: `resolve_action` used to fall back to `props["0"]`
    // for any element type, so a Text child of a Button (whose
    // content lives at `props["0"]`) ended up flagged actionable
    // and won the hit-test over its parent Button.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "btn",
        "Button",
        &[("action", json!("@actions.tap"))],
    ));
    tree.apply(&insert_patch("root", "btn"));
    add_text(&mut tree, "btn", "label", "Tap");

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let label = find_item(&pass, "label");
    assert!(
        label.action.is_none(),
        "Text content must not be misread as an action",
    );
}

#[test]
fn hit_outside_returns_none() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "btn",
        "Button",
        &[("action", json!("@actions.tap"))],
    ));
    tree.apply(&insert_patch("root", "btn"));
    add_text(&mut tree, "btn", "label", "Tap");

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    assert!(pass.hit(-1.0, -1.0).is_none());
}

#[test]
fn hit_skips_non_actionable() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "box",
        "Container",
        &[("padding.0", json!(40))],
    ));
    tree.apply(&insert_patch("root", "box"));
    add_text(&mut tree, "box", "label", "Just a label");

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let container = find_item(&pass, "box");
    // Sanity: container has a non-zero rect we can probe.
    assert!(
        container.rect.w > 0.0 && container.rect.h > 0.0,
        "container should have a non-zero rect from padding, got {:?}",
        container.rect
    );
    assert!(container.action.is_none());

    let cx = container.rect.x + container.rect.w / 2.0;
    let cy = container.rect.y + container.rect.h / 2.0;
    // The container is non-actionable and has no actionable descendants.
    assert!(
        pass.hit(cx, cy).is_none(),
        "hit on non-actionable container should return None",
    );
}

#[test]
fn padding_pushes_first_child_inward() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[("padding.0", json!(50))]));
    tree.apply(&insert_patch("root", "col"));
    add_text(&mut tree, "col", "t1", "Padded");

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let child = find_item(&pass, "t1");
    assert!(
        child.rect.x >= 50.0,
        "expected child x >= 50 (padding inset), got {}",
        child.rect.x
    );
}

// ---------------------------------------------------------------
// Focus traversal (keyboard navigation)
// ---------------------------------------------------------------

fn three_button_layout() -> LayoutPass {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    for id in ["b1", "b2", "b3"] {
        tree.apply(&create_patch(
            id,
            "Button",
            &[("action", json!(format!("@actions.{id}")))],
        ));
        tree.apply(&insert_patch("col", id));
        add_text(&mut tree, id, &format!("{id}_label"), id);
    }
    let mut text = TextEngine::new();
    LayoutPass::compute(&tree, &mut text, (800, 600), 1.0)
}

#[test]
fn focus_next_starts_at_first_when_none() {
    let pass = three_button_layout();
    assert_eq!(pass.focus_next(None).as_deref(), Some("b1"));
}

#[test]
fn focus_next_walks_in_order_and_wraps() {
    let pass = three_button_layout();
    assert_eq!(pass.focus_next(Some("b1")).as_deref(), Some("b2"));
    assert_eq!(pass.focus_next(Some("b2")).as_deref(), Some("b3"));
    assert_eq!(pass.focus_next(Some("b3")).as_deref(), Some("b1"));
}

#[test]
fn focus_prev_starts_at_last_when_none() {
    let pass = three_button_layout();
    assert_eq!(pass.focus_prev(None).as_deref(), Some("b3"));
}

#[test]
fn focus_prev_walks_backwards_and_wraps() {
    let pass = three_button_layout();
    assert_eq!(pass.focus_prev(Some("b3")).as_deref(), Some("b2"));
    assert_eq!(pass.focus_prev(Some("b2")).as_deref(), Some("b1"));
    assert_eq!(pass.focus_prev(Some("b1")).as_deref(), Some("b3"));
}

#[test]
fn focus_unknown_id_falls_back_to_first_or_last() {
    let pass = three_button_layout();
    assert_eq!(pass.focus_next(Some("ghost")).as_deref(), Some("b1"));
    assert_eq!(pass.focus_prev(Some("ghost")).as_deref(), Some("b3"));
}

#[test]
fn focus_returns_none_when_no_actionables() {
    let mut tree = Tree::new();
    add_text(&mut tree, ROOT_ID, "t", "just text");
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    assert_eq!(pass.focus_next(None), None);
    assert_eq!(pass.focus_prev(None), None);
}

#[test]
fn focus_skips_non_actionable_containers() {
    // Container in the tree should be ignored — only Buttons walk.
    let mut tree = Tree::new();
    tree.apply(&create_patch("box", "Container", &[]));
    tree.apply(&insert_patch("root", "box"));
    tree.apply(&create_patch(
        "btn",
        "Button",
        &[("action", json!("@actions.tap"))],
    ));
    tree.apply(&insert_patch("box", "btn"));
    add_text(&mut tree, "btn", "label", "Tap");

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    assert_eq!(pass.focus_next(None).as_deref(), Some("btn"));
    // Walking past the only actionable wraps back to itself.
    assert_eq!(pass.focus_next(Some("btn")).as_deref(), Some("btn"));
}

#[test]
fn border_width_pushes_child_inward_via_taffy() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "box",
        "Container",
        &[("borderWidth.0", json!(10))],
    ));
    tree.apply(&insert_patch("root", "box"));
    add_text(&mut tree, "box", "t1", "Inside");

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let container = find_item(&pass, "box");
    let child = find_item(&pass, "t1");
    assert!(
        child.rect.x >= container.rect.x + 10.0,
        "expected child x ({}) to be at least 10 inside container x ({}); got delta {}",
        child.rect.x,
        container.rect.x,
        child.rect.x - container.rect.x,
    );
}

#[test]
fn text_wraps_to_constrained_width() {
    // A long Text inside a Column constrained to 120px should wrap
    // into multiple lines, growing height beyond a single line.
    let mut tree = Tree::new();
    let long = "the quick brown fox jumps over the lazy dog several times";
    add_text(&mut tree, ROOT_ID, "narrow", long);
    let mut text = TextEngine::new();

    // Wide viewport: text fits on one line, height ≈ one line.
    let wide = LayoutPass::compute(&tree, &mut text, (1200, 600), 1.0);
    let h_wide = find_item(&wide, "narrow").rect.h;

    // Narrow viewport: text wraps, height should be larger.
    let narrow = LayoutPass::compute(&tree, &mut text, (180, 600), 1.0);
    let h_narrow = find_item(&narrow, "narrow").rect.h;

    assert!(
        h_narrow > h_wide,
        "narrow-viewport wrapped height ({h_narrow}) should exceed wide ({h_wide})",
    );
}

// ---------------------------------------------------------------
// Input element
// ---------------------------------------------------------------

#[test]
fn input_emits_input_kind_with_value_placeholder_bind() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "in",
        "Input",
        &[
            ("value", json!("hello")),
            ("placeholder", json!("Type here")),
            ("bind", json!("name")),
        ],
    ));
    tree.apply(&insert_patch("root", "in"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "in");
    match &item.kind {
        ItemKind::Input {
            value,
            placeholder,
            bind_path,
            ..
        } => {
            assert_eq!(value, "hello");
            assert_eq!(placeholder.as_deref(), Some("Type here"));
            assert_eq!(bind_path.as_deref(), Some("name"));
        }
        other => panic!("expected ItemKind::Input, got {other:?}"),
    }
}

#[test]
fn input_is_focusable_and_walked_by_focus_next() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    tree.apply(&create_patch("in", "Input", &[("bind", json!("name"))]));
    tree.apply(&insert_patch("col", "in"));
    tree.apply(&create_patch(
        "btn",
        "Button",
        &[("action", json!("@actions.save"))],
    ));
    tree.apply(&insert_patch("col", "btn"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    // First Tab from None → first focusable in document order.
    assert_eq!(pass.focus_next(None).as_deref(), Some("in"));
    // Walk forward from Input → Button.
    assert_eq!(pass.focus_next(Some("in")).as_deref(), Some("btn"));
    // Wrap from last focusable back to first.
    assert_eq!(pass.focus_next(Some("btn")).as_deref(), Some("in"));
}

// ---------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------

#[test]
fn content_size_grows_with_more_children() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    for i in 0..30 {
        let id = format!("t{i}");
        add_text(&mut tree, "col", &id, &format!("row {i}"));
    }
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (400, 200), 1.0);
    // 30 rows of ~24px line height should comfortably exceed
    // the 200px viewport.
    assert!(
        pass.content_size.1 > 200.0,
        "expected content_size.1 > 200, got {}",
        pass.content_size.1,
    );
}

#[test]
fn compute_with_scroll_shifts_every_item_y() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    for i in 0..5 {
        let id = format!("r{i}");
        add_text(&mut tree, "col", &id, &format!("row {i}"));
    }
    let mut text = TextEngine::new();
    let unscrolled = LayoutPass::compute(&tree, &mut text, (400, 600), 1.0);
    let scrolled = LayoutPass::compute_with_scroll(&tree, &mut text, (400, 600), 1.0, 100.0);
    for unrolled_item in unscrolled.items.iter() {
        let scrolled_item = find_item(&scrolled, &unrolled_item.node_id);
        let dy = unrolled_item.rect.y - scrolled_item.rect.y;
        assert!(
            (dy - 100.0).abs() < 0.5,
            "item {id} expected -100 shift, got {dy}",
            id = unrolled_item.node_id,
        );
    }
}

#[test]
fn hit_test_still_resolves_under_scroll() {
    // A Button positioned past the natural viewport top should
    // become hittable at the top of the viewport once scrolled.
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    for i in 0..40 {
        let id = format!("r{i}");
        add_text(&mut tree, "col", &id, &format!("filler {i}"));
    }
    tree.apply(&create_patch(
        "btn",
        "Button",
        &[("action", json!("@actions.tap"))],
    ));
    tree.apply(&insert_patch("col", "btn"));
    add_text(&mut tree, "btn", "lbl", "Tap");
    let mut text = TextEngine::new();
    let unscrolled = LayoutPass::compute(&tree, &mut text, (400, 200), 1.0);
    let btn_natural_y = find_item(&unscrolled, "btn").rect.y;
    // Choose a scroll offset that puts the button into view.
    let scroll_y = btn_natural_y - 50.0;
    let scrolled = LayoutPass::compute_with_scroll(&tree, &mut text, (400, 200), 1.0, scroll_y);
    let btn = find_item(&scrolled, "btn");
    let cx = btn.rect.x + btn.rect.w / 2.0;
    let cy = btn.rect.y + btn.rect.h / 2.0;
    let hit = scrolled
        .hit(cx, cy)
        .expect("button should be hittable after scroll");
    assert_eq!(hit.node_id, "btn");
}

#[test]
fn input_can_be_hit_focused_but_not_action_hit() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("in", "Input", &[("bind", json!("name"))]));
    tree.apply(&insert_patch("root", "in"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "in");
    let cx = item.rect.x + item.rect.w / 2.0;
    let cy = item.rect.y + item.rect.h / 2.0;
    assert!(
        pass.hit(cx, cy).is_none(),
        "Input must not be returned by hit() — it has no action",
    );
    let focused = pass
        .hit_focusable(cx, cy)
        .expect("Input should be focus-hittable");
    assert_eq!(focused.node_id, "in");
}

// ---------------------------------------------------------------
// End-to-end round-trip: Patches → Tree → LayoutPass.
// Lives here (not tree.rs) because it crosses both layers.
// ---------------------------------------------------------------

#[test]
fn patches_to_layout_full_round_trip() {
    // Build a representative tree using the same Patch types the
    // engine emits in production: Create, Insert, SetProp.
    let patches: Vec<Patch> = vec![
        // Root Column.
        create_patch("col", "Column", &[]),
        insert_patch("root", "col"),
        // Plain Text child.
        create_patch("hdr", "Text", &[("0", json!("Welcome"))]),
        insert_patch("col", "hdr"),
        // Button child wired to an action — created without action,
        // SetProp adds it. Exercises the SetProp side of the API.
        create_patch("btn", "Button", &[]),
        insert_patch("col", "btn"),
        Patch::SetProp {
            id: "btn".into(),
            name: "action".into(),
            value: json!("@actions.save"),
        },
        // Input child with a bind path.
        create_patch(
            "in",
            "Input",
            &[
                ("placeholder", json!("Type here")),
                ("bind", json!("user.name")),
            ],
        ),
        insert_patch("col", "in"),
    ];

    let mut tree = Tree::new();
    tree.apply_batch(&patches);

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    // The tree has 4 user nodes (col, hdr, btn, in) + the implicit
    // outer wrapper, so items.len() ≥ 4. Every emitted node above
    // is renderable.
    assert!(
        pass.items.len() >= 4,
        "expected at least 4 layout items (col, hdr, btn, in); got {}",
        pass.items.len(),
    );

    // Button: ItemKind::Button + resolved action stripped of `@actions.`.
    let btn = find_item(&pass, "btn");
    assert!(matches!(btn.kind, ItemKind::Button));
    assert_eq!(btn.action.as_deref(), Some("save"));

    // Input: bind_path matches what we set; placeholder propagated.
    let input = find_item(&pass, "in");
    match &input.kind {
        ItemKind::Input {
            placeholder,
            bind_path,
            ..
        } => {
            assert_eq!(placeholder.as_deref(), Some("Type here"));
            assert_eq!(bind_path.as_deref(), Some("user.name"));
        }
        other => panic!("expected ItemKind::Input for `in`, got {other:?}"),
    }

    // Header text content survived the patch round-trip.
    let hdr = find_item(&pass, "hdr");
    if let ItemKind::Text { content, .. } = &hdr.kind {
        assert_eq!(content, "Welcome");
    } else {
        panic!("expected ItemKind::Text for `hdr`, got {:?}", hdr.kind);
    }

    // Layout produced a non-zero content rect.
    assert!(
        pass.content_size.0 > 0.0 && pass.content_size.1 > 0.0,
        "expected non-zero content_size, got {:?}",
        pass.content_size,
    );
}

// ---------------------------------------------------------------
// Phase 13: Image element + text-align
// ---------------------------------------------------------------

#[test]
fn parse_text_align_handles_common_values() {
    assert_eq!(parse_text_align(None), TextAlign::Start);
    assert_eq!(parse_text_align(Some("start")), TextAlign::Start);
    assert_eq!(parse_text_align(Some("left")), TextAlign::Start);
    assert_eq!(parse_text_align(Some("center")), TextAlign::Center);
    assert_eq!(parse_text_align(Some("CENTER")), TextAlign::Center);
    assert_eq!(parse_text_align(Some("end")), TextAlign::End);
    assert_eq!(parse_text_align(Some("right")), TextAlign::End);
    // Unknown values fall back to Start rather than panicking.
    assert_eq!(parse_text_align(Some("justify")), TextAlign::Start);
    assert_eq!(parse_text_align(Some("")), TextAlign::Start);
}

#[test]
fn text_align_resolves_through_camel_and_kebab_props() {
    // Two Texts in the same column — first uses .textAlign("center")
    // (camelCase from the applicator), second uses tw-style
    // `text-align: "right"` (kebab from the .tw expander). Both
    // should resolve via the layout's `parse_text_align` path.
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    tree.apply(&create_patch(
        "t_center",
        "Text",
        &[("0", json!("centered")), ("textAlign.0", json!("center"))],
    ));
    tree.apply(&insert_patch("col", "t_center"));
    tree.apply(&create_patch(
        "t_right",
        "Text",
        &[
            ("0", json!("aligned-right")),
            ("text-align", json!("right")),
        ],
    ));
    tree.apply(&insert_patch("col", "t_right"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let centered = find_item(&pass, "t_center");
    match &centered.kind {
        ItemKind::Text { align, .. } => assert_eq!(*align, TextAlign::Center),
        other => panic!("expected ItemKind::Text, got {other:?}"),
    }
    let right = find_item(&pass, "t_right");
    match &right.kind {
        ItemKind::Text { align, .. } => assert_eq!(*align, TextAlign::End),
        other => panic!("expected ItemKind::Text, got {other:?}"),
    }
}

#[test]
fn image_element_emits_image_kind_with_src() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "avatar",
        "Image",
        &[("src", json!("/tmp/some.png"))],
    ));
    tree.apply(&insert_patch("root", "avatar"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "avatar");
    match &item.kind {
        ItemKind::Image { src, .. } => assert_eq!(src.as_deref(), Some("/tmp/some.png")),
        other => panic!("expected ItemKind::Image, got {other:?}"),
    }
}

#[test]
fn image_default_size_when_width_height_unset() {
    // An Image without width/height props uses a sensible default
    // so the layout slot doesn't collapse to zero.
    let mut tree = Tree::new();
    tree.apply(&create_patch("avatar", "Image", &[]));
    tree.apply(&insert_patch("root", "avatar"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "avatar");
    assert!(
        item.rect.w >= DEFAULT_IMAGE_SIZE_PX - 0.5,
        "expected default image width, got {}",
        item.rect.w,
    );
    assert!(
        item.rect.h >= DEFAULT_IMAGE_SIZE_PX - 0.5,
        "expected default image height, got {}",
        item.rect.h,
    );
}

#[test]
fn image_width_percent_resolves_to_parent_width() {
    // A column at 800 px wide containing `Image.width("100%")`
    // should produce an item rect that fills (most of) the column.
    // Take the page padding into account: outer wrapper is 24 px
    // padding on all sides at scale 1, so the image should be
    // close to 800 - 48 = 752 px wide.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "img",
        "Image",
        &[("width", json!("100%")), ("height", json!(120))],
    ));
    tree.apply(&insert_patch("root", "img"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "img");
    assert!(
        item.rect.w >= 700.0,
        "100% width Image should fill its parent column, got rect.w={}",
        item.rect.w,
    );
    assert!((item.rect.h - 120.0).abs() < 0.5, "rect.h={}", item.rect.h);
}

#[test]
fn image_aspect_ratio_drives_height_from_width() {
    // 100% width + aspectRatio 1 → height = width.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "img",
        "Image",
        &[("width", json!("100%")), ("aspectRatio", json!(1.0))],
    ));
    tree.apply(&insert_patch("root", "img"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "img");
    assert!(
        (item.rect.w - item.rect.h).abs() < 1.0,
        "aspectRatio 1 should make square; got {}x{}",
        item.rect.w,
        item.rect.h,
    );
}

#[test]
fn font_weight_numeric_resolves() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "t",
        "Text",
        &[("0", json!("Hello")), ("fontWeight", json!(700))],
    ));
    tree.apply(&insert_patch("root", "t"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    assert_eq!(find_item(&pass, "t").font_weight, 700);
}

#[test]
fn font_weight_named_resolves() {
    // tw `font-semibold` expands to `font-weight: "600"`. Test the
    // string form of `fontWeight` accepts both names and numeric
    // strings.
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    for (id, w_prop, expected) in [
        ("t1", json!("semibold"), 600u16),
        ("t2", json!("bold"), 700),
        ("t3", json!("normal"), 400),
        ("t4", json!("700"), 700),
    ] {
        tree.apply(&create_patch(
            id,
            "Text",
            &[("0", json!("hi")), ("fontWeight", w_prop)],
        ));
        tree.apply(&insert_patch("col", id));
        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
        assert_eq!(
            find_item(&pass, id).font_weight,
            expected,
            "id `{id}` font_weight",
        );
    }
}

#[test]
fn object_fit_resolves_per_token() {
    use crate::layout::ObjectFit;
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    for (id, fit, expected) in [
        ("a", json!("cover"), ObjectFit::Cover),
        ("b", json!("contain"), ObjectFit::Contain),
        ("c", json!("none"), ObjectFit::None),
        ("d", json!("fill"), ObjectFit::Fill),
    ] {
        tree.apply(&create_patch(
            id,
            "Image",
            &[("src", json!("/x.png")), ("objectFit", fit)],
        ));
        tree.apply(&insert_patch("col", id));
        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
        match find_item(&pass, id).kind {
            ItemKind::Image { fit: actual, .. } => {
                assert_eq!(actual, expected, "image `{id}` fit");
            }
            ref other => panic!("expected ItemKind::Image, got {other:?}"),
        }
    }
}

#[test]
fn object_fit_default_is_fill() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("img", "Image", &[("src", json!("/x.png"))]));
    tree.apply(&insert_patch("root", "img"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    match find_item(&pass, "img").kind {
        ItemKind::Image { fit, .. } => {
            assert_eq!(fit, crate::layout::ObjectFit::Fill);
        }
        ref other => panic!("expected ItemKind::Image, got {other:?}"),
    }
}

#[test]
fn stack_overlays_second_child_on_first_with_margin_offset() {
    // Stack pattern: avatar Image + plus-icon overlay. The
    // avatar lays out normally and sizes the Stack; the overlay
    // is absolute and offset via margin → top/left inset, so
    // both end up at the same parent origin instead of stacking
    // vertically.
    let mut tree = Tree::new();
    tree.apply(&create_patch("stack", "Stack", &[]));
    tree.apply(&insert_patch("root", "stack"));
    tree.apply(&create_patch(
        "base",
        "Image",
        &[("width", json!(56)), ("height", json!(56))],
    ));
    tree.apply(&insert_patch("stack", "base"));
    tree.apply(&create_patch(
        "badge",
        "Container",
        &[
            ("width", json!(20)),
            ("height", json!(20)),
            ("marginTop", json!(36)),
            ("marginLeft", json!(36)),
        ],
    ));
    tree.apply(&insert_patch("stack", "badge"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let base = find_item(&pass, "base");
    let badge = find_item(&pass, "badge");
    // Both children share the parent's left edge; badge offsets
    // 36 right + 36 down via marginTop/marginLeft → inset.
    assert!(
        (badge.rect.x - (base.rect.x + 36.0)).abs() < 0.5,
        "badge should be 36 to the right of base; got base.x={}, badge.x={}",
        base.rect.x,
        badge.rect.x,
    );
    assert!(
        (badge.rect.y - (base.rect.y + 36.0)).abs() < 0.5,
        "badge should be 36 below base.y; got base.y={}, badge.y={}",
        base.rect.y,
        badge.rect.y,
    );
}

#[test]
fn absolute_overlay_paints_after_in_flow_sibling() {
    // Story/component.hypen: header Row is `absolute` and declared
    // before the in-flow Image. Emit order must put the Image before
    // the header so the close button isn't covered at paint time.
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    tree.apply(&create_patch(
        "header",
        "Row",
        &[
            ("position", json!("absolute")),
            ("top", json!(0)),
            ("left", json!(0)),
            ("right", json!(0)),
        ],
    ));
    tree.apply(&insert_patch("col", "header"));
    add_text(&mut tree, "header", "close", "✕");
    tree.apply(&create_patch(
        "photo",
        "Image",
        &[("src", json!("/story.png")), ("flex", json!(1))],
    ));
    tree.apply(&insert_patch("col", "photo"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (400, 800), 1.0);
    let photo_idx = pass
        .items
        .iter()
        .position(|it| it.node_id == "photo")
        .expect("photo item");
    let close_idx = pass
        .items
        .iter()
        .position(|it| it.node_id == "close")
        .expect("close text item");
    assert!(
            photo_idx < close_idx,
            "in-flow image must emit before absolute overlay text; photo_idx={photo_idx} close_idx={close_idx}"
        );
}

#[test]
fn taffy_state_apply_patches_builds_tree_incrementally() {
    // Mirror what `App.flush_patches` does: apply patches to
    // the renderer Tree, then to the TaffyState. The follow-up
    // compute should skip the bulk-rebuild path and produce the
    // same items as a from-scratch compute.
    let patches = vec![
        create_patch("col", "Column", &[]),
        insert_patch("root", "col"),
        create_patch("hdr", "Text", &[("0", json!("Header"))]),
        insert_patch("col", "hdr"),
        create_patch("btn", "Button", &[("action", json!("@actions.tap"))]),
        insert_patch("col", "btn"),
    ];
    let mut tree = Tree::new();
    tree.apply_batch(&patches);
    let mut taffy = TaffyState::new();
    let applied = taffy.apply_patches(&patches, &tree, 1.0, vp(800.0));
    assert!(
        applied,
        "all patch types should be handled by apply_patches"
    );

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute_with_state(
        &mut taffy,
        &tree,
        &mut text,
        (800, 600),
        1.0,
        0.0,
        &HashMap::new(),
        1, // tree_generation; unused now since structure_key drops it
    );
    // Items must include the three nodes we created.
    assert!(pass.item_by_id("col").is_some());
    assert!(pass.item_by_id("hdr").is_some());
    assert!(pass.item_by_id("btn").is_some());
}

#[test]
fn taffy_state_setprop_recomputes_node_style_only() {
    // SetProp on `padding` should re-apply the style to that
    // single Taffy node and *not* trigger a bulk rebuild.
    let initial = vec![
        create_patch("box", "Container", &[]),
        insert_patch("root", "box"),
    ];
    let mut tree = Tree::new();
    tree.apply_batch(&initial);
    let mut taffy = TaffyState::new();
    assert!(taffy.apply_patches(&initial, &tree, 1.0, vp(800.0)));

    let setprop = vec![hypen_engine::Patch::SetProp {
        id: "box".into(),
        name: "padding".into(),
        value: json!(40),
    }];
    tree.apply_batch(&setprop);
    assert!(taffy.apply_patches(&setprop, &tree, 1.0, vp(800.0)));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute_with_state(
        &mut taffy,
        &tree,
        &mut text,
        (800, 600),
        1.0,
        0.0,
        &HashMap::new(),
        2,
    );
    // The padding showed up — the box's size reflects the
    // declared 40-on-each-side padding (unconstrained content =
    // ~80 wide / 80 tall minimum).
    let item = pass.item_by_id("box").expect("box laid out");
    assert!(
        item.rect.w >= 80.0 && item.rect.h >= 80.0,
        "padding(40) should produce ≥80×80 rect; got {:?}",
        item.rect,
    );
}

#[test]
fn padding_hover_state_variant_changes_geometry_when_hovered() {
    // End-to-end: a Container with `padding:hover` larger than its
    // base padding produces a larger rect once the interaction
    // snapshot marks it hovered, and the base geometry when not.
    let patches = vec![
        create_patch(
            "box",
            "Container",
            &[("padding.0", json!(8)), ("padding:hover.0", json!(40))],
        ),
        insert_patch("root", "box"),
    ];
    let mut tree = Tree::new();
    tree.apply_batch(&patches);

    // Base (no hover): ~16-tall minimum from padding(8) top+bottom.
    let mut taffy = TaffyState::new();
    assert!(taffy.apply_patches(&patches, &tree, 1.0, vp(800.0)));
    let mut text = TextEngine::new();
    let base = LayoutPass::compute_with_state(
        &mut taffy,
        &tree,
        &mut text,
        (800, 600),
        1.0,
        0.0,
        &HashMap::new(),
        1,
    );
    // The empty Container stretches to full width as a flex child,
    // so height (padding top+bottom = 16) is the unambiguous signal.
    let base_rect = base.item_by_id("box").expect("box laid out").rect;
    assert!(
        (base_rect.h - 16.0).abs() < 0.5,
        "base padding(8) → 16-tall rect; got {base_rect:?}",
    );

    // Hover active on `box`: padding jumps to 40 → 80-tall rect.
    taffy.set_interaction(crate::layout::LayoutInteraction {
        hovered: Some("box".into()),
        ..Default::default()
    });
    let hovered = LayoutPass::compute_with_state(
        &mut taffy,
        &tree,
        &mut text,
        (800, 600),
        1.0,
        0.0,
        &HashMap::new(),
        1,
    );
    let hovered_rect = hovered.item_by_id("box").expect("box laid out").rect;
    assert!(
        (hovered_rect.h - 80.0).abs() < 0.5,
        "padding:hover(40) should produce an 80-tall rect once hovered; got {hovered_rect:?}",
    );

    // Back to no hover → base geometry restored.
    taffy.set_interaction(crate::layout::LayoutInteraction::default());
    let unhovered = LayoutPass::compute_with_state(
        &mut taffy,
        &tree,
        &mut text,
        (800, 600),
        1.0,
        0.0,
        &HashMap::new(),
        1,
    );
    let unhovered_rect = unhovered.item_by_id("box").expect("box laid out").rect;
    assert!(
        (unhovered_rect.h - base_rect.h).abs() < 0.5,
        "leaving hover should restore base geometry; base={base_rect:?} now={unhovered_rect:?}",
    );
}

#[test]
fn padding_hover_only_applies_to_the_hovered_node() {
    // Two boxes, both with `padding:hover`. Hovering one must not
    // inflate the other (per-node active states).
    let patches = vec![
        create_patch(
            "a",
            "Container",
            &[("padding.0", json!(8)), ("padding:hover.0", json!(40))],
        ),
        insert_patch("root", "a"),
        create_patch(
            "b",
            "Container",
            &[("padding.0", json!(8)), ("padding:hover.0", json!(40))],
        ),
        insert_patch("root", "b"),
    ];
    let mut tree = Tree::new();
    tree.apply_batch(&patches);
    let mut taffy = TaffyState::new();
    assert!(taffy.apply_patches(&patches, &tree, 1.0, vp(800.0)));
    taffy.set_interaction(crate::layout::LayoutInteraction {
        hovered: Some("a".into()),
        ..Default::default()
    });
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute_with_state(
        &mut taffy,
        &tree,
        &mut text,
        (800, 600),
        1.0,
        0.0,
        &HashMap::new(),
        1,
    );
    let a = pass.item_by_id("a").expect("a laid out").rect;
    let b = pass.item_by_id("b").expect("b laid out").rect;
    assert!(
        (a.h - 80.0).abs() < 0.5,
        "hovered `a` should inflate; got {a:?}"
    );
    assert!(
        (b.h - 16.0).abs() < 0.5,
        "un-hovered `b` should keep base padding; got {b:?}"
    );
}

#[test]
fn scrollable_true_marks_container_as_scrollable() {
    // `.scrollable(true)` produces a `scrollable: true` prop on
    // the Container. The DSL form is what the social example
    // uses on the HomePage's outer Column; it must read as a
    // scroll container so the wheel handler routes to it and
    // Taffy clips overflow.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "page",
        "Container",
        &[("scrollable", json!(true))],
    ));
    tree.apply(&insert_patch("root", "page"));
    // Add some children so it has content.
    for i in 0..10 {
        let id = format!("c{i}");
        add_text(&mut tree, "page", &id, &format!("row {i}"));
    }
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (400, 200), 1.0);
    let item = find_item(&pass, "page");
    assert!(
        item.scrollable.is_some(),
        "scrollable: true should produce a ScrollMeta — got {:?}",
        item.scrollable,
    );
}

#[test]
fn scrollable_horizontal_marks_container_as_scrollable() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "row",
        "Row",
        &[("scrollable", json!("horizontal"))],
    ));
    tree.apply(&insert_patch("root", "row"));
    // Add wide content.
    for i in 0..5 {
        let id = format!("s{i}");
        tree.apply(&create_patch(
            &id,
            "Image",
            &[("width", json!(100)), ("height", json!(60))],
        ));
        tree.apply(&insert_patch("row", &id));
    }
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (400, 200), 1.0);
    let item = find_item(&pass, "row");
    // `scrollable` recognises horizontal as a scroll container —
    // wheel routing + overflow clipping both kick in via the
    // same is_scrollable_node check.
    assert!(item.scrollable.is_some());
}

#[test]
fn appearance_only_setprop_does_not_dirty_taffy() {
    // SetProp on an appearance-only prop (`color`) should leave
    // the layout geometry unchanged and skip Taffy's set_style
    // path entirely — verified by checking `is_layout_prop`.
    assert!(!crate::layout::is_layout_prop("color"));
    assert!(!crate::layout::is_layout_prop("backgroundColor"));
    assert!(!crate::layout::is_layout_prop("background-color"));
    assert!(!crate::layout::is_layout_prop("borderColor"));
    assert!(!crate::layout::is_layout_prop("src"));
    assert!(!crate::layout::is_layout_prop("textAlign"));
    // Box-model + sizing remain layout-affecting.
    assert!(crate::layout::is_layout_prop("padding"));
    assert!(crate::layout::is_layout_prop("paddingTop"));
    assert!(crate::layout::is_layout_prop("padding-top"));
    assert!(crate::layout::is_layout_prop("borderWidth"));
    assert!(crate::layout::is_layout_prop("borderBottomWidth"));
    assert!(crate::layout::is_layout_prop("width"));
    assert!(crate::layout::is_layout_prop("fontSize"));
    assert!(crate::layout::is_layout_prop("flex"));
    assert!(crate::layout::is_layout_prop("alignItems"));
    // The positional Text content slot drives wrapping.
    assert!(crate::layout::is_layout_prop("0"));
}

#[test]
fn taffy_state_remove_drops_node_from_tree_and_map() {
    let patches = vec![
        create_patch("col", "Column", &[]),
        insert_patch("root", "col"),
        create_patch("a", "Text", &[("0", json!("a"))]),
        insert_patch("col", "a"),
        create_patch("b", "Text", &[("0", json!("b"))]),
        insert_patch("col", "b"),
    ];
    let mut tree = Tree::new();
    tree.apply_batch(&patches);
    let mut taffy = TaffyState::new();
    assert!(taffy.apply_patches(&patches, &tree, 1.0, vp(800.0)));

    let remove = vec![hypen_engine::Patch::Remove {
        id: "a".into(),
        transition: false,
    }];
    tree.apply_batch(&remove);
    assert!(taffy.apply_patches(&remove, &tree, 1.0, vp(800.0)));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute_with_state(
        &mut taffy,
        &tree,
        &mut text,
        (800, 600),
        1.0,
        0.0,
        &HashMap::new(),
        3,
    );
    assert!(pass.item_by_id("a").is_none(), "removed `a` should be gone");
    assert!(pass.item_by_id("b").is_some(), "`b` survives");
}

#[test]
fn grid_resolves_engine_expanded_breakpoint_columns() {
    // The engine expands `.gridColumns({default: 2, md: 3, lg: 4})` into
    // `gridColumns.0` + `gridColumns@md.0` + `gridColumns@lg.0`. The
    // renderer must resolve the active breakpoint from those suffix keys.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "g",
        "Grid",
        &[
            ("gridColumns.0", json!(2)),
            ("gridColumns@md.0", json!(3)),
            ("gridColumns@lg.0", json!(4)),
        ],
    ));
    tree.apply(&insert_patch("root", "g"));
    for i in 0..4 {
        let id = format!("c{i}");
        tree.apply(&create_patch(&id, "Container", &[("height", json!(20))]));
        tree.apply(&insert_patch("g", &id));
    }
    let mut text = TextEngine::new();
    // lg (>=1024) → 4 columns on one row.
    let pass = LayoutPass::compute(&tree, &mut text, (1200, 600), 1.0);
    let xs: Vec<f32> = (0..4)
        .map(|i| pass.item_by_id(&format!("c{i}")).unwrap().rect.x)
        .collect();
    assert!(xs[1] > xs[0] && xs[2] > xs[1] && xs[3] > xs[2], "lg → 4 columns: {xs:?}");
    // sub-md (<768) → 2 columns: 3rd cell wraps under the 1st.
    let pass2 = LayoutPass::compute(&tree, &mut text, (600, 600), 1.0);
    assert_eq!(
        pass2.item_by_id("c0").unwrap().rect.x,
        pass2.item_by_id("c2").unwrap().rect.x,
    );
}

#[test]
fn grid_resolves_responsive_columns_object() {
    // `.gridColumns({default: 2, md: 3, lg: 4})` lands as a single JSON
    // object prop (not `@md` suffix keys). The renderer must pick the
    // value for the active breakpoint instead of falling back to 1
    // column — the "movie grid renders as one full-width column" bug.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "g",
        "Grid",
        &[("gridColumns.0", json!({"default": 2, "md": 3, "lg": 4}))],
    ));
    tree.apply(&insert_patch("root", "g"));
    for i in 0..4 {
        let id = format!("c{i}");
        tree.apply(&create_patch(&id, "Container", &[("height", json!(20))]));
        tree.apply(&insert_patch("g", &id));
    }
    let mut text = TextEngine::new();
    // lg viewport (>=1024) → 4 columns, all on one row (increasing x).
    let pass = LayoutPass::compute(&tree, &mut text, (1200, 600), 1.0);
    let xs: Vec<f32> = (0..4)
        .map(|i| pass.item_by_id(&format!("c{i}")).unwrap().rect.x)
        .collect();
    assert!(
        xs[1] > xs[0] && xs[2] > xs[1] && xs[3] > xs[2],
        "lg breakpoint → 4 columns: {xs:?}"
    );
    // Sub-md viewport (<768) → default 2 columns: the 3rd cell wraps
    // under the 1st (same x).
    let pass2 = LayoutPass::compute(&tree, &mut text, (600, 600), 1.0);
    assert_eq!(
        pass2.item_by_id("c0").unwrap().rect.x,
        pass2.item_by_id("c2").unwrap().rect.x,
        "default 2 columns → 3rd cell wraps under the 1st",
    );
}

#[test]
fn hover_variant_prop_resolves_to_hover_style() {
    // The engine expands tw `hover:bg-[#ff0000]` into a
    // `backgroundColor:hover.0` prop; the layout pass must surface it on
    // `LayoutItem::hover` for the painter to apply while hovered.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "btn",
        "Button",
        &[
            ("backgroundColor:hover.0", json!("#ff0000")),
            ("borderColor:hover.0", json!("#00ff00")),
        ],
    ));
    tree.apply(&insert_patch("root", "btn"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = pass.item_by_id("btn").expect("btn laid out");
    assert_eq!(item.hover.background, Some(crate::style::Rgba(0xff, 0, 0, 0xff)));
    assert_eq!(item.hover.border_color, Some(crate::style::Rgba(0, 0xff, 0, 0xff)));
}

#[test]
fn flex_child_grows_in_plain_row() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("row", "Row", &[("width", json!("100%"))]));
    tree.apply(&insert_patch("root", "row"));
    tree.apply(&create_patch(
        "left",
        "Container",
        &[("width", json!(40)), ("height", json!(20))],
    ));
    tree.apply(&insert_patch("row", "left"));
    tree.apply(&create_patch(
        "mid",
        "Container",
        &[("flex", json!(1)), ("height", json!(20))],
    ));
    tree.apply(&insert_patch("row", "mid"));
    tree.apply(&create_patch(
        "right",
        "Container",
        &[("width", json!(40)), ("height", json!(20))],
    ));
    tree.apply(&insert_patch("row", "right"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (1000, 100), 1.0);
    let mid = pass.item_by_id("mid").expect("mid laid out");
    assert!(
        mid.rect.w > 800.0,
        "plain-row flex(1) should fill; got {}",
        mid.rect.w
    );
}

#[test]
fn flex_child_grows_inside_stack_overlay() {
    // Reproduces the browser chrome: a Stack whose 2nd child (the
    // toolbar overlay, position: absolute) holds a full-width Row
    // with a flex(1) middle child between two fixed buttons. The
    // flex child must fill the row; if the absolute overlay's width
    // doesn't resolve definitely, flex distribution collapses and
    // the middle child shrinks to content (the "URL bar is narrow"
    // bug).
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "stack",
        "Stack",
        &[("width", json!("100%")), ("height", json!("100%"))],
    ));
    tree.apply(&insert_patch("root", "stack"));
    tree.apply(&create_patch(
        "base",
        "Container",
        &[("width", json!("100%"))],
    ));
    tree.apply(&insert_patch("stack", "base"));
    tree.apply(&create_patch(
        "overlay",
        "Column",
        &[("width", json!("100%"))],
    ));
    tree.apply(&insert_patch("stack", "overlay"));
    tree.apply(&create_patch("row", "Row", &[("width", json!("100%"))]));
    tree.apply(&insert_patch("overlay", "row"));
    tree.apply(&create_patch(
        "left",
        "Container",
        &[("width", json!(40)), ("height", json!(20))],
    ));
    tree.apply(&insert_patch("row", "left"));
    tree.apply(&create_patch(
        "mid",
        "Container",
        &[("flex", json!(1)), ("height", json!(20))],
    ));
    tree.apply(&insert_patch("row", "mid"));
    tree.apply(&create_patch(
        "right",
        "Container",
        &[("width", json!(40)), ("height", json!(20))],
    ));
    tree.apply(&insert_patch("row", "right"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (1000, 100), 1.0);
    let mid = pass.item_by_id("mid").expect("mid laid out");
    assert!(
        mid.rect.w > 800.0,
        "flex(1) child under a Stack overlay should fill the 1000px row \
             (minus two 40px buttons); got width {}",
        mid.rect.w,
    );
}

#[test]
fn taffy_state_recreate_existing_id_does_not_orphan_old_node() {
    // Regression: a `Create` for an id already in `node_map` used
    // to allocate a fresh Taffy leaf and overwrite the map entry
    // without freeing the previous NodeId — leaking one full
    // Style + NodeContext per re-Create. A host render loop that
    // rebuilds a subtree would grow the Taffy arena without bound.
    let initial = vec![
        create_patch("col", "Column", &[]),
        insert_patch("root", "col"),
        create_patch("a", "Text", &[("0", json!("a"))]),
        insert_patch("col", "a"),
    ];
    let mut tree = Tree::new();
    tree.apply_batch(&initial);
    let mut taffy = TaffyState::new();
    assert!(taffy.apply_patches(&initial, &tree, 1.0, vp(800.0)));
    let baseline = taffy.total_node_count();

    // Re-Create the same id many times, as a render loop would.
    for _ in 0..50 {
        let recreate = vec![create_patch("a", "Text", &[("0", json!("a"))])];
        tree.apply_batch(&recreate);
        assert!(taffy.apply_patches(&recreate, &tree, 1.0, vp(800.0)));
    }

    assert_eq!(
        taffy.total_node_count(),
        baseline,
        "re-Create of an existing id must free the old Taffy node, not orphan it",
    );
}

#[test]
fn align_items_center_sizes_inner_to_content() {
    // Regression: a Column with `alignItems: "center"` was
    // ignored, so the inner border-container in StoryItem
    // stretched to the parent's full width (default
    // `align-items: stretch`). That made `rounded-full` on a
    // square 60×60 content render around a much wider
    // rectangle, drawing the border as a stadium / ellipse
    // instead of a circle.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "outer",
        "Column",
        &[("alignItems", json!("center"))],
    ));
    tree.apply(&insert_patch("root", "outer"));
    // Container wraps the Image (whose width/height are read).
    tree.apply(&create_patch("ring", "Container", &[]));
    tree.apply(&insert_patch("outer", "ring"));
    tree.apply(&create_patch(
        "img",
        "Image",
        &[("width", json!(60)), ("height", json!(60))],
    ));
    tree.apply(&insert_patch("ring", "img"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let ring = find_item(&pass, "ring");
    // alignItems: center on the outer should let the ring
    // size to its content (60-ish, allowing for 8px default
    // padding zero on Container) instead of stretching to the
    // full viewport width.
    assert!(
        ring.rect.w < 200.0,
        "alignItems: center should not stretch ring to viewport; got rect.w={}",
        ring.rect.w,
    );
    // And the ring should be square-ish (within 1px of its
    // content) — the visible "stretching" of the border ring
    // would manifest as w > 200 on a wide viewport.
    assert!(
        (ring.rect.w - ring.rect.h).abs() < 2.0,
        "ring should be ~square; got {}x{}",
        ring.rect.w,
        ring.rect.h,
    );
}

#[test]
fn justify_content_center_centers_main_axis() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "row",
        "Row",
        &[("justifyContent", json!("center"))],
    ));
    tree.apply(&insert_patch("root", "row"));
    tree.apply(&create_patch(
        "child",
        "Image",
        &[("width", json!(40)), ("height", json!(40))],
    ));
    tree.apply(&insert_patch("row", "child"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let row = find_item(&pass, "row");
    let child = find_item(&pass, "child");
    // Center within row → child x ≈ row.x + (row.w - 40) / 2.
    let expected_x = row.rect.x + (row.rect.w - 40.0) * 0.5;
    assert!(
        (child.rect.x - expected_x).abs() < 1.0,
        "child x should be centered ({expected_x}), got {}",
        child.rect.x,
    );
}

#[test]
fn directional_border_sets_only_those_sides() {
    // Regression: tw `border-b` used to expand to a full
    // `border-width: 1px` (all 4 sides) so every card / divider
    // ended up with a box around it. Now the per-side keys
    // (`border-bottom-width: 1px`) flow through as a `Border`
    // with `sides` bitmask containing only that edge.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "card",
        "Container",
        &[("borderBottomWidth", json!(1))],
    ));
    tree.apply(&insert_patch("root", "card"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "card");
    use crate::style::{BORDER_SIDES_ALL, BORDER_SIDE_BOTTOM};
    assert_eq!(item.border.sides, BORDER_SIDE_BOTTOM);
    assert_ne!(item.border.sides, BORDER_SIDES_ALL);
    assert!(item.border.is_partial());
    assert!(item.border.is_visible());
}

#[test]
fn uniform_border_keeps_sides_all() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "card",
        "Container",
        &[("borderWidth", json!(2))],
    ));
    tree.apply(&insert_patch("root", "card"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "card");
    assert_eq!(item.border.sides, crate::style::BORDER_SIDES_ALL);
    assert!(!item.border.is_partial());
}

#[test]
fn flex_1_text_grows_to_fill_row_without_wrapping() {
    // Regression: tw `flex-1` (which expands to `flex: "1"`) used
    // to be silently dropped by build_subtree, leaving every
    // child at the Taffy default (`grow: 0, shrink: 1, basis:
    // auto`). With sibling `shrink-0` items in a row, the
    // flex-1 text would shrink and wrap mid-word ("Hypengram"
    // → "Hypengra\nm"). Now the title grows to absorb the row's
    // free space and stays on a single line.
    let mut tree = Tree::new();
    tree.apply(&create_patch("row", "Row", &[]));
    tree.apply(&insert_patch("root", "row"));
    tree.apply(&create_patch(
        "title",
        "Text",
        &[("0", json!("Hypengram")), ("flex", json!("1"))],
    ));
    tree.apply(&insert_patch("row", "title"));
    tree.apply(&create_patch(
        "btn",
        "Button",
        &[("flexShrink", json!(0)), ("action", json!("@actions.tap"))],
    ));
    tree.apply(&insert_patch("row", "btn"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let title = find_item(&pass, "title");
    let btn = find_item(&pass, "btn");
    // Title should be wide enough to dominate the row — at least
    // 10x the natural "Hypengram" width.
    assert!(
        title.rect.w > btn.rect.w,
        "flex-1 title ({}) should be wider than shrink-0 button ({})",
        title.rect.w,
        btn.rect.w,
    );
}

#[test]
fn flex_none_keeps_intrinsic_width() {
    // `flex: "none"` opts out of growing AND shrinking — the
    // child stays at its content size even in a tightly-packed
    // row.
    let mut tree = Tree::new();
    tree.apply(&create_patch("row", "Row", &[]));
    tree.apply(&insert_patch("root", "row"));
    tree.apply(&create_patch(
        "tag",
        "Text",
        &[("0", json!("ok")), ("flex", json!("none"))],
    ));
    tree.apply(&insert_patch("row", "tag"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let tag = find_item(&pass, "tag");
    // "ok" at default font size is small. With flex: none the
    // item should NOT stretch to fill the row.
    assert!(
        tag.rect.w < 200.0,
        "flex: none should keep tight width, got {}",
        tag.rect.w
    );
}

#[test]
fn icon_size_applicator_sets_both_width_and_height() {
    // `.size(N)` is the canonical Hypen applicator for square
    // glyphs (the web Icon component reads it directly). The
    // desktop renderer used to ignore it, so every `.size(24)`
    // icon laid out at the 60px DEFAULT_IMAGE_SIZE_PX default
    // and ate header space. Phase 16 fix: size resolves into
    // both width and height when neither is explicitly set.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "heart",
        "Icon",
        &[
            ("__iconPaths", json!([{"d": "M5 12h14"}])),
            ("size", json!(24)),
        ],
    ));
    tree.apply(&insert_patch("root", "heart"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "heart");
    assert!(
        (item.rect.w - 24.0).abs() < 0.5 && (item.rect.h - 24.0).abs() < 0.5,
        "expected 24x24 from .size(24), got {}x{}",
        item.rect.w,
        item.rect.h,
    );
}

#[test]
fn explicit_width_overrides_size_applicator() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "thumb",
        "Image",
        &[("size", json!(24)), ("width", json!(48))],
    ));
    tree.apply(&insert_patch("root", "thumb"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "thumb");
    assert!((item.rect.w - 48.0).abs() < 0.5, "rect.w={}", item.rect.w);
    assert!((item.rect.h - 24.0).abs() < 0.5, "rect.h={}", item.rect.h);
}

#[test]
fn image_explicit_width_height_resolve_through_layout() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "thumb",
        "Image",
        &[("width.0", json!(120)), ("height.0", json!(80))],
    ));
    tree.apply(&insert_patch("root", "thumb"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "thumb");
    assert!((item.rect.w - 120.0).abs() < 0.5, "rect.w={}", item.rect.w);
    assert!((item.rect.h - 80.0).abs() < 0.5, "rect.h={}", item.rect.h);
}

#[test]
fn icon_without_paths_falls_back_to_image_kind() {
    // No `paths` prop → `Icon` shapes the same as `Image` (the
    // bitmap path). Source string flows through unchanged.
    let mut tree = Tree::new();
    tree.apply(&create_patch("home", "Icon", &[("src", json!("home"))]));
    tree.apply(&insert_patch("root", "home"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "home");
    assert!(matches!(item.kind, ItemKind::Image { .. }));
}

#[test]
fn icon_with_engine_resolved_paths_emits_icon_kind() {
    // The engine resolves `Icon(@resources.heart)` into
    // structured `paths` + `viewBox` props. When those land,
    // layout picks the vector ItemKind::Icon path so the
    // painter rasterises the SVG instead of treating it as a
    // bitmap.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "heart",
        "Icon",
        &[
            (
                "paths",
                json!([
                    {
                        "d": "M5 12h14",
                        "fill": "none",
                        "stroke": "#1a1a1f",
                        "strokeWidth": 2.0,
                    }
                ]),
            ),
            ("viewBox", json!("0 0 24 24")),
        ],
    ));
    tree.apply(&insert_patch("root", "heart"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "heart");
    match &item.kind {
        ItemKind::Icon {
            paths,
            view_box,
            tint,
        } => {
            assert_eq!(paths.len(), 1);
            assert_eq!(paths[0].d, "M5 12h14");
            assert_eq!(*view_box, (0.0, 0.0, 24.0, 24.0));
            assert!(tint.is_none());
        }
        other => panic!("expected ItemKind::Icon, got {other:?}"),
    }
}

#[test]
fn button_with_explicit_border_zero_does_not_get_default_stroke() {
    // Regression: `.tw("border-0")` expands to `borderWidth: 0`.
    // The Button branch used to fall back to its default stroke
    // because `Border::is_visible()` returned false, so explicit
    // opt-out got silently overridden.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "iconbtn",
        "Button",
        &[
            ("action", json!("@actions.tap")),
            ("borderWidth", json!(0.0)),
            ("backgroundColor", json!("transparent")),
        ],
    ));
    tree.apply(&insert_patch("root", "iconbtn"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "iconbtn");
    assert!(
        !item.border.is_visible(),
        "explicit borderWidth: 0 must not produce a visible default border, got {:?}",
        item.border,
    );
    // Background must respect the user's transparent.
    assert_eq!(item.background, Some(Rgba::TRANSPARENT));
}

#[test]
fn button_without_any_border_prop_has_no_implicit_stroke() {
    // Buttons no longer inject demo chrome; bare buttons stay
    // borderless until the DSL sets `.border*` / `.tw("border-...")`.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "btn",
        "Button",
        &[("action", json!("@actions.tap"))],
    ));
    tree.apply(&insert_patch("root", "btn"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "btn");
    assert!(
        !item.border.is_visible(),
        "Button with no border props must not get an implicit stroke",
    );
    assert_eq!(item.background, None);
}

// ---------------------------------------------------------------
// Phase 16: per-Container scrolling
// ---------------------------------------------------------------

fn build_scrollable_column(rows: usize, overflow_prop: &str) -> Tree {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "scroller",
        "Container",
        &[(overflow_prop, json!("scroll"))],
    ));
    tree.apply(&insert_patch("root", "scroller"));
    for i in 0..rows {
        let id = format!("r{i}");
        add_text(&mut tree, "scroller", &id, &format!("row {i}"));
    }
    tree
}

#[test]
fn container_with_overflow_scroll_is_marked_scrollable() {
    let tree = build_scrollable_column(20, "overflow");
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (400, 200), 1.0);
    let item = find_item(&pass, "scroller");
    let meta = item
        .scrollable
        .expect("Container with overflow:scroll should be scrollable");
    assert!(
        meta.content_h > 0.0,
        "expected ScrollMeta.content_h > 0, got {}",
        meta.content_h,
    );
}

#[test]
fn container_with_overflow_y_auto_is_marked_scrollable() {
    let tree = build_scrollable_column(20, "overflowY");
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (400, 200), 1.0);
    let item = find_item(&pass, "scroller");
    assert!(item.scrollable.is_some());
}

#[test]
fn container_without_overflow_is_not_scrollable() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("box", "Container", &[]));
    tree.apply(&insert_patch("root", "box"));
    add_text(&mut tree, "box", "t", "hi");
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (400, 600), 1.0);
    assert!(find_item(&pass, "box").scrollable.is_none());
}

#[test]
fn per_container_scroll_shifts_descendants_only() {
    // Apply a per-container scroll; the container's own rect should
    // stay put but its descendants should shift up.
    let tree = build_scrollable_column(20, "overflow");
    let mut text = TextEngine::new();
    let unscrolled = LayoutPass::compute(&tree, &mut text, (400, 200), 1.0);
    let container_unscrolled = find_item(&unscrolled, "scroller").rect.y;
    let r0_unscrolled = find_item(&unscrolled, "r0").rect.y;

    let mut scrolls = HashMap::new();
    scrolls.insert("scroller".to_string(), 50.0);
    let scrolled =
        LayoutPass::compute_with_scrolls(&tree, &mut text, (400, 200), 1.0, 0.0, &scrolls);
    let container_scrolled = find_item(&scrolled, "scroller").rect.y;
    let r0_scrolled = find_item(&scrolled, "r0").rect.y;

    assert!(
            (container_unscrolled - container_scrolled).abs() < 0.5,
            "container y must not move: unscrolled={container_unscrolled}, scrolled={container_scrolled}",
        );
    let dy = r0_unscrolled - r0_scrolled;
    assert!(
        (dy - 50.0).abs() < 0.5,
        "expected descendant -50 shift, got {dy}",
    );
}

#[test]
fn page_scroll_and_container_scroll_compose() {
    let tree = build_scrollable_column(30, "overflow");
    let mut text = TextEngine::new();
    let mut scrolls = HashMap::new();
    scrolls.insert("scroller".to_string(), 20.0);
    let pass = LayoutPass::compute_with_scrolls(&tree, &mut text, (400, 200), 1.0, 10.0, &scrolls);
    let baseline = LayoutPass::compute(&tree, &mut text, (400, 200), 1.0);
    // Container shifts by page scroll only.
    let cd = find_item(&baseline, "scroller").rect.y - find_item(&pass, "scroller").rect.y;
    assert!(
        (cd - 10.0).abs() < 0.5,
        "container should shift by 10 (page only), got {cd}",
    );
    // Descendants shift by page + container = 30.
    let dd = find_item(&baseline, "r0").rect.y - find_item(&pass, "r0").rect.y;
    assert!(
        (dd - 30.0).abs() < 0.5,
        "descendant should shift by 30 (page+container), got {dd}",
    );
}

#[test]
fn content_size_uses_natural_bounds_not_scrolled() {
    // With per-container scroll active, descendants' shifted y
    // could fool a naive content_size calculation. Verify it
    // tracks natural extents instead.
    let tree = build_scrollable_column(30, "overflow");
    let mut text = TextEngine::new();
    let baseline = LayoutPass::compute(&tree, &mut text, (400, 200), 1.0);
    let mut scrolls = HashMap::new();
    scrolls.insert("scroller".to_string(), 100.0);
    let scrolled =
        LayoutPass::compute_with_scrolls(&tree, &mut text, (400, 200), 1.0, 0.0, &scrolls);
    assert!(
        (baseline.content_size.1 - scrolled.content_size.1).abs() < 0.5,
        "content_size.1 must be invariant of per-container scroll: baseline={}, scrolled={}",
        baseline.content_size.1,
        scrolled.content_size.1,
    );
}

#[test]
fn icon_with_engine_prefixed_props_emits_icon_kind() {
    // The engine emits `__iconPaths` + `__iconViewBox` (the
    // double-underscore is its convention for renderer-only
    // synthetic props). Every other renderer reads those names;
    // the desktop renderer used to read plain `paths` and
    // silently fell back to a bitmap placeholder for every
    // engine-resolved icon. Regression: now both forms work.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "heart",
        "Icon",
        &[
            (
                "__iconPaths",
                json!([
                    {
                        "d": "M5 12h14",
                        "fill": "none",
                        "stroke": "#1a1a1f",
                        "strokeWidth": 2.0,
                    }
                ]),
            ),
            ("__iconViewBox", json!("0 0 24 24")),
        ],
    ));
    tree.apply(&insert_patch("root", "heart"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "heart");
    match &item.kind {
        ItemKind::Icon {
            paths, view_box, ..
        } => {
            assert_eq!(paths.len(), 1);
            assert_eq!(*view_box, (0.0, 0.0, 24.0, 24.0));
        }
        other => panic!("expected ItemKind::Icon, got {other:?}"),
    }
}

#[test]
fn icon_color_prop_becomes_tint() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "icon",
        "Icon",
        &[
            ("paths", json!([{"d": "M0 0 L10 10"}])),
            ("color.0", json!("red")),
        ],
    ));
    tree.apply(&insert_patch("root", "icon"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "icon");
    match &item.kind {
        ItemKind::Icon { tint, .. } => {
            assert_eq!(*tint, Some(Rgba(0xff, 0, 0, 0xff)));
        }
        other => panic!("expected ItemKind::Icon, got {other:?}"),
    }
}

// -----------------------------------------------------------------
// clip_to: scrollable-container descendants get clipped to the
// container's rect so they don't bleed onto siblings above /
// below the container when scrolled. Regression for the
// "input visible in the grid gaps" bug in examples/social/Search.
// -----------------------------------------------------------------

#[test]
fn scrollable_container_emits_clip_to_on_descendants() {
    // Tree shape mirrors examples/social/Search:
    //   Column
    //     Input               ← outside the scrollable, no clip_to
    //     Container .scrollable(true)   ← scrollable, no clip_to (its own rect)
    //       Text                ← inside scrollable, clip_to = container's rect
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    tree.apply(&create_patch("input", "Input", &[("bind", json!("name"))]));
    tree.apply(&insert_patch("col", "input"));
    tree.apply(&create_patch(
        "grid",
        "Container",
        &[("scrollable.0", json!(true))],
    ));
    tree.apply(&insert_patch("col", "grid"));
    add_text(&mut tree, "grid", "post", "post body");

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let input = find_item(&pass, "input");
    assert!(
        input.clip_to.is_none(),
        "Input is outside the scrollable; it must have no clip_to (it shouldn't \
             get clipped to a parent that doesn't contain it)",
    );

    let grid = find_item(&pass, "grid");
    assert!(
        grid.scrollable.is_some(),
        "Container with scrollable.0=true must be scrollable"
    );
    assert!(
        grid.clip_to.is_none(),
        "The scrollable container itself has parent_clip_to = None (its own rect is \
             the clip handed *down*; clipping a container to itself would crop its border)",
    );

    let post = find_item(&pass, "post");
    let clip = post
        .clip_to
        .expect("descendant of scrollable container must carry the container's rect as clip_to");
    // Field-by-field — `Rect` doesn't derive PartialEq (f32 NaN
    // semantics make a blanket derive risky for a public type).
    assert!(
        (clip.x - grid.rect.x).abs() < 0.5
            && (clip.y - grid.rect.y).abs() < 0.5
            && (clip.w - grid.rect.w).abs() < 0.5
            && (clip.h - grid.rect.h).abs() < 0.5,
        "clip_to on a scrollable descendant must equal the container's rect; \
             grid={:?} clip={:?}",
        grid.rect,
        clip,
    );
}

#[test]
fn scrollable_clip_to_shifts_with_page_scroll() {
    // Same shape as above; assert that when `compute_with_scroll`
    // subtracts a page-scroll offset, *both* the container's
    // rect AND its descendants' clip_to shift in lockstep —
    // otherwise the clip drifts away from the items it's meant
    // to clip.
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    tree.apply(&create_patch(
        "grid",
        "Container",
        &[("scrollable.0", json!(true))],
    ));
    tree.apply(&insert_patch("col", "grid"));
    add_text(&mut tree, "grid", "post", "post body");

    let mut text = TextEngine::new();
    let scroll_y: f32 = 40.0;
    let pass = LayoutPass::compute_with_scroll(&tree, &mut text, (800, 600), 1.0, scroll_y);

    let grid = find_item(&pass, "grid");
    let post = find_item(&pass, "post");
    let clip = post.clip_to.expect("descendant must have clip_to");
    // The container's rect AND the descendant's clip_to must
    // have the same y-coord (both shifted by page scroll); the
    // painter uses clip_to directly so any drift here would
    // re-introduce the bleed.
    assert!(
        (clip.y - grid.rect.y).abs() < 0.5,
        "clip_to.y must track grid.rect.y after page scroll; \
             grid={:?} clip={:?} (scroll_y={scroll_y})",
        grid.rect,
        clip,
    );
}

#[test]
fn non_scrollable_container_does_not_emit_clip_to() {
    // A regular Container (no `.scrollable(...)`) doesn't clip
    // its descendants. Verifies we don't over-eagerly attach
    // `clip_to` to every Container's children — only when the
    // ancestor is explicitly scrollable. The original cause of
    // bleed-bug regressions like this is "I applied the fix
    // everywhere" creating new clip layers that crop legitimate
    // overflow (e.g. focus rings, shadows that intentionally
    // extend past the parent).
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    add_text(&mut tree, "col", "t1", "First");

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let t1 = find_item(&pass, "t1");
    assert!(
        t1.clip_to.is_none(),
        "Text inside a non-scrollable Column must have no clip_to",
    );
}

// -----------------------------------------------------------------
// clip_to is enforced in HIT-TESTING, not just paint (pixel/hit
// parity, constraint #5). Paint pushes the scrollable ancestor's
// `clip_to` (vello_painter::draw_item / push_outer_clip), so an item
// scrolled or transformed past that clip is invisible — and must
// therefore be unhittable, or a click on empty space would activate a
// control the user cannot see.
// -----------------------------------------------------------------

/// Minimal actionable `LayoutItem`, with an optional viewport-space
/// `clip_to` and a transform, registered so `hit()` considers it.
fn actionable_clip_item(
    id: &str,
    rect: Rect,
    clip_to: Option<Rect>,
    transform: Affine2,
) -> LayoutItem {
    LayoutItem {
        node_id: id.to_string(),
        kind: ItemKind::Container,
        rect,
        action: Some("tap".to_string()),
        action_payload: None,
        hover_action: None,
        hover_payload: None,
        video_intent: None,
        background: None,
        hover: HoverStyle::default(),
        border: crate::style::Border::default(),
        scrollable: None,
        font_weight: 400,
        clip_to,
        subtree_root: None,
        background_gradient: None,
        background_layers: None,
        background_image: None,
        state_variants: crate::style::StateVariants::default(),
        opacity: 1.0,
        transform,
    }
}

fn single_actionable_pass(item: LayoutItem) -> LayoutPass {
    let mut by_node_id = std::collections::HashMap::new();
    by_node_id.insert(item.node_id.clone(), 0usize);
    LayoutPass {
        items: vec![item],
        content_size: (0.0, 0.0),
        by_node_id,
        actionable_ids: vec![0],
        focusable_ids: vec![0],
        scrollable_ids: vec![],
        hoverable_ids: vec![0],
        a11y: std::collections::HashMap::new(),
            a11y_hash: 0,
    }
}

#[test]
fn hit_misses_in_clipped_away_region_hits_in_visible_region() {
    // An actionable spanning y∈[30,90], clipped to y<50 by its
    // scrollable ancestor: y∈[30,50) is painted (visible), y∈[50,90) is
    // cropped away (invisible).
    let rect = Rect {
        x: 0.0,
        y: 30.0,
        w: 100.0,
        h: 60.0,
    };
    let clip = Rect {
        x: 0.0,
        y: 0.0,
        w: 100.0,
        h: 50.0,
    };
    let pass = single_actionable_pass(actionable_clip_item(
        "btn",
        rect,
        Some(clip),
        Affine2::IDENTITY,
    ));
    assert_eq!(
        pass.hit(50.0, 40.0).map(|it| it.node_id.as_str()),
        Some("btn"),
        "a click in the VISIBLE (unclipped) part of the item hits it",
    );
    assert!(
        pass.hit(50.0, 70.0).is_none(),
        "a click in the CLIPPED-AWAY (painted-nothing) part must miss — it is \
         inside the rect but outside the clip the painter cropped to",
    );
    // Every hit lane shares hit_contains, so hover/focus/scroll agree.
    assert!(pass.hit_hoverable(50.0, 70.0).is_none());
    assert!(pass.hit_focusable(50.0, 70.0).is_none());
    // Sanity: without the clip that exact point is a plain rect hit —
    // proving the clip, not the rect, is what rejects it.
    let unclipped =
        single_actionable_pass(actionable_clip_item("btn", rect, None, Affine2::IDENTITY));
    assert_eq!(
        unclipped.hit(50.0, 70.0).map(|it| it.node_id.as_str()),
        Some("btn"),
        "with no clip the same point falls inside the rect and hits",
    );
}

#[test]
fn transform_pushing_item_wholly_outside_its_clip_is_unhittable() {
    // Native rect sits inside the clip, but a +200px downward transform
    // paints the whole item below the clip's bottom edge (y<50) — the
    // painter shows nothing, so NO viewport point may hit it.
    let rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 100.0,
        h: 40.0,
    };
    let clip = Rect {
        x: 0.0,
        y: 0.0,
        w: 100.0,
        h: 50.0,
    };
    let pass = single_actionable_pass(actionable_clip_item(
        "btn",
        rect,
        Some(clip),
        Affine2::translate(0.0, 200.0),
    ));
    // Where the transformed pixels would land (y≈220): outside the clip.
    assert!(
        pass.hit(50.0, 220.0).is_none(),
        "the transformed item paints at y≈220, outside the clip — nothing there to hit",
    );
    // Where the untransformed rect used to be (y≈20): inside the clip,
    // but the transform-inverse maps it out of the rect — nothing painted.
    assert!(
        pass.hit(50.0, 20.0).is_none(),
        "the item vacated its original slot (translated away) — no hit there either",
    );
}

// -----------------------------------------------------------------
// .onHover applicator
// -----------------------------------------------------------------

#[test]
fn on_hover_populates_hover_action_on_non_actionable_container() {
    // `.onHover(@actions.island_hover, target: "island")` on a
    // bare Container should make it hover-trackable even though
    // Container isn't in ACTIONABLE_TYPES. The static `target`
    // arg lives on `hover_payload`; `hovered:` is appended at
    // dispatch time.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "ctn",
        "Container",
        &[
            ("onHover.0", json!("@actions.island_hover")),
            ("onHover.target", json!("island")),
        ],
    ));
    tree.apply(&insert_patch("root", "ctn"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let ctn = find_item(&pass, "ctn");
    assert_eq!(ctn.hover_action.as_deref(), Some("island_hover"));
    let payload = ctn
        .hover_payload
        .as_ref()
        .expect("static onHover args must populate hover_payload");
    assert_eq!(payload.get("target"), Some(&json!("island")));
    assert!(
        !payload.as_object().unwrap().contains_key("hovered"),
        "hovered must NOT be baked in at layout time; window adds it",
    );
    // The id index includes it.
    assert!(
        pass.hoverable_ids
            .iter()
            .any(|&i| pass.items[i].node_id == "ctn"),
        "hover-trackable item should be in hoverable_ids",
    );
}

#[test]
fn on_hover_without_args_leaves_hover_payload_empty() {
    // Bare `.onHover(@actions.foo)` should still register but
    // produce `hover_payload: None`. The window's dispatch wraps
    // it in an object with just `{hovered: bool}`.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "btn",
        "Button",
        &[("onHover.0", json!("@actions.foo"))],
    ));
    tree.apply(&insert_patch("root", "btn"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let btn = find_item(&pass, "btn");
    assert_eq!(btn.hover_action.as_deref(), Some("foo"));
    assert!(btn.hover_payload.is_none());
}

#[test]
fn hit_hoverable_finds_topmost_hover_subject_under_cursor() {
    // Two siblings, both hover-tracked; the second is painted on
    // top so it wins the hit test. Mirrors `hit()`'s reverse
    // iteration semantics for actionables.
    let mut tree = Tree::new();
    tree.apply(&create_patch("stack", "Stack", &[]));
    tree.apply(&insert_patch("root", "stack"));
    tree.apply(&create_patch(
        "back",
        "Container",
        &[
            ("onHover.0", json!("@actions.h")),
            ("width", json!(400)),
            ("height", json!(400)),
        ],
    ));
    tree.apply(&insert_patch("stack", "back"));
    tree.apply(&create_patch(
        "front",
        "Container",
        &[
            ("onHover.0", json!("@actions.h")),
            ("width", json!(100)),
            ("height", json!(100)),
        ],
    ));
    tree.apply(&insert_patch("stack", "front"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    // Stack puts subsequent children at the parent's top-left,
    // so `front` sits on top of `back` at (0, 0). Anywhere inside
    // front's 100×100 rect should hit `front`.
    let hit = pass.hit_hoverable(50.0, 50.0).expect("hit");
    assert_eq!(hit.node_id, "front", "topmost hover subject must win");
}

#[test]
fn resolve_hover_payload_strips_author_supplied_hovered_flag() {
    // A DSL author who wrote `.onHover(@actions.x, hovered: true)`
    // would otherwise see their static value clobber the runtime
    // bool. `resolve_hover_payload` filters it out so the window
    // is always authoritative for the on/off transition.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "ctn",
        "Container",
        &[
            ("onHover.0", json!("@actions.x")),
            ("onHover.hovered", json!(true)),
            ("onHover.target", json!("island")),
        ],
    ));
    tree.apply(&insert_patch("root", "ctn"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let ctn = find_item(&pass, "ctn");
    let payload = ctn.hover_payload.as_ref().unwrap();
    assert_eq!(payload.get("target"), Some(&json!("island")));
    assert!(
        payload.as_object().unwrap().get("hovered").is_none(),
        "the author's hovered: literal must be stripped",
    );
}

// ---------------------------------------------------------------
// Focus traversal exclusion (exit-animating subtrees leave the Tab
// order the moment their exit begins)
// ---------------------------------------------------------------

#[test]
fn focus_walk_skips_excluded_ids() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    for id in ["b1", "b2", "b3"] {
        tree.apply(&create_patch(id, "Button", &[("action", json!("@actions.x"))]));
        tree.apply(&insert_patch("col", id));
    }
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    // No-op predicate matches the plain walk exactly.
    assert_eq!(pass.focus_next(None), Some("b1".into()));
    assert_eq!(pass.focus_next_excluding(None, &|_| false), Some("b1".into()));
    // Excluded ids are skipped, continuing to the next candidate…
    assert_eq!(pass.focus_next_excluding(None, &|id| id == "b1"), Some("b2".into()));
    assert_eq!(
        pass.focus_next_excluding(Some("b1"), &|id| id == "b2"),
        Some("b3".into())
    );
    // …including across the wrap.
    assert_eq!(
        pass.focus_next_excluding(Some("b3"), &|id| id == "b1"),
        Some("b2".into())
    );
    assert_eq!(
        pass.focus_prev_excluding(Some("b3"), &|id| id == "b2"),
        Some("b1".into())
    );
    assert_eq!(
        pass.focus_prev_excluding(Some("b1"), &|id| id == "b3"),
        Some("b2".into())
    );
    // Every focusable excluded: None, never an infinite walk.
    assert_eq!(pass.focus_next_excluding(Some("b1"), &|_| true), None);
    assert_eq!(pass.focus_prev_excluding(None, &|_| true), None);
}

// ---------------------------------------------------------------
// Effective-opacity gate must open for variant-decorated keys
// ---------------------------------------------------------------

#[test]
fn decorated_opacity_key_opens_the_paint_gate() {
    // A node styled ONLY by a breakpoint-decorated opacity key: the
    // effective-opacity pass must still run (an exact-key gate left
    // such a node painting fully opaque while `effective_opacity`
    // itself resolves the decorated key fine).
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "col",
        "Column",
        &[("opacity@md.0", json!(0.5))],
    ));
    tree.apply(&insert_patch("root", "col"));
    add_text(&mut tree, "col", "t", "faded");

    let mut text = TextEngine::new();
    // 800px viewport ≥ the 768px `md` threshold → the variant is active.
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let col = find_item(&pass, "col");
    let t = find_item(&pass, "t");
    assert!((col.opacity - 0.5).abs() < 1e-6, "decorated key must gate in: {}", col.opacity);
    assert!((t.opacity - 0.5).abs() < 1e-6, "children inherit the decorated value");
}

// -----------------------------------------------------------------
// Per-item transforms: static translateX/translateY/scale/rotate props
// compose into `LayoutItem::transform`, and every hit path reads the
// transformed geometry (constraint #5: pixels and hit targets agree).
// -----------------------------------------------------------------

#[test]
fn static_translate_props_move_the_hit_target() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    tree.apply(&create_patch(
        "btn",
        "Button",
        &[
            ("action", json!("@actions.go")),
            ("width.0", json!(100.0)),
            ("height.0", json!(40.0)),
            ("translateX.0", json!(200.0)),
            ("translateY.0", json!(50.0)),
        ],
    ));
    tree.apply(&insert_patch("col", "btn"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let btn = find_item(&pass, "btn");
    assert!(!btn.transform.is_identity(), "static transform props light up");
    // Layout rect is untouched (transforms are paint/hit-only)...
    assert!(btn.rect.x < 10.0, "Taffy geometry unmoved: {:?}", btn.rect);
    // ...but the hit target follows the pixels: the untransformed
    // position misses, the translated one hits.
    let (cx, cy) = (btn.rect.x + 50.0, btn.rect.y + 20.0);
    assert!(pass.hit(cx, cy).is_none(), "old position must not hit");
    let hit = pass.hit(cx + 200.0, cy + 50.0).expect("translated position hits");
    assert_eq!(hit.node_id, "btn");
    // Visual rect is the translated AABB.
    let vr = btn.visual_rect();
    assert!((vr.x - (btn.rect.x + 200.0)).abs() < 0.5);
    assert!((vr.y - (btn.rect.y + 50.0)).abs() < 0.5);
}

#[test]
fn scale_transforms_hit_about_the_box_center() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    tree.apply(&create_patch(
        "btn",
        "Button",
        &[
            ("action", json!("@actions.go")),
            ("width.0", json!(100.0)),
            ("height.0", json!(100.0)),
            ("scale.0", json!(0.5)),
        ],
    ));
    tree.apply(&insert_patch("col", "btn"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let btn = find_item(&pass, "btn");
    let (cx, cy) = (btn.rect.x + 50.0, btn.rect.y + 50.0);
    // Center is the transform origin — always inside.
    assert!(pass.hit(cx, cy).is_some(), "center still hits at 0.5×");
    // A point 40px from center was inside the unscaled box but is
    // outside the half-size box (which extends only 25px from center).
    assert!(pass.hit(cx + 40.0, cy).is_none(), "outside the scaled box");
    assert!(pass.hit(cx + 20.0, cy).is_some(), "inside the scaled box");
    // Visual rect shrinks about the center.
    let vr = btn.visual_rect();
    assert!((vr.w - 50.0).abs() < 0.5 && (vr.h - 50.0).abs() < 0.5);
    assert!((vr.x - (btn.rect.x + 25.0)).abs() < 0.5);
}

#[test]
fn rotate_transforms_hit_and_degenerate_scale_is_unhittable() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    // A wide flat button rotated 90°: its long axis becomes vertical.
    tree.apply(&create_patch(
        "rot",
        "Button",
        &[
            ("action", json!("@actions.rot")),
            ("width.0", json!(200.0)),
            ("height.0", json!(20.0)),
            ("rotate.0", json!(90.0)),
        ],
    ));
    tree.apply(&insert_patch("col", "rot"));
    tree.apply(&create_patch(
        "gone",
        "Button",
        &[
            ("action", json!("@actions.gone")),
            ("width.0", json!(100.0)),
            ("height.0", json!(100.0)),
            ("scale.0", json!(0.0)),
        ],
    ));
    tree.apply(&insert_patch("col", "gone"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let rot = find_item(&pass, "rot");
    let (cx, cy) = (rot.rect.x + 100.0, rot.rect.y + 10.0);
    // 90° about center: a point 80px right of center (inside the
    // unrotated long axis) now misses; 80px BELOW center hits.
    assert!(pass.hit(cx + 80.0, cy).is_none(), "unrotated axis misses");
    let hit = pass.hit(cx, cy + 80.0).expect("rotated axis hits");
    assert_eq!(hit.node_id, "rot");
    // Rotated visual AABB swaps the axes (200×20 → 20×200).
    let vr = rot.visual_rect();
    assert!((vr.w - 20.0).abs() < 0.5 && (vr.h - 200.0).abs() < 0.5);
    // Degenerate scale(0): nothing hittable anywhere on the item.
    let gone = find_item(&pass, "gone");
    let (gx, gy) = (gone.rect.x + 50.0, gone.rect.y + 50.0);
    assert!(!gone.hit_contains(gx, gy), "scale(0) is unhittable");
}

#[test]
fn nested_transforms_compose_down_the_tree() {
    let mut tree = Tree::new();
    // Parent translated +100 x; child rotated 90° about its own center.
    tree.apply(&create_patch(
        "wrap",
        "Column",
        &[("translateX.0", json!(100.0))],
    ));
    tree.apply(&insert_patch("root", "wrap"));
    tree.apply(&create_patch(
        "btn",
        "Button",
        &[
            ("action", json!("@actions.n")),
            ("width.0", json!(200.0)),
            ("height.0", json!(20.0)),
            ("rotate.0", json!(90.0)),
        ],
    ));
    tree.apply(&insert_patch("wrap", "btn"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let btn = find_item(&pass, "btn");
    // The child's rotation happens about its own (untranslated layout)
    // center, then the parent's translate carries it +100 x.
    let (cx, cy) = (btn.rect.x + 100.0, btn.rect.y + 10.0);
    assert!(pass.hit(cx + 100.0, cy + 80.0).is_some(), "translated+rotated point hits");
    assert!(pass.hit(cx, cy + 80.0).is_none(), "un-translated rotated point misses");
    assert!(pass.hit(cx + 100.0 + 80.0, cy).is_none(), "un-rotated translated point misses");
    // Container (wrap) itself carries a plain translate.
    let wrap = find_item(&pass, "wrap");
    let wr = wrap.visual_rect();
    assert!((wr.x - (wrap.rect.x + 100.0)).abs() < 0.5);
}

#[test]
fn transform_free_tree_keeps_identity_and_plain_hits() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    tree.apply(&create_patch(
        "btn",
        "Button",
        &[("action", json!("@actions.go")), ("width.0", json!(100.0)), ("height.0", json!(40.0))],
    ));
    tree.apply(&insert_patch("col", "btn"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let btn = find_item(&pass, "btn");
    assert!(btn.transform.is_identity());
    assert_eq!(btn.visual_rect(), btn.rect);
    assert!(pass.hit(btn.rect.x + 1.0, btn.rect.y + 1.0).is_some());
}

#[test]
fn rotate_accepts_deg_suffixed_strings() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    tree.apply(&create_patch(
        "r",
        "Container",
        &[("width.0", json!(100.0)), ("height.0", json!(20.0)), ("rotate.0", json!("90deg"))],
    ));
    tree.apply(&insert_patch("col", "r"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let r = find_item(&pass, "r");
    let vr = r.visual_rect();
    assert!((vr.w - 20.0).abs() < 0.5 && (vr.h - 100.0).abs() < 0.5, "\"90deg\" parses: {vr:?}");
}

#[test]
fn affine2_inverse_round_trips_and_conjugation_matches_recompute() {
    let m = Affine2::translate(30.0, -12.0)
        .mul(&Affine2::translate(50.0, 40.0))
        .mul(&Affine2::scale(1.5))
        .mul(&Affine2::rotate_deg(37.0))
        .mul(&Affine2::translate(-50.0, -40.0));
    let inv = m.inverse().expect("invertible");
    let (x, y) = m.apply(12.0, 34.0);
    let (bx, by) = inv.apply(x, y);
    assert!((bx - 12.0).abs() < 1e-3 && (by - 34.0).abs() < 1e-3);
    // Scroll fast path: conjugating by the shift equals recomputing
    // the transform against shifted rect centers.
    let shifted = Affine2::translate(0.0, -25.0)
        .mul(&Affine2::translate(50.0, 15.0))
        .mul(&Affine2::scale(1.5))
        .mul(&Affine2::rotate_deg(37.0))
        .mul(&Affine2::translate(-50.0, -15.0));
    let local = Affine2::translate(50.0, 40.0)
        .mul(&Affine2::scale(1.5))
        .mul(&Affine2::rotate_deg(37.0))
        .mul(&Affine2::translate(-50.0, -40.0));
    let conj = local.conjugate_translate(0.0, -25.0);
    let want = Affine2::translate(50.0, 15.0)
        .mul(&Affine2::scale(1.5))
        .mul(&Affine2::rotate_deg(37.0))
        .mul(&Affine2::translate(-50.0, -15.0));
    let _ = shifted;
    for (a, b) in conj.0.iter().zip(want.0.iter()) {
        assert!((a - b).abs() < 1e-3, "conjugation mismatch: {conj:?} vs {want:?}");
    }
}

#[test]
fn logical_viewport_converts_physical_surface_to_css_pixels() {
    use crate::layout::logical_viewport;
    // A 960x752pt window on a 2x display: wgpu reports the surface in
    // physical px, Tailwind breakpoints are CSS px.
    let v = logical_viewport((1920, 1504), 2.0);
    assert_eq!(v.w, 960.0);
    assert_eq!(v.h, 752.0);
    // 1x passes through untouched.
    let v1 = logical_viewport((1280, 800), 1.0);
    assert_eq!(v1.w, 1280.0);
    assert_eq!(v1.h, 800.0);
    // A zero scale must not divide by zero.
    let v0 = logical_viewport((800, 600), 0.0);
    assert_eq!(v0.w, 800.0);
    assert_eq!(v0.h, 600.0);
}

#[test]
fn breakpoints_resolve_against_logical_not_physical_width() {
    use crate::layout::logical_viewport;
    use crate::style::prop_f32_at;
    // Base 8, md (>=768) 16, xl (>=1280) 64. A 960pt window on a 2x
    // display is 1920 PHYSICAL px — which would wrongly match `xl`.
    // It must resolve as `md`.
    let mut props = std::collections::HashMap::new();
    props.insert("padding".to_string(), serde_json::json!(8));
    props.insert("padding@md.0".to_string(), serde_json::json!(16));
    props.insert("padding@xl.0".to_string(), serde_json::json!(64));
    let node = crate::tree::Node {
        id: "n".into(),
        element_type: "Box".into(),
        props,
        semantics: None,
    };
    let v = logical_viewport((1920, 1504), 2.0);
    assert_eq!(prop_f32_at(&node, "padding", v), Some(16.0));
}

#[test]
fn shrunk_text_in_a_row_keeps_a_box_tall_enough_for_its_wrapped_lines() {
    // The movie-discovery featured card: two padded, rounded, coloured
    // Text pills side by side in a Row. Their combined natural width
    // exceeds the row, so flex shrinks them and the text re-wraps onto a
    // second line. The laid-out box must grow to match, or the painter
    // draws two lines of glyphs over a one-line background — the "8.8"
    // and "Fi" spilling out from under their pills.
    let mut tree = Tree::new();
    tree.apply(&create_patch("row", "Row", &[]));
    tree.apply(&insert_patch(ROOT_ID, "row"));
    add_text(&mut tree, "row", "a", "Action, Adventure, Sci-Fi");
    add_text(&mut tree, "row", "b", "Drama, Thriller, Mystery");

    let mut text = TextEngine::new();

    // Roomy: both fit on one line each.
    let roomy = LayoutPass::compute(&tree, &mut text, (1600, 600), 1.0);
    let h_roomy = find_item(&roomy, "a").rect.h;

    // Cramped: the row can't hold both, so they shrink and wrap.
    let cramped = LayoutPass::compute(&tree, &mut text, (300, 600), 1.0);
    let a = find_item(&cramped, "a");

    assert!(
        a.rect.w < 199.0,
        "expected the pill to be shrunk below its natural width, got {}",
        a.rect.w
    );
    assert!(
        a.rect.h > h_roomy,
        "shrunk-and-wrapped text box height ({}) must exceed the \
         one-line height ({h_roomy}) — otherwise the background pill is \
         a line shorter than the glyphs drawn into it",
        a.rect.h
    );
}


#[test]
fn padded_text_pill_grows_to_fit_its_wrapped_lines() {
    // Same as the unpadded case, but the pills carry `px-3 py-1` like
    // movie-discovery's rating / genre chips. Padding must not stop the
    // box from growing when the shrunk width forces a second line.
    let mut tree = Tree::new();
    tree.apply(&create_patch("row", "Row", &[]));
    tree.apply(&insert_patch(ROOT_ID, "row"));
    for (id, content) in [("a", "Action, Adventure, Sci-Fi"), ("b", "Drama, Thriller, Mystery")] {
        tree.apply(&create_patch(
            id,
            "Text",
            &[
                ("0", json!(content)),
                ("paddingLeft", json!(12)),
                ("paddingRight", json!(12)),
                ("paddingTop", json!(4)),
                ("paddingBottom", json!(4)),
            ],
        ));
        tree.apply(&insert_patch("row", id));
    }

    let mut text = TextEngine::new();
    let roomy = LayoutPass::compute(&tree, &mut text, (1600, 600), 1.0);
    let h_roomy = find_item(&roomy, "a").rect.h;

    let cramped = LayoutPass::compute(&tree, &mut text, (300, 600), 1.0);
    let a = find_item(&cramped, "a");
    assert!(
        a.rect.h > h_roomy,
        "padded pill height ({}) must exceed the one-line height ({h_roomy})",
        a.rect.h
    );
}


#[test]
fn bold_text_is_measured_bold_so_its_box_fits_the_glyphs_drawn() {
    // movie-discovery's `font-black` rating pill and `font-bold` genre
    // chip. Layout used to measure every Text at weight 400 while the
    // painter drew the node's real weight; bold glyphs are wider, so a
    // line Taffy had sized as fitting wrapped when painted, and the "8.8"
    // / "Fi" spilled out from under their background pills.
    //
    // The box for bold text must therefore be at least as wide as the
    // box for the same string at regular weight.
    // In a Row so each Text sizes to its own content rather than
    // stretching to the root's full width.
    let mut tree = Tree::new();
    tree.apply(&create_patch("row", "Row", &[]));
    tree.apply(&insert_patch(ROOT_ID, "row"));
    tree.apply(&create_patch("regular", "Text", &[("0", json!("Sci-Fi"))]));
    tree.apply(&insert_patch("row", "regular"));
    tree.apply(&create_patch(
        "bold",
        "Text",
        &[("0", json!("Sci-Fi")), ("fontWeight", json!(900))],
    ));
    tree.apply(&insert_patch("row", "bold"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (1600, 600), 1.0);
    let regular = find_item(&pass, "regular").rect;
    let bold = find_item(&pass, "bold").rect;

    assert!(
        bold.w > regular.w,
        "black-weight text ({}) should measure wider than regular ({}) —          equal widths mean layout is still measuring at weight 400",
        bold.w,
        regular.w
    );
}

#[test]
fn single_argument_linear_gradient_applicator_resolves() {
    // `.linearGradient("135deg, #EC4899 0%, #F472B6 100%")` — one string
    // holding the whole CSS body, which is what the DOM renderer lowers
    // to `linear-gradient(<body>)`. movie-discovery's search button and
    // featured card both use this form; desktop used to require a second
    // `colors` argument and painted no gradient at all.
    use crate::style::{prop_linear_gradient, Viewport};
    let mut props = std::collections::HashMap::new();
    props.insert(
        "linearGradient.0".to_string(),
        json!("135deg, #EC4899 0%, #F472B6 100%"),
    );
    let node = crate::tree::Node {
        id: "btn".into(),
        element_type: "Button".into(),
        props,
        semantics: None,
    };
    let g = prop_linear_gradient(&node, Viewport::new(960.0, 752.0))
        .expect("single-argument linearGradient must resolve");
    assert_eq!(g.stops.len(), 2, "expected both colour stops, got {:?}", g.stops);
    assert_eq!(g.stops[0].color, crate::style::Rgba(0xEC, 0x48, 0x99, 0xff));
    assert_eq!(g.stops[1].color, crate::style::Rgba(0xF4, 0x72, 0xB6, 0xff));
}

#[test]
fn single_argument_linear_gradient_keeps_rgba_stop_alpha() {
    // The featured card's body uses rgba() stops with real alpha; those
    // must survive, or the card paints opaque over the page background.
    use crate::style::{prop_linear_gradient, Viewport};
    let mut props = std::collections::HashMap::new();
    props.insert(
        "linearGradient.0".to_string(),
        json!("135deg, rgba(236, 72, 153, 0.38) 0%, rgba(8, 8, 8, 0.98) 42%, rgba(244, 114, 182, 0.20) 100%"),
    );
    let node = crate::tree::Node {
        id: "card".into(),
        element_type: "Row".into(),
        props,
        semantics: None,
    };
    let g = prop_linear_gradient(&node, Viewport::new(960.0, 752.0))
        .expect("rgba-stop gradient body must resolve");
    assert_eq!(g.stops.len(), 3);
    assert_eq!(g.stops[0].color.3, 97, "0.38 alpha should survive parsing");
}

#[test]
fn layered_background_shorthand_reaches_the_item() {
    // The home-screen launcher's icon tile:
    // `.background("radial-gradient(<sheen>), linear-gradient(<brand>)")`
    // — a two-layer CSS stack in the `background` shorthand. It used to
    // reach the painter as nothing at all (no gradient, no image, no
    // colour), leaving the tile an empty border over the wallpaper.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "tile",
        "Column",
        &[(
            "background.0",
            json!(
                "radial-gradient(circle at 24% 14%, rgba(255,255,255,0.48), transparent 29%), \
                 linear-gradient(145deg, #38BDF8 0%, #4F46E5 52%, #312E81 100%)"
            ),
        )],
    ));
    tree.apply(&insert_patch("root", "tile"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "tile");
    let layers = item
        .background_layers
        .as_ref()
        .expect("layered background must reach the item");
    assert_eq!(layers.layers.len(), 2);
    // Bottom-first: brand linear below, sheen radial on top.
    assert!(matches!(
        layers.layers[0],
        crate::style::BackgroundLayer::Linear(_)
    ));
    assert!(matches!(
        layers.layers[1],
        crate::style::BackgroundLayer::Radial(_)
    ));
}

#[test]
fn semantic_alignment_aliases_map_by_axis_not_by_name() {
    // `.horizontalAlignment` / `.verticalAlignment` name a geometric
    // axis, so which flex property they drive flips with flex-direction
    // — the Android and SwiftUI convention. todo's task rows rely on
    // `horizontalAlignment("space-between")` in a Row to push "Remove"
    // to the right edge.
    use taffy::style::{AlignItems, JustifyContent};
    let mk = |kind: &str| {
        let mut props = std::collections::HashMap::new();
        props.insert("horizontalAlignment".to_string(), json!("space-between"));
        props.insert("verticalAlignment".to_string(), json!("center"));
        let node = crate::tree::Node {
            id: "n".into(),
            element_type: kind.into(),
            props,
            semantics: None,
        };
        node_style_with(&node, 1.0, vp(960.0), &[], SafeAreaInsets::default())
    };

    // Row: horizontal is the MAIN axis.
    let row = mk("Row");
    assert_eq!(row.justify_content, Some(JustifyContent::SpaceBetween));
    assert_eq!(row.align_items, Some(AlignItems::Center));

    // Column: the mapping flips. `verticalAlignment` now drives the main
    // axis, and `space-between` is not a legal align-items value so the
    // cross axis is simply left alone rather than set to nonsense.
    let col = mk("Column");
    assert_eq!(col.justify_content, Some(JustifyContent::Center));
    assert_eq!(col.align_items, None);
}

#[test]
fn css_border_shorthand_sets_width_and_colour() {
    // `.border("1px solid #333")` — todo's task-row outline. The numeric
    // read rejects the string, so without shorthand parsing no border was
    // drawn at all.
    use crate::style::{border_at, Rgba, Viewport};
    let mut props = std::collections::HashMap::new();
    props.insert("border".to_string(), json!("1px solid #333"));
    let node = crate::tree::Node {
        id: "row".into(),
        element_type: "Row".into(),
        props,
        semantics: None,
    };
    let b = border_at(&node, Viewport::new(960.0, 752.0));
    assert_eq!(b.width, 1.0, "border width should come from the shorthand");
    assert_eq!(b.color, Rgba(0x33, 0x33, 0x33, 0xff));

    // Order-independent, and the style keyword is ignored.
    let mut props2 = std::collections::HashMap::new();
    props2.insert("border".to_string(), json!("red dashed 2px"));
    let node2 = crate::tree::Node {
        id: "r2".into(),
        element_type: "Row".into(),
        props: props2,
        semantics: None,
    };
    let b2 = border_at(&node2, Viewport::new(960.0, 752.0));
    assert_eq!(b2.width, 2.0);
    assert_eq!(b2.color, Rgba(0xff, 0x00, 0x00, 0xff));
}

#[test]
fn max_width_child_stays_centred_as_the_window_resizes() {
    // The home-screen dock: a `w-full max-w-[280px]` Column centred by
    // its parent's `items-center`, inside a `min-h-screen` shell. It must
    // sit centred at every window size, not just the one it was tested
    // at — this is the "UI is scaled to the window" guarantee, and it is
    // also the regression guard for the dock drifting off-centre.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "shell",
        "Column",
        &[
            ("alignItems", json!("center")),
            ("width", json!("100%")),
            // `min-h-screen` lowers to this; it silently parsed to nothing
            // before viewport units were supported.
            ("minHeight", json!("100vh")),
        ],
    ));
    tree.apply(&insert_patch(ROOT_ID, "shell"));
    tree.apply(&create_patch(
        "dock",
        "Column",
        &[("width", json!("100%")), ("maxWidth", json!(280))],
    ));
    tree.apply(&insert_patch("shell", "dock"));

    let mut text = TextEngine::new();
    for (w, h) in [(960u32, 720u32), (1400, 900), (640, 480), (1920, 1080)] {
        let pass = LayoutPass::compute(&tree, &mut text, (w, h), 1.0);
        let dock = find_item(&pass, "dock").rect;
        let shell = find_item(&pass, "shell").rect;

        // Clamped by max-width, never wider than the window.
        assert!(
            dock.w <= 280.0 + 0.5,
            "dock width {} exceeded its 280 max at {w}x{h}",
            dock.w
        );
        assert!(dock.w <= w as f32, "dock wider than the window at {w}x{h}");

        // Centred: equal slack either side, within a rounding pixel.
        let left = dock.x - shell.x;
        let right = (shell.x + shell.w) - (dock.x + dock.w);
        assert!(
            (left - right).abs() <= 1.0,
            "dock off-centre at {w}x{h}: {left} left vs {right} right",
        );

        // The shell follows the window rather than collapsing to content.
        assert!(
            shell.h >= h as f32 - 1.0,
            "shell height {} did not fill the {h}pt window (min-h-screen)",
            shell.h
        );
    }
}

// ---------------------------------------------------------------------------
// Video (media surface) — sizing, item emission, click wiring.
//
// Desktop has no inline media decode (contract:
// hypen-docs/content/docs/guide/components.mdx). Layout must size a Video like an
// Image but with a 16:9 default aspect (poster natural aspect when the
// poster is already decoded), and emission must produce ItemKind::Video
// with the poster/src split plus onPlay click wiring.
// ---------------------------------------------------------------------------

#[test]
fn video_explicit_width_and_height() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "vid",
        "Video",
        &[
            ("width", json!(320)),
            ("height", json!(180)),
            ("src", json!("https://cdn/movie.mp4")),
        ],
    ));
    tree.apply(&insert_patch("root", "vid"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "vid");
    assert!(
        (item.rect.w - 320.0).abs() < 0.5 && (item.rect.h - 180.0).abs() < 0.5,
        "explicit 320x180 expected, got {}x{}",
        item.rect.w,
        item.rect.h,
    );
    match &item.kind {
        ItemKind::Video { src, poster, .. } => {
            assert_eq!(src.as_deref(), Some("https://cdn/movie.mp4"));
            assert_eq!(poster.as_deref(), None);
        }
        other => panic!("expected ItemKind::Video, got {other:?}"),
    }
}

#[test]
fn video_width_only_defaults_to_16_9_height() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("vid", "Video", &[("width", json!(320))]));
    tree.apply(&insert_patch("root", "vid"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "vid");
    assert!(
        (item.rect.h - 180.0).abs() < 1.0,
        "width 320 with no height should derive 180 via 16:9, got {}",
        item.rect.h,
    );
}

#[test]
fn video_height_only_defaults_to_16_9_width() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("vid", "Video", &[("height", json!(90))]));
    tree.apply(&insert_patch("root", "vid"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "vid");
    assert!(
        (item.rect.w - 160.0).abs() < 1.0,
        "height 90 with no width should derive 160 via 16:9, got {}",
        item.rect.w,
    );
}

#[test]
fn video_aspect_ratio_prop_overrides_default() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "vid",
        "Video",
        &[("width", json!(300)), ("aspectRatio", json!("4 / 3"))],
    ));
    tree.apply(&insert_patch("root", "vid"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "vid");
    assert!(
        (item.rect.h - 225.0).abs() < 1.0,
        "300 wide at 4:3 should be 225 tall, got {}",
        item.rect.h,
    );
}

#[test]
fn video_unconstrained_gets_default_16_9_box() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("vid", "Video", &[]));
    tree.apply(&insert_patch("root", "vid"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "vid");
    assert!(
        (item.rect.w - DEFAULT_VIDEO_WIDTH_PX).abs() < 0.5,
        "unconstrained video should take the default width, got {}",
        item.rect.w,
    );
    let expected_h = DEFAULT_VIDEO_WIDTH_PX / DEFAULT_VIDEO_ASPECT;
    assert!(
        (item.rect.h - expected_h).abs() < 1.0,
        "unconstrained video height should follow 16:9 ({expected_h}), got {}",
        item.rect.h,
    );
}

#[test]
fn video_poster_natural_aspect_wins_over_16_9_once_loaded() {
    // Seed a 100x50 (2:1) decoded poster so the layout's natural-aspect
    // probe finds it synchronously.
    let poster = "test://video-poster-2to1";
    let pm = tiny_skia::Pixmap::new(100, 50).expect("poster pixmap");
    crate::paint::image::test_seed_decoded(poster, std::sync::Arc::new(pm));

    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "vid",
        "Video",
        &[("width", json!(200)), ("poster", json!(poster))],
    ));
    tree.apply(&insert_patch("root", "vid"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "vid");
    assert!(
        (item.rect.h - 100.0).abs() < 1.0,
        "200-wide video with a loaded 2:1 poster should be 100 tall, got {}",
        item.rect.h,
    );
}

#[test]
fn video_emits_poster_and_src() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "vid",
        "Video",
        &[
            ("src", json!("https://cdn/clip.mp4")),
            ("poster", json!("https://cdn/frame.jpg")),
        ],
    ));
    tree.apply(&insert_patch("root", "vid"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    match &find_item(&pass, "vid").kind {
        ItemKind::Video { src, poster, .. } => {
            assert_eq!(src.as_deref(), Some("https://cdn/clip.mp4"));
            assert_eq!(poster.as_deref(), Some("https://cdn/frame.jpg"));
        }
        other => panic!("expected ItemKind::Video, got {other:?}"),
    }
}

#[test]
fn video_empty_poster_collapses_to_none() {
    // A record with no poster serialises to `""` — that must be "no
    // poster", not a queued load against no filename.
    let mut tree = Tree::new();
    tree.apply(&create_patch("vid", "Video", &[("poster", json!(""))]));
    tree.apply(&insert_patch("root", "vid"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    match &find_item(&pass, "vid").kind {
        ItemKind::Video { poster, .. } => assert_eq!(poster.as_deref(), None),
        other => panic!("expected ItemKind::Video, got {other:?}"),
    }
}

#[test]
fn video_onplay_wires_click_action_with_contract_payload() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "vid",
        "Video",
        &[
            ("src", json!("https://cdn/clip.mp4")),
            ("onPlay.0", json!("@actions.startPlayback")),
        ],
    ));
    tree.apply(&insert_patch("root", "vid"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "vid");
    assert_eq!(item.action.as_deref(), Some("startPlayback"));
    let payload = item.action_payload.as_ref().expect("play payload");
    assert_eq!(payload["type"], json!("play"));
    assert_eq!(payload["src"], json!("https://cdn/clip.mp4"));
    assert_eq!(payload["index"], json!(0));
    // Clickable → participates in hit-testing like any actionable.
    let hit = pass
        .hit(item.rect.x + 1.0, item.rect.y + 1.0)
        .expect("video with onPlay must be hittable");
    assert_eq!(hit.node_id, "vid");
}

#[test]
fn video_playlist_resolves_start_index_track() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "vid",
        "Video",
        &[
            (
                "playlist",
                json!(["https://cdn/ep1.mp4", "https://cdn/ep2.mp4", "https://cdn/ep3.mp4"]),
            ),
            ("startIndex", json!(1)),
            ("onPlay.0", json!("@actions.play")),
        ],
    ));
    tree.apply(&insert_patch("root", "vid"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "vid");
    match &item.kind {
        ItemKind::Video { src, .. } => {
            assert_eq!(src.as_deref(), Some("https://cdn/ep2.mp4"));
        }
        other => panic!("expected ItemKind::Video, got {other:?}"),
    }
    let payload = item.action_payload.as_ref().expect("play payload");
    assert_eq!(payload["index"], json!(1));
    assert_eq!(payload["src"], json!("https://cdn/ep2.mp4"));
}

#[test]
fn video_without_events_is_not_actionable() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "vid",
        "Video",
        &[("src", json!("https://cdn/clip.mp4")), ("controls", json!(true))],
    ));
    tree.apply(&insert_patch("root", "vid"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "vid");
    assert!(
        item.action.is_none(),
        "no onPlay / onClick wired — the surface must stay inert, got {:?}",
        item.action,
    );
}

#[test]
fn video_explicit_onclick_wins_over_onplay() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "vid",
        "Video",
        &[
            ("src", json!("https://cdn/clip.mp4")),
            ("onClick.0", json!("@actions.openDetail")),
            ("onPlay.0", json!("@actions.play")),
        ],
    ));
    tree.apply(&insert_patch("root", "vid"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    assert_eq!(find_item(&pass, "vid").action.as_deref(), Some("openDetail"));
}

/// Regression probe for the live Hypeflix repro: a `.onClick`-applicator
/// Button (engine lowers it to `onClick.0`) inside a tall scrollable
/// Column must be hittable at its PAINTED position after page scroll —
/// `compute_with_scroll` items already carry scroll-adjusted rects, so
/// `hit()` at the on-screen point must find the action.
#[test]
fn onclick_button_hits_at_painted_position_after_scroll() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[("scrollable.0", json!(true))]));
    tree.apply(&insert_patch("root", "col"));
    // Tall spacer pushes the button below the fold.
    tree.apply(&create_patch(
        "spacer",
        "Container",
        &[("height.0", json!(1600.0)), ("minHeight.0", json!(1600.0))],
    ));
    tree.apply(&insert_patch("col", "spacer"));
    tree.apply(&create_patch(
        "play",
        "Button",
        &[("onClick.0", json!("@actions.playFeatured"))],
    ));
    tree.apply(&insert_patch("col", "play"));
    add_text(&mut tree, "play", "label", "Play");

    let mut text = TextEngine::new();

    // Unscrolled: button sits below the 720px viewport — not hittable there.
    let unscrolled = LayoutPass::compute_with_scroll(&tree, &mut text, (960, 720), 1.0, 0.0);
    let item = find_item(&unscrolled, "play");
    assert_eq!(item.action.as_deref(), Some("playFeatured"));
    assert!(
        item.rect.y >= 720.0,
        "expected button below the fold, got {:?}",
        item.rect
    );

    // Scrolled down 1000px. The window routes wheel-over-a-scrollable to
    // PER-CONTAINER scroll (window.rs MouseWheel → self.scrollables), so
    // exercise that path: the item rect must shift up accordingly and
    // hit() at the painted center must resolve the action.
    let mut scrolls = HashMap::new();
    scrolls.insert("col".to_string(), 1000.0_f32);
    let scrolled =
        LayoutPass::compute_with_scrolls(&tree, &mut text, (960, 720), 1.0, 0.0, &scrolls);
    let item = find_item(&scrolled, "play");
    let (cx, cy) = (
        item.rect.x + item.rect.w / 2.0,
        item.rect.y + item.rect.h / 2.0,
    );
    assert!(
        cy < 720.0,
        "expected scrolled button on screen, got {:?}",
        item.rect
    );
    for it in scrolled.actionables() {
        eprintln!(
            "actionable {} rect={:?} clip_to={:?} identity={}",
            it.node_id,
            it.rect,
            it.clip_to,
            it.transform.is_identity()
        );
    }
    let hit = scrolled
        .hit(cx, cy)
        .unwrap_or_else(|| panic!("no actionable hit at painted center ({cx},{cy})"));
    assert_eq!(hit.node_id, "play");
    assert_eq!(hit.action.as_deref(), Some("playFeatured"));
}

/// Replay the REAL Hypeflix browse patch stream (captured from the live
/// worker over the remote protocol) and verify the featured "Play"
/// button is actually hittable after wheel-scrolling it into view —
/// mirroring exactly what the window does: topmost scrollable under the
/// cursor takes a per-container offset, then the click hit-tests at the
/// button's painted position.
#[test]
fn hypeflix_browse_play_button_is_hittable_after_wheel_scroll() {
    let json = include_str!("../tests/fixtures/hypeflix-browse-patches.json");
    let patches: Vec<Patch> = serde_json::from_str(json).expect("fixture deserializes");
    let mut tree = Tree::new();
    for p in &patches {
        tree.apply(p);
    }

    let mut text = TextEngine::new();
    let unscrolled = LayoutPass::compute(&tree, &mut text, (960, 720), 1.0);

    // The featured Play button: Button carrying onClick.0 == "@playFeatured".
    let play = unscrolled
        .items
        .iter()
        .find(|it| it.action.as_deref() == Some("playFeatured"))
        .expect("play button resolves an action in the layout");
    let play_id = play.node_id.clone();

    // Route the wheel exactly like window.rs: topmost scrollable under a
    // mid-viewport cursor.
    let target = unscrolled
        .hit_scrollable(350.0, 400.0)
        .expect("a scrollable container under the cursor");
    let container = target.node_id.clone();
    let meta = target.scrollable.expect("scroll meta");
    assert!(
        meta.content_h > 720.0,
        "browse content should overflow the viewport, got {}",
        meta.content_h
    );

    // Scroll just enough to bring the button up near the top of the
    // viewport. Derived from its unscrolled position rather than a magic
    // constant so the assertion tracks real layout changes above it.
    let scroll_by = (play.rect.y - 120.0).clamp(0.0, meta.content_h - 720.0);
    let mut scrolls = HashMap::new();
    scrolls.insert(container, scroll_by);
    let scrolled =
        LayoutPass::compute_with_scrolls(&tree, &mut text, (960, 720), 1.0, 0.0, &scrolls);
    let item = scrolled
        .items
        .iter()
        .find(|it| it.node_id == play_id)
        .expect("play button still emitted after scroll");
    let (cx, cy) = (
        item.rect.x + item.rect.w / 2.0,
        item.rect.y + item.rect.h / 2.0,
    );
    assert!(
        cy > 0.0 && cy < 720.0,
        "expected the scrolled play button on screen, got {:?}",
        item.rect
    );
    let hit = scrolled.hit(cx, cy).unwrap_or_else(|| {
        panic!(
            "no actionable hit at play button painted center ({cx},{cy}); item clip_to={:?}",
            item.clip_to
        )
    });
    assert_eq!(hit.node_id, play_id, "hit should resolve the play button");
}

// ---------------------------------------------------------------------------
// Video v2: composition slots + Scrubber
// (hypen-docs/content/docs/guide/components.mdx §"Playback control & composition slots")
// ---------------------------------------------------------------------------

use crate::video_v2::{
    clear_test_states, set_test_state, SlotPresence, VideoPlayerState, VideoSlotName,
};

const V2_STATES: [VideoPlayerState; 6] = [
    VideoPlayerState::Idle,
    VideoPlayerState::Loading,
    VideoPlayerState::Playing,
    VideoPlayerState::Paused,
    VideoPlayerState::Ended,
    VideoPlayerState::Error,
];

/// A 320x180 Video with one child per slot (plus one untagged child),
/// all under a fixed-size root so the player rect is deterministic.
fn slotted_video_tree() -> Tree {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "vid",
        "Video",
        &[
            ("src", json!("https://cdn/a.mp4")),
            ("width", json!(320)),
            ("height", json!(180)),
        ],
    ));
    tree.apply(&insert_patch("root", "vid"));
    for (id, slot) in [
        ("ctl", "controls"),
        ("load", "loading"),
        ("err", "error"),
        ("post", "poster"),
    ] {
        tree.apply(&create_patch(id, "Column", &[("slot.0", json!(slot))]));
        tree.apply(&insert_patch("vid", id));
    }
    // Untagged children are invalid per the spec.
    tree.apply(&create_patch("stray", "Text", &[("0", json!("nope"))]));
    tree.apply(&insert_patch("vid", "stray"));
    tree
}

fn emitted_ids(pass: &LayoutPass) -> Vec<String> {
    pass.items.iter().map(|it| it.node_id.clone()).collect()
}

#[test]
fn slot_subtrees_lay_out_full_bleed_over_the_video_rect() {
    clear_test_states();
    // `ended` co-shows poster + controls, so both overlays can be
    // measured in one pass (`idle` co-shows the same pair since the
    // controls-in-idle amendment).
    let tree = slotted_video_tree();
    let mut text = TextEngine::new();
    set_test_state("vid", VideoPlayerState::Ended); // poster + controls
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let video = find_item(&pass, "vid").rect;
    assert_eq!((video.w, video.h), (320.0, 180.0));
    for slot_id in ["post", "ctl"] {
        let r = find_item(&pass, slot_id).rect;
        assert_eq!(
            (r.x, r.y, r.w, r.h),
            (video.x, video.y, video.w, video.h),
            "slot `{slot_id}` must be a full-bleed overlay of the player rect"
        );
    }
    clear_test_states();
}

#[test]
fn slot_overlays_do_not_change_the_player_geometry() {
    clear_test_states();
    let mut bare = Tree::new();
    bare.apply(&create_patch(
        "vid",
        "Video",
        &[("src", json!("https://cdn/a.mp4"))],
    ));
    bare.apply(&insert_patch("root", "vid"));
    let mut text = TextEngine::new();
    let without = LayoutPass::compute(&bare, &mut text, (800, 600), 1.0)
        .item_by_id("vid")
        .expect("video item")
        .rect;

    let mut slotted = Tree::new();
    slotted.apply(&create_patch(
        "vid",
        "Video",
        &[("src", json!("https://cdn/a.mp4"))],
    ));
    slotted.apply(&insert_patch("root", "vid"));
    slotted.apply(&create_patch("post", "Column", &[("slot.0", json!("poster"))]));
    slotted.apply(&insert_patch("vid", "post"));
    add_text(&mut slotted, "post", "cap", "A very long caption indeed");
    let with = LayoutPass::compute(&slotted, &mut text, (800, 600), 1.0)
        .item_by_id("vid")
        .expect("video item")
        .rect;

    assert_eq!(
        (without.w, without.h),
        (with.w, with.h),
        "absolute slot overlays must not feed back into the player's size"
    );
    clear_test_states();
}

#[test]
fn slot_emission_follows_the_visibility_table_in_every_state() {
    clear_test_states();
    let tree = slotted_video_tree();
    let mut text = TextEngine::new();
    for state in V2_STATES {
        set_test_state("vid", state);
        let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
        let ids = emitted_ids(&pass);
        for (id, slot) in [
            ("ctl", VideoSlotName::Controls),
            ("load", VideoSlotName::Loading),
            ("err", VideoSlotName::Error),
            ("post", VideoSlotName::Poster),
        ] {
            let want = crate::video_v2::slot_visible(slot, state);
            assert_eq!(
                ids.iter().any(|i| i == id),
                want,
                "slot `{}` in state `{}`",
                slot.as_str(),
                state.as_str()
            );
        }
        assert!(
            ids.iter().any(|i| i == "vid"),
            "the player itself is always emitted"
        );
        assert!(
            !ids.iter().any(|i| i == "stray"),
            "untagged Video children are invalid and never emit"
        );
    }
    clear_test_states();
}

#[test]
fn hidden_slots_are_not_hit_testable_but_visible_ones_are() {
    clear_test_states();
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "vid",
        "Video",
        &[("width", json!(320)), ("height", json!(180))],
    ));
    tree.apply(&insert_patch("root", "vid"));
    tree.apply(&create_patch(
        "ctl",
        "Column",
        &[("slot.0", json!("controls"))],
    ));
    tree.apply(&insert_patch("vid", "ctl"));
    tree.apply(&create_patch(
        "btn",
        "Button",
        &[("action", json!("@actions.togglePlay"))],
    ));
    tree.apply(&insert_patch("ctl", "btn"));

    let mut text = TextEngine::new();
    // `playing` shows controls: the button inside is hittable.
    set_test_state("vid", VideoPlayerState::Playing);
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let btn = find_item(&pass, "btn").rect;
    let hit = pass.hit(btn.x + btn.w * 0.5, btn.y + btn.h * 0.5);
    assert_eq!(
        hit.map(|it| it.node_id.as_str()),
        Some("btn"),
        "a visible controls slot takes clicks"
    );

    // `error` hides controls: the same point resolves nothing.
    set_test_state("vid", VideoPlayerState::Error);
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    assert!(pass.item_by_id("btn").is_none());
    assert!(
        pass.hit(btn.x + btn.w * 0.5, btn.y + btn.h * 0.5).is_none(),
        "a hidden slot must not swallow clicks"
    );

    // `idle` shows controls (amended table): the slot's own buttons are
    // how a never-played source starts first play, so they MUST take
    // clicks — the built-in tap-to-toggle stands down when a `controls`
    // slot is present, and these buttons replace it.
    set_test_state("vid", VideoPlayerState::Idle);
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let idle_btn = find_item(&pass, "btn").rect;
    let hit = pass.hit(idle_btn.x + idle_btn.w * 0.5, idle_btn.y + idle_btn.h * 0.5);
    assert_eq!(
        hit.map(|it| it.node_id.as_str()),
        Some("btn"),
        "a controls-slot button must be hittable in idle (it starts first play)"
    );
    clear_test_states();
}

#[test]
fn co_visible_slots_stack_in_normative_paint_order_not_declaration_order() {
    clear_test_states();
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "vid",
        "Video",
        &[("width", json!(320)), ("height", json!(180))],
    ));
    tree.apply(&insert_patch("root", "vid"));
    // Declare controls BEFORE poster: paint order must still be
    // poster → loading → controls → error, bottom-to-top.
    tree.apply(&create_patch(
        "ctl",
        "Column",
        &[("slot.0", json!("controls"))],
    ));
    tree.apply(&insert_patch("vid", "ctl"));
    tree.apply(&create_patch("post", "Column", &[("slot.0", json!("poster"))]));
    tree.apply(&insert_patch("vid", "post"));

    let mut text = TextEngine::new();
    // `idle` co-shows poster + controls (the amended table's new pair).
    set_test_state("vid", VideoPlayerState::Idle);
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let ids = emitted_ids(&pass);
    let post_at = ids.iter().position(|i| i == "post").expect("poster emitted");
    let ctl_at = ids.iter().position(|i| i == "ctl").expect("controls emitted");
    assert!(
        post_at < ctl_at,
        "controls must paint ABOVE the poster in idle regardless of declaration order"
    );
    // Hit-testing walks reverse paint order, so the controls overlay
    // also wins the pointer over the poster underneath it.
    let ctl = find_item(&pass, "ctl").rect;
    let hit = pass.hit(ctl.x + ctl.w * 0.5, ctl.y + ctl.h * 0.5);
    assert_ne!(
        hit.map(|it| it.node_id.as_str()),
        Some("post"),
        "the poster must not swallow clicks aimed at the controls overlay"
    );
    clear_test_states();
}

#[test]
fn hiding_a_slot_keeps_its_subtree_in_the_renderer_tree() {
    clear_test_states();
    let tree = slotted_video_tree();
    let mut text = TextEngine::new();
    set_test_state("vid", VideoPlayerState::Playing); // controls only
    let _ = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    // Show/hide, not mount/unmount: every slot node still exists, so its
    // props, patches and per-node renderer state survive the transition.
    for id in ["ctl", "load", "err", "post"] {
        assert!(tree.get(id).is_some(), "slot node `{id}` must stay alive");
    }
    clear_test_states();
}

#[test]
fn video_item_carries_its_state_and_slot_presence() {
    clear_test_states();
    let tree = slotted_video_tree();
    let mut text = TextEngine::new();
    set_test_state("vid", VideoPlayerState::Paused);
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    match &find_item(&pass, "vid").kind {
        ItemKind::Video { state, slots, .. } => {
            assert_eq!(*state, VideoPlayerState::Paused);
            assert_eq!(
                *slots,
                SlotPresence {
                    controls: true,
                    loading: true,
                    error: true,
                    poster: true
                }
            );
            // Every slot declared → no built-in chrome anywhere.
            assert!(!slots.draws_builtin_glyph(*state));
        }
        other => panic!("expected a Video item, got {other:?}"),
    }
    clear_test_states();
}

#[test]
fn video_without_slots_keeps_the_shipped_builtins() {
    clear_test_states();
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "vid",
        "Video",
        &[("src", json!("https://cdn/a.mp4"))],
    ));
    tree.apply(&insert_patch("root", "vid"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    match &find_item(&pass, "vid").kind {
        ItemKind::Video { slots, state, .. } => {
            assert!(!slots.any(), "no slots declared");
            assert!(slots.draws_builtin_glyph(*state));
        }
        other => panic!("expected a Video item, got {other:?}"),
    }
    clear_test_states();
}

// --- Scrubber -------------------------------------------------------------

fn controls_scrubber_tree() -> Tree {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "vid",
        "Video",
        &[("width", json!(320)), ("height", json!(180))],
    ));
    tree.apply(&insert_patch("root", "vid"));
    tree.apply(&create_patch(
        "ctl",
        "Row",
        &[("slot.0", json!("controls"))],
    ));
    tree.apply(&insert_patch("vid", "ctl"));
    tree.apply(&create_patch("sc", "Scrubber", &[]));
    tree.apply(&insert_patch("ctl", "sc"));
    tree
}

#[test]
fn scrubber_inside_a_video_wires_to_the_enclosing_player() {
    clear_test_states();
    let tree = controls_scrubber_tree();
    let mut text = TextEngine::new();
    set_test_state("vid", VideoPlayerState::Playing);
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    match &find_item(&pass, "sc").kind {
        ItemKind::Scrubber { video_id, preview } => {
            assert_eq!(video_id.as_deref(), Some("vid"));
            assert_eq!(*preview, None);
        }
        other => panic!("expected a Scrubber item, got {other:?}"),
    }
    clear_test_states();
}

#[test]
fn scrubber_outside_a_video_is_inert() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("sc", "Scrubber", &[]));
    tree.apply(&insert_patch("root", "sc"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "sc");
    match &item.kind {
        ItemKind::Scrubber { video_id, .. } => assert_eq!(*video_id, None),
        other => panic!("expected a Scrubber item, got {other:?}"),
    }
    // "Outside a Video, Scrubber renders inert" — disabled, not
    // focusable, no commits (matches the DOM reference renderer).
    assert!(
        !item.is_focusable(),
        "a loose Scrubber must not take Tab focus"
    );
}

#[test]
fn scrubber_is_focusable_and_dispatches_no_click_action() {
    clear_test_states();
    let tree = controls_scrubber_tree();
    let mut text = TextEngine::new();
    set_test_state("vid", VideoPlayerState::Playing);
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "sc");
    assert!(item.is_focusable(), "Left/Right seeking needs focus");
    assert!(
        item.action.is_none(),
        "a tap on the track is a seek, not an activation"
    );
    let center = (item.rect.x + item.rect.w * 0.5, item.rect.y + item.rect.h * 0.5);
    assert_eq!(
        pass.hit_focusable_excluding(center.0, center.1, &|_| false)
            .map(|it| it.node_id.as_str()),
        Some("sc")
    );
    clear_test_states();
}

#[test]
fn scrubber_grows_to_fill_its_row_and_takes_thumb_height() {
    clear_test_states();
    let tree = controls_scrubber_tree();
    let mut text = TextEngine::new();
    set_test_state("vid", VideoPlayerState::Playing);
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let video = find_item(&pass, "vid").rect;
    let sc = find_item(&pass, "sc").rect;
    assert!(
        sc.w > video.w * 0.8,
        "an only-child Scrubber should eat the controls row, got {sc:?} in {video:?}"
    );
    assert_eq!(sc.h, DEFAULT_SCRUBBER_HEIGHT_PX);
    clear_test_states();
}

#[test]
fn scrubber_geometry_tracks_progress_and_keeps_the_thumb_inside() {
    use crate::paint::image::scrubber_geometry;
    let rect = Rect {
        x: 10.0,
        y: 20.0,
        w: 200.0,
        h: 16.0,
    };
    let zero = scrubber_geometry(rect, 0.0, 1.0).expect("geometry");
    let half = scrubber_geometry(rect, 0.5, 1.0).expect("geometry");
    let full = scrubber_geometry(rect, 1.0, 1.0).expect("geometry");

    // Track spans the item; progress scales with the fraction.
    assert_eq!(zero.track.x, rect.x);
    assert_eq!(zero.track.w, rect.w);
    assert_eq!(zero.progress.w, 0.0);
    assert!((half.progress.w - rect.w * 0.5).abs() < 0.01);
    assert_eq!(full.progress.w, rect.w);
    // Track is centred vertically and thinner than the hit box.
    assert!(zero.track.h < rect.h);
    assert!((zero.track.y + zero.track.h * 0.5 - (rect.y + rect.h * 0.5)).abs() < 0.01);
    // Thumb never hangs outside the item box at either end.
    assert!(zero.thumb_cx - zero.thumb_r >= rect.x - 0.01);
    assert!(full.thumb_cx + full.thumb_r <= rect.x + rect.w + 0.01);
    assert!(half.thumb_cx > zero.thumb_cx && full.thumb_cx > half.thumb_cx);
    // Out-of-range fractions clamp rather than overflow.
    let over = scrubber_geometry(rect, 5.0, 1.0).expect("geometry");
    assert_eq!(over.progress.w, full.progress.w);
    // Degenerate rects produce nothing to draw.
    assert!(scrubber_geometry(
        Rect {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0
        },
        0.5,
        1.0
    )
    .is_none());
}

#[test]
fn scrubber_preview_prop_overrides_the_live_position() {
    clear_test_states();
    let mut tree = controls_scrubber_tree();
    tree.apply(&Patch::SetProp {
        id: "sc".into(),
        name: crate::video_v2::SCRUB_PREVIEW_PROP.to_string(),
        value: json!(0.75),
    });
    let mut text = TextEngine::new();
    set_test_state("vid", VideoPlayerState::Playing);
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    match &find_item(&pass, "sc").kind {
        ItemKind::Scrubber { preview, video_id } => {
            assert_eq!(*preview, Some(0.75));
            assert_eq!(
                crate::video_v2::scrubber_fraction(video_id.as_deref(), *preview),
                0.75
            );
        }
        other => panic!("expected a Scrubber item, got {other:?}"),
    }
    clear_test_states();
}

#[test]
fn slot_styles_survive_the_incremental_taffy_path() {
    clear_test_states();
    // The retained Taffy mirror applies patches incrementally; the
    // parent-dependent overlay styling has to be re-applied there too
    // (it is not part of the parent-agnostic `node_style_with`).
    let mut tree = Tree::new();
    let mut state = TaffyState::new();
    let mut text = TextEngine::new();
    let batch = vec![
        create_patch(
            "vid",
            "Video",
            &[("width", json!(320)), ("height", json!(180))],
        ),
        insert_patch("root", "vid"),
    ];
    tree.apply_batch(&batch);
    assert!(state.apply_patches(&batch, &tree, 1.0, vp(800.0)));
    let batch = vec![
        create_patch("post", "Column", &[("slot.0", json!("poster"))]),
        insert_patch("vid", "post"),
    ];
    tree.apply_batch(&batch);
    assert!(state.apply_patches(&batch, &tree, 1.0, vp(800.0)));

    set_test_state("vid", VideoPlayerState::Idle);
    let pass =
        LayoutPass::compute_with_state(&mut state, &tree, &mut text, (800, 600), 1.0, 0.0, &HashMap::new(), 1);
    let video = find_item(&pass, "vid").rect;
    let slot = find_item(&pass, "post").rect;
    assert_eq!((slot.x, slot.y, slot.w, slot.h), (video.x, video.y, video.w, video.h));
    clear_test_states();
}

// ---------------------------------------------------------------------------
// Video v2: renderer-local intents
// (hypen-docs/content/docs/guide/components.mdx §"Fullscreen: `videoIntent(\"fullscreen\")`")
// ---------------------------------------------------------------------------

/// A 320x180 Video with a `controls` slot holding one Button. `intent`
/// (when given) is applied to the Button as `videoIntent.0`; `action`
/// (when given) as an `.onClick` ref.
fn intent_button_tree(intent: Option<&str>, action: Option<&str>) -> Tree {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "vid",
        "Video",
        &[("width", json!(320)), ("height", json!(180))],
    ));
    tree.apply(&insert_patch("root", "vid"));
    tree.apply(&create_patch(
        "ctl",
        "Column",
        &[("slot.0", json!("controls"))],
    ));
    tree.apply(&insert_patch("vid", "ctl"));
    let mut props: Vec<(&str, Value)> = Vec::new();
    if let Some(i) = intent {
        props.push(("videoIntent.0", json!(i)));
    }
    if let Some(a) = action {
        props.push(("onClick.0", json!(a)));
    }
    tree.apply(&create_patch("fs", "Button", &props));
    tree.apply(&insert_patch("ctl", "fs"));
    tree
}

#[test]
fn video_intent_node_is_hittable_without_an_onclick() {
    clear_test_states();
    let tree = intent_button_tree(Some("fullscreen"), None);
    let mut text = TextEngine::new();
    set_test_state("vid", VideoPlayerState::Playing); // controls visible
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let item = find_item(&pass, "fs");
    assert_eq!(
        item.video_intent,
        Some(crate::video_v2::VideoIntent::Fullscreen),
        "the item must carry the resolved intent"
    );
    assert!(
        item.action.is_none(),
        "no `.onClick` — the intent alone makes it interactive"
    );
    let r = item.rect;
    let hit = pass.hit(r.x + r.w * 0.5, r.y + r.h * 0.5);
    assert_eq!(
        hit.map(|it| it.node_id.as_str()),
        Some("fs"),
        "an intent node is actionable for hit-testing purposes"
    );
    assert!(
        item.is_focusable(),
        "Enter / Space must be able to reach the intent too"
    );
    clear_test_states();
}

#[test]
fn video_intent_outside_a_video_subtree_is_inert() {
    clear_test_states();
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "fs",
        "Button",
        &[("videoIntent.0", json!("fullscreen"))],
    ));
    tree.apply(&insert_patch("root", "fs"));
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);

    let item = find_item(&pass, "fs");
    assert_eq!(
        item.video_intent, None,
        "no enclosing Video: the intent resolves to nothing"
    );
    let r = item.rect;
    assert!(
        pass.hit(r.x + r.w * 0.5, r.y + r.h * 0.5).is_none(),
        "an inert intent must not make an action-less node hittable"
    );
    assert!(!item.is_focusable());
    clear_test_states();
}

#[test]
fn unknown_video_intents_resolve_to_nothing() {
    clear_test_states();
    let tree = intent_button_tree(Some("picture-in-picture"), None);
    let mut text = TextEngine::new();
    set_test_state("vid", VideoPlayerState::Playing);
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    // Forward compatible: an intent this renderer doesn't know renders
    // inert instead of hijacking the tap.
    assert_eq!(find_item(&pass, "fs").video_intent, None);
    clear_test_states();
}

#[test]
fn a_hidden_slot_hides_its_intent_node_too() {
    clear_test_states();
    let tree = intent_button_tree(Some("fullscreen"), None);
    let mut text = TextEngine::new();
    set_test_state("vid", VideoPlayerState::Playing);
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let r = find_item(&pass, "fs").rect;

    // `error` hides the controls slot: the intent goes with it.
    set_test_state("vid", VideoPlayerState::Error);
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    assert!(pass.item_by_id("fs").is_none());
    assert!(pass.hit(r.x + r.w * 0.5, r.y + r.h * 0.5).is_none());
    clear_test_states();
}

#[test]
fn an_intent_node_keeps_its_own_onclick_action() {
    clear_test_states();
    let tree = intent_button_tree(Some("fullscreen"), Some("@actions.logged"));
    let mut text = TextEngine::new();
    set_test_state("vid", VideoPlayerState::Playing);
    let pass = LayoutPass::compute(&tree, &mut text, (800, 600), 1.0);
    let item = find_item(&pass, "fs");
    // The intent is renderer-local and additive: an author-wired action
    // on the same node still dispatches (only the built-in's own derived
    // `onPlay` is suppressed, in `window_input`).
    assert_eq!(item.action.as_deref(), Some("logged"));
    assert_eq!(
        item.video_intent,
        Some(crate::video_v2::VideoIntent::Fullscreen)
    );
    clear_test_states();
}

// ---------------------------------------------------------------------------
// Content-sized flex containers (`alignSelf(center)` heroes)
// ---------------------------------------------------------------------------

/// The Hypeflix Browse "featured hero": a page Column (cross-axis
/// stretch) holding a Row that opts out of the stretch with
/// `alignSelf("center")` and caps itself at `maxWidth(1200)`. The Row
/// holds a `flex-1 min-w-0 pr-4` text Column and a fixed-size
/// `shrink-0` poster Image.
fn hero_tree() -> Tree {
    const BLURB: &str = "A ragtag crew of moon prospectors stumbles onto a derelict \
freighter drifting past Jupiter, and the salvage of a lifetime turns into a \
night-long fight for the airlock in this restored public-domain thriller.";

    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "page",
        "Column",
        &[("alignItems", json!("stretch"))],
    ));
    tree.apply(&insert_patch("root", "page"));

    // .tw("mx-5 p-5 rounded-3xl border items-center").maxWidth(1200).alignSelf("center")
    tree.apply(&create_patch(
        "hero",
        "Row",
        &[
            ("marginLeft", json!(20)),
            ("marginRight", json!(20)),
            ("padding", json!(20)),
            ("borderWidth", json!(1)),
            ("alignItems", json!("center")),
            ("maxWidth", json!(1200)),
            ("alignSelf", json!("center")),
        ],
    ));
    tree.apply(&insert_patch("page", "hero"));

    // .tw("flex-1 min-w-0 pr-4 items-start")
    tree.apply(&create_patch(
        "herocol",
        "Column",
        &[
            ("flex", json!(1)),
            ("minWidth", json!(0)),
            ("paddingRight", json!(16)),
            ("alignItems", json!("start")),
        ],
    ));
    tree.apply(&insert_patch("hero", "herocol"));
    add_text(&mut tree, "herocol", "kicker", "FEATURED TONIGHT");
    add_text(&mut tree, "herocol", "title", "Salvage of the Sky Whale");
    add_text(&mut tree, "herocol", "meta", "1962 · 88 min · Sci-Fi");
    add_text(&mut tree, "herocol", "blurb", BLURB);

    // .tw("w-28 h-[168px] rounded-2xl shrink-0")
    tree.apply(&create_patch(
        "poster",
        "Image",
        &[
            ("src", json!("/poster.png")),
            ("width", json!(112)),
            ("height", json!(168)),
            ("flexShrink", json!(0)),
        ],
    ));
    tree.apply(&insert_patch("hero", "poster"));
    tree
}

#[test]
fn align_self_center_row_sizes_to_fit_content_not_min_content() {
    let tree = hero_tree();
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (1024, 768), 1.0);

    // fit-content = min(max-content, available) clamped by maxWidth(1200).
    // max-content here is the unwrapped blurb (well past 1200), so the
    // hero should take the whole 1024 viewport minus its 20px margins.
    let hero = find_item(&pass, "hero").rect;
    assert!(
        (hero.w - 984.0).abs() < 2.0,
        "hero Row should fill the viewport minus its mx-5 margins (≈984), got {hero:?}"
    );
    // ...and stay centred inside the stretch Column.
    assert!(
        (hero.x - (1024.0 - hero.w) / 2.0).abs() < 2.0,
        "alignSelf(center) should centre the hero, got {hero:?}"
    );
}

#[test]
fn content_sized_row_gives_its_flex_child_the_leftover_width() {
    let tree = hero_tree();
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (1024, 768), 1.0);

    let hero = find_item(&pass, "hero").rect;
    let col = find_item(&pass, "herocol").rect;
    // hero inner width = 984 - 2*(20 padding + 1 border) = 942;
    // the flex-1 column takes all of it bar the 112px poster.
    assert!(
        col.w > hero.w - 200.0,
        "flex-1 column should absorb the hero's leftover width; hero={hero:?} col={col:?}"
    );
}

#[test]
fn shrink_zero_poster_does_not_overlap_the_flex_text_column() {
    let tree = hero_tree();
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (1024, 768), 1.0);

    let col = find_item(&pass, "herocol").rect;
    let poster = find_item(&pass, "poster").rect;
    assert!(
        col.x + col.w <= poster.x + 0.5,
        "text column must end before the poster starts; col={col:?} poster={poster:?}"
    );
    for id in ["kicker", "title", "meta", "blurb"] {
        let t = find_item(&pass, id).rect;
        assert!(
            t.x + t.w <= poster.x + 0.5,
            "`{id}` must not run under the poster; text={t:?} poster={poster:?}"
        );
    }
}

#[test]
fn long_blurb_in_a_content_sized_row_does_not_wrap_per_word() {
    let tree = hero_tree();
    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (1024, 768), 1.0);

    let blurb = find_item(&pass, "blurb").rect;
    assert!(
        blurb.w > 600.0,
        "blurb should get a wide line box, not a min-content sliver; got {blurb:?}"
    );
    // ~200 chars at the default text size across an 800px+ line box is a
    // handful of lines — the collapsed layout produced 30+.
    assert!(
        blurb.h < 200.0,
        "blurb should wrap to a few lines, not one word per line; got {blurb:?}"
    );
}

#[test]
fn content_sized_row_still_shrinks_to_short_content() {
    // The fix must not turn every `alignSelf(center)` row into a
    // full-width bar: with content narrower than the viewport, the row
    // stays at its max-content width.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "page",
        "Column",
        &[("alignItems", json!("stretch"))],
    ));
    tree.apply(&insert_patch("root", "page"));
    tree.apply(&create_patch(
        "pill",
        "Row",
        &[("alignSelf", json!("center")), ("maxWidth", json!(1200))],
    ));
    tree.apply(&insert_patch("page", "pill"));
    tree.apply(&create_patch("grow", "Column", &[("flex", json!(1))]));
    tree.apply(&insert_patch("pill", "grow"));
    add_text(&mut tree, "grow", "label", "Live");

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (1024, 768), 1.0);

    let pill = find_item(&pass, "pill").rect;
    let label = find_item(&pass, "label").rect;
    assert!(
        pill.w < 200.0,
        "short content should stay at max-content width, got {pill:?}"
    );
    assert!(
        pill.w >= label.w - 0.5,
        "the row must still fit its text, pill={pill:?} label={label:?}"
    );
    assert!(
        (pill.x - (1024.0 - pill.w) / 2.0).abs() < 2.0,
        "alignSelf(center) should centre the pill, got {pill:?}"
    );
}

#[test]
fn stretched_rows_are_untouched_by_the_fit_content_pass() {
    // No alignSelf → the default `stretch` still fills the parent.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "page",
        "Column",
        &[("alignItems", json!("stretch"))],
    ));
    tree.apply(&insert_patch("root", "page"));
    tree.apply(&create_patch("row", "Row", &[]));
    tree.apply(&insert_patch("page", "row"));
    tree.apply(&create_patch("grow", "Column", &[("flex", json!(1))]));
    tree.apply(&insert_patch("row", "grow"));
    add_text(&mut tree, "grow", "label", "Live");

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (1024, 768), 1.0);
    let row = find_item(&pass, "row").rect;
    assert!(
        (row.w - 1024.0).abs() < 1.0,
        "a stretched Row should still fill the viewport, got {row:?}"
    );
}

#[test]
fn content_sized_button_wrapper_widens_its_stretched_inner_row() {
    // Hypeflix's marathon banner: the content-sized box is the Button
    // (column direction, `alignSelf("center")`), and the collapsing
    // flex-1 line lives one level down inside a stretched Row.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "page",
        "Column",
        &[("alignItems", json!("stretch"))],
    ));
    tree.apply(&insert_patch("root", "page"));
    tree.apply(&create_patch(
        "banner",
        "Button",
        &[
            ("marginLeft", json!(20)),
            ("marginRight", json!(20)),
            ("padding", json!(16)),
            ("alignItems", json!("stretch")),
            ("maxWidth", json!(1200)),
            ("alignSelf", json!("center")),
            ("onClick.0", json!("@actions.playMarathon")),
        ],
    ));
    tree.apply(&insert_patch("page", "banner"));
    tree.apply(&create_patch(
        "brow",
        "Row",
        &[("alignItems", json!("center"))],
    ));
    tree.apply(&insert_patch("banner", "brow"));
    tree.apply(&create_patch(
        "icon",
        "Icon",
        &[("size", json!(22)), ("flexShrink", json!(0))],
    ));
    tree.apply(&insert_patch("brow", "icon"));
    tree.apply(&create_patch(
        "btext",
        "Column",
        &[
            ("flex", json!(1)),
            ("minWidth", json!(0)),
            ("marginLeft", json!(12)),
            ("alignItems", json!("start")),
        ],
    ));
    tree.apply(&insert_patch("brow", "btext"));
    add_text(&mut tree, "btext", "btitle", "Midnight Creature Marathon");
    add_text(
        &mut tree,
        "btext",
        "bsub",
        "Three creature features, one continuous stream - a Video playlist demo",
    );
    tree.apply(&create_patch(
        "chev",
        "Icon",
        &[("size", json!(16)), ("flexShrink", json!(0))],
    ));
    tree.apply(&insert_patch("brow", "chev"));

    let mut text = TextEngine::new();
    let pass = LayoutPass::compute(&tree, &mut text, (1024, 768), 1.0);

    // fit-content: the banner's max-content here is under the 984px of
    // available space, so it lands on max-content — one unwrapped line
    // of subtitle plus the two icons — and stays centred.
    let banner = find_item(&pass, "banner").rect;
    assert!(
        banner.w > 500.0 && banner.w <= 984.0,
        "banner Button should size to max-content, got {banner:?}"
    );
    assert!(
        (banner.x - (1024.0 - banner.w) / 2.0).abs() < 2.0,
        "alignSelf(center) should centre the banner, got {banner:?}"
    );
    let sub = find_item(&pass, "bsub").rect;
    assert!(
        sub.w > 400.0,
        "subtitle should get a wide line box, got {sub:?}"
    );
    assert!(
        sub.h < 60.0,
        "subtitle should sit on one or two lines, got {sub:?}"
    );
    let title = find_item(&pass, "btitle").rect;
    let chev = find_item(&pass, "chev").rect;
    assert!(
        title.x + title.w <= chev.x + 0.5,
        "title must not run under the trailing icon; title={title:?} chev={chev:?}"
    );
}

// ---------------------------------------------------------------
// Cull buffer / re-emit threshold pairing
// ---------------------------------------------------------------

/// The emit window must span exactly the visible viewport plus
/// `CULL_BUFFER_VH` viewports of slack on each side: rows inside it
/// are emitted (so scroll-in is seamless), rows beyond it are culled
/// (so frame cost stays bounded). Pins the constant's semantics so a
/// future tuning change has to look at this math.
#[test]
fn cull_window_spans_viewport_plus_buffer_each_side() {
    use crate::layout::CULL_BUFFER_VH;
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    // 100 fixed-height rows of 100px → content 10,000px tall.
    for i in 0..100 {
        let id = format!("c{i}");
        tree.apply(&create_patch(&id, "Container", &[("height", json!(100.0))]));
        tree.apply(&insert_patch("col", &id));
    }
    let mut text = TextEngine::new();
    let scrolls = std::collections::HashMap::new();
    let (w, h) = (800u32, 600u32);
    let scroll_y = 3000.0f32;
    let pass = LayoutPass::compute_with_scrolls(&tree, &mut text, (w, h), 1.0, scroll_y, &scrolls);

    let buffer = h as f32 * CULL_BUFFER_VH;
    let lo = scroll_y - buffer; // rows whose bottom is above this are culled
    let hi = scroll_y + h as f32 + buffer; // rows whose top is below this are culled
    for i in 0..100 {
        let (top, bottom) = (i as f32 * 100.0, i as f32 * 100.0 + 100.0);
        let emitted = pass.item_by_id(&format!("c{i}")).is_some();
        let expect = !(bottom < lo || top > hi);
        assert_eq!(
            emitted, expect,
            "row c{i} (natural y {top}..{bottom}) vs window {lo}..{hi}"
        );
    }
    // Anchors chosen to PIN the constant at 2.0, not just the cull
    // shape (the loop above tracks whatever value the code uses, so
    // it alone can't catch a retune). Window at 2.0 is [1800, 4800]:
    // - c46 (top 4600) is emitted ONLY thanks to the full buffer — at
    //   1.0 the window ends at 4200 and this assert fails.
    // - c17 (bottom 1800) rides the window's top edge — any buffer
    //   below 2.0 starts later and this assert fails.
    // - c49 (top 4900) sits just past the window bottom, c16 (bottom
    //   1700) just above its top — at 2.5 either assert fails.
    assert!(pass.item_by_id("c46").is_some(), "inside the below-fold buffer");
    assert!(pass.item_by_id("c17").is_some(), "on the window's top edge");
    assert!(pass.item_by_id("c49").is_none(), "just past the window bottom");
    assert!(pass.item_by_id("c16").is_none(), "just above the window top");
}

// ---------------------------------------------------------------
// Phase B: paint-only relayout skip. `refresh_paint_only` must make
// the cached pass indistinguishable from a from-scratch recompute for
// every batch the paint-only classifier admits — these equivalence
// tests are the drift tripwire between `refresh_item_paint` and the
// `emit_items` arms it mirrors.
// ---------------------------------------------------------------

mod paint_refresh {
    use super::*;

    const VP: (u32, u32) = (800, 600);

    fn set_prop(id: &str, name: &str, value: Value) -> Patch {
        Patch::SetProp {
            id: id.into(),
            name: name.into(),
            value,
        }
    }

    fn remove_prop(id: &str, name: &str) -> Patch {
        Patch::RemoveProp {
            id: id.into(),
            name: name.into(),
        }
    }

    /// A fixture covering every non-media item kind: Texts, a Button,
    /// an Image, an Input, an Icon, nested Containers with border +
    /// background.
    fn fixture() -> Tree {
        let mut tree = Tree::new();
        tree.apply(&create_patch(
            "col",
            "Column",
            &[("backgroundColor", json!("#ffffff")), ("gap", json!(8.0))],
        ));
        tree.apply(&insert_patch("root", "col"));
        add_text(&mut tree, "col", "title", "Feed");
        tree.apply(&create_patch(
            "card",
            "Container",
            &[
                ("backgroundColor", json!("#f8fafc")),
                ("borderWidth", json!(1.0)),
                ("borderColor", json!("#e2e8f0")),
                ("borderRadius", json!(8.0)),
                ("padding", json!(12.0)),
            ],
        ));
        tree.apply(&insert_patch("col", "card"));
        tree.apply(&create_patch(
            "name",
            "Text",
            &[("0", json!("Ada Lovelace")), ("color", json!("#111827"))],
        ));
        tree.apply(&insert_patch("card", "name"));
        tree.apply(&create_patch(
            "btn",
            "Button",
            &[("onClick.0", json!("@actions.like"))],
        ));
        tree.apply(&insert_patch("card", "btn"));
        tree.apply(&create_patch(
            "avatar",
            "Image",
            &[
                ("src", json!("/avatars/ada.png")),
                ("objectFit", json!("cover")),
                ("width", json!(48.0)),
                ("height", json!(48.0)),
            ],
        ));
        tree.apply(&insert_patch("card", "avatar"));
        tree.apply(&create_patch(
            "field",
            "Input",
            &[("value", json!("hi")), ("placeholder", json!("Say something"))],
        ));
        tree.apply(&insert_patch("card", "field"));
        tree.apply(&create_patch(
            "icon",
            "Icon",
            &[
                ("__iconPaths", json!(["M0 0L24 24"])),
                ("__iconViewBox", json!("0 0 24 24")),
                ("color", json!("#334155")),
                ("size", json!(24.0)),
            ],
        ));
        tree.apply(&insert_patch("col", "icon"));
        tree
    }

    /// Ground-truth equivalence: compute a pass, mutate the tree with a
    /// batch the classifier admits, refresh the old pass in place, and
    /// demand it matches a from-scratch recompute item-for-item —
    /// including the derived indexes and the a11y map.
    fn assert_refresh_matches(mut tree: Tree, batch: &[Patch]) {
        let mut text = TextEngine::new();
        let mut refreshed = LayoutPass::compute(&tree, &mut text, VP, 1.0);
        for p in batch {
            tree.apply(p);
        }
        let affected =
            crate::window::paint_only_affected_ids(batch, &[], &tree, false, false, false)
                .expect("fixture batch must classify as paint-only");
        refreshed.refresh_paint_only(
            &tree,
            &affected,
            crate::style::Viewport::new(VP.0 as f32, VP.1 as f32),
            1.0,
        );
        let fresh = LayoutPass::compute(&tree, &mut text, VP, 1.0);

        assert_eq!(
            refreshed.items.len(),
            fresh.items.len(),
            "item count must not change under a paint-only refresh"
        );
        for (a, b) in refreshed.items.iter().zip(fresh.items.iter()) {
            assert_eq!(
                format!("{a:?}"),
                format!("{b:?}"),
                "item `{}` diverged between in-place refresh and full recompute",
                a.node_id
            );
        }
        assert_eq!(refreshed.content_size, fresh.content_size);
        assert_eq!(refreshed.by_node_id, fresh.by_node_id);
        assert_eq!(refreshed.actionable_ids, fresh.actionable_ids, "actionable index");
        assert_eq!(refreshed.focusable_ids, fresh.focusable_ids, "focusable index");
        assert_eq!(refreshed.scrollable_ids, fresh.scrollable_ids, "scrollable index");
        assert_eq!(refreshed.hoverable_ids, fresh.hoverable_ids, "hoverable index");
        let mut a: Vec<String> = refreshed
            .a11y
            .iter()
            .map(|(k, v)| format!("{k}={v:?}"))
            .collect();
        let mut b: Vec<String> = fresh
            .a11y
            .iter()
            .map(|(k, v)| format!("{k}={v:?}"))
            .collect();
        a.sort();
        b.sort();
        assert_eq!(a, b, "a11y semantics map");
    }

    #[test]
    fn text_color_flip() {
        assert_refresh_matches(fixture(), &[set_prop("name", "color", json!("#ff0000"))]);
    }

    #[test]
    fn text_align_change() {
        assert_refresh_matches(fixture(), &[set_prop("title", "textAlign", json!("center"))]);
    }

    #[test]
    fn container_background_and_border_color() {
        assert_refresh_matches(
            fixture(),
            &[
                set_prop("card", "backgroundColor", json!("#0ea5e9")),
                set_prop("card", "borderColor", json!("#f43f5e")),
            ],
        );
    }

    #[test]
    fn background_removed() {
        assert_refresh_matches(fixture(), &[remove_prop("card", "backgroundColor")]);
    }

    #[test]
    fn onclick_added_updates_action_and_indexes() {
        // `title` becomes actionable AND focusable — the derived-index
        // assertion is the point of this test.
        assert_refresh_matches(
            fixture(),
            &[set_prop("title", "onClick.0", json!("@actions.open"))],
        );
    }

    #[test]
    fn onclick_removed_updates_action_and_indexes() {
        assert_refresh_matches(fixture(), &[remove_prop("btn", "onClick.0")]);
    }

    #[test]
    fn onhover_added_updates_hoverable_index() {
        assert_refresh_matches(
            fixture(),
            &[
                set_prop("card", "onHover.0", json!("@actions.spotlight")),
                set_prop("card", "onHover.postId", json!(42)),
            ],
        );
    }

    #[test]
    fn input_value_placeholder_and_bind() {
        assert_refresh_matches(
            fixture(),
            &[
                set_prop("field", "value", json!("hello world")),
                set_prop("field", "placeholder", json!("Type here")),
                set_prop("field", "bind", json!("form.message")),
            ],
        );
    }

    #[test]
    fn input_color_and_background_defaults() {
        // The Input arm's specializations: explicit backgroundColor
        // replaces the default white fill; text colour re-resolves.
        assert_refresh_matches(
            fixture(),
            &[
                set_prop("field", "color", json!("#7c3aed")),
                set_prop("field", "backgroundColor", json!("#fef9c3")),
            ],
        );
    }

    #[test]
    fn image_src_and_fit_change() {
        assert_refresh_matches(
            fixture(),
            &[
                set_prop("avatar", "src", json!("/avatars/grace.png")),
                set_prop("avatar", "objectFit", json!("contain")),
            ],
        );
    }

    #[test]
    fn image_flips_to_icon_when_paths_arrive() {
        assert_refresh_matches(
            fixture(),
            &[
                set_prop("avatar", "__iconPaths", json!(["M2 2L22 22"])),
                set_prop("avatar", "__iconViewBox", json!("0 0 24 24")),
            ],
        );
    }

    #[test]
    fn icon_tint_change_and_flip_to_image() {
        assert_refresh_matches(fixture(), &[set_prop("icon", "color", json!("#dc2626"))]);
        assert_refresh_matches(
            fixture(),
            &[
                remove_prop("icon", "__iconPaths"),
                set_prop("icon", "src", json!("/fallback.png")),
            ],
        );
    }

    #[test]
    fn hover_variant_write() {
        assert_refresh_matches(
            fixture(),
            &[set_prop("btn", "backgroundColor:hover", json!("#e0f2fe"))],
        );
    }

    #[test]
    fn state_variant_write() {
        assert_refresh_matches(
            fixture(),
            &[
                set_prop("btn", "backgroundColor:focus", json!("#bae6fd")),
                set_prop("btn", "borderColor:active", json!("#0284c7")),
            ],
        );
    }

    #[test]
    fn opacity_set_propagates_to_descendants() {
        // `card`'s opacity multiplies down into name/btn/avatar/field —
        // the whole-items opacity post-pass is what keeps descendants
        // honest.
        assert_refresh_matches(fixture(), &[set_prop("card", "opacity", json!(0.5))]);
    }

    #[test]
    fn opacity_removed_resets_to_default() {
        let mut tree = fixture();
        tree.apply(&set_prop("card", "opacity", json!(0.5)));
        assert_refresh_matches(tree, &[remove_prop("card", "opacity")]);
    }

    #[test]
    fn transform_write_and_removal() {
        assert_refresh_matches(
            fixture(),
            &[
                set_prop("card", "translateY", json!(12.0)),
                set_prop("card", "scale", json!(1.05)),
            ],
        );
        let mut tree = fixture();
        tree.apply(&set_prop("card", "translateY", json!(12.0)));
        assert_refresh_matches(tree, &[remove_prop("card", "translateY")]);
    }

    #[test]
    fn set_semantics_refreshes_a11y_map() {
        let semantics: hypen_engine::ir::Semantics =
            serde_json::from_value(json!({ "role": "button", "name": "Like this post" }))
                .expect("valid semantics JSON");
        assert_refresh_matches(
            fixture(),
            &[Patch::SetSemantics {
                id: "btn".into(),
                semantics: Some(semantics.clone()),
            }],
        );
        // And alongside a paint prop in the same batch.
        assert_refresh_matches(
            fixture(),
            &[
                set_prop("btn", "backgroundColor", json!("#eef2ff")),
                Patch::SetSemantics {
                    id: "name".into(),
                    semantics: Some(semantics),
                },
            ],
        );
    }

    #[test]
    fn mixed_paint_only_batch() {
        assert_refresh_matches(
            fixture(),
            &[
                set_prop("name", "color", json!("#dc2626")),
                set_prop("card", "backgroundColor", json!("#f0fdf4")),
                set_prop("field", "value", json!("typed")),
                set_prop("avatar", "src", json!("/b.png")),
                set_prop("col", "opacity", json!(0.9)),
                set_prop("title", "translateX", json!(4.0)),
            ],
        );
    }

    #[test]
    fn affected_ids_without_items_are_skipped() {
        // A culled node has no item — the refresh must skip it without
        // panicking, and the full recompute at the same scroll agrees.
        let mut tree = Tree::new();
        tree.apply(&create_patch("col", "Column", &[]));
        tree.apply(&insert_patch("root", "col"));
        for i in 0..200 {
            let id = format!("row{i}");
            tree.apply(&create_patch(
                &id,
                "Text",
                &[
                    ("0", json!(format!("row {i}"))),
                    ("height", json!(100.0)),
                    ("color", json!("#0f172a")),
                ],
            ));
            tree.apply(&insert_patch("col", &id));
        }
        let mut text = TextEngine::new();
        let scrolls: HashMap<String, f32> = HashMap::new();
        let mut refreshed =
            LayoutPass::compute_with_scrolls(&tree, &mut text, VP, 1.0, 0.0, &scrolls);
        let batch = [set_prop("row150", "color", json!("#ff0000"))];
        for p in &batch {
            tree.apply(p);
        }
        assert!(
            refreshed.item_by_id("row150").is_none(),
            "precondition: row150 must be culled at scroll 0"
        );
        let affected =
            crate::window::paint_only_affected_ids(&batch, &[], &tree, false, false, false).unwrap();
        refreshed.refresh_paint_only(
            &tree,
            &affected,
            crate::style::Viewport::new(VP.0 as f32, VP.1 as f32),
            1.0,
        );
        let fresh = LayoutPass::compute_with_scrolls(&tree, &mut text, VP, 1.0, 0.0, &scrolls);
        assert_eq!(refreshed.items.len(), fresh.items.len());
        for (a, b) in refreshed.items.iter().zip(fresh.items.iter()) {
            assert_eq!(format!("{a:?}"), format!("{b:?}"));
        }
    }
}

// ---------------------------------------------------------------
// Review regressions (Phase B adversarial pass): the layout-prop
// classifier must cover every prop `node_style_with`'s call graph
// feeds into Taffy, and the Taffy restyle gate must accept the
// decorated wire keys the engine actually emits.
// ---------------------------------------------------------------

#[test]
fn layout_prop_classifier_covers_every_taffy_fed_prop() {
    // Each of these reaches a Taffy style field (apply_position_props,
    // apply_flex_props, apply_alignment_props, the Grid arm) — a
    // paint-only classification for any of them would let the
    // relayout-skip serve stale geometry.
    for name in [
        "inset",
        "flexDirection",
        "flex-direction",
        "gridColumns",
        "grid-columns",
        "horizontalAlignment",
        "verticalAlignment",
        "alignContent", // was a dead camelCase arm in a lowercased match
        "align-content",
        "edges", // SafeArea's inset mask → Taffy padding
    ] {
        assert!(
            crate::layout::is_layout_prop_key(name),
            "{name} feeds Taffy styles and must classify as layout"
        );
        let decorated = format!("{name}.0");
        assert!(
            crate::layout::is_layout_prop_key(&decorated),
            "{decorated} (flattened wire form) must classify as layout"
        );
    }
}

#[test]
fn taffy_restyle_fires_for_decorated_layout_keys() {
    // The engine flattens `.width(160)` to `width.0` — the Taffy
    // mirror's SetProp gate must restyle on the DECORATED key, or the
    // solver keeps the stale dimension while the classifier correctly
    // routes the batch through the full-relayout path.
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "box",
        "Container",
        &[("width.0", json!(160.0)), ("height.0", json!(40.0))],
    ));
    tree.apply(&insert_patch("root", "box"));
    let mut taffy = TaffyState::new();
    if !taffy.apply_patches(
        &[
            create_patch("box", "Container", &[("width.0", json!(160.0)), ("height.0", json!(40.0))]),
            insert_patch("root", "box"),
        ],
        &tree,
        1.0,
        crate::style::Viewport::new(800.0, 600.0),
    ) {
        taffy.mark_needs_rebuild();
    }
    let mut text = TextEngine::new();
    let scrolls: HashMap<String, f32> = HashMap::new();
    let pass = LayoutPass::compute_with_state(
        &mut taffy, &tree, &mut text, (800, 600), 1.0, 0.0, &scrolls, 0,
    );
    assert_eq!(find_item(&pass, "box").rect.w, 160.0);

    let patch = Patch::SetProp {
        id: "box".into(),
        name: "width.0".into(),
        value: json!(320.0),
    };
    tree.apply(&patch);
    assert!(taffy.apply_patches(
        std::slice::from_ref(&patch),
        &tree,
        1.0,
        crate::style::Viewport::new(800.0, 600.0)
    ));
    let pass = LayoutPass::compute_with_state(
        &mut taffy, &tree, &mut text, (800, 600), 1.0, 0.0, &scrolls, 1,
    );
    assert_eq!(
        find_item(&pass, "box").rect.w,
        320.0,
        "width.0 SetProp must restyle the Taffy node, not just dirty the fit pass"
    );
}

#[test]
fn scroll_meta_bakes_the_emitting_offset() {
    let tree = build_scrollable_column(30, "overflow");
    let mut text = TextEngine::new();
    let mut scrolls: HashMap<String, f32> = HashMap::new();
    scrolls.insert("scroller".to_string(), 120.0);
    let pass = LayoutPass::compute_with_scrolls(&tree, &mut text, (400, 600), 1.0, 0.0, &scrolls);
    let meta = find_item(&pass, "scroller")
        .scrollable
        .expect("scroller emits ScrollMeta");
    assert_eq!(
        meta.baked_offset, 120.0,
        "ScrollMeta must record the offset the descendants were emitted with"
    );
}

// ---------------------------------------------------------------
// Phase C: container-scroll fast path. `shift_container_scroll` must
// be indistinguishable from a fresh emit at the new offset (within
// the cull buffer), including nested-scrollable clips and transform
// origins.
// ---------------------------------------------------------------

mod container_shift {
    use super::*;

    const VP: (u32, u32) = (800, 600);

    /// Compare two passes item-for-item, normalizing the offset
    /// bookkeeping a shift legitimately leaves different from a fresh
    /// emit (`emitted_offset` anchors the re-emit threshold and is
    /// NOT advanced by shifts).
    fn assert_items_match(shifted: &LayoutPass, fresh: &LayoutPass) {
        assert_eq!(shifted.items.len(), fresh.items.len(), "item membership");
        for (a, b) in shifted.items.iter().zip(fresh.items.iter()) {
            let (mut a, mut b) = (a.clone(), b.clone());
            if let Some(m) = a.scrollable.as_mut() {
                m.emitted_offset = m.baked_offset;
            }
            if let Some(m) = b.scrollable.as_mut() {
                m.emitted_offset = m.baked_offset;
            }
            assert_eq!(
                format!("{a:?}"),
                format!("{b:?}"),
                "item `{}` diverged between in-place shift and fresh emit",
                a.node_id
            );
        }
    }

    /// Scroller (200px, overflow:scroll) with 8 fixed-height rows —
    /// everything within the cull buffer at both offsets, so
    /// membership is identical and the comparison is exhaustive. One
    /// row carries a rotation so the transform post-pass (origins =
    /// rect centers, which move under the shift) is exercised.
    fn fixture() -> Tree {
        let mut tree = Tree::new();
        tree.apply(&create_patch(
            "scroller",
            "Container",
            &[("overflow", json!("scroll")), ("height", json!(200.0))],
        ));
        tree.apply(&insert_patch("root", "scroller"));
        for i in 0..8 {
            let id = format!("r{i}");
            let mut props = vec![
                ("0", json!(format!("row {i}"))),
                ("height", json!(40.0)),
            ];
            if i == 3 {
                props.push(("rotate", json!(15.0)));
            }
            tree.apply(&create_patch(&id, "Text", &props));
            tree.apply(&insert_patch("scroller", &id));
        }
        tree
    }

    #[test]
    fn shift_matches_fresh_emit_at_new_offset() {
        let tree = fixture();
        let mut text = TextEngine::new();
        let mut scrolls: HashMap<String, f32> = HashMap::new();
        let mut shifted =
            LayoutPass::compute_with_scrolls(&tree, &mut text, VP, 1.0, 0.0, &scrolls);
        shifted.shift_container_scroll(
            &tree,
            "scroller",
            40.0,
            crate::style::Viewport::new(VP.0 as f32, VP.1 as f32),
            1.0,
        );
        scrolls.insert("scroller".to_string(), 40.0);
        let fresh = LayoutPass::compute_with_scrolls(&tree, &mut text, VP, 1.0, 0.0, &scrolls);
        assert_items_match(&shifted, &fresh);
        // The shift advanced the rect baseline but NOT the cull
        // anchor; a fresh emit re-bases both.
        let meta = shifted.item_by_id("scroller").unwrap().scrollable.unwrap();
        assert_eq!(meta.baked_offset, 40.0);
        assert_eq!(meta.emitted_offset, 0.0);
        let meta = fresh.item_by_id("scroller").unwrap().scrollable.unwrap();
        assert_eq!(meta.baked_offset, 40.0);
        assert_eq!(meta.emitted_offset, 40.0);
    }

    #[test]
    fn two_shifts_compose_like_one() {
        let tree = fixture();
        let mut text = TextEngine::new();
        let mut scrolls: HashMap<String, f32> = HashMap::new();
        let vp = crate::style::Viewport::new(VP.0 as f32, VP.1 as f32);
        let mut shifted =
            LayoutPass::compute_with_scrolls(&tree, &mut text, VP, 1.0, 0.0, &scrolls);
        shifted.shift_container_scroll(&tree, "scroller", 25.0, vp, 1.0);
        shifted.shift_container_scroll(&tree, "scroller", 15.0, vp, 1.0);
        scrolls.insert("scroller".to_string(), 40.0);
        let fresh = LayoutPass::compute_with_scrolls(&tree, &mut text, VP, 1.0, 0.0, &scrolls);
        assert_items_match(&shifted, &fresh);
    }

    #[test]
    fn shift_leaves_container_row_and_siblings_alone() {
        let mut tree = fixture();
        add_text(&mut tree, "root", "outside", "not in the scroller");
        let mut text = TextEngine::new();
        let scrolls: HashMap<String, f32> = HashMap::new();
        let mut pass = LayoutPass::compute_with_scrolls(&tree, &mut text, VP, 1.0, 0.0, &scrolls);
        let container_before = pass.item_by_id("scroller").unwrap().rect;
        let outside_before = pass.item_by_id("outside").unwrap().rect;
        pass.shift_container_scroll(
            &tree,
            "scroller",
            40.0,
            crate::style::Viewport::new(VP.0 as f32, VP.1 as f32),
            1.0,
        );
        assert_eq!(pass.item_by_id("scroller").unwrap().rect, container_before);
        assert_eq!(pass.item_by_id("outside").unwrap().rect, outside_before);
    }

    #[test]
    fn nested_scrollable_clips_shift_with_their_owner() {
        // outer (scrollable, 400px) → filler rows + inner (scrollable,
        // 150px) → rows. Scrolling the OUTER moves the inner container
        // and its rows; the inner rows' clip (anchored to the inner
        // container, which moved) must shift, while the direct
        // children of the outer keep their clip (the outer's rect,
        // which did not move).
        let mut tree = Tree::new();
        tree.apply(&create_patch(
            "outer",
            "Container",
            &[("overflow", json!("scroll")), ("height", json!(400.0))],
        ));
        tree.apply(&insert_patch("root", "outer"));
        for i in 0..3 {
            let id = format!("f{i}");
            tree.apply(&create_patch(&id, "Text", &[("0", json!("filler")), ("height", json!(40.0))]));
            tree.apply(&insert_patch("outer", &id));
        }
        tree.apply(&create_patch(
            "inner",
            "Container",
            &[("overflow", json!("scroll")), ("height", json!(150.0))],
        ));
        tree.apply(&insert_patch("outer", "inner"));
        for i in 0..4 {
            let id = format!("n{i}");
            tree.apply(&create_patch(&id, "Text", &[("0", json!("nested")), ("height", json!(40.0))]));
            tree.apply(&insert_patch("inner", &id));
        }
        let mut text = TextEngine::new();
        let mut scrolls: HashMap<String, f32> = HashMap::new();
        let vp = crate::style::Viewport::new(VP.0 as f32, VP.1 as f32);
        let mut shifted =
            LayoutPass::compute_with_scrolls(&tree, &mut text, VP, 1.0, 0.0, &scrolls);
        let filler_clip_before = shifted.item_by_id("f0").unwrap().clip_to;
        let nested_clip_before = shifted.item_by_id("n0").unwrap().clip_to;
        shifted.shift_container_scroll(&tree, "outer", 30.0, vp, 1.0);
        // Direct child of the outer: clip anchored to the outer's
        // (unmoved) rect stays put.
        assert_eq!(shifted.item_by_id("f0").unwrap().clip_to, filler_clip_before);
        // Nested row: clip anchored to the inner container, which
        // moved up 30px.
        let nested_clip_after = shifted.item_by_id("n0").unwrap().clip_to.unwrap();
        assert_eq!(nested_clip_after.y, nested_clip_before.unwrap().y - 30.0);
        // And the whole shifted pass matches a fresh emit.
        scrolls.insert("outer".to_string(), 30.0);
        let fresh = LayoutPass::compute_with_scrolls(&tree, &mut text, VP, 1.0, 0.0, &scrolls);
        assert_items_match(&shifted, &fresh);
    }
}

/// `SafeArea` — a full-size vertical container that pads itself by the
/// embedder-configured safe-area insets on whichever edges its `edges`
/// prop selects. Desktop's platform defaults are zero on every edge, so
/// an unconfigured SafeArea is a plain full-size Column.
mod safe_area {
    use super::*;

    const VP: (u32, u32) = (800, 600);

    /// A SafeArea under the root with one child that fills its content
    /// box, so a single rect reads back all four resolved insets:
    /// `x`/`y` are the left/top inset and `w`/`h` are the viewport minus
    /// the horizontal / vertical pair.
    fn safe_area_tree(props: &[(&str, Value)]) -> Tree {
        let mut tree = Tree::new();
        tree.apply(&create_patch("sa", "SafeArea", props));
        tree.apply(&insert_patch("root", "sa"));
        tree.apply(&create_patch(
            "fill",
            "Container",
            &[("width", json!("100%")), ("height", json!("100%"))],
        ));
        tree.apply(&insert_patch("sa", "fill"));
        tree
    }

    fn layout(tree: &Tree, insets: SafeAreaInsets) -> LayoutPass {
        let mut text = TextEngine::new();
        LayoutPass::compute_with_insets(tree, &mut text, VP, 1.0, insets)
    }

    /// `(x, y, w, h)` of the content-box-filling child.
    fn content_box(pass: &LayoutPass) -> (f32, f32, f32, f32) {
        let r = find_item(pass, "fill").rect;
        (r.x, r.y, r.w, r.h)
    }

    #[test]
    fn default_insets_lay_out_as_a_plain_full_size_container() {
        let tree = safe_area_tree(&[]);
        let pass = layout(&tree, SafeAreaInsets::default());

        // Full-size on BOTH axes, like App / a root Container.
        let sa = find_item(&pass, "sa").rect;
        assert_eq!(
            (sa.w, sa.h),
            (800.0, 600.0),
            "SafeArea should fill the viewport; got {sa:?}"
        );
        // Zero platform insets → no padding at all.
        assert_eq!(content_box(&pass), (0.0, 0.0, 800.0, 600.0));
    }

    #[test]
    fn window_controls_are_unsafe_only_under_a_macos_unified_titlebar() {
        use crate::layout::{window_controls_platform_insets, WINDOW_CONTROLS_BAR_HEIGHT};
        let merged = window_controls_platform_insets(true, true);
        assert_eq!(
            (merged.top, merged.right, merged.bottom, merged.left),
            (WINDOW_CONTROLS_BAR_HEIGHT, 0.0, 0.0, 0.0),
        );
        // Native decorations outside the client area → nothing unsafe.
        for (unified, macos) in [(true, false), (false, true), (false, false)] {
            let p = window_controls_platform_insets(unified, macos);
            assert_eq!((p.top, p.right, p.bottom, p.left), (0.0, 0.0, 0.0, 0.0));
        }
    }

    #[test]
    fn platform_insets_pad_safe_areas_without_any_embedder_override() {
        use crate::layout::{window_controls_platform_insets, WINDOW_CONTROLS_BAR_HEIGHT};
        let tree = safe_area_tree(&[]);
        let mut text = TextEngine::new();
        let pass = LayoutPass::compute_with_safe_area(
            &tree,
            &mut text,
            VP,
            1.0,
            SafeAreaInsets::default(),
            window_controls_platform_insets(true, true),
        );
        // SafeArea itself stays full-bleed; only the content clears the
        // controls bar.
        let sa = find_item(&pass, "sa").rect;
        assert_eq!((sa.w, sa.h), (800.0, 600.0));
        assert_eq!(
            content_box(&pass),
            (
                0.0,
                WINDOW_CONTROLS_BAR_HEIGHT,
                800.0,
                600.0 - WINDOW_CONTROLS_BAR_HEIGHT
            ),
        );
    }

    #[test]
    fn embedder_overrides_win_per_edge_over_the_platform_insets() {
        use crate::layout::window_controls_platform_insets;
        let tree = safe_area_tree(&[]);
        let mut text = TextEngine::new();
        // Explicit top: 0 beats the controls-bar platform value; the
        // bottom override stacks independently.
        let pass = LayoutPass::compute_with_safe_area(
            &tree,
            &mut text,
            VP,
            1.0,
            SafeAreaInsets::default().with_top(0.0).with_bottom(40.0),
            window_controls_platform_insets(true, true),
        );
        assert_eq!(content_box(&pass), (0.0, 0.0, 800.0, 560.0));
    }

    #[test]
    fn safe_area_resolves_to_its_own_branch_not_the_container_catchall() {
        // The generic container catchall is content-height. If
        // `SafeArea` ever stopped matching (a casing change on the
        // wire, say) this is the assertion that catches it: the same
        // tree spelled `Column` does NOT fill the viewport.
        let mut tree = Tree::new();
        tree.apply(&create_patch("col", "Column", &[]));
        tree.apply(&insert_patch("root", "col"));
        add_text(&mut tree, "col", "t1", "Inside");
        let mut text = TextEngine::new();
        let pass = LayoutPass::compute(&tree, &mut text, VP, 1.0);
        let col = find_item(&pass, "col").rect;
        assert!(
            col.h < 600.0,
            "a plain Column should be content-height, got {col:?}"
        );
    }

    #[test]
    fn configured_insets_pad_all_edges_and_stay_full_bleed() {
        let tree = safe_area_tree(&[]);
        let pass = layout(&tree, SafeAreaInsets::all(20.0));

        // Padding is inside the border box, so the SafeArea's own rect
        // (and therefore its background) still covers the viewport.
        let sa = find_item(&pass, "sa").rect;
        assert_eq!((sa.x, sa.y, sa.w, sa.h), (0.0, 0.0, 800.0, 600.0));
        // Content is inset on every edge.
        assert_eq!(content_box(&pass), (20.0, 20.0, 760.0, 560.0));
    }

    #[test]
    fn edges_prop_selects_which_edges_are_padded() {
        let tree = safe_area_tree(&[("edges", json!(["top", "left"]))]);
        let pass = layout(&tree, SafeAreaInsets::all(20.0));
        assert_eq!(content_box(&pass), (20.0, 20.0, 780.0, 580.0));

        // The complementary pair, to prove the mask isn't order- or
        // name-position dependent.
        let tree = safe_area_tree(&[("edges", json!(["bottom", "right"]))]);
        let pass = layout(&tree, SafeAreaInsets::all(20.0));
        assert_eq!(content_box(&pass), (0.0, 0.0, 780.0, 580.0));
    }

    #[test]
    fn edges_accepts_the_applicator_flattened_key_and_odd_casing() {
        // `.edges(["Top"])` arrives as `edges.0`; casing and whitespace
        // come straight from user DSL.
        let tree = safe_area_tree(&[("edges.0", json!([" Top ", "LEFT"]))]);
        let pass = layout(&tree, SafeAreaInsets::all(20.0));
        assert_eq!(content_box(&pass), (20.0, 20.0, 780.0, 580.0));
    }

    #[test]
    fn absent_empty_and_unparseable_edges_fall_back_to_all_edges() {
        let all = (20.0, 20.0, 760.0, 560.0);
        for props in [
            vec![],
            vec![("edges", json!([]))],
            vec![("edges", json!(["", "  "]))],
            // Not an array at all — never fatal, just ignored.
            vec![("edges", json!("top"))],
        ] {
            let tree = safe_area_tree(&props);
            let pass = layout(&tree, SafeAreaInsets::all(20.0));
            assert_eq!(content_box(&pass), all, "props: {props:?}");
        }
    }

    #[test]
    fn explicit_list_of_only_unknown_edges_insets_nothing() {
        // An explicit non-empty list is honored literally: unknown names
        // are dropped, and losing the last recognized entry must not
        // silently widen back to all four edges. Same contract as the
        // Swift, Android, and web renderers.
        let tree = safe_area_tree(&[("edges", json!(["nope", "middle"]))]);
        let pass = layout(&tree, SafeAreaInsets::all(20.0));
        assert_eq!(content_box(&pass), (0.0, 0.0, 800.0, 600.0));
    }

    #[test]
    fn per_edge_overrides_merge_over_the_platform_defaults() {
        // Only the bottom is overridden; the other three keep the
        // desktop platform value (zero).
        let insets = SafeAreaInsets::default().with_bottom(24.0);
        assert_eq!(insets.resolved().bottom, 24.0);
        assert_eq!(insets.resolved().top, 0.0);
        assert_eq!(insets.resolved().left, 0.0);
        assert_eq!(insets.resolved().right, 0.0);

        let tree = safe_area_tree(&[]);
        let pass = layout(&tree, insets);
        assert_eq!(content_box(&pass), (0.0, 0.0, 800.0, 576.0));

        // The merge is per-edge, not all-or-nothing: overriding one
        // edge of an otherwise-uniform set leaves the rest alone.
        let insets = SafeAreaInsets::all(20.0).with_top(0.0);
        let pass = layout(&safe_area_tree(&[]), insets);
        assert_eq!(content_box(&pass), (20.0, 0.0, 760.0, 580.0));
    }

    #[test]
    fn user_padding_adds_to_the_safe_area_inset() {
        let tree = safe_area_tree(&[("padding", json!(10.0))]);
        let pass = layout(&tree, SafeAreaInsets::all(20.0));
        assert_eq!(content_box(&pass), (30.0, 30.0, 740.0, 540.0));
    }

    #[test]
    fn insets_are_logical_px_and_scale_with_hidpi() {
        let tree = safe_area_tree(&[]);
        let mut text = TextEngine::new();
        // 800×600 logical on a 2x display.
        let pass = LayoutPass::compute_with_insets(
            &tree,
            &mut text,
            (1600, 1200),
            2.0,
            SafeAreaInsets::all(20.0),
        );
        let r = find_item(&pass, "fill").rect;
        assert_eq!((r.x, r.y, r.w, r.h), (40.0, 40.0, 1520.0, 1120.0));
    }

    #[test]
    fn nested_safe_areas_each_apply_their_own_insets() {
        let mut tree = safe_area_tree(&[]);
        // Replace the filler with an inner SafeArea holding it.
        tree.apply(&create_patch("inner", "SafeArea", &[]));
        tree.apply(&insert_patch("sa", "inner"));
        tree.apply(&insert_patch("inner", "fill"));

        let pass = layout(&tree, SafeAreaInsets::all(20.0));
        // Outer insets 20, inner insets 20 again — no special-casing,
        // the padding simply nests.
        assert_eq!(content_box(&pass), (40.0, 40.0, 720.0, 520.0));
    }

    #[test]
    fn empty_safe_area_still_lays_out() {
        let mut tree = Tree::new();
        tree.apply(&create_patch("sa", "SafeArea", &[]));
        tree.apply(&insert_patch("root", "sa"));
        let pass = layout(&tree, SafeAreaInsets::all(20.0));
        let sa = find_item(&pass, "sa").rect;
        assert_eq!((sa.w, sa.h), (800.0, 600.0));
    }

    #[test]
    fn a_live_edges_setprop_restyles_the_node() {
        // `edges` feeds Taffy padding, so the incremental patch gate
        // (`is_layout_prop_key`) has to treat it as layout-affecting —
        // otherwise a module toggling the mask keeps the old insets.
        let tree = safe_area_tree(&[("edges", json!(["top"]))]);
        let mut taffy = TaffyState::new();
        taffy.set_safe_area_insets(SafeAreaInsets::all(20.0));
        taffy.mark_needs_rebuild();
        let mut text = TextEngine::new();
        let before = LayoutPass::compute_with_state(
            &mut taffy,
            &tree,
            &mut text,
            VP,
            1.0,
            0.0,
            &HashMap::new(),
            1,
        );
        assert_eq!(content_box(&before), (0.0, 20.0, 800.0, 580.0));

        let patch = Patch::SetProp {
            id: "sa".into(),
            name: "edges".into(),
            value: json!(["left"]),
        };
        let mut tree = tree;
        tree.apply(&patch);
        assert!(taffy.apply_patches(
            std::slice::from_ref(&patch),
            &tree,
            1.0,
            crate::style::Viewport::new(VP.0 as f32, VP.1 as f32),
        ));
        let after = LayoutPass::compute_with_state(
            &mut taffy,
            &tree,
            &mut text,
            VP,
            1.0,
            0.0,
            &HashMap::new(),
            2,
        );
        assert_eq!(content_box(&after), (20.0, 0.0, 780.0, 600.0));
    }

    #[test]
    fn changing_the_insets_on_a_retained_state_restyles() {
        // The `TaffyState` restyle path goes through `node_style_with`,
        // not `build_subtree` — and only runs when the structure key
        // moves, which is why the insets are folded into it.
        let tree = safe_area_tree(&[]);
        let mut taffy = TaffyState::new();
        let mut text = TextEngine::new();
        let before = LayoutPass::compute_with_state(
            &mut taffy,
            &tree,
            &mut text,
            VP,
            1.0,
            0.0,
            &HashMap::new(),
            1,
        );
        assert_eq!(content_box(&before), (0.0, 0.0, 800.0, 600.0));

        taffy.set_safe_area_insets(SafeAreaInsets::all(20.0));
        let after = LayoutPass::compute_with_state(
            &mut taffy,
            &tree,
            &mut text,
            VP,
            1.0,
            0.0,
            &HashMap::new(),
            2,
        );
        assert_eq!(content_box(&after), (20.0, 20.0, 760.0, 560.0));
    }
}
