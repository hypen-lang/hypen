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
    let min = samples[0];
    let median = samples[samples.len() / 2];
    println!("[perf] {name}: min {min:>10.3?}  median {median:>10.3?}  ({runs} runs)");
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
                    ("0", json!(format!("Second paragraph {i} with a bit more wrapped body text for shaping."))),
                    ("fontSize", json!(14.0)),
                ],
            ),
            insert(&post, &body2),
            create(
                &divider,
                "Container",
                &[("height", json!(1.0)), ("backgroundColor", json!("#e2e8f0"))],
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
                    ("0", json!(format!("Top comment {i}: nice post, love the detail!"))),
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
        create("feed", "Column", &[("scrollable", json!(true)), ("gap", json!(8.0))]),
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

/// This revision's flush-time painter invalidation for a one-patch
/// batch. Kept as the single swap point for main-vs-branch runs.
fn flush_invalidate(painter: &mut VelloPainter, patch: &Patch, tree: &Tree) {
    // ── invalidation recipe (matches this revision's flush_patches) ──
    match crate::window::paint_only_affected_ids(
        std::slice::from_ref(patch),
        &[],
        tree,
        false,
        false,
    ) {
        Some(affected) => painter.invalidate_subtrees_containing(&affected),
        None => painter.invalidate_subtree_cache(),
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
            std::hint::black_box(crate::layout::node_style_with(node, SCALE, vp, &[]));
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
    let pass = {
        let text = painter.text_engine_mut();
        LayoutPass::compute_with_state(
            &mut taffy, &tree, text, VIEWPORT, SCALE, 0.0, &scrolls, 0,
        )
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
    // invalidation recipe, full layout recompute, scene encode. This is
    // the "keystroke / counter tick" frame.
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
        flush_invalidate(&mut painter, &patch, &tree);
        generation += 1;
        let pass = {
            let text = painter.text_engine_mut();
            LayoutPass::compute_with_state(
                &mut taffy, &tree, text, VIEWPORT, SCALE, 0.0, &scrolls, generation,
            )
        };
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
    let items = {
        let pass = {
            let text = painter.text_engine_mut();
            LayoutPass::compute_with_state(
                &mut taffy, &tree, text, viewport, scale, 0.0, &scrolls, generation,
            )
        };
        let _ = painter.build_scene(&pass, viewport, scale, 0.0);
        pass.items.len()
    };
    let ctx = format!("{vname} | {tname} ({node_count} nodes, {items} items on screen)");

    // 1. State-update frame: one paint-prop SetProp lands (keystroke /
    //    counter tick). Tree + Taffy mirror + this revision's painter
    //    invalidation + full layout recompute + scene encode.
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
        flush_invalidate(&mut painter, &patch, &tree);
        generation += 1;
        let pass = {
            let text = painter.text_engine_mut();
            LayoutPass::compute_with_state(
                &mut taffy, &tree, text, viewport, scale, 0.0, &scrolls, generation,
            )
        };
        std::hint::black_box(painter.build_scene(&pass, viewport, scale, 0.0));
    });

    // 2. Scroll frame: the wheel moves a `.scrollable` container. In
    //    the App this bumps the layout cache key (full recompute + emit
    //    at the new offset) but does NOT invalidate the painter cache —
    //    cached fragments replay with a y-translate. This is the
    //    per-container scroll path; page scroll's shift-in-place fast
    //    path is strictly cheaper than this.
    let mut off = 0.0f32;
    let mut dir = 1.0f32;
    time_it(&format!("frame scroll | {ctx}"), 2, 10, || {
        off += dir * 60.0 * scale;
        if off > 600.0 * scale {
            dir = -1.0;
        } else if off <= 0.0 {
            off = 0.0;
            dir = 1.0;
        }
        scrolls.insert("feed".to_string(), off);
        generation += 1;
        let pass = {
            let text = painter.text_engine_mut();
            LayoutPass::compute_with_state(
                &mut taffy, &tree, text, viewport, scale, 0.0, &scrolls, generation,
            )
        };
        std::hint::black_box(painter.build_scene(&pass, viewport, scale, 0.0));
    });
    scrolls.clear();

    // 3. Animation / transition frame: the animator wrote an
    //    interpolated transform prop straight into the tree — the App
    //    then drops the WHOLE painter cache (animation invalidation is
    //    deliberately wholesale on every revision), recomputes layout
    //    (transform post-pass now active) and re-encodes. This is the
    //    per-tick cost of a `.transition` / enter/exit while it plays.
    let mut ty = 0.0f32;
    time_it(&format!("frame anim   | {ctx}"), 2, 10, || {
        ty = if ty >= 24.0 { 0.0 } else { ty + 2.0 };
        tree.set_prop_raw("post5", "translateY", json!(ty));
        painter.invalidate_subtree_cache();
        generation += 1;
        let pass = {
            let text = painter.text_engine_mut();
            LayoutPass::compute_with_state(
                &mut taffy, &tree, text, viewport, scale, 0.0, &scrolls, generation,
            )
        };
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
    let items = {
        let pass = {
            let text = painter.text_engine_mut();
            LayoutPass::compute_with_state(
                &mut taffy, &tree, text, viewport, scale, 0.0, &scrolls, generation,
            )
        };
        let _ = painter.build_scene(&pass, viewport, scale, 0.0);
        pass.items.len()
    };
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
        flush_invalidate(&mut painter, &patch, &tree);
        generation += 1;
        let pass = {
            let text = painter.text_engine_mut();
            LayoutPass::compute_with_state(
                &mut taffy, &tree, text, viewport, scale, 0.0, &scrolls, generation,
            )
        };
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
/// the cull window (~60 posts) visible items saturate, isolating the
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
