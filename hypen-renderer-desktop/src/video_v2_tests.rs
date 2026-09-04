//! Tests for `crate::video_v2` — the Rust mirror of the normative Video
//! v2 tables in `hypen-web/packages/core/src/types.ts`. Lives in its own
//! file via `#[path]`, matching the crate's layout/window/anim split.

use super::*;
use crate::style::vp;
use crate::tree::Tree;
use hypen_engine::Patch;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::sync::Arc;

const STATES: [VideoPlayerState; 6] = [
    VideoPlayerState::Idle,
    VideoPlayerState::Loading,
    VideoPlayerState::Playing,
    VideoPlayerState::Paused,
    VideoPlayerState::Ended,
    VideoPlayerState::Error,
];

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

fn node(props: &[(&str, Value)]) -> crate::tree::Node {
    crate::tree::Node {
        id: "v1".to_string(),
        element_type: "Video".to_string(),
        props: props
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
        semantics: None,
    }
}

// -----------------------------------------------------------------
// Contract vocabulary + constants (mirror check against types.ts)
// -----------------------------------------------------------------

#[test]
fn state_names_match_the_typescript_union() {
    let names: Vec<&str> = STATES.iter().map(|s| s.as_str()).collect();
    assert_eq!(
        names,
        vec!["idle", "loading", "playing", "paused", "ended", "error"]
    );
}

#[test]
fn constants_mirror_core_types_ts() {
    assert_eq!(PLAYBACK_REPORT_INTERVAL_MS, 250);
    assert_eq!(PLAYBACK_SEEK_EPSILON_S, 1.0);
    assert_eq!(VIDEO_SLOTS, &["controls", "loading", "error", "poster"]);
}

#[test]
fn only_playing_is_strictly_playing() {
    for state in STATES {
        assert_eq!(
            state.is_playing(),
            state == VideoPlayerState::Playing,
            "{state:?}"
        );
    }
}

#[test]
fn play_intent_stays_true_through_loading() {
    // The bind struct's `playing` field reports play INTENT: `loading`
    // (preroll, autoplay start, rebuffer) keeps it true while `state`
    // reports "loading"; every parked state reports false.
    for state in STATES {
        assert_eq!(
            state.play_intent(),
            matches!(state, VideoPlayerState::Playing | VideoPlayerState::Loading),
            "{state:?}"
        );
    }
}

#[test]
fn slot_paint_rank_orders_poster_loading_controls_error() {
    let mut ranked = [
        VideoSlotName::Error,
        VideoSlotName::Controls,
        VideoSlotName::Poster,
        VideoSlotName::Loading,
    ];
    ranked.sort_by_key(|s| slot_paint_rank(*s));
    assert_eq!(
        ranked,
        [
            VideoSlotName::Poster,
            VideoSlotName::Loading,
            VideoSlotName::Controls,
            VideoSlotName::Error,
        ],
        "bottom-to-top paint order is poster → loading → controls → error"
    );
}

// -----------------------------------------------------------------
// VIDEO_SLOT_VISIBILITY (normative table)
// -----------------------------------------------------------------

#[test]
fn slot_visibility_table_matches_the_spec_exactly() {
    // Transcribed straight from hypen-docs/content/docs/guide/components.mdx and
    // VIDEO_SLOT_VISIBILITY: (slot, [idle, loading, playing, paused,
    // ended, error]).
    let table: &[(VideoSlotName, [bool; 6])] = &[
        (
            VideoSlotName::Poster,
            [true, true, false, false, true, false],
        ),
        (
            VideoSlotName::Loading,
            [false, true, false, false, false, false],
        ),
        (
            // Visible in idle so a custom controls slot can start
            // first play, and in loading so a buffering stream still
            // offers its transport.
            VideoSlotName::Controls,
            [true, true, true, true, true, false],
        ),
        (
            VideoSlotName::Error,
            [false, false, false, false, false, true],
        ),
    ];
    for (slot, expected) in table {
        for (i, state) in STATES.iter().enumerate() {
            assert_eq!(
                slot_visible(*slot, *state),
                expected[i],
                "{}/{}",
                slot.as_str(),
                state.as_str()
            );
        }
    }
}

#[test]
fn slot_names_round_trip_case_insensitively() {
    for name in VIDEO_SLOTS {
        let parsed = VideoSlotName::parse(name).expect("known slot");
        assert_eq!(parsed.as_str(), *name);
    }
    assert_eq!(
        VideoSlotName::parse("  Controls "),
        Some(VideoSlotName::Controls)
    );
    assert_eq!(VideoSlotName::parse("chrome"), None);
}

// -----------------------------------------------------------------
// Slot presence / built-in replacement
// -----------------------------------------------------------------

#[test]
fn slot_presence_reads_positional_and_named_slot_props() {
    let mut tree = Tree::new();
    tree.apply(&create("v", "Video", &[]));
    tree.apply(&insert("root", "v"));
    tree.apply(&create("c", "Row", &[("slot.0", json!("controls"))]));
    tree.apply(&insert("v", "c"));
    tree.apply(&create("p", "Image", &[("slot", json!("poster"))]));
    tree.apply(&insert("v", "p"));
    tree.apply(&create("x", "Text", &[]));
    tree.apply(&insert("v", "x"));

    let presence = slot_presence(&tree, "v");
    assert!(presence.controls);
    assert!(presence.poster);
    assert!(!presence.loading);
    assert!(!presence.error);
    assert!(presence.any());
}

#[test]
fn controls_slot_suppresses_the_builtin_glyph_in_every_state() {
    let controls = SlotPresence {
        controls: true,
        ..Default::default()
    };
    for state in STATES {
        assert!(
            !controls.draws_builtin_glyph(state),
            "controls slot must suppress native chrome in {state:?}"
        );
    }
}

#[test]
fn loading_and_error_slots_replace_the_glyph_only_in_their_own_state() {
    let loading = SlotPresence {
        loading: true,
        ..Default::default()
    };
    assert!(!loading.draws_builtin_glyph(VideoPlayerState::Loading));
    assert!(loading.draws_builtin_glyph(VideoPlayerState::Paused));

    let error = SlotPresence {
        error: true,
        ..Default::default()
    };
    assert!(!error.draws_builtin_glyph(VideoPlayerState::Error));
    assert!(error.draws_builtin_glyph(VideoPlayerState::Idle));

    // No slots at all keeps today's shipped behaviour everywhere.
    let none = SlotPresence::default();
    for state in STATES {
        assert!(none.draws_builtin_glyph(state));
    }
}

// -----------------------------------------------------------------
// State derivation
// -----------------------------------------------------------------

#[test]
fn plain_video_with_no_source_is_idle() {
    assert_eq!(player_state(&node(&[]), vp(800.0)), VideoPlayerState::Idle);
}

#[test]
fn sticky_error_marker_wins_over_everything() {
    let n = node(&[
        ("src", json!("https://cdn/a.mp4")),
        ("autoplay", json!(true)),
        (VIDEO_ERROR_PROP, json!(true)),
    ]);
    assert_eq!(player_state(&n, vp(800.0)), VideoPlayerState::Error);
}

#[test]
fn poster_probe_failure_is_the_feature_off_error_state() {
    let poster = "https://cdn.example.com/__video_v2_probe_fail.jpg";
    crate::paint::image::test_seed_failure(poster, 404, "Not Found");
    let n = node(&[("src", json!("https://cdn/a.mp4")), ("poster", json!(poster))]);
    assert_eq!(player_state(&n, vp(800.0)), VideoPlayerState::Error);
}

#[cfg(not(feature = "video"))]
#[test]
fn without_the_feature_a_playing_source_still_reports_idle() {
    // No decode stack: the contract state is `idle` (poster shows), and
    // the poster/error slots are the only ones that can ever appear.
    let n = node(&[("src", json!("https://cdn/a.mp4")), ("autoplay", json!(true))]);
    assert_eq!(player_state(&n, vp(800.0)), VideoPlayerState::Idle);
}

#[cfg(feature = "video")]
#[test]
fn autoplay_source_without_a_pipeline_yet_is_loading() {
    // The pipeline starts on this same flush; reporting `idle` here
    // would flash the poster slot off and back on.
    let n = node(&[("src", json!("https://cdn/a.mp4")), ("autoplay", json!(true))]);
    assert_eq!(player_state(&n, vp(800.0)), VideoPlayerState::Loading);
    // Without autoplay there is nothing pending: idle.
    let n = node(&[("src", json!("https://cdn/a.mp4"))]);
    assert_eq!(player_state(&n, vp(800.0)), VideoPlayerState::Idle);
    // The one-way controlled form pends a start exactly like autoplay…
    let n = node(&[("src", json!("https://cdn/a.mp4")), ("playing", json!(true))]);
    assert_eq!(player_state(&n, vp(800.0)), VideoPlayerState::Loading);
    // …while `playing: false` pends nothing.
    let n = node(&[("src", json!("https://cdn/a.mp4")), ("playing", json!(false))]);
    assert_eq!(player_state(&n, vp(800.0)), VideoPlayerState::Idle);
}

#[test]
fn controlled_playing_reads_both_spellings_and_bool_or_string() {
    // The controlled subset: `playing: @{state.isPlaying}` as a plain
    // prop. Positional spelling wins, strings coerce like other truthy
    // props, anything else is "not controlled".
    assert_eq!(
        controlled_playing(&node(&[("playing", json!(true))])),
        Some(true)
    );
    assert_eq!(
        controlled_playing(&node(&[("playing.0", json!(false))])),
        Some(false)
    );
    assert_eq!(
        controlled_playing(&node(&[("playing", json!("true"))])),
        Some(true)
    );
    assert_eq!(
        controlled_playing(&node(&[("playing", json!(" false "))])),
        Some(false)
    );
    assert_eq!(controlled_playing(&node(&[("playing", json!("maybe"))])), None);
    assert_eq!(controlled_playing(&node(&[])), None);
}

// -----------------------------------------------------------------
// startPosition re-arm key (source configuration fingerprint)
// -----------------------------------------------------------------

#[cfg(feature = "video")]
#[test]
fn source_config_fingerprint_rearms_on_source_changes_only() {
    // The spec's `startPosition` clause: applied once, re-armed when the
    // SOURCE CONFIGURATION (src/playlist/headers) changes — NOT when a
    // playlist auto-advance moves the current track, and not on
    // unrelated prop updates.
    let base = node(&[
        ("playlist", json!(["https://cdn/ep1.mp4", "https://cdn/ep2.mp4"])),
        ("startPosition", json!(300)),
        ("headers", json!({"Authorization": "Bearer x"})),
    ]);
    let fp = source_config_fingerprint(&base);
    // A playlist auto-advance changes the registry's current track but
    // no node prop: the fingerprint is stable, so resuming ep1 at 5:00
    // must not also skip the first five minutes of ep2.
    assert_eq!(fp, source_config_fingerprint(&base));
    // Unrelated prop updates don't re-arm either.
    let unrelated = node(&[
        ("playlist", json!(["https://cdn/ep1.mp4", "https://cdn/ep2.mp4"])),
        ("startPosition", json!(300)),
        ("headers", json!({"Authorization": "Bearer x"})),
        ("muted", json!(true)),
    ]);
    assert_eq!(fp, source_config_fingerprint(&unrelated));
    // src / playlist / headers changes each re-arm.
    let new_playlist = node(&[
        ("playlist", json!(["https://cdn/other.mp4"])),
        ("headers", json!({"Authorization": "Bearer x"})),
    ]);
    assert_ne!(fp, source_config_fingerprint(&new_playlist));
    let src_a = node(&[("src", json!("https://cdn/a.mp4"))]);
    let src_b = node(&[("src", json!("https://cdn/b.mp4"))]);
    assert_ne!(
        source_config_fingerprint(&src_a),
        source_config_fingerprint(&src_b)
    );
    let src_a_auth = node(&[
        ("src", json!("https://cdn/a.mp4")),
        ("headers", json!({"Authorization": "Bearer y"})),
    ]);
    assert_ne!(
        source_config_fingerprint(&src_a),
        source_config_fingerprint(&src_a_auth)
    );
}

// -----------------------------------------------------------------
// Bind + enclosing-player resolution
// -----------------------------------------------------------------

#[test]
fn bind_path_reads_both_spellings_and_rejects_blanks() {
    assert_eq!(
        bind_path(&node(&[("bind", json!("playback"))])).as_deref(),
        Some("playback")
    );
    assert_eq!(
        bind_path(&node(&[("bind.0", json!(" state.pb "))])).as_deref(),
        Some("state.pb")
    );
    assert_eq!(bind_path(&node(&[("bind", json!(""))])), None);
    assert_eq!(bind_path(&node(&[])), None);
}

#[test]
fn enclosing_video_walks_up_through_slot_chrome() {
    let mut tree = Tree::new();
    tree.apply(&create("v", "Video", &[]));
    tree.apply(&insert("root", "v"));
    tree.apply(&create("row", "Row", &[("slot.0", json!("controls"))]));
    tree.apply(&insert("v", "row"));
    tree.apply(&create("sc", "Scrubber", &[]));
    tree.apply(&insert("row", "sc"));
    // A Scrubber outside any Video is inert.
    tree.apply(&create("loose", "Scrubber", &[]));
    tree.apply(&insert("root", "loose"));

    assert_eq!(enclosing_video(&tree, "sc").as_deref(), Some("v"));
    assert_eq!(enclosing_video(&tree, "loose"), None);
    // A Video is not its own enclosing player.
    assert_eq!(enclosing_video(&tree, "v"), None);
}

#[test]
fn scrubber_fraction_prefers_the_drag_preview_and_clamps() {
    assert_eq!(scrubber_fraction(None, Some(0.42)), 0.42);
    assert_eq!(scrubber_fraction(None, Some(2.0)), 1.0);
    assert_eq!(scrubber_fraction(None, Some(-1.0)), 0.0);
    // No preview + no player (or no duration) → empty track, never NaN.
    assert_eq!(scrubber_fraction(None, None), 0.0);
    assert_eq!(scrubber_fraction(Some("nonexistent-node"), None), 0.0);
}

#[test]
fn scrub_preview_prop_round_trips() {
    assert_eq!(
        scrub_preview(&node(&[(SCRUB_PREVIEW_PROP, json!(0.25))])),
        Some(0.25)
    );
    assert_eq!(scrub_preview(&node(&[])), None);
}

// -----------------------------------------------------------------
// Renderer-local intents — `.videoIntent("fullscreen")`
// -----------------------------------------------------------------

#[test]
fn video_intent_vocabulary_matches_the_contract() {
    assert_eq!(VideoIntent::Fullscreen.as_str(), "fullscreen");
    assert_eq!(VideoIntent::parse("fullscreen"), Some(VideoIntent::Fullscreen));
    assert_eq!(VideoIntent::parse(" fullscreen "), Some(VideoIntent::Fullscreen));
    // Unknown / future intents stay inert rather than guessing.
    assert_eq!(VideoIntent::parse("Fullscreen"), None);
    assert_eq!(VideoIntent::parse("pip"), None);
    assert_eq!(VideoIntent::parse(""), None);
}

#[test]
fn node_intent_reads_both_prop_spellings() {
    assert_eq!(
        node_intent(&node(&[("videoIntent.0", json!("fullscreen"))])),
        Some(VideoIntent::Fullscreen)
    );
    assert_eq!(
        node_intent(&node(&[("videoIntent", json!("fullscreen"))])),
        Some(VideoIntent::Fullscreen)
    );
    assert_eq!(node_intent(&node(&[("videoIntent.0", json!(true))])), None);
    assert_eq!(node_intent(&node(&[])), None);
}

#[test]
fn intent_resolves_only_inside_a_video_subtree() {
    let mut tree = Tree::new();
    tree.apply(&create("v", "Video", &[]));
    tree.apply(&insert("root", "v"));
    tree.apply(&create("row", "Row", &[("slot.0", json!("controls"))]));
    tree.apply(&insert("v", "row"));
    tree.apply(&create(
        "fs",
        "Button",
        &[("videoIntent.0", json!("fullscreen"))],
    ));
    tree.apply(&insert("row", "fs"));
    // Same tag, no player around it: inert (the `Scrubber` rule).
    tree.apply(&create(
        "loose",
        "Button",
        &[("videoIntent.0", json!("fullscreen"))],
    ));
    tree.apply(&insert("root", "loose"));

    assert_eq!(intent_for(&tree, "fs"), Some(VideoIntent::Fullscreen));
    assert_eq!(intent_for(&tree, "loose"), None);
    assert_eq!(intent_for(&tree, "row"), None);
    assert_eq!(intent_for(&tree, "missing-node"), None);
}
