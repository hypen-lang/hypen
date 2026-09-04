//! Video v2: player states, the `playback` bind struct, and composition
//! slots.
//!
//! **This module mirrors, verbatim, the normative tables and constants in
//! `hypen-web/packages/core/src/types.ts` (bottom section) and the spec in
//! `hypen-web/docs/components/video.md` §"Playback control & composition
//! slots".** Every renderer keys off one table; when the TS side moves,
//! this file moves with it.
//!
//! What lives here:
//! - [`VideoPlayerState`] — the six contract state names, spelled exactly
//!   as the bind struct reports them.
//! - [`PLAYBACK_REPORT_INTERVAL_MS`] / [`PLAYBACK_SEEK_EPSILON_S`] — the
//!   250 ms report throttle and the 1 s seek epsilon.
//! - [`VIDEO_SLOTS`] / [`slot_visible`] — the visibility table.
//! - [`player_state`] — the desktop derivation of the state machine from
//!   the media registry (feature `video`) or the poster/probe registry
//!   (feature off).
//!
//! Slot children are ordinary tree nodes: they live in the renderer tree,
//! take patches, and keep their state. Only their *layout* (full-bleed
//! overlay of the video rect) and their *emission* (show/hide per the
//! table) are special — see `crate::layout`.

use crate::style::Viewport;
use crate::tree::{Node, Tree};

/// Normative player states — slot visibility and the `playback` bind
/// struct's `state` field use these names verbatim.
/// Mirrors `VideoPlayerState` in core `types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum VideoPlayerState {
    /// No src/playlist resolved, or preload hasn't begun. Poster shows.
    #[default]
    Idle,
    /// A source is resolving / buffering and playback has not begun.
    Loading,
    Playing,
    Paused,
    /// Final track finished, no wrap.
    Ended,
    /// The sticky failure state described in the `onError` section.
    Error,
}

impl VideoPlayerState {
    /// Contract vocabulary — what the bind struct reports.
    pub fn as_str(self) -> &'static str {
        match self {
            VideoPlayerState::Idle => "idle",
            VideoPlayerState::Loading => "loading",
            VideoPlayerState::Playing => "playing",
            VideoPlayerState::Paused => "paused",
            VideoPlayerState::Ended => "ended",
            VideoPlayerState::Error => "error",
        }
    }

    /// Strictly "frames are advancing right now": true only in `playing`.
    /// NOT what the bind struct reports — see [`Self::play_intent`].
    pub fn is_playing(self) -> bool {
        matches!(self, VideoPlayerState::Playing)
    }

    /// The `playing` field of the bind struct reports play **intent**:
    /// it stays `true` through a rebuffer (`state` reports `loading`),
    /// so a play/pause toggle bound to it doesn't flicker mid-stall.
    ///
    /// On desktop `loading` always carries intent-to-play: it arises
    /// only from a live, unpaused pipeline that has not produced a frame
    /// yet (preroll / initial buffering) or from an autoplay start
    /// pending on the current flush — a pipeline paused before its first
    /// frame reads `paused`. `idle` / `paused` / `ended` / `error` all
    /// mean the pipeline does not intend to advance.
    pub fn play_intent(self) -> bool {
        matches!(self, VideoPlayerState::Playing | VideoPlayerState::Loading)
    }
}

/// Renderer → state position reports are throttled to this interval while
/// playing; transitions (play/pause/seek/ended/error) always report
/// immediately. Mirrors `PLAYBACK_REPORT_INTERVAL_MS`.
pub const PLAYBACK_REPORT_INTERVAL_MS: u64 = 250;

/// A `position` write only seeks when it differs from the renderer's
/// actual position by more than this — prevents the renderer's own
/// progress reports from echoing back as seeks. Mirrors
/// `PLAYBACK_SEEK_EPSILON_S`.
pub const PLAYBACK_SEEK_EPSILON_S: f64 = 1.0;

/// Keyboard seek step on a focused `Scrubber` (Left / Right). Not in the
/// TS constants — a desktop-only affordance (the web renderers get it
/// from the native `<input type=range>` step).
pub const SCRUBBER_KEY_STEP_S: f64 = 5.0;

/// Video composition slot names (children tagged `.slot(name)`).
/// Mirrors `VIDEO_SLOTS`.
pub const VIDEO_SLOTS: &[&str] = &["controls", "loading", "error", "poster"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VideoSlotName {
    Controls,
    Loading,
    Error,
    Poster,
}

impl VideoSlotName {
    pub fn as_str(self) -> &'static str {
        match self {
            VideoSlotName::Controls => "controls",
            VideoSlotName::Loading => "loading",
            VideoSlotName::Error => "error",
            VideoSlotName::Poster => "poster",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "controls" => Some(VideoSlotName::Controls),
            "loading" => Some(VideoSlotName::Loading),
            "error" => Some(VideoSlotName::Error),
            "poster" => Some(VideoSlotName::Poster),
            _ => None,
        }
    }
}

/// Normative slot visibility by player state — mirrors
/// `VIDEO_SLOT_VISIBILITY` in core `types.ts`. Every renderer keys
/// show/hide off this single table.
///
/// | Slot | idle | loading | playing | paused | ended | error |
/// |---|---|---|---|---|---|---|
/// | poster | ✅ | ✅ | — | — | ✅ | — |
/// | loading | — | ✅ | — | — | — | — |
/// | controls | ✅ | — | ✅ | ✅ | ✅ | — |
/// | error | — | — | — | — | — | ✅ |
///
/// `controls` is visible in `idle` so a custom controls slot can start
/// first play (play-button-over-poster) — without this, playback would
/// only be reachable via autoplay or module code.
pub fn slot_visible(slot: VideoSlotName, state: VideoPlayerState) -> bool {
    use VideoPlayerState as S;
    use VideoSlotName as N;
    match slot {
        N::Poster => matches!(state, S::Idle | S::Loading | S::Ended),
        N::Loading => matches!(state, S::Loading),
        // Every state but error: idle enables first play, loading keeps a
        // buffering stream's transport reachable (mirrors core types.ts).
        N::Controls => !matches!(state, S::Error),
        N::Error => matches!(state, S::Error),
    }
}

/// Normative paint order of co-visible slots, bottom-to-top:
/// `poster → loading → controls → error`. Lower rank paints first
/// (underneath); hit-testing walks reverse paint order, so a higher
/// rank also wins the pointer. Declaration order does NOT matter —
/// co-visible pairs (poster+loading in `loading`, poster+controls in
/// `idle`/`ended`) always stack per this rank.
pub fn slot_paint_rank(slot: VideoSlotName) -> u8 {
    match slot {
        VideoSlotName::Poster => 0,
        VideoSlotName::Loading => 1,
        VideoSlotName::Controls => 2,
        VideoSlotName::Error => 3,
    }
}

/// Which slots a Video node actually declares. A present slot **replaces**
/// the built-in for that concern, regardless of whether it is currently
/// visible: `controls` suppresses tap-to-toggle + the play glyph, `error`
/// replaces the renderer-drawn error surface, `poster` replaces the
/// `poster` prop's image, `loading` replaces any built-in spinner/glyph
/// while loading.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct SlotPresence {
    pub controls: bool,
    pub loading: bool,
    pub error: bool,
    pub poster: bool,
}

impl SlotPresence {
    pub fn any(&self) -> bool {
        self.controls || self.loading || self.error || self.poster
    }

    fn set(&mut self, slot: VideoSlotName) {
        match slot {
            VideoSlotName::Controls => self.controls = true,
            VideoSlotName::Loading => self.loading = true,
            VideoSlotName::Error => self.error = true,
            VideoSlotName::Poster => self.poster = true,
        }
    }

    /// Whether the painters draw the built-in play affordance. A present
    /// `controls` slot suppresses native chrome outright; `loading` /
    /// `error` slots replace the glyph in their own state.
    pub fn draws_builtin_glyph(&self, state: VideoPlayerState) -> bool {
        if self.controls {
            return false;
        }
        match state {
            VideoPlayerState::Loading if self.loading => false,
            VideoPlayerState::Error if self.error => false,
            _ => true,
        }
    }
}

/// The `slot` prop of a node, if it names a known slot. The engine emits
/// applicator arguments both named and positionally, so `.slot("controls")`
/// lands as `slot.0` (with `slot` as the fallback spelling).
pub fn node_slot(node: &Node) -> Option<VideoSlotName> {
    node.props
        .get("slot.0")
        .or_else(|| node.props.get("slot"))
        .and_then(|v| v.as_str())
        .and_then(VideoSlotName::parse)
}

/// Scan a Video node's direct children for slot tags.
pub fn slot_presence(tree: &Tree, video_id: &str) -> SlotPresence {
    let mut presence = SlotPresence::default();
    for child in tree.children_of(video_id) {
        if let Some(slot) = tree.get(child).and_then(node_slot) {
            presence.set(slot);
        }
    }
    presence
}

/// Renderer-private prop marking a Video node whose playback errored.
/// Written by the window (feature `video`) when it records a sticky
/// `(node, src)` error, cleared on an explicit retry / successful start.
/// Kept in the tree — not in an `App` side table — so the pure layout
/// pass can derive the `error` state without a window handle. Same
/// convention as the animator's `__anim.*` channel.
pub const VIDEO_ERROR_PROP: &str = "__video.error";

/// Renderer-private prop holding a Scrubber's in-flight drag preview
/// (`0..=1` of the enclosing player's duration). Present only between
/// pointer-down-and-claim and release; the release commits and clears it.
pub const SCRUB_PREVIEW_PROP: &str = "__video.scrubPreview";

/// `true` when the node carries the sticky playback-error marker.
fn node_errored(node: &Node) -> bool {
    node.props
        .get(VIDEO_ERROR_PROP)
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Derive the player state for a Video node.
///
/// With feature `video` the registry is authoritative:
/// - sticky error marker, or a bus error on the live player → `error`
/// - EOS → `ended`
/// - user-paused (or Router-suspended, which is a pause the user didn't
///   ask for but which reads identically off-screen) → `paused`
/// - a live pipeline that has not produced a frame yet → `loading`
///   (**coarse buffering detection**: this catches preroll and initial
///   network buffering. Mid-playback rebuffering is NOT detected — that
///   would need `GST_MESSAGE_BUFFERING` plumbed through the bus handler —
///   so a stall stays reported as `playing`. Documented narrowing.)
/// - otherwise → `playing`
/// - no pipeline at all: `loading` when a src is resolved and `autoplay`
///   is set (the pipeline starts on this same flush), else `idle`.
///
/// Without the feature there is no playback, so the state is `idle` —
/// except that a poster/probe fetch which came back with an HTTP failure
/// is exactly the contract's sticky error surface, and reports `error`.
pub fn player_state(node: &Node, viewport: Viewport) -> VideoPlayerState {
    #[cfg(test)]
    if let Some(state) = test_state_override(&node.id) {
        return state;
    }
    if node_errored(node) {
        return VideoPlayerState::Error;
    }
    #[cfg(feature = "video")]
    {
        // A live pipeline is authoritative — checked BEFORE the
        // poster/probe failure registry, so a broken `poster` URL can
        // never override a playing (or paused/ended/loading) pipeline
        // into the sticky `error` state.
        if let Some(status) = crate::media::status(&node.id) {
            if status.errored {
                return VideoPlayerState::Error;
            }
            if status.ended {
                return VideoPlayerState::Ended;
            }
            if status.paused || status.suspended {
                return VideoPlayerState::Paused;
            }
            if !status.has_frame {
                return VideoPlayerState::Loading;
            }
            return VideoPlayerState::Playing;
        }
        let (src, _) = crate::layout::resolve_media_src(node, viewport);
        // `autoplay`, or the one-way controlled form asking to play —
        // either way the pipeline starts on this same flush, and
        // reporting `idle` (or a poster-fetch `error`) here would flash
        // the wrong slot off and on for one flush.
        if src.is_some()
            && (crate::media::prop_truthy(node, "autoplay")
                || controlled_playing(node) == Some(true))
        {
            return VideoPlayerState::Loading;
        }
    }
    // The poster/probe failure registry is the feature-off error source
    // (and, with the feature on, the error source for a player that has
    // no pipeline — it is what `dispatch_media_poster_errors` reports).
    if let Some(poster) = crate::layout::resolve_media_poster(node, viewport) {
        if crate::paint::image::load_failure(&poster).is_some() {
            return VideoPlayerState::Error;
        }
    }
    VideoPlayerState::Idle
}

/// Fingerprint of a Video node's **source configuration** — the props
/// that select what to play: `src` / `source` / positional `0`,
/// `playlist`, and `headers`. This is the spec's `startPosition` re-arm
/// key: the one-shot seek applies once per `(node, source config)`, so
/// a playlist auto-advance (which changes the *current track* but not
/// the config) must NOT re-seek every newly-entered track, while a
/// `src`/`playlist`/`headers` change re-arms it. Unrelated prop updates
/// leave the fingerprint untouched.
#[cfg(feature = "video")]
pub fn source_config_fingerprint(node: &Node) -> String {
    let null = serde_json::Value::Null;
    let src = node
        .props
        .get("src.0")
        .or_else(|| node.props.get("src"))
        .or_else(|| node.props.get("source.0"))
        .or_else(|| node.props.get("source"))
        .or_else(|| node.props.get("0"))
        .unwrap_or(&null);
    let playlist = node
        .props
        .get("playlist")
        .or_else(|| node.props.get("playlist.0"))
        .unwrap_or(&null);
    let headers = crate::media::resolve_headers(node);
    format!("{src}\u{0}{playlist}\u{0}{headers:?}")
}

/// The dotted state path a Video node's `.bind(@state.playback)` targets,
/// if any. The engine writes the *path* into the `bind` prop and the
/// *resolved struct* into the `playback` prop (same shape `Input.bind`
/// uses for `value`).
pub fn bind_path(node: &Node) -> Option<String> {
    node.props
        .get("bind")
        .or_else(|| node.props.get("bind.0"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The `playback` prop's resolved struct (the inbound write channel).
pub fn playback_value(node: &Node) -> Option<&serde_json::Value> {
    node.props
        .get("playback")
        .or_else(|| node.props.get("playback.0"))
}

/// The one-way controlled form — `playing: @{state.isPlaying}` as a
/// plain prop, the spec's "controlled subset": the module drives, the
/// renderer follows, and renderer-initiated changes surface only via
/// events (there is no report loop back into a plain prop). `None`
/// when the prop is absent or not a boolean.
pub fn controlled_playing(node: &Node) -> Option<bool> {
    let v = node
        .props
        .get("playing.0")
        .or_else(|| node.props.get("playing"))?;
    v.as_bool().or(match v.as_str().map(str::trim) {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    })
}

/// Nearest `Video` ancestor of `id` (inclusive of the node's parent
/// chain, exclusive of `id` itself). `None` when the node is not inside a
/// player — a `Scrubber` there renders inert per the spec.
pub fn enclosing_video(tree: &Tree, id: &str) -> Option<String> {
    let mut cur = tree.parent_of(id)?.to_string();
    loop {
        let node = tree.get(&cur)?;
        if crate::layout::MEDIA_TYPES
            .iter()
            .any(|t| t.eq_ignore_ascii_case(&node.element_type))
        {
            return Some(cur);
        }
        cur = tree.parent_of(&cur)?.to_string();
    }
}

// ---------------------------------------------------------------------------
// Renderer-local intents — `.videoIntent("fullscreen")`
// ---------------------------------------------------------------------------

/// A renderer-local video intent: an interaction the renderer performs
/// ITSELF, without an action → module → state round trip. Normative spec:
/// `hypen-web/docs/components/video.md` §"Fullscreen: `videoIntent`".
///
/// Fullscreen is the first one because platforms gate it behind a user
/// gesture (and, on remote apps, a round trip can lose it entirely).
/// Unknown intent names parse to `None` and render inert, so an app can
/// ship a newer intent against an older renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoIntent {
    /// Toggle fullscreen presentation of the player. On desktop the
    /// player has no separate container to promote, so the winit WINDOW
    /// goes borderless-fullscreen: the whole window scales, which keeps
    /// the surface AND the composition slots overlaid on it — the same
    /// guarantee the DOM renderer gets by fullscreening the video
    /// container rather than the raw `<video>`.
    Fullscreen,
}

impl VideoIntent {
    /// Contract spelling, as authored in `.videoIntent("…")`.
    pub fn as_str(self) -> &'static str {
        match self {
            VideoIntent::Fullscreen => "fullscreen",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "fullscreen" => Some(VideoIntent::Fullscreen),
            _ => None,
        }
    }
}

/// The intent a node is tagged with, ignoring where it sits in the tree.
/// `.videoIntent("fullscreen")` lowers to the `videoIntent.0` prop; the
/// bare `videoIntent` alias is accepted the same way slot names are.
pub fn node_intent(node: &Node) -> Option<VideoIntent> {
    node.props
        .get("videoIntent.0")
        .or_else(|| node.props.get("videoIntent"))
        .and_then(|v| v.as_str())
        .and_then(VideoIntent::parse)
}

/// The intent this node actually carries: a tagged node OUTSIDE any Video
/// subtree is inert (same rule as `Scrubber`), so it resolves to `None`
/// and never becomes hittable or focusable on the intent's account.
pub fn intent_for(tree: &Tree, id: &str) -> Option<VideoIntent> {
    let intent = node_intent(tree.get(id)?)?;
    enclosing_video(tree, id).map(|_| intent)
}

/// A Scrubber's in-flight drag preview fraction, if the pointer is down
/// on it.
pub fn scrub_preview(node: &Node) -> Option<f32> {
    node.props
        .get(SCRUB_PREVIEW_PROP)
        .and_then(|v| v.as_f64())
        .map(|v| v as f32)
        .filter(|v| v.is_finite())
}

/// `(position, duration)` in seconds for a player, from the live
/// pipeline. `(0, 0)` without the feature or without a pipeline — the
/// Scrubber then paints an empty track.
pub fn position_duration(video_id: Option<&str>) -> (f64, f64) {
    #[cfg(feature = "video")]
    {
        if let Some(id) = video_id {
            if let Some(status) = crate::media::status(id) {
                return (status.position, status.duration);
            }
        }
    }
    let _ = video_id;
    (0.0, 0.0)
}

/// Progress `0..=1` a Scrubber should paint: the drag preview while a
/// gesture is in flight, otherwise `position / duration`.
pub fn scrubber_fraction(video_id: Option<&str>, preview: Option<f32>) -> f32 {
    if let Some(p) = preview {
        return p.clamp(0.0, 1.0);
    }
    let (position, duration) = position_duration(video_id);
    if duration <= 0.0 {
        return 0.0;
    }
    ((position / duration) as f32).clamp(0.0, 1.0)
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------
//
// The player state is derived from the media registry, which needs a live
// GStreamer pipeline (feature `video`) to reach anything past `idle` /
// `error`. Slot visibility is normative for ALL SIX states, so the layout
// tests need to drive the state directly. A thread-local override does
// that without touching the production path (`#[cfg(test)]`-only, and
// thread-local so parallel tests can't see each other's states).

#[cfg(test)]
thread_local! {
    static TEST_STATES: std::cell::RefCell<std::collections::HashMap<String, VideoPlayerState>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

#[cfg(test)]
fn test_state_override(id: &str) -> Option<VideoPlayerState> {
    TEST_STATES.with(|s| s.borrow().get(id).copied())
}

/// Test-only: force `player_state` for a node id on this thread.
#[cfg(test)]
pub(crate) fn set_test_state(id: &str, state: VideoPlayerState) {
    TEST_STATES.with(|s| s.borrow_mut().insert(id.to_string(), state));
}

/// Test-only: drop every forced state on this thread.
#[cfg(test)]
pub(crate) fn clear_test_states() {
    TEST_STATES.with(|s| s.borrow_mut().clear());
}

#[cfg(test)]
#[path = "video_v2_tests.rs"]
mod tests;
