//! Phase 8 demo: a long Column scrolls with the mouse wheel.
//!
//! ```bash
//! cargo run -p hypen-renderer-desktop --example scroll
//! ```

use hypen_renderer_desktop::DesktopApp;
use hypen_server::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct ScrollState {}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .init();

    // Build a long static page with ~80 styled rows so the
    // viewport definitely overflows.
    let mut rows = String::new();
    for i in 0..80 {
        rows.push_str(&format!(
            "Container {{ Text(\"Row {i}\").fontSize(16).color(\"#1a1a1f\") }}\n    .padding(12).backgroundColor(\"white\").borderWidth(1).borderColor(\"#e3e7ef\").borderRadius(8)\n",
        ));
    }
    let ui = format!(
        r##"Column {{
            Text("Hypen Desktop — Scroll demo").fontSize(24).color("#1a1a1f")
            Text("Mouse wheel to scroll. Indicator on the right.").fontSize(12).color("gray")
            {rows}
        }}.gap(8)"##,
    );

    let app = HypenApp::default();
    let def = HypenApp::module::<ScrollState>("Scroll")
        .state(ScrollState::default())
        .ui(ui)
        .build();

    let instance = app
        .instantiate(Arc::new(def))
        .expect("instantiate scroll module");

    DesktopApp::new()
        .title("Hypen Desktop — Scroll")
        .size(540, 420)
        .module(Arc::new(instance))
        .run();
}
