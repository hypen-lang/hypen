// A Hypen module that emits engine-native effects (Navigate + Delay), to
// verify the host's effect handling.
wit_bindgen::generate!({
    world: "module",
    path: "../../wit",
    generate_all,
});

use hypen::module::types::{DelayEffect, Effect};

struct Module;

fn count_of(state: &[u8]) -> i64 {
    std::str::from_utf8(state).ok()
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
    fn init(_config: Vec<u8>) -> Result<Vec<u8>, String> {
        Ok(encode(0))
    }

    fn dispatch(state: Vec<u8>, action: Action) -> Result<ReducerOutput, String> {
        match action.name.as_str() {
            // Request navigation — no state change.
            "go" => Ok(out(None, vec![Effect::Navigate("/next".to_string())])),
            // Debounce: ask the host to dispatch `tick` after 120ms.
            "debounce" => Ok(out(
                None,
                vec![Effect::Delay(DelayEffect { ms: 120, then: "tick".to_string() })],
            )),
            // The delayed follow-up: bump the counter.
            "tick" => Ok(out(Some(encode(count_of(&state) + 1)), vec![])),
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
        vec!["go".into(), "debounce".into(), "tick".into()]
    }
}

export!(Module);
