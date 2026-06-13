//! Input demo: text input with two-way state binding.
//!
//! Mouse: click to place the caret, drag to select. Keyboard:
//! Backspace / Delete / arrows to edit, Shift+arrows to extend the
//! selection, Home / End / Shift versions for line edges. Cmd / Ctrl +
//! A selects all; +C / X / V copy / cut / paste through the system
//! clipboard.
//!
//! ```bash
//! cargo run -p hypen-renderer-desktop --example input
//! ```

use hypen_renderer_desktop::DesktopApp;
use hypen_server::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct GreetingState {
    name: String,
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let app = HypenApp::default();
    let def = HypenApp::module::<GreetingState>("Greeting")
        .state(GreetingState::default())
        .ui(r##"
            Column {
                Text("Hypen Desktop — Input demo")
                    .fontSize(24)
                    .color("#1a1a1f")
                Text("Type your name; the greeting below updates as state.")
                    .fontSize(13)
                    .color("gray")
                Input(placeholder: "Your name").bind(@state.name)
                Text("Hello, @{state.name}!")
                    .fontSize(28)
                    .color("#3554d1")
                    .marginTop(8)
            }.gap(14)
        "##)
        .build();

    let instance = app
        .instantiate(Arc::new(def))
        .expect("instantiate input module");

    DesktopApp::new()
        .title("Hypen Desktop — Input")
        .size(560, 320)
        .module(Arc::new(instance))
        .run();
}
