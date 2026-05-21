//! winit `ApplicationHandler` + per-window state.
//!
//! Owns the GPU surface, painter, tree, layout cache, and a handle to the
//! `HypenModule` so click events can dispatch actions back. Patches arrive
//! via the shared `PatchQueue`; we drain on every redraw and request a
//! repaint whenever new patches show up.

use crate::accessibility::{renderer_id_for, tree_update_for_layout};
use crate::damage::Damage;
use crate::gpu::Gpu;
use crate::ime::{apply_ime_transition, ImeEffect};
use crate::layout::{ItemKind, LayoutPass, TaffyState};
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
    pressed: Option<String>,
    focused: Option<String>,
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
            proxy,
            window: None,
            gpu: None,
            ak: None,
            painter: VelloPainter::new(),
            tree: Tree::new(),
            taffy: TaffyState::new(),
            layout: None,
            cursor: PhysicalPosition::new(0.0, 0.0),
            hovered: None,
            pressed: None,
            focused: None,
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
        }
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
        let patches = self.queue.drain();
        let n = patches.len();
        if n == 0 {
            return 0;
        }
        self.tree.apply_batch(&patches);
        self.tree_generation = self.tree_generation.wrapping_add(1);
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
        let scale = self
            .window
            .as_ref()
            .map(|w| w.scale_factor() as f32)
            .unwrap_or(1.0);
        let viewport_w = self.gpu.as_ref().map(|g| g.size.0 as f32).unwrap_or(0.0);
        if !self
            .taffy
            .apply_patches(&patches, &self.tree, scale, viewport_w)
        {
            self.taffy.mark_needs_rebuild();
        }
        self.damage.add_full();
        n
    }

    fn redraw(&mut self) {
        self.flush_patches();

        let (w, h, scale) = match (self.gpu.as_ref(), self.window.as_ref()) {
            (Some(gpu), Some(window)) => (gpu.size.0, gpu.size.1, window.scale_factor() as f32),
            _ => return,
        };
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
                }
            }
            self.last_scroll_y_in_layout = self.scroll_y;
            self.layout_generation = self.layout_generation.wrapping_add(1);
        }
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
        // 2 px stroke and any 1 px border anti-aliasing.
        const PAD: f32 = 6.0;
        Some(crate::layout::Rect {
            x: item.rect.x - PAD,
            y: item.rect.y - PAD,
            w: item.rect.w + 2.0 * PAD,
            h: item.rect.h + 2.0 * PAD,
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
        use std::hash::{Hash, Hasher};
        let mut h_hasher = std::collections::hash_map::DefaultHasher::new();
        self.tree_generation.hash(&mut h_hasher);
        w.hash(&mut h_hasher);
        h.hash(&mut h_hasher);
        scale.to_bits().hash(&mut h_hasher);
        // Sorted iteration so two equivalent maps with different
        // insertion order produce the same key.
        let mut sorted: Vec<(&String, &f32)> = self.scrollables.iter().collect();
        sorted.sort_by(|a, b| a.0.cmp(b.0));
        for (id, off) in sorted {
            id.hash(&mut h_hasher);
            off.to_bits().hash(&mut h_hasher);
        }
        h_hasher.finish()
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
        let Some(adapter) = self.ak.as_mut() else {
            return;
        };
        let Some(layout) = self.layout.as_ref() else {
            return;
        };
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
            (it.rect.x as i32).hash(&mut hasher);
            (it.rect.y as i32).hash(&mut hasher);
            (it.rect.w as i32).hash(&mut hasher);
            (it.rect.h as i32).hash(&mut hasher);
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
        let fp = hasher.finish();
        if Some(fp) == self.last_a11y_fingerprint {
            return;
        }
        self.last_a11y_fingerprint = Some(fp);
        adapter.update_if_active(|| tree_update_for_layout(layout));
    }

    fn hit_actionable(&self, x: f32, y: f32) -> Option<String> {
        self.layout
            .as_ref()
            .and_then(|l| l.hit(x, y))
            .map(|item| item.node_id.clone())
    }

    fn hit_focusable(&self, x: f32, y: f32) -> Option<String> {
        self.layout
            .as_ref()
            .and_then(|l| l.hit_focusable(x, y))
            .map(|item| item.node_id.clone())
    }
}

// Input editing / IME / keyboard / click dispatch methods for `App`
// live in a separate file via `#[path]` so this file can stay focused
// on App state, the redraw flow, and the ApplicationHandler match.
// The included module declares another `impl App { ... }` block with
// the rest of the methods.
#[path = "window_input.rs"]
mod input_impl;

impl ApplicationHandler<AppEvent> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = WindowAttributes::default()
            .with_title(self.title.clone())
            .with_inner_size(winit::dpi::PhysicalSize::new(
                self.initial_size.0,
                self.initial_size.1,
            ))
            .with_visible(false);
        let window = Arc::new(
            event_loop
                .create_window(attrs)
                .expect("create winit window"),
        );

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
                        if let Some(layout) = self.layout.as_ref() {
                            if let Some(rid) = renderer_id_for(layout, req.target_node) {
                                if let Some(item) = layout.item_by_id(&rid) {
                                    if let Some(action) = item.action.clone() {
                                        let payload = item.action_payload.clone();
                                        log::debug!(
                                            "dispatch (a11y): {action} payload={payload:?}"
                                        );
                                        self.module.dispatch_action(&action, payload);
                                        self.focused = Some(rid);
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
            WindowEvent::CloseRequested => event_loop.exit(),
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
                self.cursor = position;
                let (px, py) = (position.x as f32, position.y as f32);

                // While drag-selecting, every move updates the head of
                // the selection without touching the anchor.
                if let Some(drag_id) = self.dragging_input.clone() {
                    if let Some((value, font_size, rect)) = self.lookup_input(&drag_id) {
                        let local_x = (px - rect.x - 12.0).max(0.0);
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
            }
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Left,
                ..
            } => {
                let (cx, cy) = (self.cursor.x as f32, self.cursor.y as f32);
                let action_target = self.hit_actionable(cx, cy);
                let focus_target = self.hit_focusable(cx, cy);
                let mut needs_redraw = false;

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
                        let local_x = (cx - rect.x - 12.0).max(0.0);
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
                self.handle_click();
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
                    let target = self.layout.as_ref().and_then(|l| l.hit_scrollable(cx, cy));
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
                        log::info!(
                            "drained {n} patches while occluded (occlude transition)"
                        );
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
}

/// Clamp `y` into the legal scroll range for `content_h` content
/// against a `viewport_h` viewport.
pub(crate) fn clamp_scroll(y: f32, content_h: f32, viewport_h: f32) -> f32 {
    let max = (content_h - viewport_h).max(0.0);
    y.clamp(0.0, max)
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
