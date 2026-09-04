//! Entry point — opens a single desktop window driven by
//! [`hypen_browser::BrowserModule`].

use hypen_browser::{init_logging, BrowserModule, Storage};
use hypen_renderer_desktop::{DesktopApp, Shortcut};

fn main() {
    // Tee terminal logs into the in-app patch console (the `{ }` panel).
    init_logging();

    let storage = Storage::load();
    let module = BrowserModule::build(storage);

    // Optional CLI argument: a URL to open on launch (`hypen-browser
    // ws://localhost:3000`) — how `hypen run desktop` points the app
    // at the dev server. Same normalization as the address bar, so
    // plain `localhost:3000` works too.
    if let Some(url) = std::env::args().nth(1) {
        module.open_url(&url);
    }

    DesktopApp::new()
        .title("Hypen Browser")
        // Taskbar / window-switcher icon on Windows + Linux/X11. The
        // macOS Dock and Windows Explorer icons come from the packaged
        // artifacts instead (assets/icons/icon.icns in the .app bundle,
        // icon.ico embedded by build.rs).
        .icon_png(include_bytes!("../assets/icons/icon-256.png"))
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
