//! Entry point — opens a single desktop window driven by
//! [`hypen_browser::BrowserModule`].

use hypen_browser::{init_logging, BrowserModule, Storage};
use hypen_renderer_desktop::{DesktopApp, Shortcut};

fn main() {
    // Tee terminal logs into the in-app patch console (the `{ }` panel).
    init_logging();

    let storage = Storage::load();
    let module = BrowserModule::build(storage);

    DesktopApp::new()
        .title("Hypen Browser")
        .size(1024, 720)
        // Safari-style: merge the macOS title bar into the app. The
        // shell insets its toolbar so the traffic lights sit clear.
        .unified_titlebar(true)
        // Browser-style keyboard shortcuts. Cmd is taken interchangeably
        // with Ctrl by the renderer so the same combos fire across
        // macOS / Linux / Windows.
        .shortcut(Shortcut::cmd("l"), "focus_url", None)
        .shortcut(Shortcut::cmd("r"), "refresh", None)
        .shortcut(Shortcut::cmd("w"), "go_home", None)
        .shortcut(Shortcut::plain("Escape"), "esc", None)
        .module(module)
        .run();
}
