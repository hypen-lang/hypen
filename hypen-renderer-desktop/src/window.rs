//! winit `ApplicationHandler` + per-window state.
//!
//! Owns the GPU surface, painter, tree, layout cache, and a handle to the
//! `HypenModule` so click events can dispatch actions back. Patches arrive
//! via the shared `PatchQueue`; we drain on every redraw and request a
//! repaint whenever new patches show up.

use crate::gpu::Gpu;
use crate::layout::LayoutPass;
use crate::module::HypenModule;
use crate::paint::cpu::CpuPainter;
use crate::painter::{PaintTarget, Painter};
use crate::tree::Tree;
use hypen_engine::Patch;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use winit::application::ApplicationHandler;
use winit::dpi::PhysicalPosition;
use winit::event::{ElementState, KeyEvent, MouseButton, WindowEvent};
use winit::keyboard::{Key, ModifiersState, NamedKey};
use winit::event_loop::ActiveEventLoop;
use winit::window::{Window, WindowAttributes, WindowId};

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

    window: Option<Arc<Window>>,
    gpu: Option<Gpu>,
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
}

impl App {
    pub fn new(
        title: impl Into<String>,
        initial_size: (u32, u32),
        queue: Arc<PatchQueue>,
        module: Arc<dyn HypenModule>,
    ) -> Self {
        Self {
            title: title.into(),
            initial_size,
            queue,
            module,
            window: None,
            gpu: None,
            painter: CpuPainter::new(),
            tree: Tree::new(),
            pixels: Vec::new(),
            layout: None,
            cursor: PhysicalPosition::new(0.0, 0.0),
            hovered: None,
            pressed: None,
            focused: None,
            modifiers: ModifiersState::default(),
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
        }

        self.painter.paint(
            &self.tree,
            PaintTarget {
                pixels: &mut self.pixels,
                width: w,
                height: h,
                scale_factor: scale,
            },
        );
        // Stash a fresh layout for hit testing — same pass the painter
        // just consumed, so visuals and hits agree by construction.
        self.layout = Some(LayoutPass::compute(
            &self.tree,
            self.painter.text_engine_mut(),
            (w, h),
            scale,
        ));

        let gpu = self.gpu.as_mut().expect("gpu set");
        if let Err(e) = gpu.present(&self.pixels) {
            log::warn!("present failed: {e}");
        }
    }

    /// Hit-test the cached layout and return the actionable node id under
    /// `(x, y)`, if any.
    fn hit_actionable(&self, x: f32, y: f32) -> Option<String> {
        self.layout
            .as_ref()
            .and_then(|l| l.hit(x, y))
            .map(|item| item.node_id.clone())
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
    /// Returns true if anything was handled (so the caller can request
    /// a redraw).
    fn handle_keyboard(&mut self, ev: &KeyEvent) -> bool {
        if ev.state != ElementState::Pressed {
            return false;
        }
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
            Key::Named(NamedKey::Enter) | Key::Named(NamedKey::Space) => {
                self.dispatch_focused()
            }
            Key::Named(NamedKey::Escape) => {
                if self.focused.take().is_some() {
                    return true;
                }
                false
            }
            _ => false,
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

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = WindowAttributes::default()
            .with_title(self.title.clone())
            .with_inner_size(winit::dpi::PhysicalSize::new(
                self.initial_size.0,
                self.initial_size.1,
            ));
        let window = Arc::new(
            event_loop
                .create_window(attrs)
                .expect("create winit window"),
        );
        let gpu = pollster::block_on(Gpu::new(Arc::clone(&window)));
        self.window = Some(window);
        self.gpu = Some(gpu);
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _id: WindowId,
        event: WindowEvent,
    ) {
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
                let target =
                    self.hit_actionable(self.cursor.x as f32, self.cursor.y as f32);
                if target != self.pressed {
                    self.pressed = target;
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
