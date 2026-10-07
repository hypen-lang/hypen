//! Tests for [`crate::chart`] — the Chart family's contract.
//!
//! Lives in its own file via `#[path]` for the same reason
//! `layout_tests.rs` does: `chart.rs` stays the readable description of
//! how a chart is resolved, without the fixture weight.
//!
//! The behaviours pinned here are the cross-renderer contract (the DOM
//! renderer's `dom.chart-contract.test.ts` is the same list): data
//! normalisation, domain resolution, nice ticks, insets, mark geometry,
//! highlight dimming, `Marker` placement and hiding, and payload
//! resolution — including the nearest-x fallback and the pointer-less
//! case. The last block drives the real [`LayoutPass`] so the layout
//! contract (leaf-like block, 200px default height, marks laid out by the
//! chart, decorative marks transparent to the pointer) is pinned against
//! the renderer rather than against this module alone.

use super::*;
use crate::layout::{ItemKind, LayoutPass};
use crate::style::vp;
use crate::text::TextEngine;
use crate::tree::Tree;
use hypen_engine::Patch;
use indexmap::IndexMap;
use serde_json::json;
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/// A chart under `root` with the given marks, plus the resolved scene for
/// a 320x200 host at the origin (the DOM reference's default box, so the
/// numbers in these tests line up with the contract suite's).
fn scene_with(
    chart_props: &[(&str, Value)],
    marks: &[(&str, &str, Vec<(&str, Value)>)],
) -> (Tree, ChartScene) {
    let mut tree = Tree::new();
    tree.apply(&create_patch("c", "Chart", chart_props));
    tree.apply(&insert_patch("root", "c"));
    for (id, element_type, props) in marks {
        tree.apply(&create_patch(id, element_type, props));
        tree.apply(&insert_patch("c", id));
    }
    let rect = Rect {
        x: 0.0,
        y: 0.0,
        w: defaults::WIDTH,
        h: defaults::HEIGHT,
    };
    let scene = build_scene(&tree, "c", rect, vp(800.0), 1.0);
    (tree, scene)
}

fn mark_node(element_type: &str, props: &[(&str, Value)]) -> Node {
    let mut tree = Tree::new();
    tree.apply(&create_patch("m", element_type, props));
    tree.apply(&insert_patch("root", "m"));
    tree.get("m").expect("mark node").clone()
}

fn bars_of(scene: &ChartScene) -> Vec<(Rect, ShapePaint)> {
    scene
        .shapes
        .iter()
        .filter_map(|s| match s {
            ChartShape::Rect { rect, paint, .. } => Some((*rect, paint.clone())),
            _ => None,
        })
        .collect()
}

fn labels_of(scene: &ChartScene) -> Vec<String> {
    scene
        .shapes
        .iter()
        .filter_map(|s| match s {
            ChartShape::Label { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn segments_of(scene: &ChartScene) -> Vec<(f32, f32, f32, f32, ShapePaint)> {
    scene
        .shapes
        .iter()
        .filter_map(|s| match s {
            ChartShape::Segment {
                x1,
                y1,
                x2,
                y2,
                paint,
            } => Some((*x1, *y1, *x2, *y2, paint.clone())),
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Data normalisation
// ---------------------------------------------------------------------------

#[test]
fn a_bare_number_list_uses_the_index_as_x() {
    let data = normalize_data(&mark_node("Line", &[("points", json!([3, 5, 2]))]));
    assert_eq!(data.len(), 3);
    assert_eq!(data[0].x, DataX::Num(0.0));
    assert_eq!(data[2].x, DataX::Num(2.0));
    assert_eq!(
        data.iter().map(|d| d.y).collect::<Vec<_>>(),
        [3.0, 5.0, 2.0]
    );
}

#[test]
fn tuples_read_x_and_y_positionally() {
    let data = normalize_data(&mark_node("Line", &[("points", json!([[1, 3], [2, 5]]))]));
    assert_eq!(data[0].x, DataX::Num(1.0));
    assert_eq!(data[1].y, 5.0);
}

#[test]
fn objects_use_the_field_names_and_keep_the_raw_row() {
    let rows = json!([{ "month": "Jan", "count": 10 }, { "month": "Feb", "count": 30 }]);
    let data = normalize_data(&mark_node(
        "Bars",
        &[
            ("data", rows.clone()),
            ("x", json!("month")),
            ("y", json!("count")),
        ],
    ));
    assert_eq!(data[1].x, DataX::Cat("Feb".into()));
    assert_eq!(data[1].y, 30.0);
    assert_eq!(data[1].raw, rows[1]);
}

#[test]
fn bars_sugar_label_and_value_name_the_fields() {
    let data = normalize_data(&mark_node(
        "Bars",
        &[
            ("data", json!([{ "m": "Jan", "n": 4 }])),
            ("label", json!("m")),
            ("value", json!("n")),
        ],
    ));
    assert_eq!(data[0].x, DataX::Cat("Jan".into()));
    assert_eq!(data[0].y, 4.0);
}

#[test]
fn a_json_encoded_list_is_accepted() {
    let data = normalize_data(&mark_node("Line", &[("points", json!("[1, 2, 3]"))]));
    assert_eq!(data.len(), 3);
}

#[test]
fn a_missing_x_field_falls_back_to_the_index() {
    let data = normalize_data(&mark_node("Line", &[("points", json!([{ "y": 7 }]))]));
    assert_eq!(data[0].x, DataX::Num(0.0));
    assert_eq!(data[0].y, 7.0);
}

#[test]
fn rows_without_a_usable_y_are_dropped_not_zeroed() {
    let data = normalize_data(&mark_node(
        "Line",
        &[("points", json!([1, null, "nope", 4]))],
    ));
    assert_eq!(data.len(), 2);
    // The surviving rows keep their ORIGINAL positions, which is what the
    // event payload's `index` means.
    assert_eq!(data[1].index, 3);
}

// ---------------------------------------------------------------------------
// Domains, ticks, insets
// ---------------------------------------------------------------------------

#[test]
fn nice_ticks_match_the_reference() {
    assert_eq!(
        ticks(0.0, 100.0, 5),
        vec![0.0, 20.0, 40.0, 60.0, 80.0, 100.0]
    );
    assert_eq!(
        ticks(0.0, 7.0, 5),
        vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]
    );
    assert_eq!(nice_domain(12.0, 63.0, 5), (10.0, 70.0));
}

#[test]
fn a_degenerate_domain_is_padded() {
    assert_eq!(nice_domain(5.0, 5.0, 5), (4.5, 5.5));
    assert_eq!(nice_domain(0.0, 0.0, 5), (-1.0, 1.0));
}

#[test]
fn explicit_chart_ranges_win() {
    let (_, scene) = scene_with(
        &[("x", json!([0, 10])), ("y", json!([0, 100]))],
        &[("l", "Line", vec![("points", json!([1, 2, 3]))])],
    );
    assert_eq!((scene.x.min, scene.x.max), (0.0, 10.0));
    assert_eq!((scene.y.min, scene.y.max), (0.0, 100.0));
}

#[test]
fn without_ranges_the_y_domain_is_the_nice_rounded_union() {
    let (_, scene) = scene_with(
        &[],
        &[
            ("a", "Line", vec![("points", json!([12, 40]))]),
            ("b", "Line", vec![("points", json!([63]))]),
        ],
    );
    assert_eq!((scene.y.min, scene.y.max), (10.0, 70.0));
}

#[test]
fn bars_always_include_zero_so_heights_are_honest() {
    let (_, scene) = scene_with(&[], &[("b", "Bars", vec![("data", json!([50, 60]))])]);
    assert_eq!(scene.y.min, 0.0);
}

#[test]
fn a_string_x_anywhere_switches_x_to_categorical_bands() {
    let (_, scene) = scene_with(
        &[],
        &[(
            "b",
            "Bars",
            vec![("data", json!([{"x": "Jan", "y": 1}, {"x": "Feb", "y": 2}]))],
        )],
    );
    assert_eq!(scene.x.kind, ScaleKind::Band);
    assert_eq!(scene.x.categories, vec!["Jan".to_string(), "Feb".into()]);
    // First-seen order, band centres: a 312px plot (320 less the 4px
    // sparkline inset each side) splits into two 156px bands.
    assert_eq!(scene.x.band, 156.0);
    assert_eq!(scene.x.map(&DataX::Cat("Jan".into())), Some(82.0));
    assert_eq!(scene.x.map(&DataX::Cat("Feb".into())), Some(238.0));
}

#[test]
fn a_bare_chart_is_edge_to_edge_and_axes_reserve_label_room() {
    let (_, bare) = scene_with(&[], &[("l", "Line", vec![("points", json!([1, 2]))])]);
    assert_eq!(bare.plot.x, defaults::BARE_INSET);

    let (_, axes) = scene_with(
        &[],
        &[
            ("ax", "Axis", vec![("0", json!("x"))]),
            ("ay", "Axis", vec![("0", json!("y"))]),
            ("l", "Line", vec![("points", json!([1, 2]))]),
        ],
    );
    assert_eq!(axes.plot.x, defaults::INSET_LEFT);
    assert_eq!(
        axes.plot.y + axes.plot.h,
        defaults::HEIGHT - defaults::INSET_BOTTOM
    );
}

#[test]
fn the_padding_prop_overrides_every_inset() {
    assert_eq!(insets(Some(9.0), true, true), (9.0, 9.0, 9.0, 9.0));
    assert_eq!(
        insets(None, true, false),
        (
            defaults::INSET_TOP,
            defaults::INSET_RIGHT,
            defaults::INSET_BOTTOM,
            defaults::BARE_INSET
        )
    );
}

// ---------------------------------------------------------------------------
// Mark geometry
// ---------------------------------------------------------------------------

#[test]
fn bars_are_one_rect_per_datum_with_proportional_heights() {
    let (_, scene) = scene_with(
        &[("y", json!([0, 100]))],
        &[(
            "b",
            "Bars",
            vec![("data", json!([{"x": "a", "y": 25}, {"x": "b", "y": 50}]))],
        )],
    );
    let bars = bars_of(&scene);
    assert_eq!(bars.len(), 2);
    // Twice the value, twice the height, both growing from the zero line.
    assert!((bars[1].0.h - bars[0].0.h * 2.0).abs() < 0.01);
    let base = scene.plot.y + scene.plot.h;
    assert!((bars[0].0.y + bars[0].0.h - base).abs() < 0.01);
    // Default bar width is 70% of the band.
    assert!((bars[0].0.w - scene.x.band * defaults::BAR_WIDTH).abs() < 0.01);
}

#[test]
fn highlight_keeps_the_chosen_bars_and_dims_the_rest() {
    let (_, scene) = scene_with(
        &[],
        &[(
            "b",
            "Bars",
            vec![("data", json!([1, 2, 3])), ("highlight", json!(1))],
        )],
    );
    let bars = bars_of(&scene);
    let alpha = |i: usize| bars[i].1.fill.expect("bars fill").3;
    assert!(
        alpha(1) > alpha(0),
        "the highlighted bar keeps full opacity"
    );
    assert_eq!(alpha(0), alpha(2), "every other bar is dimmed equally");
    let full = alpha(1) as f32;
    assert!((alpha(0) as f32 - full * defaults::DIMMED_OPACITY).abs() <= 1.0);
}

#[test]
fn a_line_is_a_polyline_with_no_fill_and_a_default_stroke_width_of_two() {
    let (_, scene) = scene_with(
        &[("x", json!([0, 2])), ("y", json!([0, 10]))],
        &[("l", "Line", vec![("points", json!([0, 5, 10]))])],
    );
    let path = scene
        .shapes
        .iter()
        .find_map(|s| match s {
            ChartShape::Path { points, paint, .. } => Some((points.clone(), paint.clone())),
            _ => None,
        })
        .expect("line path");
    assert_eq!(path.0.len(), 3);
    assert!(path.1.fill.is_none(), "a line is stroked, never filled");
    assert_eq!(path.1.width, 2.0);
    assert!(path.1.round_cap);
}

#[test]
fn an_area_closes_back_down_to_the_zero_line() {
    let (_, scene) = scene_with(
        &[("y", json!([0, 10]))],
        &[("a", "Area", vec![("points", json!([2, 8]))])],
    );
    let (base, paint) = scene
        .shapes
        .iter()
        .find_map(|s| match s {
            ChartShape::Path {
                close_to_y, paint, ..
            } => Some((*close_to_y, paint.clone())),
            _ => None,
        })
        .expect("area path");
    assert_eq!(base, Some(scene.plot.y + scene.plot.h));
    assert!(paint.stroke.is_none(), "an area is filled, never stroked");
    // Default fill-opacity 0.15 of the inherited text colour.
    assert_eq!(paint.fill.expect("area fill").3, 38);
}

#[test]
fn points_draw_one_circle_per_row_with_a_larger_touch_target() {
    let (_, scene) = scene_with(
        &[],
        &[(
            "p",
            "Points",
            vec![
                ("points", json!([[1, 1]])),
                ("radius", json!(5)),
                ("onClick.0", json!("@actions.pick")),
            ],
        )],
    );
    let radii: Vec<f32> = scene
        .shapes
        .iter()
        .filter_map(|s| match s {
            ChartShape::Circle { r, .. } => Some(*r),
            _ => None,
        })
        .collect();
    assert_eq!(radii, vec![5.0]);
    // Drawn at 5px, hittable at 12 — fingers work.
    assert_eq!(scene.marks[0].hit_radius, defaults::HIT_RADIUS);
}

#[test]
fn axis_x_labels_every_category_and_axis_y_labels_nice_ticks() {
    let (_, scene) = scene_with(
        &[("y", json!([0, 100]))],
        &[
            (
                "ax",
                "Axis",
                vec![("0", json!("x")), ("label", json!("Month"))],
            ),
            ("ay", "Axis", vec![("0", json!("y")), ("ticks", json!(2))]),
            (
                "b",
                "Bars",
                vec![(
                    "data",
                    json!([{"x": "Jan", "y": 10}, {"x": "Feb", "y": 90}]),
                )],
            ),
        ],
    );
    let labels = labels_of(&scene);
    assert_eq!(
        labels,
        vec![
            "Jan".to_string(),
            "Feb".into(),
            "Month".into(),
            "0".into(),
            "50".into(),
            "100".into()
        ]
    );
}

#[test]
fn axis_grid_lines_span_the_plot() {
    let (_, scene) = scene_with(
        &[("y", json!([0, 10]))],
        &[
            (
                "ay",
                "Axis",
                vec![
                    ("0", json!("y")),
                    ("grid", json!(true)),
                    ("ticks", json!(1)),
                ],
            ),
            ("l", "Line", vec![("points", json!([1]))]),
        ],
    );
    let right = scene.plot.x + scene.plot.w;
    assert!(
        segments_of(&scene)
            .iter()
            .any(|(x1, _, x2, _, _)| *x1 == scene.plot.x && *x2 == right),
        "expected a horizontal grid line spanning the plot"
    );
    assert_eq!(right, defaults::WIDTH - defaults::INSET_RIGHT);
}

#[test]
fn rule_is_a_dashed_line_across_the_plot_at_the_data_value() {
    let (_, scene) = scene_with(
        &[("x", json!([0, 1])), ("y", json!([0, 10]))],
        &[
            ("r", "Rule", vec![("y", json!(5))]),
            ("l", "Line", vec![("points", json!([1]))]),
        ],
    );
    let (x1, y1, x2, y2, paint) = segments_of(&scene).remove(0);
    assert_eq!((x1, x2), (scene.plot.x, scene.plot.x + scene.plot.w));
    assert_eq!(y1, y2);
    assert!((y1 - (scene.plot.y + scene.plot.h * 0.5)).abs() < 0.01);
    assert_eq!(paint.dash, Some((4.0, 4.0)));
}

#[test]
fn a_marker_sits_at_the_data_coordinate_and_keeps_its_anchor() {
    let (_, scene) = scene_with(
        &[("x", json!([0, 10])), ("y", json!([0, 10]))],
        &[(
            "m",
            "Marker",
            vec![
                ("x", json!(5)),
                ("y", json!(5)),
                ("anchor", json!("bottom")),
            ],
        )],
    );
    let place = scene.marker("m").expect("placed marker");
    assert!((place.x - (scene.plot.x + scene.plot.w * 0.5)).abs() < 0.01);
    assert!((place.y - (scene.plot.y + scene.plot.h * 0.5)).abs() < 0.01);
    assert_eq!(place.anchor, Anchor::Bottom);
}

#[test]
fn a_marker_with_no_coordinates_is_hidden_and_one_coordinate_centres_the_other_axis() {
    let (_, scene) = scene_with(
        &[("x", json!([0, 10])), ("y", json!([0, 10]))],
        &[
            ("hidden", "Marker", vec![]),
            ("goal", "Marker", vec![("y", json!(10))]),
        ],
    );
    assert!(
        scene.marker("hidden").is_none(),
        "a marker with neither coordinate is hidden"
    );
    let goal = scene.marker("goal").expect("half-placed marker");
    assert!((goal.x - (scene.plot.x + scene.plot.w * 0.5)).abs() < 0.01);
    assert!((goal.y - scene.plot.y).abs() < 0.01);
}

#[test]
fn the_anchor_rule_positions_content_around_the_point() {
    // 40x20 content, 8px gap: top puts it above and centred.
    assert_eq!(anchor_offset(Anchor::Top, 40.0, 20.0, 8.0), (-20.0, -28.0));
    assert_eq!(anchor_offset(Anchor::Bottom, 40.0, 20.0, 8.0), (-20.0, 8.0));
    assert_eq!(anchor_offset(Anchor::Left, 40.0, 20.0, 8.0), (-48.0, -10.0));
    assert_eq!(anchor_offset(Anchor::Right, 40.0, 20.0, 8.0), (8.0, -10.0));
    assert_eq!(
        anchor_offset(Anchor::Center, 40.0, 20.0, 8.0),
        (-20.0, -10.0)
    );
}

#[test]
fn path_is_drawn_in_data_units_through_one_affine_transform() {
    let (_, scene) = scene_with(
        &[("x", json!([0, 10])), ("y", json!([0, 10]))],
        &[("q", "Path", vec![("d", json!("M0,0 L10,10"))])],
    );
    let (d, transform) = scene
        .shapes
        .iter()
        .find_map(|s| match s {
            ChartShape::SvgPath { d, transform, .. } => Some((d.clone(), *transform)),
            _ => None,
        })
        .expect("svg path");
    assert_eq!(d, "M0,0 L10,10");
    let [sx, _, _, sy, tx, ty] = transform;
    // Data (0,0) maps to the plot's bottom-left, (10,10) to its top-right.
    assert!((tx - scene.plot.x).abs() < 0.01);
    assert!((ty - (scene.plot.y + scene.plot.h)).abs() < 0.01);
    assert!((sx * 10.0 + tx - (scene.plot.x + scene.plot.w)).abs() < 0.01);
    assert!(sy < 0.0, "y flips: data grows up, pixels grow down");
}

#[test]
fn glow_defaults_to_six_pixels_in_the_inherited_colour() {
    let (_, scene) = scene_with(
        &[("color", json!("#10b981"))],
        &[(
            "l",
            "Line",
            vec![("points", json!([1, 2])), ("glow.0", json!(true))],
        )],
    );
    let glow = scene
        .shapes
        .iter()
        .find_map(|s| match s {
            ChartShape::Path { paint, .. } => paint.glow,
            _ => None,
        })
        .expect("glow");
    assert_eq!(glow.radius, defaults::GLOW_RADIUS);
    assert_eq!(glow.color, crate::style::parse_color("#10b981").unwrap());
    assert_eq!((glow.dx, glow.dy), (0.0, 0.0), "a glow has no offset");
}

#[test]
fn the_shadow_family_becomes_a_shape_shadow_too() {
    let (_, scene) = scene_with(
        &[],
        &[(
            "l",
            "Line",
            vec![
                ("points", json!([1, 2])),
                ("shadow.0", json!({ "y": 2, "blur": 8, "color": "#000000" })),
            ],
        )],
    );
    let glow = scene
        .shapes
        .iter()
        .find_map(|s| match s {
            ChartShape::Path { paint, .. } => paint.glow,
            _ => None,
        })
        .expect("shape shadow");
    assert_eq!((glow.dx, glow.dy, glow.radius), (0.0, 2.0, 8.0));
}

#[test]
fn style_applicators_override_the_per_kind_defaults() {
    let (_, scene) = scene_with(
        &[],
        &[(
            "l",
            "Line",
            vec![
                ("points", json!([1, 2])),
                ("stroke.0", json!("#3b82f6")),
                ("strokeWidth.0", json!(3)),
                ("strokeOpacity.0", json!(0.5)),
            ],
        )],
    );
    let paint = scene
        .shapes
        .iter()
        .find_map(|s| match s {
            ChartShape::Path { paint, .. } => Some(paint.clone()),
            _ => None,
        })
        .expect("line paint");
    assert_eq!(paint.width, 3.0);
    let stroke = paint.stroke.expect("stroke");
    assert_eq!((stroke.0, stroke.1, stroke.2), (0x3b, 0x82, 0xf6));
    assert_eq!(stroke.3, 128, "stroke-opacity is unitless and multiplies");
}

#[test]
fn logical_lengths_scale_with_the_display() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("c", "Chart", &[]));
    tree.apply(&insert_patch("root", "c"));
    tree.apply(&create_patch(
        "l",
        "Line",
        &[
            ("points", json!([1, 2])),
            ("onClick.0", json!("@actions.p")),
        ],
    ));
    tree.apply(&insert_patch("c", "l"));
    let rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 640.0,
        h: 400.0,
    };
    let scene = build_scene(&tree, "c", rect, vp(800.0), 2.0);
    assert_eq!(scene.plot.x, defaults::BARE_INSET * 2.0);
    assert_eq!(scene.marks[0].hit_radius, defaults::HIT_RADIUS * 2.0);
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

fn interactive_bars() -> (Tree, ChartScene) {
    scene_with(
        &[],
        &[(
            "b",
            "Bars",
            vec![
                (
                    "data",
                    json!([
                        { "month": "Jan", "count": 10 },
                        { "month": "Feb", "count": 30 },
                        { "month": "Mar", "count": 20 }
                    ]),
                ),
                ("x", json!("month")),
                ("y", json!("count")),
                ("series", json!("units")),
                ("onClick.0", json!("@actions.pick")),
            ],
        )],
    )
}

#[test]
fn tapping_a_bar_resolves_that_row() {
    let (_, scene) = interactive_bars();
    let mark = &scene.marks[0];
    let (rect, index) = mark.bars[1];
    assert_eq!(index, 1);
    let payload = mark.payload(Some((rect.x + rect.w * 0.5, rect.y + rect.h * 0.5)));
    assert_eq!(payload["series"], json!("units"));
    assert_eq!(payload["index"], json!(1));
    assert_eq!(payload["x"], json!("Feb"));
    assert_eq!(payload["y"], json!(30.0));
    assert_eq!(payload["datum"], json!({ "month": "Feb", "count": 30 }));
}

#[test]
fn a_hit_on_the_line_itself_resolves_the_datum_nearest_the_pointer() {
    let (_, scene) = scene_with(
        &[("x", json!([0, 2])), ("y", json!([0, 10]))],
        &[(
            "l",
            "Line",
            vec![
                ("points", json!([1, 5, 9])),
                ("onHover.0", json!("@actions.hover")),
            ],
        )],
    );
    let mark = &scene.marks[0];
    // Just right of the plot's centre: x = 1 is still the nearest vertex.
    let mid = scene.plot.x + scene.plot.w * 0.5;
    let payload = mark.payload(Some((mid + 10.0, scene.plot.y)));
    assert_eq!(payload["series"], json!("line"));
    assert_eq!(payload["index"], json!(1));
    assert_eq!(payload["x"], json!(1.0));
    assert_eq!(payload["y"], json!(5.0));
}

#[test]
fn a_pointer_past_the_last_vertex_clamps_to_the_last_datum() {
    let (_, scene) = scene_with(
        &[("x", json!([0, 2]))],
        &[(
            "l",
            "Line",
            vec![
                ("points", json!([1, 5, 9])),
                ("onClick.0", json!("@actions.pick")),
            ],
        )],
    );
    let payload = scene.marks[0].payload(Some((9999.0, 0.0)));
    assert_eq!(payload["index"], json!(2));
}

#[test]
fn an_event_without_a_pointer_still_names_the_series() {
    let (_, scene) = scene_with(
        &[],
        &[(
            "l",
            "Line",
            vec![
                ("points", json!([1])),
                ("name", json!("revenue")),
                ("onClick.0", json!("@actions.pick")),
            ],
        )],
    );
    let payload = scene.marks[0].payload(None);
    assert_eq!(payload["series"], json!("revenue"));
    assert!(!payload.contains_key("index"));
}

#[test]
fn chart_level_events_resolve_the_pointer_to_data_coordinates() {
    let (_, scene) = scene_with(
        &[("x", json!([0, 100])), ("y", json!([0, 10]))],
        &[("l", "Line", vec![("points", json!([[0, 0]]))])],
    );
    let payload = scene.payload(scene.plot.x + scene.plot.w * 0.5, scene.plot.y);
    assert!((payload["x"].as_f64().unwrap() - 50.0).abs() < 1e-6);
    assert!((payload["y"].as_f64().unwrap() - 10.0).abs() < 1e-6);
}

#[test]
fn a_chart_level_event_over_a_band_scale_names_the_category() {
    let (_, scene) = scene_with(
        &[],
        &[(
            "b",
            "Bars",
            vec![("data", json!([{"x": "Jan", "y": 1}, {"x": "Feb", "y": 2}]))],
        )],
    );
    let payload = scene.payload(scene.plot.x + scene.plot.w * 0.75, scene.plot.y);
    assert_eq!(payload["x"], json!("Feb"));
}

#[test]
fn only_marks_with_an_event_applicator_are_hittable() {
    let (_, scene) = scene_with(
        &[],
        &[
            (
                "l",
                "Line",
                vec![
                    ("points", json!([1, 2])),
                    ("onMove.0", json!("@actions.track")),
                ],
            ),
            ("p", "Points", vec![("points", json!([[0, 1]]))]),
        ],
    );
    assert_eq!(scene.marks.len(), 1, "the decorative Points is transparent");
    assert_eq!(scene.marks[0].node_id, "l");
    assert!(scene.marks[0].events.mouse_move.is_some());
}

#[test]
fn a_point_is_hit_within_the_touch_radius_and_missed_outside_it() {
    let (_, scene) = scene_with(
        &[("x", json!([0, 1])), ("y", json!([0, 1]))],
        &[(
            "p",
            "Points",
            vec![
                ("points", json!([[0, 0]])),
                ("onClick.0", json!("@actions.pick")),
            ],
        )],
    );
    let mark = &scene.marks[0];
    let (px, py, _) = mark.points[0];
    assert_eq!(mark.hit(px + 6.0, py), Some(MarkHit::Datum(0)));
    assert_eq!(mark.hit(px, py + defaults::HIT_RADIUS + 4.0), None);
}

// ---------------------------------------------------------------------------
// Layout integration
// ---------------------------------------------------------------------------

fn compute(tree: &Tree) -> LayoutPass {
    let mut text = TextEngine::new();
    LayoutPass::compute(tree, &mut text, (800, 600), 1.0)
}

fn item<'a>(pass: &'a LayoutPass, node_id: &str) -> &'a crate::layout::LayoutItem {
    pass.items
        .iter()
        .find(|it| it.node_id == node_id)
        .unwrap_or_else(|| panic!("expected a layout item for `{node_id}`"))
}

#[test]
fn a_chart_is_a_block_that_fills_its_width_and_defaults_to_200_tall() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    tree.apply(&create_patch("c", "Chart", &[]));
    tree.apply(&insert_patch("col", "c"));
    tree.apply(&create_patch("l", "Line", &[("points", json!([1, 2]))]));
    tree.apply(&insert_patch("c", "l"));

    let pass = compute(&tree);
    let chart = item(&pass, "c");
    assert_eq!(chart.rect.h, defaults::HEIGHT);
    assert_eq!(chart.rect.w, 800.0);
    assert!(matches!(chart.kind, ItemKind::Chart(_)));
    // Marks are laid out BY the chart: a decorative one emits no item.
    assert!(pass.items.iter().all(|it| it.node_id != "l"));
}

#[test]
fn the_height_applicator_sizes_the_chart() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "c",
        "Chart",
        &[("height.0", json!(48)), ("width.0", json!(120))],
    ));
    tree.apply(&insert_patch("root", "c"));
    let pass = compute(&tree);
    let chart = item(&pass, "c");
    assert_eq!((chart.rect.w, chart.rect.h), (120.0, 48.0));
}

#[test]
fn an_interactive_mark_emits_an_item_that_hit_tests_on_its_own_geometry() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("c", "Chart", &[("y", json!([0, 100]))]));
    tree.apply(&insert_patch("root", "c"));
    tree.apply(&create_patch(
        "b",
        "Bars",
        &[
            ("data", json!([{"x": "Jan", "y": 100}])),
            ("onClick.0", json!("@actions.pick")),
            ("onClick.tag", json!("targets")),
        ],
    ));
    tree.apply(&insert_patch("c", "b"));

    let pass = compute(&tree);
    let mark = item(&pass, "b");
    assert_eq!(mark.action.as_deref(), Some("pick"));
    let ItemKind::ChartMark(resolved) = &mark.kind else {
        panic!("expected a chart mark item, got {:?}", mark.kind);
    };
    let (bar, _) = resolved.bars[0];
    let (cx, cy) = (bar.x + bar.w * 0.5, bar.y + bar.h * 0.5);
    assert!(mark.hit_contains(cx, cy));
    // A point inside the chart but outside the bar is not on the mark.
    assert!(!mark.hit_contains(bar.x - 40.0, cy));
    assert_eq!(pass.hit(cx, cy).map(|it| it.node_id.as_str()), Some("b"));

    // Static action args and the datum travel together.
    let payload = mark.action_payload_at(Some((cx, cy))).expect("payload");
    assert_eq!(payload["tag"], json!("targets"));
    assert_eq!(payload["series"], json!("bars"));
    assert_eq!(payload["index"], json!(0));
    assert_eq!(payload["x"], json!("Jan"));
    assert_eq!(payload["y"], json!(100.0));
}

#[test]
fn a_chart_level_click_carries_the_pointer_in_data_units() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "c",
        "Chart",
        &[
            ("x", json!([0, 100])),
            ("y", json!([0, 10])),
            ("onClick.0", json!("@actions.plot")),
        ],
    ));
    tree.apply(&insert_patch("root", "c"));
    let pass = compute(&tree);
    let chart = item(&pass, "c");
    let ItemKind::Chart(scene) = &chart.kind else {
        panic!("expected a chart item");
    };
    let (cx, cy) = (
        scene.plot.x + scene.plot.w * 0.5,
        scene.plot.y + scene.plot.h,
    );
    let payload = chart.action_payload_at(Some((cx, cy))).expect("payload");
    assert!((payload["x"].as_f64().unwrap() - 50.0).abs() < 1e-6);
    assert!((payload["y"].as_f64().unwrap()).abs() < 1e-6);
}

#[test]
fn a_marker_lands_on_its_data_point_and_its_children_come_with_it() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "c",
        "Chart",
        &[("x", json!([0, 10])), ("y", json!([0, 10]))],
    ));
    tree.apply(&insert_patch("root", "c"));
    tree.apply(&create_patch(
        "m",
        "Marker",
        &[
            ("x", json!(5)),
            ("y", json!(5)),
            ("anchor", json!("center")),
        ],
    ));
    tree.apply(&insert_patch("c", "m"));
    tree.apply(&create_patch("t", "Text", &[("0", json!("peak"))]));
    tree.apply(&insert_patch("m", "t"));

    let pass = compute(&tree);
    let chart = item(&pass, "c");
    let ItemKind::Chart(scene) = &chart.kind else {
        panic!("expected a chart item");
    };
    let place = scene.marker("m").expect("placed marker");
    let marker = item(&pass, "m");
    // `center` puts the content's middle on the data point.
    assert!((marker.rect.x + marker.rect.w * 0.5 - place.x).abs() < 0.01);
    assert!((marker.rect.y + marker.rect.h * 0.5 - place.y).abs() < 0.01);
    // The Text child rides along inside it.
    let text = item(&pass, "t");
    assert!(text.rect.x >= marker.rect.x - 0.01);
    assert!(text.rect.y >= marker.rect.y - 0.01);
}

#[test]
fn a_marker_above_its_point_sits_a_gap_clear_of_it() {
    let mut tree = Tree::new();
    tree.apply(&create_patch(
        "c",
        "Chart",
        &[("x", json!([0, 10])), ("y", json!([0, 10]))],
    ));
    tree.apply(&insert_patch("root", "c"));
    tree.apply(&create_patch(
        "m",
        "Marker",
        &[("x", json!(5)), ("y", json!(5))],
    ));
    tree.apply(&insert_patch("c", "m"));
    tree.apply(&create_patch("t", "Text", &[("0", json!("peak"))]));
    tree.apply(&insert_patch("m", "t"));

    let pass = compute(&tree);
    let chart = item(&pass, "c");
    let ItemKind::Chart(scene) = &chart.kind else {
        panic!("expected a chart item");
    };
    let place = scene.marker("m").expect("placed marker");
    let marker = item(&pass, "m");
    assert!(
        (marker.rect.y + marker.rect.h + defaults::MARKER_GAP - place.y).abs() < 0.01,
        "the default `top` anchor sits {} above the point",
        defaults::MARKER_GAP
    );
}

#[test]
fn a_marker_with_no_coordinates_emits_nothing_at_all() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("c", "Chart", &[]));
    tree.apply(&insert_patch("root", "c"));
    tree.apply(&create_patch("m", "Marker", &[]));
    tree.apply(&insert_patch("c", "m"));
    tree.apply(&create_patch("t", "Text", &[("0", json!("tooltip"))]));
    tree.apply(&insert_patch("m", "t"));

    let pass = compute(&tree);
    assert!(
        pass.items
            .iter()
            .all(|it| it.node_id != "m" && it.node_id != "t"),
        "a hidden marker paints nothing and hit-tests nothing"
    );
}

#[test]
fn a_mark_outside_a_chart_lays_out_nothing() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("col", "Column", &[]));
    tree.apply(&insert_patch("root", "col"));
    tree.apply(&create_patch("l", "Line", &[("points", json!([1, 2]))]));
    tree.apply(&insert_patch("col", "l"));
    let pass = compute(&tree);
    assert!(pass.items.iter().all(|it| it.node_id != "l"));
}

#[test]
fn a_prop_change_on_a_mark_forces_a_full_relayout() {
    let mut tree = Tree::new();
    tree.apply(&create_patch("c", "Chart", &[]));
    tree.apply(&insert_patch("root", "c"));
    tree.apply(&create_patch("l", "Line", &[("points", json!([1, 2]))]));
    tree.apply(&insert_patch("c", "l"));

    // `points` is not a layout prop by the shared classifier's reckoning,
    // but it resolves the chart's domains — so the chart family opts out
    // of the paint-only fast path wholesale.
    assert!(crate::chart::is_chart_family_node(&tree, "c"));
    assert!(crate::chart::is_chart_family_node(&tree, "l"));
    let patches = vec![Patch::SetProp {
        id: "l".into(),
        name: "points".into(),
        value: json!([5, 6]),
    }];
    assert!(
        crate::window::paint_only_affected_ids(&patches, &[], &tree, false, false, false).is_none(),
        "a chart mark's data change must not take the paint-only path"
    );
}

#[test]
fn on_move_dispatches_on_entry_then_at_most_once_a_frame() {
    assert!(move_due(None), "entering a mark always dispatches");
    assert!(!move_due(Some(defaults::MOVE_THROTTLE_MS - 1)));
    assert!(move_due(Some(defaults::MOVE_THROTTLE_MS)));
}

#[test]
fn a_long_press_matures_at_half_a_second() {
    assert!(!long_press_matured(defaults::LONG_PRESS_MS - 1));
    assert!(long_press_matured(defaults::LONG_PRESS_MS));
}

#[test]
fn the_family_is_registered_under_its_lowercase_names() {
    assert!(is_chart_type("chart"));
    // The engine emits primitive element types in their DSL spelling, so
    // the PascalCase form has to resolve to the same thing.
    assert!(is_chart_type("Chart"));
    assert!(!is_chart_type("Charter"));
    for name in CHART_MARK_TYPES {
        let kind = MarkKind::from_element_type(name).expect("registered mark");
        assert_eq!(kind.as_str(), *name);
        let pascal = format!("{}{}", name[..1].to_uppercase(), &name[1..]);
        assert_eq!(MarkKind::from_element_type(&pascal), Some(kind));
    }
    assert_eq!(MarkKind::from_element_type("Column"), None);
    // Only these four resolve a datum in their event payload.
    let data: Vec<&str> = CHART_MARK_TYPES
        .iter()
        .filter(|n| MarkKind::from_element_type(n).unwrap().is_data())
        .copied()
        .collect();
    assert_eq!(data, vec!["line", "area", "bars", "points"]);
}

#[test]
fn grid_lines_are_drawn_at_a_fixed_fifteen_percent() {
    let (_, scene) = scene_with(
        &[("y", json!([0, 10])), ("color", json!("#000000"))],
        &[(
            "ay",
            "Axis",
            vec![
                ("0", json!("y")),
                ("grid", json!(true)),
                ("ticks", json!(1)),
            ],
        )],
    );
    let right = scene.plot.x + scene.plot.w;
    let grid = segments_of(&scene)
        .into_iter()
        .find(|(x1, _, x2, _, _)| *x1 == scene.plot.x && *x2 == right)
        .expect("a grid line");
    assert_eq!(grid.4.stroke.expect("grid stroke").3, 38);
    // The axis line itself keeps its own 0.5 stroke-opacity.
    let axis = segments_of(&scene)
        .into_iter()
        .find(|(x1, y1, _, y2, _)| *x1 == scene.plot.x && y1 != y2)
        .expect("the axis line");
    assert_eq!(axis.4.stroke.expect("axis stroke").3, 128);
}

#[test]
fn a_zero_value_bar_is_still_tappable() {
    let (_, scene) = scene_with(
        &[("y", json!([0, 10]))],
        &[(
            "b",
            "Bars",
            vec![
                ("data", json!([0, 5])),
                ("onClick.0", json!("@actions.pick")),
            ],
        )],
    );
    let mark = &scene.marks[0];
    let (rect, index) = mark.bars[0];
    assert_eq!(index, 0);
    assert_eq!(rect.h, 0.0, "a zero value draws no bar at all");
    // …but its datum point still carries the touch target.
    assert_eq!(
        mark.hit(rect.x + rect.w * 0.5, rect.y),
        Some(MarkHit::Datum(0))
    );
}

#[test]
fn named_effect_arguments_from_engine_patches() {
    for (props, radius, dy) in [
        (vec![("glow.color", json!("#d6fc74")), ("glow.radius", json!(4))], 4.0, 0.0),
        (vec![("shadow.color", json!("#d6fc74")), ("shadow.blur", json!(8)), ("shadow.y", json!(2))], 8.0, 2.0),
    ] {
        let mut props = props;
        props.push(("points", json!([1, 2])));
        let (_, scene) = scene_with(&[], &[("l", "Line", props)]);
        let glow = scene.shapes.iter().find_map(|s| match s {
            ChartShape::Path { paint, .. } => paint.glow, _ => None,
        }).expect("named effect must reach the painter");
        assert_eq!(glow.radius, radius);
        assert_eq!(glow.dy, dy);
        assert_eq!(glow.color, parse_color("#d6fc74").unwrap());
    }
}
