//! Remote demo: connect to a running Hypen `RemoteServer`.
//!
//! Run a server first — e.g. the bundled social example:
//!
//! ```bash
//! cd examples/social/typescript && bun install && bun run dev
//! ```
//!
//! The server prints something like `listening on http://localhost:3000`.
//! Then in another terminal:
//!
//! ```bash
//! cargo run -p hypen-renderer-desktop --example remote
//! # or override the URL / module:
//! cargo run -p hypen-renderer-desktop --example remote -- ws://localhost:3000 App
//! ```
//!
//! The desktop window shows the server-rendered tree, and clicks
//! dispatch back over the same WebSocket — so any state mutation on
//! the server reflects here on the next patch the server emits.

use hypen_renderer_desktop::DesktopApp;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .init();

    let mut args = std::env::args().skip(1);
    let url = args.next().unwrap_or_else(|| "ws://localhost:3000".into());
    let module = args.next().unwrap_or_else(|| "App".into());

    log::info!("connecting to {url} (module={module})");

    DesktopApp::new()
        .title(format!("Hypen Desktop — {module} @ {url}"))
        .size(960, 720)
        .connect(url, module)
        .run();
}
