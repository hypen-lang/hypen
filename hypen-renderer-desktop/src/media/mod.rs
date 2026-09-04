//! Inline video playback for `Video` elements (feature `video`).
//!
//! Architecture mirrors the async image worker in
//! [`crate::paint::image`]: playback runs entirely off the winit
//! thread (GStreamer streaming threads), decoded RGBA frames land in
//! a per-player mutex slot, and every landed frame fires
//! [`AppEvent::Wake`] through the registered [`EventLoopProxy`] so
//! the next paint picks it up — a frame-driven repaint loop that
//! stands down the moment playback pauses or ends.
//!
//! One `playbin` pipeline per playing video, keyed by renderer node
//! id. `playbin` does demux + decode + HTTP streaming + A/V sync in
//! one element graph; the video sink is an `appsink` constrained to
//! `video/x-raw,format=RGBA` (pipeline construction lives in
//! [`gst_pipeline`]). Audio goes to `autoaudiosink`, with a
//! `fakesink` fallback so headless machines still play video.
//!
//! Threading rule: GStreamer calls (state changes, seeks) are NEVER
//! made while holding the registry lock — bus sync handlers run on
//! streaming threads and only touch the per-player `Arc`'d slots and
//! the global event queue, so no lock ordering can deadlock.

mod gst_pipeline;

use crate::window::AppEvent;
use gstreamer::prelude::*;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use winit::event_loop::EventLoopProxy;

/// One decoded video frame, tightly packed RGBA8 (stride == width*4).
/// Video content is opaque, so the bytes are valid under both
/// straight- and premultiplied-alpha interpretation — tiny-skia and
/// peniko can both consume them without conversion.
#[derive(Clone)]
pub struct VideoFrame {
    pub width: u32,
    pub height: u32,
    pub data: Arc<Vec<u8>>,
}

/// Playback options resolved from the Video node's props.
#[derive(Debug, Clone, Default)]
pub struct PlayOpts {
    /// Start muted (`muted` prop). Muted playback routes audio to a
    /// `fakesink`, which also sidesteps audio-device discovery on
    /// headless machines.
    pub muted: bool,
    /// Single-source loop (`loop` prop, playlist empty): on EOS the
    /// pipeline seeks back to zero and keeps playing — no `Ended`
    /// event surfaces. Playlist-level wrap is the window's job.
    pub looping: bool,
    /// Extra HTTP request headers (`headers` prop), applied to the
    /// stream fetch via playbin's `source-setup` signal
    /// (souphttpsrc `extra-headers`).
    pub headers: Vec<(String, String)>,
}

/// Event surfaced from a playback pipeline, consumed by the window
/// via [`take_events`].
pub struct MediaEvent {
    pub node_id: String,
    pub kind: MediaEventKind,
}

pub enum MediaEventKind {
    /// The current track reached EOS (and single-src looping was not
    /// requested). The window decides: playlist advance, wrap, or a
    /// contract `onEnded` dispatch.
    Ended,
    /// The stream could not be fetched or decoded. `status` is the
    /// HTTP status when it could be extracted from the GStreamer
    /// error text, per the contract's best-effort clause.
    Error {
        code: String,
        message: String,
        status: Option<u16>,
    },
}

/// Shared slots the GStreamer callbacks write into. Everything the
/// streaming threads touch lives here (never the registry lock).
pub(crate) struct PlayerShared {
    pub(crate) frame: Mutex<Option<VideoFrame>>,
    /// Set once the bus surfaced EOS for a non-looping player.
    pub(crate) ended: AtomicBool,
    /// Set when the bus surfaced an error; painter shows no frame
    /// overlay changes, the window releases the player on the event.
    pub(crate) errored: AtomicBool,
}

struct Player {
    /// Resolved URL of the playing track.
    url: String,
    /// Playlist index of the playing track (0 for single src).
    index: u64,
    pipeline: gstreamer::Element,
    shared: Arc<PlayerShared>,
    /// `true` while the user (or an error/EOS) has playback paused.
    paused: bool,
    /// `true` while the renderer has playback suspended because the
    /// node's subtree is Router-detached (cached off-screen). Kept
    /// separate from `paused` so reattaching restores the state the
    /// user left: a playing video resumes, a paused one stays paused.
    suspended: bool,
}

struct Registry {
    players: Mutex<HashMap<String, Player>>,
    waker: Mutex<Option<EventLoopProxy<AppEvent>>>,
    events: Mutex<Vec<MediaEvent>>,
}

fn registry() -> &'static Registry {
    static REG: OnceLock<Registry> = OnceLock::new();
    REG.get_or_init(|| Registry {
        players: Mutex::new(HashMap::new()),
        waker: Mutex::new(None),
        events: Mutex::new(Vec::new()),
    })
}

/// Monotonic counter bumped every time an appsink lands a frame.
/// The window compares it across redraws to invalidate the painter's
/// subtree scene cache — exactly the `image_load_generation` pattern:
/// without it a cached subtree would replay its encode-time video
/// frame forever.
static FRAME_GEN: AtomicU64 = AtomicU64::new(0);

pub fn frame_generation() -> u64 {
    FRAME_GEN.load(Ordering::Relaxed)
}

pub(crate) fn bump_frame_generation() {
    FRAME_GEN.fetch_add(1, Ordering::Relaxed);
}

/// Register the renderer's event-loop proxy so streaming threads can
/// wake the winit loop when a frame or event lands. Idempotent.
pub fn set_waker(proxy: EventLoopProxy<AppEvent>) {
    *registry().waker.lock().expect("media waker poisoned") = Some(proxy);
}

/// Rising-edge gate on Wake events: streaming threads only send a new
/// `AppEvent::Wake` once the previous one was consumed by the event
/// loop ([`ack_wake`]). Without this, a playing video floods winit's
/// user-event queue at frame rate while the window is occluded /
/// app-napped — the exact pile-up the patch queue's rising-edge
/// gating exists to prevent. At most one media Wake is in flight at
/// any time; frames landing while one is pending are picked up by
/// that pending wake's redraw.
static WAKE_PENDING: AtomicBool = AtomicBool::new(false);

/// Re-arm the wake gate. Called by the window at the START of its
/// `AppEvent::Wake` handling — before it reads frames/events — so a
/// frame landing after the ack sends a fresh wake instead of being
/// missed.
pub fn ack_wake() {
    WAKE_PENDING.store(false, Ordering::Release);
}

pub(crate) fn wake() {
    if WAKE_PENDING.swap(true, Ordering::AcqRel) {
        return;
    }
    let sent = registry()
        .waker
        .lock()
        .expect("media waker poisoned")
        .as_ref()
        .map(|proxy| proxy.send_event(AppEvent::Wake).is_ok())
        .unwrap_or(false);
    if !sent {
        // No proxy registered (tests / headless embedders) or the
        // event loop is gone — don't wedge the gate shut forever.
        WAKE_PENDING.store(false, Ordering::Release);
    }
}

pub(crate) fn push_event(node_id: &str, kind: MediaEventKind) {
    registry()
        .events
        .lock()
        .expect("media events poisoned")
        .push(MediaEvent {
            node_id: node_id.to_string(),
            kind,
        });
    wake();
}

/// Drain all pending playback events. Called by the window on every
/// patch flush / wake.
pub fn take_events() -> Vec<MediaEvent> {
    std::mem::take(&mut *registry().events.lock().expect("media events poisoned"))
}

/// `true` when `node_id` has a live playback pipeline (playing,
/// paused, or ended-but-showing-its-last-frame).
pub fn has_playback(node_id: &str) -> bool {
    registry()
        .players
        .lock()
        .expect("media registry poisoned")
        .contains_key(node_id)
}

/// The `(url, playlist_index)` of the track the node's player is
/// currently on. Diverges from the node's `startIndex`-derived track
/// after a playlist advance — the registry is the source of truth.
pub fn current_track(node_id: &str) -> Option<(String, u64)> {
    registry()
        .players
        .lock()
        .expect("media registry poisoned")
        .get(node_id)
        .map(|p| (p.url.clone(), p.index))
}

/// Latest decoded frame for the node, if playback has produced one.
pub fn current_frame(node_id: &str) -> Option<VideoFrame> {
    let shared = {
        let players = registry().players.lock().expect("media registry poisoned");
        Arc::clone(&players.get(node_id)?.shared)
    };
    let frame = shared.frame.lock().expect("frame slot poisoned");
    frame.clone()
}

/// `true` when the node's playback exists but is not advancing —
/// paused by the user or ended. Drives the painters' play-glyph
/// overlay on top of the last decoded frame.
pub fn is_paused(node_id: &str) -> bool {
    let players = registry().players.lock().expect("media registry poisoned");
    match players.get(node_id) {
        Some(p) => p.paused || p.shared.ended.load(Ordering::Relaxed),
        None => false,
    }
}

/// One-shot snapshot of a player's contract-relevant state, taken with
/// a single registry-lock acquisition. Backs
/// [`crate::video_v2::player_state`] and the `playback` bind reports —
/// deriving the state from five separate accessors would sample a
/// moving pipeline at five different instants.
///
/// `position` / `duration` are seconds; `0.0` while the pipeline can't
/// answer the query yet (pre-preroll, unseekable live stream).
#[derive(Debug, Clone, Copy, Default)]
pub struct PlayerStatus {
    pub paused: bool,
    pub suspended: bool,
    pub ended: bool,
    pub errored: bool,
    /// At least one decoded frame has landed — the coarse "not
    /// buffering any more" signal (see `video_v2::player_state`).
    pub has_frame: bool,
    pub position: f64,
    pub duration: f64,
}

/// Snapshot `node_id`'s player. `None` when it has no pipeline.
///
/// Threading rule (see the module header): the registry lock is dropped
/// before the GStreamer position/duration queries run.
pub fn status(node_id: &str) -> Option<PlayerStatus> {
    let (pipeline, shared, paused, suspended) = {
        let players = registry().players.lock().expect("media registry poisoned");
        let p = players.get(node_id)?;
        (
            p.pipeline.clone(),
            Arc::clone(&p.shared),
            p.paused,
            p.suspended,
        )
    };
    let has_frame = shared.frame.lock().expect("frame slot poisoned").is_some();
    let (position, duration) = query_position_duration(&pipeline);
    Some(PlayerStatus {
        paused,
        suspended,
        ended: shared.ended.load(Ordering::Relaxed),
        errored: shared.errored.load(Ordering::Relaxed),
        has_frame,
        position,
        duration,
    })
}

/// `(position, duration)` in seconds for `node_id`'s pipeline, or `None`
/// when it has none.
pub fn position_duration(node_id: &str) -> Option<(f64, f64)> {
    let pipeline = {
        let players = registry().players.lock().expect("media registry poisoned");
        players.get(node_id)?.pipeline.clone()
    };
    Some(query_position_duration(&pipeline))
}

/// GStreamer position/duration queries in TIME format, converted to
/// seconds. A pipeline that hasn't prerolled answers `None` for both —
/// reported as `0.0` (the contract's "0 until known").
fn query_position_duration(pipeline: &gstreamer::Element) -> (f64, f64) {
    let position = pipeline
        .query_position::<gstreamer::ClockTime>()
        .map(|t| t.seconds_f64())
        .unwrap_or(0.0);
    let duration = pipeline
        .query_duration::<gstreamer::ClockTime>()
        .map(|t| t.seconds_f64())
        .unwrap_or(0.0);
    (position.max(0.0), duration.max(0.0))
}

/// Seek `node_id` to `seconds` (clamped at 0, and to the known duration
/// when the pipeline can answer). Returns `true` when the seek was
/// issued. Flushing + key-unit: the same flags the ended-restart and
/// single-src loop paths use, so the next decoded frame is at the new
/// position rather than after the remaining queued buffers.
pub fn seek(node_id: &str, seconds: f64) -> bool {
    let pipeline = {
        let players = registry().players.lock().expect("media registry poisoned");
        match players.get(node_id) {
            Some(p) => p.pipeline.clone(),
            None => return false,
        }
    };
    let (_, duration) = query_position_duration(&pipeline);
    let mut target = seconds.max(0.0);
    if duration > 0.0 {
        target = target.min(duration);
    }
    if !target.is_finite() {
        return false;
    }
    let ns = (target * 1_000_000_000.0) as u64;
    pipeline
        .seek_simple(
            gstreamer::SeekFlags::FLUSH | gstreamer::SeekFlags::KEY_UNIT,
            gstreamer::ClockTime::from_nseconds(ns),
        )
        .is_ok()
}

/// Drive playback to an explicit `playing` state — the `playback` bind
/// struct's write path (as opposed to [`toggle`], which is the pointer
/// affordance). Writing `true` on an ended player restarts it from zero
/// per the spec. Returns `Some(now_playing)`, or `None` when the node
/// has no pipeline.
pub fn set_playing(node_id: &str, playing: bool) -> Option<bool> {
    let (pipeline, shared, was_paused) = {
        let players = registry().players.lock().expect("media registry poisoned");
        let p = players.get(node_id)?;
        (p.pipeline.clone(), Arc::clone(&p.shared), p.paused)
    };
    let ended = shared.ended.load(Ordering::Relaxed);
    if playing != was_paused && !ended {
        // Already in the requested state — no pipeline traffic, and no
        // echo back out through the bind reports.
        return Some(playing);
    }
    if playing {
        if ended {
            shared.ended.store(false, Ordering::Relaxed);
            let _ = pipeline.seek_simple(
                gstreamer::SeekFlags::FLUSH | gstreamer::SeekFlags::KEY_UNIT,
                gstreamer::ClockTime::ZERO,
            );
        }
        let _ = pipeline.set_state(gstreamer::State::Playing);
    } else {
        let _ = pipeline.set_state(gstreamer::State::Paused);
    }
    let mut players = registry().players.lock().expect("media registry poisoned");
    if let Some(p) = players.get_mut(node_id) {
        p.paused = !playing;
    }
    Some(playing)
}

/// Start (or restart) playback of `url` for `node_id`. Any existing
/// pipeline for the node is torn down first. `playing = false`
/// prerolls paused (first frame shows, no advance).
///
/// Returns `Ok(true)` when playback started, `Ok(false)` when the
/// pipeline failed synchronously but its bus already surfaced a
/// structured [`MediaEventKind::Error`] (the caller must NOT
/// dispatch its own error — the event pump will), and `Err` when it
/// failed with no bus error to route.
pub fn start(
    node_id: &str,
    url: &str,
    index: u64,
    opts: &PlayOpts,
    playing: bool,
) -> Result<bool, String> {
    // Tear down any prior pipeline for this node OUTSIDE the lock.
    release(node_id);

    let shared = Arc::new(PlayerShared {
        frame: Mutex::new(None),
        ended: AtomicBool::new(false),
        errored: AtomicBool::new(false),
    });
    let pipeline = gst_pipeline::build(node_id, url, opts, Arc::clone(&shared))?;
    let target = if playing {
        gstreamer::State::Playing
    } else {
        gstreamer::State::Paused
    };
    if let Err(e) = pipeline.set_state(target) {
        let _ = pipeline.set_state(gstreamer::State::Null);
        // A missing file / unreachable host can fail the state change
        // synchronously; the bus sync handler has then already pushed
        // the structured error event. One error, one dispatch path.
        if shared.errored.load(Ordering::Relaxed) {
            return Ok(false);
        }
        return Err(format!("set_state({target:?}) failed: {e}"));
    }
    let player = Player {
        url: url.to_string(),
        index,
        pipeline,
        shared,
        paused: !playing,
        suspended: false,
    };
    let prior = registry()
        .players
        .lock()
        .expect("media registry poisoned")
        .insert(node_id.to_string(), player);
    // A racing insert for the same node (shouldn't happen — the
    // window is single-threaded) still gets torn down.
    if let Some(old) = prior {
        let _ = old.pipeline.set_state(gstreamer::State::Null);
    }
    Ok(true)
}

/// Toggle play/pause. Returns `Some(now_playing)`; `None` when the
/// node has no playback. An ended player restarts from zero.
pub fn toggle(node_id: &str) -> Option<bool> {
    // Snapshot what we need under the lock; do gst calls after.
    let (pipeline, shared, was_paused) = {
        let players = registry().players.lock().expect("media registry poisoned");
        let p = players.get(node_id)?;
        (p.pipeline.clone(), Arc::clone(&p.shared), p.paused)
    };
    let ended = shared.ended.load(Ordering::Relaxed);
    let now_playing = if ended {
        // Restart from the top.
        shared.ended.store(false, Ordering::Relaxed);
        let _ = pipeline.seek_simple(
            gstreamer::SeekFlags::FLUSH | gstreamer::SeekFlags::KEY_UNIT,
            gstreamer::ClockTime::ZERO,
        );
        let _ = pipeline.set_state(gstreamer::State::Playing);
        true
    } else if was_paused {
        let _ = pipeline.set_state(gstreamer::State::Playing);
        true
    } else {
        let _ = pipeline.set_state(gstreamer::State::Paused);
        false
    };
    let mut players = registry().players.lock().expect("media registry poisoned");
    if let Some(p) = players.get_mut(node_id) {
        p.paused = !now_playing;
    }
    Some(now_playing)
}

/// Suspend (`true`) or resume (`false`) the node's pipeline without
/// touching the user-facing paused state. Backs the Router keep-alive
/// cache: a `Detach`ed subtree keeps its pipeline (position, decoded
/// frame) but must stop advancing — otherwise cached routes keep
/// playing audio off-screen. `Attach` resumes only players the user
/// had playing (not paused, not ended).
///
/// Returns `true` when the audible pipeline state actually changed
/// (playing → suspended, or suspended → playing again) so the caller
/// can dispatch the contract's `onPause` / `onPlay` events; `false`
/// for no-ops (no player, already in the requested state, or the
/// player was user-paused/ended either way).
pub fn set_suspended(node_id: &str, suspended: bool) -> bool {
    // Snapshot under the lock; gst state changes happen after.
    let audible = {
        let mut players = registry().players.lock().expect("media registry poisoned");
        let Some(p) = players.get_mut(node_id) else {
            return false;
        };
        if p.suspended == suspended {
            return false;
        }
        p.suspended = suspended;
        let ended = p.shared.ended.load(Ordering::Relaxed);
        (!p.paused && !ended).then(|| p.pipeline.clone())
    };
    let Some(pipeline) = audible else {
        return false;
    };
    let target = if suspended {
        gstreamer::State::Paused
    } else {
        gstreamer::State::Playing
    };
    let _ = pipeline.set_state(target);
    true
}

/// `true` while the node's pipeline is suspended by [`set_suspended`].
pub fn is_suspended(node_id: &str) -> bool {
    registry()
        .players
        .lock()
        .expect("media registry poisoned")
        .get(node_id)
        .is_some_and(|p| p.suspended)
}

/// Tear down the node's pipeline, if any.
pub fn release(node_id: &str) {
    let removed = registry()
        .players
        .lock()
        .expect("media registry poisoned")
        .remove(node_id);
    if let Some(p) = removed {
        let _ = p.pipeline.set_state(gstreamer::State::Null);
    }
}

/// Tear down every pipeline whose node id is NOT in `alive`. Called
/// by the window each redraw so removed Video nodes release their
/// decoder + network resources promptly.
pub fn retain_only(alive: &HashSet<String>) {
    let removed: Vec<Player> = {
        let mut players = registry().players.lock().expect("media registry poisoned");
        let dead: Vec<String> = players
            .keys()
            .filter(|id| !alive.contains(*id))
            .cloned()
            .collect();
        dead.into_iter()
            .filter_map(|id| players.remove(&id))
            .collect()
    };
    for p in removed {
        let _ = p.pipeline.set_state(gstreamer::State::Null);
    }
}

/// Tear down everything. Called on window close / app exit.
pub fn release_all() {
    let removed: Vec<Player> = {
        let mut players = registry().players.lock().expect("media registry poisoned");
        players.drain().map(|(_, p)| p).collect()
    };
    for p in removed {
        let _ = p.pipeline.set_state(gstreamer::State::Null);
    }
}

// ---------------------------------------------------------------------------
// Prop resolution helpers (Video node props → PlayOpts / playlist).
// ---------------------------------------------------------------------------

/// Truthy check for a bool-ish prop (`autoplay`, `muted`, `loop`):
/// JSON `true` or the string `"true"`, under either the named key or
/// its positional `.0` variant.
pub(crate) fn prop_truthy(node: &crate::tree::Node, name: &str) -> bool {
    let zero = format!("{name}.0");
    let v = node.props.get(&zero).or_else(|| node.props.get(name));
    match v {
        Some(v) => v.as_bool() == Some(true) || v.as_str().map(str::trim) == Some("true"),
        None => false,
    }
}

/// The node's `playlist` prop as an ordered list of URLs. Entries are
/// trimmed but NOT filtered — indexes must stay aligned with the
/// authored array (contract payloads carry the index).
pub(crate) fn resolve_playlist(node: &crate::tree::Node) -> Vec<String> {
    node.props
        .get("playlist")
        .or_else(|| node.props.get("playlist.0"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|v| v.as_str().map(str::trim).unwrap_or_default().to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Resolve the node's `headers` prop: either a whole JSON object
/// under `headers` / `headers.0`, or flattened `headers.<Name>` keys.
pub(crate) fn resolve_headers(node: &crate::tree::Node) -> Vec<(String, String)> {
    let obj = node
        .props
        .get("headers")
        .or_else(|| node.props.get("headers.0"))
        .and_then(|v| v.as_object());
    if let Some(map) = obj {
        return map
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect();
    }
    let mut out = Vec::new();
    for (k, v) in &node.props {
        if let Some(name) = k.strip_prefix("headers.") {
            if name != "0" {
                if let Some(s) = v.as_str() {
                    out.push((name.to_string(), s.to_string()));
                }
            }
        }
    }
    out
}

/// Build [`PlayOpts`] from the node's props. `looping` is set only
/// for single-src playback — playlist wrap is queue-level and handled
/// by the window on `Ended`.
pub(crate) fn resolve_play_opts(node: &crate::tree::Node) -> PlayOpts {
    let has_playlist = !resolve_playlist(node).is_empty();
    PlayOpts {
        muted: prop_truthy(node, "muted"),
        looping: prop_truthy(node, "loop") && !has_playlist,
        headers: resolve_headers(node),
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
