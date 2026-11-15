// A CM-async Hypen counter in Rust (`hypen:module@0.2.0`), built by
// `hypen build --target wasm`. The reducer exports are `async fn` and
// `await` the storage capability inline — no effect descriptors.
//
// The CLI detects `[package.metadata.hypen] abi = "0.2"` and provisions
// `wit/` from its vendored wit-v0_2, so `path: "wit"` resolves to the async
// world and wit-bindgen generates async bindings automatically.

wit_bindgen::generate!({
    world: "module",
    path: "wit",
    generate_all,
});

use hypen::storage::local;
use hypen::storage::types::Tier;

struct Module;

fn count_of(state: &[u8]) -> i64 {
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
    async fn init(_config: Vec<u8>) -> Result<Vec<u8>, String> {
        // Awaited storage warm-start.
        let bucket = local::Bucket::open(Tier::Persistent, "counter".to_string())
            .await
            .map_err(|e| format!("{e:?}"))?;
        match bucket.get("count".to_string()).await.map_err(|e| format!("{e:?}"))? {
            Some(bytes) => Ok(bytes),
            None => Ok(encode(0)),
        }
    }

    async fn dispatch(state: Vec<u8>, action: Action) -> Result<ReducerOutput, String> {
        let next = match action.name.as_str() {
            "increment" => count_of(&state) + 1,
            other => return Err(format!("unknown action: {}", other)),
        };
        let new_state = encode(next);
        // Awaited persist mid-reducer, then return the delta.
        let bucket = local::Bucket::open(Tier::Persistent, "counter".to_string())
            .await
            .map_err(|e| format!("{e:?}"))?;
        bucket
            .set("count".to_string(), new_state.clone())
            .await
            .map_err(|e| format!("{e:?}"))?;
        Ok(ReducerOutput { state: Some(new_state), effects: vec![], emit: vec![] })
    }

    async fn on_activated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        Ok(ReducerOutput { state: None, effects: vec![], emit: vec![] })
    }
    async fn on_deactivated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        Ok(ReducerOutput { state: None, effects: vec![], emit: vec![] })
    }
    async fn on_destroyed(_state: Vec<u8>) -> Result<(), String> {
        Ok(())
    }

    fn actions() -> Vec<String> {
        vec!["increment".to_string()]
    }
}

export!(Module);
