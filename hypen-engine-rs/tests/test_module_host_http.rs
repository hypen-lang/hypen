//! Deferred HTTP (`hypen:http/deferred`) on the native host, driven with the
//! committed `deferred_http_module.wasm` fixture: what `send` queues and
//! refuses, the link-time grant, the `httpHosts` allowlist (for deferred
//! requests and for blocking `wasi:http`), and the round trip through the
//! engine's effect handler and completion entry.
//!
//! No test here opens a connection for a deferred request — performing them
//! is the embedder's job (`tests/test_hypen_runtime.rs` covers the runtime's
//! client end to end).
//!
//! Run with: `cargo test --features module-loader --test test_module_host_http`

use std::sync::{Arc, Mutex};

use hypen_engine::hosted::{HttpCompletionError, HttpDelivery};
use hypen_engine::module_host::{
    DeniedCapability, DualHost, Effect, HostAction, HostError, HostPattern, HttpEffect,
    HttpFailure, HttpFailureKind, HttpOutcome, HttpRequest, HttpResponse, ManifestGrant,
    ModuleHost, ModuleInstanceId, ModuleManifest, QueuedHttpRequest, ReducerOutput, WasmtimeHost,
    WasmtimeHostAsync,
    MAX_HTTP_REQUESTS_PER_CALL,
};
use hypen_engine::{Engine, ModuleGrants};
use serde_json::{json, Value};

const DEFERRED: &[u8] = include_bytes!("fixtures/deferred_http_module.wasm");
const DEFERRED_ASYNC: &[u8] = include_bytes!("fixtures/deferred_http_async_module.wasm");
const FETCHER: &[u8] = include_bytes!("fixtures/fetcher_module.wasm");
const COUNTER: &[u8] = include_bytes!("fixtures/counter_module.wasm");

fn http_only(name: &str, hosts: &[&str]) -> ModuleManifest {
    ModuleManifest {
        name: name.into(),
        http: true,
        http_hosts: hosts.iter().map(|h| h.parse::<HostPattern>().unwrap()).collect(),
        ..ModuleManifest::default()
    }
}

/// A live instance of the fixture plus its state.
struct Guest {
    host: WasmtimeHost,
    id: ModuleInstanceId,
    state: Vec<u8>,
}

impl Guest {
    fn start(manifest: ModuleManifest, config: &str) -> Self {
        let mut host = WasmtimeHost::new().unwrap();
        host.register("m", DEFERRED, manifest).unwrap();
        let id = host.instantiate("m").unwrap();
        let state = host.init(id, config.as_bytes()).unwrap();
        Self { host, id, state }
    }

    fn dispatch(&mut self, action: &str, payload: Value) -> ReducerOutput {
        let action = HostAction::new(action, payload.to_string().into_bytes());
        let output = self.host.dispatch(self.id, &self.state, action, &[]).unwrap();
        if let Some(state) = &output.state {
            self.state.clone_from(state);
        }
        output
    }

    fn state(&self) -> Value {
        serde_json::from_slice(&self.state).unwrap()
    }

    fn send_error(&self) -> String {
        self.state()["sendError"].as_str().unwrap_or("").to_string()
    }
}

#[test]
fn send_queues_the_request_into_the_reducer_output_and_performs_nothing() {
    let mut guest = Guest::start(http_only("m", &[]), "{}");
    let output = guest.dispatch(
        "get",
        json!({
            "url": "https://api.example.com/v1/items?q=1",
            "method": "POST",
            "headers": { "content-type": "application/json", "x-trace": "abc" },
            "body": "{\"n\":1}",
            "timeoutMs": 2500,
            "tag": "t-1",
        }),
    );
    assert_eq!(
        output.http_requests,
        vec![QueuedHttpRequest {
            request: HttpRequest {
                method: "POST".into(),
                url: "https://api.example.com/v1/items?q=1".into(),
                headers: vec![
                    ("content-type".into(), "application/json".into()),
                    ("x-trace".into(), "abc".into()),
                ],
                body: Some(b"{\"n\":1}".to_vec()),
                timeout_ms: Some(2500),
            },
            then: "fetched".into(),
            tag: Some("t-1".into()),
        }]
    );
    assert_eq!(guest.state()["queued"], 1);
    assert_eq!(guest.send_error(), "");

    // The queue belongs to one call: the next output starts empty.
    let output = guest.dispatch("get", json!({ "url": "http://localhost:1/" }));
    assert_eq!(output.http_requests.len(), 1);
    assert_eq!(output.http_requests[0].tag, None);
    assert_eq!(output.http_requests[0].request.timeout_ms, None);
}

#[test]
fn requests_are_bounded_per_call_and_malformed_ones_are_refused_at_send() {
    let mut guest = Guest::start(http_only("m", &[]), "{}");

    let output = guest.dispatch("flood", json!({ "url": "http://h.test/", "count": 20 }));
    assert_eq!(output.http_requests.len(), MAX_HTTP_REQUESTS_PER_CALL);
    assert_eq!(guest.state()["accepted"], MAX_HTTP_REQUESTS_PER_CALL);
    assert_eq!(
        guest.send_error(),
        "limit-exceeded: too many requests in one call (limit 16)"
    );
    // The bound is per call, not per instance.
    let output = guest.dispatch("flood", json!({ "url": "http://h.test/", "count": 3 }));
    assert_eq!(output.http_requests.len(), 3);

    for (case, expected) in [
        ("url", "invalid-request: invalid url: contains a space"),
        ("scheme", "invalid-request: invalid url: must be absolute and start with http:// or https://"),
        ("header", "invalid-request: header 'Host' is set by the host"),
        ("method", "invalid-request: method 'GET /smuggled' is not an HTTP token"),
        ("body", "limit-exceeded: body of 1048577 bytes exceeds the 1048576-byte limit"),
        ("timeout", "invalid-request: timeout-ms is 0"),
    ] {
        let output = guest.dispatch("bad", json!({ "case": case }));
        assert!(output.http_requests.is_empty(), "{case} was queued");
        let told = guest.send_error();
        assert!(told.starts_with(expected), "{case}: {told}");
    }

    // An unknown `then` is not the host's to judge (it does not know the
    // action set at `send`); the engine refuses it when it folds the output.
    let output = guest.dispatch("bad", json!({ "case": "then" }));
    assert_eq!(output.http_requests.len(), 1);
    assert_eq!(output.http_requests[0].then, "not-an-action");
}

#[test]
fn the_allowlist_is_checked_at_send_and_names_the_host() {
    let mut guest = Guest::start(http_only("m", &["*.example.com", "127.0.0.1:8080"]), "{}");

    for allowed in [
        "https://api.example.com/x",
        "http://deep.api.EXAMPLE.com:8443/",
        "http://127.0.0.1:8080/health",
    ] {
        let output = guest.dispatch("get", json!({ "url": allowed }));
        assert_eq!(output.http_requests.len(), 1, "{allowed}: {}", guest.send_error());
    }
    for (refused, host) in [
        ("https://evil.test/", "evil.test:443"),
        ("https://example.com/", "example.com:443"),
        ("http://127.0.0.1:9090/", "127.0.0.1:9090"),
        ("http://api.example.com.evil.test/", "api.example.com.evil.test:80"),
    ] {
        let output = guest.dispatch("get", json!({ "url": refused }));
        assert!(output.http_requests.is_empty(), "{refused} was queued");
        assert_eq!(
            guest.send_error(),
            format!("permission-denied: host '{host}' is not in the manifest's `httpHosts` allowlist")
        );
    }
}

#[test]
fn nothing_can_be_queued_from_init() {
    let guest = Guest::start(http_only("m", &[]), r#"{"probe":"http://h.test/"}"#);
    let told = guest.state()["initSend"].as_str().unwrap().to_string();
    assert!(
        told.starts_with("permission-denied: http: requests can only be queued from `dispatch`"),
        "{told}"
    );
}

#[test]
fn importing_the_interface_without_the_http_grant_is_a_link_time_denial() {
    fn check(host: &mut dyn ModuleHost) {
        // Everything except `http`.
        let no_http = ModuleManifest { http: false, ..ModuleManifest::all("m") };
        host.register("m", DEFERRED, no_http).unwrap();
        let err = host.instantiate("m").unwrap_err();
        assert!(matches!(err, HostError::Instantiate(_)), "{err}");
        assert_eq!(
            err.to_string(),
            "instantiation failed: module 'm' imports hypen:http/deferred@0.1.0 but its \
             manifest does not grant `http`"
        );
        assert_eq!(
            host.denied_capabilities("m"),
            vec![DeniedCapability {
                import: "hypen:http/deferred@0.1.0".into(),
                grant: ManifestGrant::Http,
            }]
        );

        // `httpHosts` alone grants nothing: `http` is the master switch.
        let hosts_only = ModuleManifest { http: false, ..http_only("m", &["h.test"]) };
        host.register("m", DEFERRED, hosts_only).unwrap();
        assert!(host.instantiate("m").is_err());

        host.register("m", DEFERRED, http_only("m", &[])).unwrap();
        assert!(host.denied_capabilities("m").is_empty());
        let id = host.instantiate("m").unwrap();
        assert_eq!(host.actions(id).unwrap(), ["get", "fetched", "flood", "bad"]);
    }
    check(&mut WasmtimeHost::new().unwrap());
    check(&mut DualHost::new().unwrap());
}

/// Components built before the interface existed do not import it, and are
/// untouched by it: the committed fixtures run as they are.
#[test]
fn components_that_do_not_import_the_interface_are_unaffected() {
    let mut host = WasmtimeHost::new().unwrap();
    host.register("counter", COUNTER, ModuleManifest::all("counter")).unwrap();
    let id = host.instantiate("counter").unwrap();
    let state = host.init(id, b"{}").unwrap();
    let output = host
        .dispatch(id, &state, HostAction::new("increment", b"{}".to_vec()), &[])
        .unwrap();
    assert!(output.http_requests.is_empty());
    assert!(output.state.is_some());
}

// ── hypen:module@0.2.0 (CM-async) ────────────────────────────────────────────

/// `send` is a plain sync func in the v0.2 world too. The async host links
/// it under the same grant, queues through the same code, and delivers the
/// completion to an `async` reducer.
#[test]
fn the_async_abi_queues_and_completes_the_same_way() {
    fn check(host: &mut dyn ModuleHost) {
        host.register("m", DEFERRED_ASYNC, ModuleManifest::default()).unwrap();
        assert_eq!(
            host.denied_capabilities("m"),
            vec![DeniedCapability {
                import: "hypen:http/deferred@0.2.0".into(),
                grant: ManifestGrant::Http,
            }]
        );
        assert!(matches!(host.instantiate("m"), Err(HostError::Instantiate(_))));

        host.register("m", DEFERRED_ASYNC, http_only("m", &["*.example.com"])).unwrap();
        let id = host.instantiate("m").unwrap();
        let state = host.init(id, b"{}").unwrap();
        let get = |url: &str| {
            HostAction::new("get", json!({ "url": url, "tag": "t" }).to_string().into_bytes())
        };

        let output = host.dispatch(id, &state, get("https://api.example.com/x"), &[]).unwrap();
        assert_eq!(output.http_requests.len(), 1);
        assert_eq!(output.http_requests[0].request.url, "https://api.example.com/x");
        assert_eq!(output.http_requests[0].then, "fetched");
        assert_eq!(output.http_requests[0].tag.as_deref(), Some("t"));

        let output = host.dispatch(id, &state, get("https://evil.test/"), &[]).unwrap();
        assert!(output.http_requests.is_empty());
        let told: Value = serde_json::from_slice(&output.state.unwrap()).unwrap();
        let told = told["sendError"].as_str().unwrap();
        assert!(told.contains("PermissionDenied") && told.contains("'evil.test:443'"), "{told}");

        // The completion, as the engine would dispatch it.
        let payload = HttpOutcome::Response(HttpResponse {
            status: 201,
            headers: Vec::new(),
            body: b"made".to_vec(),
        })
        .into_payload(Some("t"));
        let output = host.dispatch(id, &state, HostAction::new("fetched", payload), &[]).unwrap();
        let state: Value = serde_json::from_slice(&output.state.unwrap()).unwrap();
        assert_eq!(
            state["last"],
            json!({ "ok": true, "status": 201, "body": "made", "error": null, "tag": "t" })
        );
    }
    check(&mut WasmtimeHostAsync::new().unwrap());
    check(&mut DualHost::new().unwrap());
}

// ── blocking wasi:http under the same allowlist ─────────────────────────────

/// A local server that counts connections and answers each with `body`.
fn counting_server(body: &'static str) -> (u16, Arc<Mutex<usize>>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(Mutex::new(0usize));
    let seen = Arc::clone(&hits);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            *seen.lock().unwrap() += 1;
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            );
        }
    });
    (port, hits)
}

#[test]
fn the_allowlist_also_gates_blocking_wasi_http_requests() {
    let (port, hits) = counting_server("pong");
    let url = format!("http://127.0.0.1:{port}/");
    let fetch = |manifest: ModuleManifest| -> Value {
        let mut host = WasmtimeHost::new().unwrap();
        host.register("fetcher", FETCHER, manifest).unwrap();
        let id = host.instantiate("fetcher").unwrap();
        let state = host.init(id, b"{}").unwrap();
        let action = HostAction::new("fetch", json!({ "url": url }).to_string().into_bytes());
        let output = host.dispatch(id, &state, action, &[]).unwrap();
        serde_json::from_slice(&output.state.unwrap()).unwrap()
    };

    // Another host is allow-listed: the request is refused before any
    // connection is made.
    let state = fetch(http_only("fetcher", &["api.example.com"]));
    assert!(state["received"].is_null(), "{state}");
    assert!(!state["error"].is_null(), "{state}");
    // The same host on another port is not this host either.
    let state = fetch(http_only("fetcher", &["127.0.0.1:1"]));
    assert!(!state["error"].is_null(), "{state}");
    assert_eq!(*hits.lock().unwrap(), 0, "a denied request reached the network");

    // Allow-listed (exactly, and by an any-port pattern), or no list at all.
    for manifest in [
        http_only("fetcher", &[&format!("127.0.0.1:{port}")]),
        http_only("fetcher", &["127.0.0.1"]),
        http_only("fetcher", &[]),
    ] {
        let state = fetch(manifest);
        assert_eq!(state["received"]["body"], "pong", "{state}");
    }
    assert_eq!(*hits.lock().unwrap(), 3);
}

// ── through the engine ──────────────────────────────────────────────────────

type Outbox = Arc<Mutex<Vec<(String, HttpEffect)>>>;

/// An engine hosting the fixture under scope `net`, with an effect handler
/// that records the HTTP requests handed to the embedder.
fn engine_with_fixture(manifest: ModuleManifest) -> (Engine, Outbox) {
    let mut engine = Engine::new();
    engine.set_module_host(Box::new(WasmtimeHost::new().unwrap()));
    let outbox: Outbox = Arc::default();
    let sink = Arc::clone(&outbox);
    engine.set_effect_handler(move |scope: &str, effect: &Effect| {
        if let Effect::Http(http) = effect {
            sink.lock().unwrap().push((scope.to_string(), http.clone()));
        }
    });

    let grants = ModuleGrants::from(&manifest);
    let host = engine.module_host_mut().unwrap();
    host.register("net", DEFERRED, manifest).unwrap();
    let id = host.instantiate("net").unwrap();
    let state: Value = serde_json::from_slice(&host.init(id, b"{}").unwrap()).unwrap();
    let actions = host.actions(id).unwrap();
    engine.register_module_instance("net", id, actions, grants, state).unwrap();
    (engine, outbox)
}

fn response(status: u16, content_type: &str, body: &[u8]) -> HttpOutcome {
    HttpOutcome::Response(HttpResponse {
        status,
        headers: vec![("Content-Type".into(), content_type.into())],
        body: body.to_vec(),
    })
}

#[test]
fn a_request_round_trips_through_the_engine_and_a_completion_can_chain_another() {
    let (mut engine, outbox) = engine_with_fixture(http_only("net", &["*.example.com"]));
    engine
        .dispatch_module_action(
            "net",
            "get",
            json!({ "url": "https://a.example.com/first", "tag": "one",
                    "next": "https://b.example.com/second" }),
        )
        .unwrap();
    assert_eq!(engine.get_module_state("net").unwrap()["completions"], 0);
    assert_eq!(engine.module_http_in_flight("net"), 1);

    let (scope, first) = outbox.lock().unwrap().pop().unwrap();
    assert_eq!(scope, "net");
    assert_eq!(first.url.to_string(), "https://a.example.com/first");
    assert_eq!(
        engine.complete_http_request(first.id, response(200, "text/plain", b"hello")),
        Ok(HttpDelivery::Delivered)
    );
    let state = engine.get_module_state("net").unwrap().clone();
    assert_eq!(
        state["last"],
        json!({ "ok": true, "status": 200, "body": "hello", "bodyEncoding": "utf8",
                "contentType": "text/plain", "tag": "one" })
    );

    // `fetched` queued the chained request from inside the completion.
    let (_, second) = outbox.lock().unwrap().pop().expect("chained request");
    assert_eq!(second.request.url, "https://b.example.com/second");
    assert_eq!(second.tag.as_deref(), Some("chained"));
    assert_eq!(engine.module_http_in_flight("net"), 1);

    // Binary body, non-2xx status.
    engine
        .complete_http_request(second.id, response(503, "application/octet-stream", &[0xff, 0x00]))
        .unwrap();
    let state = engine.get_module_state("net").unwrap().clone();
    assert_eq!(state["last"]["status"], 503);
    assert_eq!(state["last"]["body"], "/wA=");
    assert_eq!(state["last"]["bodyEncoding"], "base64");
    assert_eq!(state["log"], json!(["\"one\":200", "\"chained\":503"]));
    assert_eq!(state["completions"], 2);
    assert_eq!(engine.module_http_in_flight("net"), 0);
    assert!(outbox.lock().unwrap().is_empty());

    // Completed means completed.
    assert_eq!(
        engine.complete_http_request(second.id, response(200, "text/plain", b"again")),
        Err(HttpCompletionError::UnknownRequest(second.id))
    );
}

#[test]
fn failures_reach_the_module_with_their_kind_and_tag() {
    let (mut engine, outbox) = engine_with_fixture(http_only("net", &[]));
    for (kind, wire) in [
        (HttpFailureKind::Network, "network"),
        (HttpFailureKind::Timeout, "timeout"),
        (HttpFailureKind::Denied, "denied"),
        (HttpFailureKind::TooLarge, "too-large"),
        (HttpFailureKind::InvalidResponse, "invalid-response"),
    ] {
        engine
            .dispatch_module_action("net", "get", json!({ "url": "http://h.test/", "tag": wire }))
            .unwrap();
        let (_, effect) = outbox.lock().unwrap().pop().unwrap();
        engine
            .complete_http_request(effect.id, HttpOutcome::Failure(HttpFailure::new(kind, "why")))
            .unwrap();
        assert_eq!(
            engine.get_module_state("net").unwrap()["last"],
            json!({ "ok": false, "error": wire, "message": "why", "tag": wire })
        );
    }
}

#[test]
fn the_engine_refuses_a_then_the_module_does_not_export() {
    let (mut engine, outbox) = engine_with_fixture(http_only("net", &[]));
    let err = engine
        .dispatch_module_action("net", "bad", json!({ "case": "then" }))
        .unwrap_err();
    assert!(
        err.to_string().contains("`then` 'not-an-action' is not an action of 'net'"),
        "{err}"
    );
    assert!(outbox.lock().unwrap().is_empty());
    assert_eq!(engine.module_http_in_flight("net"), 0);
    // The dispatch that queued it still applied its state.
    assert_eq!(engine.get_module_state("net").unwrap()["queued"], 1);
    let report = engine.last_module_cascade_report().unwrap();
    assert_eq!(report.failures()[0].cause.code(), "notAccepted");
}

#[test]
fn a_completion_for_a_destroyed_module_is_dropped() {
    let (mut engine, outbox) = engine_with_fixture(http_only("net", &[]));
    engine
        .dispatch_module_action("net", "get", json!({ "url": "http://h.test/" }))
        .unwrap();
    let (_, effect) = outbox.lock().unwrap().pop().unwrap();
    engine.destroy_module("net").unwrap();
    assert_eq!(
        engine.complete_http_request(effect.id, response(200, "text/plain", b"late")),
        Ok(HttpDelivery::ModuleGone)
    );
}
