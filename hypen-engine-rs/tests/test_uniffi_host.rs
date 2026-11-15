//! Integration tests for the UniFFI `HypenModuleHost` surface — the exact
//! API Kotlin (Android/JVM) and Swift (iOS/macOS) host libraries call,
//! driven natively so the JSON plumbing and dual-ABI routing are proven
//! without a JVM in the loop.
//!
//! Run with:
//! `cargo test --features "uniffi,module-loader" --test test_uniffi_host`

use hypen_engine::uniffi::HypenModuleHost;

const COUNTER: &[u8] = include_bytes!("fixtures/counter_module.wasm");
const ASYNC_COUNTER: &[u8] = include_bytes!("fixtures/async_counter_module.wasm");
const FETCHER: &[u8] = include_bytes!("fixtures/fetcher_module.wasm");

/// Manifests are deny-by-default, so the grants the fixtures need are
/// spelled out: both counters import `hypen:storage/cloud`, and the async
/// one also imports `wasi:http` (its `fetch` action).
const COUNTER_GRANTS: &str = r#"{"storage": ["cloud"]}"#;
const ASYNC_COUNTER_GRANTS: &str = r#"{"storage": ["cloud"], "http": true}"#;

fn count(state_json: &str) -> i64 {
    let v: serde_json::Value = serde_json::from_str(state_json).unwrap();
    v["count"].as_i64().unwrap()
}

/// The full loop over the FFI shapes: register (bytes + manifest JSON),
/// instantiate, init, dispatch, and the camelCase ReducerOutput
/// wire — with BOTH ABIs behind one host object (DualHost sniffing).
#[test]
fn ffi_surface_drives_both_abis() {
    let host = HypenModuleHost::new().unwrap();

    host.register("counter".into(), COUNTER.to_vec(), COUNTER_GRANTS.into()).unwrap();
    host.register("acounter".into(), ASYNC_COUNTER.to_vec(), ASYNC_COUNTER_GRANTS.into()).unwrap();

    // v0.1 sync module.
    let id = host.instantiate("counter".into()).unwrap();
    let state = host.init(id, "{}".into()).unwrap();
    assert_eq!(count(&state), 0);
    let out_json = host
        .dispatch(id, state, "increment".into(), "{}".into(), String::new())
        .unwrap();
    let out: serde_json::Value = serde_json::from_str(&out_json).unwrap();
    assert_eq!(out["state"]["count"], 1, "wire: {out}");
    assert_eq!(out["effects"][0]["type"], "log", "wire: {out}");

    // v0.2 async module through the same host object.
    let aid = host.instantiate("acounter".into()).unwrap();
    let astate = host.init(aid, r#"{"start": 5}"#.into()).unwrap();
    assert_eq!(count(&astate), 5, "config seeds async init");
    let aout: serde_json::Value = serde_json::from_str(
        &host
            .dispatch(aid, astate, "increment".into(), "{}".into(), String::new())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(aout["state"]["count"], 6, "wire: {aout}");

    let actions = host.actions(aid).unwrap();
    assert!(actions.contains(&"tick".to_string()), "actions: {actions:?}");
    host.destroy(id).unwrap();
    host.destroy(aid).unwrap();
}

/// `dataDir` config = persistent storage through the FFI: a second host
/// (second app launch) warm-starts from the snapshot.
#[test]
fn ffi_data_dir_persists_across_hosts() {
    let dir = tempfile::tempdir().unwrap();
    let config = format!(r#"{{"dataDir": "{}"}}"#, dir.path().display());

    {
        let host = HypenModuleHost::with_config(config.clone()).unwrap();
        host.register("counter".into(), COUNTER.to_vec(), COUNTER_GRANTS.into()).unwrap();
        let id = host.instantiate("counter".into()).unwrap();
        let mut state = host.init(id, "{}".into()).unwrap();
        for _ in 0..2 {
            let out: serde_json::Value = serde_json::from_str(
                &host
                    .dispatch(id, state, "increment".into(), "{}".into(), String::new())
                    .unwrap(),
            )
            .unwrap();
            state = out["state"].to_string();
        }
        assert_eq!(count(&state), 2);
    }

    let host = HypenModuleHost::with_config(config).unwrap();
    host.register("counter".into(), COUNTER.to_vec(), COUNTER_GRANTS.into()).unwrap();
    let id = host.instantiate("counter".into()).unwrap();
    let restored = host.init(id, "{}".into()).unwrap();
    assert_eq!(count(&restored), 2, "state survived across host objects");
}

/// `interpreter: true` (Pulley) through the FFI — the exact configuration an
/// iOS embedding uses. No JIT pages; same semantics.
#[test]
fn ffi_interpreter_mode_runs_modules() {
    let host = HypenModuleHost::with_config(r#"{"interpreter": true}"#.into()).unwrap();
    host.register("counter".into(), COUNTER.to_vec(), COUNTER_GRANTS.into()).unwrap();
    let id = host.instantiate("counter".into()).unwrap();
    let state = host.init(id, "{}".into()).unwrap();
    let out: serde_json::Value = serde_json::from_str(
        &host
            .dispatch(id, state, "increment".into(), "{}".into(), String::new())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(out["state"]["count"], 1);
}

/// An empty manifest grants nothing beyond `local` storage: the counter's
/// `cloud` import and the fetcher's `wasi:http` import both fail to link.
#[test]
fn ffi_empty_manifest_is_least_privilege() {
    let host = HypenModuleHost::new().unwrap();
    host.register("counter".into(), COUNTER.to_vec(), String::new()).unwrap();
    let err = host.instantiate("counter".into()).unwrap_err();
    assert!(format!("{err}").contains("cloud"), "denial names the import: {err}");

    host.register("fetcher".into(), FETCHER.to_vec(), "{}".into()).unwrap();
    let err = host.instantiate("fetcher".into()).unwrap_err();
    assert!(format!("{err}").contains("http"), "denial names the import: {err}");

    // ...and the explicit grant links it.
    host.register("fetcher".into(), FETCHER.to_vec(), r#"{"http": true}"#.into()).unwrap();
    host.instantiate("fetcher".into()).unwrap();
}

/// Manifest JSON gates capabilities through the FFI: `"http": false` denies
/// the http-importing fetcher at instantiate, exactly like app.json.
#[test]
fn ffi_manifest_denies_http() {
    let host = HypenModuleHost::new().unwrap();
    host.register(
        "fetcher".into(),
        FETCHER.to_vec(),
        r#"{"name": "fetcher", "storage": ["local", "app", "cloud"], "http": false}"#.into(),
    )
    .unwrap();
    let err = host.instantiate("fetcher".into()).unwrap_err();
    assert!(format!("{err}").contains("http"), "denial names the import: {err}");
}

/// Liveness and link denials over FFI: asked of the host, not inferred from
/// error text; `cacheDir` is accepted and must be a usable directory.
#[test]
fn ffi_reports_liveness_denials_and_takes_a_cache_dir() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    let config = serde_json::json!({ "maxCallMs": 300, "cacheDir": cache }).to_string();
    let host = HypenModuleHost::with_config(config).unwrap();
    assert!(cache.is_dir(), "the cache directory was created");

    // A denied module: the missing grants as data.
    host.register("net".into(), FETCHER.to_vec(), r#"{"storage": ["app", "cloud"]}"#.into()).unwrap();
    assert!(host.instantiate("net".into()).is_err());
    let denied: serde_json::Value =
        serde_json::from_str(&host.denied_capabilities("net".into())).unwrap();
    let denied = denied.as_array().unwrap();
    assert_eq!(denied.len(), 1, "{denied:?}");
    assert_eq!(denied[0]["grant"], "http");
    assert!(denied[0]["import"].as_str().unwrap().starts_with("wasi:http/"));
    host.register("counter".into(), COUNTER.to_vec(), "".into()).unwrap();
    let denied: serde_json::Value =
        serde_json::from_str(&host.denied_capabilities("counter".into())).unwrap();
    assert_eq!(
        denied,
        serde_json::json!([{ "import": "hypen:storage/cloud@0.1.0", "grant": "storage", "scope": "cloud" }])
    );
    assert_eq!(host.denied_capabilities("nobody".into()), "[]");

    // A live instance, then one killed by the call deadline.
    host.register("acounter".into(), ASYNC_COUNTER.to_vec(), ASYNC_COUNTER_GRANTS.into()).unwrap();
    assert_eq!(host.denied_capabilities("acounter".into()), "[]");
    let id = host.instantiate("acounter".into()).unwrap();
    let state = host.init(id, "{}".into()).unwrap();
    assert!(host.is_alive(id));
    assert_eq!(host.death_reason(id), None);
    assert!(host.dispatch(id, state, "spin".into(), "{}".into(), "".into()).is_err());
    assert!(!host.is_alive(id));
    let reason = host.death_reason(id).expect("a killed instance has a reason");
    assert!(reason.contains("module 'acounter' export `dispatch` exceeded its 300 ms"), "{reason}");
    host.destroy(id).unwrap();
    assert!(!host.is_alive(id));
    assert_eq!(host.death_reason(id), None);

    // A cache directory that is a file is a construction error.
    let file = dir.path().join("file");
    std::fs::write(&file, "x").unwrap();
    let config = serde_json::json!({ "cacheDir": file }).to_string();
    let err = HypenModuleHost::with_config(config).err().expect("refused").to_string();
    assert!(err.contains("is not a directory"), "{err}");
}

/// Deferred HTTP over the FFI: the manifest JSON carries `http` /
/// `httpHosts` (a malformed pattern is refused at `register`), and the
/// requests a reducer queued come back in the dispatch result as
/// `httpRequests` for the embedder to perform and complete by dispatching
/// `then`.
#[test]
fn ffi_reports_queued_http_requests_and_takes_http_hosts() {
    const DEFERRED: &[u8] = include_bytes!("fixtures/deferred_http_module.wasm");
    let host = HypenModuleHost::new().unwrap();

    let err = host
        .register("net".into(), DEFERRED.to_vec(), r#"{"http": true, "httpHosts": ["https://x"]}"#.into())
        .unwrap_err();
    assert!(err.to_string().contains("drop the scheme"), "{err}");

    let manifest = r#"{"http": true, "httpHosts": ["*.example.com"]}"#;
    host.register("net".into(), DEFERRED.to_vec(), manifest.into()).unwrap();
    let id = host.instantiate("net".into()).unwrap();
    let state = host.init(id, "{}".into()).unwrap();

    let payload = r#"{"url": "https://api.example.com/v1", "method": "POST", "body": "hi",
                      "headers": {"x-a": "1"}, "tag": "t"}"#;
    let out = host.dispatch(id, state.clone(), "get".into(), payload.into(), String::new()).unwrap();
    let out: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        out["httpRequests"],
        serde_json::json!([{
            "method": "POST",
            "url": "https://api.example.com/v1",
            "headers": [["x-a", "1"]],
            "bodyBase64": "aGk=",
            "timeoutMs": 30000,
            "then": "fetched",
            "tag": "t",
        }])
    );

    // Outside the allowlist: refused at `send`, nothing queued.
    let out = host
        .dispatch(id, state, "get".into(), r#"{"url": "https://evil.test/"}"#.into(), String::new())
        .unwrap();
    let out: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(out["httpRequests"], serde_json::json!([]));
    assert!(out["state"]["sendError"].as_str().unwrap().contains("'evil.test:443'"), "{out}");
}
