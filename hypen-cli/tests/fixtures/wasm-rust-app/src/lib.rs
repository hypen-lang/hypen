// A Hypen counter module in Rust, built to a WASM Component by
// `hypen build --target wasm`. Implements the `hypen:module` reducer ABI
// directly via wit-bindgen — Rust's idiomatic component path.
//
// The CLI provisions `wit/` from its vendored copy before building, so the
// `path: "wit"` below resolves.

wit_bindgen::generate!({
    world: "module",
    path: "wit",
    generate_all,
});

struct Module;

fn count_of(state: &[u8]) -> i64 {
    // state is `{"count":N}` JSON; parse N without pulling in serde.
    std::str::from_utf8(state)
        .ok()
        .and_then(|s| s.split(':').nth(1))
        .map(|t| t.trim_end_matches('}').trim())
        .and_then(|t| t.parse().ok())
        .unwrap_or(0)
}

fn encode(count: i64) -> Vec<u8> {
    format!("{{\"count\":{}}}", count).into_bytes()
}

impl Guest for Module {
    fn init(_config: Vec<u8>) -> Result<Vec<u8>, String> {
        Ok(encode(0))
    }

    fn dispatch(state: Vec<u8>, action: Action) -> Result<ReducerOutput, String> {
        let current = count_of(&state);
        let next = match action.name.as_str() {
            "increment" => current + 1,
            "decrement" => current - 1,
            other => return Err(format!("unknown action: {}", other)),
        };
        Ok(ReducerOutput {
            state: Some(encode(next)),
            effects: vec![],
            emit: vec![],
        })
    }

    fn on_activated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        Ok(ReducerOutput { state: None, effects: vec![], emit: vec![] })
    }

    fn on_deactivated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        Ok(ReducerOutput { state: None, effects: vec![], emit: vec![] })
    }

    fn on_destroyed(_state: Vec<u8>) -> Result<(), String> {
        Ok(())
    }

    fn actions() -> Vec<String> {
        vec!["increment".to_string(), "decrement".to_string()]
    }
}

export!(Module);
