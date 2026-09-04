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
use std::path::PathBuf;
use std::sync::Arc;
use winit::event_loop::{ControlFlow, EventLoop};

pub struct DesktopApp {
    title: String,
    size: (u32, u32),
    module: Option<Arc<dyn HypenModule>>,
    shortcuts: Vec<crate::window::ShortcutBinding>,
    unified_titlebar: bool,
    reduced_motion: Option<bool>,
    window_icon: Option<winit::window::Icon>,
    safe_area_insets: crate::layout::SafeAreaInsets,
    screenshot_path: Option<PathBuf>,
}

impl DesktopApp {
    pub fn new() -> Self {
        Self {
            title: "Hypen Desktop".into(),
            size: (960, 640),
            module: None,
            shortcuts: Vec::new(),
            unified_titlebar: false,
            reduced_motion: None,
            window_icon: None,
            safe_area_insets: crate::layout::SafeAreaInsets::default(),
            screenshot_path: None,
        }
    }

    /// Declare the window's safe-area insets, in logical px. `SafeArea`
    /// containers pad themselves by these on whichever edges their
    /// `edges` prop selects.
    ///
    /// Desktop's platform default is zero on every edge — a desktop
    /// window has no notch or home indicator — with one exception:
    /// under [`Self::unified_titlebar`] on macOS, the window-controls
    /// bar (close / minimize / maximize) is drawn over the content, so
    /// the renderer installs its height
    /// ([`crate::layout::WINDOW_CONTROLS_BAR_HEIGHT`]) as the platform
    /// top inset automatically. So by default a `SafeArea { ... }` lays
    /// out exactly like a full-size `Column`, except that it clears the
    /// controls bar when there is one. Overrides are per-edge and merge
    /// over the platform values, so an embedder declares only the edges
    /// it additionally covers:
    ///
    /// ```rust,ignore
    /// use hypen_renderer_desktop::{DesktopApp, SafeAreaInsets};
    /// DesktopApp::new()
    ///     // Reserve a 40px bottom overlay HUD; top keeps the platform
    ///     // value (the controls bar under a unified titlebar, else 0).
    ///     .safe_area_insets(SafeAreaInsets::default().with_bottom(40.0))
    ///     .run();
    /// ```
    pub fn safe_area_insets(mut self, insets: crate::layout::SafeAreaInsets) -> Self {
        self.safe_area_insets = insets;
        self
    }

    /// Programmatically force reduced motion on or off for this window.
    /// When unset, the renderer follows the `HYPEN_REDUCED_MOTION`
    /// environment variable (`1`/`true`/`yes`/`on`), defaulting to
    /// motion enabled. There is no reliable cross-platform OS
    /// reduced-motion query in this stack, so configuration is the v1
    /// gate (a recorded narrowing against the web renderers'
    /// `prefers-reduced-motion` media query). Per-node
    /// `.motion(essential)` opt-outs are honored either way.
    pub fn reduced_motion(mut self, on: bool) -> Self {
        self.reduced_motion = Some(on);
        self
    }

    /// Register a keyboard shortcut. When the user presses the key
    /// combo, the renderer dispatches `action_name` against the
    /// mounted [`HypenModule`] with the given static `payload`.
    ///
    /// ```rust,ignore
    /// use hypen_renderer_desktop::{DesktopApp, Shortcut};
    /// DesktopApp::new()
    ///     .shortcut(Shortcut::cmd("l"), "focus_url", None)
    ///     .shortcut(Shortcut::plain("Escape"), "esc", None)
    ///     .run();
    /// ```
    ///
    /// `cmd` and `ctrl` are treated as the same modifier
    /// cross-platform — the macOS convention (`Cmd+L`) and the
    /// Linux / Windows convention (`Ctrl+L`) fire the same handler.
    /// Useful for `Cmd+L` (focus URL), `Cmd+R` (refresh), `Cmd+W`
    /// (close), etc. in browser-style apps. Shortcuts only fire
    /// when no text Input has the focus — typing a literal `l` into
    /// an address bar never accidentally dispatches `focus_url`.
    pub fn shortcut(
        mut self,
        combo: crate::window::Shortcut,
        action_name: impl Into<String>,
        payload: Option<serde_json::Value>,
    ) -> Self {
        self.shortcuts.push(crate::window::ShortcutBinding {
            combo,
            action: action_name.into(),
            payload,
        });
        self
    }

    pub fn title(mut self, t: impl Into<String>) -> Self {
        self.title = t.into();
        self
    }

    /// macOS only: merge the window's title bar into the content like
    /// Safari — the title bar goes transparent, the title text hides,
    /// and content extends full-height under it (`fullSizeContentView`)
    /// so the app draws edge-to-edge with the traffic lights floating
    /// over the top. The app is responsible for insetting its own
    /// top-left content so nothing hides behind the traffic lights —
    /// content inside a `SafeArea { ... }` gets that for free: the
    /// controls bar becomes the window's platform safe-area top inset
    /// (see [`Self::safe_area_insets`]). No-op on other platforms.
    pub fn unified_titlebar(mut self, on: bool) -> Self {
        self.unified_titlebar = on;
        self
    }

    pub fn size(mut self, w: u32, h: u32) -> Self {
        self.size = (w, h);
        self
    }

    /// Set the window / taskbar icon from raw RGBA pixels (row-major,
    /// 4 bytes per pixel). Shows in the title bar + taskbar on Windows
    /// and in X11 window switchers on Linux. macOS and Wayland ignore
    /// per-window icons — there the icon comes from the packaged app
    /// (.app bundle .icns / .desktop entry). Invalid data (length ≠
    /// `w * h * 4`) is logged and skipped rather than aborting launch.
    pub fn icon_rgba(mut self, rgba: Vec<u8>, w: u32, h: u32) -> Self {
        match winit::window::Icon::from_rgba(rgba, w, h) {
            Ok(icon) => self.window_icon = Some(icon),
            Err(e) => log::warn!("window icon rejected: {e}"),
        }
        self
    }

    /// Set the window / taskbar icon from an encoded PNG (typically an
    /// `include_bytes!` of a 256px asset). See [`Self::icon_rgba`] for
    /// platform behaviour. A PNG that fails to decode is logged and
    /// skipped rather than aborting launch.
    pub fn icon_png(self, bytes: &[u8]) -> Self {
        match image::load_from_memory_with_format(bytes, image::ImageFormat::Png) {
            Ok(img) => {
                let rgba = img.to_rgba8();
                let (w, h) = rgba.dimensions();
                self.icon_rgba(rgba.into_raw(), w, h)
            }
            Err(e) => {
                log::warn!("window icon PNG failed to decode: {e}");
                self
            }
        }
    }

    /// Save one settled renderer frame as a PNG and close the app.
    ///
    /// The exported image uses the logical dimensions configured by
    /// [`Self::size`], so Retina and standard-density hosts produce the same
    /// screenshot size. This is intended for gallery and visual-regression
    /// capture; ordinary apps should omit it.
    pub fn screenshot(mut self, path: impl Into<PathBuf>) -> Self {
        self.screenshot_path = Some(path.into());
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
    pub fn connect(self, url: impl Into<String>, module_name: impl Into<String>) -> Self {
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
        // Feature `video`: playback pipelines wake the loop the same
        // way — once per decoded frame and per EOS / error event.
        #[cfg(feature = "video")]
        crate::media::set_waker(proxy.clone());
        let mut app = WindowApp::new(
            self.title.clone(),
            self.size,
            queue,
            Arc::clone(&module),
            proxy,
        );
        app.set_shortcuts(self.shortcuts.clone());
        app.set_unified_titlebar(self.unified_titlebar);
        app.set_window_icon(self.window_icon.clone());
        app.set_safe_area_insets(self.safe_area_insets);
        if let Some(on) = self.reduced_motion {
            app.set_reduced_motion(on);
        }
        app.set_screenshot_path(self.screenshot_path.clone());
        event_loop.run_app(&mut app).expect("event loop run");
        if let Some(error) = app.take_screenshot_error() {
            panic!("desktop screenshot failed: {error}");
        }
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
