// Cross-module fixture. Targets the `module-x` world (base module + the
// hypen:engine/state capability) and exercises both directions of
// cross-module access against a sibling named "counter":
//
//   action "pull" -> read the counter's state, mirror its count into `seen`.
//   action "bump" -> dispatch "increment" to the counter (directed dispatch).

wit_bindgen::generate!({
    world: "module-x",
    path: "../../../../../wit",
    generate_all,
});

use hypen::engine::state;

struct Module;

impl Guest for Module {
    fn init(_config: Vec<u8>) -> Result<Vec<u8>, String> {
        Ok(b"{\"seen\":0}".to_vec())
    }

    fn dispatch(_state: Vec<u8>, action: Action) -> Result<ReducerOutput, String> {
        match action.name.as_str() {
            "pull" => {
                // Cross-module READ: snapshot the counter's state.
                let bytes = state::read("counter").map_err(|e| format!("{e:?}"))?;
                let counter: serde_json::Value =
                    serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
                let count = counter["count"].as_i64().unwrap_or(0);
                Ok(ReducerOutput {
                    state: Some(format!("{{\"seen\":{count}}}").into_bytes()),
                    effects: vec![],
                    emit: vec![],
                })
            }
            "bump" => {
                // Cross-module DISPATCH: send "increment" to the counter.
                state::dispatch(
                    "counter",
                    &state::Action { name: "increment".into(), payload: b"{}".to_vec() },
                )
                .map_err(|e| format!("{e:?}"))?;
                Ok(ReducerOutput { state: None, effects: vec![], emit: vec![] })
            }
            "watch" => {
                // Cross-module SUBSCRIBE: re-run "pull" whenever counter.count
                // changes, so `seen` tracks the counter automatically.
                state::subscribe("counter", "count", "pull").map_err(|e| format!("{e:?}"))?;
                Ok(ReducerOutput { state: None, effects: vec![], emit: vec![] })
            }
            other => Err(format!("unknown action: {other}")),
        }
    }

    fn on_activated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        // Auto-wire the cross-module subscription on activation: from now on,
        // every change to counter.count re-dispatches our own "pull", so `seen`
        // tracks the counter with no explicit "watch" action.
        state::subscribe("counter", "count", "pull").map_err(|e| format!("{e:?}"))?;
        Ok(ReducerOutput { state: None, effects: vec![], emit: vec![] })
    }
    fn on_deactivated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        Ok(ReducerOutput { state: None, effects: vec![], emit: vec![] })
    }
    fn on_destroyed(_state: Vec<u8>) -> Result<(), String> {
        Ok(())
    }

    fn actions() -> Vec<String> {
        vec!["pull".into(), "bump".into(), "watch".into()]
    }
}

export!(Module);
