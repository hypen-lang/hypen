//! Video v2 window glue: the `playback` bind channel (report + apply),
//! `startPosition`, composition-slot suppression of built-ins, and the
//! `Scrubber` gesture.
//!
//! Lives in its own file via `#[path]` from `window.rs` (same pattern as
//! `window_input.rs`) so the main file stays focused on App state and the
//! ApplicationHandler dispatch loop. The methods attach to the same `App`.
//!
//! Normative reference: `hypen-web/docs/components/video.md`
//! §"Playback control & composition slots", mirrored in Rust by
//! [`crate::video_v2`].

use super::*;
use crate::video_v2::{
    VideoPlayerState, PLAYBACK_REPORT_INTERVAL_MS, PLAYBACK_SEEK_EPSILON_S, SCRUBBER_KEY_STEP_S,
};

/// The last values the renderer pushed into a Video's `playback` bind
/// struct. Two jobs:
///
/// 1. **Throttle** — `position` reports at most every
///    [`PLAYBACK_REPORT_INTERVAL_MS`] while playing; every other field
///    reports immediately on transition.
/// 2. **Echo guard** — an inbound `playback` write whose field still
///    equals what we last reported is our own report coming back around
///    the state loop and is dropped without touching the pipeline. The
///    epsilon guard on `position` is the second half of the same
///    defence.
#[derive(Debug, Clone)]
pub(crate) struct PlaybackReport {
    pub position: f64,
    pub duration: f64,
    pub playing: bool,
    pub state: VideoPlayerState,
    /// When `position` was last pushed. Seeded at construction so the
    /// very first frame after a transition doesn't immediately re-report.
    pub position_reported_at: std::time::Instant,
}

/// An in-flight `Scrubber` drag. The preview lives in the renderer tree
/// (`video_v2::SCRUB_PREVIEW_PROP`) so layout/paint pick it up like any
/// other prop; this record is the gesture bookkeeping.
#[derive(Debug, Clone)]
pub(crate) struct VideoScrubDrag {
    pub scrubber_id: String,
    /// Enclosing player, resolved at pointer-down. Always `Some` for a
    /// claimed drag: an inert Scrubber outside a Video never claims the
    /// gesture in the first place (`video_scrub_down` refuses it).
    pub video_id: Option<String>,
    /// The track rect captured at pointer-down. Held here rather than
    /// re-read per move so the fraction mapping stays stable for the
    /// whole gesture — nothing can relayout the widget during the drag.
    /// (Pointer→local mapping itself stays live through the cached
    /// layout, which `write_scrub_preview` patches in place rather than
    /// dropping, so transformed scrubbers keep tracking the pointer.)
    pub rect: crate::layout::Rect,
    pub fraction: f32,
    /// Set when the enclosing player's track changed under the gesture
    /// (playlist auto-advance, retarget, error release): the captured
    /// fraction belongs to the OLD track's timeline, so the release
    /// must commit nothing — while still consuming the pointer-up (a
    /// cancelled scrub is not a tap either).
    pub cancelled: bool,
}

/// `true` when a Video declares a `controls` slot, so the built-in
/// tap-to-toggle stands down ("a present slot replaces the built-in for
/// that concern" — the desktop's native chrome IS the tap affordance).
/// Free function so the rule is testable without a GPU-backed `App`.
pub(crate) fn tap_suppressed(tree: &Tree, video_id: &str) -> bool {
    crate::video_v2::slot_presence(tree, video_id).controls
}

/// Pointer x → fraction of a Scrubber's track, clamped to `0..=1`.
///
/// Deliberately the inverse of the painted geometry's track span
/// (`crate::paint::image::scrubber_geometry` uses the full item width
/// for the track), so the progress edge lands exactly under the pointer.
pub(crate) fn scrub_fraction_at(rect: crate::layout::Rect, x: f32) -> f32 {
    if rect.w <= 0.0 {
        return 0.0;
    }
    ((x - rect.x) / rect.w).clamp(0.0, 1.0)
}

/// Resolve what a Scrubber release (or a keyboard seek) dispatches.
///
/// Commit precedence per the spec: the Scrubber's **own**
/// `.bind(...)` wins, else the **enclosing Video's** bind, else the
/// Scrubber's `.onSeek(@actions.x)` action with the contract payload
/// `{type: "seek", position}`. With none of the three, nothing
/// dispatches. The local seek applies in every case (see
/// `App::commit_scrub`), so the playhead moves even with no wire
/// commit.
///
/// Either bind tier is a `position` write on the bound path, through
/// the same `__hypen_bind` channel a bound `Input` uses.
///
/// Resolution note: the bind target is a *struct*, and `__hypen_bind`
/// carries one `{path, value}` pair. We therefore address the field
/// directly — `"<bind>.position"` — which `path_set` (engine) writes
/// into the nested object. Writing the whole struct instead would
/// clobber `duration` / `state` with renderer-side copies.
pub(crate) fn scrub_commit_dispatch(
    tree: &Tree,
    scrubber_id: &str,
    video_id: Option<&str>,
    position: f64,
) -> Option<(String, serde_json::Value)> {
    let own_bind = tree.get(scrubber_id).and_then(crate::video_v2::bind_path);
    let video_bind = video_id
        .and_then(|id| tree.get(id))
        .and_then(crate::video_v2::bind_path);
    if let Some(bind) = own_bind.or(video_bind) {
        return Some((
            "__hypen_bind".to_string(),
            json!({ "path": format!("{bind}.position"), "value": position }),
        ));
    }
    let node = tree.get(scrubber_id)?;
    let (action, base) = crate::layout::resolve_named_event_action(node, "onSeek")?;
    let mut obj = match base {
        serde_json::Value::Object(o) => o,
        _ => serde_json::Map::new(),
    };
    obj.insert("type".to_string(), json!("seek"));
    obj.insert("position".to_string(), json!(position));
    Some((action, serde_json::Value::Object(obj)))
}

/// One field of the `playback` struct that changed and must be pushed
/// back into module state.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PlaybackFieldReport {
    pub path: String,
    pub value: serde_json::Value,
}

/// Decide which `playback` fields to report for one Video, given the
/// live values and the last report. Pure so the throttle + transition
/// rules are testable without a pipeline or an event loop.
///
/// - `playing` / `state` / `duration` report immediately on change.
/// - `position` reports on a state transition, and otherwise at most
///   every [`PLAYBACK_REPORT_INTERVAL_MS`].
/// - `playing` reports play **intent** ([`VideoPlayerState::play_intent`]),
///   not the raw state: `loading` with intent-to-play (preroll, autoplay
///   start, rebuffer) reports `playing: true` while `state` reports
///   `"loading"`, so a bound toggle doesn't flicker mid-stall.
pub(crate) fn playback_reports(
    bind: &str,
    last: Option<&PlaybackReport>,
    state: VideoPlayerState,
    position: f64,
    duration: f64,
    now: std::time::Instant,
) -> Vec<PlaybackFieldReport> {
    let playing = state.play_intent();
    let mut out = Vec::new();
    let transition = last.map(|l| l.state != state).unwrap_or(true);
    if transition {
        out.push(PlaybackFieldReport {
            path: format!("{bind}.state"),
            value: json!(state.as_str()),
        });
    }
    if last.map(|l| l.playing != playing).unwrap_or(true) {
        out.push(PlaybackFieldReport {
            path: format!("{bind}.playing"),
            value: json!(playing),
        });
    }
    if last
        .map(|l| (l.duration - duration).abs() > f64::EPSILON)
        .unwrap_or(duration > 0.0)
    {
        out.push(PlaybackFieldReport {
            path: format!("{bind}.duration"),
            value: json!(duration),
        });
    }
    let position_changed = last
        .map(|l| (l.position - position).abs() > f64::EPSILON)
        .unwrap_or(true);
    let throttle_elapsed = last
        .map(|l| {
            now.duration_since(l.position_reported_at).as_millis() as u64
                >= PLAYBACK_REPORT_INTERVAL_MS
        })
        .unwrap_or(true);
    if position_changed && (transition || throttle_elapsed) {
        out.push(PlaybackFieldReport {
            path: format!("{bind}.position"),
            value: json!(position),
        });
    }
    out
}

/// What an inbound `playback` write should do to the pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub(crate) struct PlaybackWritePlan {
    /// Drive play/pause to this state (echo/no-op writes are `None`).
    pub set_playing: Option<bool>,
    /// Seek to this clamped position (epsilon-guarded; `None` when the
    /// write matches the actual position within the epsilon).
    pub seek_to: Option<f64>,
}

/// Decide what an inbound `playback` struct write does, given the live
/// pipeline values and the echo-guard state. Pure so the first-bind and
/// echo rules are testable without a pipeline.
///
/// - `playing` — play/pause; `true` on an ended player restarts from
///   zero. Skipped when it matches what we last reported (our own echo
///   coming back around the state loop) or the pipeline's play intent.
/// - `position` — seek, ONLY when it differs from the actual position
///   by more than [`PLAYBACK_SEEK_EPSILON_S`], clamped to
///   `[0, duration]`. When both fields act on an ended player, the
///   restart's seek-to-zero runs first and the explicit seek lands
///   after — restart-from-`ended` yields to an accompanying seek.
/// - `duration` / `state` — renderer-owned, writes ignored.
///
/// `first_application` marks the first write ever applied from a
/// freshly-bound struct. Per the spec it carries **positive intent
/// only**: `playing: true` plays and a `position` seeks, but an
/// initialized `playing: false` cannot cancel an `autoplay` started
/// earlier in the same flush. Every later write is authoritative in
/// both directions.
pub(crate) fn plan_playback_write(
    obj: &serde_json::Map<String, serde_json::Value>,
    first_application: bool,
    last: Option<&PlaybackReport>,
    state: VideoPlayerState,
    position: f64,
    duration: f64,
) -> PlaybackWritePlan {
    let mut plan = PlaybackWritePlan::default();
    if let Some(want_playing) = obj.get("playing").and_then(|v| v.as_bool()) {
        let echo = last.is_some_and(|l| l.playing == want_playing);
        // Intent comparison, matching what the reports carry: a
        // `playing: true` write against a `loading` pipeline that
        // already intends to play is a no-op, not a restart.
        let already = state.play_intent() == want_playing
            && !(want_playing && state == VideoPlayerState::Ended);
        let negative_init = first_application && !want_playing;
        if !echo && !already && !negative_init {
            plan.set_playing = Some(want_playing);
        }
    }
    if let Some(want_position) = obj.get("position").and_then(|v| v.as_f64()) {
        if want_position.is_finite()
            && (want_position - position).abs() > PLAYBACK_SEEK_EPSILON_S
        {
            let mut target = want_position.max(0.0);
            if duration > 0.0 {
                target = target.min(duration);
            }
            plan.seek_to = Some(target);
        }
    }
    plan
}

impl App {
    /// Live `(state, position, duration)` for a Video node.
    pub(crate) fn video_playback_snapshot(
        &self,
        node_id: &str,
    ) -> Option<(VideoPlayerState, f64, f64)> {
        let node = self.tree.get(node_id)?;
        let state = crate::video_v2::player_state(node, self.logical_viewport());
        let (position, duration) = crate::video_v2::position_duration(Some(node_id));
        Some((state, position, duration))
    }

    /// Push renderer → state reports for every Video carrying a
    /// `.bind(@state.playback)`. Called on every patch flush and every
    /// redraw: while playing, the decoder's frame-driven repaints are
    /// what tick this, and the 250 ms throttle keeps the state traffic
    /// bounded regardless of frame rate.
    pub(crate) fn sync_video_bind(&mut self) {
        let viewport = self.logical_viewport();
        let now = std::time::Instant::now();
        let mut pending: Vec<(String, Vec<PlaybackFieldReport>, VideoPlayerState, f64, f64)> =
            Vec::new();
        let detached = self.tree.detached_node_ids();
        let mut alive: std::collections::HashSet<String> = std::collections::HashSet::new();
        for node in self.tree.nodes() {
            if !crate::layout::MEDIA_TYPES
                .iter()
                .any(|t| t.eq_ignore_ascii_case(&node.element_type))
            {
                continue;
            }
            // Detached (Router-cached) players are still alive — only
            // nodes that left the tree entirely lose their side-table
            // entries below.
            alive.insert(node.id.clone());
            // A Router-cached (detached) player is off-screen; its
            // suspension already dispatched the contract `onPause`, and
            // reporting into module state from an invisible route would
            // fight the route that IS on screen.
            if detached.contains(&node.id) {
                continue;
            }
            let Some(bind) = crate::video_v2::bind_path(node) else {
                continue;
            };
            let state = crate::video_v2::player_state(node, viewport);
            let (position, duration) = crate::video_v2::position_duration(Some(&node.id));
            let reports = playback_reports(
                &bind,
                self.video_bind_reports.get(&node.id),
                state,
                position,
                duration,
                now,
            );
            if !reports.is_empty() {
                pending.push((node.id.clone(), reports, state, position, duration));
            }
        }
        for (node_id, reports, state, position, duration) in pending {
            let reported_position = reports.iter().any(|r| r.path.ends_with(".position"));
            for report in reports {
                log::debug!("dispatch (playback bind): {} = {}", report.path, report.value);
                self.module.dispatch_action(
                    "__hypen_bind",
                    Some(json!({ "path": report.path, "value": report.value })),
                );
            }
            let prev = self.video_bind_reports.get(&node_id);
            let position_reported_at = if reported_position {
                now
            } else {
                prev.map(|p| p.position_reported_at).unwrap_or(now)
            };
            let position = if reported_position {
                position
            } else {
                prev.map(|p| p.position).unwrap_or(position)
            };
            self.video_bind_reports.insert(
                node_id,
                PlaybackReport {
                    position,
                    duration,
                    playing: state.play_intent(),
                    state,
                    position_reported_at,
                },
            );
        }
        // Prune the per-node side tables for Videos that left the tree:
        // without this the maps grow with every visited video for the
        // lifetime of the window, and a reused node id would seed the
        // echo guard / one-shot marks with a dead player's values.
        self.video_bind_reports.retain(|id, _| alive.contains(id));
        self.video_playback_applied.retain(|id| alive.contains(id));
        #[cfg(feature = "video")]
        {
            self.video_start_seeked.retain(|id, _| alive.contains(id));
            self.video_pending_bind_seeks
                .retain(|id, _| alive.contains(id));
        }
    }

    /// Apply inbound `playback` writes from module state.
    ///
    /// The engine resolves the bound struct and lands it on the node as
    /// a `SetProp { name: "playback" }`; this scans a freshly-applied
    /// batch for those and drives the pipeline:
    ///
    /// - `playing` — play / pause; `true` on an ended player restarts
    ///   from zero. Skipped when it matches what we last reported (our
    ///   own echo) or the pipeline's actual state.
    /// - `position` — seek, but ONLY when it differs from the renderer's
    ///   actual position by more than [`PLAYBACK_SEEK_EPSILON_S`], and
    ///   clamped to `[0, duration]`. This is the guard that stops the
    ///   250 ms progress reports from coming back around as seeks.
    /// - `duration` / `state` — renderer-owned, writes ignored.
    pub(crate) fn apply_playback_writes(&mut self, patches: &[Patch]) {
        let mut targets: Vec<String> = Vec::new();
        let mut controlled: Vec<String> = Vec::new();
        for patch in patches {
            // A batch can deliver the bound struct either as a fresh
            // mount (`Create` carrying `playback`) or as an update
            // (`SetProp`); both are the same inbound write. A `SetProp`
            // on the plain `playing` prop is the one-way controlled
            // form's play/pause flip (its mount-time start is handled
            // by `sync_video_playback`, like autoplay).
            let (id, is_controlled) = match patch {
                Patch::SetProp { id, name, .. } => {
                    if name == "playback" || name == "playback.0" {
                        (id, false)
                    } else if name == "playing" || name == "playing.0" {
                        (id, true)
                    } else {
                        continue;
                    }
                }
                Patch::Create { id, props, .. } => {
                    if !props.contains_key("playback") && !props.contains_key("playback.0") {
                        continue;
                    }
                    (id, false)
                }
                _ => continue,
            };
            let is_video = self.tree.get(id).is_some_and(|n| {
                crate::layout::MEDIA_TYPES
                    .iter()
                    .any(|t| t.eq_ignore_ascii_case(&n.element_type))
            });
            if !is_video {
                continue;
            }
            let list = if is_controlled {
                &mut controlled
            } else {
                &mut targets
            };
            if !list.iter().any(|t| t == id.as_ref()) {
                list.push(id.to_string());
            }
        }
        // A Router-detached (cached) player is off-screen: driving its
        // pipeline from a state write would resume audio on an invisible
        // route — and `sync_video_playback` could never re-pause it (the
        // suspended flag is already set, so `set_suspended` no-ops).
        // The write is dropped; the suspend/resume contract governs what
        // plays when the route reattaches.
        let detached = self.tree.detached_node_ids();
        for id in targets {
            if detached.contains(&id) {
                continue;
            }
            self.apply_playback_write(&id);
        }
        for id in controlled {
            if detached.contains(&id) {
                continue;
            }
            self.apply_controlled_playing(&id);
        }
    }

    /// Apply a flip of the one-way controlled `playing:` prop. No echo
    /// guard is needed — the renderer never writes into a plain prop,
    /// so the only defence is "the pipeline is already there" (intent
    /// comparison, same as the bind path; `true` on an ended player
    /// still restarts it).
    fn apply_controlled_playing(&mut self, node_id: &str) {
        let Some(want) = self
            .tree
            .get(node_id)
            .and_then(crate::video_v2::controlled_playing)
        else {
            return;
        };
        let Some((state, _, _)) = self.video_playback_snapshot(node_id) else {
            return;
        };
        let already =
            state.play_intent() == want && !(want && state == VideoPlayerState::Ended);
        if !already {
            self.set_video_playing(node_id, want);
        }
    }

    fn apply_playback_write(&mut self, node_id: &str) {
        let Some(value) = self
            .tree
            .get(node_id)
            .and_then(crate::video_v2::playback_value)
            .cloned()
        else {
            return;
        };
        let Some(obj) = value.as_object() else {
            return;
        };
        let Some((state, position, duration)) = self.video_playback_snapshot(node_id) else {
            return;
        };
        let last = self.video_bind_reports.get(node_id).cloned();
        // First application of this node's freshly-bound struct? See
        // `plan_playback_write` — positive intent only.
        let first = self.video_playback_applied.insert(node_id.to_string());
        let plan = plan_playback_write(obj, first, last.as_ref(), state, position, duration);
        if let Some(want_playing) = plan.set_playing {
            self.set_video_playing(node_id, want_playing);
        }
        if let Some(target) = plan.seek_to {
            // Issued through the deferral shim: a pipeline that has not
            // prerolled silently drops seeks, so the write is parked and
            // re-issued once the source becomes seekable.
            self.seek_video_or_defer(node_id, target);
        }
        // `duration` and `state` are renderer-owned: writes ignored.
    }

    /// Drive a player to an explicit playing state and dispatch the
    /// contract event, mirroring what a tap-toggle does.
    pub(crate) fn set_video_playing(&mut self, node_id: &str, playing: bool) {
        #[cfg(feature = "video")]
        {
            // `playing: true` on a node that has no pipeline yet (no
            // `autoplay`, or a source that was never started) is a start
            // request, not a no-op — the same thing a tap would do. It
            // also clears the sticky error, since an explicit write is
            // an explicit retry.
            if playing && !crate::media::has_playback(node_id) {
                let viewport = self.logical_viewport();
                let Some(node) = self.tree.get(node_id) else {
                    return;
                };
                let (src, index) = crate::layout::resolve_media_src(node, viewport);
                let Some(src) = src else { return };
                let opts = crate::media::resolve_play_opts(node);
                self.video_error_keys
                    .remove(&crate::window::video_error_key(node_id, &src));
                self.start_video(node_id, &src, index, &opts);
                self.request_redraw_full();
                return;
            }
            // Snapshot BEFORE driving so a write that asks for the state
            // the pipeline is already in dispatches no contract event —
            // `media::set_playing` is idempotent but can't tell the
            // caller whether it changed anything.
            let was_playing = crate::media::status(node_id)
                .map(|s| !s.paused && !s.ended)
                .unwrap_or(false);
            let Some(now_playing) = crate::media::set_playing(node_id, playing) else {
                return;
            };
            if now_playing == was_playing {
                return;
            }
            let (src, index) = match crate::media::current_track(node_id) {
                Some((u, i)) => (u, i),
                None => return,
            };
            let (event, typ) = if now_playing {
                ("onPlay", "play")
            } else {
                ("onPause", "pause")
            };
            if let Some((action, payload)) =
                self.video_event_payload(node_id, event, typ, &src, index, &[])
            {
                self.module.dispatch_action(&action, Some(payload));
            }
            self.request_redraw_full();
        }
        #[cfg(not(feature = "video"))]
        {
            let _ = (node_id, playing);
        }
    }

    /// Seek a player, updating the last-reported position so the seek's
    /// own progress report doesn't read as a fresh change.
    pub(crate) fn seek_video(&mut self, node_id: &str, seconds: f64) {
        #[cfg(feature = "video")]
        {
            if !crate::media::seek(node_id, seconds) {
                return;
            }
            if let Some(report) = self.video_bind_reports.get_mut(node_id) {
                report.position = seconds;
            }
            self.request_redraw_full();
        }
        #[cfg(not(feature = "video"))]
        {
            let _ = (node_id, seconds);
        }
    }

    /// Seek now when the pipeline can honor it, or park the write until
    /// it can: GStreamer silently drops a `seek_simple` on a pipeline
    /// that has not prerolled, so an inbound `playback.position` write
    /// issued during preroll (e.g. the resume point carried by a bind's
    /// first application, in the same flush that started the autoplay
    /// pipeline) would otherwise be lost. Parked writes are re-issued by
    /// [`Self::apply_pending_bind_seeks`] once the source is seekable,
    /// and dropped if the track changes underneath them.
    #[cfg(feature = "video")]
    fn seek_video_or_defer(&mut self, node_id: &str, seconds: f64) {
        let prerolled = crate::media::status(node_id).is_some_and(|s| s.duration > 0.0);
        if prerolled {
            self.seek_video(node_id, seconds);
            return;
        }
        // Pin the write to the track it targeted: the pipeline's current
        // track when one exists, else the node's resolved source (the
        // pipeline may start later in this same flush, or on a tap).
        let track = crate::media::current_track(node_id)
            .map(|(u, _)| u)
            .or_else(|| {
                let viewport = self.logical_viewport();
                self.tree
                    .get(node_id)
                    .and_then(|n| crate::layout::resolve_media_src(n, viewport).0)
            });
        let Some(track) = track else {
            return; // No source at all — nothing this write can target.
        };
        self.video_pending_bind_seeks
            .insert(node_id.to_string(), (track, seconds));
    }

    #[cfg(not(feature = "video"))]
    fn seek_video_or_defer(&mut self, node_id: &str, seconds: f64) {
        let _ = (node_id, seconds);
    }

    /// Re-issue parked `playback.position` writes (see
    /// [`Self::seek_video_or_defer`]) whose pipeline has become
    /// seekable. Runs alongside `apply_start_positions` on every flush
    /// and frame tick. A write whose track changed underneath it
    /// (playlist advance, retarget) or whose node left the tree is
    /// dropped — it belonged to the old timeline.
    #[cfg(feature = "video")]
    pub(crate) fn apply_pending_bind_seeks(&mut self) {
        if self.video_pending_bind_seeks.is_empty() {
            return;
        }
        let viewport = self.logical_viewport();
        let mut ready: Vec<(String, f64)> = Vec::new();
        let mut dropped: Vec<String> = Vec::new();
        for (id, (url, secs)) in &self.video_pending_bind_seeks {
            let Some(node) = self.tree.get(id) else {
                dropped.push(id.clone());
                continue;
            };
            match crate::media::current_track(id) {
                Some((cur, _)) if &cur == url => {
                    let seekable =
                        crate::media::status(id).is_some_and(|s| s.duration > 0.0);
                    if seekable {
                        ready.push((id.clone(), *secs));
                    }
                }
                // The track moved on — the parked write is stale.
                Some(_) => dropped.push(id.clone()),
                None => {
                    // No pipeline yet: keep waiting while the node still
                    // resolves the same source, drop when it changed.
                    let (src, _) = crate::layout::resolve_media_src(node, viewport);
                    if src.as_deref() != Some(url.as_str()) {
                        dropped.push(id.clone());
                    }
                }
            }
        }
        for id in dropped {
            self.video_pending_bind_seeks.remove(&id);
        }
        for (id, secs) in ready {
            self.video_pending_bind_seeks.remove(&id);
            self.seek_video(&id, secs);
        }
    }

    /// `startPosition`: a one-time seek applied as soon as the source
    /// becomes seekable. "Seekable" here is "the pipeline can answer a
    /// duration query" — i.e. it has prerolled; before that a seek is
    /// silently dropped by GStreamer, which is exactly the bug this
    /// deferral exists to avoid. One-shot per `(node, source
    /// configuration)`: it re-arms when the `src`/`playlist`/`headers`
    /// props change, NOT when a playlist auto-advance moves the current
    /// track — resuming episode 1 at 5:00 must not also skip the first
    /// five minutes of every following episode (spec: "re-arms when the
    /// source configuration changes, not on unrelated prop updates").
    #[cfg(feature = "video")]
    pub(crate) fn apply_start_positions(&mut self) {
        let mut pending: Vec<(String, f64, String)> = Vec::new();
        let viewport = self.logical_viewport();
        for node in self.tree.nodes() {
            if !crate::layout::MEDIA_TYPES
                .iter()
                .any(|t| t.eq_ignore_ascii_case(&node.element_type))
            {
                continue;
            }
            let Some(start) = crate::style::prop_f32_at(node, "startPosition", viewport) else {
                continue;
            };
            if !start.is_finite() || start <= 0.0 {
                continue;
            }
            let config = crate::video_v2::source_config_fingerprint(node);
            if self.video_start_seeked.get(&node.id) == Some(&config) {
                continue;
            }
            // Not prerolled yet (or no pipeline at all) — try again on
            // the next flush / frame.
            let Some(status) = crate::media::status(&node.id) else {
                continue;
            };
            if status.duration <= 0.0 {
                continue;
            }
            pending.push((node.id.clone(), start as f64, config));
        }
        for (id, start, config) in pending {
            self.video_start_seeked.insert(id.clone(), config);
            self.seek_video(&id, start);
        }
    }

    /// Set / clear the sticky playback-error marker on a Video node.
    /// Stored in the tree (see [`crate::video_v2::VIDEO_ERROR_PROP`]) so
    /// the pure layout pass can derive the `error` player state — which
    /// is what shows the `error` slot — without reaching into `App`.
    // Only the `video` feature can produce a *playback* error; without
    // it the error state comes from the poster/probe registry, which
    // `video_v2::player_state` reads directly.
    #[cfg_attr(not(feature = "video"), allow(dead_code))]
    pub(crate) fn mark_video_error(&mut self, node_id: &str, errored: bool) {
        if self.tree.get(node_id).is_none() {
            return;
        }
        if errored {
            self.tree.set_prop_raw(
                node_id,
                crate::video_v2::VIDEO_ERROR_PROP,
                serde_json::Value::Bool(true),
            );
        } else {
            self.tree
                .remove_prop_raw(node_id, crate::video_v2::VIDEO_ERROR_PROP);
        }
        self.tree_generation = self.tree_generation.wrapping_add(1);
        self.layout = None;
        self.painter.invalidate_subtree_cache();
        self.damage.add_full();
    }

    /// `true` when the Video declares a `controls` slot — the spec's
    /// "a present slot replaces the built-in for that concern". The
    /// built-in tap-to-toggle is native chrome, so it stands down; any
    /// author-wired `.onClick` / `onPlay` action still dispatches.
    // Tap-to-toggle only exists with the `video` feature, so the
    // suppression query has no caller without it.
    #[cfg_attr(not(feature = "video"), allow(dead_code))]
    pub(crate) fn video_suppresses_tap(&self, node_id: &str) -> bool {
        tap_suppressed(&self.tree, node_id)
    }

    // -----------------------------------------------------------------
    // Scrubber gesture
    // -----------------------------------------------------------------

    /// Pointer-down on a Scrubber: claim the gesture and seed the drag
    /// preview at the press position. Returns `true` when claimed (the
    /// caller must then repaint and suppress the ordinary click path on
    /// release).
    pub(crate) fn video_scrub_down(&mut self, x: f32, y: f32) -> bool {
        let Some((id, video_id, rect)) = self.layout.as_ref().and_then(|l| {
            l.items
                .iter()
                .rev()
                .find(|it| {
                    matches!(it.kind, crate::layout::ItemKind::Scrubber { .. })
                        && it.hit_contains(x, y)
                })
                .map(|it| {
                    (
                        it.node_id.clone(),
                        it.scrubber_video_id().map(str::to_string),
                        it.rect,
                    )
                })
        }) else {
            return false;
        };
        // A Scrubber outside any Video renders inert per the spec:
        // don't claim the gesture at all — no preview, no commit; the
        // ordinary click path proceeds as if the widget weren't there.
        if video_id.is_none() {
            return false;
        }
        if self.exit_excluded(&id) {
            return false;
        }
        let (lx, _) = self.pointer_to_item_local(&id, x, y);
        let fraction = scrub_fraction_at(rect, lx);
        self.write_scrub_preview(&id, Some(fraction));
        self.video_scrub = Some(VideoScrubDrag {
            scrubber_id: id,
            video_id,
            rect,
            fraction,
            cancelled: false,
        });
        true
    }

    /// Invalidate an in-flight Scrubber drag wired to `video_id` because
    /// the player's track changed under it (playlist auto-advance,
    /// retarget, error release). The captured fraction belongs to the
    /// OLD track's timeline: committing it against the new one would
    /// seek the fresh track to a position the user never chose and write
    /// that position into module state. The gesture record stays until
    /// pointer-up so the release is still consumed (a cancelled scrub is
    /// not a tap), but previews stop and the release commits nothing.
    // Only the `video` feature can advance / retarget / error a live
    // pipeline, so the cancellation has no caller without it.
    #[cfg_attr(not(feature = "video"), allow(dead_code))]
    pub(crate) fn cancel_video_scrub_for(&mut self, video_id: &str) {
        let scrubber_id = match self.video_scrub.as_mut() {
            Some(drag)
                if !drag.cancelled && drag.video_id.as_deref() == Some(video_id) =>
            {
                drag.cancelled = true;
                drag.scrubber_id.clone()
            }
            _ => return,
        };
        self.write_scrub_preview(&scrubber_id, None);
    }

    /// Pointer-move during a Scrubber drag: preview only, no commit and
    /// no module traffic — the point of wiring the widget to the player
    /// renderer-side is that dragging stays responsive even when module
    /// state lives across a WebSocket.
    pub(crate) fn video_scrub_move(&mut self, x: f32, y: f32) -> bool {
        let Some(drag) = self.video_scrub.as_ref() else {
            return false;
        };
        // A cancelled drag (track changed underneath) previews nothing
        // more; it only lingers to swallow the release.
        if drag.cancelled {
            return false;
        }
        let id = drag.scrubber_id.clone();
        let rect = drag.rect;
        let (lx, _) = self.pointer_to_item_local(&id, x, y);
        let fraction = scrub_fraction_at(rect, lx);
        if let Some(drag) = self.video_scrub.as_mut() {
            if (drag.fraction - fraction).abs() < f32::EPSILON {
                return false;
            }
            drag.fraction = fraction;
        }
        self.write_scrub_preview(&id, Some(fraction));
        true
    }

    /// Pointer-up: commit the drag. Returns `true` when a drag was in
    /// flight (the caller then skips the ordinary click dispatch — a
    /// scrub is not a tap).
    pub(crate) fn video_scrub_up(&mut self) -> bool {
        let Some(drag) = self.video_scrub.take() else {
            return false;
        };
        self.write_scrub_preview(&drag.scrubber_id, None);
        // Cancelled mid-flight (the enclosing player's track changed
        // under the gesture): consume the release — a scrub is not a
        // tap, cancelled or not — but commit nothing. The fraction was
        // captured against a timeline that no longer exists.
        if drag.cancelled {
            return true;
        }
        let (_, duration) = crate::video_v2::position_duration(drag.video_id.as_deref());
        let position = (drag.fraction as f64) * duration;
        self.commit_scrub(&drag.scrubber_id, drag.video_id.as_deref(), position);
        true
    }

    /// Keyboard seek on a focused Scrubber (Left / Right, ±5 s).
    /// Immediate commit — no preview phase, matching how a native range
    /// input commits each arrow press.
    pub(crate) fn video_scrub_key(&mut self, delta_s: f64) -> bool {
        let Some(id) = self.focused.clone() else {
            return false;
        };
        if self.exit_excluded(&id) {
            return false;
        }
        // An inert Scrubber (no enclosing Video) takes no keyboard
        // seeks either — the flattening `and_then` returns `None` both
        // when the focused item is not a Scrubber and when it is a
        // loose one.
        let Some(video_id) = self
            .layout
            .as_ref()
            .and_then(|l| l.item_by_id(&id))
            .and_then(|it| match &it.kind {
                crate::layout::ItemKind::Scrubber { video_id, .. } => video_id.clone(),
                _ => None,
            })
        else {
            return false;
        };
        let (position, duration) = crate::video_v2::position_duration(Some(&video_id));
        let mut target = (position + delta_s).max(0.0);
        if duration > 0.0 {
            target = target.min(duration);
        }
        self.commit_scrub(&id, Some(&video_id), target);
        true
    }

    /// Shared commit path for drag-release and keyboard seeks: apply the
    /// seek locally (so the picture moves at gesture latency, not state
    /// round-trip latency — the same optimistic-local-update pattern a
    /// bound `Input` uses for its text) and dispatch the write.
    fn commit_scrub(&mut self, scrubber_id: &str, video_id: Option<&str>, position: f64) {
        if let Some(id) = video_id {
            self.seek_video(id, position);
        }
        let dispatch =
            scrub_commit_dispatch(&self.tree, scrubber_id, video_id, position);
        if let Some((action, payload)) = dispatch {
            log::debug!("dispatch (scrubber commit): {action} payload={payload:?}");
            self.module.dispatch_action(&action, Some(payload));
        }
        self.request_redraw_full();
    }

    /// Write (or clear) the drag preview prop and invalidate, so paint
    /// sees the moved thumb. Bumps the tree generation by hand
    /// (`set_prop_raw` bypasses the patch stream), which forces the next
    /// redraw's layout pass to rebuild from the tree; until then the
    /// CACHED layout is kept and its Scrubber item's `preview` is
    /// patched in place. Dropping the layout here instead would strand
    /// every subsequent `CursorMoved` before the next redraw on
    /// `pointer_to_item_local`'s raw-viewport fallback — a scrubber
    /// under a non-identity transform (entrance/scale animation, an
    /// animated ancestor) would lose transform-aware pointer mapping for
    /// the rest of the frame, every frame of the drag.
    fn write_scrub_preview(&mut self, id: &str, fraction: Option<f32>) {
        match fraction {
            Some(f) => self.tree.set_prop_raw(
                id,
                crate::video_v2::SCRUB_PREVIEW_PROP,
                serde_json::Value::from(f as f64),
            ),
            None => self
                .tree
                .remove_prop_raw(id, crate::video_v2::SCRUB_PREVIEW_PROP),
        }
        self.tree_generation = self.tree_generation.wrapping_add(1);
        if let Some(layout) = self.layout.as_mut() {
            if let Some(item) = layout.item_by_id_mut(id) {
                if let crate::layout::ItemKind::Scrubber { preview, .. } = &mut item.kind {
                    *preview = fraction;
                }
            }
        }
        self.painter.invalidate_subtree_cache();
        self.damage.add_full();
        if let Some(w) = self.window.as_ref() {
            w.request_redraw();
        }
    }
}

/// Keyboard step used by the window's Left / Right handling on a focused
/// Scrubber. Re-exported here so `window_input.rs` doesn't need the
/// `video_v2` import.
pub(crate) const SCRUB_KEY_STEP: f64 = SCRUBBER_KEY_STEP_S;
