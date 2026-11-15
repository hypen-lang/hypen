// Deferred HTTP from a `hypen:module@0.2.0` (CM-async) module.
//
// The v0.2 counterpart of `deferred-http-module`, kept minimal: it proves
// that `hypen:http/deferred.send` — a plain *sync* func in an otherwise async
// world, because it only queues — links and queues on the async host, and
// that the completion is delivered to an `async` reducer.
//
//   "get"     {url, tag?} -> queue a GET, `then: "fetched"`.
//   "fetched" (completion payload) -> record ok/status/body/error kind + tag.

wit_bindgen::generate!({
    world: "module-x",
    path: "../../../../../wit-v0_2",
    generate_all,
});

use hypen::http::deferred::{self as http, Request};
use serde_json::{json, Value};

struct Module;

fn output(state: Value) -> ReducerOutput {
    ReducerOutput { state: Some(state.to_string().into_bytes()), effects: vec![], emit: vec![] }
}

fn no_change() -> ReducerOutput {
    ReducerOutput { state: None, effects: vec![], emit: vec![] }
}

impl Guest for Module {
    async fn init(_config: Vec<u8>) -> Result<Vec<u8>, String> {
        Ok(json!({ "queued": 0, "last": null, "sendError": null }).to_string().into_bytes())
    }

    async fn dispatch(state: Vec<u8>, action: Action) -> Result<ReducerOutput, String> {
        let mut state: Value = serde_json::from_slice(&state).map_err(|e| e.to_string())?;
        let payload: Value = serde_json::from_slice(&action.payload).unwrap_or(Value::Null);
        match action.name.as_str() {
            "get" => {
                let request = Request {
                    method: "GET".into(),
                    url: payload["url"].as_str().unwrap_or("").into(),
                    headers: Vec::new(),
                    body: None,
                    timeout_ms: None,
                };
                // No `.await`: queueing is synchronous in v0.2 as well.
                match http::send(&request, "fetched", payload["tag"].as_str()) {
                    Ok(()) => {
                        state["queued"] = json!(state["queued"].as_u64().unwrap_or(0) + 1);
                        state["sendError"] = Value::Null;
                    }
                    Err(e) => state["sendError"] = json!(format!("{e:?}")),
                }
                Ok(output(state))
            }
            "fetched" => {
                state["last"] = json!({
                    "ok": payload["ok"],
                    "status": payload["status"],
                    "body": payload["body"],
                    "error": payload["error"]["kind"],
                    "tag": payload["tag"],
                });
                Ok(output(state))
            }
            other => Err(format!("unknown action: {other}")),
        }
    }

    async fn on_activated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        Ok(no_change())
    }
    async fn on_deactivated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        Ok(no_change())
    }
    async fn on_destroyed(_state: Vec<u8>) -> Result<(), String> {
        Ok(())
    }

    fn actions() -> Vec<String> {
        vec!["get".into(), "fetched".into()]
    }
}

export!(Module);
