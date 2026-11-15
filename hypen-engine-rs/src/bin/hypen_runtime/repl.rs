//! REPL mode: one action per stdin line, state and patches on stdout.
//!
//! ```text
//! <action> [json-payload]
//! <scope>:<action> [json-payload]
//! ```
//!
//! The REPL has no timer thread, so a `Delay` effect is reported rather than
//! scheduled (use `--serve` for real timers). Deferred HTTP requests *are*
//! performed — inline, one after the other, before the next line is read —
//! and each completion's state is printed, so a fetch can be tried from the
//! prompt.

use std::io::{BufRead, Write};

use hypen_engine::Patch;
use serde_json::Value;

use crate::app::{Booted, DispatchRequest, Runtime};
use crate::effects::HostEffects;
use crate::http::perform_blocking;
use crate::error::{one_line, RuntimeError};

/// One parsed REPL line.
#[derive(Debug, PartialEq)]
pub enum Line<'a> {
    Blank,
    Action { name: &'a str, payload: Value },
    /// The payload was not JSON.
    BadPayload(String),
}

/// Split a line into an action name and an optional JSON payload (`{}` when
/// absent).
pub fn parse_line(line: &str) -> Line<'_> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Line::Blank;
    }
    let (name, payload) = match trimmed.split_once(char::is_whitespace) {
        Some((name, rest)) => (name, rest.trim()),
        None => (trimmed, ""),
    };
    if payload.is_empty() {
        return Line::Action { name, payload: Value::Object(Default::default()) };
    }
    match serde_json::from_str(payload) {
        Ok(payload) => Line::Action { name, payload },
        Err(e) => Line::BadPayload(e.to_string()),
    }
}

fn patches_text(patches: &[Patch], pretty: bool) -> String {
    let text = if pretty {
        serde_json::to_string_pretty(patches)
    } else {
        serde_json::to_string(patches)
    };
    text.unwrap_or_else(|_| "[]".into())
}

/// Drive `booted` from `input` until EOF, writing to `output`.
pub fn run(booted: Booted, input: impl BufRead, mut output: impl Write) -> Result<(), RuntimeError> {
    let Booted { runtime, initial_patches } = booted;
    let has_ui = initial_patches.is_some();
    let io_error = |e| RuntimeError::io("write to", "stdout", e);

    let entry = runtime.entry_scope().to_string();
    writeln!(output, "ready: {}", runtime.module_state(&entry)).map_err(io_error)?;
    if let Some(patches) = &initial_patches {
        writeln!(output, "ui: {}", patches_text(patches, true)).map_err(io_error)?;
    }
    eprintln!("(type `<action> [payload]`; Ctrl-D to exit)");

    for line in input.lines() {
        let line = line.map_err(|e| RuntimeError::io("read from", "stdin", e))?;
        let (name, payload) = match parse_line(&line) {
            Line::Blank => continue,
            Line::BadPayload(e) => {
                writeln!(output, "error: invalid JSON payload: {e}").map_err(io_error)?;
                continue;
            }
            Line::Action { name, payload } => (name, payload),
        };

        // Report the scope the action targets: `scope:action` reports that
        // scope, a bare name the entry scope.
        let request = DispatchRequest::new(name, payload, None);
        let target = request.addressed_scope().unwrap_or(&entry).to_string();
        let before = runtime.module_state(&target);

        let outcome = runtime.dispatch(&request);
        if let Err(e) = &outcome.result {
            writeln!(output, "error: {}", one_line(e)).map_err(io_error)?;
            output.flush().map_err(io_error)?;
            continue;
        }

        let after = outcome.state.scopes.get(&target).cloned().unwrap_or(Value::Null);
        if after == before {
            writeln!(output, "state: <unchanged>").map_err(io_error)?;
        } else {
            writeln!(output, "state: {after}").map_err(io_error)?;
        }
        if has_ui {
            writeln!(output, "patches: {}", patches_text(&outcome.patches, false))
                .map_err(io_error)?;
        }
        report_effects(&runtime, outcome.effects, &mut output).map_err(io_error)?;
        output.flush().map_err(io_error)?;
    }
    Ok(())
}

/// Print what a dispatch asked the host to do, and perform its deferred HTTP
/// requests: each is carried out, completed through the engine, and whatever
/// its completion asked for in turn is handled the same way (a queue, so a
/// chain of requests is followed to its end).
fn report_effects(
    runtime: &Runtime,
    effects: HostEffects,
    output: &mut impl Write,
) -> std::io::Result<()> {
    let mut pending = std::collections::VecDeque::from([effects]);
    while let Some(effects) = pending.pop_front() {
        for path in &effects.navigations {
            writeln!(output, "navigate: {path}")?;
        }
        for delay in &effects.delays {
            writeln!(
                output,
                "delay: {}ms -> {}:{} (scheduled only under --serve)",
                delay.delay.as_millis(),
                delay.scope,
                delay.action
            )?;
        }
        for (scope, request) in effects.http {
            let (id, then) = (request.id, request.then.clone());
            writeln!(output, "http: {} {} -> {scope}:{then}", request.request.method, request.url)?;
            output.flush()?;
            let outcome = perform_blocking(request);
            pending.push_back(runtime.complete_http(&scope, id, outcome));
            writeln!(output, "state: {}", runtime.module_state(&scope))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lines_parse_into_actions_and_payloads() {
        assert_eq!(parse_line("   "), Line::Blank);
        assert_eq!(parse_line("increment"), Line::Action { name: "increment", payload: json!({}) });
        assert_eq!(
            parse_line("  Counter:add   {\"by\": 2}  "),
            Line::Action { name: "Counter:add", payload: json!({ "by": 2 }) }
        );
        assert_eq!(parse_line("set 7"), Line::Action { name: "set", payload: json!(7) });
        assert!(matches!(parse_line("increment {not-json}"), Line::BadPayload(_)));
    }
}
