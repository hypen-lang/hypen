// Minimal stub Hypen module exercising the v0.1 module world end-to-end:
// - reducer ABI (init / dispatch / lifecycle)
// - storage capability imports (local + cloud)
// - effect descriptors (log)
//
// Models a trivial counter module:
//   action "increment" -> state.count += 1, logs, persists to local storage
//   action "sync"      -> compare-and-set into cloud storage

wit_bindgen::generate!({
    world: "module",
    path: "../../../../../wit",
    generate_all,
});

use hypen::module::types::{Effect, LogEffect, LogLevel};
use hypen::storage::{local, cloud, types::Tier};

struct Module;

fn state_value(state: &[u8]) -> i64 {
    let s = std::str::from_utf8(state).unwrap_or("{\"count\":0}");
    s.split(':')
        .nth(1)
        .and_then(|t| t.trim_end_matches('}').trim().parse().ok())
        .unwrap_or(0)
}

fn encode_state(count: i64) -> Vec<u8> {
    format!("{{\"count\":{}}}", count).into_bytes()
}

impl Guest for Module {
    fn init(_config: Vec<u8>) -> Result<Vec<u8>, String> {
        let bucket = local::Bucket::open(Tier::Persistent, "counter")
            .map_err(|e| format!("open local bucket: {:?}", e))?;
        let count = match bucket.get("count").map_err(|e| format!("{:?}", e))? {
            Some(bytes) => state_value(&bytes),
            None => 0,
        };
        Ok(encode_state(count))
    }

    fn dispatch(state: Vec<u8>, action: Action) -> Result<ReducerOutput, String> {
        let current = state_value(&state);
        match action.name.as_str() {
            "increment" => {
                let next = current + 1;
                let new_state = encode_state(next);

                let bucket = local::Bucket::open(Tier::Persistent, "counter")
                    .map_err(|e| format!("{:?}", e))?;
                bucket.set("count", &new_state).map_err(|e| format!("{:?}", e))?;

                Ok(ReducerOutput {
                    state: Some(new_state),
                    effects: vec![Effect::Log(LogEffect {
                        level: LogLevel::Debug,
                        message: format!("count -> {}", next),
                    })],
                    emit: vec![],
                })
            }
            "sync" => {
                let cloud_bucket = cloud::Bucket::open(Tier::Persistent, "counter")
                    .map_err(|e| format!("{:?}", e))?;
                cloud_bucket
                    .compare_and_set("count", None, &state)
                    .map_err(|e| format!("{:?}", e))?;
                Ok(ReducerOutput {
                    state: None,
                    effects: vec![],
                    emit: vec![],
                })
            }
            other => Err(format!("unknown action: {}", other)),
        }
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
        vec!["increment".into(), "sync".into()]
    }
}

export!(Module);
