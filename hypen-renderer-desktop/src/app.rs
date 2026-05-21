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
use crate::remote::RemoteModule;
use crate::window::{App as WindowApp, AppEvent, PatchQueue};
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

    /// Connect to a remote `RemoteServer` over WebSocket and stream
    /// patches from a registered module by name. Counterpart to the
    /// TypeScript `RemoteServer` in `hypen-web/packages/server`. The
    /// renderer doesn't care whether the engine runs in-process or
    /// across the network — the same `HypenModule` contract holds.
    ///
    /// ```rust,ignore
    /// // Server (TS, in your example app):
    /// //   new RemoteServer().module("Counter", counter)
    /// //     .ui(`Column { Text("Count: @{state.count}") }`)
    /// //     .listen(3000);
    /// //
    /// // Client (this binary):
    /// DesktopApp::new()
    ///     .title("Counter (remote)")
    ///     .connect("ws://localhost:3000", "Counter")
    ///     .run();
    /// ```
    pub fn connect(
        self,
        url: impl Into<String>,
        module_name: impl Into<String>,
    ) -> Self {
        let remote = RemoteModule::connect(url, module_name);
        self.module(Arc::new(remote))
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

        // AccessKit pipes events back to us through the winit user
        // event channel, so we need a typed event loop.
        let event_loop = EventLoop::<AppEvent>::with_user_event()
            .build()
            .expect("event loop");
        event_loop.set_control_flow(ControlFlow::Wait);
        let proxy = event_loop.create_proxy();

        // Wire the patch callback BEFORE mount so the SDK's deferred
        // initial render lands in our queue. (See hypen-sdk-rs commit
        // that moved render_ir_node from new() to mount().) Patches
        // can arrive on a worker thread (async action handlers); we
        // also need to wake the event loop so `flush_patches` runs —
        // otherwise the loop sits in `Wait` forever and the UI never
        // reflects the dispatched action.
        let q_for_cb = Arc::clone(&queue);
        let proxy_for_cb = proxy.clone();
        module.on_patches(Arc::new(move |patches| {
            // `push` returns true only on the empty → non-empty
            // transition. Without this gate, an engine that fires a
            // patch batch per frame (or worse, mid-frame) floods
            // winit's user-event queue with redundant Wake events
            // that pile up faster than we drain them — a sneaky
            // memory leak when the window is occluded or macOS
            // app-napped and RedrawRequested isn't being delivered.
            // Once the loop processes one Wake it drains *all*
            // pending patches via `flush_patches` anyway, so a
            // single Wake per batch-burst is sufficient.
            if q_for_cb.push(patches) {
                let _ = proxy_for_cb.send_event(AppEvent::Wake);
            }
        }));
        module.mount();

        // Background image-fetch worker uses the same proxy to wake
        // the renderer when an HTTP avatar finishes decoding.
        crate::paint::image::set_waker(proxy.clone());
        let mut app = WindowApp::new(
            self.title.clone(),
            self.size,
            queue,
            Arc::clone(&module),
            proxy,
        );
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
