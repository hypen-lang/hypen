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
use crate::layout::{ItemKind, LayoutPass};
use crate::module::HypenModule;
use crate::paint::cpu::CpuPainter;
use crate::painter::PaintTarget;
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
        Self { anchor: at, head: at }
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

impl PatchQueue {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn push(&self, patches: &[Patch]) {
        let mut q = self.queued.lock().expect("patch queue poisoned");
        q.extend_from_slice(patches);
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
    painter: CpuPainter,
    tree: Tree,
    pixels: Vec<u8>,

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
    /// Pending resize coalescing. macOS / GNOME emit a burst of
    /// `Resized` events while the user drags a window edge; doing a
    /// full `gpu.resize` + layout + paint per event multiplies work by
    /// ~10–20x. We store the latest size here and apply it once at
    /// the start of the next redraw, so a drag turns into one
    /// configure + texture upload per displayed frame instead of one
    /// per OS event.
    pending_resize: Option<(u32, u32)>,
    /// Hash of the last AccessKit tree we published. Lets us skip
    /// rebuilding + sending the full TreeUpdate when nothing
    /// semantically changed (e.g. the user is just hovering or
    /// scrolling — no new node IDs, no new roles, no new bounds).
    last_a11y_fingerprint: u64,
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
            painter: CpuPainter::new(),
            tree: Tree::new(),
            pixels: Vec::new(),
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
            pending_resize: None,
            last_a11y_fingerprint: 0,
            last_ime_target: None,
            scroll_y: 0.0,
            scrollables: HashMap::new(),
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

    fn ensure_pixel_buf(&mut self, w: u32, h: u32) {
        let needed = (w as usize) * (h as usize) * 4;
        if self.pixels.len() != needed {
            self.pixels.resize(needed, 0);
        }
    }

    fn flush_patches(&mut self) -> bool {
        let patches = self.queue.drain();
        if patches.is_empty() {
            false
        } else {
            self.tree.apply_batch(&patches);
            self.tree_generation = self.tree_generation.wrapping_add(1);
            self.layout = None;
            // Tree mutation can move anything, anywhere — we don't
            // try to compute the touched subtrees today.
            self.damage.add_full();
            true
        }
    }

    fn redraw(&mut self) {
        // Apply any pending resize once, just before painting. This
        // turns a Resized burst from N gpu.resize + paint passes into
        // exactly one per displayed frame.
        if let Some((w, h)) = self.pending_resize.take() {
            if let Some(gpu) = self.gpu.as_mut() {
                gpu.resize(w, h);
            }
        }

        self.flush_patches();

        let (w, h, scale) = match (self.gpu.as_ref(), self.window.as_ref()) {
            (Some(gpu), Some(window)) => (gpu.size.0, gpu.size.1, window.scale_factor() as f32),
            _ => return,
        };
        self.ensure_pixel_buf(w, h);

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
                if let Some(item) =
                    prev.items.iter().find(|it| &it.node_id == id)
                {
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
        let cache_miss = self.layout.is_none() || !key_match;
        if cache_miss {
            let pass = LayoutPass::compute_with_scrolls(
                &self.tree,
                self.painter.text_engine_mut(),
                (w, h),
                scale,
                self.scroll_y,
                &self.scrollables,
            );
            self.layout = Some(pass);
            self.last_layout_key = Some(key);
            self.last_scroll_y_in_layout = self.scroll_y;
        } else if (self.scroll_y - self.last_scroll_y_in_layout).abs() > f32::EPSILON {
            // Scroll-only fast path: re-shift the cached items by the
            // delta. Skips Taffy + cosmic-text + raster-cache key
            // changes entirely. Page scroll is the dominant case
            // where this kicks in — wheel events on a list of posts.
            let delta = self.scroll_y - self.last_scroll_y_in_layout;
            if let Some(layout) = self.layout.as_mut() {
                for it in layout.items.iter_mut() {
                    it.rect.y -= delta;
                }
            }
            self.last_scroll_y_in_layout = self.scroll_y;
        }
        // Resolve damage. `Damage::None` means a redraw fired but
        // no specific region was marked — repaint everything to be
        // safe (something might have changed without going through a
        // damage-marking path). Layout-cache misses also force a full
        // repaint, since the new geometry can shift any item.
        let damage = match self.damage {
            Damage::Region(r) if !cache_miss => Some(r),
            _ => None,
        };
        self.damage = Damage::None;
        // Borrow split: paint_layout takes `&LayoutPass` while the
        // painter takes `&mut self.painter`; both fields live on
        // `self`, so we lift the immutable borrow up first.
        let pass = self.layout.as_ref().expect("layout populated above");
        self.painter.paint_layout_with_damage(
            pass,
            PaintTarget {
                pixels: &mut self.pixels,
                width: w,
                height: h,
                scale_factor: scale,
            },
            self.scroll_y,
            damage,
        );
        let new_scroll = clamp_scroll(self.scroll_y, pass.content_size.1, h as f32);
        if (new_scroll - self.scroll_y).abs() > f32::EPSILON {
            self.scroll_y = new_scroll;
            self.damage.add_full();
            if let Some(w) = self.window.as_ref() {
                w.request_redraw();
            }
        }
        // `self.layout` is already populated by the cache-miss branch
        // above; no second store needed.

        let gpu = self.gpu.as_mut().expect("gpu set");
        // Forward damage to the GPU upload too: only the dirty
        // rectangle gets pushed across PCIe (still drawing the full
        // surface from the texture afterwards, since the unchanged
        // pixels live in the texture from previous frames).
        let upload_region = damage.map(|r| {
            (
                r.x.max(0.0) as u32,
                r.y.max(0.0) as u32,
                r.w.max(0.0) as u32,
                r.h.max(0.0) as u32,
            )
        });
        if let Err(e) = gpu.present_region(&self.pixels, upload_region) {
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
        let item = layout.items.iter().find(|it| it.node_id == id)?;
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
        let Some(adapter) = self.ak.as_mut() else { return };
        let Some(layout) = self.layout.as_ref() else { return };
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
                ItemKind::Input { value, placeholder, .. } => {
                    value.hash(&mut hasher);
                    placeholder.hash(&mut hasher);
                }
                _ => {}
            }
        }
        let fp = hasher.finish();
        if fp == self.last_a11y_fingerprint {
            return;
        }
        self.last_a11y_fingerprint = fp;
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
                                if let Some(item) =
                                    layout.items.iter().find(|it| it.node_id == rid)
                                {
                                    if let Some(action) = item.action.clone() {
                                        log::debug!("dispatch (a11y): {action}");
                                        self.module.dispatch_action(&action, None);
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
                // Background worker (image fetch, future async work)
                // finished and wants the renderer to repaint.
                self.request_redraw_full();
            }
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _id: WindowId,
        event: WindowEvent,
    ) {
        if let (Some(adapter), Some(window)) = (self.ak.as_mut(), self.window.as_ref()) {
            adapter.process_event(window, &event);
        }
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                // Coalesce: stash the latest size and let the next
                // redraw apply it once. winit already coalesces
                // request_redraw calls, so a drag burst of N Resized
                // events becomes one gpu.resize + one paint per
                // displayed frame.
                self.pending_resize = Some((size.width, size.height));
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
                        let new_sel =
                            Selection::range(sel.anchor, new_head).clamped(value.len());
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
                    let target = self.layout.as_ref().and_then(|l| {
                        l.items.iter().rev().find(|it| {
                            it.scrollable.is_some() && it.rect.contains(cx, cy)
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
                        let viewport_h = self
                            .gpu
                            .as_ref()
                            .map(|g| g.size.1 as f32)
                            .unwrap_or(0.0);
                        let content_h = self
                            .layout
                            .as_ref()
                            .map(|l| l.content_size.1 + self.scroll_y)
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
                        self.layout = None;
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
                if self.handle_keyboard(&ev) {
                    self.request_redraw_full();
                }
            }
            WindowEvent::Focused(false) => {
                if self.focused.take().is_some() || self.hovered.take().is_some() {
                    self.request_redraw_full();
                }
            }
            WindowEvent::RedrawRequested => {
                self.redraw();
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        // Re-clamp selections against current values whenever patches
        // changed the value out from under us.
        if let Some(layout) = self.layout.as_ref() {
            for item in layout.items.iter() {
                if let ItemKind::Input { value, .. } = &item.kind {
                    if let Some(sel) = self.input_selections.get(&item.node_id).copied() {
                        let clamped = sel.clamped(value.len());
                        if clamped != sel {
                            self.input_selections.insert(item.node_id.clone(), clamped);
                        }
                    }
                }
            }
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

