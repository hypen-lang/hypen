//! Top-level app entry — `DesktopApp::new().module(instance).run()`.
//!
//! The renderer drives a [`HypenModule`] (the type-erased Rust SDK
//! `ModuleInstance<S>`). Lifecycle:
//!
//! 1. Caller builds a module via `hypen_server::HypenApp::default().instantiate(...)`.
//! 2. Caller hands it to `DesktopApp::module(instance)`.
//! 3. `run()` wires the patch callback and calls `mount()` so the SDK's
//!    deferred initial render flushes through that callback.
//! 4. winit owns the event loop and pulls patches each frame.
//!
//! For trivial demos (`Text` / `Column` only, no state) [`Self::source`]
//! builds a stateless module behind the scenes.

use crate::module::HypenModule;
use crate::window::{App as WindowApp, PatchQueue};
use hypen_server::app::HypenApp;
use hypen_server::module::ModuleBuilder;
use std::sync::Arc;
use winit::event_loop::{ControlFlow, EventLoop};

pub struct DesktopApp {
    title: String,
    size: (u32, u32),
    module: Option<Arc<dyn HypenModule>>,
}

impl DesktopApp {
    pub fn new() -> Self {
        Self {
            title: "Hypen Desktop".into(),
            size: (960, 640),
            module: None,
        }
    }

    pub fn title(mut self, t: impl Into<String>) -> Self {
        self.title = t.into();
        self
    }

    pub fn size(mut self, w: u32, h: u32) -> Self {
        self.size = (w, h);
        self
    }

    /// Drive the window with a fully-built SDK module instance.
    ///
    /// ```rust,ignore
    /// use hypen_server::prelude::*;
    /// use hypen_renderer_desktop::DesktopApp;
    /// use std::sync::Arc;
    ///
    /// #[derive(Default, Clone, Serialize, Deserialize)]
    /// struct MyState { count: i32 }
    /// impl State for MyState {}
    ///
    /// let app = HypenApp::default();
    /// let def = HypenApp::module::<MyState>("Counter")
    ///     .state(MyState::default())
    ///     .ui(r#"Text("@{state.count}")"#)
    ///     .build();
    /// let instance = app.instantiate(Arc::new(def)).unwrap();
    ///
    /// DesktopApp::new().module(Arc::new(instance)).run();
    /// ```
    pub fn module(mut self, instance: Arc<dyn HypenModule>) -> Self {
        self.module = Some(instance);
        self
    }

    /// Convenience for stateless demos. Builds an internal module with no
    /// state and no actions, just `ui(source)`. Use [`Self::module`] for
    /// anything richer.
    pub fn source(self, source: impl Into<String>) -> Self {
        let app = HypenApp::default();
        let def = ModuleBuilder::<EmptyState>::new("Desktop")
            .state(EmptyState::default())
            .ui(source.into())
            .build();
        let instance = app
            .instantiate(Arc::new(def))
            .expect("instantiate stateless module for source(...)");
        self.module(Arc::new(instance))
    }

    /// Open the window, mount the module (firing the initial render), and
    /// block until the user closes the window.
    pub fn run(self) {
        let queue = PatchQueue::new();
        let module = self
            .module
            .expect("DesktopApp::run() requires either .module(...) or .source(...)");

        // Wire the patch callback BEFORE mount so the SDK's deferred
        // initial render lands in our queue. (See hypen-sdk-rs commit
        // that moved render_ir_node from new() to mount().)
        let q_for_cb = Arc::clone(&queue);
        module.on_patches(Arc::new(move |patches| q_for_cb.push(patches)));
        module.mount();

        let event_loop = EventLoop::new().expect("event loop");
        event_loop.set_control_flow(ControlFlow::Wait);
        let mut app = WindowApp::new(self.title.clone(), self.size, queue, Arc::clone(&module));
        event_loop.run_app(&mut app).expect("event loop run");
    }
}

impl Default for DesktopApp {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Internal: stateless module support for `DesktopApp::source(...)`.
//
// `State` is a blanket-impl trait (anything Clone+Send+Sync+Serde+'static
// implements it), so this struct picks it up automatically.
// ---------------------------------------------------------------------------

#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
struct EmptyState {}
