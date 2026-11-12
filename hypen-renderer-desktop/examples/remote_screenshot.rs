//! Capture a remote Hypen app through the production Desktop/Vello renderer.
//!
//! Usage:
//! `cargo run -p hypen-renderer-desktop --example remote_screenshot -- <ws-url> <output.png> [module] [delay]`
//!
//! `delay` (or the `HYPEN_SCREENSHOT_DELAY` environment variable; the
//! argument wins) is how long to wait after the first non-empty frame
//! before capturing: `3000`, `3000ms` or `3s`. The default (750 ms) only
//! covers local image decodes; apps that fetch data or images over the
//! network need a few seconds or they are captured mid-load.

use hypen_renderer_desktop::DesktopApp;
use std::time::Duration;

/// Parse `3000`, `3000ms`, `3s` or `2.5s`.
fn parse_delay(raw: &str) -> Option<Duration> {
    let s = raw.trim().to_ascii_lowercase();
    if let Some(ms) = s.strip_suffix("ms") {
        return ms.trim().parse::<u64>().ok().map(Duration::from_millis);
    }
    if let Some(secs) = s.strip_suffix('s') {
        return secs
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(Duration::from_secs_f64);
    }
    s.parse::<u64>().ok().map(Duration::from_millis)
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();

    let mut args = std::env::args().skip(1);
    let url = args.next().expect("missing WebSocket URL");
    let output = args.next().expect("missing screenshot output path");
    let module = args.next().unwrap_or_else(|| "App".to_string());
    let delay = args
        .next()
        .or_else(|| std::env::var("HYPEN_SCREENSHOT_DELAY").ok())
        .map(|raw| parse_delay(&raw).unwrap_or_else(|| panic!("bad screenshot delay {raw:?}")));

    let mut app = DesktopApp::new()
        .title(format!("Hypen Desktop — {module}"))
        .size(430, 934)
        .reduced_motion(true)
        .screenshot(output);
    if let Some(delay) = delay {
        app = app.screenshot_delay(delay);
    }
    app.connect(url, module).run();
}
