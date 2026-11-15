//! Hardening tests for the `hypen-runtime` binary, driven as a subprocess
//! against the real wasmtime host: the `--serve` admission policy (Host /
//! Origin / Content-Type / body size), structured HTTP errors, startup error
//! rendering, least-privilege single-module grants, hostile app manifests,
//! crash recovery, and hot reload of live-minted scopes.
//!
//! Run with:
//! `cargo test --features runtime-bin --test test_hypen_runtime_hardening`
//! (set `HYPEN_RUNTIME_BIN` to test a specific build of the binary).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const COUNTER: &str = "tests/fixtures/counter_module.wasm";
const LIMITS: &str = "tests/fixtures/limits_module.wasm";
const SEEDED: &str = "tests/fixtures/seeded_module.wasm";
const COUNTER_UI: &str = "tests/fixtures/counter_ui.hypen";
const APP: &str = "tests/fixtures/app/app.json";

fn runtime_path() -> PathBuf {
    match std::env::var_os("HYPEN_RUNTIME_BIN") {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(env!("CARGO_BIN_EXE_hypen-runtime")),
    }
}

fn fixture(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(path)
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

/// A `hypen-runtime --serve` child whose stderr is collected as it runs.
struct Server {
    child: Child,
    port: u16,
    stderr: Arc<Mutex<String>>,
}

impl Server {
    fn start(args: &[&str]) -> Self {
        let args: Vec<PathBuf> = args.iter().map(PathBuf::from).collect();
        Self::start_paths(&args)
    }

    fn start_paths(args: &[PathBuf]) -> Self {
        let port = free_port();
        let mut child = Command::new(runtime_path())
            .args(args)
            .arg("--serve")
            .arg(port.to_string())
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn hypen-runtime --serve");

        let stderr = Arc::new(Mutex::new(String::new()));
        let sink = Arc::clone(&stderr);
        let mut pipe = child.stderr.take().expect("stderr pipe");
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                sink.lock().unwrap().push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        });

        let server = Server { child, port, stderr };
        let deadline = Instant::now() + Duration::from_secs(20);
        while TcpStream::connect(("127.0.0.1", port)).is_err() {
            assert!(
                Instant::now() < deadline,
                "server did not start. stderr:\n{}",
                server.stderr()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        server
    }

    fn stderr(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    /// Wait until stderr contains `needle`.
    fn wait_for_log(&self, needle: &str) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !self.stderr().contains(needle) {
            assert!(
                Instant::now() < deadline,
                "never logged {needle:?}. stderr:\n{}",
                self.stderr()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn host(&self) -> String {
        format!("127.0.0.1:{}", self.port)
    }

    /// Send one request with exactly these extra header lines.
    fn request(&self, method: &str, path: &str, headers: &[&str], body: Option<&str>) -> Response {
        let mut head = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
        for h in headers {
            head.push_str(h);
            head.push_str("\r\n");
        }
        if let Some(body) = body {
            head.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        head.push_str("\r\n");
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).expect("connect");
        stream.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        stream.write_all(head.as_bytes()).unwrap();
        // The server may answer (and close) before reading a body it refuses.
        let _ = stream.write_all(body.unwrap_or("").as_bytes());
        let mut raw = Vec::new();
        let _ = stream.read_to_end(&mut raw);
        Response::parse(&raw)
    }

    /// A well-formed same-machine CLI request (curl-like: no Origin).
    fn get(&self, path: &str) -> Response {
        self.request("GET", path, &[&format!("Host: {}", self.host())], None)
    }

    fn dispatch(&self, body: &str) -> Response {
        self.request(
            "POST",
            "/dispatch",
            &[&format!("Host: {}", self.host()), "Content-Type: application/json"],
            Some(body),
        )
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Response {
    status: u16,
    head: String,
    body: String,
}

impl Response {
    fn parse(raw: &[u8]) -> Self {
        let text = String::from_utf8_lossy(raw).to_string();
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
        let status = head
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| panic!("no status line in response: {text:?}"));
        Response { status, head: head.to_string(), body: body.to_string() }
    }

    fn json(&self) -> Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|e| panic!("body is not JSON ({e}): {:?}", self.body))
    }

    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().skip(1).find_map(|line| {
            let (n, v) = line.split_once(':')?;
            n.eq_ignore_ascii_case(name).then(|| v.trim().to_string())
        })
    }

    /// Assert the `{ "error": { "code", "message" } }` shape and return it.
    fn error(&self, status: u16, code: &str) -> Value {
        assert_eq!(self.status, status, "body: {}", self.body);
        let error = self.json()["error"].clone();
        assert_eq!(error["code"], code, "body: {}", self.body);
        assert!(error["message"].as_str().is_some_and(|m| !m.is_empty()), "body: {}", self.body);
        assert_eq!(self.header("Content-Type").as_deref(), Some("application/json"));
        error
    }
}

fn counter_server() -> Server {
    Server::start(&[COUNTER, "--grant-storage", "cloud"])
}

fn count(server: &Server) -> Value {
    server.get("/state").json()["state"]["count"].clone()
}

/// Run the binary to completion (REPL mode, empty stdin).
fn run(args: &[&str]) -> (i32, String, String) {
    let output = Command::new(runtime_path())
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::null())
        .output()
        .expect("run hypen-runtime");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    )
}

// ── D1: Host / Origin / Content-Type ────────────────────────────────────────

/// The CSRF shape: a page on another origin POSTs a "simple" request (no
/// preflight) at the dev server. It must be refused before the body is even
/// looked at, and must not change state.
#[test]
fn cross_origin_post_is_refused_and_changes_nothing() {
    let s = counter_server();
    let host = format!("Host: {}", s.host());
    for content_type in ["Content-Type: text/plain", "Content-Type: application/json"] {
        let r = s.request(
            "POST",
            "/dispatch",
            &[&host, "Origin: https://evil.example", content_type],
            Some(r#"{"action":"increment"}"#),
        );
        let error = r.error(403, "forbidden_origin");
        assert!(error["hint"].as_str().unwrap().contains("--allow-origin"), "{error}");
        assert!(r.header("Access-Control-Allow-Origin").is_none(), "no CORS grant: {}", r.head);
    }
    // `Origin: null` (sandboxed iframe, file://) is foreign too.
    let r = s.request(
        "POST",
        "/dispatch",
        &[&host, "Origin: null", "Content-Type: application/json"],
        Some(r#"{"action":"increment"}"#),
    );
    r.error(403, "forbidden_origin");
    assert_eq!(count(&s), 0, "no refused request reached the module");
}

#[test]
fn foreign_origins_cannot_read_state_patches_or_events() {
    let s = counter_server();
    let host = format!("Host: {}", s.host());
    for path in ["/state", "/patches", "/events"] {
        let r = s.request("GET", path, &[&host, "Origin: https://evil.example"], None);
        r.error(403, "forbidden_origin");
        assert!(r.header("Access-Control-Allow-Origin").is_none(), "{path}: {}", r.head);
    }
}

#[test]
fn the_servers_own_origin_and_cli_clients_are_admitted() {
    let s = counter_server();
    // curl: no Origin at all.
    assert_eq!(s.dispatch(r#"{"action":"increment"}"#).status, 200);
    // The reference client: same-origin POSTs carry the server's own origin.
    for origin in [format!("http://127.0.0.1:{}", s.port), format!("http://localhost:{}", s.port)] {
        let r = s.request(
            "POST",
            "/dispatch",
            &[
                &format!("Host: {}", s.host()),
                &format!("Origin: {origin}"),
                "Content-Type: application/json; charset=utf-8",
            ],
            Some(r#"{"action":"increment"}"#),
        );
        assert_eq!(r.status, 200, "{origin}: {}", r.body);
        assert!(r.header("Access-Control-Allow-Origin").is_none(), "same-origin needs no CORS");
    }
    assert_eq!(count(&s), 3);
}

/// DNS rebinding: the attacker's hostname resolves to 127.0.0.1, so the
/// request reaches us — but the browser still sends the attacker's Host.
#[test]
fn requests_with_a_foreign_host_header_are_refused() {
    let s = counter_server();
    for host in [
        format!("evil.example:{}", s.port),
        "127.0.0.1".to_string(),
        format!("127.0.0.1:{}", s.port.wrapping_add(1)),
    ] {
        for path in ["/", "/state", "/patches", "/events"] {
            let r = s.request("GET", path, &[&format!("Host: {host}")], None);
            r.error(403, "forbidden_host");
        }
        let r = s.request(
            "POST",
            "/dispatch",
            &[&format!("Host: {host}"), "Content-Type: application/json"],
            Some(r#"{"action":"increment"}"#),
        );
        r.error(403, "forbidden_host");
    }
    assert_eq!(count(&s), 0);
    // `localhost` with the right port is this server.
    let r = s.request("GET", "/state", &[&format!("Host: localhost:{}", s.port)], None);
    assert_eq!(r.status, 200);
}

#[test]
fn allow_origin_admits_exactly_that_origin_with_cors_headers() {
    let s = Server::start(&[
        COUNTER,
        "--grant-storage",
        "cloud",
        "--allow-origin",
        "http://localhost:5173",
    ]);
    let host = format!("Host: {}", s.host());

    // The browser's preflight for a JSON POST.
    let r = s.request(
        "OPTIONS",
        "/dispatch",
        &[&host, "Origin: http://localhost:5173", "Access-Control-Request-Method: POST"],
        None,
    );
    assert_eq!(r.status, 204, "{}", r.body);
    assert_eq!(r.header("Access-Control-Allow-Origin").as_deref(), Some("http://localhost:5173"));
    assert!(r.header("Access-Control-Allow-Headers").unwrap().contains("Content-Type"));

    let r = s.request(
        "POST",
        "/dispatch",
        &[&host, "Origin: http://localhost:5173", "Content-Type: application/json"],
        Some(r#"{"action":"increment"}"#),
    );
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(r.header("Access-Control-Allow-Origin").as_deref(), Some("http://localhost:5173"));
    assert_eq!(r.header("Vary").as_deref(), Some("Origin"));

    // Any other origin is still refused — the grant is not a wildcard.
    let r = s.request("GET", "/state", &[&host, "Origin: http://localhost:5174"], None);
    r.error(403, "forbidden_origin");
    let r = s.request("OPTIONS", "/dispatch", &[&host, "Origin: https://evil.example"], None);
    r.error(403, "forbidden_origin");
}

#[test]
fn the_event_stream_sends_no_wildcard_cors_header() {
    let s = counter_server();
    let mut stream = TcpStream::connect(("127.0.0.1", s.port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    stream
        .write_all(format!("GET /events HTTP/1.1\r\nHost: {}\r\n\r\n", s.host()).as_bytes())
        .unwrap();
    let mut seen = String::new();
    let mut buf = [0u8; 1024];
    while !seen.contains(": connected") {
        let n = stream.read(&mut buf).expect("SSE handshake");
        assert!(n > 0, "stream closed early: {seen}");
        seen.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
    assert!(seen.contains("text/event-stream"), "{seen}");
    assert!(!seen.to_lowercase().contains("access-control-allow-origin"), "{seen}");
}

#[test]
fn post_bodies_must_be_declared_json() {
    let s = counter_server();
    let host = format!("Host: {}", s.host());
    for content_type in [None, Some("Content-Type: text/plain"), Some("Content-Type: application/x-www-form-urlencoded")] {
        let mut headers = vec![host.as_str()];
        headers.extend(content_type);
        let r = s.request("POST", "/dispatch", &headers, Some(r#"{"action":"increment"}"#));
        let error = r.error(415, "unsupported_media_type");
        assert!(error["hint"].as_str().unwrap().contains("application/json"));
    }
    assert_eq!(count(&s), 0);
}

// ── D2: body size, stalled clients ──────────────────────────────────────────

#[test]
fn oversized_bodies_are_refused_with_413() {
    let s = counter_server();
    let padding = "x".repeat(1024 * 1024 + 1);
    let body = format!(r#"{{"action":"increment","payload":"{padding}"}}"#);
    s.dispatch(&body).error(413, "payload_too_large");

    // A chunked body has no Content-Length to check up front; the cap still
    // holds while reading.
    let mut stream = TcpStream::connect(("127.0.0.1", s.port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    stream
        .write_all(
            format!(
                "POST /dispatch HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\n\
                 Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                s.host()
            )
            .as_bytes(),
        )
        .unwrap();
    let chunk = "x".repeat(64 * 1024);
    for _ in 0..20 {
        // The server may stop reading (and answer) once it is past the cap.
        if stream.write_all(format!("{:x}\r\n{chunk}\r\n", chunk.len()).as_bytes()).is_err() {
            break;
        }
    }
    let _ = stream.write_all(b"0\r\n\r\n");
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    Response::parse(&raw).error(413, "payload_too_large");

    // Just under the cap is fine, and the server is still healthy.
    let ok = format!(r#"{{"action":"increment","payload":"{}"}}"#, "x".repeat(900 * 1024));
    assert_eq!(s.dispatch(&ok).status, 200);
    assert_eq!(count(&s), 1);
}

/// A client that sends headers and then stalls mid-body must not stop
/// anyone else from being served.
#[test]
fn a_stalled_request_does_not_block_other_requests() {
    let s = counter_server();
    let mut stalled = Vec::new();
    for _ in 0..8 {
        let mut stream = TcpStream::connect(("127.0.0.1", s.port)).unwrap();
        stream
            .write_all(
                format!(
                    "POST /dispatch HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\n\
                     Content-Length: 4096\r\n\r\n{{\"action\":",
                    s.host()
                )
                .as_bytes(),
            )
            .unwrap();
        stalled.push(stream); // …and never send the rest
    }
    std::thread::sleep(Duration::from_millis(200));

    let started = Instant::now();
    for expected in 1..=5 {
        let r = s.dispatch(r#"{"action":"increment"}"#);
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(r.json()["state"]["count"], expected);
    }
    assert_eq!(s.get("/state").status, 200);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "other requests were served promptly while 8 clients stalled ({:?})",
        started.elapsed()
    );
    drop(stalled);
}

// ── C: structured errors, the server keeps serving ──────────────────────────

#[test]
fn bad_requests_get_json_errors_and_never_take_the_server_down() {
    let s = counter_server();

    s.dispatch("{not json").error(400, "invalid_json");
    s.dispatch("").error(400, "invalid_json");
    s.dispatch(r#"{"payload":{}}"#).error(400, "invalid_json");
    s.dispatch(r#"{"action":""}"#).error(400, "invalid_request");

    let r = s.dispatch(r#"{"action":"nonexistent"}"#);
    r.error(404, "action_not_found");
    assert_eq!(r.json()["state"]["count"], 0, "failed dispatches still report state");
    assert_eq!(r.json()["patches"], json!([]));

    s.get("/missing").error(404, "not_found");
    let r = s.get("/dispatch");
    r.error(405, "method_not_allowed");
    assert_eq!(r.header("Allow").as_deref(), Some("POST"));
    let r = s.request(
        "DELETE",
        "/state",
        &[&format!("Host: {}", s.host())],
        None,
    );
    r.error(405, "method_not_allowed");

    // After all of that the server still works.
    let r = s.dispatch(r#"{"action":"increment"}"#);
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["state"]["count"], 1);
    assert!(r.json().get("error").is_none());
}

// ── D5: /patches is a bounded snapshot ──────────────────────────────────────

#[test]
fn patches_is_a_snapshot_that_does_not_grow_with_history() {
    let s = Server::start(&[
        COUNTER, "--grant-storage", "cloud", "--scope", "counter", "--ui", COUNTER_UI,
    ]);
    let initial = s.get("/patches").json();
    let initial_len = initial.as_array().expect("patch array").len();
    assert!(initial_len > 0);
    assert!(s.get("/patches").body.contains("Count: 0"));

    for _ in 0..40 {
        assert_eq!(s.dispatch(r#"{"action":"increment"}"#).status, 200);
    }
    let after = s.get("/patches");
    let patches = after.json();
    let patches = patches.as_array().unwrap();
    assert_eq!(patches.len(), initial_len, "40 re-renders later the snapshot is the same size");
    assert!(after.body.contains("Count: 40"), "…and current: {}", after.body);
    assert!(!after.body.contains("Count: 39"), "no history is replayed");
    // A snapshot is only Creates and Inserts — what a fresh client needs.
    assert!(patches.iter().all(|p| p["type"] == "create" || p["type"] == "insert"), "{}", after.body);
}

// ── D9: the reference client's envelope ─────────────────────────────────────

/// The reference client sends UI actions as the engine's `__hypen_dispatch`
/// envelope; the scope is resolved from the node, never named by the client.
#[test]
fn ui_actions_arrive_as_hypen_dispatch_envelopes() {
    let s = Server::start(&["--app", APP]);
    let html = s.get("/").body;
    assert!(html.contains("__hypen_dispatch"), "client sends envelopes");
    assert!(!html.contains("sender:"), "client no longer relies on the `sender` shortcut");

    let tree = s.get("/patches").json();
    let button = tree
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["type"] == "create" && p["elementType"] == "Button")
        .and_then(|p| p["id"].as_str())
        .expect("the Counter's Button")
        .to_string();
    let body = json!({
        "action": "__hypen_dispatch",
        "payload": { "node": button, "action": "increment", "payload": {} },
    });
    let r = s.dispatch(&body.to_string());
    assert_eq!(r.status, 200, "{}", r.body);
    let v = r.json();
    assert_eq!(v["states"]["counter"]["count"], 1, "resolved to the Button's owner: {v}");
    assert_eq!(v["states"]["app"]["count"], 0, "{v}");

    // An envelope for a node that owns no such action is refused.
    let body = json!({
        "action": "__hypen_dispatch",
        "payload": { "node": "no-such-node", "action": "increment", "payload": {} },
    });
    let r = s.dispatch(&body.to_string());
    assert_ne!(r.status, 200, "{}", r.body);
    assert!(r.json()["error"]["code"].is_string());
}

// ── D10: a crashed module is reported, then restarted ───────────────────────

#[test]
fn a_crashed_module_is_reported_and_restarted_on_the_next_action() {
    let s = Server::start(&[LIMITS, "--grant-storage", "app", "--call-timeout-ms", "400"]);
    assert_eq!(s.dispatch(r#"{"action":"noop"}"#).status, 200);

    // `hang` spins forever: the call deadline kills the instance.
    let r = s.dispatch(r#"{"action":"hang"}"#);
    let error = r.error(500, "module_crashed");
    assert_eq!(error["scopes"], json!(["limits_module"]), "{error}");
    assert!(error["hint"].as_str().unwrap().contains("next action"), "{error}");
    s.wait_for_log("module `limits_module` CRASHED");

    // The next action restarts it from its config and then runs normally.
    let r = s.dispatch(r#"{"action":"noop"}"#);
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(r.json()["state"], json!({ "count": 0 }));
    s.wait_for_log("module `limits_module` was RESTARTED");

    // And it can crash and recover again; other endpoints never went away.
    s.dispatch(r#"{"action":"hang"}"#).error(500, "module_crashed");
    assert_eq!(s.get("/state").status, 200);
    assert_eq!(s.dispatch(r#"{"action":"noop"}"#).status, 200);
}

// ── D6: live-minted scopes hot-reload with their .wasm ──────────────────────

#[test]
fn a_live_minted_usage_scope_is_hot_reloaded_with_its_wasm() {
    let tmp = tempfile::tempdir().unwrap();
    let wasm = tmp.path().join("seeded.wasm");
    std::fs::copy(fixture(SEEDED), &wasm).unwrap();
    let app_hypen = |extra: &str| {
        format!("module App {{\n Column {{\n  Text(\"App: @{{state.count}}\")\n  Seeded()\n{extra} }}\n}}\n")
    };
    std::fs::write(tmp.path().join("app.hypen"), app_hypen("")).unwrap();
    std::fs::write(
        tmp.path().join("seeded.hypen"),
        "module Seeded {\n Text(\"Seeded: @{state.count}\")\n}\n",
    )
    .unwrap();
    std::fs::write(
        tmp.path().join("app.json"),
        r#"{ "entry": "App", "modules": [
            { "name": "App", "wasm": "seeded.wasm", "ui": "app.hypen" },
            { "name": "Seeded", "wasm": "seeded.wasm", "ui": "seeded.hypen" } ] }"#,
    )
    .unwrap();
    let s = Server::start_paths(&[PathBuf::from("--app"), tmp.path().join("app.json")]);
    s.wait_for_log("[reload] watching");

    // A template edit adds a second usage with its own config → a new scope.
    std::fs::write(tmp.path().join("app.hypen"), app_hypen("  Seeded(start: 5)\n")).unwrap();
    s.wait_for_log("minted usage scope `seeded__a`");
    assert_eq!(s.get("/state").json()["states"]["seeded__a"]["count"], 5);

    // "Rebuild" the module. Every scope it backs must be swapped — including
    // the one minted after boot — and keep its state.
    std::fs::write(&wasm, std::fs::read(fixture(SEEDED)).unwrap()).unwrap();
    for scope in ["app", "seeded", "seeded__a"] {
        s.wait_for_log(&format!("[reload] {scope} reloaded"));
    }
    assert_eq!(s.get("/state").json()["states"]["seeded__a"]["count"], 5, "state preserved");

    // One change, one reload. The watcher also reports the reload's own read
    // of the file; that echo must not start another reload (it used to loop
    // forever, recompiling the module several times a second).
    std::thread::sleep(Duration::from_millis(1500));
    let log = s.stderr();
    for line in ["[reload] seeded__a reloaded", "[reload] app reloaded", "[reload] ui re-rendered"] {
        assert_eq!(log.matches(line).count(), 1, "`{line}` exactly once. stderr:\n{log}");
    }
}

// ── D7 / B: hostile and mistaken manifests ──────────────────────────────────

fn write_manifest(dir: &Path, modules: &str) -> String {
    std::fs::write(dir.join("app.hypen"), "module App { Text(\"x\") }").unwrap();
    std::fs::copy(fixture(SEEDED), dir.join("ok.wasm")).unwrap();
    let path = dir.join("app.json");
    std::fs::write(&path, format!(r#"{{ "entry": "App", "modules": [ {modules} ] }}"#)).unwrap();
    path.to_string_lossy().to_string()
}

#[test]
fn manifests_that_escape_their_directory_or_misname_modules_fail_to_boot() {
    let outer = tempfile::tempdir().unwrap();
    std::fs::copy(fixture(SEEDED), outer.path().join("outside.wasm")).unwrap();
    let dir = outer.path().join("app");
    std::fs::create_dir(&dir).unwrap();
    let outside_abs = outer.path().join("outside.wasm").to_string_lossy().to_string();

    let cases: Vec<(String, &str, &str)> = vec![
        (
            r#"{ "name": "App", "wasm": "../outside.wasm", "ui": "app.hypen" }"#.to_string(),
            "`modules[0].wasm`",
            "outside the manifest directory",
        ),
        (
            format!(r#"{{ "name": "App", "wasm": {outside_abs:?}, "ui": "app.hypen" }}"#),
            "`modules[0].wasm`",
            "outside the manifest directory",
        ),
        (
            r#"{ "name": "App", "wasm": "ok.wasm", "ui": "/etc/hostname" }"#.to_string(),
            "`modules[0].ui`",
            "outside the manifest directory",
        ),
        (
            r#"{ "name": "App", "wasm": "ok.wasm", "ui": "app.hypen" },
               { "name": "app", "wasm": "ok.wasm", "ui": "app.hypen" }"#
                .to_string(),
            "`modules[1].name`",
            "duplicate module",
        ),
        (
            r#"{ "name": "App", "wasm": "ok.wasm", "ui": "app.hypen" },
               { "name": "a:b", "wasm": "ok.wasm", "ui": "app.hypen" }"#
                .to_string(),
            "`modules[1].name`",
            "contains `:`",
        ),
        (
            r#"{ "name": "App", "wasm": "ok.wasm", "ui": "app.hypen", "reads": ["ghost"] }"#
                .to_string(),
            "`modules[0].reads[0]`",
            "not a stateful module",
        ),
        (
            r#"{ "name": "App", "wasm": "missing.wasm", "ui": "app.hypen" }"#.to_string(),
            "`modules[0].wasm`",
            "cannot be resolved",
        ),
    ];
    for (modules, field, problem) in cases {
        let manifest = write_manifest(&dir, &modules);
        let (code, stdout, stderr) = run(&["--app", &manifest]);
        assert_eq!(code, 1, "{modules}\nstderr: {stderr}");
        assert!(stdout.is_empty(), "nothing booted: {stdout}");
        assert!(stderr.starts_with("error: invalid app manifest"), "{stderr}");
        assert!(stderr.contains(field), "names the field {field}: {stderr}");
        assert!(stderr.contains(problem), "says why ({problem}): {stderr}");
        assert!(!stderr.contains("panicked"), "{stderr}");
    }

    // Not JSON at all.
    std::fs::write(dir.join("app.json"), "{ nope").unwrap();
    let (code, _, stderr) = run(&["--app", &dir.join("app.json").to_string_lossy()]);
    assert_eq!(code, 1);
    assert!(stderr.contains("is not valid JSON") && stderr.contains("caused by:"), "{stderr}");
}

// ── D8 / C: least privilege and startup errors ──────────────────────────────

#[test]
fn single_module_mode_grants_nothing_by_default() {
    // The counter imports `hypen:storage/cloud`; without the grant it does
    // not start, and the error says which flag grants it.
    let (code, _, stderr) = run(&[COUNTER]);
    assert_eq!(code, 1, "{stderr}");
    let lines: Vec<&str> = stderr.lines().collect();
    assert_eq!(lines[0], "error: module `counter_module`: instantiate failed", "{stderr}");
    assert!(lines[1].starts_with("  caused by: instantiation failed:"), "{stderr}");
    assert!(lines[1].contains("hypen:storage/cloud"), "{stderr}");
    assert!(lines[2].starts_with("  hint: ") && lines[2].contains("--grant-storage cloud"), "{stderr}");

    let (code, stdout, stderr) = run(&[COUNTER, "--grant-storage", "cloud"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains(r#"ready: {"count":0}"#), "{stdout}");

    // In --app mode the same failure points at app.json instead.
    let (code, _, stderr) = run(&["--app", "tests/fixtures/app_acl/app_http_denied.json"]);
    assert_eq!(code, 1);
    assert!(stderr.contains("error: module `fetcher`: instantiate failed"), "{stderr}");
    assert!(stderr.contains("hint: ") && stderr.contains("\"http\": true"), "{stderr}");
    assert!(stderr.contains("`fetcher` entry in app.json"), "{stderr}");
}

#[test]
fn startup_failures_exit_nonzero_with_a_rendered_error_never_a_panic() {
    // Usage mistakes: exit 2, the error, a pointer to --help.
    for args in [&[][..], &["--frob"], &[COUNTER, "--serve"], &[COUNTER, "--serve", "x"], &[COUNTER, "--app", APP]] {
        let (code, stdout, stderr) = run(args);
        assert_eq!(code, 2, "{args:?}: {stderr}");
        assert!(stdout.is_empty());
        assert!(stderr.starts_with("error: "), "{stderr}");
        assert!(stderr.contains("hint: run with --help"), "{stderr}");
        assert!(!stderr.contains("panicked"), "{stderr}");
    }

    // --help: usage on stdout, exit 0.
    let (code, stdout, _) = run(&["--help"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("--grant-http") && stdout.contains("--allow-origin"), "{stdout}");

    // Runtime failures: exit 1, naming the file.
    let cases: [(&[&str], &str); 4] = [
        (&["no/such/module.wasm"], "error: cannot read no/such/module.wasm"),
        (&["--app", "no/such/app.json"], "error: cannot read no/such/app.json"),
        (&[SEEDED, "--ui", "no/such/ui.hypen"], "error: cannot read no/such/ui.hypen"),
        // A file that is not a component.
        (&[COUNTER_UI], "error: module `counter_ui`: register failed"),
    ];
    for (args, expected) in cases {
        let (code, _, stderr) = run(args);
        assert_eq!(code, 1, "{args:?}: {stderr}");
        assert!(stderr.starts_with(expected), "{args:?}: {stderr}");
        assert!(stderr.contains("caused by:"), "{stderr}");
        assert!(!stderr.contains("panicked"), "{stderr}");
    }

    // A port that is already taken.
    let s = counter_server();
    let (code, _, stderr) =
        run(&[COUNTER, "--grant-storage", "cloud", "--serve", &s.port.to_string()]);
    assert_eq!(code, 1, "{stderr}");
    assert!(stderr.contains(&format!("error: cannot listen on 127.0.0.1:{}", s.port)), "{stderr}");
}
