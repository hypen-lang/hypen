//! winit `ApplicationHandler` + per-window state.
//!
//! Owns the GPU surface, painter, tree, layout cache, and a handle to the
//! `HypenModule` so click events can dispatch actions back. Patches arrive
//! via the shared `PatchQueue`; we drain on every redraw and request a
//! repaint whenever new patches show up.

use crate::accessibility::{renderer_id_for, tree_update_for_layout};
use crate::gpu::Gpu;
use crate::layout::{ItemKind, LayoutPass};
use crate::module::HypenModule;
use crate::paint::cpu::CpuPainter;
use crate::painter::PaintTarget;
use crate::tree::Tree;
use accesskit::Action as AkAction;
use accesskit_winit::{Adapter as AkAdapter, Event as AkEvent, WindowEvent as AkWindowEvent};
use hypen_engine::Patch;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use winit::application::ApplicationHandler;
use winit::dpi::PhysicalPosition;
use winit::event::{ElementState, KeyEvent, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoopProxy};
use winit::keyboard::{Key, ModifiersState, NamedKey};
use winit::window::{Window, WindowAttributes, WindowId};

/// User-event type carried through the winit event loop. Today this
/// only carries AccessKit events, but a single enum keeps the door open
/// for hot-reload pings, async-action results, etc.
#[derive(Debug)]
pub enum AppEvent {
    Accessibility(AkEvent),
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
    /// `resumed`. The proxy itself is cheap to clone; we keep one
    /// owned copy so the adapter stays connected for the window's
    /// lifetime.
    proxy: EventLoopProxy<AppEvent>,

    window: Option<Arc<Window>>,
    gpu: Option<Gpu>,
    /// Per-window AccessKit adapter. Created in `resumed` (must be
    /// before the window becomes visible per `accesskit_winit`'s
    /// contract) and dropped on close.
    ak: Option<AkAdapter>,
    painter: CpuPainter,
    tree: Tree,
    pixels: Vec<u8>,

    /// Cached layout from the last paint. Used by hit-testing on click,
    /// hover, and press.
    layout: Option<LayoutPass>,
    cursor: PhysicalPosition<f64>,
    /// Renderer node id of the actionable currently under the cursor, if
    /// any. Mirrored into `painter.interaction.hovered` each repaint.
    hovered: Option<String>,
    /// Renderer node id of the actionable the user is currently
    /// holding the left mouse button on. Cleared on mouse-up.
    pressed: Option<String>,
    /// Renderer node id of the keyboard-focused actionable. Tab cycles
    /// forward, Shift+Tab backward, Enter / Space dispatches its action,
    /// Escape clears focus.
    focused: Option<String>,
    /// Tracks current keyboard modifier state so Tab vs Shift+Tab works.
    modifiers: ModifiersState,
    /// Per-Input cursor byte-offset, keyed by renderer node id. Value
    /// lives in the renderer tree (engine round-trips it on every
    /// `__hypen_bind` dispatch); we only need to remember where the
    /// caret sits between keystrokes.
    input_cursors: HashMap<String, usize>,
    /// Vertical page scroll offset in physical pixels. `0.0` means the
    /// top of the content sits at the top of the viewport; a positive
    /// value means the user has scrolled down.
    scroll_y: f32,
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
            input_cursors: HashMap::new(),
            scroll_y: 0.0,
        }
    }

    fn ensure_pixel_buf(&mut self, w: u32, h: u32) {
        let needed = (w as usize) * (h as usize) * 4;
        if self.pixels.len() != needed {
            self.pixels.resize(needed, 0);
        }
    }

    /// Drain pending patches and apply them to the tree. Returns true
    /// when the tree changed (so the caller knows to invalidate cached
    /// layout / request a redraw).
    fn flush_patches(&mut self) -> bool {
        let patches = self.queue.drain();
        if patches.is_empty() {
            false
        } else {
            self.tree.apply_batch(&patches);
            self.layout = None;
            true
        }
    }

    fn redraw(&mut self) {
        self.flush_patches();

        let (w, h, scale) = match (self.gpu.as_ref(), self.window.as_ref()) {
            (Some(gpu), Some(window)) => (gpu.size.0, gpu.size.1, window.scale_factor() as f32),
            _ => return,
        };
        self.ensure_pixel_buf(w, h);

        // Sync hover/press into the painter before drawing so visual
        // state matches the user's pointer at the moment of paint.
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
            interaction.input_cursors = self.input_cursors.clone();
        }

        // Clamp scroll_y against the previous frame's content size if
        // we have one. Re-clamp again below once we have the new
        // content size — this two-step keeps scroll_y sane even when
        // patches shorten the page out from under us.
        if let Some(prev) = self.layout.as_ref() {
            self.scroll_y = clamp_scroll(self.scroll_y, prev.content_size.1, h as f32);
        }

        self.painter.paint_with_scroll(
            &self.tree,
            PaintTarget {
                pixels: &mut self.pixels,
                width: w,
                height: h,
                scale_factor: scale,
            },
            self.scroll_y,
        );
        // Recompute layout once more for hit-testing using the same
        // scroll offset the painter just consumed, so visuals and hits
        // agree by construction.
        let pass = LayoutPass::compute_with_scroll(
            &self.tree,
            self.painter.text_engine_mut(),
            (w, h),
            scale,
            self.scroll_y,
        );
        // Re-clamp using the freshly observed content size. If the
        // clamp moved us, request another redraw so the next frame
        // shows the corrected position.
        let new_scroll = clamp_scroll(self.scroll_y, pass.content_size.1, h as f32);
        if (new_scroll - self.scroll_y).abs() > f32::EPSILON {
            self.scroll_y = new_scroll;
            if let Some(w) = self.window.as_ref() {
                w.request_redraw();
            }
        }
        self.layout = Some(pass);

        let gpu = self.gpu.as_mut().expect("gpu set");
        if let Err(e) = gpu.present(&self.pixels) {
            log::warn!("present failed: {e}");
        }

        // Push the latest accessibility tree once we've laid out. The
        // adapter ignores the call when no assistive tech is listening,
        // so the cost is a noop on systems without a screen reader.
        self.publish_accessibility();
    }

    fn publish_accessibility(&mut self) {
        let Some(adapter) = self.ak.as_mut() else { return };
        let Some(layout) = self.layout.as_ref() else { return };
        adapter.update_if_active(|| tree_update_for_layout(layout));
    }

    /// Hit-test the cached layout and return the actionable node id under
    /// `(x, y)`, if any.
    fn hit_actionable(&self, x: f32, y: f32) -> Option<String> {
        self.layout
            .as_ref()
            .and_then(|l| l.hit(x, y))
            .map(|item| item.node_id.clone())
    }

    /// Hit-test for any focusable item — actionables OR text inputs.
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
            ItemKind::Input {
                value, bind_path, ..
            } => bind_path
                .as_ref()
                .map(|p| (id, value.clone(), p.clone())),
            _ => None,
        }
    }

    /// Apply `mutate(value, cursor)` to the focused Input and dispatch
    /// `__hypen_bind` with the result. Returns true if anything changed.
    fn edit_focused_input<F>(&mut self, mutate: F) -> bool
    where
        F: FnOnce(&str, usize) -> (String, usize),
    {
        let (id, value, bind_path) = match self.focused_input() {
            Some(x) => x,
            None => return false,
        };
        let cursor = self
            .input_cursors
            .get(&id)
            .copied()
            .unwrap_or(value.len())
            .min(value.len());
        let (new_value, new_cursor) = mutate(&value, cursor);
        if new_value == value && new_cursor == cursor {
            return false;
        }
        self.input_cursors
            .insert(id.clone(), new_cursor.min(new_value.len()));
        if new_value != value {
            self.module.dispatch_action(
                "__hypen_bind",
                Some(json!({ "path": bind_path, "value": new_value })),
            );
        }
        true
    }

    /// Look up the action of the currently-focused actionable and
    /// dispatch it. Returns true if anything was dispatched.
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
    /// Enter / Space activates the focused actionable; Escape clears focus.
    /// While an `Input` is focused, printable characters and editing
    /// keys mutate its text and dispatch `__hypen_bind`. Returns true
    /// if anything was handled.
    fn handle_keyboard(&mut self, ev: &KeyEvent) -> bool {
        if ev.state != ElementState::Pressed {
            return false;
        }

        // Editing keys take precedence when an Input is focused.
        let editing_focused = self.focused_input().is_some();

        match ev.logical_key.as_ref() {
            Key::Named(NamedKey::Tab) => {
                let layout = match self.layout.as_ref() {
                    Some(l) => l,
                    None => return false,
                };
                let next = if self.modifiers.shift_key() {
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
                self.edit_focused_input(|val, cursor| {
                    if cursor == 0 {
                        return (val.to_string(), cursor);
                    }
                    let prev = prev_char_boundary(val, cursor);
                    let mut new = String::with_capacity(val.len());
                    new.push_str(&val[..prev]);
                    new.push_str(&val[cursor..]);
                    (new, prev)
                })
            }
            Key::Named(NamedKey::Delete) if editing_focused => {
                self.edit_focused_input(|val, cursor| {
                    if cursor >= val.len() {
                        return (val.to_string(), cursor);
                    }
                    let next = next_char_boundary(val, cursor);
                    let mut new = String::with_capacity(val.len());
                    new.push_str(&val[..cursor]);
                    new.push_str(&val[next..]);
                    (new, cursor)
                })
            }
            Key::Named(NamedKey::ArrowLeft) if editing_focused => {
                self.edit_focused_input(|val, cursor| {
                    (val.to_string(), prev_char_boundary(val, cursor))
                })
            }
            Key::Named(NamedKey::ArrowRight) if editing_focused => {
                self.edit_focused_input(|val, cursor| {
                    (val.to_string(), next_char_boundary(val, cursor))
                })
            }
            Key::Named(NamedKey::Home) if editing_focused => {
                self.edit_focused_input(|val, _| (val.to_string(), 0))
            }
            Key::Named(NamedKey::End) if editing_focused => {
                self.edit_focused_input(|val, _| {
                    let len = val.len();
                    (val.to_string(), len)
                })
            }
            Key::Named(NamedKey::Enter) | Key::Named(NamedKey::Space)
                if !editing_focused =>
            {
                self.dispatch_focused()
            }
            _ => {
                // Printable text (works across layouts + dead keys
                // because winit pre-resolves to the typed string).
                if editing_focused {
                    if let Some(text) = ev.text.as_deref() {
                        // Filter out control bytes — Backspace/etc
                        // surface here too on some platforms.
                        let clean: String = text
                            .chars()
                            .filter(|c| !c.is_control())
                            .collect();
                        if !clean.is_empty() {
                            return self.edit_focused_input(|val, cursor| {
                                let mut new = String::with_capacity(val.len() + clean.len());
                                new.push_str(&val[..cursor]);
                                new.push_str(&clean);
                                new.push_str(&val[cursor..]);
                                let new_cursor = cursor + clean.len();
                                (new, new_cursor)
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
    fn handle_click(&mut self) {
        let (px, py) = (self.cursor.x as f32, self.cursor.y as f32);
        let pressed_id = self.pressed.take();
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
        if let Some(w) = self.window.as_ref() {
            w.request_redraw();
        }
    }
}

impl ApplicationHandler<AppEvent> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        // Create the window invisible so AccessKit can attach before
        // any platform-specific show happens (the adapter panics if the
        // window is already visible — see accesskit_winit's docs).
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

        // Now that AccessKit is attached, reveal the window.
        window.set_visible(true);

        self.window = Some(window);
        self.gpu = Some(gpu);
    }

    fn user_event(&mut self, _event_loop: &ActiveEventLoop, event: AppEvent) {
        match event {
            AppEvent::Accessibility(AkEvent { window_event, .. }) => match window_event {
                AkWindowEvent::InitialTreeRequested => {
                    // The first paint will publish the real tree; for
                    // now nudge a redraw so it happens promptly even
                    // when no other event has fired.
                    if let Some(w) = self.window.as_ref() {
                        w.request_redraw();
                    }
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
                                        if let Some(w) = self.window.as_ref() {
                                            w.request_redraw();
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                AkWindowEvent::AccessibilityDeactivated => {
                    // Adapter stays — `update_if_active` becomes a noop
                    // until reactivated. No state to clear here.
                }
            },
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _id: WindowId,
        event: WindowEvent,
    ) {
        // Let AccessKit observe the raw event before our handlers do —
        // it needs to see focus / scroll changes regardless of whether
        // we choose to act on them.
        if let (Some(adapter), Some(window)) = (self.ak.as_mut(), self.window.as_ref()) {
            adapter.process_event(window, &event);
        }
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                if let Some(gpu) = self.gpu.as_mut() {
                    gpu.resize(size.width, size.height);
                }
                self.layout = None;
                if let Some(w) = self.window.as_ref() {
                    w.request_redraw();
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.cursor = position;
                let new_hover = self.hit_actionable(position.x as f32, position.y as f32);
                if new_hover != self.hovered {
                    self.hovered = new_hover;
                    if let Some(w) = self.window.as_ref() {
                        w.request_redraw();
                    }
                }
            }
            WindowEvent::CursorLeft { .. } => {
                if self.hovered.take().is_some() {
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
                // Two distinct concepts:
                //  - `pressed` tracks which actionable received mouse-
                //    down so we can match it on release for click
                //    semantics; only Buttons/etc. land here.
                //  - `focused` follows the broader focusable hit (also
                //    Inputs) so click-to-focus works for text editing.
                let action_target = self.hit_actionable(cx, cy);
                let focus_target = self.hit_focusable(cx, cy);
                let mut needs_redraw = false;
                if action_target != self.pressed {
                    self.pressed = action_target;
                    needs_redraw = true;
                }
                if focus_target != self.focused {
                    // Park the cursor at the end of the value so the
                    // user can immediately type / arrow without it
                    // sitting at offset 0 from a prior session.
                    if let Some(id) = focus_target.as_deref() {
                        if let Some(item) = self
                            .layout
                            .as_ref()
                            .and_then(|l| l.items.iter().find(|it| it.node_id == id))
                        {
                            if let ItemKind::Input { value, .. } = &item.kind {
                                self.input_cursors.insert(id.to_string(), value.len());
                            }
                        }
                    }
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
                    // PixelDelta is already physical-pixel scroll
                    // (trackpads). LineDelta is reported in lines —
                    // convert to a sensible pixel step.
                    MouseScrollDelta::LineDelta(_, y) => -y * 32.0,
                    MouseScrollDelta::PixelDelta(p) => -p.y as f32,
                };
                if dy.abs() > f32::EPSILON {
                    let viewport_h = self
                        .gpu
                        .as_ref()
                        .map(|g| g.size.1 as f32)
                        .unwrap_or(0.0);
                    let content_h = self
                        .layout
                        .as_ref()
                        .map(|l| l.content_size.1 + self.scroll_y) // un-shifted
                        .unwrap_or(0.0);
                    let new = clamp_scroll(self.scroll_y + dy, content_h, viewport_h);
                    if (new - self.scroll_y).abs() > f32::EPSILON {
                        self.scroll_y = new;
                        // Hover under the cursor changes when scroll
                        // moves — recompute against the (about-to-be-
                        // rebuilt) layout on the next redraw.
                        self.layout = None;
                        if let Some(w) = self.window.as_ref() {
                            w.request_redraw();
                        }
                    }
                }
            }
            WindowEvent::ModifiersChanged(modifiers) => {
                self.modifiers = modifiers.state();
            }
            WindowEvent::KeyboardInput { event: ev, .. } => {
                if self.handle_keyboard(&ev) {
                    if let Some(w) = self.window.as_ref() {
                        w.request_redraw();
                    }
                }
            }
            WindowEvent::Focused(false) => {
                if self.focused.take().is_some() || self.hovered.take().is_some() {
                    if let Some(w) = self.window.as_ref() {
                        w.request_redraw();
                    }
                }
            }
            WindowEvent::RedrawRequested => {
                self.redraw();
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        // Re-clamp cursors against current values whenever patches
        // changed the value out from under us. Cheap; most frames
        // there are zero inputs to walk.
        if let Some(layout) = self.layout.as_ref() {
            for item in layout.items.iter() {
                if let ItemKind::Input { value, .. } = &item.kind {
                    if let Some(c) = self.input_cursors.get(&item.node_id) {
                        if *c > value.len() {
                            self.input_cursors.insert(item.node_id.clone(), value.len());
                        }
                    }
                }
            }
        }
        // (rest of about_to_wait below)
        // Patches that arrived between events (e.g. from an async action
        // handler resolving on another thread) live in the queue. If we
        // see any here, kick a repaint so they apply.
        if !self.queue.is_empty() {
            if let Some(w) = self.window.as_ref() {
                w.request_redraw();
            }
        }
    }
}

/// Clamp `y` into the legal scroll range for `content_h` content
/// against a `viewport_h` viewport. Negative scroll (rubber-banding)
/// isn't supported in Phase 8; content shorter than the viewport is
/// pinned to `0.0`.
pub(crate) fn clamp_scroll(y: f32, content_h: f32, viewport_h: f32) -> f32 {
    let max = (content_h - viewport_h).max(0.0);
    y.clamp(0.0, max)
}

/// Step `cursor` left to the start of the previous UTF-8 codepoint.
/// Returns `0` when already at the start. Used by Backspace / ArrowLeft
/// so multi-byte characters are deleted / skipped as units.
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
/// Returns `s.len()` when already at the end.
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
        // "é" is two bytes in UTF-8.
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
    fn clamp_scroll_pins_to_zero_when_content_fits() {
        // Content shorter than viewport -> any positive scroll
        // collapses to 0.
        assert_eq!(clamp_scroll(0.0, 100.0, 600.0), 0.0);
        assert_eq!(clamp_scroll(50.0, 100.0, 600.0), 0.0);
    }

    #[test]
    fn clamp_scroll_caps_at_max_offset() {
        // 1200 content, 600 viewport -> max scroll = 600.
        assert_eq!(clamp_scroll(0.0, 1200.0, 600.0), 0.0);
        assert_eq!(clamp_scroll(300.0, 1200.0, 600.0), 300.0);
        assert_eq!(clamp_scroll(600.0, 1200.0, 600.0), 600.0);
        assert_eq!(clamp_scroll(900.0, 1200.0, 600.0), 600.0);
    }

    #[test]
    fn clamp_scroll_rejects_negative() {
        assert_eq!(clamp_scroll(-10.0, 1200.0, 600.0), 0.0);
    }

    #[test]
    fn boundary_helpers_handle_emoji_correctly() {
        // 4-byte codepoint.
        let s = "ab😀cd";
        // After "ab" (offset 2), step right should land on offset 6
        // (start of "c"): "a", "b", emoji = 4 bytes => 2+4 = 6.
        assert_eq!(next_char_boundary(s, 2), 6);
        // From "c" back to "b" should step over the emoji.
        assert_eq!(prev_char_boundary(s, 6), 2);
    }
}
