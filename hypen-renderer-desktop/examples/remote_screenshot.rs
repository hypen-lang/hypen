//! Capture a remote Hypen app through the production Desktop/Vello renderer.
//!
//! Usage:
//! `cargo run -p hypen-renderer-desktop --example remote_screenshot -- <ws-url> <output.png> [module]`

use hypen_renderer_desktop::DesktopApp;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();

    let mut args = std::env::args().skip(1);
    let url = args.next().expect("missing WebSocket URL");
    let output = args.next().expect("missing screenshot output path");
    let module = args.next().unwrap_or_else(|| "App".to_string());

    DesktopApp::new()
        .title(format!("Hypen Desktop — {module}"))
        .size(430, 934)
        .reduced_motion(true)
        .screenshot(output)
        .connect(url, module)
        .run();
}
