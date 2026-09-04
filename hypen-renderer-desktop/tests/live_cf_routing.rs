//! Live-deploy diagnostic for the desktop renderer's WS path.
//!
//! Drives `RemoteModule` directly against the deployed Cloudflare worker.
//! Strips out the GUI and hit-test layers so we isolate one question:
//! when the renderer receives `Patch` frames over `wss://`, does it
//! correctly fire the `on_patches` callback with all of them?
//!
//! We connect, count patches received before and after a `router.push`,
//! and assert the post-push batch matches what the worker actually
//! emitted (validated independently as ~105 patches). If this passes,
//! the desktop's WS path is fine and the bug is downstream (renderer /
//! hit-test). If it fails, we've localised the bug to the desktop's
//! patch-receive path.
//!
//! Tagged `#[ignore]` because it hits a network endpoint — run with
//! `cargo test --test live_cf_routing -- --ignored --nocapture`.

use hypen_renderer_desktop::module::HypenModule;
use hypen_renderer_desktop::remote::RemoteModule;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn count_patches_for_url(url: &str) -> (Vec<usize>, Vec<usize>) {
    let module = RemoteModule::connect(url, "App");
    let frames: Arc<Mutex<Vec<usize>>> = Arc::new(Mutex::new(Vec::new()));
    let frames_for_cb = Arc::clone(&frames);
    module.on_patches(Arc::new(move |patches| {
        frames_for_cb.lock().unwrap().push(patches.len());
    }));
    module.mount();
    std::thread::sleep(Duration::from_millis(3000));
    let before = frames.lock().unwrap().clone();
    module.dispatch_action(
        "router.push",
        Some(serde_json::json!({"to": "/profile"})),
    );
    std::thread::sleep(Duration::from_millis(2500));
    let all = frames.lock().unwrap().clone();
    let after = all[before.len()..].to_vec();
    (before, after)
}

/// Collect the actual patches that arrived after a `router.push` so we
/// can diff them between servers, not just count them.
fn collect_post_push_patches(
    url: &str,
) -> Vec<hypen_engine::Patch> {
    let module = RemoteModule::connect(url, "App");
    let collected: Arc<Mutex<Vec<hypen_engine::Patch>>> =
        Arc::new(Mutex::new(Vec::new()));
    let collected_for_cb = Arc::clone(&collected);
    // Capture only frames AFTER the push.
    let pushed: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    let pushed_for_cb = Arc::clone(&pushed);
    module.on_patches(Arc::new(move |patches| {
        if *pushed_for_cb.lock().unwrap() {
            collected_for_cb.lock().unwrap().extend_from_slice(patches);
        }
    }));
    module.mount();
    std::thread::sleep(Duration::from_millis(3000));
    *pushed.lock().unwrap() = true;
    module.dispatch_action(
        "router.push",
        Some(serde_json::json!({"to": "/profile"})),
    );
    std::thread::sleep(Duration::from_millis(2500));
    let out = collected.lock().unwrap().clone();
    out
}

#[test]
#[ignore = "hits the live deploy; opt in with --ignored"]
fn router_push_against_live_cf_deploy_delivers_swap_patches() {
    let _ = env_logger::builder()
        .filter_module("hypen_renderer_desktop", log::LevelFilter::Debug)
        .is_test(true)
        .try_init();

    let module = RemoteModule::connect(
        "wss://hypen-calorie-counter.ian-dae.workers.dev/ws",
        "App",
    );

    // Bucket received patches by call. Each `on_patches` invocation is one
    // server-side `InitialTree` or `Patch` frame.
    let frames: Arc<Mutex<Vec<usize>>> = Arc::new(Mutex::new(Vec::new()));
    let frames_for_cb = Arc::clone(&frames);
    module.on_patches(Arc::new(move |patches| {
        frames_for_cb.lock().unwrap().push(patches.len());
    }));

    // Mount triggers the worker to start pumping (no-op here, but we call
    // it to mirror real renderer setup).
    module.mount();

    // Wait for initial-tree + Home hydration to settle.
    std::thread::sleep(Duration::from_millis(3000));

    let before = frames.lock().unwrap().clone();
    println!("frames before router.push: {:?}", before);
    let before_total: usize = before.iter().sum();
    assert!(
        before_total > 50,
        "expected initialTree + Home hydration to deliver many patches before push; got {before_total}",
    );

    // Dispatch router.push exactly the way the click path would.
    module.dispatch_action(
        "router.push",
        Some(serde_json::json!({"to": "/profile"})),
    );

    // Wait for the route swap + Profile onActivated to settle.
    std::thread::sleep(Duration::from_millis(2500));

    let all = frames.lock().unwrap().clone();
    let after = &all[before.len()..];
    println!("frames after router.push: {:?}", after);
    let after_total: usize = after.iter().sum();

    // The worker emits ~105 patches on the swap. If the desktop's
    // WS-receive path is healthy, those land in the callback. If it
    // returns 0 or 1, the bug is in the receive path (TLS framing,
    // serde Patch enum drift, batched-frame splitter, …).
    assert!(
        after_total >= 50,
        "post-push delivered only {after_total} patches across {} frames; \
         worker emits ~105. If the smoke test in hypen-web/cloudflare/ \
         shows n=105 but this shows ~0, the desktop receive path is the bug.",
        after.len(),
    );
}

/// A/B between `wss://` (deploy) and `ws://localhost:8821` (wrangler dev).
/// Pre-req: run `bun run dev` from examples/calorie-counter/cloudflare/
/// in another terminal first. Run with
/// `cargo test --test live_cf_routing -- --ignored --nocapture local_vs_deploy`.
#[test]
#[ignore = "requires wrangler dev running on :8821 + hits live deploy"]
fn local_vs_deploy_patch_counts_match() {
    let _ = env_logger::builder()
        .filter_module("hypen_renderer_desktop", log::LevelFilter::Info)
        .is_test(true)
        .try_init();

    let (local_before, local_after) = count_patches_for_url("ws://localhost:8821/ws");
    println!("LOCAL  before={local_before:?} after={local_after:?}");

    let (cf_before, cf_after) = count_patches_for_url(
        "wss://hypen-calorie-counter.ian-dae.workers.dev/ws",
    );
    println!("DEPLOY before={cf_before:?} after={cf_after:?}");

    let local_after_total: usize = local_after.iter().sum();
    let cf_after_total: usize = cf_after.iter().sum();

    // The two paths should deliver the same route-swap patches. A delta
    // here pins the bug to one specific path (local-only or deploy-only).
    let delta = local_after_total.abs_diff(cf_after_total);
    assert!(
        delta <= 5,
        "post-push patch totals differ: local={local_after_total} deploy={cf_after_total}. \
         If one is ~0 and the other is ~100, the bug is in that path's send/receive — \
         not in apply_patches.",
    );
}

/// Deeper than counts: compare the actual deserialized Patch values
/// between local wrangler-dev and live deploy. If they're structurally
/// equal, the desktop renderer has no way to behave differently for one
/// vs the other — the user-reported bug must be environmental
/// (cached binary, wrong URL typed, etc.) rather than CF-vs-local.
#[test]
#[ignore = "requires wrangler dev on :8821 + hits live deploy"]
fn local_vs_deploy_patches_are_structurally_identical() {
    let _ = env_logger::builder()
        .filter_module("hypen_renderer_desktop", log::LevelFilter::Info)
        .is_test(true)
        .try_init();

    let local = collect_post_push_patches("ws://localhost:8821/ws");
    let cf = collect_post_push_patches(
        "wss://hypen-calorie-counter.ian-dae.workers.dev/ws",
    );

    println!("local post-push patches: {}", local.len());
    println!("cf    post-push patches: {}", cf.len());

    // Compare every variant by tag-counting first — quickest discriminator.
    fn tag_counts(patches: &[hypen_engine::Patch]) -> std::collections::BTreeMap<&'static str, usize> {
        let mut counts = std::collections::BTreeMap::new();
        for p in patches {
            let tag = match p {
                hypen_engine::Patch::Create { .. } => "Create",
                hypen_engine::Patch::SetProp { .. } => "SetProp",
                hypen_engine::Patch::RemoveProp { .. } => "RemoveProp",
                hypen_engine::Patch::SetText { .. } => "SetText",
                hypen_engine::Patch::Insert { .. } => "Insert",
                hypen_engine::Patch::Move { .. } => "Move",
                hypen_engine::Patch::Remove { .. } => "Remove",
                hypen_engine::Patch::Detach { .. } => "Detach",
                hypen_engine::Patch::Attach { .. } => "Attach",
                hypen_engine::Patch::SetSemantics { .. } => "SetSemantics",
                hypen_engine::Patch::BatchAnimation { .. } => "BatchAnimation",
                hypen_engine::Patch::RegisterTemplate { .. } => "RegisterTemplate",
                hypen_engine::Patch::Instantiate { .. } => "Instantiate",
            };
            *counts.entry(tag).or_insert(0) += 1;
        }
        counts
    }

    let l_counts = tag_counts(&local);
    let c_counts = tag_counts(&cf);
    println!("local tag counts: {l_counts:?}");
    println!("cf    tag counts: {c_counts:?}");

    // Soft equality: at minimum the shape of operations is the same.
    assert_eq!(
        l_counts, c_counts,
        "patch-variant distributions differ between local wrangler-dev and deploy",
    );
}
