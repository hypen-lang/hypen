//! Counter demo (Phase 3 → Phase 5 polish).
//!
//! Exercises: `.padding`, `.margin`, `.gap`, `.fontSize`, `.color`,
//! `.backgroundColor`, `.borderWidth`, `.borderColor`, `.borderRadius`
//! and the renderer's hover / press / focus states on `Button`.
//!
//! ```bash
//! cargo run -p hypen-renderer-desktop --example counter
//! ```

use hypen_renderer_desktop::DesktopApp;
use hypen_server::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct CounterState {
    count: i32,
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let app = HypenApp::default();
    let def = HypenApp::module::<CounterState>("Counter")
        .state(CounterState::default())
        .ui(r##"
            Column {
                Text("Hypen Desktop")
                    .fontSize(28)
                    .color("#1a1a1f")
                Text("Click +/- or use Tab and Enter / Space to change the count")
                    .fontSize(14)
                    .color("gray")
                Container {
                    Text("Count: @{state.count}")
                        .fontSize(48)
                        .color("#3554d1")
                }
                    .backgroundColor("white")
                    .borderWidth(1)
                    .borderColor("#dde3f0")
                    .borderRadius(12)
                    .padding(20)
                    .marginTop(8)
                Row {
                    Button("@actions.decrement")
                        .backgroundColor("#fde7e7")
                        .borderWidth(2)
                        .borderColor("#c0392b")
                        .borderRadius(10)
                        .padding(14) {
                            Text("-").fontSize(22).color("#c0392b")
                        }
                    Button("@actions.increment")
                        .backgroundColor("#e7f6ec")
                        .borderWidth(2)
                        .borderColor("#2e7d32")
                        .borderRadius(10)
                        .padding(14) {
                            Text("+").fontSize(22).color("#2e7d32")
                        }
                }.gap(12).marginTop(8)
            }.gap(16)
        "##)
        .on_action::<()>("increment", |state, _payload, _ctx| {
            state.count += 1;
        })
        .on_action::<()>("decrement", |state, _payload, _ctx| {
            state.count -= 1;
        })
        .build();

    let instance = app
        .instantiate(Arc::new(def))
        .expect("instantiate counter module");

    DesktopApp::new()
        .title("Hypen Desktop — Counter")
        .size(560, 420)
        .module(Arc::new(instance))
        .run();
}
