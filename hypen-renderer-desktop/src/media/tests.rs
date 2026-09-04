//! Headless tests for the `video` feature. Everything here degrades
//! to a skip-with-message when the sandbox has no working GStreamer
//! (missing plugins, init failure) — CI without media libs must not
//! fail, it just doesn't exercise playback.

use super::*;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Playback tests share the global event queue ([`take_events`]
/// drains it wholesale), so they serialise on this lock.
static TEST_LOCK: Mutex<()> = Mutex::new(());

fn lock_tests() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn gst_ready() -> bool {
    super::gst_pipeline::ensure_init().is_ok()
}

/// Build (once) a tiny H.264/MP4 fixture with videotestsrc. Returns
/// `None` when no usable encoder exists on this machine.
fn fixture_path() -> Option<PathBuf> {
    use std::sync::OnceLock;
    static FIXTURE: OnceLock<Option<PathBuf>> = OnceLock::new();
    FIXTURE
        .get_or_init(|| {
            let path = std::env::temp_dir().join(format!(
                "hypen_video_fixture_{}.mp4",
                std::process::id()
            ));
            build_fixture(&path).then_some(path)
        })
        .clone()
}

/// Encode 30 frames of 64×48 videotestsrc into an MP4 at `path`.
/// Tries H.264 encoders first (openh264enc / x264enc), then MPEG-4
/// part 2 (avenc_mpeg4) — any of them produces a progressive MP4 the
/// playback pipeline can decode via the installed plugin set.
fn build_fixture(path: &std::path::Path) -> bool {
    use gstreamer as gst;
    use gstreamer::prelude::*;

    let encoders: &[(&str, Option<&str>)] = &[
        ("openh264enc", Some("h264parse")),
        ("x264enc", Some("h264parse")),
        ("avenc_mpeg4", None),
    ];
    for (enc_name, parse_name) in encoders {
        let Ok(enc) = gst::ElementFactory::make(enc_name).build() else {
            continue;
        };
        let pipeline = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc")
            .property("num-buffers", 30i32)
            .build();
        let capsfilter = gst::ElementFactory::make("capsfilter").build();
        let convert = gst::ElementFactory::make("videoconvert").build();
        let mux = gst::ElementFactory::make("mp4mux").build();
        let sink = gst::ElementFactory::make("filesink").build();
        let (Ok(src), Ok(capsfilter), Ok(convert), Ok(mux), Ok(sink)) =
            (src, capsfilter, convert, mux, sink)
        else {
            continue;
        };
        capsfilter.set_property(
            "caps",
            gst::Caps::builder("video/x-raw")
                .field("width", 64i32)
                .field("height", 48i32)
                .field("framerate", gst::Fraction::new(30, 1))
                .build(),
        );
        sink.set_property("location", path.to_string_lossy().as_ref());
        let parse = parse_name.and_then(|p| gst::ElementFactory::make(p).build().ok());
        let mut chain: Vec<&gst::Element> = vec![&src, &capsfilter, &convert, &enc];
        if let Some(p) = parse.as_ref() {
            chain.push(p);
        }
        chain.push(&mux);
        chain.push(&sink);
        if pipeline.add_many(chain.iter().copied()).is_err()
            || gst::Element::link_many(chain.iter().copied()).is_err()
        {
            continue;
        }
        if pipeline.set_state(gst::State::Playing).is_err() {
            let _ = pipeline.set_state(gst::State::Null);
            continue;
        }
        let bus = pipeline.bus().expect("pipeline bus");
        let msg = bus.timed_pop_filtered(
            gst::ClockTime::from_seconds(20),
            &[gst::MessageType::Eos, gst::MessageType::Error],
        );
        let ok = matches!(msg.as_ref().map(|m| m.view()), Some(gst::MessageView::Eos(_)));
        let _ = pipeline.set_state(gst::State::Null);
        if ok && path.exists() {
            return true;
        }
    }
    false
}

fn poll_until<T>(timeout: Duration, mut f: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(v) = f() {
            return Some(v);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn muted_opts() -> PlayOpts {
    PlayOpts {
        muted: true,
        looping: false,
        headers: Vec::new(),
    }
}

#[test]
fn frames_arrive_from_local_fixture() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    let Some(fixture) = fixture_path() else {
        eprintln!("skipping: no usable MP4 encoder to build the fixture");
        return;
    };
    let node = "test-video-frames";
    start(node, fixture.to_str().unwrap(), 0, &muted_opts(), true)
        .expect("start playback of local fixture");
    let frame = poll_until(Duration::from_secs(15), || current_frame(node));
    let frame = frame.expect("a decoded RGBA frame should arrive within the timeout");
    assert_eq!(frame.width, 64);
    assert_eq!(frame.height, 48);
    assert_eq!(
        frame.data.len(),
        64 * 48 * 4,
        "frame bytes must be tightly packed RGBA"
    );
    assert!(has_playback(node));
    assert!(!is_paused(node), "autostarted playback reports playing");
    release(node);
    assert!(!has_playback(node));
}

#[test]
fn eos_surfaces_ended_event_and_marks_paused() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    let Some(fixture) = fixture_path() else {
        eprintln!("skipping: no usable MP4 encoder to build the fixture");
        return;
    };
    let node = "test-video-eos";
    let _ = take_events(); // drain stale events from other runs
    start(node, fixture.to_str().unwrap(), 0, &muted_opts(), true)
        .expect("start playback of local fixture");
    // 30 frames at 30 fps ≈ 1 s of media; allow generous slack for
    // preroll on a loaded CI box.
    let ended = poll_until(Duration::from_secs(20), || {
        take_events()
            .into_iter()
            .find(|e| e.node_id == node && matches!(e.kind, MediaEventKind::Ended))
    });
    assert!(ended.is_some(), "EOS should surface a MediaEventKind::Ended");
    assert!(
        is_paused(node),
        "an ended player reports paused so the painter overlays the play glyph"
    );
    release(node);
}

#[test]
fn missing_file_surfaces_error_event() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    let node = "test-video-missing";
    let _ = take_events();
    // A missing file may fail the state change synchronously (start
    // returns `Ok(false)` — the bus already queued the structured
    // error) or asynchronously (`Ok(true)`, error arrives later).
    // Either way exactly one Error event must surface.
    let started = start(
        node,
        "/tmp/__hypen_video_does_not_exist_xyz.mp4",
        0,
        &muted_opts(),
        true,
    )
    .expect("pipeline construction succeeds; the error surfaces via the bus");
    let _ = started;
    let err = poll_until(Duration::from_secs(15), || {
        take_events()
            .into_iter()
            .find(|e| e.node_id == node && matches!(e.kind, MediaEventKind::Error { .. }))
    });
    let Some(MediaEvent {
        kind: MediaEventKind::Error { code, message, status },
        ..
    }) = err
    else {
        panic!("a missing file should surface MediaEventKind::Error");
    };
    assert!(!message.is_empty());
    assert!(
        code.starts_with("resource/"),
        "missing file maps to a resource error, got {code}"
    );
    assert_eq!(status, None, "local file errors carry no HTTP status");
    release(node);
}

#[test]
fn toggle_pauses_and_resumes() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    let Some(fixture) = fixture_path() else {
        eprintln!("skipping: no usable MP4 encoder to build the fixture");
        return;
    };
    let node = "test-video-toggle";
    start(node, fixture.to_str().unwrap(), 0, &muted_opts(), true)
        .expect("start playback of local fixture");
    poll_until(Duration::from_secs(15), || current_frame(node))
        .expect("frame before toggling");
    assert_eq!(toggle(node), Some(false), "first toggle pauses");
    assert!(is_paused(node));
    assert_eq!(toggle(node), Some(true), "second toggle resumes");
    assert!(!is_paused(node));
    release(node);
    assert_eq!(toggle(node), None, "released node has nothing to toggle");
}

#[test]
fn suspend_pauses_playing_pipeline_and_resume_restores_it() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    let Some(fixture) = fixture_path() else {
        eprintln!("skipping: no usable MP4 encoder to build the fixture");
        return;
    };
    let node = "test-video-suspend";
    start(node, fixture.to_str().unwrap(), 0, &muted_opts(), true)
        .expect("start playback of local fixture");
    poll_until(Duration::from_secs(15), || current_frame(node))
        .expect("frame before suspending");

    assert!(set_suspended(node, true), "suspending a playing pipeline changes state");
    assert!(is_suspended(node));
    assert!(!is_paused(node), "suspension must not surface as user-facing pause");
    assert!(!set_suspended(node, true), "re-suspending is a no-op");

    assert!(set_suspended(node, false), "resuming a suspended pipeline changes state");
    assert!(!is_suspended(node));
    assert!(!set_suspended(node, false), "re-resuming is a no-op");
    release(node);
    assert!(!set_suspended("test-video-suspend", true), "released node has nothing to suspend");
}

#[test]
fn suspend_leaves_user_paused_player_paused_across_the_round_trip() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    let Some(fixture) = fixture_path() else {
        eprintln!("skipping: no usable MP4 encoder to build the fixture");
        return;
    };
    let node = "test-video-suspend-paused";
    start(node, fixture.to_str().unwrap(), 0, &muted_opts(), true)
        .expect("start playback of local fixture");
    poll_until(Duration::from_secs(15), || current_frame(node))
        .expect("frame before pausing");
    assert_eq!(toggle(node), Some(false), "user pauses");

    assert!(
        !set_suspended(node, true),
        "suspending a user-paused player changes no audible state"
    );
    assert!(is_suspended(node));
    assert!(
        !set_suspended(node, false),
        "resuming must not restart a player the user paused"
    );
    assert!(is_paused(node), "user-facing pause survives the detach/attach round trip");
    release(node);
}

#[test]
fn status_snapshot_reports_position_duration_and_frame_arrival() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    let Some(fixture) = fixture_path() else {
        eprintln!("skipping: no usable MP4 encoder to build the fixture");
        return;
    };
    let node = "test-video-status";
    assert!(status(node).is_none(), "no pipeline, no status");
    start(node, fixture.to_str().unwrap(), 0, &muted_opts(), true)
        .expect("start playback of local fixture");
    // Before the first frame the coarse buffering signal is `has_frame:
    // false` — that is exactly what `video_v2::player_state` maps to
    // `loading`.
    let ready = poll_until(Duration::from_secs(15), || {
        status(node).filter(|s| s.has_frame && s.duration > 0.0)
    })
    .expect("a prerolled, frame-producing pipeline");
    assert!(!ready.paused);
    assert!(!ready.ended);
    assert!(!ready.errored);
    assert!(!ready.suspended);
    assert!(ready.position >= 0.0);
    assert!(
        ready.duration > 0.0,
        "a progressive MP4 must answer a duration query"
    );
    assert_eq!(
        position_duration(node).map(|(_, d)| d > 0.0),
        Some(true),
        "the standalone accessor agrees with the snapshot"
    );
    release(node);
    assert!(position_duration(node).is_none());
}

#[test]
fn seek_moves_the_reported_position() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    let Some(fixture) = fixture_path() else {
        eprintln!("skipping: no usable MP4 encoder to build the fixture");
        return;
    };
    let node = "test-video-seek";
    assert!(!seek(node, 1.0), "a node with no pipeline cannot seek");
    // Preroll paused so playback can't race the seek past its target.
    start(node, fixture.to_str().unwrap(), 0, &muted_opts(), false)
        .expect("preroll the local fixture");
    let duration = poll_until(Duration::from_secs(15), || {
        status(node).map(|s| s.duration).filter(|d| *d > 0.0)
    })
    .expect("duration once prerolled");
    let target = duration * 0.5;
    assert!(seek(node, target), "seek issued");
    // KEY_UNIT (the flag the ended-restart and loop paths already use)
    // snaps to the nearest preceding keyframe, and the tiny fixture may
    // only carry one at t=0 — frame-accurate seeking is an explicit v2
    // non-goal. So the contract we assert is "never past the request".
    let after = poll_until(Duration::from_secs(10), || status(node)).expect("status after seek");
    assert!(
        after.position <= target + 0.1,
        "seek must not land past its target: {} > {target}",
        after.position
    );
    // Clamping: past the end pins to the duration, negative pins to 0 —
    // and neither is allowed to error the pipeline out.
    assert!(seek(node, duration * 10.0));
    assert!(seek(node, -5.0));
    let clamped = poll_until(Duration::from_secs(10), || status(node)).expect("status");
    assert!(!clamped.errored, "out-of-range seeks must stay quiet");
    assert!(
        clamped.position <= duration + 0.1,
        "position must stay within the media duration"
    );
    release(node);
}

#[test]
fn set_playing_drives_explicit_states_and_restarts_after_eos() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    let Some(fixture) = fixture_path() else {
        eprintln!("skipping: no usable MP4 encoder to build the fixture");
        return;
    };
    let node = "test-video-set-playing";
    assert_eq!(set_playing(node, true), None, "no pipeline, no state change");
    let _ = take_events();
    start(node, fixture.to_str().unwrap(), 0, &muted_opts(), true)
        .expect("start playback of local fixture");
    poll_until(Duration::from_secs(15), || current_frame(node)).expect("a frame");

    assert_eq!(set_playing(node, false), Some(false), "explicit pause");
    assert!(is_paused(node));
    // Idempotent: writing the state it is already in is a no-op, which
    // is what keeps the bind's echo from thrashing the pipeline.
    assert_eq!(set_playing(node, false), Some(false));
    assert_eq!(set_playing(node, true), Some(true), "explicit play");
    assert!(!is_paused(node));

    // Play after EOS restarts from zero per the spec.
    let ended = poll_until(Duration::from_secs(25), || {
        take_events()
            .into_iter()
            .find(|e| e.node_id == node && matches!(e.kind, MediaEventKind::Ended))
    });
    assert!(ended.is_some(), "the fixture should reach EOS");
    assert!(is_paused(node), "an ended player reads as paused");
    assert_eq!(
        set_playing(node, true),
        Some(true),
        "writing playing:true on an ended player restarts it"
    );
    assert!(!is_paused(node));
    release(node);
}

#[test]
fn broken_poster_does_not_error_a_live_pipeline() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    let Some(fixture) = fixture_path() else {
        eprintln!("skipping: no usable MP4 encoder to build the fixture");
        return;
    };
    let node_id = "test-video-poster-vs-pipeline";
    let poster = "https://cdn.example.com/__broken_poster_for_live_pipeline.jpg";
    crate::paint::image::test_seed_failure(poster, 404, "Not Found");
    start(node_id, fixture.to_str().unwrap(), 0, &muted_opts(), true)
        .expect("start playback of local fixture");
    poll_until(Duration::from_secs(15), || current_frame(node_id))
        .expect("a decoded frame before asserting the player state");
    let node = crate::tree::Node {
        id: node_id.to_string(),
        element_type: "Video".to_string(),
        props: [
            (
                "src".to_string(),
                serde_json::json!(fixture.to_str().unwrap()),
            ),
            ("poster".to_string(), serde_json::json!(poster)),
        ]
        .into_iter()
        .collect(),
        semantics: None,
    };
    // The live pipeline is authoritative: a failed POSTER fetch must not
    // flip a visibly playing player into the sticky `error` state (which
    // would overlay the error slot, hide controls, and report
    // state:"error" through the bind while audio keeps playing).
    assert_eq!(
        crate::video_v2::player_state(&node, crate::style::vp(800.0)),
        crate::video_v2::VideoPlayerState::Playing,
        "a broken poster must not override a live playing pipeline"
    );
    // Without a pipeline the same poster failure IS the error surface
    // (the feature-off / never-started contract state).
    release(node_id);
    assert_eq!(
        crate::video_v2::player_state(&node, crate::style::vp(800.0)),
        crate::video_v2::VideoPlayerState::Error,
        "with no pipeline the poster failure is the error state"
    );
}

// -----------------------------------------------------------------
// Pure helpers (no GStreamer runtime needed).
// -----------------------------------------------------------------

fn node_with(props: &[(&str, serde_json::Value)]) -> crate::tree::Node {
    crate::tree::Node {
        id: "n1".to_string(),
        element_type: "Video".to_string(),
        props: props
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
        semantics: None,
    }
}

#[test]
fn prop_truthy_accepts_bool_and_string_under_both_keys() {
    use serde_json::json;
    assert!(prop_truthy(&node_with(&[("autoplay", json!(true))]), "autoplay"));
    assert!(prop_truthy(&node_with(&[("autoplay.0", json!("true"))]), "autoplay"));
    assert!(!prop_truthy(&node_with(&[("autoplay", json!(false))]), "autoplay"));
    assert!(!prop_truthy(&node_with(&[("autoplay", json!("no"))]), "autoplay"));
    assert!(!prop_truthy(&node_with(&[]), "autoplay"));
}

#[test]
fn resolve_playlist_keeps_index_alignment() {
    use serde_json::json;
    let node = node_with(&[("playlist", json!(["https://cdn/a.mp4", "", "https://cdn/c.mp4"]))]);
    let list = resolve_playlist(&node);
    assert_eq!(list.len(), 3, "empty entries must NOT be filtered — indexes align");
    assert_eq!(list[2], "https://cdn/c.mp4");
}

#[test]
fn resolve_headers_reads_object_and_flattened_forms() {
    use serde_json::json;
    let obj = node_with(&[("headers", json!({"Authorization": "Bearer x"}))]);
    assert_eq!(
        resolve_headers(&obj),
        vec![("Authorization".to_string(), "Bearer x".to_string())]
    );
    let flat = node_with(&[("headers.X-Token", json!("t1"))]);
    assert_eq!(
        resolve_headers(&flat),
        vec![("X-Token".to_string(), "t1".to_string())]
    );
}

#[test]
fn play_opts_disable_single_src_loop_for_playlists() {
    use serde_json::json;
    let single = node_with(&[("loop", json!(true))]);
    assert!(resolve_play_opts(&single).looping);
    let queued = node_with(&[
        ("loop", json!(true)),
        ("playlist", json!(["https://cdn/a.mp4"])),
    ]);
    assert!(
        !resolve_play_opts(&queued).looping,
        "playlist wrap is queue-level (window), not a pipeline seek-loop"
    );
}

#[test]
fn http_status_extraction_ignores_codec_numbers_and_source_lines() {
    use super::gst_pipeline::extract_http_status;
    assert_eq!(extract_http_status("Not Found (404)"), Some(404));
    assert_eq!(extract_http_status("server returned 403, giving up"), Some(403));
    // Status-line echoes count as an explicit pattern.
    assert_eq!(extract_http_status("HTTP/1.1 403 Forbidden"), Some(403));
    assert_eq!(extract_http_status("got HTTP/2 502"), Some(502));
    assert_eq!(extract_http_status("status: 500"), Some(500));
    assert_eq!(extract_http_status("avdec_h264 failed to decode"), None);
    assert_eq!(extract_http_status("x264 stream corrupt"), None);
    assert_eq!(extract_http_status("error code 42"), None);
    assert_eq!(extract_http_status("retry after 1000 ms"), None);
    // C source-line references in GStreamer debug strings must not
    // read as statuses.
    assert_eq!(
        extract_http_status("gstfilesrc.c(553): gst_file_src_start (): No such file"),
        None
    );
}

#[test]
fn http_status_extraction_never_fabricates_from_url_path_segments() {
    use super::gst_pipeline::extract_http_status;
    // souphttpsrc embeds the stream URI in its error/debug text, and
    // DNS / IO / decode failures carry no HTTP status at all: a 4xx/5xx
    // number that is merely a CDN path segment (`/480/`, `/540/`) must
    // NOT surface as an `onError` status.
    for s in [
        "Could not open resource for reading and writing. URL: https://cdn.example.com/hls/480/clip.mp4",
        "Could not resolve server name. https://cdn.example.com/v/540/ep1.mp4",
        "Internal data stream error. gstsouphttpsrc.c(1509): reason error (-5), https://cdn/576/a.ts",
    ] {
        assert_eq!(
            extract_http_status(s),
            None,
            "no explicit status pattern in {s:?}"
        );
    }
    // A genuine souphttpsrc HTTP failure still reads its status even
    // when the same text embeds a decoy path segment.
    assert_eq!(
        extract_http_status("Not Found (404), URL: https://cdn.example.com/hls/480/clip.mp4"),
        Some(404)
    );
    assert_eq!(
        extract_http_status("https://cdn.example.com/500/x.mp4: server returned 503"),
        Some(503)
    );
}
