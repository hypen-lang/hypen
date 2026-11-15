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
            let path = std::env::temp_dir()
                .join(format!("hypen_video_fixture_{}.mp4", std::process::id()));
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
        let ok = matches!(
            msg.as_ref().map(|m| m.view()),
            Some(gst::MessageView::Eos(_))
        );
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
        restrict_sources: false,
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
    start(
        node,
        fixture.to_str().unwrap(),
        fixture.to_str().unwrap(),
        0,
        &muted_opts(),
        true,
    )
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
    start(
        node,
        fixture.to_str().unwrap(),
        fixture.to_str().unwrap(),
        0,
        &muted_opts(),
        true,
    )
    .expect("start playback of local fixture");
    // 30 frames at 30 fps ≈ 1 s of media; allow generous slack for
    // preroll on a loaded CI box.
    let ended = poll_until(Duration::from_secs(20), || {
        take_events()
            .into_iter()
            .find(|e| e.node_id == node && matches!(e.kind, MediaEventKind::Ended))
    });
    assert!(
        ended.is_some(),
        "EOS should surface a MediaEventKind::Ended"
    );
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
        kind:
            MediaEventKind::Error {
                code,
                message,
                status,
            },
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
    start(
        node,
        fixture.to_str().unwrap(),
        fixture.to_str().unwrap(),
        0,
        &muted_opts(),
        true,
    )
    .expect("start playback of local fixture");
    poll_until(Duration::from_secs(15), || current_frame(node)).expect("frame before toggling");
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
    start(
        node,
        fixture.to_str().unwrap(),
        fixture.to_str().unwrap(),
        0,
        &muted_opts(),
        true,
    )
    .expect("start playback of local fixture");
    poll_until(Duration::from_secs(15), || current_frame(node)).expect("frame before suspending");

    assert!(
        set_suspended(node, true),
        "suspending a playing pipeline changes state"
    );
    assert!(is_suspended(node));
    assert!(
        !is_paused(node),
        "suspension must not surface as user-facing pause"
    );
    assert!(!set_suspended(node, true), "re-suspending is a no-op");

    assert!(
        set_suspended(node, false),
        "resuming a suspended pipeline changes state"
    );
    assert!(!is_suspended(node));
    assert!(!set_suspended(node, false), "re-resuming is a no-op");
    release(node);
    assert!(
        !set_suspended("test-video-suspend", true),
        "released node has nothing to suspend"
    );
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
    start(
        node,
        fixture.to_str().unwrap(),
        fixture.to_str().unwrap(),
        0,
        &muted_opts(),
        true,
    )
    .expect("start playback of local fixture");
    poll_until(Duration::from_secs(15), || current_frame(node)).expect("frame before pausing");
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
    assert!(
        is_paused(node),
        "user-facing pause survives the detach/attach round trip"
    );
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
    start(
        node,
        fixture.to_str().unwrap(),
        fixture.to_str().unwrap(),
        0,
        &muted_opts(),
        true,
    )
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
    start(
        node,
        fixture.to_str().unwrap(),
        fixture.to_str().unwrap(),
        0,
        &muted_opts(),
        false,
    )
    .expect("preroll the local fixture");
    let duration = poll_until(Duration::from_secs(15), || {
        status(node).map(|s| s.duration).filter(|d| *d > 0.0)
    })
    .expect("duration once prerolled");
    let target = duration * 0.5;
    // The duration can be known (from the demuxer) a moment before the
    // pipeline finishes prerolling, and GStreamer refuses a flushing seek
    // until it has — on a loaded machine that moment is long enough to
    // see. Issue the seek once the pipeline accepts it.
    assert!(
        poll_until(Duration::from_secs(10), || seek(node, target).then_some(())).is_some(),
        "seek issued"
    );
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
    assert_eq!(
        set_playing(node, true),
        None,
        "no pipeline, no state change"
    );
    let _ = take_events();
    start(
        node,
        fixture.to_str().unwrap(),
        fixture.to_str().unwrap(),
        0,
        &muted_opts(),
        true,
    )
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
    start(
        node_id,
        fixture.to_str().unwrap(),
        fixture.to_str().unwrap(),
        0,
        &muted_opts(),
        true,
    )
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
    // Without a pipeline the poster failure still doesn't error a
    // PLAYABLE track: the poster just doesn't show and a click plays
    // (state and click agree). Only a poster with no playable track
    // behind it reads `error`.
    release(node_id);
    assert_eq!(
        crate::video_v2::player_state(&node, crate::style::vp(800.0)),
        crate::video_v2::VideoPlayerState::Idle,
        "with no pipeline a playable track behind a broken poster is idle"
    );
    let mut poster_only = node.clone();
    poster_only.props.remove("src");
    assert_eq!(
        crate::video_v2::player_state(&poster_only, crate::style::vp(800.0)),
        crate::video_v2::VideoPlayerState::Error,
        "a poster-only element's poster failure is the error state"
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
    assert!(prop_truthy(
        &node_with(&[("autoplay", json!(true))]),
        "autoplay"
    ));
    assert!(prop_truthy(
        &node_with(&[("autoplay.0", json!("true"))]),
        "autoplay"
    ));
    assert!(!prop_truthy(
        &node_with(&[("autoplay", json!(false))]),
        "autoplay"
    ));
    assert!(!prop_truthy(
        &node_with(&[("autoplay", json!("no"))]),
        "autoplay"
    ));
    assert!(!prop_truthy(&node_with(&[]), "autoplay"));
}

#[test]
fn resolve_playlist_keeps_index_alignment() {
    use serde_json::json;
    let node = node_with(&[(
        "playlist",
        json!(["https://cdn/a.mp4", "", "https://cdn/c.mp4"]),
    )]);
    let list = resolve_playlist(&node);
    assert_eq!(
        list.len(),
        3,
        "empty entries must NOT be filtered — indexes align"
    );
    assert_eq!(list[2].url(), Some("https://cdn/c.mp4"));
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
    assert_eq!(
        extract_http_status("server returned 403, giving up"),
        Some(403)
    );
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

// ---------------------------------------------------------------------------
// Remote-content source restriction (a remote app's HLS / DASH manifest
// must not be able to name `file://` segments, keys or playlists).
// ---------------------------------------------------------------------------

fn restricted_opts() -> PlayOpts {
    PlayOpts {
        restrict_sources: true,
        ..muted_opts()
    }
}

#[test]
fn remote_media_uri_policy_allows_only_http_and_data() {
    use super::gst_pipeline::remote_media_uri_allowed;
    for ok in [
        "http://a.test/x.m3u8",
        "HTTPS://a.test/seg.ts",
        "data:application/x-mpegurl;base64,AAAA",
    ] {
        assert!(remote_media_uri_allowed(ok), "{ok}");
    }
    for refused in [
        "file:///etc/passwd",
        "FILE:///etc/passwd",
        "/etc/passwd",
        "C:\\secret.ts",
        "smb://host/share/x.ts",
        "rtsp://cam/stream",
        "",
    ] {
        assert!(!remote_media_uri_allowed(refused), "{refused}");
    }
}

/// A node stamped with a remote app's asset origin plays with
/// `restrict_sources`; a local app's node does not.
#[test]
fn play_opts_restrict_a_remote_apps_node_only() {
    use crate::paint::image::ASSET_ORIGIN_PROP;
    use serde_json::json;
    assert!(!resolve_play_opts(&node_with(&[("src", json!("/a.mp4"))])).restrict_sources);
    assert!(
        resolve_play_opts(&node_with(&[
            ("src", json!("/a.mp4")),
            (ASSET_ORIGIN_PROP, json!("http://a.test")),
        ]))
        .restrict_sources
    );
}

#[test]
fn restricted_pipeline_refuses_a_local_top_level_uri() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    let shared = PlayerShared::new;
    for uri in ["file:///etc/hosts", "/etc/hosts"] {
        let err = super::gst_pipeline::build(
            "test-video-restrict-top",
            uri,
            &restricted_opts(),
            shared(),
        )
        .expect_err("a restricted pipeline must not open a local file");
        assert!(err.contains("refusing"), "{err}");
    }
}

/// The HLS / DASH case: playbin with an allowed manifest URL, whose
/// demuxer then adds a source element for a segment URI the manifest
/// names. Simulated by adding a bin holding a `filesrc` below playbin
/// (exactly how `adaptivedemux` nests its fragment sources): in a
/// restricted pipeline it is locked in `NULL` (never opens the file)
/// and the node gets a `resource/NotAuthorized` error; an allowed
/// `data:` source and an unrestricted pipeline's `filesrc` are left
/// alone.
#[test]
fn restricted_pipeline_refuses_a_nested_local_segment_source() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    use gstreamer as gst;
    let shared = PlayerShared::new;
    let secret = std::env::temp_dir().join(format!("hypen_secret_{}.ts", std::process::id()));
    std::fs::write(&secret, b"secret").unwrap();
    let file_uri = gst::glib::filename_to_uri(&secret, None)
        .unwrap()
        .to_string();

    // A demuxer-style nested bin: [bin [filesrc]] or [bin [dataurisrc]].
    let nested = |factory: &str, uri: &str| {
        let bin = gst::Bin::new();
        let src = gst::Element::make_from_uri(gst::URIType::Src, uri, None)
            .unwrap_or_else(|e| panic!("{factory} for {uri}: {e}"));
        assert_eq!(src.factory().unwrap().name(), factory);
        bin.add(&src).unwrap();
        (bin, src)
    };

    let _ = take_events();
    let node = "test-video-restrict-nested";
    let playbin = match super::gst_pipeline::build(
        node,
        "http://127.0.0.1:9/manifest.m3u8",
        &restricted_opts(),
        shared(),
    ) {
        Ok(p) => p,
        Err(e) if e.contains("playbin unavailable") => {
            eprintln!("skipping: {e}");
            return;
        }
        Err(e) => panic!("{e}"),
    };
    let playbin = playbin.downcast::<gst::Bin>().expect("playbin is a bin");

    let (data_bin, data_src) = nested("dataurisrc", "data:,hello");
    playbin.add(&data_bin).unwrap();
    assert!(!data_src.is_locked_state(), "an allowed data: source runs");

    let (file_bin, file_src) = nested("filesrc", &file_uri);
    playbin.add(&file_bin).unwrap();
    assert!(
        file_src.is_locked_state(),
        "a file: segment source in a remote pipeline must never leave NULL"
    );
    let err = take_events().into_iter().find_map(|e| match e.kind {
        MediaEventKind::Error { code, .. } if e.node_id == node => Some(code),
        _ => None,
    });
    assert_eq!(err.as_deref(), Some("resource/NotAuthorized"));
    // Even when the bin is driven, the locked source stays put.
    let _ = file_bin.set_state(gst::State::Paused);
    assert_eq!(file_src.current_state(), gst::State::Null);
    let _ = file_bin.set_state(gst::State::Null);
    let _ = playbin.set_state(gst::State::Null);

    // A local app's pipeline is not restricted: same nested filesrc runs.
    let local = super::gst_pipeline::build(
        "test-video-unrestricted-nested",
        "http://127.0.0.1:9/manifest.m3u8",
        &muted_opts(),
        shared(),
    )
    .unwrap()
    .downcast::<gst::Bin>()
    .unwrap();
    let (local_bin, local_src) = nested("filesrc", &file_uri);
    local.add(&local_bin).unwrap();
    assert!(!local_src.is_locked_state());
    let _ = local.set_state(gst::State::Null);
    let _ = std::fs::remove_file(&secret);
}

/// The legacy `adaptivedemux` demuxers fetch playlists and keys through
/// a downloader no signal can see, so a restricted pipeline refuses
/// them outright (decodebin never plugs them — see the end-to-end test
/// below — and one that got in anyway is locked and errored).
/// Skipped where gst-plugins-bad isn't installed.
#[test]
fn restricted_pipeline_refuses_legacy_adaptive_demuxers() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    use gstreamer as gst;
    let pipeline: gst::Element = gst::Pipeline::new().upcast();
    let mut ran = false;
    for name in ["hlsdemux", "dashdemux", "mssdemux"] {
        let Ok(demux) = gst::ElementFactory::make(name).build() else {
            continue;
        };
        ran = true;
        assert!(
            !super::gst_pipeline::guard_remote_element(&pipeline, &demux),
            "{name}"
        );
        assert!(demux.is_locked_state(), "{name}");
    }
    // Their adaptivedemux2 successors are fine.
    for name in ["hlsdemux2", "dashdemux2"] {
        if let Ok(demux) = gst::ElementFactory::make(name).build() {
            assert!(super::gst_pipeline::guard_remote_element(&pipeline, &demux));
        }
    }
    if !ran {
        eprintln!("skipping: no legacy adaptive demuxer installed (gst-plugins-bad)");
    }
}

/// Count GStreamer-CRITICALs (`g_return_if_fail` failures) logged while
/// `f` runs.
fn gst_criticals_during(f: impl FnOnce()) -> usize {
    use gstreamer::glib;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let count = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&count);
    let handler = glib::log_set_handler(
        Some("GStreamer"),
        glib::LogLevels::LEVEL_CRITICAL,
        false,
        false,
        move |_, _, message| {
            eprintln!("GStreamer-CRITICAL: {message}");
            seen.fetch_add(1, Ordering::SeqCst);
        },
    );
    f();
    glib::log_remove_handler(Some("GStreamer"), handler);
    count.load(Ordering::SeqCst)
}

/// A legacy adaptive demuxer the guard starved must consume what it is
/// fed cleanly: the starving probe takes ownership of every buffer, so
/// GStreamer must not be told to drop (and unref) it a second time —
/// that logged `gst_mini_object_unref: assertion 'mini_object != NULL'`
/// at the manifest's EOS. Skipped where gst-plugins-bad isn't installed.
#[test]
fn starved_legacy_demuxer_consumes_its_manifest_without_criticals() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    use gstreamer as gst;
    let pipeline: gst::Element = gst::Pipeline::new().upcast();
    let mut ran = false;
    for (name, caps) in [
        ("hlsdemux", "application/x-hls"),
        ("dashdemux", "application/dash+xml"),
        ("mssdemux", "application/vnd.ms-sstr+xml"),
    ] {
        let Ok(demux) = gst::ElementFactory::make(name).build() else {
            continue;
        };
        ran = true;
        assert!(!super::gst_pipeline::guard_remote_element(
            &pipeline, &demux
        ));
        let criticals = gst_criticals_during(|| {
            let sink = demux.static_pad("sink").expect("demuxer sink pad");
            let src = gst::Pad::builder(gst::PadDirection::Src).build();
            src.set_active(true).unwrap();
            src.link(&sink).unwrap();
            demux.set_state(gst::State::Paused).unwrap();
            assert!(src.push_event(gst::event::StreamStart::new("manifest")));
            assert!(
                src.push_event(gst::event::Caps::new(&gst::Caps::new_empty_simple(caps))),
                "{name}: caps {caps}"
            );
            let _ = src.push_event(gst::event::Segment::new(&gst::FormattedSegment::<
                gst::format::Bytes,
            >::new()));
            let pushed = src.push(gst::Buffer::from_slice(
                b"#EXTM3U\n#EXTINF:1.0,\nfile:///etc/passwd\n".to_vec(),
            ));
            assert!(pushed.is_ok(), "{name}: starved buffer push: {pushed:?}");
            let mut list = gst::BufferList::new();
            list.get_mut()
                .unwrap()
                .add(gst::Buffer::from_slice(b"#EXT-X-ENDLIST\n".to_vec()));
            let _ = src.push_list(list);
            let _ = src.push_event(gst::event::Eos::new());
            let _ = demux.set_state(gst::State::Null);
        });
        assert_eq!(criticals, 0, "{name}: GStreamer-CRITICAL while starved");
    }
    let _ = take_events();
    if !ran {
        eprintln!("skipping: no legacy adaptive demuxer installed (gst-plugins-bad)");
    }
}

/// The manifest scan behind the HTTP-only demuxers' refusal: any
/// absolute non-HTTP URI, wherever the manifest names it, is reported;
/// relative references and http(s) / data: URIs are fine.
#[test]
fn manifest_scan_finds_non_http_uris() {
    use super::gst_pipeline::manifest_refused_uri;
    let ok = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n\
              #EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00Z\n\
              #EXT-X-KEY:METHOD=AES-128,URI=\"https://k.test/key\"\n\
              #EXTINF:1.0,\nseg0.ts\n#EXTINF:1.0,\nhttp://cdn.test/seg1.ts\n#EXT-X-ENDLIST\n";
    assert_eq!(manifest_refused_uri(ok), None);
    let mpd = r#"<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" profiles="urn:mpeg:dash:profile:isoff-live:2011">
        <BaseURL>https://cdn.test/</BaseURL><SegmentTemplate media="$Number$.m4s"/></MPD>"#;
    assert_eq!(manifest_refused_uri(mpd), None);

    assert_eq!(
        manifest_refused_uri("#EXTM3U\n#EXTINF:1.0,\nfile:///tmp/seg.ts\n").as_deref(),
        Some("file:///tmp/seg.ts")
    );
    assert_eq!(
        manifest_refused_uri("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"FILE:/etc/key\"\n")
            .as_deref(),
        Some("FILE:/etc/key")
    );
    assert_eq!(
        manifest_refused_uri("<MPD><BaseURL>smb://share/x/</BaseURL></MPD>").as_deref(),
        Some("smb://share/x/")
    );
    assert_eq!(
        manifest_refused_uri("<S media=\"rtsp://h/x\"/>").as_deref(),
        Some("rtsp://h/x")
    );
}

/// Comments are not URIs anything opens (an encoder's provenance note
/// must not refuse a playable stream); XML character references ARE
/// decoded, as the demuxer's XML parser would, so `file&#58;//` cannot
/// slip past; a UTF-16 MPD is scanned like a UTF-8 one.
#[test]
fn manifest_scan_ignores_comments_and_decodes_what_the_demuxer_decodes() {
    use super::gst_pipeline::{manifest_refused_uri, manifest_text};
    let mpd_comment = r#"<?xml version="1.0"?>
        <!-- Generated from file:///home/encoder/master.mov -->
        <MPD><BaseURL>https://cdn.test/</BaseURL></MPD>"#;
    assert_eq!(manifest_refused_uri(mpd_comment), None);
    let hls_comment = "#EXTM3U\n# packaged from file:///srv/in.mp4\n#EXTINF:1.0,\nseg0.ts\n";
    assert_eq!(manifest_refused_uri(hls_comment), None);
    // A tag line is not a comment.
    assert_eq!(
        manifest_refused_uri("#EXTM3U\n#EXT-X-MAP:URI=\"file:///etc/init.mp4\"\n").as_deref(),
        Some("file:///etc/init.mp4")
    );
    assert_eq!(
        manifest_refused_uri("<MPD><BaseURL>file&#58;///etc/</BaseURL></MPD>").as_deref(),
        Some("file:///etc/")
    );
    assert_eq!(
        manifest_refused_uri("<MPD><BaseURL>&#x66;ile://h/x/</BaseURL></MPD>").as_deref(),
        Some("file://h/x/")
    );
    // A comment that never closes hides nothing after it… and nothing
    // the demuxer would read either (the XML is malformed).
    assert_eq!(
        manifest_refused_uri("<MPD><!-- <BaseURL>smb://x/</BaseURL>"),
        None
    );

    let mpd = "<MPD><BaseURL>smb://share/x/</BaseURL></MPD>";
    let mut utf16 = vec![0xFF, 0xFE];
    utf16.extend(mpd.encode_utf16().flat_map(u16::to_le_bytes));
    assert_eq!(
        manifest_refused_uri(&manifest_text(&utf16)).as_deref(),
        Some("smb://share/x/")
    );
}

/// Feed a guarded, standalone `hlsdemux2` a manifest as ONE buffer list
/// of `chunks`, and return the debug text of the `resource/NotAuthorized`
/// refusal posted within 5 s (`Some(None)` when none was). `None` when
/// hlsdemux2 is not installed.
fn push_manifest_list_to_guarded_hlsdemux2(chunks: Vec<Vec<u8>>) -> Option<Option<String>> {
    use gstreamer as gst;
    let Ok(demux) = gst::ElementFactory::make("hlsdemux2").build() else {
        eprintln!("skipping: hlsdemux2 is not installed");
        return None;
    };
    let pipeline = gst::Pipeline::new();
    pipeline.add(&demux).unwrap();
    let pipeline_el: gst::Element = pipeline.clone().upcast();
    assert!(super::gst_pipeline::guard_remote_element(
        &pipeline_el,
        &demux
    ));
    let bus = pipeline.bus().unwrap();
    let sink = demux.static_pad("sink").expect("demuxer sink pad");
    let src = gst::Pad::builder(gst::PadDirection::Src).build();
    src.set_active(true).unwrap();
    src.link(&sink).unwrap();
    // Only the probe on the sink pad is under test: activate the pad
    // rather than bring the whole demuxer up (it will not leave NULL
    // without a scheduler of its own).
    if demux.set_state(gst::State::Paused).is_err() {
        sink.set_active(true).unwrap();
    }
    assert!(src.push_event(gst::event::StreamStart::new("manifest")));
    let _ = src.push_event(gst::event::Caps::new(&gst::Caps::new_empty_simple(
        "application/x-hls",
    )));
    let _ = src.push_event(gst::event::Segment::new(&gst::FormattedSegment::<
        gst::format::Bytes,
    >::new()));
    let mut list = gst::BufferList::new();
    {
        let list = list.get_mut().unwrap();
        for chunk in chunks {
            list.add(gst::Buffer::from_slice(chunk));
        }
    }
    let _ = src.push_list(list);
    let _ = src.push_event(gst::event::Eos::new());
    // (A standalone demuxer posts its own "requires a streams-aware
    // context" error on the state change; look past it.)
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut refusal = None;
    while refusal.is_none() && Instant::now() < deadline {
        let Some(msg) = bus.timed_pop_filtered(
            gst::ClockTime::from_mseconds(100),
            &[gst::MessageType::Error],
        ) else {
            continue;
        };
        if let gst::MessageView::Error(err) = msg.view() {
            if err.error().matches(gst::ResourceError::NotAuthorized) {
                refusal = Some(err.debug().map(|d| d.to_string()).unwrap_or_default());
            }
        }
    }
    let _ = demux.set_state(gst::State::Null);
    Some(refusal)
}

/// The HTTP-only demuxer's manifest scan sees a manifest however it
/// arrives — here as a buffer LIST — withholds its EOS, and posts the
/// refusal on the pipeline.
#[test]
fn http_only_demuxer_scan_refuses_a_manifest_pushed_as_a_buffer_list() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    let Some(refusal) = push_manifest_list_to_guarded_hlsdemux2(vec![
        b"#EXTM3U\n#EXT-X-TARGETDURATION:2\n".to_vec(),
        b"#EXTINF:1.0,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n".to_vec(),
    ]) else {
        return;
    };
    let debug = refusal.expect("the refused manifest must post resource/NotAuthorized");
    assert!(debug.contains("file:///etc/passwd"), "{debug}");
}

/// A pad without a chain-list function (adaptivedemux2's) hands a buffer
/// list on one buffer at a time — through the scan's BUFFER probe AGAIN
/// after its BUFFER_LIST probe saw the whole list. Each byte must count
/// once: a 2.5 MiB manifest (under the 4 MiB scan limit) pushed as a list
/// is scanned and refused, not double-counted past the limit and waved
/// through unscanned.
#[test]
fn http_only_demuxer_scan_counts_a_buffer_list_once() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    let mut padding = b"#EXTM3U\n#EXT-X-TARGETDURATION:2\n#".to_vec();
    padding.extend(std::iter::repeat(b'x').take(5 << 19)); // 2.5 MiB
    padding.push(b'\n');
    let Some(refusal) = push_manifest_list_to_guarded_hlsdemux2(vec![
        padding,
        b"#EXTINF:1.0,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n".to_vec(),
    ]) else {
        return;
    };
    let debug = refusal.expect("a 2.5 MiB manifest list must still be scanned and refused");
    assert!(debug.contains("file:///etc/passwd"), "{debug}");
}

/// The stall watchdog's clock: armed only once the manifest is accepted,
/// any sign of life restarts the wait.
#[test]
fn stall_watch_counts_silence_from_the_last_sign_of_life() {
    let w = super::gst_pipeline::StallWatch::new();
    let short = Duration::from_millis(30);
    std::thread::sleep(Duration::from_millis(60));
    assert!(
        !w.stalled(short),
        "not armed before the manifest is accepted"
    );
    w.progress();
    assert!(!w.stalled(short));
    std::thread::sleep(Duration::from_millis(60));
    assert!(w.stalled(short));
    w.progress();
    assert!(!w.stalled(short), "media arriving restarts the wait");
}

/// Encode 30 frames into an MPEG-TS segment at `path` (an HLS segment).
fn build_ts_segment(path: &std::path::Path) -> bool {
    use gstreamer as gst;
    let desc = format!(
        "videotestsrc num-buffers=30 ! video/x-raw,width=64,height=48,framerate=30/1 \
         ! videoconvert ! openh264enc ! h264parse ! mpegtsmux ! filesink location={}",
        path.display()
    );
    let Ok(pipeline) = gst::parse::launch(&desc) else {
        return false;
    };
    if pipeline.set_state(gst::State::Playing).is_err() {
        let _ = pipeline.set_state(gst::State::Null);
        return false;
    }
    let msg = pipeline.bus().expect("bus").timed_pop_filtered(
        gst::ClockTime::from_seconds(20),
        &[gst::MessageType::Eos, gst::MessageType::Error],
    );
    let ok = matches!(
        msg.as_ref().map(|m| m.view()),
        Some(gst::MessageView::Eos(_))
    );
    let _ = pipeline.set_state(gst::State::Null);
    ok && path.exists()
}

/// Serve `files` (`(path, content type, body)`) over HTTP/1.1 on an
/// ephemeral localhost port until the process exits; 404 otherwise.
fn serve(files: Vec<(String, &'static str, Vec<u8>)>) -> u16 {
    serve_gated(files, None)
}

/// A gate a test opens to release the responses [`serve_gated`] holds.
type Gate = Arc<(Mutex<bool>, std::sync::Condvar)>;

fn open_gate(gate: &Gate) {
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
}

/// [`serve`], one thread per connection (a held response never blocks
/// another request), where a request for `gated.0` is answered only
/// once the test opens `gated.1` (or after 30 s).
fn serve_gated(files: Vec<(String, &'static str, Vec<u8>)>, gated: Option<(String, Gate)>) -> u16 {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let files = Arc::new(files);
    let gated = Arc::new(gated);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let files = Arc::clone(&files);
            let gated = Arc::clone(&gated);
            std::thread::spawn(move || {
                let mut request_line = String::new();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let _ = reader.read_line(&mut request_line);
                // Drain the headers.
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let path = request_line.split_whitespace().nth(1).unwrap_or("/");
                let path = path.split('?').next().unwrap_or(path);
                if let Some((gated_path, gate)) = gated.as_ref() {
                    if gated_path == path {
                        let (open, cvar) = &**gate;
                        let guard = open.lock().unwrap();
                        let _ = cvar.wait_timeout_while(guard, Duration::from_secs(30), |o| !*o);
                    }
                }
                match files.iter().find(|(p, _, _)| p == path) {
                    Some((_, mime, body)) => {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\n\
                             Connection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(body);
                    }
                    None => {
                        let _ = stream.write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                    }
                }
            });
        }
    });
    port
}

fn serve_manifest(body: String) -> u16 {
    serve(vec![(
        "/live.m3u8".to_string(),
        "application/vnd.apple.mpegurl",
        body.into_bytes(),
    )])
}

/// End to end, with real demuxers: an HLS manifest served over HTTP
/// whose only segment is a `file://` URI. With the legacy `hlsdemux`
/// a local app's pipeline really plays the local segment (the attack
/// path); a remote app's (restricted, `playbin3`) pipeline must produce
/// no frame. With `hlsdemux2` (the default) the demuxer refuses the
/// `file://` URI itself and the stream stalls; with only the legacy
/// demuxer, it is starved and refused (`resource/NotAuthorized`).
/// Exercises whichever HLS demuxer the registry ranks first; force the
/// legacy one with `GST_PLUGIN_FEATURE_RANK=hlsdemux2:NONE` (rank
/// changes made at runtime don't reach decodebin's factory cache).
/// Skipped without souphttpsrc / an HLS demuxer / an H.264 encoder.
#[test]
fn remote_hls_manifest_cannot_reach_a_local_segment() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    use gstreamer as gst;
    let registry = gst::Registry::get();
    let have = |name: &str| {
        registry
            .find_feature(name, gst::ElementFactory::static_type())
            .filter(|f| f.rank() > gst::Rank::NONE)
    };
    if have("souphttpsrc").is_none() || (have("hlsdemux").is_none() && have("hlsdemux2").is_none())
    {
        eprintln!("skipping: souphttpsrc or an HLS demuxer is not installed");
        return;
    }
    let segment = std::env::temp_dir().join(format!("hypen_local_seg_{}.ts", std::process::id()));
    if !build_ts_segment(&segment) {
        eprintln!("skipping: cannot encode an MPEG-TS segment here");
        return;
    }
    let seg_uri = gst::glib::filename_to_uri(&segment, None).unwrap();
    let port = serve_manifest(format!(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n\
         #EXTINF:1.0,\n{seg_uri}\n#EXT-X-ENDLIST\n"
    ));
    let manifest = format!("http://127.0.0.1:{port}/live.m3u8");
    let run = |node: &str, opts: &PlayOpts| {
        let _ = take_events();
        let started = start(node, &manifest, &manifest, 0, opts, true);
        let frame = started
            .as_ref()
            .ok()
            .and_then(|_| poll_until(Duration::from_secs(8), || current_frame(node)));
        let events = take_events();
        release(node);
        let err = events.into_iter().find_map(|e| match e.kind {
            MediaEventKind::Error { code, .. } if e.node_id == node => Some(code),
            _ => None,
        });
        (frame.is_some(), err)
    };
    // Is decoding the segment possible at all here? (Played directly,
    // as a local file.) Without that, neither run below means anything.
    let (direct_frame, _) = {
        let seg = segment.to_str().unwrap().to_string();
        let _ = take_events();
        let started = start("test-hls-direct", &seg, &seg, 0, &muted_opts(), true);
        let frame = started
            .as_ref()
            .ok()
            .and_then(|_| poll_until(Duration::from_secs(8), || current_frame("test-hls-direct")));
        let _ = take_events();
        release("test-hls-direct");
        (frame.is_some(), ())
    };
    if !direct_frame {
        let _ = std::fs::remove_file(&segment);
        eprintln!("skipping: GStreamer cannot play the MPEG-TS segment here (no H.264 decoder?)");
        return;
    }
    let (local_frame, local_err) = run("test-hls-local", &muted_opts());
    let (remote_frame, remote_err) = run("test-hls-remote", &restricted_opts());
    let _ = std::fs::remove_file(&segment);
    eprintln!(
        "hls: legacy hlsdemux ranked {:?}, hlsdemux2 {:?}; local: frame={local_frame} \
         err={local_err:?}; remote: frame={remote_frame} err={remote_err:?}",
        have("hlsdemux").map(|f| f.rank()),
        have("hlsdemux2").map(|f| f.rank()),
    );
    // The control: a local app's (unrestricted `playbin`) pipeline plays
    // the manifest's `file://` segment through the legacy `hlsdemux` —
    // the attack path the restriction exists for. Only `hlsdemux` can
    // demux HLS under `playbin`, so without it there is no control.
    if have("hlsdemux").is_some() {
        assert!(
            local_frame,
            "control: a local pipeline must play the manifest's segment (err {local_err:?})"
        );
    } else {
        eprintln!("no control run: the legacy hlsdemux (gst-plugins-bad) is not installed");
    }
    assert!(
        !remote_frame,
        "a remote app's HLS manifest played a file:// segment"
    );
    // And the refusal is surfaced, never a silent stall: refused by the
    // guard (the legacy demuxer: never plugged under playbin → missing
    // plugin; starved under playbin3) or, with `hlsdemux2`, by the
    // manifest scan / refusal backstop — `resource/NotAuthorized`.
    let code = remote_err.expect("a refused HLS segment must report onError, not stall");
    assert!(
        matches!(
            code.as_str(),
            "core/MissingPlugin" | "resource/NotAuthorized"
        ),
        "{code}"
    );
}

/// `hlsdemux2` downloads VARIANT playlists itself (never through a pad
/// the manifest scan sees), and refuses a `file://` segment one names
/// without posting anything — the stall watchdog must still turn that
/// into `onError` (`resource/NotAuthorized`) instead of a stall. (Run
/// with a short watchdog timeout; the real one only adds waiting.)
/// Skipped without souphttpsrc / hlsdemux2 / an H.264 encoder.
#[test]
fn remote_hls_variant_naming_a_local_segment_reports_onerror() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    use gstreamer as gst;
    let registry = gst::Registry::get();
    let have = |name: &str| {
        registry
            .find_feature(name, gst::ElementFactory::static_type())
            .is_some_and(|f| f.rank() > gst::Rank::NONE)
    };
    if !have("souphttpsrc") || !have("hlsdemux2") {
        eprintln!("skipping: souphttpsrc or hlsdemux2 is not installed");
        return;
    }
    let segment = std::env::temp_dir().join(format!("hypen_variant_seg_{}.ts", std::process::id()));
    if !build_ts_segment(&segment) {
        eprintln!("skipping: cannot encode an MPEG-TS segment here");
        return;
    }
    let seg_uri = gst::glib::filename_to_uri(&segment, None).unwrap();
    let port = serve(vec![
        (
            "/master.m3u8".to_string(),
            "application/vnd.apple.mpegurl",
            b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=64x48\nv.m3u8\n".to_vec(),
        ),
        (
            "/v.m3u8".to_string(),
            "application/vnd.apple.mpegurl",
            format!(
                "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n\
                 #EXTINF:1.0,\n{seg_uri}\n#EXT-X-ENDLIST\n"
            )
            .into_bytes(),
        ),
    ]);
    let url = format!("http://127.0.0.1:{port}/master.m3u8");
    let node = "test-hls-variant-remote";
    let _ = take_events();
    super::gst_pipeline::ADAPTIVE_STALL_TIMEOUT_MS_OVERRIDE
        .store(2_000, std::sync::atomic::Ordering::SeqCst);
    start(node, &url, &url, 0, &restricted_opts(), true).expect("start");
    let err = poll_until(Duration::from_secs(15), || {
        crate::media::status(node).filter(|s| s.errored).map(|_| ())
    });
    super::gst_pipeline::ADAPTIVE_STALL_TIMEOUT_MS_OVERRIDE
        .store(0, std::sync::atomic::Ordering::SeqCst);
    let frame = current_frame(node);
    let events = take_events();
    release(node);
    let _ = std::fs::remove_file(&segment);
    assert!(
        frame.is_none(),
        "a remote app's variant played a file:// segment"
    );
    assert!(
        err.is_some(),
        "the refused variant segment stalled without onError"
    );
    let code = events.into_iter().find_map(|e| match e.kind {
        MediaEventKind::Error { code, .. } if e.node_id == node => Some(code),
        _ => None,
    });
    assert_eq!(code.as_deref(), Some("resource/NotAuthorized"));
}

/// A remote app's media still plays: progressive MP4 and an HLS stream
/// whose segment is on the server, both over HTTP, through the
/// restricted (`playbin3`) pipeline — HLS via the HTTP-only
/// `hlsdemux2`. Skipped without souphttpsrc / an encoder / hlsdemux2.
#[test]
fn restricted_pipeline_plays_http_mp4_and_hls() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    use gstreamer as gst;
    let registry = gst::Registry::get();
    let have = |name: &str| {
        registry
            .find_feature(name, gst::ElementFactory::static_type())
            .is_some_and(|f| f.rank() > gst::Rank::NONE)
    };
    if !have("souphttpsrc") {
        eprintln!("skipping: souphttpsrc not installed");
        return;
    }
    let Some(fixture) = fixture_path() else {
        eprintln!("skipping: no usable MP4 encoder to build the fixture");
        return;
    };
    let mut files = vec![(
        "/clip.mp4".to_string(),
        "video/mp4",
        std::fs::read(&fixture).unwrap(),
    )];
    let segment = std::env::temp_dir().join(format!("hypen_http_seg_{}.ts", std::process::id()));
    let hls = have("hlsdemux2") && build_ts_segment(&segment);
    if hls {
        // ONE segment, served at once: the shape that hits GStreamer
        // 1.24 adaptivedemux2's unexposed-pad EOS race when the demuxer's
        // output thread is scheduled late (~1 run in 4 with every core
        // busy, before the workaround — see
        // `gst_pipeline::is_unexposed_eos_race`). The production rebuild
        // must make it play regardless.
        files.push((
            "/live.m3u8".to_string(),
            "application/vnd.apple.mpegurl",
            b"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n\
              #EXTINF:1.0,\nseg0.ts\n#EXT-X-ENDLIST\n"
                .to_vec(),
        ));
        files.push((
            "/seg0.ts".to_string(),
            "video/mp2t",
            std::fs::read(&segment).unwrap(),
        ));
        let _ = std::fs::remove_file(&segment);
    }
    let port = serve(files);
    let mut cases = vec![(
        "test-remote-mp4",
        format!("http://127.0.0.1:{port}/clip.mp4"),
    )];
    if hls {
        cases.push((
            "test-remote-hls",
            format!("http://127.0.0.1:{port}/live.m3u8"),
        ));
    } else {
        eprintln!("skipping the HLS case: hlsdemux2 / a TS segment unavailable");
    }
    for (node, url) in cases {
        let _ = take_events();
        start(node, &url, &url, 0, &restricted_opts(), true)
            .unwrap_or_else(|e| panic!("{node}: {e}"));
        let frame = poll_until(Duration::from_secs(15), || current_frame(node));
        let errors: Vec<String> = take_events()
            .into_iter()
            .filter_map(|e| match e.kind {
                MediaEventKind::Error { code, message, .. } if e.node_id == node => {
                    Some(format!("{code}: {message}"))
                }
                _ => None,
            })
            .collect();
        release(node);
        assert!(
            frame.is_some(),
            "{node}: no frame from {url}; errors: {errors:?}"
        );
        assert!(errors.is_empty(), "{node}: {errors:?}");
    }
}

/// What [`serve_dyn`] answers a request with.
enum Reply {
    Body(&'static str, Vec<u8>),
    /// Accept the request and never answer it (a hung server), until the
    /// test's `hang` gate opens (or 60 s pass).
    Hang,
    NotFound,
}

/// Serve every request through `reply(path, nth request for that path)`
/// on an ephemeral localhost port, one thread per connection. A `Hang`
/// reply holds its connection until `hang` is opened.
fn serve_dyn(reply: impl Fn(&str, usize) -> Reply + Send + Sync + 'static, hang: Gate) -> u16 {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let reply = Arc::new(reply);
    let counts: Arc<Mutex<std::collections::HashMap<String, usize>>> = Arc::default();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let (reply, counts, hang) =
                (Arc::clone(&reply), Arc::clone(&counts), Arc::clone(&hang));
            std::thread::spawn(move || {
                let mut request_line = String::new();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let _ = reader.read_line(&mut request_line);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let path = request_line.split_whitespace().nth(1).unwrap_or("/");
                let path = path.split('?').next().unwrap_or(path).to_string();
                let nth = {
                    let mut counts = counts.lock().unwrap();
                    let n = counts.entry(path.clone()).or_insert(0);
                    *n += 1;
                    *n - 1
                };
                match reply(&path, nth) {
                    Reply::Body(mime, body) => {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\n\
                             Cache-Control: no-cache\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(&body);
                    }
                    Reply::Hang => {
                        let (open, cvar) = &*hang;
                        let guard = open.lock().unwrap();
                        let _ = cvar.wait_timeout_while(guard, Duration::from_secs(60), |o| !*o);
                    }
                    Reply::NotFound => {
                        let _ = stream.write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                    }
                }
            });
        }
    });
    port
}

fn have_feature(name: &str) -> bool {
    use gstreamer as gst;
    gst::Registry::get()
        .find_feature(name, gst::ElementFactory::static_type())
        .is_some_and(|f| f.rank() > gst::Rank::NONE)
}

/// The `onError` codes `node` got (drains the event queue).
fn error_codes(node: &str) -> Vec<String> {
    take_events()
        .into_iter()
        .filter_map(|e| match e.kind {
            MediaEventKind::Error { code, message, .. } if e.node_id == node => {
                Some(format!("{code}: {message}"))
            }
            _ => None,
        })
        .collect()
}

/// Run `f` with the stall watchdog's timeout set to `ms` (its suspect
/// threshold shrinks to half), restoring the real one after.
fn with_stall_timeout<T>(ms: u64, f: impl FnOnce() -> T) -> T {
    use std::sync::atomic::Ordering::SeqCst;
    struct Restore;
    impl Drop for Restore {
        fn drop(&mut self) {
            super::gst_pipeline::ADAPTIVE_STALL_TIMEOUT_MS_OVERRIDE.store(0, SeqCst);
        }
    }
    super::gst_pipeline::ADAPTIVE_STALL_TIMEOUT_MS_OVERRIDE.store(ms, SeqCst);
    let _restore = Restore;
    f()
}

/// The playlist check's view of an HLS master playlist: every variant
/// and rendition playlist it names, resolved, http(s) only; nothing for
/// a media playlist (its URIs are segments the check must not fetch).
#[test]
fn hls_master_playlist_uris_lists_variants_and_renditions_only() {
    use super::gst_pipeline::hls_master_playlist_uris;
    let base = "http://cdn.test/show/master.m3u8";
    let master = "#EXTM3U\n\
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"en\",URI=\"audio/en.m3u8\"\n\
        #EXT-X-STREAM-INF:BANDWIDTH=1\n\
        low/index.m3u8\n\
        #EXT-X-STREAM-INF:BANDWIDTH=2\n\
        /abs/high.m3u8\n\
        #EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=3,URI=\"iframes.m3u8\"\n\
        #EXT-X-STREAM-INF:BANDWIDTH=4\n\
        file:///etc/local.m3u8\n\
        #EXT-X-STREAM-INF:BANDWIDTH=5\n\
        low/index.m3u8\n";
    assert_eq!(
        hls_master_playlist_uris(base, master),
        vec![
            "http://cdn.test/show/audio/en.m3u8",
            "http://cdn.test/show/low/index.m3u8",
            "http://cdn.test/abs/high.m3u8",
            "http://cdn.test/show/iframes.m3u8",
        ]
    );
    let media = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.0,\nseg0.ts\n";
    assert!(hls_master_playlist_uris(base, media).is_empty());
    assert!(hls_master_playlist_uris(base, "<MPD/>").is_empty());
}

/// The watchdog's reading of silence. Before playback: input silence
/// alone counts, whatever the state (a paused pipeline still prerolls) —
/// suspect, then timed out. During playback: only while PLAYING, only
/// when nothing goes in AND nothing comes out (download-ahead pauses keep
/// output flowing), a pause holds the timer, and it never "times out"
/// (mid-stream network failures are the demuxer's to report).
#[test]
fn stall_verdict_separates_refusal_silence_from_pauses() {
    use super::gst_pipeline::{StallVerdict, StallWatch};
    let (suspect, timeout) = (Duration::from_millis(40), Duration::from_millis(120));
    let w = StallWatch::new();
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(
        w.verdict(true, suspect, timeout),
        StallVerdict::Fine,
        "not armed"
    );
    w.progress();
    assert_eq!(w.verdict(false, suspect, timeout), StallVerdict::Fine);
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(w.verdict(false, suspect, timeout), StallVerdict::Suspect);
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(w.verdict(false, suspect, timeout), StallVerdict::TimedOut);

    // Media out: playback has begun.
    let w = StallWatch::new();
    w.progress();
    w.output();
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(
        w.verdict(false, suspect, timeout),
        StallVerdict::Fine,
        "paused: nothing flows by design"
    );
    assert_eq!(
        w.verdict(true, suspect, timeout),
        StallVerdict::Fine,
        "a pause holds the timer: resuming is not a stall"
    );
    std::thread::sleep(Duration::from_millis(60));
    w.output(); // download-ahead pause: output still flowing
    assert_eq!(w.verdict(true, suspect, timeout), StallVerdict::Fine);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        w.verdict(true, suspect, timeout),
        StallVerdict::Suspect,
        "nothing in, nothing out while PLAYING: suspect, never timed out"
    );
}

/// A server that accepts the segment request and never answers is a
/// NETWORK failure — `resource/Read`, the code `souphttpsrc` gives a
/// server that stops answering — not a refusal: nothing the stream names
/// is refused. (Before: `resource/NotAuthorized` after 20 s of silence.)
#[test]
fn remote_hls_silent_server_reports_a_network_timeout_not_a_refusal() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    if !have_feature("souphttpsrc") || !have_feature("hlsdemux2") {
        eprintln!("skipping: souphttpsrc or hlsdemux2 is not installed");
        return;
    }
    let hang: Gate = Arc::default();
    let port = serve_dyn(
        |path, _| match path {
            "/master.m3u8" => Reply::Body(
                "application/vnd.apple.mpegurl",
                b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=64x48\nv.m3u8\n".to_vec(),
            ),
            "/v.m3u8" => Reply::Body(
                "application/vnd.apple.mpegurl",
                b"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n\
                  #EXTINF:1.0,\nseg0.ts\n#EXT-X-ENDLIST\n"
                    .to_vec(),
            ),
            "/seg0.ts" => Reply::Hang,
            _ => Reply::NotFound,
        },
        Arc::clone(&hang),
    );
    let url = format!("http://127.0.0.1:{port}/master.m3u8");
    let node = "test-hls-silent-server";
    let _ = take_events();
    let errored = with_stall_timeout(2_000, || {
        start(node, &url, &url, 0, &restricted_opts(), true).expect("start");
        poll_until(Duration::from_secs(15), || {
            crate::media::status(node).filter(|s| s.errored).map(|_| ())
        })
    });
    let errors = error_codes(node);
    release(node);
    open_gate(&hang);
    assert!(
        errored.is_some(),
        "a hung server must end in onError, not a stall"
    );
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(errors[0].starts_with("resource/Read: "), "{errors:?}");
}

/// A refusal that appears only AFTER playback began: a live media
/// playlist whose update (fetched by the demuxer itself, never through a
/// pad) adds a `file://` segment. The demuxer refuses it silently and
/// playback freezes; the watchdog must notice (nothing in, nothing out
/// while PLAYING), find the refused URI in the playlist and report
/// `resource/NotAuthorized` — not leave the node frozen.
#[test]
fn remote_hls_live_update_naming_a_local_segment_reports_onerror() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    use gstreamer as gst;
    if !have_feature("souphttpsrc") || !have_feature("hlsdemux2") {
        eprintln!("skipping: souphttpsrc or hlsdemux2 is not installed");
        return;
    }
    let segment = std::env::temp_dir().join(format!("hypen_live_seg_{}.ts", std::process::id()));
    if !build_ts_segment(&segment) {
        eprintln!("skipping: cannot encode an MPEG-TS segment here");
        return;
    }
    let body = std::fs::read(&segment).unwrap();
    let seg_uri = gst::glib::filename_to_uri(&segment, None)
        .unwrap()
        .to_string();
    let first_frame: Gate = Arc::default();
    let first_frame_for_server = Arc::clone(&first_frame);
    let port = serve_dyn(
        move |path, _| match path {
            "/live.m3u8" => {
                // Until the first frame is out: three HTTP segments. After:
                // a fourth, local one — a live update the demuxer fetches.
                let updated = *first_frame_for_server.0.lock().unwrap();
                let mut text = String::from(
                    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n\
                     #EXTINF:1.0,\nseg0.ts\n#EXTINF:1.0,\nseg1.ts\n#EXTINF:1.0,\nseg2.ts\n",
                );
                if updated {
                    text.push_str(&format!("#EXTINF:1.0,\n{seg_uri}\n"));
                }
                Reply::Body("application/vnd.apple.mpegurl", text.into_bytes())
            }
            "/seg0.ts" | "/seg1.ts" | "/seg2.ts" => Reply::Body("video/mp2t", body.clone()),
            _ => Reply::NotFound,
        },
        Arc::default(),
    );
    let url = format!("http://127.0.0.1:{port}/live.m3u8");
    let node = "test-hls-live-update-remote";
    let _ = take_events();
    let (frame, errored) = with_stall_timeout(2_000, || {
        start(node, &url, &url, 0, &restricted_opts(), true).expect("start");
        let frame = poll_until(Duration::from_secs(15), || current_frame(node));
        open_gate(&first_frame);
        let errored = poll_until(Duration::from_secs(25), || {
            crate::media::status(node).filter(|s| s.errored).map(|_| ())
        });
        (frame, errored)
    });
    let errors = error_codes(node);
    release(node);
    let _ = std::fs::remove_file(&segment);
    assert!(frame.is_some(), "the live stream never played: {errors:?}");
    assert!(
        errored.is_some(),
        "a mid-stream refused segment froze playback without onError"
    );
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(
        errors[0].starts_with("resource/NotAuthorized: "),
        "{errors:?}"
    );
}

/// GStreamer 1.24's adaptivedemux2 unexposed-pad EOS race, made
/// deterministic: the demuxer posts the race's exact error at the race's
/// exact moment (media parsed, no demuxer pad exposed yet). The stream is
/// fine, so the pipeline restarts and plays — no `onError`.
#[test]
fn adaptive_unexposed_eos_race_restarts_the_stream_instead_of_failing_it() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    if !have_feature("souphttpsrc") || !have_feature("hlsdemux2") {
        eprintln!("skipping: souphttpsrc or hlsdemux2 is not installed");
        return;
    }
    let segment = std::env::temp_dir().join(format!("hypen_race_seg_{}.ts", std::process::id()));
    if !build_ts_segment(&segment) {
        eprintln!("skipping: cannot encode an MPEG-TS segment here");
        return;
    }
    let body = std::fs::read(&segment).unwrap();
    let _ = std::fs::remove_file(&segment);
    let port = serve(vec![
        (
            "/one.m3u8".to_string(),
            "application/vnd.apple.mpegurl",
            b"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n\
              #EXTINF:1.0,\nseg0.ts\n#EXT-X-ENDLIST\n"
                .to_vec(),
        ),
        ("/seg0.ts".to_string(), "video/mp2t", body),
    ]);
    let url = format!("http://127.0.0.1:{port}/one.m3u8");
    let node = "test-hls-eos-race";
    let _ = take_events();
    super::gst_pipeline::INJECT_UNEXPOSED_EOS_RACE.store(true, std::sync::atomic::Ordering::SeqCst);
    start(node, &url, &url, 0, &restricted_opts(), true).expect("start");
    let frame = poll_until(Duration::from_secs(15), || current_frame(node));
    let injected = !super::gst_pipeline::INJECT_UNEXPOSED_EOS_RACE
        .swap(false, std::sync::atomic::Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(300));
    let errors = error_codes(node);
    release(node);
    assert!(injected, "the race was never injected (no parser pad?)");
    assert!(errors.is_empty(), "the race failed the stream: {errors:?}");
    assert!(frame.is_some(), "the restarted stream never played");
}

/// The race workaround must not swallow a REAL download failure: a
/// segment the server 404s still ends in `onError` (once).
#[test]
fn adaptive_missing_segment_still_reports_its_error() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    if !have_feature("souphttpsrc") || !have_feature("hlsdemux2") {
        eprintln!("skipping: souphttpsrc or hlsdemux2 is not installed");
        return;
    }
    let port = serve(vec![(
        "/gone.m3u8".to_string(),
        "application/vnd.apple.mpegurl",
        b"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n\
          #EXTINF:1.0,\nseg0.ts\n#EXTINF:1.0,\nseg1.ts\n#EXT-X-ENDLIST\n"
            .to_vec(),
    )]);
    let url = format!("http://127.0.0.1:{port}/gone.m3u8");
    let node = "test-hls-404";
    let _ = take_events();
    start(node, &url, &url, 0, &restricted_opts(), true).expect("start");
    let errored = poll_until(Duration::from_secs(20), || {
        crate::media::status(node).filter(|s| s.errored).map(|_| ())
    });
    let errors = error_codes(node);
    release(node);
    assert!(errored.is_some(), "a 404 segment must end in onError");
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(errors[0].starts_with("resource/"), "{errors:?}");
}

/// `seekable` is the pipeline's own answer, not "the duration is
/// known": a source can report its duration before the pipeline has
/// prerolled (here an `appsrc` with a set duration and no data yet), and
/// GStreamer refuses a flushing seek until it has. Once prerolled, the
/// seek a `true` answer promises is taken.
#[test]
fn pipeline_seekable_waits_for_preroll_not_for_the_duration() {
    let _guard = lock_tests();
    if !gst_ready() {
        eprintln!("skipping: GStreamer init failed in this sandbox");
        return;
    }
    use gstreamer as gst;
    use gstreamer_app::AppSrc;
    let Ok(pipeline) = gst::parse::launch(
        "appsrc name=src format=time is-live=false stream-type=seekable \
         caps=video/x-raw,format=RGBA,width=4,height=4,framerate=1/1 ! fakesink sync=false",
    ) else {
        eprintln!("skipping: appsrc/fakesink unavailable");
        return;
    };
    let pipeline = pipeline.downcast::<gst::Pipeline>().unwrap();
    let src = pipeline
        .by_name("src")
        .unwrap()
        .downcast::<AppSrc>()
        .unwrap();
    src.set_duration(gst::ClockTime::from_seconds(10));
    src.set_callbacks(
        gstreamer_app::AppSrcCallbacks::builder()
            .seek_data(|_, _| true)
            .build(),
    );
    let element: gst::Element = pipeline.clone().upcast();
    assert!(!super::pipeline_seekable(&element), "NULL");
    let _ = element.set_state(gst::State::Paused);
    // Prerolling: the duration is already known — what the window used to
    // take for "seekable" — but the pipeline is not.
    let duration = poll_until(Duration::from_secs(5), || {
        element.query_duration::<gst::ClockTime>()
    });
    assert_eq!(duration, Some(gst::ClockTime::from_seconds(10)));
    assert!(
        !super::pipeline_seekable(&element),
        "duration known but preroll pending: not seekable yet"
    );
    let mut buffer = gst::Buffer::from_slice(vec![0u8; 4 * 4 * 4]);
    {
        let b = buffer.get_mut().unwrap();
        b.set_pts(gst::ClockTime::ZERO);
        b.set_duration(gst::ClockTime::from_seconds(1));
    }
    src.push_buffer(buffer).unwrap();
    let ready = poll_until(Duration::from_secs(5), || {
        super::pipeline_seekable(&element).then_some(())
    });
    let seeked = ready.is_some()
        && element
            .seek_simple(
                gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                gst::ClockTime::from_seconds(5),
            )
            .is_ok();
    let _ = element.set_state(gst::State::Null);
    assert!(
        ready.is_some(),
        "prerolled pipeline never reported seekable"
    );
    assert!(seeked, "a seekable pipeline refused the seek");
}
