// Deferred-HTTP fixture. Targets the `module-x` world and imports
// `hypen:http/deferred`: every request is QUEUED from a reducer and its
// outcome arrives later as the `fetched` action. Nothing here blocks, so the
// same component runs on hosts that cannot suspend a guest.
//
//   init({"probe": url}?)  -> optionally tries `send` from `init`, where no
//                             request can be queued; records the refusal.
//   "get"     {url, tag?, method?, headers?, body?, timeoutMs?, next?}
//             -> queue one request, `then: "fetched"`. `next` (a URL) is
//                remembered and requested from the completion handler.
//   "fetched" (completion payload) -> record status/body/tag or the error
//                kind; if a `next` URL is pending, queue it (tag "chained").
//   "flood"   {url, count} -> queue `count` requests; record how many `send`
//                accepted and the first refusal.
//   "bad"     {case} -> one malformed request per case ("url", "scheme",
//                "header", "method", "body", "timeout", "then"); records
//                what `send` answered. "then" names an action this module
//                does not export: `send` accepts it, the engine refuses it.
//
// A refused `send` is recorded in state (`sendError`), not returned as a
// reducer error, so tests can read what the guest was told.

wit_bindgen::generate!({
    world: "module-x",
    path: "../../../../../wit",
    generate_all,
});

use hypen::http::deferred::{self as http, Request};
use serde_json::{json, Value};

struct Module;

fn describe(error: &http::Error) -> String {
    match error {
        http::Error::PermissionDenied(why) => format!("permission-denied: {why}"),
        http::Error::InvalidRequest(why) => format!("invalid-request: {why}"),
        http::Error::LimitExceeded(why) => format!("limit-exceeded: {why}"),
    }
}

fn get(url: &str) -> Request {
    Request {
        method: "GET".into(),
        url: url.into(),
        headers: Vec::new(),
        body: None,
        timeout_ms: None,
    }
}

/// The request a `get` payload describes.
fn request_from(payload: &Value) -> Request {
    let mut request = get(payload["url"].as_str().unwrap_or(""));
    if let Some(method) = payload["method"].as_str() {
        request.method = method.into();
    }
    if let Some(headers) = payload["headers"].as_object() {
        request.headers = headers
            .iter()
            .map(|(name, value)| (name.clone(), value.as_str().unwrap_or("").to_string()))
            .collect();
    }
    if let Some(body) = payload["body"].as_str() {
        request.body = Some(body.as_bytes().to_vec());
    }
    request.timeout_ms = payload["timeoutMs"].as_u64().map(|ms| ms as u32);
    request
}

fn output(state: Value) -> ReducerOutput {
    ReducerOutput { state: Some(state.to_string().into_bytes()), effects: vec![], emit: vec![] }
}

/// Queue `request` and record in `state` whether `send` accepted it.
fn send(state: &mut Value, request: &Request, then: &str, tag: Option<&str>) {
    match http::send(request, then, tag) {
        Ok(()) => {
            state["queued"] = json!(state["queued"].as_u64().unwrap_or(0) + 1);
            state["sendError"] = Value::Null;
        }
        Err(e) => state["sendError"] = json!(describe(&e)),
    }
}

impl Guest for Module {
    fn init(config: Vec<u8>) -> Result<Vec<u8>, String> {
        let config: Value = serde_json::from_slice(&config).unwrap_or(Value::Null);
        let mut state = json!({
            "queued": 0,
            "completions": 0,
            "last": null,
            "log": [],
            "next": null,
            "sendError": null,
        });
        if let Some(url) = config["probe"].as_str() {
            let refused = http::send(&get(url), "fetched", None).err();
            state["initSend"] = json!(refused.as_ref().map(describe));
        }
        Ok(state.to_string().into_bytes())
    }

    fn dispatch(state: Vec<u8>, action: Action) -> Result<ReducerOutput, String> {
        let mut state: Value = serde_json::from_slice(&state).map_err(|e| e.to_string())?;
        let payload: Value = serde_json::from_slice(&action.payload).unwrap_or(Value::Null);
        match action.name.as_str() {
            "get" => {
                state["next"] = payload["next"].clone();
                let request = request_from(&payload);
                send(&mut state, &request, "fetched", payload["tag"].as_str());
                Ok(output(state))
            }
            "fetched" => {
                state["completions"] = json!(state["completions"].as_u64().unwrap_or(0) + 1);
                let summary = if payload["ok"].as_bool() == Some(true) {
                    json!({
                        "ok": true,
                        "status": payload["status"],
                        "body": payload["body"],
                        "bodyEncoding": payload["bodyEncoding"],
                        "contentType": payload["headers"]["content-type"],
                        "tag": payload["tag"],
                    })
                } else {
                    json!({
                        "ok": false,
                        "error": payload["error"]["kind"],
                        "message": payload["error"]["message"],
                        "tag": payload["tag"],
                    })
                };
                let entry = match summary["ok"].as_bool() {
                    Some(true) => json!(format!("{}:{}", summary["tag"], summary["status"])),
                    _ => json!(format!("{}:{}", summary["tag"], summary["error"])),
                };
                if let Some(log) = state["log"].as_array_mut() {
                    log.push(entry);
                }
                state["last"] = summary;
                // A completion handler is a reducer like any other: it can
                // queue the next request.
                if let Some(next) = state["next"].as_str().map(str::to_string) {
                    state["next"] = Value::Null;
                    send(&mut state, &get(&next), "fetched", Some("chained"));
                }
                Ok(output(state))
            }
            "flood" => {
                let url = payload["url"].as_str().unwrap_or("");
                let count = payload["count"].as_u64().unwrap_or(0);
                let mut accepted = 0u64;
                let mut first_refusal = Value::Null;
                for n in 0..count {
                    match http::send(&get(url), "fetched", Some(&format!("flood-{n}"))) {
                        Ok(()) => accepted += 1,
                        Err(e) if first_refusal.is_null() => first_refusal = json!(describe(&e)),
                        Err(_) => {}
                    }
                }
                state["accepted"] = json!(accepted);
                state["sendError"] = first_refusal;
                Ok(output(state))
            }
            "bad" => {
                let ok_url = payload["url"].as_str().unwrap_or("http://example.invalid/");
                let mut request = get(ok_url);
                let mut then = "fetched";
                match payload["case"].as_str().unwrap_or("") {
                    "url" => request.url = "not a url".into(),
                    "scheme" => request.url = "ftp://example.invalid/file".into(),
                    "header" => request.headers = vec![("Host".into(), "evil.invalid".into())],
                    "method" => request.method = "GET /smuggled".into(),
                    "body" => request.body = Some(vec![0u8; 1024 * 1024 + 1]),
                    "timeout" => request.timeout_ms = Some(0),
                    "then" => then = "not-an-action",
                    other => return Err(format!("unknown bad case: {other}")),
                }
                send(&mut state, &request, then, Some("bad"));
                Ok(output(state))
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
        vec!["get".into(), "fetched".into(), "flood".into(), "bad".into()]
    }
}

export!(Module);
