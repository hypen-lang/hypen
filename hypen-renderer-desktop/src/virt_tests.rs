//! The first block mirrors `hypen-web/tests/virtualization-math.test.ts`
//! case for case; keep the two aligned. The rest pins the desktop glue.

use super::*;
use indexmap::IndexMap;
use serde_json::json;

fn w(total: usize, start: usize, end: usize) -> VirtWindow {
    VirtWindow {
        total,
        start,
        end,
        estimated_size: None,
    }
}

fn r(start: usize, end: usize) -> ItemRange {
    ItemRange { start, end }
}

// ── parseVirtWindow ──

#[test]
fn parse_decodes_the_engines_prop() {
    assert_eq!(
        parse_virt_window(&json!({ "total": 100, "start": 10, "end": 40 })),
        Some(w(100, 10, 40))
    );
    assert_eq!(
        parse_virt_window(&json!({ "total": 5, "start": 0, "end": 2, "estimatedSize": 48 })),
        Some(VirtWindow {
            estimated_size: Some(48.0),
            ..w(5, 0, 2)
        })
    );
}

#[test]
fn parse_rejects_malformed_values() {
    assert_eq!(parse_virt_window(&Value::Null), None);
    assert_eq!(
        parse_virt_window(&json!({ "total": 10, "start": 5, "end": 3 })),
        None
    );
    assert_eq!(
        parse_virt_window(&json!({ "total": 10, "start": 0, "end": 11 })),
        None
    );
    assert_eq!(
        parse_virt_window(&json!({ "total": 10, "start": -1, "end": 3 })),
        None
    );
    assert_eq!(
        parse_virt_window(&json!({ "total": "10", "start": 0, "end": 3 })),
        None
    );
}

// ── itemSize ──

#[test]
fn item_size_prefers_the_measured_average() {
    let est = VirtWindow {
        estimated_size: Some(30.0),
        ..w(100, 0, 10)
    };
    assert_eq!(item_size(&est, 500.0, 10.0), 50.0);
}

#[test]
fn item_size_falls_back_to_the_estimate_then_the_default() {
    let est = VirtWindow {
        estimated_size: Some(30.0),
        ..w(100, 0, 10)
    };
    assert_eq!(item_size(&est, 0.0, 0.0), 30.0);
    assert_eq!(item_size(&w(100, 0, 10), 0.0, 0.0), DEFAULT_ITEM_SIZE);
}

// ── windowPadding ──

#[test]
fn padding_stands_in_for_the_items_outside_the_window() {
    assert_eq!(window_padding(&w(100, 40, 70), 10.0, 1), (400.0, 300.0));
}

#[test]
fn padding_is_zero_when_the_window_covers_everything() {
    assert_eq!(window_padding(&w(5, 0, 5), 10.0, 1), (0.0, 0.0));
}

#[test]
fn padding_counts_grid_rows() {
    // 3 columns: items 0..8 are rows 0..2; window 9..18 is rows 3..5; 30 items = 10 rows.
    assert_eq!(window_padding(&w(30, 9, 18), 100.0, 3), (300.0, 400.0));
}

// ── windowRows ──

#[test]
fn window_rows_is_the_item_count_for_a_list() {
    assert_eq!(window_rows(&w(100, 40, 70), 1), 30);
}

#[test]
fn window_rows_counts_every_grid_row_the_window_touches() {
    assert_eq!(window_rows(&w(30, 9, 18), 3), 3);
    assert_eq!(window_rows(&w(30, 10, 17), 3), 3);
}

// ── childrenPerItem ──

#[test]
fn children_per_item_groups_a_multi_node_templates_children() {
    assert_eq!(children_per_item(&w(100, 10, 20), 10), 1);
    assert_eq!(children_per_item(&w(100, 10, 20), 30), 3);
}

#[test]
fn children_per_item_is_at_least_one() {
    assert_eq!(children_per_item(&w(100, 10, 10), 0), 1);
    assert_eq!(children_per_item(&w(100, 10, 20), 0), 1);
}

// ── visibleRange ──

#[test]
fn visible_maps_the_scroll_offset_to_items() {
    assert_eq!(visible_range(1000, 50.0, 500.0, 200.0, 1), r(10, 14));
}

#[test]
fn visible_clamps_to_the_list() {
    assert_eq!(visible_range(12, 50.0, 500.0, 200.0, 1), r(10, 12));
    assert_eq!(visible_range(100, 50.0, -300.0, 200.0, 1), r(0, 4));
}

#[test]
fn visible_counts_grid_rows() {
    assert_eq!(visible_range(90, 100.0, 300.0, 200.0, 3), r(9, 15));
}

// ── wantedRange ──

#[test]
fn wanted_adds_a_viewport_of_overscan_on_each_side() {
    assert_eq!(wanted_range(r(40, 60), 1000), r(20, 80));
}

#[test]
fn wanted_overscans_at_least_five_items() {
    assert_eq!(wanted_range(r(40, 42), 1000), r(35, 47));
}

#[test]
fn wanted_clamps_to_the_list() {
    assert_eq!(wanted_range(r(2, 10), 12), r(0, 12));
}

// ── shouldReport ──

#[test]
fn report_not_while_the_visible_range_is_covered() {
    assert!(!should_report(&w(1000, 20, 80), r(40, 60), r(20, 80), None));
}

#[test]
fn report_when_the_visible_range_leaves_the_window() {
    assert!(should_report(&w(1000, 20, 80), r(70, 90), r(50, 110), None));
}

#[test]
fn report_when_the_window_is_far_larger_than_needed() {
    assert!(should_report(
        &w(1000, 0, 500),
        r(100, 110),
        r(90, 120),
        None
    ));
}

#[test]
fn report_never_the_same_range_twice() {
    let wanted = r(50, 110);
    assert!(!should_report(
        &w(1000, 20, 80),
        r(70, 90),
        wanted,
        Some(wanted)
    ));
}

// ── desktop glue ──

fn set_window(id: &str, total: usize, start: usize, end: usize) -> Patch {
    Patch::SetProp {
        id: id.into(),
        name: VIRT_WINDOW_PROP.into(),
        value: json!({ "total": total, "start": start, "end": end }),
    }
}

fn pad_in(patches: &[Patch], id: &str) -> Option<(f32, f32)> {
    patches.iter().rev().find_map(|p| match p {
        Patch::SetProp {
            id: pid,
            name,
            value,
        } if &**pid == id && name == VIRT_PAD_PROP => pad_of(value),
        _ => None,
    })
}

#[test]
fn ingest_consumes_the_window_and_appends_padding_after_the_batch() {
    let mut lists = VirtLists::default();
    let mut batch = vec![
        set_window("list", 100, 0, 10),
        Patch::Insert {
            parent_id: "list".into(),
            id: "row".into(),
            before_id: None,
        },
    ];
    lists.ingest(&mut batch, 2.0);
    assert!(
        !batch
            .iter()
            .any(|p| matches!(p, Patch::SetProp { name, .. } if name == VIRT_WINDOW_PROP)),
        "__virt.window never reaches the tree"
    );
    assert!(matches!(batch[0], Patch::Insert { .. }));
    assert!(matches!(batch.last(), Some(Patch::SetProp { name, .. }) if name == VIRT_PAD_PROP));
    // Unmeasured: the default 48 (logical) per item, 90 items after.
    assert_eq!(pad_in(&batch, "list"), Some((0.0, 90.0 * 48.0)));
    assert_eq!(lists.window("list"), Some(w(100, 0, 10)));
}

#[test]
fn ingest_strips_the_window_from_create_props() {
    let mut lists = VirtLists::default();
    let mut props = IndexMap::new();
    props.insert(
        VIRT_WINDOW_PROP.to_string(),
        json!({ "total": 3, "start": 0, "end": 3, "estimatedSize": 20 }),
    );
    let mut batch = vec![Patch::Create {
        id: "list".into(),
        element_type: "List".into(),
        props: Arc::new(props),
        semantics: None,
    }];
    lists.ingest(&mut batch, 1.0);
    match &batch[0] {
        Patch::Create { props, .. } => assert!(!props.contains_key(VIRT_WINDOW_PROP)),
        other => panic!("{other:?}"),
    }
    assert_eq!(pad_in(&batch, "list"), Some((0.0, 0.0)));
}

#[test]
fn malformed_window_keeps_the_previous_one_and_remove_prop_drops_the_padding() {
    let mut lists = VirtLists::default();
    let mut batch = vec![set_window("list", 100, 0, 10)];
    lists.ingest(&mut batch, 1.0);
    let mut bad = vec![Patch::SetProp {
        id: "list".into(),
        name: VIRT_WINDOW_PROP.into(),
        value: json!({ "total": 1, "start": 5, "end": 2 }),
    }];
    lists.ingest(&mut bad, 1.0);
    assert!(bad.is_empty());
    assert_eq!(lists.window("list"), Some(w(100, 0, 10)));

    let mut gone = vec![Patch::RemoveProp {
        id: "list".into(),
        name: VIRT_WINDOW_PROP.into(),
    }];
    lists.ingest(&mut gone, 1.0);
    assert!(matches!(&gone[..], [Patch::RemoveProp { name, .. }] if name == VIRT_PAD_PROP));
    assert!(lists.is_empty());
}

fn geom(rows: &[(f32, f32)], content_start: f32) -> ListGeometry {
    ListGeometry {
        horizontal: false,
        content_start,
        children: rows
            .iter()
            .enumerate()
            .map(|(i, (near, ext))| (format!("r{i}"), *near, *ext))
            .collect(),
    }
}

#[test]
fn measure_uses_the_row_pitch_gaps_included() {
    // 4 rows of 30px with 10px gaps starting at 100.
    let g = geom(
        &[(100.0, 30.0), (140.0, 30.0), (180.0, 30.0), (220.0, 30.0)],
        100.0,
    );
    assert_eq!(measure(&w(50, 10, 14), &g, 1), Some((160.0, 4.0)));
    // One row: its own extent.
    let one = geom(&[(0.0, 25.0)], 0.0);
    assert_eq!(measure(&w(50, 0, 1), &one, 1), Some((25.0, 1.0)));
    // Nothing materialized.
    assert_eq!(measure(&w(50, 0, 0), &geom(&[], 0.0), 1), None);
}

#[test]
fn measure_groups_multi_node_items() {
    // 2 items × 2 children; items start at 0 and 50.
    let g = geom(
        &[(0.0, 20.0), (20.0, 20.0), (50.0, 20.0), (70.0, 20.0)],
        0.0,
    );
    assert_eq!(measure(&w(10, 0, 2), &g, 1), Some((100.0, 2.0)));
}

#[test]
fn remeasure_repads_only_when_the_padding_moves() {
    let mut lists = VirtLists::default();
    let mut batch = vec![set_window("list", 100, 10, 14)];
    lists.ingest(&mut batch, 1.0);
    assert_eq!(pad_in(&batch, "list"), Some((480.0, 86.0 * 48.0)));
    let g = geom(
        &[(480.0, 30.0), (520.0, 30.0), (560.0, 30.0), (600.0, 30.0)],
        480.0,
    );
    let p = lists
        .remeasure("list", &g, 1, 1.0)
        .expect("40px pitch repads");
    assert_eq!(pad_in(&[p], "list"), Some((400.0, 86.0 * 40.0)));
    assert!(
        lists.remeasure("list", &g, 1, 1.0).is_none(),
        "same measurement, no write"
    );
}

#[test]
fn visible_range_follows_the_scroll_container() {
    let mut lists = VirtLists::default();
    let mut batch = vec![set_window("list", 1000, 0, 30)];
    lists.ingest(&mut batch, 1.0);
    let g = geom(&[(0.0, 48.0)], 0.0);
    // List top at screen 100; the window shows screen 0..600.
    let vp = ListViewport {
        list_near: 100.0,
        own_scroll: 0.0,
        vis_lo: 0.0,
        vis_hi: 600.0,
    };
    assert_eq!(lists.visible("list", &g, 1, vp, 1.0), Some(r(0, 11)));
    // Scrolled 4800px into the list (item 100 at the top).
    let vp = ListViewport {
        list_near: -4800.0,
        ..vp
    };
    assert_eq!(lists.visible("list", &g, 1, vp, 1.0), Some(r(100, 113)));
    // The list scrolls itself: same answer from its own offset.
    let vp = ListViewport {
        list_near: 0.0,
        own_scroll: 4800.0,
        vis_lo: 0.0,
        vis_hi: 600.0,
    };
    assert_eq!(lists.visible("list", &g, 1, vp, 1.0), Some(r(100, 113)));
    // Entirely below the window: nothing visible, nothing to report.
    let vp = ListViewport {
        list_near: 900.0,
        own_scroll: 0.0,
        vis_lo: 0.0,
        vis_hi: 600.0,
    };
    assert_eq!(lists.visible("list", &g, 1, vp, 1.0), None);
}

#[test]
fn plan_report_applies_overscan_and_never_repeats() {
    let mut lists = VirtLists::default();
    lists.ingest(&mut vec![set_window("list", 1000, 0, 30)], 1.0);
    assert_eq!(lists.plan_report("list", r(0, 12)), None, "covered");
    assert_eq!(lists.plan_report("list", r(100, 113)), Some(r(87, 126)));
    assert_eq!(lists.plan_report("list", r(100, 113)), None, "same range");
    // The engine answers with the new window: covered, no report.
    lists.ingest(&mut vec![set_window("list", 1000, 87, 126)], 1.0);
    assert_eq!(lists.plan_report("list", r(100, 113)), None);
}

/// The padding appended for a new window reaches the tree in the same
/// flush: it is the list's current padding (`visible` measures from it) and
/// arms anchoring — no second trip through `ingest` needed.
#[test]
fn a_window_move_records_its_padding_and_arms_the_anchor() {
    let mut lists = VirtLists::default();
    lists.ingest(&mut vec![set_window("list", 1000, 0, 30)], 1.0);
    lists.set_anchor("list", Some(("r5".into(), 240.0)));
    assert_eq!(lists.anchor_shift("list", |_| Some(240.0)), 0.0);

    lists.ingest(&mut vec![set_window("list", 1000, 10, 40)], 1.0);
    lists.set_anchor("list", Some(("r15".into(), 720.0)));
    assert_eq!(
        lists.anchor_shift("list", |_| Some(730.0)),
        10.0,
        "the window's own padding change keeps the row in place"
    );
    // `visible` measures item 0 from the recorded leading padding (480).
    let vp = ListViewport {
        list_near: 0.0,
        own_scroll: 0.0,
        vis_lo: 0.0,
        vis_hi: 96.0,
    };
    let g = geom(&[(480.0, 48.0)], 480.0);
    assert_eq!(lists.visible("list", &g, 1, vp, 1.0), Some(r(0, 2)));
}

#[test]
fn set_positions_place_rows_in_the_whole_list() {
    use crate::tree::{Tree, ROOT_ID};
    let mut tree = Tree::new();
    let mut batch = vec![
        Patch::Create {
            id: "list".into(),
            element_type: "List".into(),
            props: Arc::new(IndexMap::new()),
            semantics: None,
        },
        Patch::Insert {
            parent_id: ROOT_ID.into(),
            id: "list".into(),
            before_id: None,
        },
    ];
    // Items 40..42, two children each.
    for i in 0..4 {
        let id = format!("c{i}");
        batch.push(Patch::Create {
            id: id.as_str().into(),
            element_type: "Text".into(),
            props: Arc::new(IndexMap::new()),
            semantics: None,
        });
        batch.push(Patch::Insert {
            parent_id: "list".into(),
            id: id.as_str().into(),
            before_id: None,
        });
    }
    tree.apply_batch(&batch);
    let mut lists = VirtLists::default();
    lists.ingest(&mut vec![set_window("list", 100, 40, 42)], 1.0);
    assert_eq!(
        lists.set_positions(&tree),
        vec![
            ("c0".to_string(), 41, 100),
            ("c1".to_string(), 41, 100),
            ("c2".to_string(), 42, 100),
            ("c3".to_string(), 42, 100),
        ]
    );
}

#[test]
fn anchor_shift_keeps_the_first_visible_row_in_place() {
    let mut lists = VirtLists::default();
    let mut batch = vec![set_window("list", 1000, 0, 30)];
    lists.ingest(&mut batch, 1.0);
    lists.set_anchor("list", Some(("r5".into(), 240.0)));
    // A pad change landed and the row moved 32px down in its container.
    assert_eq!(lists.anchor_shift("list", |_| Some(272.0)), 32.0);
    // Consumed: nothing pending any more.
    assert_eq!(lists.anchor_shift("list", |_| Some(300.0)), 0.0);
}

// ── through the real Tree + Taffy layout ──

mod layout {
    use super::*;
    use crate::layout::{LayoutItem, LayoutPass, TaffyState};
    use crate::style::vp;
    use crate::text::TextEngine;
    use crate::tree::{Tree, ROOT_ID};

    fn create(id: &str, element_type: &str, props: &[(&str, Value)]) -> Patch {
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

    fn insert(parent: &str, id: &str) -> Patch {
        Patch::Insert {
            parent_id: parent.into(),
            id: id.into(),
            before_id: None,
        }
    }

    fn item<'a>(pass: &'a LayoutPass, id: &str) -> &'a LayoutItem {
        pass.items
            .iter()
            .find(|it| it.node_id == id)
            .unwrap_or_else(|| panic!("no item {id}"))
    }

    /// The renderer pipeline in miniature: ingest (as `flush_patches`),
    /// Tree, Taffy mirror, layout.
    struct Rig {
        virt: VirtLists,
        tree: Tree,
        taffy: TaffyState,
        text: TextEngine,
        generation: u64,
    }

    impl Rig {
        fn new() -> Self {
            Self {
                virt: VirtLists::default(),
                tree: Tree::new(),
                taffy: TaffyState::default(),
                text: TextEngine::new(),
                generation: 0,
            }
        }

        fn apply(&mut self, mut batch: Vec<Patch>) -> LayoutPass {
            self.virt.ingest(&mut batch, 1.0);
            self.tree.apply_batch(&batch);
            assert!(self.taffy.apply_patches(&batch, &self.tree, 1.0, vp(800.0)));
            self.generation += 1;
            LayoutPass::compute_with_state(
                &mut self.taffy,
                &self.tree,
                &mut self.text,
                (800, 600),
                1.0,
                0.0,
                &HashMap::new(),
                self.generation,
            )
        }

        fn list(&mut self, list_type: &str, rows: usize, window: Value) -> LayoutPass {
            let mut batch = vec![create("list", list_type, &[]), insert(ROOT_ID, "list")];
            for i in 0..rows {
                let id = format!("row{i}");
                batch.push(create(
                    &id,
                    "Column",
                    &[("width", json!(30)), ("height", json!(30))],
                ));
                batch.push(insert("list", &id));
            }
            batch.push(Patch::SetProp {
                id: "list".into(),
                name: VIRT_WINDOW_PROP.into(),
                value: window,
            });
            self.apply(batch)
        }
    }

    #[test]
    fn windowed_list_is_padded_on_its_scroll_axis_and_remeasured() {
        let mut rig = Rig::new();
        let pass = rig.list("List", 10, json!({ "total": 100, "start": 20, "end": 30 }));
        assert!(
            !rig.tree
                .get("list")
                .unwrap()
                .props
                .contains_key(VIRT_WINDOW_PROP),
            "__virt.window is never stored as an ordinary prop"
        );
        // Unmeasured: 48px per missing item, 20 before and 70 after.
        let list = item(&pass, "list").rect;
        assert!(
            (list.h - (20.0 * 48.0 + 10.0 * 30.0 + 70.0 * 48.0)).abs() < 1.0,
            "{list:?}"
        );
        assert!((item(&pass, "row0").rect.y - list.y - 20.0 * 48.0).abs() < 1.0);

        // Measure the rows (30px each) → re-pad: the list spans 100 rows.
        let geom = rig
            .taffy
            .virt_geometry(&rig.tree, "list")
            .expect("geometry");
        assert!(!geom.horizontal);
        assert_eq!(geom.children.len(), 10);
        let pad = rig
            .virt
            .remeasure("list", &geom, 1, 1.0)
            .expect("measured size differs from the default");
        let pass = rig.apply(vec![pad]);
        let list = item(&pass, "list").rect;
        assert!((list.h - 100.0 * 30.0).abs() < 1.0, "{list:?}");
        assert!(
            pass.content_size.1 >= 100.0 * 30.0 - 1.0,
            "the padded list gives the page its whole virtual extent"
        );
        assert!((item(&pass, "row0").rect.y - list.y - 600.0).abs() < 1.0);

        // Scrolled 900px into the list: items 30..50 visible, report 10..70.
        let geom = rig.taffy.virt_geometry(&rig.tree, "list").unwrap();
        let vis = rig
            .virt
            .visible(
                "list",
                &geom,
                1,
                ListViewport {
                    list_near: list.y - 900.0,
                    own_scroll: 0.0,
                    vis_lo: 0.0,
                    vis_hi: 600.0,
                },
                1.0,
            )
            .unwrap();
        assert_eq!(vis, r(30, 50));
        assert_eq!(rig.virt.plan_report("list", vis), Some(r(10, 70)));
    }

    #[test]
    fn rows_outside_the_viewport_are_culled_while_the_list_spans_it() {
        let mut rig = Rig::new();
        // 30 rows materialized at 30px from y=0; estimate 30 for the rest.
        let pass = rig.list(
            "List",
            30,
            json!({ "total": 10000, "start": 0, "end": 30, "estimatedSize": 30 }),
        );
        assert!(item(&pass, "list").rect.h >= 10000.0 * 30.0 - 1.0);
        // Every materialized row is within the cull buffer here; the list
        // element itself is emitted even though it is 300k px tall.
        assert!(pass.items.iter().any(|it| it.node_id == "row29"));
    }

    /// Containers with their own `build_subtree` branch (Center, Stack,
    /// Button) are padded on the first build, not only on a later restyle.
    #[test]
    fn special_containers_are_padded_on_their_first_build() {
        for list_type in ["Center", "Stack", "Button"] {
            let mut rig = Rig::new();
            let pass = rig.list(
                list_type,
                1,
                json!({ "total": 4, "start": 1, "end": 2, "estimatedSize": 30 }),
            );
            let list = item(&pass, "list").rect;
            assert!(
                list.h >= 4.0 * 30.0 - 1.0,
                "{list_type}: one row plus 3 stand-ins, got {list:?}"
            );
        }
    }

    #[test]
    fn windowed_row_is_padded_horizontally_and_remove_prop_unpads() {
        let mut rig = Rig::new();
        let pass = rig.list(
            "Row",
            2,
            json!({ "total": 4, "start": 1, "end": 3, "estimatedSize": 30 }),
        );
        let list = item(&pass, "list").rect;
        assert!((list.w - 4.0 * 30.0).abs() < 1.0, "{list:?}");
        assert!((item(&pass, "row0").rect.x - list.x - 30.0).abs() < 1.0);
        assert!(
            rig.taffy
                .virt_geometry(&rig.tree, "list")
                .unwrap()
                .horizontal
        );

        let pass = rig.apply(vec![Patch::RemoveProp {
            id: "list".into(),
            name: VIRT_WINDOW_PROP.into(),
        }]);
        assert!((item(&pass, "list").rect.w - 2.0 * 30.0).abs() < 1.0);
        assert!(!rig
            .tree
            .get("list")
            .unwrap()
            .props
            .contains_key(VIRT_PAD_PROP));
    }
}

#[test]
fn removing_the_list_element_forgets_it() {
    let mut lists = VirtLists::default();
    lists.ingest(&mut vec![set_window("list", 10, 0, 5)], 1.0);
    lists.ingest(
        &mut vec![Patch::Remove {
            id: "list".into(),
            transition: false,
        }],
        1.0,
    );
    assert!(lists.is_empty());
}
