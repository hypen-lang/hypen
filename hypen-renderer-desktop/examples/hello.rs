//! Phase 1 demo: a real Engine parses inline Hypen DSL, emits Patches,
//! the desktop renderer paints them.
//!
//! Run with:
//! ```bash
//! cd hypen-renderer-desktop && cargo run --example hello
//! ```

use hypen_renderer_desktop::DesktopApp;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    DesktopApp::new()
        .title("Hypen Desktop — Hello")
        .size(640, 360)
        .source(
            r#"
            Column {
                Text("Hello from Hypen Desktop")
                Text("Phase 1: Engine -> Patches -> tiny-skia -> wgpu")
                Text("(layout, clicks, native polish coming next)")
            }
            "#,
        )
        .run();
}
