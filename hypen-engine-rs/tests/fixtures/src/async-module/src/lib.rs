// Reference module for the `hypen:module@0.2.0` CM-async ABI (WASI 0.3).
//
// The v0.2 counterpart of `stub-module` + `xmod-module`: an async counter
// that `await`s its capability imports *inline* — storage round-trips and
// cross-module reads happen mid-reducer, no Elm-style effect detour — and
// then returns the state delta the engine path-diffs as usual.
//
//   init          -> restore persisted count from local storage (awaited),
//                    falling back to config.start.
//   "increment"   -> count += 1, await storage set + read-back, return delta.
//   "sync"        -> push state to cloud storage via awaited compare-and-set.
//   "pull"        -> await a cross-module read of "counter", mirror its count.
//   "spin"        -> infinite loop (host timeout proof).
//
// Functions declared `async func` in the WIT get async bindings by default —
// no `async:` option needed. Async imports take OWNED params (String/Vec<u8>)
// because each call is a subtask whose params must outlive the caller frame.

wit_bindgen::generate!({
    world: "module-x",
    path: "../../../../../wit-v0_2",
    generate_all,
});

use hypen::engine::state;
use hypen::module::types::{Effect, LogEffect, LogLevel};
use hypen::storage::local;
use hypen::storage::types::Tier;
use hypen::time::clock;

struct Module;

fn count_of(state: &[u8]) -> i64 {
    serde_json::from_slice::<serde_json::Value>(state)
        .ok()
        .and_then(|v| v["count"].as_i64())
        .unwrap_or(0)
}

fn encode(count: i64) -> Vec<u8> {
    format!("{{\"count\":{count}}}").into_bytes()
}

fn no_change() -> ReducerOutput {
    ReducerOutput { state: None, effects: vec![], emit: vec![] }
}

impl Guest for Module {
    // WIT `async func` export => plain `async fn` in the Guest trait.
    async fn init(config: Vec<u8>) -> Result<Vec<u8>, String> {
        let bucket = local::Bucket::open(Tier::Persistent, "counter".to_string())
            .await
            .map_err(|e| format!("{e:?}"))?;
        // Awaited storage read *inside init*: warm-start from the persisted
        // count when present, otherwise seed from declaration-site config.
        if let Some(bytes) = bucket.get("count".to_string()).await.map_err(|e| format!("{e:?}"))? {
            return Ok(bytes);
        }
        let start = serde_json::from_slice::<serde_json::Value>(&config)
            .ok()
            .and_then(|v| v["start"].as_i64())
            .unwrap_or(0);
        Ok(encode(start))
    }

    async fn dispatch(state: Vec<u8>, action: Action) -> Result<ReducerOutput, String> {
        match action.name.as_str() {
            "increment" => {
                let next = count_of(&state) + 1;
                let new_state = encode(next);
                // Sequential awaits across the same capability: persist,
                // then read back — the reducer suspends twice and still
                // returns a delta the path-diff pipeline consumes.
                let bucket = local::Bucket::open(Tier::Persistent, "counter".to_string())
                    .await
                    .map_err(|e| format!("{e:?}"))?;
                bucket
                    .set("count".to_string(), new_state.clone())
                    .await
                    .map_err(|e| format!("{e:?}"))?;
                let echoed = bucket
                    .get("count".to_string())
                    .await
                    .map_err(|e| format!("{e:?}"))?
                    .ok_or("persisted count vanished")?;
                Ok(ReducerOutput {
                    state: Some(echoed),
                    effects: vec![Effect::Log(LogEffect {
                        level: LogLevel::Info,
                        message: format!("count -> {next}"),
                    })],
                    emit: vec![],
                })
            }
            "sync" => {
                // Awaited cloud round-trip with optimistic concurrency.
                let bucket = hypen::storage::cloud::Bucket::open(
                    Tier::Persistent,
                    "counter".to_string(),
                )
                .await
                .map_err(|e| format!("{e:?}"))?;
                let version = bucket
                    .info("state".to_string())
                    .await
                    .map_err(|e| format!("{e:?}"))?
                    .and_then(|i| i.version);
                bucket
                    .compare_and_set("state".to_string(), version, state)
                    .await
                    .map_err(|e| format!("{e:?}"))?;
                Ok(no_change())
            }
            "pull" => {
                // Awaited cross-module READ: mirror the counter's count.
                let bytes = state::read("counter".to_string())
                    .await
                    .map_err(|e| format!("{e:?}"))?;
                let seen = count_of(&bytes);
                Ok(ReducerOutput {
                    state: Some(format!("{{\"seen\":{seen}}}").into_bytes()),
                    effects: vec![],
                    emit: vec![],
                })
            }
            "tick" => {
                // hypen:time in one reducer pass: measure with the monotonic
                // clock, await a sleep (task suspends through the component
                // event loop; virtual clocks resume instantly), then stamp
                // wall-clock time into the state.
                let payload: serde_json::Value =
                    serde_json::from_slice(&action.payload).unwrap_or(serde_json::json!({}));
                let ms = payload["ms"].as_u64().unwrap_or(0);
                let mono_before = clock::monotonic_ms();
                clock::sleep_ms(ms).await;
                let mut s: serde_json::Value =
                    serde_json::from_slice(&state).unwrap_or(serde_json::json!({}));
                s["woke_at"] = serde_json::json!(clock::now_ms());
                s["slept_ms"] = serde_json::json!(clock::monotonic_ms() - mono_before);
                Ok(ReducerOutput {
                    state: Some(serde_json::to_vec(&s).unwrap()),
                    effects: vec![],
                    emit: vec![],
                })
            }
            "fetch" => {
                // Real HTTP from inside an async reducer: waki rides the
                // standard wasi:http p2 surface (manifest-gated egress).
                // The reducer mixes an awaited custom import (storage) with
                // the HTTP round-trip, then returns one delta.
                let payload: serde_json::Value =
                    serde_json::from_slice(&action.payload).unwrap_or(serde_json::json!({}));
                let url = payload["url"].as_str().unwrap_or("").to_string();
                let mut s: serde_json::Value =
                    serde_json::from_slice(&state).unwrap_or(serde_json::json!({}));
                match waki::Client::new().get(&url).send() {
                    Ok(resp) => {
                        let status = resp.status_code();
                        let body = String::from_utf8_lossy(&resp.body().unwrap_or_default())
                            .into_owned();
                        s["received"] = serde_json::json!({ "status": status, "body": body });
                        s["error"] = serde_json::Value::Null;
                        // Awaited storage write in the same reducer pass:
                        // cache the fetched body next to the counter state.
                        let bucket =
                            local::Bucket::open(Tier::Cache, "fetch".to_string())
                                .await
                                .map_err(|e| format!("{e:?}"))?;
                        bucket
                            .set("last".to_string(), body.into_bytes())
                            .await
                            .map_err(|e| format!("{e:?}"))?;
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
            "spin" => loop {
                std::hint::black_box(0);
            },
            other => Err(format!("unknown action: {other}")),
        }
    }

    async fn on_activated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        // Awaited cross-module SUBSCRIBE on activation: track the counter.
        state::subscribe("counter".to_string(), "count".to_string(), "pull".to_string())
            .await
            .map_err(|e| format!("{e:?}"))?;
        Ok(no_change())
    }

    async fn on_deactivated(_state: Vec<u8>) -> Result<ReducerOutput, String> {
        Ok(no_change())
    }

    async fn on_destroyed(_state: Vec<u8>) -> Result<(), String> {
        Ok(())
    }

    // Sync export coexisting with the async ones. Pure metadata.
    fn actions() -> Vec<String> {
        vec![
            "increment".into(),
            "sync".into(),
            "pull".into(),
            "tick".into(),
            "fetch".into(),
            "spin".into(),
        ]
    }
}

export!(Module);
