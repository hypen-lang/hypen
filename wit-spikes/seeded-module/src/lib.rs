// A Hypen module that seeds its initial `count` from declaration-site config.
// Declaring `module Seeded(start: 7)` makes the runtime call `init({"start":7})`;
// this reducer decodes it so the initial state is `{"count":7}` instead of the
// default `{"count":0}`. Proves config-seeded init end-to-end.
wit_bindgen::generate!({
    world: "module",
    path: "../../wit",
    generate_all,
});

use hypen::module::types::Effect;

struct Module;

/// Pull the single integer value out of a flat one-field JSON object like
/// `{"count":3}` or `{"start":7}`. Returns 0 for `{}` / anything unparseable —
/// exactly the "no config" default. (Mirrors the effects-module's tiny parser;
/// keeps the fixture dependency-free.)
fn int_field(bytes: &[u8]) -> i64 {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| s.split(':').nth(1))
        .map(|t| t.trim_end_matches('}').trim())
        .and_then(|t| t.parse().ok())
        .unwrap_or(0)
}
fn encode(count: i64) -> Vec<u8> {
    format!("{{\"count\":{}}}", count).into_bytes()
}
fn out(state: Option<Vec<u8>>, effects: Vec<Effect>) -> ReducerOutput {
    ReducerOutput { state, effects, emit: vec![] }
}

impl Guest for Module {
    fn init(config: Vec<u8>) -> Result<Vec<u8>, String> {
        // Seed `count` from `config.start`; default 0 when the module was
        // declared without a `start:` arg (config is `{}`).
        Ok(encode(int_field(&config)))
    }

    fn dispatch(state: Vec<u8>, action: Action) -> Result<ReducerOutput, String> {
        match action.name.as_str() {
            "increment" => Ok(out(Some(encode(int_field(&state) + 1)), vec![])),
            "reset" => Ok(out(Some(encode(0)), vec![])),
            other => Err(format!("unknown action: {other}")),
        }
    }

    fn on_activated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        Ok(out(None, vec![]))
    }
    fn on_deactivated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        Ok(out(None, vec![]))
    }
    fn on_destroyed(_state: Vec<u8>) -> Result<(), String> {
        Ok(())
    }
    fn actions() -> Vec<String> {
        vec!["increment".into(), "reset".into()]
    }
}

export!(Module);
