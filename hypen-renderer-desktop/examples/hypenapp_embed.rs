//! Desktop `HypenApp` embed demo.
//!
//! Run a remote Hypen app first, then pass its WebSocket URL:
//!
//! ```bash
//! cargo run -p hypen-renderer-desktop --example hypenapp_embed -- \
//!   ws://localhost:3000
//! ```

use hypen_renderer_desktop::DesktopApp;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "ws://localhost:3000".into());

    DesktopApp::new()
        .title("HypenApp embed - desktop")
        .size(960, 720)
        .source(format!(
            r##"
Column {{
    Text("Host desktop app").fontSize(24).fontWeight(bold)
    Text("Embedding {url}")
    Container {{
        HypenApp("{url}") {{
            Text("Connecting to embedded app...").slot("loading")
            Text("Embedded app failed to connect").slot("error").color(red)
        }}
    }}
    .padding(16)
    .borderWidth(1)
    .borderColor("#d1d5db")
    .cornerRadius(12)
}}
.gap(12)
.padding(24)
"##
        ))
        .run();
}
