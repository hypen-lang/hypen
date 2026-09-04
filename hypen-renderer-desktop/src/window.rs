//! winit `ApplicationHandler` + per-window state.
//!
//! Owns the GPU surface, painter, tree, layout cache, and a handle to the
//! `HypenModule` so click events can dispatch actions back. Patches arrive
//! via the shared `PatchQueue`; we drain on every redraw and request a
//! repaint whenever new patches show up.

use crate::accessibility::{renderer_id_for, tree_update_for_layout_excluding};
use crate::anim::{DesktopAnimator, DesktopScrubber, ScrubPointerUp, TickOutcome};
use crate::damage::Damage;
use crate::gpu::Gpu;
use crate::ime::{apply_ime_transition, ImeEffect};
use crate::layout::{ItemKind, LayoutPass, TaffyState};
use crate::style::Viewport;
use crate::module::HypenModule;
use crate::paint::vello_painter::VelloPainter;
use crate::tree::Tree;
use accesskit::Action as AkAction;
use accesskit_winit::{Adapter as AkAdapter, Event as AkEvent, WindowEvent as AkWindowEvent};
use arboard::Clipboard;
use hypen_engine::Patch;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use winit::application::ApplicationHandler;
use winit::dpi::PhysicalPosition;
use winit::event::{ElementState, Ime, KeyEvent, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoopProxy};
use winit::keyboard::{Key, ModifiersState, NamedKey};
use winit::window::{Window, WindowAttributes, WindowId};

/// Anchor + head selection within an `Input`'s text. Both fields are
/// byte offsets into the value string; collapsed (`anchor == head`)
/// means just a caret. Phase 7's cursor model maps to
/// `Selection::caret(n)`; Phase 9 adds the range form.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Selection {
    pub anchor: usize,
    pub head: usize,
}

impl Selection {
    pub fn caret(at: usize) -> Self {
        Self {
            anchor: at,
            head: at,
        }
    }

    pub fn range(anchor: usize, head: usize) -> Self {
        Self { anchor, head }
    }

    pub fn min(self) -> usize {
        self.anchor.min(self.head)
    }

    pub fn max(self) -> usize {
        self.anchor.max(self.head)
    }

    pub fn is_collapsed(self) -> bool {
        self.anchor == self.head
    }

    /// Clamp both fields so neither exceeds `max` bytes. Used after the
    /// underlying value shrinks (e.g. external state change) to keep
    /// the selection in-bounds.
    pub fn clamped(self, max: usize) -> Self {
        Self {
            anchor: self.anchor.min(max),
            head: self.head.min(max),
        }
    }
}

/// A keyboard shortcut binding registered via
/// [`crate::DesktopApp::shortcut`]. When the user presses the
/// described combo, the renderer dispatches `action` against the
/// mounted [`HypenModule`] with the static `payload`.
#[derive(Debug, Clone)]
pub struct ShortcutBinding {
    pub combo: Shortcut,
    pub action: String,
    pub payload: Option<serde_json::Value>,
}

/// A keyboard combo: a `key` (logical character or named key like
/// `"Escape"`) plus a set of required modifiers. `cmd` is the macOS
/// "Command" key; the renderer treats it as interchangeable with
/// `ctrl` so the same binding fires on Linux / Windows / macOS.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Shortcut {
    /// Single-character key (`"l"`, `"r"`, …) — case-insensitive — OR
    /// a winit `NamedKey` debug name (`"Escape"`, `"Enter"`, …).
    pub key: String,
    /// Require Cmd (macOS) / Ctrl (Linux + Windows) to be held.
    pub cmd_or_ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

impl Shortcut {
    /// Bare key, no modifiers. Typical use: `Shortcut::plain("Escape")`.
    pub fn plain(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            cmd_or_ctrl: false,
            shift: false,
            alt: false,
        }
    }

    /// `Cmd+<key>` on macOS / `Ctrl+<key>` elsewhere.
    pub fn cmd(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            cmd_or_ctrl: true,
            shift: false,
            alt: false,
        }
    }

    /// `Cmd+Shift+<key>`.
    pub fn cmd_shift(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            cmd_or_ctrl: true,
            shift: true,
            alt: false,
        }
    }
}

/// User-event type carried through the winit event loop.
#[derive(Debug)]
pub enum AppEvent {
    /// AccessKit-originated event (focus, action requested, etc.).
    Accessibility(AkEvent),
    /// Generic "the world changed, please redraw" wake-up sent by
    /// background workers (image fetcher, future async actions).
    /// We don't carry a payload because the renderer always re-reads
    /// its caches on the next frame.
    Wake,
}

impl From<AkEvent> for AppEvent {
    fn from(e: AkEvent) -> Self {
        AppEvent::Accessibility(e)
    }
}

/// Shared queue between the SDK callback (which fires from
/// `engine.render_callback` on the dispatch thread) and the winit
/// event-loop thread.
#[derive(Default)]
pub struct PatchQueue {
    queued: Mutex<Vec<Patch>>,
}

/// Hard cap so a misbehaving engine can't accumulate gigabytes of
/// patches while the event loop is blocked / window minimised /
/// macOS app-napped. When we hit the cap we drop the OLDEST patches
/// and warn. 200k patches ≈ 10–20 MB of engine wire data — generous
/// for any legitimate burst, far below the GBs we'd see from a leak.
const PATCH_QUEUE_CAP: usize = 200_000;

/// Backstop cap on detached-but-not-freed subtree roots held alive in
/// the Tree + Taffy mirror (see [`Tree::evict_detached_over`]). The
/// engine's own Router keep-alive LRU defaults to ~10 entries and
/// emits `Remove` on eviction, so a healthy session sits in the low
/// tens. This cap is set far above that purely so a host that detaches
/// without ever re-Attaching or Removing (a render loop / buggy
/// server) can't grow the node arena without bound. Hitting it logs a
/// warning.
const DETACHED_SUBTREE_CAP: usize = 1024;

impl PatchQueue {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Returns `true` if the queue went from empty to non-empty —
    /// callers use this to fire `AppEvent::Wake` only on the
    /// rising edge so a chatty engine doesn't flood winit's user
    /// event queue with redundant wake-ups.
    pub fn push(&self, patches: &[Patch]) -> bool {
        if patches.is_empty() {
            return false;
        }
        let mut q = self.queued.lock().expect("patch queue poisoned");
        let was_empty = q.is_empty();
        q.extend_from_slice(patches);
        if q.len() > PATCH_QUEUE_CAP {
            let drop_n = q.len() - PATCH_QUEUE_CAP;
            log::warn!(
                "patch queue at {}; dropping {} oldest — \
                 event loop falling behind the engine (window minimised? \
                 SDK in a render loop?)",
                q.len(),
                drop_n
            );
            q.drain(..drop_n);
        }
        was_empty
    }

    pub fn drain(&self) -> Vec<Patch> {
        let mut q = self.queued.lock().expect("patch queue poisoned");
        std::mem::take(&mut *q)
    }

    pub fn is_empty(&self) -> bool {
        self.queued.lock().expect("patch queue poisoned").is_empty()
    }
}

pub struct App {
    title: String,
    initial_size: (u32, u32),
    queue: Arc<PatchQueue>,
    module: Arc<dyn HypenModule>,
    /// Lowers `RegisterTemplate`/`Instantiate` back into the plain
    /// `Create`+`Insert` runs the rest of the renderer consumes. The
    /// desktop renderer can't exploit template cloning, so every drained
    /// batch is expanded in `flush_patches` before ingestion. Session-
    /// lifetime state: skeletons registered by earlier batches expand
    /// later `Instantiate`s.
    template_expander: hypen_engine::TemplateExpander,
    /// EventLoopProxy used to construct the AccessKit adapter on
    /// `resumed`.
    proxy: EventLoopProxy<AppEvent>,

    window: Option<Arc<Window>>,
    gpu: Option<Gpu>,
    /// Per-window AccessKit adapter. Created in `resumed` and dropped
    /// on close.
    ak: Option<AkAdapter>,
    painter: VelloPainter,
    tree: Tree,
    /// Animation runtime for the `__anim.*` prop channel: every patch
    /// batch routes through [`DesktopAnimator::ingest`] (deferred exits,
    /// enter queuing, batch-animation preludes), and each redraw ticks
    /// it BEFORE layout so interpolated values written into the real
    /// tree props reach Taffy and hit-testing the same frame. While it
    /// has active work the redraw path re-requests a frame (Fifo
    /// presents pace that at vsync); idle, the loop stays demand-driven.
    animator: DesktopAnimator,
    /// Renderer-resident scrub source for the `__anim.scrub*` channel
    /// (Option G). Fed the window's winit pointer/wheel events; interpolates
    /// pose props into the same real [`Tree`] the animator writes. Its owned
    /// ids are synced into the animator each flush for scrub precedence
    /// (scrub > playbacks > transaction > `.transition`), its settle rides
    /// the same demand-driven redraw tick, and its settle writes are drained
    /// into the `__hypen_bind` channel. See [`DesktopScrubber`].
    scrubber: DesktopScrubber,
    /// Retained Taffy structure. Reused across frames; rebuilt only
    /// when its structure-key (tree generation, viewport, scale)
    /// stops matching the current redraw inputs. Saves the per-
    /// frame `TaffyTree` allocation + full renderer-tree walk on
    /// scroll-out-of-buffer / scrollables-changed / resize-where-
    /// only-position-shifted invalidations.
    taffy: TaffyState,

    /// Cached layout from the last paint. Used by hit-testing on click,
    /// hover, drag, and press.
    layout: Option<LayoutPass>,
    cursor: PhysicalPosition<f64>,
    hovered: Option<String>,
    /// Renderer node id of the topmost element under the cursor with
    /// an `.onHover(...)` applicator. Kept separate from `hovered`
    /// because hover-action subjects can be any element type (Row,
    /// Container, …) while `hovered` tracks actionables for tint
    /// damage. Updated on every CursorMoved; on change we fire two
    /// dispatches — leave on the old, enter on the new — so handlers
    /// can flip CSS-:hover-like state on/off.
    hover_subject: Option<String>,
    pressed: Option<String>,
    focused: Option<String>,
    /// `true` when the focused item should show a focus ring — set when
    /// focus moves via the keyboard (Tab), cleared on mouse-click focus.
    /// The `:focus-visible` rule, so clicking doesn't ring buttons/tiles.
    focus_visible: bool,
    modifiers: ModifiersState,

    /// Per-Input selection, keyed by renderer node id. Value lives in
    /// the renderer tree (engine round-trips it on every `__hypen_bind`
    /// dispatch); we only need to remember the caret + selection range
    /// between keystrokes / mouse events.
    input_selections: HashMap<String, Selection>,
    /// Renderer node id of an Input whose text is currently being
    /// drag-selected. `Some(id)` between mouse-down inside that Input
    /// and the next mouse-up; `head` updates on every CursorMoved.
    dragging_input: Option<String>,
    /// Multi-click tracking for double-click-word and triple-click-line
    /// selection. A click within `MULTI_CLICK_MS` and `MULTI_CLICK_PX`
    /// of the previous one bumps `count`; otherwise it resets to 1.
    last_click_at: Option<std::time::Instant>,
    last_click_pos: PhysicalPosition<f64>,
    click_count: u32,
    /// System clipboard handle, lazily created on first copy/paste so
    /// systems without a clipboard server don't fail at startup.
    clipboard: Option<Clipboard>,

    /// Active IME preedit composition: `(focused_input_id, text)`.
    /// While `Some`, the painter renders the text inline at the caret
    /// underlined and `__hypen_bind` dispatch is suppressed. Cleared
    /// on `Ime::Commit` (text becomes the inserted value via
    /// `replace_selection_with`) or `Ime::Disabled`.
    ime_preedit: Option<(String, String)>,
    /// True when the OS IME has been enabled for this window via
    /// `set_ime_allowed(true)`. Mirrors the active focus target so
    /// we toggle off when focus leaves an `Input`.
    ime_active: bool,

    /// Per-frame damage tracking. `Full` is the conservative default
    /// after patches / resize / scroll (anything that moves geometry
    /// or invalidates the whole image). `Region(rect)` accumulates
    /// scoped damage from high-frequency events that only change a
    /// small area — hover and press tints in particular. The redraw
    /// path consumes this and resets to `None`; both the CPU paint
    /// and the GPU upload then operate on the bounding rect only.
    damage: Damage,
    /// Bumps every time `flush_patches` applies one or more Patches.
    /// Feeds the layout cache key — patches mutate the tree, so any
    /// non-empty patch batch invalidates the cached layout.
    tree_generation: u64,
    /// `true` when the current renderer tree has at least one node
    /// carrying a layout-affecting interaction-state variant
    /// (`padding:hover`, `width:focus`, …). Recomputed after every
    /// patch flush. When `false` (the overwhelmingly common case),
    /// hover/press/focus transitions never enter the layout cache key,
    /// so they stay on the repaint-only fast path with zero relayout.
    has_layout_state_variants: bool,
    /// Hash of the inputs that fed the most recent successful layout
    /// pass — excluding page `scroll_y`. Page scroll is applied as a
    /// uniform post-pass shift, so a scroll-only frame can re-shift
    /// the cached layout without recomputing Taffy + measure. Other
    /// changes (patches, resize, per-Container scroll, scale) bump
    /// the key and force a full recompute.
    last_layout_key: Option<u64>,
    /// `scroll_y` baked into `self.layout`'s items. Frames where
    /// `last_layout_key` matches but this differs only need a uniform
    /// y-shift, not a layout recompute.
    last_scroll_y_in_layout: f32,
    /// `scroll_y` at the time `self.layout`'s items were last *emitted*
    /// (cull-buffer origin). The fast path keeps shifting items without
    /// re-emitting, but the cull buffer stays anchored where the items
    /// were originally walked — so the recompute threshold must be
    /// measured against THIS value, not against `last_scroll_y_in_layout`
    /// (which advances every fast-path frame). Without the split, we
    /// never detect divergence and items beyond the original buffer
    /// stay un-emitted forever — the "white forever" scroll bug.
    last_scroll_y_emitted: f32,
    /// Pending resize coalescing. macOS / GNOME emit a burst of
    /// Hash of the last AccessKit tree we published. `None` until the
    /// first publish so an empty layout (whose hash legitimately could
    /// be `0`) doesn't trick us into skipping the very first send.
    /// Lets later frames skip rebuilding + sending the full TreeUpdate
    /// when nothing semantically changed (hover / scroll / etc.).
    last_a11y_fingerprint: Option<u64>,
    /// Bumps every time `redraw` produces a fresh `LayoutPass`
    /// (cache miss) or shifts items in place (scroll fast path).
    /// AccessKit publish skips entirely when this matches the
    /// last-published generation — neither the fingerprint walk
    /// nor the AccessKit `update_if_active` runs on hover / press /
    /// caret-only frames.
    layout_generation: u64,
    /// Last `layout_generation` we ran `publish_accessibility` on.
    last_a11y_layout_generation: u64,
    /// Last `(focused_id, rect)` we passed to `set_ime_cursor_area`.
    /// `None` whenever the OS IME is currently disabled. Lets us
    /// skip the redundant call every frame when the focused Input's
    /// rect hasn't moved.
    last_ime_target: Option<(String, (i32, i32, u32, u32))>,
    /// Vertical page scroll offset in physical pixels.
    scroll_y: f32,
    /// Per-scrollable-Container offsets in physical pixels, keyed by
    /// the container's renderer `node_id`. Populated when the user
    /// rolls the mouse wheel over a Container with `overflow: scroll`
    /// or `overflow: auto`. Clamped against each container's
    /// `ScrollMeta::content_h` after every layout.
    scrollables: HashMap<String, f32>,
    /// Rolling 1-second window for `flush_patches` calls. If the
    /// engine enters a render loop (the suspected culprit behind the
    /// idle-RAM leak), this counts the per-second flush rate and logs
    /// a warning so the user sees it instead of just observing the
    /// symptoms (flicker mid-scroll, posts cycling through images,
    /// scroll snapping back). 60 flushes/sec is well above any
    /// legitimate user-driven cadence — even typing fires <10/sec.
    patch_window_start: Option<std::time::Instant>,
    patch_window_flushes: u32,
    /// True while the window is occluded / hidden by the OS (other
    /// Space, minimised, fully covered). Set / cleared by
    /// `WindowEvent::Occluded`. While true the renderer drains
    /// patches into the Tree to keep state moving but skips paint +
    /// AccessKit publish entirely — no GPU work, no per-frame
    /// allocations. Caches that are cheap to rebuild (image / text
    /// raster tiles) get dropped on the occlude edge so the process
    /// can trim while hidden.
    is_occluded: bool,
    /// Keyboard shortcuts registered via [`crate::DesktopApp::shortcut`].
    /// Checked before the per-key default handling so a binding
    /// always wins over the renderer's built-in Tab / Enter / Space
    /// behaviour. Shortcuts are silenced while an `Input` is focused
    /// (typing in the address bar must not trigger `focus_url` etc.).
    shortcuts: Vec<ShortcutBinding>,
    /// macOS: merge the title bar into the content (Safari-style). Set
    /// via [`App::set_unified_titlebar`]; applied once on window create.
    unified_titlebar: bool,
    /// Video `onError` dedupe: `"node_id\u{0}poster_url"` keys for
    /// which we already dispatched the element's `onError` action.
    /// The failure registry entries are sticky (like
    /// `CacheEntry::Failed`), so without this every worker wake would
    /// re-dispatch the same error.
    dispatched_media_errors: std::collections::HashSet<String>,
    /// Feature `video`: sticky `"node_id\u{0}src"` keys whose playback
    /// start or stream errored. Autoplay reconciliation skips them so
    /// a failing stream can't enter a start → error → restart loop; a
    /// user click clears the key (an explicit retry).
    #[cfg(feature = "video")]
    video_error_keys: std::collections::HashSet<String>,
    /// Feature `video`: last [`crate::media::frame_generation`] folded
    /// into painter-cache invalidation. A decoded frame landing since
    /// the previous build means any cached subtree containing the
    /// video would replay its encode-time frame — same pattern as
    /// `last_image_load_gen` on the painter.
    #[cfg(feature = "video")]
    last_video_frame_gen: u64,
    /// Video v2: last values pushed into each bound Video's `playback`
    /// struct — the 250 ms position throttle and the echo guard against
    /// the renderer's own reports coming back as writes. Keyed by Video
    /// node id. See [`window_video::PlaybackReport`].
    video_bind_reports: HashMap<String, window_video::PlaybackReport>,
    /// Video v2: node ids whose bound `playback` struct has had at least
    /// one write applied. The FIRST application of a freshly-bound
    /// struct carries positive intent only (spec: an initialized
    /// `playing: false` cannot cancel `autoplay`; `playing: true` and a
    /// `position` seek do apply); every later write is authoritative in
    /// both directions. Pruned with `video_bind_reports` when the node
    /// leaves the tree, so an id reuse re-enters first-application mode.
    video_playback_applied: std::collections::HashSet<String>,
    /// Video v2: the in-flight `Scrubber` drag, if any. Preview values
    /// live in the tree; this is the gesture bookkeeping.
    video_scrub: Option<window_video::VideoScrubDrag>,
    /// Feature `video`: per-node fingerprint of the source configuration
    /// (`src`/`playlist`/`headers` — see
    /// [`crate::video_v2::source_config_fingerprint`]) whose one-shot
    /// `startPosition` seek has been applied. The seek re-arms only when
    /// the source configuration changes — a playlist auto-advance keeps
    /// the fingerprint, so newly-entered tracks are NOT re-seeked.
    #[cfg(feature = "video")]
    video_start_seeked: HashMap<String, String>,
    /// Feature `video`: inbound `playback.position` writes that arrived
    /// before their pipeline prerolled, as `node_id -> (track url,
    /// seconds)`. GStreamer silently drops a `seek_simple` on an
    /// un-prerolled pipeline, so the write is parked here and re-issued
    /// when the pipeline can answer a duration query; it is dropped if
    /// the track changes underneath it or the node leaves the tree.
    #[cfg(feature = "video")]
    video_pending_bind_seeks: HashMap<String, (String, f64)>,
}

/// Sticky-error key for a `(video node, src)` pair — mirrors the
/// poster path's `"node_id\u{0}poster"` dedupe keys.
#[cfg(feature = "video")]
pub(crate) fn video_error_key(node_id: &str, src: &str) -> String {
    format!("{node_id}\u{0}{src}")
}

impl App {
    pub fn new(
        title: impl Into<String>,
        initial_size: (u32, u32),
        queue: Arc<PatchQueue>,
        module: Arc<dyn HypenModule>,
        proxy: EventLoopProxy<AppEvent>,
    ) -> Self {
        Self {
            title: title.into(),
            initial_size,
            queue,
            module,
            template_expander: hypen_engine::TemplateExpander::new(),
            proxy,
            window: None,
            gpu: None,
            ak: None,
            painter: VelloPainter::new(),
            tree: Tree::new(),
            animator: DesktopAnimator::new(),
            scrubber: DesktopScrubber::new(),
            taffy: TaffyState::new(),
            layout: None,
            cursor: PhysicalPosition::new(0.0, 0.0),
            hovered: None,
            hover_subject: None,
            pressed: None,
            focused: None,
            focus_visible: false,
            modifiers: ModifiersState::default(),
            input_selections: HashMap::new(),
            dragging_input: None,
            last_click_at: None,
            last_click_pos: PhysicalPosition::new(0.0, 0.0),
            click_count: 0,
            clipboard: None,
            ime_preedit: None,
            ime_active: false,
            damage: Damage::Full,
            tree_generation: 0,
            has_layout_state_variants: false,
            last_layout_key: None,
            last_scroll_y_in_layout: 0.0,
            last_scroll_y_emitted: 0.0,
            last_a11y_fingerprint: None,
            layout_generation: 0,
            last_a11y_layout_generation: 0,
            last_ime_target: None,
            scroll_y: 0.0,
            scrollables: HashMap::new(),
            patch_window_start: None,
            patch_window_flushes: 0,
            is_occluded: false,
            shortcuts: Vec::new(),
            unified_titlebar: false,
            dispatched_media_errors: std::collections::HashSet::new(),
            #[cfg(feature = "video")]
            video_error_keys: std::collections::HashSet::new(),
            #[cfg(feature = "video")]
            last_video_frame_gen: 0,
            video_bind_reports: HashMap::new(),
            video_playback_applied: std::collections::HashSet::new(),
            video_scrub: None,
            #[cfg(feature = "video")]
            video_start_seeked: HashMap::new(),
            #[cfg(feature = "video")]
            video_pending_bind_seeks: HashMap::new(),
        }
    }

    /// Dispatch `onError` for Video elements whose poster fetch came
    /// back with an HTTP error status (the contract's "Desktop —
    /// status from the poster/probe fetch"). The image worker records
    /// non-2xx statuses in a registry and fires `AppEvent::Wake`; this
    /// scan (cheap: one pass over live nodes, gated per node on
    /// element type + a wired `onError`) runs on every wake / patch
    /// flush and dispatches each failure once per `(node, poster)`.
    fn dispatch_media_poster_errors(&mut self) {
        let viewport = self.logical_viewport();
        let pending = collect_media_error_dispatches(
            &self.tree,
            viewport,
            &mut self.dispatched_media_errors,
            &crate::paint::image::load_failure,
        );
        for (action, payload) in pending {
            log::debug!("dispatch (media error): {action} payload={payload:?}");
            self.module.dispatch_action(&action, Some(payload));
        }
    }

    /// Feature `video`: reconcile live playback pipelines with the
    /// current tree. Three jobs, run on every patch flush:
    ///
    /// 1. **Release** — pipelines whose Video node left the tree tear
    ///    down (decoder + network resources freed promptly).
    /// 2. **Autoplay** — a Video node with `autoplay` and a resolved
    ///    src that has no pipeline yet starts playing (skipping
    ///    `(node, src)` pairs with a sticky error).
    /// 3. **Retarget** — a single-src node whose `src` prop changed
    ///    under a live pipeline releases it (and autoplays the new
    ///    src when asked). Playlist nodes are exempt: their current
    ///    track legitimately diverges from `startIndex` after an
    ///    advance.
    /// 4. **Suspend/resume** — nodes inside a Router-`Detach`ed
    ///    subtree keep their pipeline (the cache exists to preserve
    ///    position) but stop advancing; re-`Attach` resumes players
    ///    the user had playing. Autoplay and retarget are deferred
    ///    while detached — they run on the flush that reattaches.
    #[cfg(feature = "video")]
    fn sync_video_playback(&mut self) {
        let viewport = self.logical_viewport();
        let detached = self.tree.detached_node_ids();
        let mut alive: HashSet<String> = HashSet::new();
        let mut to_release: Vec<String> = Vec::new();
        let mut to_start: Vec<(String, String, u64, crate::media::PlayOpts)> = Vec::new();
        let mut suspend_flips: Vec<(String, bool)> = Vec::new();
        for node in self.tree.nodes() {
            if !crate::layout::MEDIA_TYPES
                .iter()
                .any(|t| t.eq_ignore_ascii_case(&node.element_type))
            {
                continue;
            }
            alive.insert(node.id.clone());
            if detached.contains(&node.id) {
                if crate::media::set_suspended(&node.id, true) {
                    suspend_flips.push((node.id.clone(), true));
                }
                continue;
            }
            if crate::media::set_suspended(&node.id, false) {
                suspend_flips.push((node.id.clone(), false));
            }
            let (src, index) = crate::layout::resolve_media_src(node, viewport);
            // `autoplay`, or the one-way controlled form (`playing:` as
            // a plain truthy prop — the spec's "module drives, renderer
            // follows" subset): both mean this node should be playing on
            // sight, including after a `src` retarget. Play/pause flips
            // of the prop on a live pipeline are handled patch-driven in
            // `apply_playback_writes`.
            let autoplay = crate::media::prop_truthy(node, "autoplay")
                || crate::video_v2::controlled_playing(node) == Some(true);
            if let Some((cur_url, _)) = crate::media::current_track(&node.id) {
                let single_src = crate::media::resolve_playlist(node).is_empty();
                if single_src && src.as_deref() != Some(cur_url.as_str()) {
                    to_release.push(node.id.clone());
                    if let Some(src) = src {
                        if autoplay
                            && !self.video_error_keys.contains(&video_error_key(&node.id, &src))
                        {
                            let opts = crate::media::resolve_play_opts(node);
                            to_start.push((node.id.clone(), src, index, opts));
                        }
                    }
                }
                continue;
            }
            let Some(src) = src else { continue };
            if !autoplay {
                continue;
            }
            if self
                .video_error_keys
                .contains(&video_error_key(&node.id, &src))
            {
                continue;
            }
            let opts = crate::media::resolve_play_opts(node);
            to_start.push((node.id.clone(), src, index, opts));
        }
        crate::media::retain_only(&alive);
        for id in to_release {
            crate::media::release(&id);
        }
        for (id, src, index, opts) in to_start {
            self.start_video(&id, &src, index, &opts);
        }
        // Suspension flips map onto the contract's playback events:
        // navigating away pauses (`onPause`), navigating back resumes
        // (`onPlay`) — same payloads a user-initiated toggle sends.
        for (id, suspended) in suspend_flips {
            let Some((src, index)) = crate::media::current_track(&id) else {
                continue;
            };
            let (event, typ) = if suspended {
                ("onPause", "pause")
            } else {
                ("onPlay", "play")
            };
            if let Some((action, payload)) =
                self.video_event_payload(&id, event, typ, &src, index, &[])
            {
                log::debug!("dispatch (video {typ}): {action} payload={payload:?}");
                self.module.dispatch_action(&action, Some(payload));
            }
        }
    }

    /// Feature `video`: start playback of `src` for the node and
    /// dispatch the contract event — `onPlay` on success, `onError`
    /// (code `pipeline`, no status) when the pipeline can't even be
    /// constructed. Failures record a sticky error key so autoplay
    /// doesn't retry-loop.
    #[cfg(feature = "video")]
    fn start_video(&mut self, node_id: &str, src: &str, index: u64, opts: &crate::media::PlayOpts) {
        // A fresh pipeline invalidates any Scrubber drag captured on the
        // old one (its fraction belongs to the old track's timeline) and
        // clears the Video v2 sticky-error marker (which is what shows
        // the `error` slot); a later failure sets it again below. The
        // one-shot `startPosition` seek re-arms on source-configuration
        // changes only (`apply_start_positions`), not on restarts.
        self.cancel_video_scrub_for(node_id);
        self.mark_video_error(node_id, false);
        match crate::media::start(node_id, src, index, opts, true) {
            Ok(true) => {
                if let Some((action, payload)) =
                    self.video_event_payload(node_id, "onPlay", "play", src, index, &[])
                {
                    log::debug!("dispatch (video play): {action} payload={payload:?}");
                    self.module.dispatch_action(&action, Some(payload));
                }
            }
            // The pipeline failed synchronously but its bus already
            // queued the structured error — `pump_media_events` will
            // dispatch the single `onError` and record the sticky key.
            Ok(false) => {}
            Err(e) => {
                log::warn!("video: failed to start {src} for {node_id}: {e}");
                self.video_error_keys.insert(video_error_key(node_id, src));
                // Video v2: the sticky error is also the `error` player
                // state, which is what shows an `error` composition slot.
                self.mark_video_error(node_id, true);
                if let Some((action, payload)) = self.video_event_payload(
                    node_id,
                    "onError",
                    "error",
                    src,
                    index,
                    &[("code", json!("pipeline")), ("message", json!(e))],
                ) {
                    self.module.dispatch_action(&action, Some(payload));
                }
            }
        }
    }

    /// Feature `video`: build a contract event dispatch for the node's
    /// `event` action prop (`onPlay` / `onPause` / `onEnded` /
    /// `onTrackChange` / `onError`). `None` when the node is gone or
    /// the action isn't wired. Payload is the contract's
    /// `{ type, src, index, ...extra }` merged over any static named
    /// args from the applicator.
    #[cfg(feature = "video")]
    fn video_event_payload(
        &self,
        node_id: &str,
        event: &str,
        typ: &str,
        src: &str,
        index: u64,
        extra: &[(&str, serde_json::Value)],
    ) -> Option<(String, serde_json::Value)> {
        let node = self.tree.get(node_id)?;
        let (action, base) = crate::layout::resolve_named_event_action(node, event)?;
        let mut obj = match base {
            serde_json::Value::Object(o) => o,
            _ => serde_json::Map::new(),
        };
        obj.insert("type".to_string(), json!(typ));
        obj.insert("src".to_string(), json!(src));
        obj.insert("index".to_string(), json!(index));
        for (k, v) in extra {
            obj.insert((*k).to_string(), v.clone());
        }
        Some((action, serde_json::Value::Object(obj)))
    }

    /// Feature `video`: drain playback events (EOS / errors) from the
    /// media registry and route them per the contract — playlist
    /// advance + `onTrackChange`, queue wrap under `loop`, terminal
    /// `onEnded {completed: true}`, and `onError` with best-effort
    /// HTTP status. Called from every patch flush / wake.
    #[cfg(feature = "video")]
    fn pump_media_events(&mut self) {
        let events = crate::media::take_events();
        if events.is_empty() {
            return;
        }
        let viewport = self.logical_viewport();
        for ev in events {
            if self.tree.get(&ev.node_id).is_none() {
                // Node removed while the event was in flight.
                crate::media::release(&ev.node_id);
                continue;
            }
            let (cur_src, cur_idx) = match crate::media::current_track(&ev.node_id) {
                Some((u, i)) => (u, i),
                None => {
                    let node = self.tree.get(&ev.node_id).expect("checked above");
                    let (s, i) = crate::layout::resolve_media_src(node, viewport);
                    (s.unwrap_or_default(), i)
                }
            };
            match ev.kind {
                crate::media::MediaEventKind::Ended => {
                    let node = self.tree.get(&ev.node_id).expect("checked above");
                    let playlist = crate::media::resolve_playlist(node);
                    let wraps = crate::media::prop_truthy(node, "loop");
                    let opts = crate::media::resolve_play_opts(node);
                    let next = if playlist.is_empty() {
                        None
                    } else {
                        let n = cur_idx + 1;
                        if (n as usize) < playlist.len() {
                            Some((playlist[n as usize].clone(), n))
                        } else if wraps {
                            Some((playlist[0].clone(), 0))
                        } else {
                            None
                        }
                    };
                    match next {
                        Some((next_src, next_idx)) => {
                            // Finished track first (`completed: false`
                            // — the queue continues), then advance and
                            // announce the new track.
                            if let Some((action, payload)) = self.video_event_payload(
                                &ev.node_id,
                                "onEnded",
                                "ended",
                                &cur_src,
                                cur_idx,
                                &[("completed", json!(false))],
                            ) {
                                self.module.dispatch_action(&action, Some(payload));
                            }
                            // An in-flight Scrubber drag was captured on
                            // the finished track's timeline: committing
                            // its fraction against the NEW track would
                            // seek it to a position the user never chose
                            // (and write it into module state). Cancel
                            // the gesture before advancing.
                            self.cancel_video_scrub_for(&ev.node_id);
                            match crate::media::start(&ev.node_id, &next_src, next_idx, &opts, true)
                            {
                                Ok(true) => {
                                    if let Some((action, payload)) = self.video_event_payload(
                                        &ev.node_id,
                                        "onTrackChange",
                                        "trackchange",
                                        &next_src,
                                        next_idx,
                                        &[],
                                    ) {
                                        self.module.dispatch_action(&action, Some(payload));
                                    }
                                }
                                // Bus error already queued — the next
                                // pump pass dispatches the `onError`
                                // and records the sticky key.
                                Ok(false) => {}
                                Err(e) => {
                                    log::warn!(
                                        "video: playlist advance to {next_src} failed: {e}"
                                    );
                                    self.video_error_keys
                                        .insert(video_error_key(&ev.node_id, &next_src));
                                    self.mark_video_error(&ev.node_id, true);
                                    if let Some((action, payload)) = self.video_event_payload(
                                        &ev.node_id,
                                        "onError",
                                        "error",
                                        &next_src,
                                        next_idx,
                                        &[("code", json!("pipeline")), ("message", json!(e))],
                                    ) {
                                        self.module.dispatch_action(&action, Some(payload));
                                    }
                                }
                            }
                        }
                        None => {
                            // Queue (or single track) done. The player
                            // stays registered in its ended state — the
                            // painter shows the last frame + play glyph
                            // and a click restarts from zero.
                            if let Some((action, payload)) = self.video_event_payload(
                                &ev.node_id,
                                "onEnded",
                                "ended",
                                &cur_src,
                                cur_idx,
                                &[("completed", json!(true))],
                            ) {
                                self.module.dispatch_action(&action, Some(payload));
                            }
                        }
                    }
                }
                crate::media::MediaEventKind::Error {
                    code,
                    message,
                    status,
                } => {
                    log::warn!(
                        "video: {} failed for {}: {code}: {message} (status {status:?})",
                        cur_src,
                        ev.node_id
                    );
                    self.video_error_keys
                        .insert(video_error_key(&ev.node_id, &cur_src));
                    self.mark_video_error(&ev.node_id, true);
                    // The pipeline is going away — an in-flight Scrubber
                    // drag on it has nothing left to commit against.
                    self.cancel_video_scrub_for(&ev.node_id);
                    // Quiet error state per the contract: the pipeline
                    // goes away and the poster / dark box shows again.
                    crate::media::release(&ev.node_id);
                    let mut extra = vec![("code", json!(code)), ("message", json!(message))];
                    if let Some(s) = status {
                        extra.push(("status", json!(s)));
                    }
                    if let Some((action, payload)) = self.video_event_payload(
                        &ev.node_id,
                        "onError",
                        "error",
                        &cur_src,
                        cur_idx,
                        &extra,
                    ) {
                        self.module.dispatch_action(&action, Some(payload));
                    }
                }
            }
        }
        self.request_redraw_full();
    }

    /// Perform a renderer-local video intent (`.videoIntent("…")`).
    ///
    /// Presentation only: no action is dispatched, no module is
    /// involved, and the player's state / events are untouched — the
    /// pipeline keeps running and the composition slots keep painting,
    /// they just paint into a bigger window.
    ///
    /// Deliberately NOT behind the `video` cargo feature: a poster-only
    /// build (no GStreamer) still has a window to fullscreen, and the
    /// intent must behave the same there.
    pub(crate) fn perform_video_intent(&mut self, intent: crate::video_v2::VideoIntent) {
        match intent {
            crate::video_v2::VideoIntent::Fullscreen => self.toggle_window_fullscreen(),
        }
    }

    /// Toggle the winit window between borderless fullscreen (current
    /// monitor, `None` = the one the window is on) and its previous
    /// windowed geometry. Desktop has no per-player container to
    /// promote the way the DOM wrapper does, so the WINDOW is the
    /// fullscreen target: everything painted — video surface and the
    /// slot chrome overlaid on it — scales together.
    ///
    /// Thin by design: it is the one line this crate cannot exercise
    /// headlessly (no `Window` without an event loop), so all the
    /// resolution logic lives in layout / `window_input` where tests
    /// can reach it.
    fn toggle_window_fullscreen(&mut self) {
        let Some(window) = self.window.as_ref() else {
            return;
        };
        if window.fullscreen().is_some() {
            window.set_fullscreen(None);
        } else {
            window.set_fullscreen(Some(winit::window::Fullscreen::Borderless(None)));
        }
    }

    /// Feature `video`: a click that landed on a Video surface toggles
    /// playback — start (or restart-after-error, treating the click as
    /// an explicit retry), pause, or resume — and dispatches the
    /// matching contract event (`onPlay` / `onPause`). Returns `true`
    /// when the toggle ran and handled its own dispatch; the caller
    /// must then skip a *derived* `onPlay` item action (payload
    /// `type == "play"`) so the event doesn't double-fire, while an
    /// explicit `.onClick` action still dispatches alongside.
    #[cfg(feature = "video")]
    pub(crate) fn handle_video_click(&mut self, node_id: &str) -> bool {
        // Video v2: a present `controls` slot replaces the built-in
        // chrome, and tap-to-toggle IS the built-in chrome on desktop.
        // The author's own transport buttons drive playback instead;
        // any `.onClick` / `onPlay` wired on the surface still fires
        // through the normal item-action path.
        if self.video_suppresses_tap(node_id) {
            return false;
        }
        let viewport = self.logical_viewport();
        let Some(node) = self.tree.get(node_id) else {
            return false;
        };
        let (src, index) = match crate::media::current_track(node_id) {
            Some((u, i)) => (Some(u), i),
            None => crate::layout::resolve_media_src(node, viewport),
        };
        let Some(src) = src else {
            return false;
        };
        let opts = crate::media::resolve_play_opts(node);
        if crate::media::has_playback(node_id) {
            let event = match crate::media::toggle(node_id) {
                Some(true) => "onPlay",
                Some(false) => "onPause",
                None => return false,
            };
            let typ = if event == "onPlay" { "play" } else { "pause" };
            if let Some((action, payload)) =
                self.video_event_payload(node_id, event, typ, &src, index, &[])
            {
                log::debug!("dispatch (video {typ}): {action} payload={payload:?}");
                self.module.dispatch_action(&action, Some(payload));
            }
        } else {
            // Clicking is an explicit retry: forget any sticky error
            // for this (node, src) so the user can recover from a
            // transient failure.
            self.video_error_keys
                .remove(&video_error_key(node_id, &src));
            self.start_video(node_id, &src, index, &opts);
        }
        self.request_redraw_full();
        true
    }

    /// Enable the macOS Safari-style unified title bar. Applied on
    /// window creation in `resumed`.
    pub fn set_unified_titlebar(&mut self, on: bool) {
        self.unified_titlebar = on;
    }

    /// Replace the shortcut table. Called once by
    /// [`crate::DesktopApp::run`] after all bindings have been
    /// registered.
    pub fn set_shortcuts(&mut self, shortcuts: Vec<ShortcutBinding>) {
        self.shortcuts = shortcuts;
    }

    /// True when the Ctrl (Linux/Windows) or Cmd (macOS) modifier is
    /// held — the prefix for clipboard / select-all shortcuts.
    fn clipboard_modifier(&self) -> bool {
        self.modifiers.control_key() || self.modifiers.super_key()
    }

    fn clipboard_get(&mut self) -> Option<&mut Clipboard> {
        if self.clipboard.is_none() {
            self.clipboard = Clipboard::new().ok();
        }
        self.clipboard.as_mut()
    }

    /// Drain the patch queue into the Tree + Taffy mirror. Returns
    /// the number of patches applied so callers can log throughput
    /// (specifically the occluded path, which is where queue
    /// accumulation hurts most).
    fn flush_patches(&mut self) -> usize {
        let scale = self
            .window
            .as_ref()
            .map(|w| w.scale_factor() as f32)
            .unwrap_or(1.0);
        let viewport = self.logical_viewport();
        // Lower template patches first: everything downstream (scrubber,
        // animator, Tree, Taffy mirror) consumes the plain wire.
        let mut patches = self.template_expander.expand(self.queue.drain());
        let n = patches.len();
        if n == 0 {
            // Overdue-exit backbone: even a patch-less flush (occluded
            // Wake / about_to_wait drain) finalizes deferred exits whose
            // `duration + delay + 80ms` window elapsed while the redraw
            // ticker was stalled — the corpse must not outlive its
            // grace period just because no frames are being painted.
            self.finalize_overdue_exits(scale, viewport);
            self.dispatch_animation_completions();
            // Playback events (EOS / stream errors) arrive without any
            // patch traffic; route them even on a patch-less flush.
            #[cfg(feature = "video")]
            {
                self.pump_media_events();
                self.sync_video_playback();
                self.apply_start_positions();
                self.apply_pending_bind_seeks();
            }
            // Video v2: player state advances (preroll → playing, EOS →
            // ended) without any patch traffic either, so the `playback`
            // bind reports ride the patch-less flush too.
            self.sync_video_bind();
            return 0;
        }
        // Scrub source gets first crack at the batch (Option G, gesture
        // wins): it registers `__anim.scrub*` channels, cancels on
        // remove/detach, cleans up on the matching `__anim.states` label,
        // and SWALLOWS engine SetProps to a scrub-owned node's scrubbed keys
        // (removing them here so neither the tree nor the animator applies
        // them; the latest value replays at cleanup). Then sync the owned
        // set into the animator so this batch's transaction/pose/FLIP/shared
        // paths exclude scrub-active nodes (scrub > playbacks > transaction >
        // `.transition`).
        self.scrubber.pre_ingest(&mut patches, &mut self.tree);
        self.animator.set_scrub_active(self.scrubber.owned_ids());
        self.dispatch_scrub_binds();
        // FLIP pre-pass (before the batch mutates the tree): snapshot
        // First rects off the still-current PRE-batch layout for every
        // `Move` patch whose node carries a `.layout` spec, AND (#146) for
        // the `.layout` siblings sharing a parent with any `Remove` in the
        // batch — a removal reflows those siblings but emits no `Move`
        // patch for them. The Last measurement and the playback run in
        // `redraw`, once the post-batch layout exists
        // (`play_pending_flips`). For flagged/exit removes the sibling FLIP
        // measures zero here (the node holds flow until it settles) and
        // runs at exit finalize instead (`queue_removal_sibling_flips`).
        {
            let prev_layout = &self.layout;
            let tree = &self.tree;
            self.animator.prepare_moves(tree, &patches, |id| {
                prev_layout
                    .as_ref()
                    .and_then(|l| l.item_by_id(id))
                    .map(|it| (it.rect.x, it.rect.y))
            });
            // Shared-element pre-pass (Option H, protocol step 1): snapshot
            // the on-screen `visual_rect` of every keyed node under a batch
            // detach root off the still-current PRE-batch layout, BEFORE
            // the batch mutates the tree. The Last measurement and the FLIP
            // run in `redraw`, once the post-batch layout exists
            // (`play_shared_flips`). `visual_rect` (not `rect`) is the
            // desktop `getBoundingClientRect`: it reflects any in-flight
            // transform, so a mid-flight second navigation retargets for
            // free (protocol step 5).
            self.animator.prepare_shared(tree, &patches, |id| {
                prev_layout.as_ref().and_then(|l| l.item_by_id(id)).map(|it| {
                    let r = it.visual_rect();
                    (r.x, r.y, r.w, r.h)
                })
            });
        }
        // Route the batch through the animation runtime: it honors the
        // batch-head `batchAnimation` prelude, defers flagged Removes
        // whose roots carry playable exit specs, queues enters, and
        // applies everything else to the Tree. `outcome.forwarded` is
        // what actually reached the tree — the Taffy mirror below must
        // see exactly that (withheld exit removals reach Taffy later,
        // when the exit finalizes), and `outcome.restyle` carries the
        // end-of-batch essential-snap writes whose Taffy styles must
        // follow immediately.
        let outcome = self.animator.ingest(&patches, &mut self.tree);
        // Exit-animating subtrees are engine-side dead the moment their
        // flagged Remove arrived: focus must not stay on (or under)
        // one. Clear it now and never restore onto it — Tab traversal
        // and every hit-test path exclude exiting ids, so nothing can
        // re-select the corpse while its exit plays.
        if clear_focus_if_exiting(
            &self.animator,
            &self.tree,
            &mut self.focused,
            &mut self.focus_visible,
        ) {
            self.ime_preedit = None;
        }
        self.tree_generation = self.tree_generation.wrapping_add(1);
        // Dropping the cached layout unconditionally on any non-empty
        // batch is LOAD-BEARING for `.layout` FLIP correctness, not just a
        // cache hygiene nicety: `play_pending_flips` (in `redraw`) needs a
        // fresh cache-MISS so the post-batch `Last` rect is measured off
        // newly-solved Taffy geometry rather than a stale cached pass. If a
        // future change makes this conditional (e.g. keep the layout when a
        // batch "looks" paint-only), the First/Last delta collapses to zero
        // and every Move/removal-sibling FLIP silently stops inverting.
        self.layout = None;
        // Patches changed something somewhere in the tree, so the
        // painter's subtree scene cache is potentially stale: a prop
        // change inside any cached Post / Grid cell / etc. would
        // make its previously-encoded Vello scene wrong. Per-key
        // invalidation would require tracking which subtree each
        // patch's `id` belongs to — far more bookkeeping than the
        // bulk drop costs. The next paint pass rebuilds fragments
        // for whatever is still visible; off-screen subtrees just
        // don't re-cache until they scroll into view.
        self.painter.invalidate_subtree_cache();
        // Rolling 1-second flush-rate counter. The engine sending
        // patches per-frame (suspected render loop) is the most
        // plausible cause of: stale post images cycling during
        // scroll, scroll position snapping back to top, and the
        // idle-RAM leak. The renderer can't tell from a single batch
        // whether it's legitimate, so we surface the rate instead.
        let now = std::time::Instant::now();
        match self.patch_window_start {
            Some(start) if now.duration_since(start).as_secs() >= 1 => {
                if self.patch_window_flushes >= 60 {
                    log::warn!(
                        "engine flushed {} patch batches in the last second \
                         ({} patches just now) — looks like a render loop on the \
                         engine/module side; visual artefacts (stale images, \
                         scroll reset) follow from this",
                        self.patch_window_flushes,
                        n,
                    );
                }
                self.patch_window_start = Some(now);
                self.patch_window_flushes = 1;
            }
            Some(_) => {
                self.patch_window_flushes = self.patch_window_flushes.saturating_add(1);
            }
            None => {
                self.patch_window_start = Some(now);
                self.patch_window_flushes = 1;
            }
        }
        // Apply the same patches incrementally to the retained
        // Taffy tree so it stays mirrored without paying a full
        // structural rebuild on the next compute. `apply_patches`
        // returns false only on patches it didn't handle — fall
        // back to a bulk rebuild then.
        if !self
            .taffy
            .apply_patches(&outcome.forwarded, &self.tree, scale, viewport)
        {
            self.taffy.mark_needs_rebuild();
        }
        // End-of-batch essential snaps landed layout-affecting targets
        // directly in the tree (no SetProp for `apply_patches` to see):
        // restyle their Taffy nodes so geometry leaves the mid-flight
        // pose now, not at the next unrelated restyle.
        for id in &outcome.restyle {
            self.taffy.restyle_node(id, &self.tree, scale, viewport);
        }
        // Backstop: if detached subtrees have piled up past the cap
        // (host detaching without ever re-Attaching or Removing), tear
        // down the oldest and mirror the teardown into Taffy AND the
        // animator. No-op in the common case.
        for evicted in evict_detached_backstop(
            &mut self.tree,
            &mut self.taffy,
            &mut self.animator,
            DETACHED_SUBTREE_CAP,
        ) {
            // The scrub source keeps per-node records too; an evicted
            // detached root's subtree leaves the arena, so its entries go.
            self.scrubber.forget(&evicted);
        }
        // Recompute the layout-state-variant gate for the new tree.
        // Cheap whole-tree scan, runs only on patch flush (not per
        // frame). Drives whether interaction transitions participate in
        // the layout cache key + are threaded into the layout pass.
        self.has_layout_state_variants = self
            .tree
            .nodes()
            .any(crate::style::node_has_layout_state_variant);
        self.damage.add_full();
        self.finalize_overdue_exits(scale, viewport);
        // Route any `.onAnimationComplete` dispatches queued by this batch's
        // exit finalizes (defensive re-Create supersede fires none) and the
        // overdue backbone to the module.
        self.dispatch_animation_completions();
        // A batch may have just created / re-pointed a Video whose
        // poster already sits in the failure registry (sticky Failed →
        // no further worker wake for it). Catch those here.
        self.dispatch_media_poster_errors();
        // Feature `video`: the batch may have created, removed, or
        // re-pointed Video nodes — reconcile playback pipelines and
        // route any pending EOS / error events.
        #[cfg(feature = "video")]
        {
            self.pump_media_events();
            self.sync_video_playback();
            self.apply_start_positions();
            self.apply_pending_bind_seeks();
        }
        // Video v2: a `playback` write from module state arrives as a
        // `SetProp` on the Video's `playback` prop — apply it to the
        // pipeline (play/pause, epsilon-guarded seek), then push the
        // resulting renderer → state reports.
        self.apply_playback_writes(&outcome.forwarded);
        self.sync_video_bind();
        n
    }

    /// Timeout backbone for deferred exits (`duration + delay + 80ms`):
    /// finalizes exits whose grace window elapsed even when the redraw
    /// ticker stalled (occluded window drains still call this via
    /// `flush_patches`). The normal settle path is `DesktopAnimator::
    /// tick` inside `redraw`.
    /// Viewport width in LOGICAL CSS pixels, for Tailwind breakpoint
    /// selection.
    ///
    /// The GPU surface is sized in PHYSICAL pixels, but the breakpoints it
    /// gets compared against (`sm` 640 … `xl` 1280) are CSS pixels. Feeding
    /// the surface width straight in doubled the apparent viewport on a 2x
    /// display, so a 520pt window reported 1040 and matched `lg` — the
    /// home-screen launcher picked `lg:max-w-[300px]` for its dock and
    /// `lg:max-w-[290px]` for its icon grid instead of the base widths, and
    /// the dock's fourth icon overflowed its container.
    ///
    /// Lengths stay physical (taffy styles multiply by `scale`); only the
    /// breakpoint comparison is logical.
    /// The window content box in logical (CSS) px — the basis for
    /// Tailwind breakpoints and `vh`/`vw`/`vmin`/`vmax`. wgpu reports
    /// the surface in physical px, so this divides by the scale factor.
    fn logical_viewport(&self) -> Viewport {
        let physical = self
            .gpu
            .as_ref()
            .map(|g| (g.size.0 as f32, g.size.1 as f32))
            .unwrap_or((0.0, 0.0));
        let scale = self
            .window
            .as_ref()
            .map(|w| w.scale_factor() as f32)
            .unwrap_or(1.0);
        crate::layout::logical_viewport((physical.0 as u32, physical.1 as u32), scale)
    }

    fn finalize_overdue_exits(&mut self, scale: f32, viewport: Viewport) {
        let overdue = self.animator.finalize_overdue(&mut self.tree);
        if overdue.is_empty() {
            return;
        }
        // #146 sibling-shift: an overdue exit finalize reflows the exiting
        // root's `.layout` siblings. Snapshot their First off the
        // still-current pre-teardown layout before it is dropped just
        // below, so the next redraw's fresh-layout `play_pending_flips`
        // slides them.
        {
            let prev_layout = &self.layout;
            self.animator.queue_removal_sibling_flips(|id| {
                prev_layout
                    .as_ref()
                    .and_then(|l| l.item_by_id(id))
                    .map(|it| (it.rect.x, it.rect.y))
            });
        }
        self.tree_generation = self.tree_generation.wrapping_add(1);
        self.layout = None;
        self.painter.invalidate_subtree_cache();
        if !self
            .taffy
            .apply_patches(&overdue, &self.tree, scale, viewport)
        {
            self.taffy.mark_needs_rebuild();
        }
        self.damage.add_full();
    }

    /// Programmatic reduced-motion toggle (see the `HYPEN_REDUCED_MOTION`
    /// env var on [`DesktopAnimator`] for the config-flag default). The
    /// live toggle mirrors the web renderers: ON snaps all in-flight
    /// work except `.motion(essential)` nodes, OFF restarts `.animate`
    /// presets.
    pub fn set_reduced_motion(&mut self, on: bool) {
        // Scrub follows the same per-node rule as `.states`: dragging is
        // direct manipulation (always live), only the release settle snaps
        // under reduced motion (with the `.motion(essential)` per-node
        // exemption). Mirror the flag onto the scrubber.
        self.scrubber.set_reduced_motion(on);
        let scale = self
            .window
            .as_ref()
            .map(|w| w.scale_factor() as f32)
            .unwrap_or(1.0);
        let viewport = self.logical_viewport();
        let frame = drive_reduced_motion_toggle(
            &mut self.animator,
            &mut self.tree,
            &mut self.taffy,
            scale,
            viewport,
            on,
        );
        if frame.invalidate {
            self.tree_generation = self.tree_generation.wrapping_add(1);
            self.layout = None;
            self.painter.invalidate_subtree_cache();
        }
        // Request a frame when the toggle wrote anything OR left work
        // in flight. The second condition is what wakes an idle window
        // after toggling OFF: restarting `.animate` presets writes
        // nothing yet (the outcome is empty), but the restarted
        // ambients need frames — without this the pulses stay frozen
        // until an unrelated event nudges a redraw.
        if frame.invalidate || frame.rearm {
            self.request_redraw_full();
        }
    }

    fn redraw(&mut self) {
        self.flush_patches();

        // Feature `video`: one or more decoded frames landed since the
        // last build — any painter subtree cached with an older frame
        // would replay it, so drop the cache and repaint fully. Same
        // monotonic-generation pattern as the image worker's
        // `image_load_generation`.
        #[cfg(feature = "video")]
        {
            let frame_gen = crate::media::frame_generation();
            if frame_gen != self.last_video_frame_gen {
                self.last_video_frame_gen = frame_gen;
                self.painter.invalidate_subtree_cache();
                self.damage.add_full();
                // A landed frame is also the tick that moves `position`
                // and (on the first one) flips loading → playing: hook
                // the bind reports onto the same frame-driven path the
                // Scrubber repaints ride. The 250 ms throttle inside
                // keeps this from becoming per-frame state traffic.
                self.apply_start_positions();
                self.apply_pending_bind_seeks();
                self.sync_video_bind();
            }
        }

        let (w, h, scale) = match (self.gpu.as_ref(), self.window.as_ref()) {
            (Some(gpu), Some(window)) => (gpu.size.0, gpu.size.1, window.scale_factor() as f32),
            _ => return,
        };

        // Animation tick — BEFORE layout, so interpolated values written
        // into the real tree props reach Taffy, item emission, and
        // hit-testing this same frame (constraint #5: geometry and hit
        // targets follow the animated values). Any write invalidates the
        // layout cache (item styling is baked at emit time) and the
        // painter's subtree scene cache; layout-affecting props also
        // restyle their Taffy nodes so Taffy re-solves.
        //
        // PERF DEBT (bounded): every tick with a write drops the WHOLE
        // painter subtree cache, even when the writes are paint-only
        // (opacity/color) and confined to one subtree. Scoping the
        // invalidation would need (a) `TickOutcome` to carry the ids it
        // wrote, and (b) each cache entry to record its subtree root so
        // "entry is on the same root-to-leaf path as a written id" can
        // be answered (opacity inherits DOWNWARD, so an animating
        // ancestor invalidates cached descendants too — containment
        // alone is not enough). Neither exists today; a wrong retain
        // here paints stale frames, the worst failure mode, so the
        // wholesale drop stays until the cache records coverage. Cost
        // is bounded: it only recurs while animations are in flight,
        // and the next paint re-encodes only visible subtrees.
        let frame = drive_animation_frame(
            &mut self.animator,
            &mut self.tree,
            &mut self.taffy,
            scale,
            crate::layout::logical_viewport((w, h), scale),
        );
        // Scrub source tick: advance any in-flight settle and fire elapsed
        // deadlines (the no-flash cleanup window, the scroll rest-debounce
        // write, the scroll-quiescence release). Writes land in the same
        // real tree props the animator writes, so a dirty scrub frame
        // invalidates layout/paint exactly like an animation frame; its
        // settle writes drain into the `__hypen_bind` channel below.
        let scrub_dirty = self.scrubber.tick(&mut self.tree);
        let scrub_active = self.scrubber.has_active();
        if scrub_dirty {
            self.tree_generation = self.tree_generation.wrapping_add(1);
            self.layout = None;
            self.painter.invalidate_subtree_cache();
            self.damage.add_full();
        }
        self.dispatch_scrub_binds();
        // #146 sibling-shift for flagged/exit removes: any exit that
        // finalized in the tick above recorded its `.layout` siblings.
        // Measure their First off the STILL-CURRENT pre-teardown layout
        // (dropped just below when `frame.invalidate` is set) and queue
        // them, so the fresh-layout `play_pending_flips` slides them.
        {
            let prev_layout = &self.layout;
            self.animator.queue_removal_sibling_flips(|id| {
                prev_layout
                    .as_ref()
                    .and_then(|l| l.item_by_id(id))
                    .map(|it| (it.rect.x, it.rect.y))
            });
        }
        if frame.invalidate {
            self.tree_generation = self.tree_generation.wrapping_add(1);
            self.layout = None;
            self.painter.invalidate_subtree_cache();
            self.damage.add_full();
        }
        let mut hovered_set: HashSet<String> = HashSet::new();
        if let Some(id) = self.hovered.clone() {
            hovered_set.insert(id);
        }
        let mut pressed_set: HashSet<String> = HashSet::new();
        if let Some(id) = self.pressed.clone() {
            pressed_set.insert(id);
        }
        {
            let interaction = self.painter.interaction_mut();
            interaction.hovered = hovered_set;
            interaction.pressed = pressed_set;
            interaction.focused = self.focused.clone();
            interaction.focus_visible = self.focus_visible;
            interaction.input_selections = self.input_selections.clone();
            interaction.ime_preedit = self.ime_preedit.clone();
        }

        if let Some(prev) = self.layout.as_ref() {
            self.scroll_y = clamp_scroll(self.scroll_y, prev.content_size.1, h as f32);
        }

        // Clamp per-Container scroll offsets against the *previous*
        // layout's ScrollMeta (the live one isn't built yet). Stale
        // entries get pruned when the prior layout no longer reports
        // them as scrollable.
        if let Some(prev) = self.layout.as_ref() {
            self.scrollables.retain(|id, off| {
                if let Some(item) = prev.item_by_id(id) {
                    if let Some(meta) = item.scrollable {
                        let max = (meta.content_h - item.rect.h).max(0.0);
                        *off = off.clamp(0.0, max);
                        return true;
                    }
                }
                false
            });
        }

        // Feed the live interaction snapshot into the retained Taffy
        // state so layout-affecting state variants (`padding:hover`, …)
        // resolve against the node actually under the pointer / pressed
        // / focused. Gated on `has_layout_state_variants`: when the tree
        // has none, pass the default (all-`None`) so the layout pass's
        // interaction key stays constant and a hover/press/focus
        // transition never forces a relayout.
        let layout_interaction = if self.has_layout_state_variants {
            crate::layout::LayoutInteraction {
                hovered: self.hovered.clone(),
                pressed: self.pressed.clone(),
                focused: self.focused.clone(),
            }
        } else {
            crate::layout::LayoutInteraction::default()
        };
        self.taffy.set_interaction(layout_interaction);

        // Layout cache. Hover / press / focus / caret-only frames
        // don't change anything that feeds Taffy or cosmic-text, so a
        // matching key lets us skip the entire layout pass and reuse
        // the previous frame's `self.layout`. Mutates that change the
        // tree (patches), viewport (resize), or scroll positions all
        // bump the key and force a recompute.
        let key = self.layout_cache_key(w, h, scale);
        let key_match = self.last_layout_key == Some(key);
        // The cull window the cached layout was emitted against
        // is centred on `last_scroll_y_in_layout`. As page scroll
        // moves further, eventually we need a fresh emit to
        // populate the items that have entered the cull buffer.
        // Half a viewport-height of slack keeps the fast path
        // running through normal wheel bursts and only forces a
        // recompute on a meaningful scroll shift.
        // Threshold is measured against the scroll position at which
        // items were last *emitted* (cull-buffer origin), not against
        // the per-frame fast-path baseline — otherwise scrolling in
        // small increments never trips the recompute and items beyond
        // the original cull buffer never get walked.
        // Buffer in `emit_items` is one viewport-height on each side;
        // recompute threshold is half of that so we re-emit while a
        // half-viewport of slack is still unconsumed (avoids the user
        // ever scrolling into un-emitted territory).
        let scroll_recompute_threshold = (h as f32) * 0.5;
        let scroll_outside_buffer = !key_match
            || (self.scroll_y - self.last_scroll_y_emitted).abs() > scroll_recompute_threshold;
        let cache_miss = self.layout.is_none() || !key_match || scroll_outside_buffer;
        let mut flips_played = false;
        if cache_miss {
            let pass = LayoutPass::compute_with_state(
                &mut self.taffy,
                &self.tree,
                self.painter.text_engine_mut(),
                (w, h),
                scale,
                self.scroll_y,
                &self.scrollables,
                self.tree_generation,
            );
            self.layout = Some(pass);
            self.last_layout_key = Some(key);
            self.last_scroll_y_in_layout = self.scroll_y;
            self.last_scroll_y_emitted = self.scroll_y;
            self.layout_generation = self.layout_generation.wrapping_add(1);
            // `.layout` FLIP playback: the fresh pass provides the Last
            // rects for any First snapshots `flush_patches` took off the
            // pre-batch layout. Starting a playback writes the invert
            // translate props into the tree AFTER this pass's transform
            // post-pass already ran — refresh the per-item transforms in
            // place (cheap: transforms are paint/hit-only, Taffy
            // geometry is untouched) so this same frame paints AND
            // hit-tests the node at its First position.
            if self.animator.has_pending_flips() {
                flips_played |= {
                    let layout_ref = self.layout.as_ref().expect("layout populated above");
                    self.animator.play_pending_flips(&mut self.tree, scale, |id| {
                        layout_ref.item_by_id(id).map(|it| (it.rect.x, it.rect.y))
                    })
                };
            }
            // Shared-element FLIP resolution (Option H, protocol steps 3/4):
            // the fresh pass provides the incoming nodes' Last `visual_rect`
            // for any source snapshots `prepare_shared` took. Matched nodes
            // pose over the source rect via transform writes and play back
            // to base — same invert-then-refresh dance as `.layout` FLIPs.
            if self.animator.has_pending_shared() {
                flips_played |= {
                    let layout_ref = self.layout.as_ref().expect("layout populated above");
                    self.animator.play_shared_flips(&mut self.tree, scale, |id| {
                        layout_ref.item_by_id(id).map(|it| {
                            let r = it.visual_rect();
                            (r.x, r.y, r.w, r.h)
                        })
                    })
                };
            }
            if flips_played {
                if let Some(pass) = self.layout.as_mut() {
                    pass.refresh_transforms(
                        &self.tree,
                        crate::layout::logical_viewport((w, h), scale),
                        scale,
                    );
                }
                self.painter.invalidate_subtree_cache();
                self.damage.add_full();
            }
        } else if (self.scroll_y - self.last_scroll_y_in_layout).abs() > f32::EPSILON {
            // Scroll-only fast path: re-shift the cached items by the
            // delta. Skips Taffy + cosmic-text + raster-cache key
            // changes entirely. Page scroll is the dominant case
            // where this kicks in — wheel events on a list of posts.
            // `clip_to` shifts in lockstep with `rect`: both live in
            // the post-page-scroll coord space, so a partial shift
            // would drift the clip away from the item it clips and
            // re-introduce the "input shows through grid gaps" bug
            // on every scroll fast-path frame.
            let delta = self.scroll_y - self.last_scroll_y_in_layout;
            if let Some(layout) = self.layout.as_mut() {
                for it in layout.items.iter_mut() {
                    it.rect.y -= delta;
                    if let Some(clip) = it.clip_to.as_mut() {
                        clip.y -= delta;
                    }
                    // Cumulative transforms embed the emit-time rect
                    // centers as origin terms; a uniform y-shift of
                    // every rect conjugates every cumulative transform
                    // by the same shift (exact — see
                    // `Affine2::conjugate_translate`). Without this, a
                    // scaled/rotated item would pivot about its stale
                    // pre-scroll center on every fast-path frame.
                    if !it.transform.is_identity() {
                        it.transform = it.transform.conjugate_translate(0.0, -delta);
                    }
                }
            }
            self.last_scroll_y_in_layout = self.scroll_y;
            self.layout_generation = self.layout_generation.wrapping_add(1);
        }
        // Route this frame's `.onAnimationComplete` dispatches to the module:
        // enter/exit/finite-preset/states settles from the tick above, plus
        // any zero-delta shared-element settle from `play_shared_flips`.
        self.dispatch_animation_completions();
        // Vello rebuilds the whole scene every frame, so we don't
        // forward partial-damage rects to the painter. We still
        // consume `self.damage` here so callers that flag full /
        // region damage don't accumulate stale state across frames.
        self.damage = Damage::None;
        // Borrow split: paint_layout takes `&LayoutPass` while the
        // painter takes `&mut self.painter`; both fields live on
        // `self`, so we lift the immutable borrow up first.
        let pass = self.layout.as_ref().expect("layout populated above");
        let scene = self.painter.build_scene(pass, (w, h), scale, self.scroll_y);
        let new_scroll = clamp_scroll(self.scroll_y, pass.content_size.1, h as f32);
        if (new_scroll - self.scroll_y).abs() > f32::EPSILON {
            self.scroll_y = new_scroll;
            self.damage.add_full();
            if let Some(w) = self.window.as_ref() {
                w.request_redraw();
            }
        }

        // winit's pre-present hook tells the windowing system we're
        // about to submit a frame. On macOS during live resize this
        // synchronises the CAMetalLayer commit with the AppKit view
        // update — without it, the OS stretches the previous swapchain
        // image to the new window size between Resized events and our
        // first frame at the new size, producing the visible flash.
        if let Some(w) = self.window.as_ref() {
            w.pre_present_notify();
        }
        let gpu = self.gpu.as_mut().expect("gpu set");
        if let Err(e) = gpu.present(scene) {
            log::warn!("present failed: {e}");
        }

        self.publish_accessibility();
        // Toggle the OS IME allowed-state to match focus. Idempotent
        // and called every frame so transitions via Tab / Escape /
        // mouse / AccessKit all converge here without per-callsite
        // bookkeeping.
        self.sync_ime_to_focus();

        // Self-perpetuating ticker: while animations are in flight,
        // request the next frame now — wgpu's Fifo present mode paces
        // the resulting RedrawRequested cadence at vsync. When the last
        // animation settles `rearm` goes false, nothing re-arms, and
        // the loop stands down to pure demand-driven `Wait`. FLIP
        // playbacks started after the tick (mid-frame, off the fresh
        // layout) are the one post-tick animator mutation — they OR in
        // via `flips_played` so a batch whose only motion is a FLIP
        // still arms the ticker.
        if frame.rearm || flips_played || scrub_active {
            if let Some(win) = self.window.as_ref() {
                win.request_redraw();
            }
        }
    }

    /// Mark the whole surface dirty and ask winit to redraw. Used by
    /// every event handler that mutates state in a way we don't (or
    /// don't yet) damage-track precisely. Hover / press transitions
    /// are the explicit exception — they call `mark_interaction_damage`
    /// + `request_redraw` directly so that mouse-only-moving frames
    /// stay scoped.
    fn request_redraw_full(&mut self) {
        self.damage.add_full();
        if let Some(w) = self.window.as_ref() {
            w.request_redraw();
        }
    }

    /// Look up an item's drawn rect, expanded by a few px so damage
    /// covers borders, hover tints, and the focus ring. Returns `None`
    /// when no current layout exists or the id isn't in it.
    fn item_damage_rect(&self, id: &str) -> Option<crate::layout::Rect> {
        let layout = self.layout.as_ref()?;
        let item = layout.item_by_id(id)?;
        // 6 px is a comfortable cover for the 3 px outset focus ring +
        // 2 px stroke and any 1 px border anti-aliasing. The VISUAL
        // rect (transform-aware AABB) is what actually painted, so
        // damage must cover it — not the untransformed layout rect.
        const PAD: f32 = 6.0;
        let rect = item.visual_rect();
        Some(crate::layout::Rect {
            x: rect.x - PAD,
            y: rect.y - PAD,
            w: rect.w + 2.0 * PAD,
            h: rect.h + 2.0 * PAD,
        })
    }

    /// Mark damage for an interaction transition: union of the rect
    /// of `old` and `new` (either may be `None`).
    fn mark_interaction_damage(&mut self, old: Option<&str>, new: Option<&str>) {
        if let Some(id) = old {
            if let Some(r) = self.item_damage_rect(id) {
                self.damage.add_region(r);
            }
        }
        if let Some(id) = new {
            if let Some(r) = self.item_damage_rect(id) {
                self.damage.add_region(r);
            }
        }
    }

    /// Hash the inputs that feed `LayoutPass::compute_with_scrolls`,
    /// excluding page `scroll_y` — that's a uniform post-pass shift,
    /// not a layout-altering input. Frames that only change `scroll_y`
    /// take the fast path in `redraw` and re-shift the cached items
    /// instead of recomputing Taffy + measure.
    fn layout_cache_key(&self, w: u32, h: u32, scale: f32) -> u64 {
        layout_cache_key_inner(
            self.tree_generation,
            w,
            h,
            scale,
            &self.scrollables,
            self.has_layout_state_variants,
            self.hovered.as_deref(),
            self.pressed.as_deref(),
            self.focused.as_deref(),
            video_state_key_for(&self.tree, self.logical_viewport()),
        )
    }

    fn publish_accessibility(&mut self) {
        // Coarse gate: skip entirely on frames where the layout
        // wasn't re-emitted. Hover / press / focus / IME / caret-
        // only frames don't bump `layout_generation`, so the
        // O(n_visible) fingerprint hash never runs on those.
        if self.layout_generation == self.last_a11y_layout_generation {
            return;
        }
        self.last_a11y_layout_generation = self.layout_generation;
        let Some(layout) = self.layout.as_ref() else {
            return;
        };
        // Exit-animating subtrees are excluded from assistive tech the
        // moment their exit begins: they still paint, but engine-side
        // they are dead — a screen reader must not report or activate
        // them (parity with the pointer/keyboard exclusion). Computed
        // before the fingerprint and mixed into it, so an exit
        // beginning under an otherwise identical layout still
        // republishes.
        let exit_excluded: Vec<String> = layout
            .items
            .iter()
            .filter(|it| self.animator.is_exit_excluded(&self.tree, &it.node_id))
            .map(|it| it.node_id.clone())
            .collect();
        // Fingerprint the layout's a11y-relevant shape so we skip the
        // full TreeUpdate rebuild when nothing semantic changed (the
        // common case during scroll / hover bursts). The fingerprint
        // covers what `tree_update_for_layout` actually reads:
        // node id, item kind discriminant, and rect bounds (rounded
        // to 1px so subpixel jitter doesn't invalidate the cache).
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        layout.items.len().hash(&mut hasher);
        for it in &layout.items {
            it.node_id.hash(&mut hasher);
            std::mem::discriminant(&it.kind).hash(&mut hasher);
            // Fingerprint the VISUAL rect — the bounds AccessKit
            // publishes. A transform-only change (mid-animation frame,
            // static transform prop landing) must republish even when
            // the Taffy rect is unchanged.
            let rect = it.visual_rect();
            (rect.x as i32).hash(&mut hasher);
            (rect.y as i32).hash(&mut hasher);
            (rect.w as i32).hash(&mut hasher);
            (rect.h as i32).hash(&mut hasher);
            it.action.hash(&mut hasher);
            // `Text { content }` and `Input { value }` change the
            // accessible label without changing rect; mix those in.
            match &it.kind {
                ItemKind::Text { content, .. } => content.hash(&mut hasher),
                ItemKind::Input {
                    value, placeholder, ..
                } => {
                    value.hash(&mut hasher);
                    placeholder.hash(&mut hasher);
                }
                _ => {}
            }
        }
        exit_excluded.hash(&mut hasher);
        let fp = hasher.finish();
        if Some(fp) == self.last_a11y_fingerprint {
            return;
        }
        self.last_a11y_fingerprint = Some(fp);
        let Some(adapter) = self.ak.as_mut() else {
            return;
        };
        adapter.update_if_active(|| {
            tree_update_for_layout_excluding(layout, &|id| {
                exit_excluded.iter().any(|e| e == id)
            })
        });
    }

    /// Exit-animating subtrees are engine-side dead the moment the
    /// flagged Remove was emitted — every hit-test path below excludes
    /// them immediately, even while their exit still paints.
    fn exit_excluded(&self, id: &str) -> bool {
        self.animator.is_exit_excluded(&self.tree, id)
    }

    fn hit_actionable(&self, x: f32, y: f32) -> Option<String> {
        self.layout
            .as_ref()
            .and_then(|l| l.hit_excluding(x, y, &|id| self.exit_excluded(id)))
            .map(|item| item.node_id.clone())
    }

    /// Recompute the `onHover` subject under the cursor and fire the
    /// leave / enter dispatch pair if it changed. Idempotent — calling
    /// with the same cursor position twice does nothing.
    ///
    /// We dispatch leave BEFORE enter so a handler that toggles the
    /// same boolean for both subjects ends in the correct state. The
    /// payload is `{hovered: bool, …static args from .onHover(...)}`;
    /// any author-supplied `hovered` key is stripped in
    /// `resolve_hover_payload` so the runtime value wins.
    fn update_hover_subject(&mut self, x: f32, y: f32) {
        let new_subject = self
            .layout
            .as_ref()
            .and_then(|l| l.hit_hoverable_excluding(x, y, &|id| self.exit_excluded(id)))
            .map(|item| item.node_id.clone());
        if new_subject == self.hover_subject {
            return;
        }
        let prev = self.hover_subject.take();
        if let Some(id) = prev.as_deref() {
            self.dispatch_hover(id, false);
        }
        self.hover_subject = new_subject;
        if let Some(id) = self.hover_subject.clone() {
            self.dispatch_hover(&id, true);
        }
    }

    /// Look up the hover action + payload for a node, merge the
    /// runtime `hovered` flag into the payload, and dispatch.
    /// Silently no-ops if the node disappeared between the hover
    /// transition and this call — common when an action handler
    /// rewrites the tree out from under us.
    fn dispatch_hover(&self, id: &str, hovered: bool) {
        let item = match self.layout.as_ref().and_then(|l| l.item_by_id(id)) {
            Some(it) => it,
            None => return,
        };
        let action = match item.hover_action.as_deref() {
            Some(a) => a,
            None => return,
        };
        let mut payload_obj = match item.hover_payload.clone() {
            Some(serde_json::Value::Object(m)) => m,
            _ => serde_json::Map::new(),
        };
        payload_obj.insert("hovered".into(), serde_json::Value::Bool(hovered));
        log::debug!("dispatch hover: {action} payload={payload_obj:?}");
        self.module
            .dispatch_action(action, Some(serde_json::Value::Object(payload_obj)));
    }

    /// Forward every `.onAnimationComplete` dispatch the animator queued at
    /// its natural-settle points (enter/exit/finite-preset/states/
    /// sharedElement) to the mounted module — the same channel clicks and
    /// hovers use. Called after each animator drive; empty (and cheap) in
    /// the overwhelmingly common case where nothing settled.
    fn dispatch_animation_completions(&mut self) {
        for completion in self.animator.take_completions() {
            log::debug!(
                "dispatch (anim complete): {} payload={:?}",
                completion.action,
                completion.payload
            );
            self.module
                .dispatch_action(&completion.action, Some(completion.payload));
        }
    }

    /// Forward every scrub settle write the scrubber queued into the exact
    /// two-way `.bind` channel — `module.dispatch_action("__hypen_bind",
    /// {path, value})` — the same channel a bound `Input` uses. The `value`
    /// is the winning pose LABEL. Called after every scrubber interaction
    /// (flush / pointer release / redraw tick); empty and cheap otherwise.
    fn dispatch_scrub_binds(&mut self) {
        for bind in self.scrubber.take_binds() {
            log::debug!("dispatch (scrub bind): {} = {}", bind.path, bind.value);
            self.module.dispatch_action(
                "__hypen_bind",
                Some(json!({ "path": bind.path, "value": bind.value })),
            );
        }
    }

    fn hit_focusable(&self, x: f32, y: f32) -> Option<String> {
        self.layout
            .as_ref()
            .and_then(|l| l.hit_focusable_excluding(x, y, &|id| self.exit_excluded(id)))
            .map(|item| item.node_id.clone())
    }

    /// Map a viewport-space pointer position into `id`'s item-LOCAL
    /// space (the space the layout rect, text metrics, and caret math
    /// live in) by inverting the item's cumulative transform. Identity
    /// (the common case) returns the point unchanged.
    fn pointer_to_item_local(&self, id: &str, x: f32, y: f32) -> (f32, f32) {
        self.layout
            .as_ref()
            .and_then(|l| l.item_by_id(id))
            .map(|it| it.to_local(x, y))
            .unwrap_or((x, y))
    }
}

// Input editing / IME / keyboard / click dispatch methods for `App`
// live in a separate file via `#[path]` so this file can stay focused
// on App state, the redraw flow, and the ApplicationHandler match.
// The included module declares another `impl App { ... }` block with
// the rest of the methods.
#[path = "window_input.rs"]
mod input_impl;
#[cfg(test)]
pub(crate) use input_impl::focused_dispatch;

// Video v2 (`playback` bind, composition slots, `Scrubber`) glue —
// another `impl App { ... }` block, same `#[path]` pattern.
#[path = "window_video.rs"]
pub(crate) mod window_video;

impl ApplicationHandler<AppEvent> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = WindowAttributes::default()
            .with_title(self.title.clone())
            // LOGICAL, not physical: `DesktopApp::size(960, 720)` means a
            // 960x720 *window*, the same units every other toolkit takes and
            // the same units the UI is authored in. As `PhysicalSize` it was
            // divided by the scale factor — a 2x display opened the window at
            // 480x360pt, less than half the requested area, which is what
            // cropped the home-screen launcher and pushed its dock out of
            // view.
            .with_inner_size(winit::dpi::LogicalSize::new(
                self.initial_size.0,
                self.initial_size.1,
            ))
            .with_visible(false);
        let window = Arc::new(
            event_loop
                .create_window(attrs)
                .expect("create winit window"),
        );

        #[cfg(target_os = "macos")]
        if self.unified_titlebar {
            crate::macos::configure_unified_titlebar(&window);
        }

        let adapter = AkAdapter::with_event_loop_proxy(event_loop, &window, self.proxy.clone());
        self.ak = Some(adapter);

        let gpu = pollster::block_on(Gpu::new(Arc::clone(&window)));
        window.set_visible(true);

        self.window = Some(window);
        self.gpu = Some(gpu);
    }

    fn user_event(&mut self, _event_loop: &ActiveEventLoop, event: AppEvent) {
        match event {
            AppEvent::Accessibility(AkEvent { window_event, .. }) => match window_event {
                AkWindowEvent::InitialTreeRequested => {
                    self.request_redraw_full();
                }
                AkWindowEvent::ActionRequested(req) => {
                    if matches!(req.action, AkAction::Click) {
                        // Renderer-local `.videoIntent(...)`: performed
                        // right here, exactly as on the pointer and
                        // keyboard paths — assistive tech activating the
                        // fullscreen button must not be a dead end.
                        // Resolved before the borrow below because
                        // performing an intent needs `&mut self`.
                        let intent = self.layout.as_ref().and_then(|layout| {
                            let rid = renderer_id_for(layout, req.target_node)?;
                            if self.animator.is_exit_excluded(&self.tree, &rid) {
                                return None;
                            }
                            layout.item_by_id(&rid)?.video_intent
                        });
                        if let Some(i) = intent {
                            self.perform_video_intent(i);
                        }
                        if let Some(layout) = self.layout.as_ref() {
                            if let Some(rid) = renderer_id_for(layout, req.target_node)
                                .filter(|rid| {
                                    // Exit-animating ids are engine-side
                                    // dead: no dispatch, and focus must
                                    // never land (or be restored) on one.
                                    !self.animator.is_exit_excluded(&self.tree, rid)
                                })
                            {
                                if let Some(item) = layout.item_by_id(&rid) {
                                    if let Some(action) = item.action.clone() {
                                        let payload = item.action_payload.clone();
                                        log::debug!(
                                            "dispatch (a11y): {action} payload={payload:?}"
                                        );
                                        self.module.dispatch_action(&action, payload);
                                        self.focused = Some(rid);
                                        // Assistive-tech focus shows the ring.
                                        self.focus_visible = true;
                                        self.request_redraw_full();
                                    }
                                }
                            }
                        }
                    }
                }
                AkWindowEvent::AccessibilityDeactivated => {}
            },
            AppEvent::Wake => {
                // Re-arm the media wake gate FIRST — before reading
                // frames or events — so a frame landing from here on
                // sends a fresh wake instead of being coalesced into
                // this (already in-progress) one.
                #[cfg(feature = "video")]
                crate::media::ack_wake();
                // A wake may mean an image/poster fetch just resolved —
                // including with an HTTP error. Dispatch any pending
                // Video `onError`s before deciding whether to repaint.
                self.dispatch_media_poster_errors();
                // Playback EOS / errors also arrive via Wake; route
                // them promptly rather than waiting for the redraw's
                // flush (which is skipped entirely while occluded).
                #[cfg(feature = "video")]
                self.pump_media_events();
                if self.is_occluded {
                    // Wake fired while hidden. Drain the queue into
                    // the Tree so the worker's Arc'd patches don't
                    // sit on the queue for the entire occluded
                    // window — but don't ask for a paint we won't
                    // receive a RedrawRequested for anyway.
                    let n = self.flush_patches();
                    if n > 0 {
                        log::info!("drained {n} patches while occluded (wake)");
                    }
                } else {
                    // Background worker (image fetch, future async work)
                    // finished and wants the renderer to repaint.
                    self.request_redraw_full();
                }
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        if let (Some(adapter), Some(window)) = (self.ak.as_mut(), self.window.as_ref()) {
            adapter.process_event(window, &event);
        }
        match event {
            WindowEvent::CloseRequested => {
                // Feature `video`: tear down playback pipelines before
                // the window goes away so GStreamer streaming threads
                // stop touching the (about to vanish) waker proxy.
                #[cfg(feature = "video")]
                crate::media::release_all();
                event_loop.exit()
            }
            WindowEvent::Resized(size) => {
                // Paint synchronously inside the Resized handler.
                // request_redraw schedules a frame for the next tick,
                // but macOS stretches the existing swapchain image to
                // the new window size in the meantime — that's the
                // visible "flash with diff sizing" during drags.
                // Waiting for the submitted frame keeps the swapchain
                // content in step with the surface size on every
                // resize event.
                if let Some(gpu) = self.gpu.as_mut() {
                    gpu.resize(size.width, size.height);
                }
                self.layout = None;
                self.damage.add_full();
                self.redraw();
            }
            WindowEvent::ScaleFactorChanged { .. } => {
                // The platform changed our HiDPI scale (window dragged
                // between displays, system zoom toggle, etc.). The
                // layout cache key includes scale, so the next paint
                // would auto-recompute — but on backends that don't
                // also fire a `Resized`, we'd otherwise paint a stale
                // frame at the new scale until something else nudges
                // a redraw. Clear and request explicitly. Bitmap
                // raster caches stay valid: text + icon tiles are
                // keyed on physical font_size / dimensions, which
                // change with scale and miss naturally.
                self.layout = None;
                self.damage.add_full();
                if let Some(w) = self.window.as_ref() {
                    w.request_redraw();
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                log::trace!("cursor moved: {position:?}");
                self.cursor = position;
                let (px, py) = (position.x as f32, position.y as f32);

                // Scrub gesture: route the move to any active drag first. It
                // claims on slop and interpolates the pose props straight
                // into the tree, so a dirty move invalidates layout/paint
                // exactly like an animation frame.
                if self.scrubber.pointer_move(&mut self.tree, position.x, position.y) {
                    self.tree_generation = self.tree_generation.wrapping_add(1);
                    self.layout = None;
                    self.painter.invalidate_subtree_cache();
                    self.damage.add_full();
                    if let Some(w) = self.window.as_ref() {
                        w.request_redraw();
                    }
                }

                // Video v2 `Scrubber` drag: preview-only, no commit and
                // no module traffic until release.
                if self.video_scrub_move(px, py) {
                    if let Some(w) = self.window.as_ref() {
                        w.request_redraw();
                    }
                }

                // While drag-selecting, every move updates the head of
                // the selection without touching the anchor.
                if let Some(drag_id) = self.dragging_input.clone() {
                    if let Some((value, font_size, rect)) = self.lookup_input(&drag_id) {
                        // Caret math lives in the item's LOCAL (layout
                        // rect) space; inverse-transform the pointer
                        // first so drag-select stays correct on a
                        // transformed Input.
                        let (lx, _) = self.pointer_to_item_local(&drag_id, px, py);
                        let local_x = (lx - rect.x - 12.0).max(0.0);
                        let new_head = self
                            .painter
                            .text_engine_mut()
                            .byte_offset_at_x(&value, local_x, font_size);
                        let sel = self.selection_of(&drag_id, &value);
                        let new_sel = Selection::range(sel.anchor, new_head).clamped(value.len());
                        if new_sel != sel {
                            // Selection band paints inside the input's
                            // rect; nothing else changed.
                            let dmg = self.item_damage_rect(&drag_id);
                            self.input_selections.insert(drag_id, new_sel);
                            if let Some(r) = dmg {
                                self.damage.add_region(r);
                            } else {
                                self.damage.add_full();
                            }
                            if let Some(w) = self.window.as_ref() {
                                w.request_redraw();
                            }
                        }
                    }
                }

                let new_hover = self.hit_actionable(px, py);
                if new_hover != self.hovered {
                    let prev = self.hovered.clone();
                    self.mark_interaction_damage(prev.as_deref(), new_hover.as_deref());
                    self.hovered = new_hover;
                    if let Some(w) = self.window.as_ref() {
                        w.request_redraw();
                    }
                }
                // Fire `.onHover` enter/leave on subject change. Runs
                // independently of the actionable-tint path above —
                // hover-trackable subjects aren't gated to Buttons.
                self.update_hover_subject(px, py);
            }
            WindowEvent::CursorLeft { .. } => {
                let prev = self.hovered.take();
                if let Some(id) = prev.as_deref() {
                    if let Some(r) = self.item_damage_rect(id) {
                        self.damage.add_region(r);
                    }
                    if let Some(w) = self.window.as_ref() {
                        w.request_redraw();
                    }
                }
                // Fire a leave dispatch for any element currently
                // tracking onHover — the pointer just left the window.
                if let Some(id) = self.hover_subject.take() {
                    self.dispatch_hover(&id, false);
                }
            }
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Left,
                ..
            } => {
                let (cx, cy) = (self.cursor.x as f32, self.cursor.y as f32);
                let action_target = self.hit_actionable(cx, cy);
                let focus_target = self.hit_focusable(cx, cy);
                // Debug-level so a headless/remote session can verify input
                // routing (press coords + resolved target) without a rebuild.
                log::debug!(
                    "mouse press at ({cx},{cy}) action_target={action_target:?} focus_target={focus_target:?}"
                );
                let mut needs_redraw = false;

                // Scrub gesture: open a PENDING drag if the press is inside a
                // gesture-scrub node's bounds (a mid-settle catch claims
                // immediately). It stays pending until slop is exceeded, so
                // the normal press/focus bookkeeping below still runs — a
                // below-slop tap remains an ordinary click (suppressed only
                // when the drag actually claims, at release).
                if let Some(layout) = self.layout.as_ref() {
                    if self.scrubber.pointer_down(layout, self.cursor.x, self.cursor.y) {
                        needs_redraw = true;
                    }
                }

                // Video v2 `Scrubber`: a press on the timeline opens a
                // local drag (preview only). It coexists with the
                // press/focus bookkeeping below — the Scrubber is
                // focusable, so the same press also focuses it for the
                // Left/Right keyboard seek.
                if self.video_scrub_down(cx, cy) {
                    needs_redraw = true;
                }

                // Compute multi-click count before the input
                // mutations below — count==2 selects the word at
                // cursor, count==3 selects the whole input.
                let now = std::time::Instant::now();
                self.click_count = next_click_count(
                    self.click_count,
                    self.last_click_at,
                    now,
                    self.last_click_pos,
                    self.cursor,
                );
                self.last_click_at = Some(now);
                self.last_click_pos = self.cursor;
                let click_count = self.click_count;

                if action_target != self.pressed {
                    let prev = self.pressed.clone();
                    self.mark_interaction_damage(prev.as_deref(), action_target.as_deref());
                    self.pressed = action_target;
                    needs_redraw = true;
                }

                // Click-to-position cursor for Inputs. Compute the byte
                // offset under the click and seed both anchor + head
                // there so a non-drag click collapses any prior
                // selection at the click point. Double-click expands
                // to the word at that byte; triple-click selects the
                // entire input value.
                if let Some(id) = focus_target.as_deref() {
                    if let Some((value, font_size, rect)) = self.lookup_input(id) {
                        // Same local-space mapping as drag-select: the
                        // click position must be inverse-transformed
                        // before caret byte-offset math.
                        let (lx, _) = self.pointer_to_item_local(id, cx, cy);
                        let local_x = (lx - rect.x - 12.0).max(0.0);
                        let byte = self
                            .painter
                            .text_engine_mut()
                            .byte_offset_at_x(&value, local_x, font_size);
                        let sel = match click_count {
                            2 => {
                                let (s, e) = crate::text_nav::word_range_at(&value, byte);
                                Selection::range(s, e)
                            }
                            3 => Selection::range(0, value.len()),
                            _ => Selection::caret(byte),
                        };
                        self.input_selections.insert(id.to_string(), sel);
                        // Drag only meaningful for single-click; a
                        // double-click already grabbed a range, and
                        // dragging from there would feel jumpy.
                        self.dragging_input = if click_count == 1 {
                            Some(id.to_string())
                        } else {
                            None
                        };
                        needs_redraw = true;
                    }
                }
                if focus_target != self.focused {
                    let prev = self.focused.clone();
                    self.mark_interaction_damage(prev.as_deref(), focus_target.as_deref());
                    self.focused = focus_target;
                    // Mouse-driven focus: no ring (`:focus-visible`).
                    self.focus_visible = false;
                    needs_redraw = true;
                }
                if needs_redraw {
                    if let Some(w) = self.window.as_ref() {
                        w.request_redraw();
                    }
                }
            }
            WindowEvent::MouseInput {
                state: ElementState::Released,
                button: MouseButton::Left,
                ..
            } => {
                // A claimed scrub drag consumes the release: it begins the
                // settle (or, under reduced motion, arrives instantly) and
                // the click is SUPPRESSED — a drag is not a tap. A below-slop
                // pointer never claimed, so the ordinary click path runs and
                // the child's action fires.
                // Video v2 `Scrubber` release commits the seek and
                // consumes the click — a scrub is not a tap.
                if self.video_scrub_up() {
                    self.pressed = None;
                    self.dragging_input = None;
                    let _ = self.scrubber.pointer_up(&mut self.tree);
                    self.dispatch_scrub_binds();
                    return;
                }
                match self.scrubber.pointer_up(&mut self.tree) {
                    ScrubPointerUp::Claimed => {
                        self.pressed = None;
                        self.dragging_input = None;
                        self.tree_generation = self.tree_generation.wrapping_add(1);
                        self.layout = None;
                        self.painter.invalidate_subtree_cache();
                        self.damage.add_full();
                        self.dispatch_scrub_binds();
                        if let Some(w) = self.window.as_ref() {
                            w.request_redraw();
                        }
                    }
                    ScrubPointerUp::NoOp => self.handle_click(),
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let dy = match delta {
                    MouseScrollDelta::LineDelta(_, y) => -y * 32.0,
                    MouseScrollDelta::PixelDelta(p) => -p.y as f32,
                };
                if dy.abs() > f32::EPSILON {
                    let cx = self.cursor.x as f32;
                    let cy = self.cursor.y as f32;
                    // Topmost scrollable Container under the cursor wins
                    // — fall back to page scroll when there isn't one.
                    let target = self
                        .layout
                        .as_ref()
                        .and_then(|l| {
                            l.hit_scrollable_excluding(cx, cy, &|id| {
                                self.animator.is_exit_excluded(&self.tree, id)
                            })
                        });
                    let mut container_damage: Option<crate::layout::Rect> = None;
                    let mut full_damage = false;
                    if let Some(item) = target {
                        let meta = item.scrollable.unwrap();
                        let max = (meta.content_h - item.rect.h).max(0.0);
                        let id = item.node_id.clone();
                        let cur = self.scrollables.get(&id).copied().unwrap_or(0.0);
                        let new = (cur + dy).clamp(0.0, max);
                        if (new - cur).abs() > f32::EPSILON {
                            // Per-container scroll: only items inside
                            // this container moved. Damage = the
                            // container's rect (children clip to it).
                            container_damage = Some(item.rect);
                            self.scrollables.insert(id, new);
                        }
                    } else {
                        let viewport_h = self.gpu.as_ref().map(|g| g.size.1 as f32).unwrap_or(0.0);
                        // `LayoutPass.content_size.1` is the *total* content
                        // height already, not "content above the current
                        // scroll position" — adding scroll_y inflated the
                        // cap and let the user wheel past the end until
                        // the next frame's redraw-time clamp caught up.
                        let content_h = self
                            .layout
                            .as_ref()
                            .map(|l| l.content_size.1)
                            .unwrap_or(0.0);
                        let new = clamp_scroll(self.scroll_y + dy, content_h, viewport_h);
                        if (new - self.scroll_y).abs() > f32::EPSILON {
                            self.scroll_y = new;
                            // Page scroll moves every item — repaint
                            // the whole surface.
                            full_damage = true;
                        }
                    }
                    if let Some(rect) = container_damage {
                        self.damage.add_region(rect);
                        // Don't drop `self.layout` here — the per-container
                        // scroll already bumped `layout_cache_key` (via the
                        // `scrollables` map), so the next redraw will
                        // recompute on its own. Throwing away the cached
                        // layout strands the redraw-time clamp + scrollables
                        // retain that read it on entry.
                        if let Some(w) = self.window.as_ref() {
                            w.request_redraw();
                        }
                    } else if full_damage {
                        // Page scroll is just a uniform y-shift — let
                        // `redraw`'s fast path re-shift the cached
                        // layout instead of forcing a full recompute.
                        // Damage stays Full because every item moves.
                        self.request_redraw_full();
                    }
                    // Scroll-source scrub: re-derive every scroll entry's
                    // progress from its resolved container's freshly-updated
                    // offset (absolute mapping). Runs after the offset write
                    // above so it reads the new value; a dirty re-derive
                    // invalidates layout like any tree write.
                    let mut scrub_dirty = false;
                    if let Some(layout) = self.layout.as_ref() {
                        scrub_dirty =
                            self.scrubber.on_scroll(&mut self.tree, layout, &self.scrollables);
                    }
                    if scrub_dirty {
                        self.tree_generation = self.tree_generation.wrapping_add(1);
                        self.layout = None;
                        self.painter.invalidate_subtree_cache();
                        self.damage.add_full();
                        if let Some(w) = self.window.as_ref() {
                            w.request_redraw();
                        }
                    }
                }
            }
            WindowEvent::ModifiersChanged(modifiers) => {
                self.modifiers = modifiers.state();
            }
            WindowEvent::Ime(ime_ev) => {
                // Preedit / commit paint inline at the caret of the
                // focused input — damage = that input's rect. On
                // commit, the value changes and a __hypen_bind action
                // dispatches, which produces patches that bump
                // tree_generation and force full damage anyway.
                let focused_id = self.focused.clone();
                self.handle_ime(ime_ev);
                let damaged = focused_id
                    .as_deref()
                    .and_then(|id| self.item_damage_rect(id));
                if let Some(r) = damaged {
                    self.damage.add_region(r);
                    if let Some(w) = self.window.as_ref() {
                        w.request_redraw();
                    }
                } else {
                    self.request_redraw_full();
                }
            }
            WindowEvent::KeyboardInput { event: ev, .. } => {
                // The vast majority of keyboard events that handle_keyboard
                // returns `true` for are selection / caret moves on a
                // focused Input — they only repaint that one rect.
                // Tab / Escape / focus changes mutate `self.focused`
                // through `mark_interaction_damage` paths internally,
                // so they're already scoped. Anything that produces a
                // value change goes through `__hypen_bind` → patches
                // → `flush_patches` → `damage.add_full()` on the next
                // frame, so we don't need a defensive full damage
                // here.
                let prev_focused = self.focused.clone();
                if self.handle_keyboard(&ev) {
                    if let Some(id) = prev_focused.as_deref() {
                        if let Some(r) = self.item_damage_rect(id) {
                            self.damage.add_region(r);
                        }
                    }
                    if let Some(id) = self.focused.as_deref() {
                        if let Some(r) = self.item_damage_rect(id) {
                            self.damage.add_region(r);
                        }
                    }
                    if let Some(w) = self.window.as_ref() {
                        w.request_redraw();
                    }
                }
            }
            WindowEvent::Focused(false) => {
                // A claimed scrub drag has no OS pointer-capture on desktop
                // (winit exposes none — see anim.rs' scrub narrowings), so a
                // focus loss mid-drag is the winit analog of the DOM's
                // `pointercancel`, which the DOM scrubber routes straight to
                // its pointer-up settle path. Forward it the same way: without
                // this the grab STRANDS — `active_pointer` stays set (blocking
                // every future gesture until an unrelated release consumes it),
                // the node holds its mid-drag pose, and engine writes to its
                // scrubbed keys defer indefinitely (the ticker is not armed
                // during a drag, so it can never self-heal). A pending
                // below-slop drag is simply discarded (NoOp).
                if let ScrubPointerUp::Claimed = self.scrubber.pointer_up(&mut self.tree) {
                    self.pressed = None;
                    self.dragging_input = None;
                    self.tree_generation = self.tree_generation.wrapping_add(1);
                    self.layout = None;
                    self.painter.invalidate_subtree_cache();
                    self.damage.add_full();
                    self.dispatch_scrub_binds();
                    self.animator.set_scrub_active(self.scrubber.owned_ids());
                }
                // Clear `pressed` too — losing focus mid-press would
                // otherwise leave a stale pressed id that the next
                // mouse-up could match against.
                let changed = self.focused.take().is_some()
                    || self.hovered.take().is_some()
                    || self.pressed.take().is_some();
                if changed {
                    self.request_redraw_full();
                }
            }
            WindowEvent::Occluded(occluded) => {
                // Idempotent — `Occluded(true)` can fire repeatedly
                // when the user moves between Spaces / minimises and
                // restores. Only act on transitions.
                if occluded == self.is_occluded {
                    return;
                }
                self.is_occluded = occluded;
                if occluded {
                    // Drain whatever's in the queue right now so its
                    // Arc'd props release; clear the paint-side raster
                    // caches so the process can trim while hidden.
                    // Global decoded-image cache is *not* cleared —
                    // refetching from the network on every unhide
                    // would hitch the resume. Its LRU cap bounds it.
                    let n = self.flush_patches();
                    if n > 0 {
                        log::info!("drained {n} patches while occluded (occlude transition)");
                    }
                    self.painter.clear_image_cache();
                    self.painter.text_engine_mut().clear_measure_cache();
                    // Drop the short-term decoded-pixmap cache so a
                    // hidden window's resident set shrinks. Encoded
                    // bytes survive — re-decode on resume is cheap
                    // (and parallel with paint via the worker that
                    // already validated them).
                    crate::paint::image::clear_decoded_cache();
                    self.damage = crate::damage::Damage::None;
                } else {
                    // Coming back up: caches were cleared, repaint
                    // the world. `request_redraw_full` marks damage
                    // and asks winit for a frame — the OS will then
                    // dispatch `RedrawRequested` and the normal path
                    // takes over.
                    self.request_redraw_full();
                }
            }
            WindowEvent::RedrawRequested => {
                if self.is_occluded {
                    // Some platforms still dispatch a `RedrawRequested`
                    // for a backgrounded window (e.g. macOS during a
                    // Spaces transition). Skip the paint to avoid
                    // touching the swapchain when the OS isn't going
                    // to show it.
                    return;
                }
                self.redraw();
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        // Drop entries whose owning Input node no longer exists. The
        // engine cycles Input nodes on form rerenders / list re-keys;
        // without this, every transient Input that ever held a
        // selection leaves a `String + Selection` pair behind for the
        // process lifetime. A handful is meaningless; a long-running
        // session that re-renders forms or chat composers accumulates
        // tens of thousands.
        self.input_selections
            .retain(|id, _| self.tree.get(id).is_some());

        // No value-clamping pass here. The previous version walked
        // `layout.items` and clamped every stored selection against
        // its current Input value — meant to handle the server
        // shrinking the value out from under us. The problem: this
        // hook fires *between* the user's keystroke and the patch
        // round-trip, so the layout still reflects the pre-typing
        // value (length N) while `input_selections` correctly holds
        // the post-typing caret position (N + 1). Clamping at that
        // moment loses the caret back to N, and the next keystroke
        // inserts at position N instead of N + 1 — producing
        // "test" → "estt" / "rust" → "ustr". Selection-of /
        // edit_focused_input / the painter already clamp on read
        // (window_input.rs:42, 59 + vello_painter.rs:362), so the
        // stored value can safely be slightly stale until the patch
        // lands and the next read re-clamps it.

        if self.is_occluded {
            // Hidden: drain the queue into the Tree so its Arc'd
            // patches don't sit until we resume, but don't ask for a
            // paint we won't get a `RedrawRequested` for. `Wake`
            // events from the patch callback do the same drain on
            // the rising edge; this handles bursts that arrive
            // through other winit wakeups (timers, accessibility,
            // etc.) without piling up.
            let n = self.flush_patches();
            if n > 0 {
                log::info!("drained {n} patches while occluded (about_to_wait)");
            }
            return;
        }
        if !self.queue.is_empty() {
            self.request_redraw_full();
        }
    }

    fn exiting(&mut self, _event_loop: &ActiveEventLoop) {
        // Feature `video`: tear down every playback pipeline so the
        // process exits without live GStreamer streaming threads.
        #[cfg(feature = "video")]
        crate::media::release_all();
    }
}

/// Outcome of one animation-frame step (or reduced-motion toggle) —
/// see [`drive_animation_frame`] / [`drive_reduced_motion_toggle`].
/// Extracted as data so the redraw glue is testable without a
/// GPU-backed `App`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct FrameAnim {
    /// The animator wrote into the tree / finalized removals: the
    /// caller must bump the tree generation, drop the cached layout,
    /// invalidate the painter subtree cache, and mark full damage.
    pub invalidate: bool,
    /// Animations remain in flight after this step: the caller must
    /// request another frame (the vsync re-arm). `false` on idle steps
    /// so the demand-driven loop stands down.
    pub rearm: bool,
}

/// Mirror a [`TickOutcome`] into the retained Taffy state: finalized
/// removal patches replay through `apply_patches` (bulk rebuild on any
/// unhandled patch), and layout-affecting animated writes restyle
/// their nodes so Taffy re-solves off the interpolated values.
pub(crate) fn mirror_tick_outcome(
    outcome: &TickOutcome,
    tree: &Tree,
    taffy: &mut TaffyState,
    scale: f32,
    viewport: Viewport,
) {
    if !outcome.finalized.is_empty()
        && !taffy.apply_patches(&outcome.finalized, tree, scale, viewport)
    {
        taffy.mark_needs_rebuild();
    }
    for id in &outcome.restyle {
        taffy.restyle_node(id, tree, scale, viewport);
    }
}

/// One animation-frame step, extracted from [`App::redraw`] so the
/// window wiring is testable headless: tick the animator against the
/// tree — the caller runs this BEFORE computing the LayoutPass, so
/// animated geometry reaches Taffy, item emission, and hit-testing the
/// same frame — and mirror the outcome into the retained Taffy state.
pub(crate) fn drive_animation_frame(
    animator: &mut DesktopAnimator,
    tree: &mut Tree,
    taffy: &mut TaffyState,
    scale: f32,
    viewport: Viewport,
) -> FrameAnim {
    let outcome = animator.tick(tree);
    let invalidate = !outcome.is_empty();
    if invalidate {
        mirror_tick_outcome(&outcome, tree, taffy, scale, viewport);
    }
    FrameAnim {
        invalidate,
        rearm: animator.has_active(tree),
    }
}

/// Reduced-motion toggle step, extracted from
/// [`App::set_reduced_motion`] for the same headless-testability
/// reason. `rearm` is decided off `has_active`, NOT off the toggle's
/// outcome: toggling OFF restarts `.animate` presets without writing
/// anything yet, so an empty outcome must still wake the redraw loop
/// or restarted pulses stay frozen on an idle window.
pub(crate) fn drive_reduced_motion_toggle(
    animator: &mut DesktopAnimator,
    tree: &mut Tree,
    taffy: &mut TaffyState,
    scale: f32,
    viewport: Viewport,
    on: bool,
) -> FrameAnim {
    let outcome = animator.set_reduced_motion(on, tree);
    let invalidate = !outcome.is_empty();
    if invalidate {
        mirror_tick_outcome(&outcome, tree, taffy, scale, viewport);
    }
    FrameAnim {
        invalidate,
        rearm: animator.has_active(tree),
    }
}

/// Detached-subtree eviction backstop (see [`DETACHED_SUBTREE_CAP`]):
/// tear down the oldest detached roots past `cap` and mirror the
/// teardown into Taffy AND the animator — every evicted id leaves the
/// node arena, so its animator records (specs, ambients, …) must go
/// with it or they accumulate for the process lifetime.
pub(crate) fn evict_detached_backstop(
    tree: &mut Tree,
    taffy: &mut TaffyState,
    animator: &mut DesktopAnimator,
    cap: usize,
) -> Vec<String> {
    let evicted = tree.evict_detached_over(cap);
    if !evicted.is_empty() {
        log::warn!(
            "evicted {} detached node(s) over the {cap}-root \
             backstop — the host is detaching subtrees without re-Attaching or \
             Removing them (likely a render loop / Router cache that never evicts)",
            evicted.len(),
        );
        for id in &evicted {
            taffy.remove_node(id);
            animator.forget(id);
        }
    }
    evicted
}

/// Clear `focused` (and the `:focus-visible` ring flag) when it sits
/// on or under an exit-animating subtree — those ids are engine-side
/// dead, so keyboard activation, typing, and IME must stop the moment
/// the exit begins. Returns `true` when focus was cleared.
pub(crate) fn clear_focus_if_exiting(
    animator: &DesktopAnimator,
    tree: &Tree,
    focused: &mut Option<String>,
    focus_visible: &mut bool,
) -> bool {
    let Some(id) = focused.as_deref() else {
        return false;
    };
    if animator.is_exit_excluded(tree, id) {
        *focused = None;
        *focus_visible = false;
        true
    } else {
        false
    }
}

/// Pure scan behind [`App::dispatch_media_poster_errors`]: walk the
/// tree's Video nodes and produce the `(action, payload)` dispatches
/// for posters whose fetch failed with an HTTP status, deduped through
/// `dispatched` (`"node_id\u{0}poster"` keys, mutated in place).
/// `lookup_failure` is injected so tests don't depend on the global
/// image-cache registry.
pub(crate) fn collect_media_error_dispatches(
    tree: &Tree,
    viewport: Viewport,
    dispatched: &mut HashSet<String>,
    lookup_failure: &dyn Fn(&str) -> Option<crate::paint::image::LoadFailure>,
) -> Vec<(String, serde_json::Value)> {
    let mut pending = Vec::new();
    for node in tree.nodes() {
        if !crate::layout::MEDIA_TYPES
            .iter()
            .any(|t| t.eq_ignore_ascii_case(&node.element_type))
        {
            continue;
        }
        let Some((action, base_payload)) =
            crate::layout::resolve_named_event_action(node, "onError")
        else {
            continue;
        };
        let Some(poster) = crate::layout::resolve_media_poster(node, viewport) else {
            continue;
        };
        let Some(failure) = lookup_failure(&poster) else {
            continue;
        };
        let dedupe_key = format!("{}\u{0}{}", node.id, poster);
        if !dispatched.insert(dedupe_key) {
            continue;
        }
        let (src, index) = crate::layout::resolve_media_src(node, viewport);
        let mut obj = match base_payload {
            serde_json::Value::Object(o) => o,
            _ => serde_json::Map::new(),
        };
        obj.insert("type".to_string(), json!("error"));
        // `src` names the track the error refers to; the poster is
        // what actually failed, so fall back to it for poster-only
        // elements.
        obj.insert(
            "src".to_string(),
            match src.as_deref() {
                Some(s) => json!(s),
                None => json!(poster),
            },
        );
        obj.insert("index".to_string(), json!(index));
        obj.insert("status".to_string(), json!(failure.status));
        obj.insert("message".to_string(), json!(failure.message));
        pending.push((action, serde_json::Value::Object(obj)));
    }
    pending
}

/// Clamp `y` into the legal scroll range for `content_h` content
/// against a `viewport_h` viewport.
pub(crate) fn clamp_scroll(y: f32, content_h: f32, viewport_h: f32) -> f32 {
    let max = (content_h - viewport_h).max(0.0);
    y.clamp(0.0, max)
}

/// Pure layout-cache-key hash. Folds the live interaction state
/// (hovered / pressed / focused) into the key ONLY when
/// `has_layout_state_variants` is set — so a tree with no layout-
/// affecting state variant produces a key independent of hover/press/
/// focus, keeping interaction transitions on the repaint-only fast path
/// (no relayout). Extracted as a free function so the guard is unit-
/// testable without constructing a full `App` (which needs a GPU).
#[allow(clippy::too_many_arguments)]
pub(crate) fn layout_cache_key_inner(
    tree_generation: u64,
    w: u32,
    h: u32,
    scale: f32,
    scrollables: &HashMap<String, f32>,
    has_layout_state_variants: bool,
    hovered: Option<&str>,
    pressed: Option<&str>,
    focused: Option<&str>,
    video_state_key: u64,
) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h_hasher = std::collections::hash_map::DefaultHasher::new();
    tree_generation.hash(&mut h_hasher);
    w.hash(&mut h_hasher);
    h.hash(&mut h_hasher);
    scale.to_bits().hash(&mut h_hasher);
    // Sorted iteration so two equivalent maps with different insertion
    // order produce the same key.
    let mut sorted: Vec<(&String, &f32)> = scrollables.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    for (id, off) in sorted {
        id.hash(&mut h_hasher);
        off.to_bits().hash(&mut h_hasher);
    }
    // Interaction state participates ONLY when the tree has a layout-
    // affecting state variant. In the common case the branch is skipped
    // entirely, so the key is byte-identical to the pre-feature
    // behaviour and hover/press/focus transitions never trigger a
    // relayout. When a layout state variant IS present, a transition on
    // (or off) the hovered / pressed / focused node bumps the key,
    // forcing `redraw` to recompute the LayoutPass with the new active
    // states (Taffy's per-node dirty tracking keeps that incremental).
    if has_layout_state_variants {
        hovered.hash(&mut h_hasher);
        pressed.hash(&mut h_hasher);
        focused.hash(&mut h_hasher);
    }
    // Video v2: the player state lives in the media registry, not in
    // tree props, so a preroll→playing / play→pause / EOS transition
    // bumps nothing else in this key — yet it changes which composition
    // slots are emitted and what the surface paints. Fold it in (zero
    // for a tree with no Video, so every non-media app's key is
    // byte-identical to before).
    video_state_key.hash(&mut h_hasher);
    h_hasher.finish()
}

/// Hash of every live Video node's derived player state. Feeds the
/// layout cache key so a registry-side transition (which touches no tree
/// prop) still forces the slot-visibility re-emit. `0` when the tree has
/// no Video at all — the overwhelmingly common case pays one scan of the
/// node map and produces the same key as before the feature.
pub(crate) fn video_state_key_for(tree: &Tree, viewport: Viewport) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut ids: Vec<(&str, u8)> = Vec::new();
    for node in tree.nodes() {
        if !crate::layout::MEDIA_TYPES
            .iter()
            .any(|t| t.eq_ignore_ascii_case(&node.element_type))
        {
            continue;
        }
        let state = crate::video_v2::player_state(node, viewport);
        ids.push((node.id.as_str(), state as u8));
    }
    if ids.is_empty() {
        return 0;
    }
    ids.sort_unstable();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for (id, state) in ids {
        id.hash(&mut h);
        state.hash(&mut h);
    }
    h.finish()
}

/// Step `cursor` left to the start of the previous UTF-8 codepoint.
pub(crate) fn prev_char_boundary(s: &str, cursor: usize) -> usize {
    if cursor == 0 {
        return 0;
    }
    let mut i = cursor.min(s.len()).saturating_sub(1);
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Step `cursor` right to the start of the next UTF-8 codepoint.
pub(crate) fn next_char_boundary(s: &str, cursor: usize) -> usize {
    if cursor >= s.len() {
        return s.len();
    }
    let mut i = cursor + 1;
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// macOS / GNOME / Windows all use ~500 ms + ~5 px as the
/// double-click thresholds. Past either threshold, the click count
/// resets to 1.
const MULTI_CLICK_MS: u128 = 500;
const MULTI_CLICK_PX: f64 = 5.0;
/// Largest multi-click count we keep — quad-click and beyond fold
/// back into 1 so the user can re-enter single-click mode by holding
/// still and clicking again.
const MAX_CLICK_COUNT: u32 = 3;

/// Pure click-count state machine. Returns the next `click_count`
/// given the current count, the previous click's time/position, and
/// the new click's time/position.
pub(crate) fn next_click_count(
    prev_count: u32,
    prev_at: Option<std::time::Instant>,
    now: std::time::Instant,
    prev_pos: winit::dpi::PhysicalPosition<f64>,
    new_pos: winit::dpi::PhysicalPosition<f64>,
) -> u32 {
    let close_in_time = prev_at
        .map(|t| now.duration_since(t).as_millis() < MULTI_CLICK_MS)
        .unwrap_or(false);
    let close_in_space = (new_pos.x - prev_pos.x).abs() < MULTI_CLICK_PX
        && (new_pos.y - prev_pos.y).abs() < MULTI_CLICK_PX;
    if close_in_time && close_in_space {
        let next = prev_count.saturating_add(1);
        if next > MAX_CLICK_COUNT {
            1
        } else {
            next.max(2)
        }
    } else {
        1
    }
}

#[cfg(test)]
#[path = "window_tests.rs"]
mod tests;
