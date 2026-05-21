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
    /// pass. When the next frame's key matches, we reuse `self.layout`
    /// instead of running Taffy + cosmic-text again. Captures: tree
    /// generation, viewport (w, h), scale, page scroll, every
    /// per-Container scroll offset.
    last_layout_key: Option<u64>,
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
            clipboard: None,
            ime_preedit: None,
            ime_active: false,
            damage: Damage::Full,
            tree_generation: 0,
            last_layout_key: None,
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
        let cache_miss = self.layout.is_none() || self.last_layout_key != Some(key);
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

    /// Hash the inputs that feed `LayoutPass::compute_with_scrolls`.
    /// Used as a cache key so hover / press / focus / caret-only
    /// frames can reuse the previous frame's layout instead of
    /// rerunning Taffy + cosmic-text.
    fn layout_cache_key(&self, w: u32, h: u32, scale: f32) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h_hasher = std::collections::hash_map::DefaultHasher::new();
        self.tree_generation.hash(&mut h_hasher);
        w.hash(&mut h_hasher);
        h.hash(&mut h_hasher);
        scale.to_bits().hash(&mut h_hasher);
        self.scroll_y.to_bits().hash(&mut h_hasher);
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

    /// Find the focused Input (if any) and return `(node_id, value, bind_path)`.
    fn focused_input(&self) -> Option<(String, String, String)> {
        let id = self.focused.clone()?;
        let layout = self.layout.as_ref()?;
        let item = layout.items.iter().find(|it| it.node_id == id)?;
        match &item.kind {
            ItemKind::Input { value, bind_path, .. } => bind_path
                .as_ref()
                .map(|p| (id, value.clone(), p.clone())),
            _ => None,
        }
    }

    /// Look up an Input's `(value, font_size, rect)` by node id. Used
    /// by mouse-driven cursor positioning + drag-select.
    fn lookup_input(
        &self,
        id: &str,
    ) -> Option<(String, f32, crate::layout::Rect)> {
        let layout = self.layout.as_ref()?;
        let item = layout.items.iter().find(|it| it.node_id == id)?;
        match &item.kind {
            ItemKind::Input { value, font_size, .. } => {
                Some((value.clone(), *font_size, item.rect))
            }
            _ => None,
        }
    }

    /// Read the current selection of `id`, defaulting to a caret at
    /// the end of `value`.
    fn selection_of(&self, id: &str, value: &str) -> Selection {
        self.input_selections
            .get(id)
            .copied()
            .unwrap_or_else(|| Selection::caret(value.len()))
            .clamped(value.len())
    }

    /// Apply `mutate(value, sel)` to the focused Input and dispatch
    /// `__hypen_bind` if the value changed. Returns true if anything
    /// changed (including a pure selection move).
    fn edit_focused_input<F>(&mut self, mutate: F) -> bool
    where
        F: FnOnce(&str, Selection) -> (String, Selection),
    {
        let (id, value, bind_path) = match self.focused_input() {
            Some(x) => x,
            None => return false,
        };
        let sel = self.selection_of(&id, &value);
        let (new_value, new_sel) = mutate(&value, sel);
        let new_sel = new_sel.clamped(new_value.len());
        if new_value == value && new_sel == sel {
            return false;
        }
        self.input_selections.insert(id.clone(), new_sel);
        if new_value != value {
            self.module.dispatch_action(
                "__hypen_bind",
                Some(json!({ "path": bind_path, "value": new_value })),
            );
        }
        true
    }

    /// Replace the selected range (or insert at the caret if collapsed)
    /// with `replacement`. Used by typing + paste. `pub(crate)` so the
    /// test module can exercise the pure logic without an `App`.
    pub(crate) fn replace_selection_with(
        value: &str,
        sel: Selection,
        replacement: &str,
    ) -> (String, Selection) {
        let lo = sel.min().min(value.len());
        let hi = sel.max().min(value.len());
        let mut new = String::with_capacity(value.len() - (hi - lo) + replacement.len());
        new.push_str(&value[..lo]);
        new.push_str(replacement);
        new.push_str(&value[hi..]);
        let caret = lo + replacement.len();
        (new, Selection::caret(caret))
    }

    fn copy_focused_selection(&mut self) -> bool {
        let (id, value, _) = match self.focused_input() {
            Some(x) => x,
            None => return false,
        };
        let sel = self.selection_of(&id, &value);
        if sel.is_collapsed() {
            return false;
        }
        let text = value[sel.min()..sel.max()].to_string();
        match self.clipboard_get() {
            Some(cb) => match cb.set_text(text) {
                Ok(()) => true,
                Err(e) => {
                    log::warn!("clipboard copy failed: {e}");
                    false
                }
            },
            None => false,
        }
    }

    fn cut_focused_selection(&mut self) -> bool {
        if !self.copy_focused_selection() {
            return false;
        }
        self.edit_focused_input(|val, sel| Self::replace_selection_with(val, sel, ""))
    }

    fn paste_into_focused_input(&mut self) -> bool {
        let pasted = match self.clipboard_get().and_then(|cb| cb.get_text().ok()) {
            Some(s) => s,
            None => return false,
        };
        // Single-line `Input` strips embedded newlines; Textarea will
        // preserve them when multi-line editing lands.
        let cleaned: String = pasted.replace(['\n', '\r'], " ");
        if cleaned.is_empty() {
            return false;
        }
        self.edit_focused_input(|val, sel| Self::replace_selection_with(val, sel, &cleaned))
    }

    /// Apply a winit `Ime` event to the focused Input. Pure transition
    /// (toggling flags / setting preedit) lives in
    /// [`apply_ime_transition`]; this method is the side-effecting
    /// adapter that calls `edit_focused_input` on `Commit`.
    fn handle_ime(&mut self, event: Ime) {
        let focused_input_id = self.focused_input().map(|(id, _, _)| id);
        let effect = apply_ime_transition(
            &mut self.ime_preedit,
            &mut self.ime_active,
            focused_input_id.as_deref(),
            event,
        );
        if let ImeEffect::Commit(text) = effect {
            // Insertion goes through the same primitive typing uses,
            // so a non-empty selection is replaced and the caret
            // advances to the end of the inserted text.
            self.edit_focused_input(|val, sel| {
                Self::replace_selection_with(val, sel, &text)
            });
        }
    }

    /// Toggle `set_ime_allowed` on the window so the OS IME activates
    /// when an `Input` is focused and dismisses otherwise. Also updates
    /// `set_ime_cursor_area` so candidate windows position near the
    /// caret instead of in the corner.
    fn sync_ime_to_focus(&mut self) {
        let want_ime = self.focused_input().is_some();
        let Some(window) = self.window.as_ref() else { return };
        if want_ime != self.ime_active {
            window.set_ime_allowed(want_ime);
            self.ime_active = want_ime;
            if !want_ime {
                self.ime_preedit = None;
                self.last_ime_target = None;
            }
        }
        if want_ime {
            // Only call `set_ime_cursor_area` when the focused Input's
            // rect or identity actually moves. The OS winit backends
            // translate this into platform syscalls that are cheap
            // individually but show up in profiles when called every
            // frame on a focused input that hasn't moved.
            if let Some(id) = self.focused.as_deref() {
                if let Some((_, _, rect)) = self.lookup_input(id) {
                    let target = (
                        id.to_string(),
                        (rect.x as i32, rect.y as i32, rect.w as u32, rect.h as u32),
                    );
                    if self.last_ime_target.as_ref() != Some(&target) {
                        use winit::dpi::PhysicalPosition as P;
                        use winit::dpi::PhysicalSize as S;
                        window.set_ime_cursor_area(
                            P::new(target.1 .0, target.1 .1),
                            S::new(target.1 .2, target.1 .3),
                        );
                        self.last_ime_target = Some(target);
                    }
                }
            }
        }
    }

    fn dispatch_focused(&mut self) -> bool {
        let action = (|| -> Option<String> {
            let id = self.focused.as_deref()?;
            let layout = self.layout.as_ref()?;
            let item = layout.items.iter().find(|it| it.node_id == id)?;
            item.action.clone()
        })();
        if let Some(action) = action {
            log::debug!("dispatch (kbd): {action}");
            self.module.dispatch_action(&action, None);
            true
        } else {
            false
        }
    }

    /// Handle keyboard input. Tab walks focus forward, Shift+Tab back;
    /// Enter / Space activates the focused actionable; Escape clears
    /// focus. While an `Input` is focused, editing keys mutate its
    /// text + selection and dispatch `__hypen_bind`. Ctrl/Cmd shortcuts
    /// (A / C / X / V) cover select-all + clipboard.
    fn handle_keyboard(&mut self, ev: &KeyEvent) -> bool {
        if ev.state != ElementState::Pressed {
            return false;
        }

        let editing_focused = self.focused_input().is_some();
        let shift = self.modifiers.shift_key();
        let cmd = self.clipboard_modifier();

        if cmd && editing_focused {
            match ev.logical_key.as_ref() {
                Key::Character(s) if s.eq_ignore_ascii_case("a") => {
                    return self.edit_focused_input(|val, _| {
                        (val.to_string(), Selection::range(0, val.len()))
                    });
                }
                Key::Character(s) if s.eq_ignore_ascii_case("c") => {
                    return self.copy_focused_selection();
                }
                Key::Character(s) if s.eq_ignore_ascii_case("x") => {
                    return self.cut_focused_selection();
                }
                Key::Character(s) if s.eq_ignore_ascii_case("v") => {
                    return self.paste_into_focused_input();
                }
                _ => {}
            }
        }

        match ev.logical_key.as_ref() {
            Key::Named(NamedKey::Tab) => {
                let layout = match self.layout.as_ref() {
                    Some(l) => l,
                    None => return false,
                };
                let next = if shift {
                    layout.focus_prev(self.focused.as_deref())
                } else {
                    layout.focus_next(self.focused.as_deref())
                };
                if next != self.focused {
                    self.focused = next;
                    return true;
                }
                false
            }
            Key::Named(NamedKey::Escape) => self.focused.take().is_some(),
            Key::Named(NamedKey::Backspace) if editing_focused => {
                self.edit_focused_input(|val, sel| {
                    if !sel.is_collapsed() {
                        return Self::replace_selection_with(val, sel, "");
                    }
                    if sel.head == 0 {
                        return (val.to_string(), sel);
                    }
                    let prev = prev_char_boundary(val, sel.head);
                    let mut new = String::with_capacity(val.len());
                    new.push_str(&val[..prev]);
                    new.push_str(&val[sel.head..]);
                    (new, Selection::caret(prev))
                })
            }
            Key::Named(NamedKey::Delete) if editing_focused => {
                self.edit_focused_input(|val, sel| {
                    if !sel.is_collapsed() {
                        return Self::replace_selection_with(val, sel, "");
                    }
                    if sel.head >= val.len() {
                        return (val.to_string(), sel);
                    }
                    let next = next_char_boundary(val, sel.head);
                    let mut new = String::with_capacity(val.len());
                    new.push_str(&val[..sel.head]);
                    new.push_str(&val[next..]);
                    (new, Selection::caret(sel.head))
                })
            }
            Key::Named(NamedKey::ArrowLeft) if editing_focused => {
                self.edit_focused_input(move |val, sel| {
                    let new_head = if shift || sel.is_collapsed() {
                        prev_char_boundary(val, sel.head)
                    } else {
                        sel.min()
                    };
                    let anchor = if shift { sel.anchor } else { new_head };
                    (val.to_string(), Selection::range(anchor, new_head))
                })
            }
            Key::Named(NamedKey::ArrowRight) if editing_focused => {
                self.edit_focused_input(move |val, sel| {
                    let new_head = if shift || sel.is_collapsed() {
                        next_char_boundary(val, sel.head)
                    } else {
                        sel.max()
                    };
                    let anchor = if shift { sel.anchor } else { new_head };
                    (val.to_string(), Selection::range(anchor, new_head))
                })
            }
            Key::Named(NamedKey::Home) if editing_focused => {
                self.edit_focused_input(move |val, sel| {
                    let anchor = if shift { sel.anchor } else { 0 };
                    (val.to_string(), Selection::range(anchor, 0))
                })
            }
            Key::Named(NamedKey::End) if editing_focused => {
                self.edit_focused_input(move |val, sel| {
                    let len = val.len();
                    let anchor = if shift { sel.anchor } else { len };
                    (val.to_string(), Selection::range(anchor, len))
                })
            }
            Key::Named(NamedKey::Enter) | Key::Named(NamedKey::Space)
                if !editing_focused =>
            {
                self.dispatch_focused()
            }
            _ => {
                if editing_focused {
                    if let Some(text) = ev.text.as_deref() {
                        let clean: String =
                            text.chars().filter(|c| !c.is_control()).collect();
                        if !clean.is_empty() {
                            return self.edit_focused_input(|val, sel| {
                                Self::replace_selection_with(val, sel, &clean)
                            });
                        }
                    }
                }
                false
            }
        }
    }

    /// Handle a mouse-up. Dispatches an action only when the pointer
    /// is still over the same actionable that received mouse-down.
    /// Drag-select state clears regardless.
    fn handle_click(&mut self) {
        let (px, py) = (self.cursor.x as f32, self.cursor.y as f32);
        let pressed_id = self.pressed.take();
        // Press tint always disappears on release; damage the released
        // button so it repaints in the un-pressed colour.
        if let Some(id) = pressed_id.as_deref() {
            if let Some(r) = self.item_damage_rect(id) {
                self.damage.add_region(r);
            }
        }
        if let Some(layout) = self.layout.as_ref() {
            if let Some(item) = layout.hit(px, py) {
                let same_target = pressed_id
                    .as_deref()
                    .map(|id| id == item.node_id)
                    .unwrap_or(true);
                if same_target {
                    if let Some(action) = item.action.clone() {
                        log::debug!("dispatch action: {action}");
                        self.module.dispatch_action(&action, None);
                    }
                }
            }
        }
        self.dragging_input = None;
        self.request_redraw_full();
    }
}

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
                            self.input_selections.insert(drag_id, new_sel);
                            self.request_redraw_full();
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

                if action_target != self.pressed {
                    let prev = self.pressed.clone();
                    self.mark_interaction_damage(prev.as_deref(), action_target.as_deref());
                    self.pressed = action_target;
                    needs_redraw = true;
                }

                // Click-to-position cursor for Inputs. Compute the byte
                // offset under the click and seed both anchor + head
                // there so a non-drag click collapses any prior
                // selection at the click point.
                if let Some(id) = focus_target.as_deref() {
                    if let Some((value, font_size, rect)) = self.lookup_input(id) {
                        let local_x = (cx - rect.x - 12.0).max(0.0);
                        let byte = self
                            .painter
                            .text_engine_mut()
                            .byte_offset_at_x(&value, local_x, font_size);
                        self.input_selections
                            .insert(id.to_string(), Selection::caret(byte));
                        self.dragging_input = Some(id.to_string());
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
                    let mut scrolled = false;
                    if let Some(item) = target {
                        let meta = item.scrollable.unwrap();
                        let max = (meta.content_h - item.rect.h).max(0.0);
                        let id = item.node_id.clone();
                        let cur = self.scrollables.get(&id).copied().unwrap_or(0.0);
                        let new = (cur + dy).clamp(0.0, max);
                        if (new - cur).abs() > f32::EPSILON {
                            self.scrollables.insert(id, new);
                            scrolled = true;
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
                            scrolled = true;
                        }
                    }
                    if scrolled {
                        self.layout = None;
                        self.request_redraw_full();
                    }
                }
            }
            WindowEvent::ModifiersChanged(modifiers) => {
                self.modifiers = modifiers.state();
            }
            WindowEvent::Ime(ime_ev) => {
                self.handle_ime(ime_ev);
                self.request_redraw_full();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prev_boundary_steps_back_one_ascii_char() {
        assert_eq!(prev_char_boundary("hello", 5), 4);
        assert_eq!(prev_char_boundary("hello", 1), 0);
        assert_eq!(prev_char_boundary("hello", 0), 0);
    }

    #[test]
    fn prev_boundary_steps_over_multibyte() {
        let s = "é";
        assert_eq!(s.len(), 2);
        assert_eq!(prev_char_boundary(s, 2), 0);
    }

    #[test]
    fn next_boundary_steps_forward_one_ascii_char() {
        assert_eq!(next_char_boundary("hello", 0), 1);
        assert_eq!(next_char_boundary("hello", 4), 5);
        assert_eq!(next_char_boundary("hello", 5), 5);
    }

    #[test]
    fn next_boundary_steps_over_multibyte() {
        let s = "é";
        assert_eq!(next_char_boundary(s, 0), 2);
    }

    #[test]
    fn boundary_helpers_handle_emoji_correctly() {
        let s = "ab😀cd";
        assert_eq!(next_char_boundary(s, 2), 6);
        assert_eq!(prev_char_boundary(s, 6), 2);
    }

    #[test]
    fn clamp_scroll_pins_to_zero_when_content_fits() {
        assert_eq!(clamp_scroll(0.0, 100.0, 600.0), 0.0);
        assert_eq!(clamp_scroll(50.0, 100.0, 600.0), 0.0);
    }

    #[test]
    fn clamp_scroll_caps_at_max_offset() {
        assert_eq!(clamp_scroll(0.0, 1200.0, 600.0), 0.0);
        assert_eq!(clamp_scroll(300.0, 1200.0, 600.0), 300.0);
        assert_eq!(clamp_scroll(600.0, 1200.0, 600.0), 600.0);
        assert_eq!(clamp_scroll(900.0, 1200.0, 600.0), 600.0);
    }

    #[test]
    fn clamp_scroll_rejects_negative() {
        assert_eq!(clamp_scroll(-10.0, 1200.0, 600.0), 0.0);
    }

    // ---------------------------------------------------------------
    // Selection helpers
    // ---------------------------------------------------------------

    #[test]
    fn selection_caret_collapses_anchor_and_head() {
        let s = Selection::caret(5);
        assert_eq!(s.anchor, 5);
        assert_eq!(s.head, 5);
        assert!(s.is_collapsed());
        assert_eq!(s.min(), 5);
        assert_eq!(s.max(), 5);
    }

    #[test]
    fn selection_range_min_max_normalise_order() {
        let forward = Selection::range(2, 7);
        assert_eq!(forward.min(), 2);
        assert_eq!(forward.max(), 7);
        assert!(!forward.is_collapsed());

        let backward = Selection::range(7, 2);
        assert_eq!(backward.min(), 2);
        assert_eq!(backward.max(), 7);
        assert!(!backward.is_collapsed());
    }

    #[test]
    fn selection_clamped_pins_each_field_to_max() {
        assert_eq!(
            Selection::range(5, 100).clamped(10),
            Selection::range(5, 10),
        );
        assert_eq!(
            Selection::range(20, 30).clamped(10),
            Selection::range(10, 10),
        );
        assert!(Selection::range(20, 30).clamped(10).is_collapsed());
    }

    // ---------------------------------------------------------------
    // replace_selection_with
    // ---------------------------------------------------------------

    #[test]
    fn replace_inserts_at_caret_when_collapsed() {
        let (new, sel) = App::replace_selection_with("hello", Selection::caret(5), " world");
        assert_eq!(new, "hello world");
        assert_eq!(sel, Selection::caret(11));
    }

    #[test]
    fn replace_at_zero_prepends() {
        let (new, sel) = App::replace_selection_with("world", Selection::caret(0), "hello ");
        assert_eq!(new, "hello world");
        assert_eq!(sel, Selection::caret(6));
    }

    #[test]
    fn replace_substitutes_a_range() {
        let (new, sel) =
            App::replace_selection_with("hello world", Selection::range(0, 5), "yo");
        assert_eq!(new, "yo world");
        assert_eq!(sel, Selection::caret(2));
    }

    #[test]
    fn replace_handles_reversed_anchor_head() {
        let (new, sel) =
            App::replace_selection_with("hello world", Selection::range(11, 6), "");
        assert_eq!(new, "hello ");
        assert_eq!(sel, Selection::caret(6));
    }

    #[test]
    fn replace_with_empty_deletes_the_selected_range() {
        let (new, sel) =
            App::replace_selection_with("abcde", Selection::range(1, 4), "");
        assert_eq!(new, "ae");
        assert_eq!(sel, Selection::caret(1));
    }

    #[test]
    fn replace_clamps_indices_past_value_length() {
        // Defensive against external state changes that shrank the
        // value before the editor caught up — past-the-end indices
        // collapse to value.len() and the replacement appends.
        let (new, sel) =
            App::replace_selection_with("abc", Selection::range(10, 20), "xy");
        assert_eq!(new, "abcxy");
        assert_eq!(sel, Selection::caret(5));
    }

    #[test]
    fn replace_handles_multibyte_correctly() {
        // "héllo" — h(1) é(2) l(1) l(1) o(1) = 6 bytes.
        // Selecting the "é" (bytes 1..3) and replacing with "i".
        let (new, sel) =
            App::replace_selection_with("héllo", Selection::range(1, 3), "i");
        assert_eq!(new, "hillo");
        assert_eq!(sel, Selection::caret(2));
    }

    // -----------------------------------------------------------------
}
