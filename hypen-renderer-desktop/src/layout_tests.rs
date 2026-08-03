//! Tests for `crate::layout`. Lives in its own file via `#[path]` so
//! `layout.rs` itself stays focused on the build / walk / API surface
//! without the editor-buffer weight of ~1.2k lines of test helpers
//! and patch-stream fixtures.

use super::*;
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
    let applied = taffy.apply_patches(&patches, &tree, 1.0, 800.0);
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
    assert!(taffy.apply_patches(&initial, &tree, 1.0, 800.0));

    let setprop = vec![hypen_engine::Patch::SetProp {
        id: "box".into(),
        name: "padding".into(),
        value: json!(40),
    }];
    tree.apply_batch(&setprop);
    assert!(taffy.apply_patches(&setprop, &tree, 1.0, 800.0));

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
    assert!(taffy.apply_patches(&patches, &tree, 1.0, 800.0));
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
    assert!(taffy.apply_patches(&patches, &tree, 1.0, 800.0));
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
    assert!(taffy.apply_patches(&patches, &tree, 1.0, 800.0));

    let remove = vec![hypen_engine::Patch::Remove { id: "a".into() }];
    tree.apply_batch(&remove);
    assert!(taffy.apply_patches(&remove, &tree, 1.0, 800.0));

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
    assert!(taffy.apply_patches(&initial, &tree, 1.0, 800.0));
    let baseline = taffy.total_node_count();

    // Re-Create the same id many times, as a render loop would.
    for _ in 0..50 {
        let recreate = vec![create_patch("a", "Text", &[("0", json!("a"))])];
        tree.apply_batch(&recreate);
        assert!(taffy.apply_patches(&recreate, &tree, 1.0, 800.0));
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
