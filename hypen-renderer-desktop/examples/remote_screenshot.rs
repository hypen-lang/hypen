//! Capture a remote Hypen app through the production Desktop/Vello renderer.
//!
//! Usage:
//! `cargo run -p hypen-renderer-desktop --example remote_screenshot -- <ws-url> <output.png> [module] [delay] [options]`
//!
//! `delay` (or the `HYPEN_SCREENSHOT_DELAY` environment variable; the
//! argument wins) is how long to wait after the first non-empty frame
//! before capturing: `3000`, `3000ms` or `3s`. The default (750 ms) only
//! covers local image decodes; apps that fetch data or images over the
//! network need a few seconds or they are captured mid-load.
//!
//! Options (anywhere on the command line, applied in order):
//! - `--route /path` — dispatch `router.replace` with `{"to": "/path"}`
//!   (what the web client does for a deep link).
//! - `--action name` / `--action 'name={"json":"payload"}'` — dispatch an
//!   arbitrary action (repeatable).
//! - `--settle 1500ms` — pause before the first action and between
//!   actions (default 1.5 s). The capture delay is extended by the total
//!   settle time, so the shot is still `delay` after the last action.

use hypen_renderer_desktop::DesktopApp;
use serde_json::Value;
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

#[derive(Debug, PartialEq)]
struct Args {
    url: String,
    output: String,
    module: String,
    delay: Option<Duration>,
    actions: Vec<(String, Value)>,
    settle: Option<Duration>,
}

/// Parse `name` or `name=<json>` (a payload that is not valid JSON is
/// sent as a JSON string).
fn parse_action(raw: &str) -> (String, Value) {
    match raw.split_once('=') {
        Some((name, payload)) => {
            let value = serde_json::from_str(payload)
                .unwrap_or_else(|_| Value::String(payload.to_string()));
            (name.trim().to_string(), value)
        }
        None => (raw.trim().to_string(), Value::Null),
    }
}

fn parse_args(raw: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut positional = Vec::new();
    let mut actions = Vec::new();
    let mut settle = None;
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        let mut value = |flag: &str| it.next().ok_or_else(|| format!("{flag} needs a value"));
        match arg.as_str() {
            "--route" => {
                let to = value("--route")?;
                actions.push((
                    "router.replace".to_string(),
                    serde_json::json!({ "to": to }),
                ));
            }
            "--action" => actions.push(parse_action(&value("--action")?)),
            "--settle" => {
                let raw = value("--settle")?;
                settle = Some(parse_delay(&raw).ok_or_else(|| format!("bad --settle {raw:?}"))?);
            }
            flag if flag.starts_with("--") => return Err(format!("unknown option {flag}")),
            _ => positional.push(arg),
        }
    }
    let mut positional = positional.into_iter();
    let url = positional.next().ok_or("missing WebSocket URL")?;
    let output = positional.next().ok_or("missing screenshot output path")?;
    let module = positional.next().unwrap_or_else(|| "App".to_string());
    let delay = match positional.next() {
        Some(raw) => {
            Some(parse_delay(&raw).ok_or_else(|| format!("bad screenshot delay {raw:?}"))?)
        }
        None => None,
    };
    if let Some(extra) = positional.next() {
        return Err(format!("unexpected argument {extra:?}"));
    }
    Ok(Args {
        url,
        output,
        module,
        delay,
        actions,
        settle,
    })
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();

    let args = parse_args(std::env::args().skip(1)).unwrap_or_else(|e| panic!("{e}"));
    let delay = args.delay.or_else(|| {
        std::env::var("HYPEN_SCREENSHOT_DELAY")
            .ok()
            .map(|raw| parse_delay(&raw).unwrap_or_else(|| panic!("bad screenshot delay {raw:?}")))
    });

    let mut app = DesktopApp::new()
        .title(format!("Hypen Desktop — {}", args.module))
        .size(430, 934)
        .reduced_motion(true)
        .screenshot(args.output)
        .startup_actions(args.actions);
    if let Some(settle) = args.settle {
        app = app.startup_action_settle(settle);
    }
    if let Some(delay) = delay {
        app = app.screenshot_delay(delay);
    }
    app.connect(args.url, args.module).run();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(args: &[&str]) -> Result<Args, String> {
        parse_args(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn positional_arguments_keep_working() {
        let a = parse(&["ws://h/ws", "out.png"]).unwrap();
        assert_eq!(a.module, "App");
        assert_eq!(a.delay, None);
        assert!(a.actions.is_empty());
        let a = parse(&["ws://h/ws", "out.png", "Main", "3s"]).unwrap();
        assert_eq!(a.module, "Main");
        assert_eq!(a.delay, Some(Duration::from_secs(3)));
    }

    #[test]
    fn routes_and_actions_are_collected_in_order() {
        let a = parse(&[
            "--route",
            "/story/1",
            "ws://h/ws",
            "--action",
            r#"selectTab={"tab":"cart"}"#,
            "out.png",
            "--action",
            "refresh",
            "--action",
            "search=plain text",
            "--settle",
            "800ms",
        ])
        .unwrap();
        assert_eq!(a.url, "ws://h/ws");
        assert_eq!(a.output, "out.png");
        assert_eq!(a.settle, Some(Duration::from_millis(800)));
        assert_eq!(
            a.actions,
            vec![
                ("router.replace".into(), json!({"to": "/story/1"})),
                ("selectTab".into(), json!({"tab": "cart"})),
                ("refresh".into(), Value::Null),
                ("search".into(), json!("plain text")),
            ]
        );
    }

    #[test]
    fn bad_input_is_reported() {
        assert!(parse(&["ws://h/ws"]).is_err());
        assert!(parse(&["ws://h/ws", "o.png", "--route"]).is_err());
        assert!(parse(&["ws://h/ws", "o.png", "--bogus"]).is_err());
        assert!(parse(&["ws://h/ws", "o.png", "App", "soon"]).is_err());
    }
}
