//! Entry point — opens a single desktop window driven by
//! [`hypen_browser::BrowserModule`].

use hypen_browser::{BrowserModule, Storage};
use hypen_renderer_desktop::{DesktopApp, Shortcut};

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .init();

    let storage = Storage::load();
    let module = BrowserModule::build(storage);

    DesktopApp::new()
        .title("Hypen Browser")
        .size(1024, 720)
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
