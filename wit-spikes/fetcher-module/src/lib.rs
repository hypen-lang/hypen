// Fixture demonstrating wasi:http inside a Hypen module — no Hypen-shaped
// HTTP API, no host-side fetch handler, just idiomatic Rust HTTP through
// the standard WASI surface.
//
//   action "fetch" → payload {url}; do a real HTTP GET via `waki`; write
//                    {status, body} into state. On transport error, write
//                    {error: "..."}.

wit_bindgen::generate!({
    world: "module-x",
    path: "../../wit",
    generate_all,
});

struct Module;

impl Guest for Module {
    fn init(_config: Vec<u8>) -> Result<Vec<u8>, String> {
        Ok(b"{\"received\":null,\"error\":null}".to_vec())
    }

    fn dispatch(state: Vec<u8>, action: Action) -> Result<ReducerOutput, String> {
        let mut s: serde_json::Value =
            serde_json::from_slice(&state).unwrap_or(serde_json::json!({}));
        let payload: serde_json::Value =
            serde_json::from_slice(&action.payload).unwrap_or(serde_json::Value::Null);

        match action.name.as_str() {
            "fetch" => {
                let url = payload["url"].as_str().unwrap_or("").to_string();
                match waki::Client::new().get(&url).send() {
                    Ok(resp) => {
                        let status = resp.status_code();
                        let body_bytes = resp.body().unwrap_or_default();
                        let body = String::from_utf8_lossy(&body_bytes).into_owned();
                        s["received"] = serde_json::json!({ "status": status, "body": body });
                        s["error"] = serde_json::Value::Null;
                    }
                    Err(e) => {
                        s["error"] = serde_json::Value::String(e.to_string());
                    }
                }
                Ok(ReducerOutput {
                    state: Some(serde_json::to_vec(&s).unwrap()),
                    effects: vec![],
                    emit: vec![],
                })
            }
            other => Err(format!("unknown action: {other}")),
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
        vec!["fetch".into()]
    }
}

export!(Module);
