//! Manual perf benchmarks — headless, GPU-free timings of the hot
//! paths: patch ingest (Tree + Taffy mirror), style resolution, the
//! full layout pass, and Vello scene encoding including the
//! flush-equivalent "one paint prop changed" frame.
//!
//! Ignored by default so `cargo test` stays fast; run with
//!
//! ```sh
//! cargo test --release -p hypen-renderer-desktop --lib -- \
//!     --ignored perf_bench --nocapture --test-threads=1
//! ```
//!
//! The same file (with the flush-invalidation recipe swapped to match
//! that revision's `flush_patches` behaviour) runs against `main` for
//! before/after comparisons — every bench builds its fixture through
//! public-in-crate APIs that exist on both sides.

use crate::layout::{LayoutPass, TaffyState};
use crate::paint::vello_painter::VelloPainter;
use crate::text::TextEngine;
use crate::tree::Tree;
use hypen_engine::Patch;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

const VIEWPORT: (u32, u32) = (800, 600);
const SCALE: f32 = 1.0;

fn viewport_logical() -> crate::style::Viewport {
    crate::layout::logical_viewport(VIEWPORT, SCALE)
}

fn props(entries: &[(&str, Value)]) -> Arc<IndexMap<String, Value>> {
    let mut map = IndexMap::new();
    for (k, v) in entries {
        map.insert((*k).to_string(), v.clone());
    }
    Arc::new(map)
}

fn create(id: &str, element_type: &str, entries: &[(&str, Value)]) -> Patch {
    Patch::Create {
        id: id.into(),
        element_type: element_type.to_string(),
        props: props(entries),
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

/// `runs` timed executions after `warmup` untimed ones; reports the
/// minimum (least-noise) and the median.
fn time_it<F: FnMut()>(name: &str, warmup: usize, runs: usize, mut f: F) {
    for _ in 0..warmup {
        f();
    }
    let mut samples: Vec<Duration> = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t = Instant::now();
        f();
        samples.push(t.elapsed());
    }
    samples.sort();
    let median = samples[samples.len() / 2];
    // p95, clamped into range for small `runs`.
    let p95 = samples[((runs * 95) / 100).min(runs - 1)];
    let max = samples[runs - 1];
    // Median and tail, NOT min. Jank is caused by the slow frames, and
    // in a bench that reuses caches across iterations the minimum is
    // systematically the warmest sample rather than the least-noisy one
    // — which is exactly how the first version of this file came to
    // report width-drag figures ~1.7x better than a real drag.
    println!(
        "[perf] {name}: median {median:>10.3?}  p95 {p95:>10.3?}  max {max:>10.3?}  ({runs} runs)"
    );
}

/// Patch batch for a social-feed-shaped tree: one scrollable Column
/// holding `posts` Posts, each `Container > Row { Image, Column {
/// Text, Text } } + Text` (7 nodes). `density` piles on per-post
/// chrome: `1` adds a stats Row of three Texts (~11 nodes/post — the
/// original "heavy" shape), `2` additionally adds a comment preview
/// (Row > Image + Column > 2 Texts), a tag Row of three Texts, a
/// divider and a second body line (~22 nodes/post — double the
/// on-screen density).
fn feed_batch_dense(posts: usize, density: u8) -> Vec<Patch> {
    let mut batch = feed_batch(posts);
    if density == 0 {
        return batch;
    }
    for i in 0..posts {
        let post = format!("post{i}");
        let stats = format!("stats{i}");
        batch.extend([
            create(
                &stats,
                "Row",
                &[("gap", json!(16.0)), ("marginTop", json!(4.0))],
            ),
            insert(&post, &stats),
        ]);
        for (j, label) in ["likes", "comments", "shares"].iter().enumerate() {
            let id = format!("{label}{i}");
            batch.extend([
                create(
                    &id,
                    "Text",
                    &[
                        ("0", json!(format!("{} {label}", (i * 7 + j * 13) % 997))),
                        ("fontSize", json!(12.0)),
                        ("color", json!("#64748b")),
                        ("fontWeight", json!("medium")),
                    ],
                ),
                insert(&stats, &id),
            ]);
        }
        if density < 2 {
            continue;
        }
        let divider = format!("div{i}");
        let body2 = format!("body2_{i}");
        let comment = format!("comment{i}");
        let cavatar = format!("cavatar{i}");
        let ccol = format!("ccol{i}");
        let cauthor = format!("cauthor{i}");
        let cbody = format!("cbody{i}");
        let tags = format!("tags{i}");
        batch.extend([
            create(
                &body2,
                "Text",
                &[
                    (
                        "0",
                        json!(format!(
                            "Second paragraph {i} with a bit more wrapped body text for shaping."
                        )),
                    ),
                    ("fontSize", json!(14.0)),
                ],
            ),
            insert(&post, &body2),
            create(
                &divider,
                "Container",
                &[
                    ("height", json!(1.0)),
                    ("backgroundColor", json!("#e2e8f0")),
                ],
            ),
            insert(&post, &divider),
            create(&comment, "Row", &[("gap", json!(6.0))]),
            insert(&post, &comment),
            create(&cavatar, "Image", &[("size", json!(24.0))]),
            insert(&comment, &cavatar),
            create(&ccol, "Column", &[("flex", json!(1.0))]),
            insert(&comment, &ccol),
            create(
                &cauthor,
                "Text",
                &[
                    ("0", json!(format!("replier_{i}"))),
                    ("fontSize", json!(12.0)),
                    ("fontWeight", json!("semibold")),
                ],
            ),
            insert(&ccol, &cauthor),
            create(
                &cbody,
                "Text",
                &[
                    (
                        "0",
                        json!(format!("Top comment {i}: nice post, love the detail!")),
                    ),
                    ("fontSize", json!(12.0)),
                    ("color", json!("#475569")),
                ],
            ),
            insert(&ccol, &cbody),
            create(&tags, "Row", &[("gap", json!(8.0))]),
            insert(&post, &tags),
        ]);
        for tag in ["#rust", "#hypen", "#perf"] {
            let id = format!("tag{}_{i}", &tag[1..]);
            batch.extend([
                create(
                    &id,
                    "Text",
                    &[
                        ("0", json!(tag)),
                        ("fontSize", json!(11.0)),
                        ("color", json!("#2563eb")),
                    ],
                ),
                insert(&tags, &id),
            ]);
        }
    }
    batch
}

fn feed_batch(posts: usize) -> Vec<Patch> {
    let mut batch = vec![
        create(
            "feed",
            "Column",
            &[("scrollable", json!(true)), ("gap", json!(8.0))],
        ),
        insert("root", "feed"),
    ];
    for i in 0..posts {
        let post = format!("post{i}");
        let row = format!("row{i}");
        let avatar = format!("avatar{i}");
        let col = format!("col{i}");
        let name = format!("name{i}");
        let handle = format!("handle{i}");
        let body = format!("body{i}");
        batch.extend([
            create(
                &post,
                "Container",
                &[
                    ("padding", json!(12.0)),
                    ("gap", json!(6.0)),
                    ("backgroundColor", json!("#ffffff")),
                    ("borderRadius", json!(8.0)),
                ],
            ),
            insert("feed", &post),
            create(&row, "Row", &[("gap", json!(8.0))]),
            insert(&post, &row),
            create(&avatar, "Image", &[("size", json!(40.0))]),
            insert(&row, &avatar),
            create(&col, "Column", &[("flex", json!(1.0)), ("gap", json!(2.0))]),
            insert(&row, &col),
            create(
                &name,
                "Text",
                &[
                    ("0", json!(format!("User Number {i}"))),
                    ("fontSize", json!(15.0)),
                    ("fontWeight", json!("semibold")),
                ],
            ),
            insert(&col, &name),
            create(
                &handle,
                "Text",
                &[
                    ("0", json!(format!("@user_{i}"))),
                    ("fontSize", json!(12.0)),
                    ("color", json!("#64748b")),
                ],
            ),
            insert(&col, &handle),
            create(
                &body,
                "Text",
                &[
                    (
                        "0",
                        json!(format!(
                            "Post body {i}: a couple of lines of wrapped text so the \
                             measure path and the glyph raster path both do real work."
                        )),
                    ),
                    ("fontSize", json!(14.0)),
                ],
            ),
            insert(&post, &body),
        ]);
    }
    batch
}

/// Search's Food-app shape: one viewport-sized scroll container with a
/// 5-column, 30-card Grid. Each card carries a distinct 800x600 bitmap plus
/// the same small text stack as RestaurantCard.hypen.
fn food_grid_batch(active_images: usize) -> Vec<Patch> {
    const CARDS: usize = 30;
    let mut batch = vec![
        create(
            "food_scroll",
            "Column",
            &[
                ("scrollable", json!(true)),
                ("width", json!(1440.0)),
                ("height", json!(900.0)),
                ("backgroundColor", json!("#fafaf9")),
            ],
        ),
        insert("root", "food_scroll"),
        create(
            "food_grid",
            "Grid",
            &[
                ("gridColumns", json!(5.0)),
                ("gap", json!(18.0)),
                ("padding", json!(32.0)),
                ("width", json!(1440.0)),
            ],
        ),
        insert("food_scroll", "food_grid"),
    ];

    for i in 0..CARDS {
        let card = format!("food_card_{i}");
        let image = format!("food_image_{i}");
        let info = format!("food_info_{i}");
        let name = format!("food_name_{i}");
        let meta = format!("food_meta_{i}");
        let fee = format!("food_fee_{i}");
        batch.extend([
            create(
                &card,
                "Column",
                &[
                    ("width", json!("100%")),
                    ("backgroundColor", json!("#ffffff")),
                    ("borderRadius", json!(16.0)),
                    ("overflow", json!("hidden")),
                ],
            ),
            insert("food_grid", &card),
            create(
                &image,
                "Image",
                &[
                    (
                        "src",
                        json!((i < active_images)
                            .then(|| format!("bench://food/{i}"))
                            .unwrap_or_default()),
                    ),
                    ("width", json!("100%")),
                    ("height", json!(176.0)),
                    ("objectFit", json!("cover")),
                ],
            ),
            insert(&card, &image),
            create(
                &info,
                "Column",
                &[("padding", json!(14.0)), ("gap", json!(4.0))],
            ),
            insert(&card, &info),
            create(
                &name,
                "Text",
                &[
                    ("0", json!(format!("Restaurant {i}"))),
                    ("fontSize", json!(15.0)),
                    ("fontWeight", json!("bold")),
                ],
            ),
            insert(&info, &name),
            create(
                &meta,
                "Text",
                &[
                    ("0", json!("Italian · 20–30 min · 1.2 km")),
                    ("fontSize", json!(12.0)),
                    ("color", json!("#6b7280")),
                ],
            ),
            insert(&info, &meta),
            create(
                &fee,
                "Text",
                &[
                    ("0", json!("Free delivery")),
                    ("fontSize", json!(12.0)),
                    ("fontWeight", json!("semibold")),
                    ("color", json!("#16a34a")),
                ],
            ),
            insert(&info, &fee),
        ]);
    }
    batch
}

/// This revision's flush-time painter invalidation + relayout decision
/// for a one-patch batch. Kept as the single swap point for
/// main-vs-branch runs. Returns `Some(affected)` when this revision
/// KEEPS the cached LayoutPass (paint-only batch: caller refreshes the
/// pass in place instead of recomputing), `None` when the layout must
/// be dropped for a full recompute. A main-side run swaps the recipe
/// body for `painter.invalidate_subtree_cache(); None` (or that
/// revision's scoped invalidation returning `None`) so the caller
/// always recomputes, matching main's `flush_patches`.
fn flush_invalidate(
    painter: &mut VelloPainter,
    patch: &Patch,
    tree: &Tree,
) -> Option<std::collections::HashSet<String>> {
    // ── invalidation recipe (matches this revision's flush_patches) ──
    match crate::window::paint_only_affected_ids(
        std::slice::from_ref(patch),
        &[],
        tree,
        false,
        false,
        false,
    ) {
        Some(affected) => {
            painter.invalidate_subtrees_containing(&affected);
            Some(affected)
        }
        None => {
            painter.invalidate_subtree_cache();
            None
        }
    }
    // ── end invalidation recipe ──
}

/// Mirror of the App's per-batch bookkeeping: apply to the Tree, then
/// to the retained Taffy state.
fn apply_all(tree: &mut Tree, taffy: &mut TaffyState, batch: &[Patch]) {
    tree.apply_batch(batch);
    if !taffy.apply_patches(batch, tree, SCALE, viewport_logical()) {
        taffy.mark_needs_rebuild();
    }
}

#[test]
#[ignore = "manual perf benchmark"]
fn perf_bench_patch_ingest_wide_list() {
    // 3000 Text children under one Column — the shape that used to be
    // O(N²) in both the Tree sibling lists and the Taffy mirror.
    let mut batch = vec![create("list", "Column", &[]), insert("root", "list")];
    for i in 0..3000 {
        let id = format!("t{i}");
        batch.push(create(&id, "Text", &[("0", json!(format!("row {i}")))]));
        batch.push(insert("list", &id));
    }
    time_it("patch ingest, 3000-child list (Tree + Taffy)", 1, 5, || {
        let mut tree = Tree::new();
        let mut taffy = TaffyState::new();
        apply_all(&mut tree, &mut taffy, &batch);
    });
}

#[test]
#[ignore = "manual perf benchmark"]
fn perf_bench_style_resolution() {
    let mut tree = Tree::new();
    tree.apply(&create(
        "n",
        "Container",
        &[
            ("padding", json!(12.0)),
            ("marginTop", json!(4.0)),
            ("gap", json!(8.0)),
            ("backgroundColor", json!("#ffffff")),
            ("borderRadius", json!(8.0)),
            ("borderWidth", json!(1.0)),
            ("borderColor", json!("#e2e8f0")),
            ("flex", json!(1.0)),
            ("width", json!("100%")),
            ("minHeight", json!(48.0)),
            ("color", json!("#0f172a")),
            ("fontSize", json!(14.0)),
        ],
    ));
    let node = tree.get("n").unwrap();
    let vp = viewport_logical();
    time_it("node_style_with × 20k (12-prop node)", 1, 5, || {
        for _ in 0..20_000 {
            std::hint::black_box(crate::layout::node_style_with(
                node,
                SCALE,
                vp,
                &[],
                crate::layout::SafeAreaInsets::default(),
            ));
        }
    });
}

#[test]
#[ignore = "manual perf benchmark"]
fn perf_bench_layout_pass_feed() {
    let batch = feed_batch(300);
    let mut text = TextEngine::new();
    let scrolls: HashMap<String, f32> = HashMap::new();

    // Cold: fresh TaffyState each run (bulk build + solve + emit).
    time_it("layout pass COLD, 300-post feed", 1, 5, || {
        let mut tree = Tree::new();
        let mut taffy = TaffyState::new();
        tree.apply_batch(&batch);
        taffy.mark_needs_rebuild();
        std::hint::black_box(LayoutPass::compute_with_state(
            &mut taffy, &tree, &mut text, VIEWPORT, SCALE, 0.0, &scrolls, 0,
        ));
    });

    // Warm: retained TaffyState, re-run the pass (incremental solve +
    // emit + post-passes — the per-frame recompute shape).
    let mut tree = Tree::new();
    let mut taffy = TaffyState::new();
    apply_all(&mut tree, &mut taffy, &batch);
    let _ = LayoutPass::compute_with_state(
        &mut taffy, &tree, &mut text, VIEWPORT, SCALE, 0.0, &scrolls, 0,
    );
    time_it("layout pass WARM, 300-post feed", 2, 10, || {
        std::hint::black_box(LayoutPass::compute_with_state(
            &mut taffy, &tree, &mut text, VIEWPORT, SCALE, 0.0, &scrolls, 0,
        ));
    });
}

#[test]
#[ignore = "manual perf benchmark"]
fn perf_bench_scene_encode_and_one_prop_frame() {
    let batch = feed_batch(300);
    let mut tree = Tree::new();
    let mut taffy = TaffyState::new();
    apply_all(&mut tree, &mut taffy, &batch);
    let mut painter = VelloPainter::new();
    let scrolls: HashMap<String, f32> = HashMap::new();
    let mut pass = {
        let text = painter.text_engine_mut();
        LayoutPass::compute_with_state(&mut taffy, &tree, text, VIEWPORT, SCALE, 0.0, &scrolls, 0)
    };

    // Cold encode: every visible subtree misses.
    time_it("scene encode COLD (cache cleared)", 1, 5, || {
        painter.invalidate_subtree_cache();
        std::hint::black_box(painter.build_scene(&pass, VIEWPORT, SCALE, 0.0));
    });

    // Warm encode: every visible subtree hits.
    let _ = painter.build_scene(&pass, VIEWPORT, SCALE, 0.0);
    time_it("scene encode WARM (all cache hits)", 2, 10, || {
        std::hint::black_box(painter.build_scene(&pass, VIEWPORT, SCALE, 0.0));
    });

    // Flush-equivalent frame after ONE paint-prop change (a Text's
    // colour flips on one post): Tree + Taffy mirror, this revision's
    // invalidation recipe, then either the paint-only in-place refresh
    // (this revision) or a full layout recompute (main), scene encode.
    // This is the "keystroke / counter tick" frame.
    let mut generation = 1u64;
    let mut red = false;
    time_it("frame after 1 color SetProp (flush recipe)", 2, 10, || {
        red = !red;
        let patch = Patch::SetProp {
            id: "name5".into(),
            name: "color".into(),
            value: json!(if red { "#ff0000" } else { "#0f172a" }),
        };
        tree.apply(&patch);
        if !taffy.apply_patches(
            std::slice::from_ref(&patch),
            &tree,
            SCALE,
            viewport_logical(),
        ) {
            taffy.mark_needs_rebuild();
        }
        match flush_invalidate(&mut painter, &patch, &tree) {
            Some(affected) => {
                pass.refresh_paint_only(&tree, &affected, viewport_logical(), SCALE);
            }
            None => {
                generation += 1;
                let text = painter.text_engine_mut();
                pass = LayoutPass::compute_with_state(
                    &mut taffy, &tree, text, VIEWPORT, SCALE, 0.0, &scrolls, generation,
                );
            }
        }
        std::hint::black_box(painter.build_scene(&pass, VIEWPORT, SCALE, 0.0));
    });
}

/// One cell of the frame-update matrix: build the tier's tree at the
/// given physical viewport + HiDPI scale, warm layout + scene caches,
/// then time the flush-equivalent frame after one colour SetProp.
fn run_frame_update(
    vname: &str,
    tname: &str,
    posts: usize,
    density: u8,
    viewport: (u32, u32),
    scale: f32,
) {
    let batch = feed_batch_dense(posts, density);
    let node_count = batch
        .iter()
        .filter(|p| matches!(p, Patch::Create { .. }))
        .count();
    let vp_logical = crate::layout::logical_viewport(viewport, scale);
    let mut tree = Tree::new();
    let mut taffy = TaffyState::new();
    tree.apply_batch(&batch);
    if !taffy.apply_patches(&batch, &tree, scale, vp_logical) {
        taffy.mark_needs_rebuild();
    }
    let mut painter = VelloPainter::new();
    let mut scrolls: HashMap<String, f32> = HashMap::new();
    let mut generation = 0u64;
    let mut pass = {
        let text = painter.text_engine_mut();
        LayoutPass::compute_with_state(
            &mut taffy, &tree, text, viewport, scale, 0.0, &scrolls, generation,
        )
    };
    let _ = painter.build_scene(&pass, viewport, scale, 0.0);
    let items = pass.items.len();
    let ctx = format!("{vname} | {tname} ({node_count} nodes, {items} items on screen)");

    // 1. State-update frame: one paint-prop SetProp lands (keystroke /
    //    counter tick). Tree + Taffy mirror + this revision's painter
    //    invalidation + (paint-only in-place refresh | full layout
    //    recompute, per the recipe's decision) + scene encode.
    let mut red = false;
    time_it(&format!("frame update | {ctx}"), 2, 10, || {
        red = !red;
        let patch = Patch::SetProp {
            id: "name5".into(),
            name: "color".into(),
            value: json!(if red { "#ff0000" } else { "#0f172a" }),
        };
        tree.apply(&patch);
        if !taffy.apply_patches(std::slice::from_ref(&patch), &tree, scale, vp_logical) {
            taffy.mark_needs_rebuild();
        }
        match flush_invalidate(&mut painter, &patch, &tree) {
            Some(affected) => {
                pass.refresh_paint_only(&tree, &affected, vp_logical, scale);
            }
            None => {
                generation += 1;
                let text = painter.text_engine_mut();
                pass = LayoutPass::compute_with_state(
                    &mut taffy, &tree, text, viewport, scale, 0.0, &scrolls, generation,
                );
            }
        }
        std::hint::black_box(painter.build_scene(&pass, viewport, scale, 0.0));
    });

    // 2. Scroll frame: the wheel moves a `.scrollable` container.
    //    This revision mirrors redraw's container fast path: shift
    //    the container's cached items in place within the re-emit
    //    threshold, full recompute past it — the oscillating offset
    //    crosses the threshold periodically, so the timed
    //    distribution mixes both, like a real fling. (A main-side
    //    comparison run replaces this body with the unconditional
    //    per-frame recompute main performs.)
    let mut off = 0.0f32;
    let mut dir = 1.0f32;
    let reemit_threshold = (viewport.1 as f32) * crate::layout::SCROLL_REEMIT_THRESHOLD_VH;
    time_it(&format!("frame scroll | {ctx}"), 2, 10, || {
        off += dir * 60.0 * scale;
        if off > 600.0 * scale {
            dir = -1.0;
        } else if off <= 0.0 {
            off = 0.0;
            dir = 1.0;
        }
        scrolls.insert("feed".to_string(), off);
        let meta = pass.item_by_id("feed").and_then(|it| it.scrollable);
        let (shift, emit_drift) = meta
            .map(|m| (off - m.baked_offset, off - m.emitted_offset))
            .unwrap_or((0.0, 0.0));
        if meta.is_none() {
            generation += 1;
            let text = painter.text_engine_mut();
            pass = LayoutPass::compute_with_state(
                &mut taffy, &tree, text, viewport, scale, 0.0, &scrolls, generation,
            );
        } else if emit_drift.abs() > reemit_threshold {
            pass = LayoutPass::reemit_with_state(&taffy, &tree, viewport, scale, 0.0, &scrolls);
        } else if shift.abs() > f32::EPSILON {
            pass.shift_container_scroll(&tree, "feed", shift, vp_logical, scale);
        }
        std::hint::black_box(painter.build_scene(&pass, viewport, scale, 0.0));
    });
    scrolls.clear();

    // Re-bake a clean pass at offset 0 (the scroll section above left
    // the outer pass shifted / re-emitted mid-oscillation).
    generation += 1;
    pass = {
        let text = painter.text_engine_mut();
        LayoutPass::compute_with_state(
            &mut taffy, &tree, text, viewport, scale, 0.0, &scrolls, generation,
        )
    };

    // 3. Animation / transition frame: the animator wrote an
    //    interpolated transform prop straight into the tree. This
    //    revision classifies the tick paint-only (redraw's
    //    `FrameAnim::paint_only`) and repairs the cached pass in place
    //    + drops only the fragments containing the animated node —
    //    main drops the whole painter cache and recomputes layout.
    //    This is the per-tick cost of a `.transition` / enter/exit
    //    while it plays.
    let mut ty = 0.0f32;
    time_it(&format!("frame anim   | {ctx}"), 2, 10, || {
        ty = if ty >= 24.0 { 0.0 } else { ty + 2.0 };
        tree.set_prop_raw("post5", "translateY", json!(ty));
        // Affected = written node + descendants (transform inherits),
        // exactly what drive_animation_frame derives from the tick's
        // raw-write log.
        let mut affected: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut stack: Vec<String> = vec!["post5".to_string()];
        while let Some(cur) = stack.pop() {
            if affected.insert(cur.clone()) {
                stack.extend(tree.children_of(&cur).iter().cloned());
            }
        }
        pass.refresh_paint_only(&tree, &affected, vp_logical, scale);
        painter.invalidate_subtrees_containing(&affected);
        std::hint::black_box(painter.build_scene(&pass, viewport, scale, 0.0));
    });
    tree.remove_prop_raw("post5", "translateY");
}

/// Per-frame update time across viewport sizes × layout weights: the
/// "state changed, repaint" frame (tree + Taffy mirror + invalidation
/// + full layout recompute + scene encode) that a keystroke or counter
/// tick pays. 4K runs at the typical HiDPI scale 2 (logical 1920×1080,
/// physical 3840×2160 geometry).
#[test]
#[ignore = "manual perf benchmark"]
fn perf_bench_frame_update_matrix() {
    let viewports: [(&str, (u32, u32), f32); 3] = [
        ("800x600 @1x", (800, 600), 1.0),
        ("2K 2560x1440 @1x", (2560, 1440), 1.0),
        ("4K 3840x2160 @2x", (3840, 2160), 2.0),
    ];
    let tiers: [(&str, usize, u8); 3] = [
        ("light,  20 posts", 20, 0),
        ("medium, 150 posts", 150, 0),
        ("heavy,  600 double-dense posts", 600, 2),
    ];
    for (vname, vp, scale) in viewports {
        for (tname, posts, density) in tiers {
            run_frame_update(vname, tname, posts, density, vp, scale);
        }
    }
}

/// End-to-end reproduction of the Food Search grid's warm scroll. Unlike the
/// general frame matrix, this includes Vello's GPU work and waits for each
/// submission to finish, so image-atlas upload/raster cost cannot hide in the
/// queue. Pipeline creation, image decoding, and the first cache fills happen
/// before the measured samples.
#[test]
#[ignore = "manual GPU perf benchmark"]
fn perf_bench_food_grid_scroll() {
    const VIEWPORT: (u32, u32) = (2880, 1800);
    const SCALE: f32 = 2.0;
    const CARD_COUNT: usize = 30;
    const WARMUP_FRAMES: usize = 4;
    const MEASURED_FRAMES: usize = 30;

    fn env_usize(name: &str, default: usize) -> usize {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default)
    }

    fn report(name: &str, mut samples: Vec<Duration>) {
        samples.sort();
        let median = samples[samples.len() / 2];
        let p95 = samples[((samples.len() * 95) / 100).min(samples.len() - 1)];
        let max = samples[samples.len() - 1];
        let fps = 1.0 / median.as_secs_f64();
        println!(
            "[food-scroll] {name:<17} median {median:>10.3?}  p95 {p95:>10.3?}  max {max:>10.3?}  ({fps:>6.1} fps equivalent)"
        );
    }

    // Seed 30 distinct, already-decoded 800x600 sources. Distinct allocations
    // matter: Vello keys image resources by Blob identity, just like the 30
    // distinct Unsplash responses used by the real app.
    let active_images = env_usize("HYPEN_FOOD_BENCH_IMAGES", CARD_COUNT).min(CARD_COUNT);
    let source_size = (
        env_usize("HYPEN_FOOD_BENCH_IMAGE_WIDTH", 800) as u32,
        env_usize("HYPEN_FOOD_BENCH_IMAGE_HEIGHT", 600) as u32,
    );
    assert!(source_size.0 > 0 && source_size.1 > 0);
    for i in 0..active_images {
        let mut pixmap = tiny_skia::Pixmap::new(source_size.0, source_size.1)
            .expect("allocate Food benchmark source");
        pixmap.fill(tiny_skia::Color::from_rgba8(
            32 + (i as u8).wrapping_mul(37),
            64 + (i as u8).wrapping_mul(53),
            96 + (i as u8).wrapping_mul(71),
            255,
        ));
        crate::paint::image::test_seed_decoded(&format!("bench://food/{i}"), Arc::new(pixmap));
    }

    let batch = food_grid_batch(active_images);
    let mut tree = Tree::new();
    let mut taffy = TaffyState::new();
    tree.apply_batch(&batch);
    let vp_logical = crate::layout::logical_viewport(VIEWPORT, SCALE);
    if !taffy.apply_patches(&batch, &tree, SCALE, vp_logical) {
        taffy.mark_needs_rebuild();
    }
    let mut painter = VelloPainter::new();
    let mut scrolls = HashMap::new();
    let mut pass = {
        let text = painter.text_engine_mut();
        LayoutPass::compute_with_state(&mut taffy, &tree, text, VIEWPORT, SCALE, 0.0, &scrolls, 0)
    };
    let scroll_item = pass
        .item_by_id("food_scroll")
        .expect("Food fixture must emit its scroll container");
    let scroll_meta = scroll_item
        .scrollable
        .expect("Food fixture must overflow its scroll container");
    let max_scroll = (scroll_meta.content_h - scroll_item.rect.h).max(0.0);
    assert!(max_scroll > 0.0, "Food fixture did not overflow");

    let emitted_images = pass
        .items
        .iter()
        .filter(|item| matches!(item.kind, crate::layout::ItemKind::Image { .. }))
        .count();
    let viewport_rect = crate::layout::Rect {
        x: 0.0,
        y: 0.0,
        w: VIEWPORT.0 as f32,
        h: VIEWPORT.1 as f32,
    };
    let visible_images = pass
        .items
        .iter()
        .filter(|item| {
            matches!(item.kind, crate::layout::ItemKind::Image { .. })
                && crate::damage::rects_intersect(item.visual_rect(), viewport_rect)
        })
        .count();
    println!(
        "[food-scroll] fixture           30 cards, {active_images} sourced images ({emitted_images} Image nodes, {visible_images} visible), {}x{} source, {:.1} MiB decoded source data, viewport {}x{} @2x",
        source_size.0,
        source_size.1,
        (active_images * source_size.0 as usize * source_size.1 as usize * 4) as f64
            / (1024.0 * 1024.0),
        VIEWPORT.0,
        VIEWPORT.1,
    );

    // Walk the entire list before timing. This mirrors the reported case:
    // every source has been seen, decoded, and wrapped as ImageData already.
    let mut warm_offset = 0.0f32;
    while warm_offset <= max_scroll {
        scrolls.insert("food_scroll".to_string(), warm_offset);
        pass = LayoutPass::reemit_with_state(&taffy, &tree, VIEWPORT, SCALE, 0.0, &scrolls);
        std::hint::black_box(painter.build_scene(&pass, VIEWPORT, SCALE, 0.0));
        warm_offset += VIEWPORT.1 as f32 * 0.4;
    }
    scrolls.insert("food_scroll".to_string(), 0.0);
    pass = LayoutPass::reemit_with_state(&taffy, &tree, VIEWPORT, SCALE, 0.0, &scrolls);

    // Off-screen wgpu target: no swapchain or vsync, so the result is stable
    // GPU completion time rather than time spent waiting for a display slot.
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let mut gpu = match pollster::block_on(wgpu::util::initialize_adapter_from_env_or_default(
        &instance, None,
    )) {
        Ok(adapter) => {
            let adapter_info = adapter.get_info();
            let (device, queue) =
                pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
                    .expect("request Food benchmark device");
            let renderer = vello::Renderer::new(
                &device,
                vello::RendererOptions {
                    use_cpu: false,
                    antialiasing_support: vello::AaSupport::area_only(),
                    num_init_threads: std::num::NonZeroUsize::new(1),
                    pipeline_cache: None,
                },
            )
            .expect("create Food benchmark Vello renderer");
            let target = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("food-scroll-benchmark-target"),
                size: wgpu::Extent3d {
                    width: VIEWPORT.0,
                    height: VIEWPORT.1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::STORAGE_BINDING
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());
            let params = vello::RenderParams {
                base_color: vello::peniko::Color::from_rgba8(0xfb, 0xfb, 0xfd, 0xff),
                width: VIEWPORT.0,
                height: VIEWPORT.1,
                antialiasing_method: vello::AaConfig::Area,
            };
            println!(
                "[food-scroll] adapter           {} ({:?})",
                adapter_info.name, adapter_info.backend
            );
            Some((device, queue, renderer, target, target_view, params))
        }
        Err(error) => {
            println!("[food-scroll] adapter           unavailable ({error}); GPU timings skipped");
            None
        }
    };

    let mut offset = 0.0f32;
    let mut direction = 1.0f32;
    let step = 48.0 * SCALE;
    for _ in 0..WARMUP_FRAMES {
        offset = (offset + direction * step).clamp(0.0, max_scroll);
        if offset >= max_scroll || offset <= 0.0 {
            direction = -direction;
        }
        let baked = pass
            .item_by_id("food_scroll")
            .and_then(|item| item.scrollable)
            .map(|meta| meta.baked_offset)
            .unwrap_or(0.0);
        pass.shift_container_scroll(&tree, "food_scroll", offset - baked, vp_logical, SCALE);
        let scene = painter.build_scene(&pass, VIEWPORT, SCALE, 0.0);
        if let Some((device, queue, renderer, _, target_view, params)) = gpu.as_mut() {
            renderer
                .render_to_texture(device, queue, scene, target_view, params)
                .expect("warm Food benchmark frame");
            device
                .poll(wgpu::PollType::wait_indefinitely())
                .expect("wait for warm Food benchmark frame");
        } else {
            std::hint::black_box(scene);
        }
    }

    let mut layout_samples = Vec::with_capacity(MEASURED_FRAMES);
    let mut scene_samples = Vec::with_capacity(MEASURED_FRAMES);
    let mut gpu_samples = Vec::with_capacity(MEASURED_FRAMES);
    let mut total_samples = Vec::with_capacity(MEASURED_FRAMES);
    for _ in 0..MEASURED_FRAMES {
        let total_started = Instant::now();
        offset = (offset + direction * step).clamp(0.0, max_scroll);
        if offset >= max_scroll || offset <= 0.0 {
            direction = -direction;
        }

        let layout_started = Instant::now();
        let baked = pass
            .item_by_id("food_scroll")
            .and_then(|item| item.scrollable)
            .map(|meta| meta.baked_offset)
            .unwrap_or(0.0);
        pass.shift_container_scroll(&tree, "food_scroll", offset - baked, vp_logical, SCALE);
        layout_samples.push(layout_started.elapsed());

        let scene_started = Instant::now();
        let scene = painter.build_scene(&pass, VIEWPORT, SCALE, 0.0);
        scene_samples.push(scene_started.elapsed());

        if let Some((device, queue, renderer, _, target_view, params)) = gpu.as_mut() {
            let gpu_started = Instant::now();
            renderer
                .render_to_texture(device, queue, scene, target_view, params)
                .expect("render Food benchmark frame");
            device
                .poll(wgpu::PollType::wait_indefinitely())
                .expect("wait for Food benchmark frame");
            gpu_samples.push(gpu_started.elapsed());
        } else {
            std::hint::black_box(scene);
        }
        total_samples.push(total_started.elapsed());
    }

    report("layout shift", layout_samples);
    report("scene encode", scene_samples);
    if gpu_samples.is_empty() {
        report("CPU total", total_samples);
    } else {
        report("GPU completion", gpu_samples);
        report("total frame", total_samples);
    }
}

/// Measure the state-update frame (same recipe as the matrix) and
/// return `(min, median, items_on_screen, node_count)` instead of
/// printing — the sweep benches print machine-parsable lines for
/// curve fitting.
fn measure_update_frame(
    posts: usize,
    density: u8,
    viewport: (u32, u32),
    scale: f32,
) -> (Duration, Duration, usize, usize) {
    let batch = feed_batch_dense(posts, density);
    let node_count = batch
        .iter()
        .filter(|p| matches!(p, Patch::Create { .. }))
        .count();
    let vp_logical = crate::layout::logical_viewport(viewport, scale);
    let mut tree = Tree::new();
    let mut taffy = TaffyState::new();
    tree.apply_batch(&batch);
    if !taffy.apply_patches(&batch, &tree, scale, vp_logical) {
        taffy.mark_needs_rebuild();
    }
    let mut painter = VelloPainter::new();
    let scrolls: HashMap<String, f32> = HashMap::new();
    let mut generation = 0u64;
    let mut pass = {
        let text = painter.text_engine_mut();
        LayoutPass::compute_with_state(
            &mut taffy, &tree, text, viewport, scale, 0.0, &scrolls, generation,
        )
    };
    let _ = painter.build_scene(&pass, viewport, scale, 0.0);
    let items = pass.items.len();
    let mut red = false;
    let mut samples: Vec<Duration> = Vec::with_capacity(12);
    for run in 0..12 {
        red = !red;
        let patch = Patch::SetProp {
            id: "name5".into(),
            name: "color".into(),
            value: json!(if red { "#ff0000" } else { "#0f172a" }),
        };
        let t = Instant::now();
        tree.apply(&patch);
        if !taffy.apply_patches(std::slice::from_ref(&patch), &tree, scale, vp_logical) {
            taffy.mark_needs_rebuild();
        }
        match flush_invalidate(&mut painter, &patch, &tree) {
            Some(affected) => {
                pass.refresh_paint_only(&tree, &affected, vp_logical, scale);
            }
            None => {
                generation += 1;
                let text = painter.text_engine_mut();
                pass = LayoutPass::compute_with_state(
                    &mut taffy, &tree, text, viewport, scale, 0.0, &scrolls, generation,
                );
            }
        }
        std::hint::black_box(painter.build_scene(&pass, viewport, scale, 0.0));
        if run >= 2 {
            samples.push(t.elapsed());
        }
    }
    samples.sort();
    (samples[0], samples[samples.len() / 2], items, node_count)
}

/// Resolution sweep: fixed 250-post tree, viewport grows @1x. Visible
/// items grow with viewport height (vertical feed + cull window);
/// frame time should be affine in visible items.
#[test]
#[ignore = "manual perf benchmark"]
fn perf_bench_scaling_resolution() {
    const POSTS: usize = 250;
    for (w, h) in [
        (800u32, 600u32),
        (1280, 720),
        (1600, 900),
        (1920, 1080),
        (2560, 1440),
        (3200, 1800),
        (3840, 2160),
    ] {
        let (min, median, items, nodes) = measure_update_frame(POSTS, 0, (w, h), 1.0);
        println!(
            "[sweep-res] w={w} h={h} nodes={nodes} items={items} min_us={} median_us={}",
            min.as_micros(),
            median.as_micros()
        );
    }
}

/// Node sweep: fixed 1920×1080 @1x viewport, total posts grow. Past
/// the cull window (1 + 2×CULL_BUFFER_VH viewports of content, ~60
/// posts at the current 2.0) visible items saturate, isolating the
/// per-total-node tax (Taffy re-solve + O(nodes) scans).
#[test]
#[ignore = "manual perf benchmark"]
fn perf_bench_scaling_nodes() {
    for posts in [25usize, 50, 100, 200, 400, 800, 1600] {
        let (min, median, items, nodes) = measure_update_frame(posts, 0, (1920, 1080), 1.0);
        println!(
            "[sweep-nodes] posts={posts} nodes={nodes} items={items} min_us={} median_us={}",
            min.as_micros(),
            median.as_micros()
        );
    }
}

/// Live-resize frame, decomposed. A window drag delivers a burst of
/// `WindowEvent::Resized`, and `App::window_event` paints each one
/// synchronously: drop the layout cache, recompute the pass at the new
/// viewport, re-encode the whole Vello scene (the painter drops its
/// subtree cache on any viewport change), then republish AccessKit
/// (the fingerprint moves every frame because every rect moved).
///
/// This bench measures those stages separately so the per-frame CPU
/// budget during a drag is attributable. GPU submit/present is excluded
/// — headless — so the real frame is this plus vsync.
#[test]
#[ignore = "manual perf benchmark"]
fn perf_bench_resize_frame() {
    for (label, posts, density, base, scale) in [
        (
            "light,  20 posts  @1280x720",
            20usize,
            0u8,
            (1280u32, 720u32),
            1.0f32,
        ),
        ("medium, 150 posts @1920x1080", 150, 0, (1920, 1080), 1.0),
        ("heavy,  600 posts @1920x1080", 600, 2, (1920, 1080), 1.0),
    ] {
        let batch = feed_batch_dense(posts, density);
        let mut tree = Tree::new();
        let mut taffy = TaffyState::new();
        let vp_logical = crate::layout::logical_viewport(base, scale);
        tree.apply_batch(&batch);
        if !taffy.apply_patches(&batch, &tree, scale, vp_logical) {
            taffy.mark_needs_rebuild();
        }
        let mut painter = VelloPainter::new();
        let scrolls: HashMap<String, f32> = HashMap::new();
        let mut pass = {
            let text = painter.text_engine_mut();
            LayoutPass::compute_with_state(&mut taffy, &tree, text, base, scale, 0.0, &scrolls, 0)
        };
        let _ = painter.build_scene(&pass, base, scale, 0.0);
        println!("[resize] --- {label} ({} items) ---", pass.items.len());

        // Stage 1: layout pass at a NEW width (restyle_all + Taffy + emit).
        //
        // The width MUST decrease monotonically and never repeat. An
        // earlier version cycled through 8 widths, which let every text
        // measure hit the cache from the 9th iteration on and made the
        // reported figure ~1.7x better than a drag ever is: `wrap_width`
        // is part of the measure-cache key, so a real drag mints a fresh
        // key for every text node on every frame.
        let mut w_step = 0u32;
        time_it(&format!("resize LAYOUT width-drag  {label}"), 2, 10, || {
            w_step += 1;
            let vp = (base.0 - w_step * 2, base.1);
            let text = painter.text_engine_mut();
            std::hint::black_box(LayoutPass::compute_with_state(
                &mut taffy, &tree, text, vp, scale, 0.0, &scrolls, 0,
            ));
        });

        // Stage 2: layout pass at a NEW height only (no restyle_all;
        // `taffy_structure_key` deliberately excludes height).
        // Monotonic too, for symmetry — though height does not feed the
        // measure key, so this axis was never distorted by the cycle.
        let mut h_step = 0u32;
        time_it(&format!("resize LAYOUT height-drag {label}"), 2, 10, || {
            h_step += 1;
            let vp = (base.0, base.1 - h_step * 2);
            let text = painter.text_engine_mut();
            std::hint::black_box(LayoutPass::compute_with_state(
                &mut taffy, &tree, text, vp, scale, 0.0, &scrolls, 0,
            ));
        });

        // Restore a pass at the base viewport for the paint / a11y stages.
        pass = {
            let text = painter.text_engine_mut();
            LayoutPass::compute_with_state(&mut taffy, &tree, text, base, scale, 0.0, &scrolls, 0)
        };

        // Stage 3: scene encode with the subtree cache cold — what a
        // viewport change forces on every single resize frame.
        time_it(
            &format!("resize ENCODE (cache cold) {label}"),
            2,
            10,
            || {
                painter.invalidate_subtree_cache();
                std::hint::black_box(painter.build_scene(&pass, base, scale, 0.0));
            },
        );

        // Stage 4: AccessKit republish — fingerprint + full TreeUpdate.
        // Runs on every resize frame: `layout_generation` bumps and the
        // fingerprint changes because every rect moved.
        let excluded: Vec<String> = Vec::new();
        time_it(
            &format!("resize A11Y publish        {label}"),
            2,
            10,
            || {
                let fp = std::hint::black_box(crate::window::a11y_fingerprint(&pass, &excluded));
                std::hint::black_box(fp);
                std::hint::black_box(crate::accessibility::tree_update_for_layout_excluding(
                    &pass,
                    &|_id| false,
                ));
            },
        );
    }
}

/// Isolate the per-node style build — the inner loop of `restyle_all`,
/// which a width-resize runs over every node in the tree (not just the
/// visible ones) on every frame of the drag.
#[test]
#[ignore = "manual perf benchmark"]
fn perf_bench_node_style_build() {
    let batch = feed_batch_dense(20, 2);
    let mut tree = Tree::new();
    tree.apply_batch(&batch);
    let vp = viewport_logical();
    let ids: Vec<String> = batch
        .iter()
        .filter_map(|p| match p {
            Patch::Create { id, .. } => Some(id.to_string()),
            _ => None,
        })
        .collect();
    let nodes: Vec<&crate::tree::Node> = ids.iter().filter_map(|id| tree.get(id)).collect();
    let n = nodes.len();
    println!("[style] {n} nodes");
    let empty: [&str; 0] = [];
    let safe = crate::layout::SafeAreaInsets::default();
    time_it("node_style_with x all nodes", 3, 20, || {
        for node in &nodes {
            std::hint::black_box(crate::layout::node_style_with(
                node, SCALE, vp, &empty, safe,
            ));
        }
    });
    // Per-call figure for the write-up.
    let t = Instant::now();
    const REPS: usize = 50;
    for _ in 0..REPS {
        for node in &nodes {
            std::hint::black_box(crate::layout::node_style_with(
                node, SCALE, vp, &empty, safe,
            ));
        }
    }
    let per = t.elapsed() / (REPS * n) as u32;
    println!("[style] per node_style_with call: {per:?}");
}

/// What virtualising the scrollable containers would actually be worth.
///
/// The renderer solves every node in the tree and then culls at emit, so
/// a 600-post feed hands Taffy ~13k nodes to place 381 visible items. A
/// virtualised container would instead give Taffy only the window plus
/// two spacers standing in for the scrolled-past and not-yet-reached
/// content, sized from cached heights.
///
/// This measures that shape directly — same viewport, same visible post
/// count, same total content height, but the off-window posts collapsed
/// into two fixed-height leaves. It is not an implementation; it is the
/// floor any implementation would be aiming at, measured before
/// committing to the work.
#[test]
#[ignore = "manual perf benchmark"]
fn perf_bench_virtualization_headroom() {
    const VP: (u32, u32) = (1920, 1080);
    let vp_logical = crate::layout::logical_viewport(VP, SCALE);
    let scrolls: HashMap<String, f32> = HashMap::new();

    // Measure the real thing first, and learn the content height and how
    // many posts actually land inside the cull window.
    let full_batch = feed_batch_dense(600, 0);
    let mut tree = Tree::new();
    let mut taffy = TaffyState::new();
    tree.apply_batch(&full_batch);
    if !taffy.apply_patches(&full_batch, &tree, SCALE, vp_logical) {
        taffy.mark_needs_rebuild();
    }
    let mut painter = VelloPainter::new();
    let pass = {
        let text = painter.text_engine_mut();
        LayoutPass::compute_with_state(&mut taffy, &tree, text, VP, SCALE, 0.0, &scrolls, 0)
    };
    let full_nodes = full_batch
        .iter()
        .filter(|p| matches!(p, Patch::Create { .. }))
        .count();
    let content_h = pass.content_size.1;
    // Posts whose own item survived the cull — the window a virtualised
    // container would have to keep real.
    let live_posts = pass
        .items
        .iter()
        .filter(|it| it.node_id.starts_with("post"))
        .count();
    println!(
        "[virt] full: {full_nodes} nodes, {} items, content_h {content_h:.0}, {live_posts} posts in window",
        pass.items.len()
    );

    let mut w_step = 0u32;
    time_it("virt FULL      600 posts, all real", 2, 10, || {
        w_step += 1;
        let vp = (VP.0 - w_step * 2, VP.1);
        let text = painter.text_engine_mut();
        std::hint::black_box(LayoutPass::compute_with_state(
            &mut taffy, &tree, text, vp, SCALE, 0.0, &scrolls, 0,
        ));
    });

    // The virtualised shape: the same window of real posts, with the rest
    // of the content height carried by two spacer leaves.
    let window = live_posts.max(1);
    let mut virt_batch = feed_batch_dense(window, 0);
    let spacer_h = ((content_h as f64 - content_h as f64 * window as f64 / 600.0) / 2.0).max(1.0);
    for tag in ["lead", "trail"] {
        virt_batch.push(create(
            tag,
            "Container",
            &[("height", json!(spacer_h)), ("width", json!(100.0))],
        ));
        virt_batch.push(insert("feed", tag));
    }
    let mut vtree = Tree::new();
    let mut vtaffy = TaffyState::new();
    vtree.apply_batch(&virt_batch);
    if !vtaffy.apply_patches(&virt_batch, &vtree, SCALE, vp_logical) {
        vtaffy.mark_needs_rebuild();
    }
    let mut vpainter = VelloPainter::new();
    let vnodes = virt_batch
        .iter()
        .filter(|p| matches!(p, Patch::Create { .. }))
        .count();
    {
        let text = vpainter.text_engine_mut();
        let vpass =
            LayoutPass::compute_with_state(&mut vtaffy, &vtree, text, VP, SCALE, 0.0, &scrolls, 0);
        println!(
            "[virt] virtualised: {vnodes} nodes, {} items",
            vpass.items.len()
        );
    }
    let mut vw_step = 0u32;
    time_it("virt WINDOWED  window + 2 spacers", 2, 10, || {
        vw_step += 1;
        let vp = (VP.0 - vw_step * 2, VP.1);
        let text = vpainter.text_engine_mut();
        std::hint::black_box(LayoutPass::compute_with_state(
            &mut vtaffy,
            &vtree,
            text,
            vp,
            SCALE,
            0.0,
            &scrolls,
            0,
        ));
    });
}

/// The gated path: a tree that DOES read the viewport.
///
/// `h-screen` lowers to `height: "100vh"` and is the ordinary app-shell
/// idiom, so the interesting question for the per-node viewport
/// dependency record is not how fast a vh-free tree resizes (that is the
/// tier above) but how much a vh-bearing one gives back. If this row is
/// close to the vh-free height-drag row, resolving viewport units lazily
/// instead of eagerly would buy nothing, because the restyle it would
/// avoid is already down to a handful of nodes.
#[test]
#[ignore = "manual perf benchmark"]
fn perf_bench_resize_frame_viewport_units() {
    const VP: (u32, u32) = (1920, 1080);
    for (label, posts, vh_nodes) in [
        ("150 posts, shell only", 150usize, 0usize),
        ("150 posts, shell + 20 vh", 150, 20),
        ("600 posts, shell only", 600, 0),
    ] {
        let mut batch = feed_batch_dense(posts, 0);
        // The app shell: one `h-screen`-equivalent at the root.
        batch.push(Patch::SetProp {
            id: "feed".into(),
            name: "height".into(),
            value: json!("100vh"),
        });
        // Optionally scatter more viewport-relative lengths through the
        // tree, to see how the cost tracks the number of dependents.
        for i in 0..vh_nodes {
            batch.push(Patch::SetProp {
                id: format!("post{i}").into(),
                name: "paddingTop".into(),
                value: json!("2vh"),
            });
        }
        let vp_logical = crate::layout::logical_viewport(VP, SCALE);
        let mut tree = Tree::new();
        let mut taffy = TaffyState::new();
        tree.apply_batch(&batch);
        if !taffy.apply_patches(&batch, &tree, SCALE, vp_logical) {
            taffy.mark_needs_rebuild();
        }
        let mut painter = VelloPainter::new();
        let scrolls: HashMap<String, f32> = HashMap::new();
        {
            let text = painter.text_engine_mut();
            let _ = LayoutPass::compute_with_state(
                &mut taffy, &tree, text, VP, SCALE, 0.0, &scrolls, 0,
            );
        }
        let mut h_step = 0u32;
        time_it(&format!("resize vh height-drag {label}"), 2, 10, || {
            h_step += 1;
            let vp = (VP.0, VP.1 - h_step * 2);
            let text = painter.text_engine_mut();
            std::hint::black_box(LayoutPass::compute_with_state(
                &mut taffy, &tree, text, vp, SCALE, 0.0, &scrolls, 0,
            ));
        });
    }
}

/// Resize sweep: fixed 1920×1080 viewport (so the number of VISIBLE,
/// post-cull items saturates early) while total node count grows.
///
/// This isolates the per-total-node tax on a resize frame. A flat curve
/// would mean the pass costs what it draws; a linear one means we pay
/// for the whole tree to draw a fixed window of it.
#[test]
#[ignore = "manual perf benchmark"]
fn perf_bench_resize_scaling_nodes() {
    const VP: (u32, u32) = (1920, 1080);
    const SCALE: f32 = 1.0;
    for posts in [25usize, 50, 100, 200, 400, 800] {
        let batch = feed_batch_dense(posts, 0);
        let nodes = batch
            .iter()
            .filter(|p| matches!(p, Patch::Create { .. }))
            .count();
        let vp_logical = crate::layout::logical_viewport(VP, SCALE);
        let mut tree = Tree::new();
        let mut taffy = TaffyState::new();
        tree.apply_batch(&batch);
        if !taffy.apply_patches(&batch, &tree, SCALE, vp_logical) {
            taffy.mark_needs_rebuild();
        }
        let mut painter = VelloPainter::new();
        let scrolls: HashMap<String, f32> = HashMap::new();
        let pass = {
            let text = painter.text_engine_mut();
            LayoutPass::compute_with_state(&mut taffy, &tree, text, VP, SCALE, 0.0, &scrolls, 0)
        };
        let items = pass.items.len();

        // Monotonic, and every sample counts. The previous version
        // stepped `% 4` and then kept only steps 4..8 — it threw away
        // the cold samples that actually resemble a drag and reported
        // the minimum of the warm repeats.
        let mut sample = |dw: u32, dh: u32| -> Duration {
            let mut samples: Vec<Duration> = Vec::with_capacity(8);
            for step in 1..=8u32 {
                let vp = (VP.0 - dw * step * 2, VP.1 - dh * step * 2);
                let text = painter.text_engine_mut();
                let t = Instant::now();
                std::hint::black_box(LayoutPass::compute_with_state(
                    &mut taffy, &tree, text, vp, SCALE, 0.0, &scrolls, 0,
                ));
                samples.push(t.elapsed());
            }
            samples.sort();
            samples[samples.len() / 2]
        };
        let w = sample(8, 0);
        let h = sample(0, 8);
        println!(
            "[sweep-resize] posts={posts} nodes={nodes} items={items} \
             width_median_us={} height_median_us={}",
            w.as_micros(),
            h.as_micros()
        );
    }
}
