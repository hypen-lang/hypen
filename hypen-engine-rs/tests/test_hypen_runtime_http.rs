//! Deferred HTTP (`hypen:http/deferred`) end to end: the `hypen-runtime`
//! binary hosts `deferred_http_module.wasm`, the module queues requests from
//! its reducer, the runtime performs them on its worker pool against an HTTP
//! server running in this test process, and the completion comes back as the
//! module's `fetched` action — observed over the real `--serve` API
//! (`POST /dispatch`, `GET /state`, the `GET /events` patch stream).
//!
//! Run with: `cargo test --features runtime-bin --test test_hypen_runtime_http`

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const MODULE: &str = "tests/fixtures/deferred_http_module.wasm";
const UI: &str = "tests/fixtures/deferred_http_ui.hypen";

/// See `test_hypen_runtime.rs`: the binary cargo built for this target, or
/// `HYPEN_RUNTIME_BIN`.
fn runtime_path() -> PathBuf {
    match std::env::var_os("HYPEN_RUNTIME_BIN") {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(env!("CARGO_BIN_EXE_hypen-runtime")),
    }
}

// ── the upstream: an HTTP server in this process ────────────────────────────

const BIG: usize = 4 * 1024 * 1024 + 1;

/// What the upstream saw: one request line + headers per connection.
type Seen = Arc<Mutex<Vec<String>>>;

struct Upstream {
    port: u16,
    seen: Seen,
}

impl Upstream {
    /// Routes:
    /// `/ok` 200 text · `/missing` 404 · `/binary` 200 non-UTF-8 ·
    /// `/slow` answers after 3 s · `/big` a body one byte over the 4 MiB cap ·
    /// `/hop` 302 → `/ok` (same host) · `/leave` 302 → `http://localhost:<port>/ok`
    /// (another host name) · `/second` 200 "second".
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen: Seen = Arc::default();
        let log = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let log = Arc::clone(&log);
                std::thread::spawn(move || serve(stream, port, &log));
            }
        });
        Self { port, seen }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn requests(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

fn serve(mut stream: TcpStream, port: u16, log: &Seen) {
    let mut head = Vec::new();
    let mut chunk = [0u8; 2048];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => head.extend_from_slice(&chunk[..n]),
        }
    }
    let head = String::from_utf8_lossy(&head).to_string();
    log.lock().unwrap().push(head.clone());
    let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();

    let reply = |status: &str, content_type: &str, body: &[u8]| {
        let mut bytes = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
             X-Upstream: test\r\n\r\n",
            body.len()
        )
        .into_bytes();
        bytes.extend_from_slice(body);
        bytes
    };
    let redirect = |to: &str| {
        format!("HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\n\r\n").into_bytes()
    };
    let bytes = match path.as_str() {
        "/ok" => reply("200 OK", "text/plain", b"hello"),
        "/second" => reply("200 OK", "text/plain", b"second"),
        "/missing" => reply("404 Not Found", "text/plain", b"nope"),
        "/binary" => reply("200 OK", "application/octet-stream", &[0xff, 0xfe, 0x00]),
        "/slow" => {
            std::thread::sleep(Duration::from_secs(3));
            reply("200 OK", "text/plain", b"late")
        }
        "/big" => reply("200 OK", "application/octet-stream", &vec![b'x'; BIG]),
        "/hop" => redirect("/ok"),
        "/leave" => redirect(&format!("http://localhost:{port}/ok")),
        _ => reply("400 Bad Request", "text/plain", b"unknown test route"),
    };
    let _ = stream.write_all(&bytes);
}

// ── the runtime under test ──────────────────────────────────────────────────

struct Runtime {
    child: Child,
    port: u16,
}

impl Runtime {
    /// `hypen-runtime <module> <args…> --serve <port>`, ready to accept.
    fn serve(args: &[&str]) -> Self {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let child = Command::new(runtime_path())
            .args(args)
            .arg("--serve")
            .arg(port.to_string())
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn hypen-runtime --serve");
        let runtime = Self { child, port };
        let deadline = Instant::now() + Duration::from_secs(20);
        while TcpStream::connect(("127.0.0.1", port)).is_err() {
            assert!(Instant::now() < deadline, "the runtime did not start listening");
            std::thread::sleep(Duration::from_millis(50));
        }
        runtime
    }

    /// The fixture in single-module mode, allowed to reach `127.0.0.1` only.
    fn with_module() -> Self {
        Self::serve(&[MODULE, "--scope", "net", "--grant-http", "--grant-http-host", "127.0.0.1"])
    }

    fn request(&self, method: &str, path: &str, body: Option<&Value>) -> (u16, Value) {
        let body = body.map(Value::to_string).unwrap_or_default();
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.port,
            body.len()
        )
        .unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).unwrap();
        let (head, body) = raw.split_once("\r\n\r\n").expect("an HTTP response");
        let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, serde_json::from_str(body).unwrap_or(Value::Null))
    }

    fn dispatch(&self, action: &str, payload: Value) -> (u16, Value) {
        self.request("POST", "/dispatch", Some(&json!({ "action": action, "payload": payload })))
    }

    fn state(&self) -> Value {
        self.request("GET", "/state", None).1["state"].clone()
    }

    /// Poll `/state` until the module has seen `completions` completions.
    fn await_completions(&self, completions: u64) -> Value {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let state = self.state();
            if state["completions"].as_u64() >= Some(completions) {
                return state;
            }
            assert!(
                Instant::now() < deadline,
                "completion {completions} never arrived; state: {state}"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// Queue one GET through the module and wait for its completion.
    fn fetch(&self, payload: Value) -> Value {
        let before = self.state()["completions"].as_u64().unwrap();
        let (status, body) = self.dispatch("get", payload);
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["state"]["sendError"], Value::Null, "{body}");
        assert_eq!(
            body["state"]["completions"], before,
            "the reducer returned before the request completed"
        );
        self.await_completions(before + 1)["last"].clone()
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ── tests ───────────────────────────────────────────────────────────────────

#[test]
fn a_queued_request_is_performed_and_completes_into_the_module() {
    let upstream = Upstream::start();
    let runtime = Runtime::with_module();

    let last = runtime.fetch(json!({
        "url": upstream.url("/ok"),
        "tag": "greeting",
        "headers": { "x-token": "abc" },
    }));
    assert_eq!(
        last,
        json!({ "ok": true, "status": 200, "body": "hello", "bodyEncoding": "utf8",
                "contentType": "text/plain", "tag": "greeting" })
    );
    let request = upstream.requests().pop().unwrap().to_ascii_lowercase();
    assert!(request.starts_with("get /ok http/1.1\r\n"), "{request}");
    assert!(request.contains(&format!("\r\nhost: 127.0.0.1:{}\r\n", upstream.port)), "{request}");
    assert!(request.contains("\r\nx-token: abc\r\n"), "{request}");

    // A non-2xx status is a completed exchange, not a failure.
    let last = runtime.fetch(json!({ "url": upstream.url("/missing"), "tag": "404" }));
    assert_eq!(
        (last["ok"].clone(), last["status"].clone(), last["body"].clone()),
        (json!(true), json!(404), json!("nope"))
    );

    // Bytes that are not UTF-8 arrive base64-encoded.
    let last = runtime.fetch(json!({ "url": upstream.url("/binary") }));
    assert_eq!(last["body"], "//4A");
    assert_eq!(last["bodyEncoding"], "base64");

    // A same-host redirect is followed.
    let last = runtime.fetch(json!({ "url": upstream.url("/hop"), "tag": "hop" }));
    assert_eq!((last["status"].clone(), last["body"].clone()), (json!(200), json!("hello")));
}

#[test]
fn every_failure_kind_reaches_the_module() {
    let upstream = Upstream::start();
    let runtime = Runtime::with_module();

    // Slow upstream, short budget.
    let started = Instant::now();
    let last = runtime.fetch(json!({ "url": upstream.url("/slow"), "timeoutMs": 300, "tag": "slow" }));
    assert_eq!((last["ok"].clone(), last["error"].clone()), (json!(false), json!("timeout")));
    assert_eq!(last["tag"], "slow");
    assert!(last["message"].as_str().unwrap().contains("300 ms"), "{last}");
    assert!(started.elapsed() < Duration::from_secs(3), "the timeout did not cut the wait short");

    // A body over the response cap.
    let last = runtime.fetch(json!({ "url": upstream.url("/big") }));
    assert_eq!(last["error"], "too-large", "{last}");

    // A redirect to a host that is not allow-listed: refused on the hop,
    // before any connection to it.
    let hits = upstream.requests().len();
    let last = runtime.fetch(json!({ "url": upstream.url("/leave"), "tag": "leave" }));
    assert_eq!(last["error"], "denied", "{last}");
    let why = last["message"].as_str().unwrap();
    assert!(
        why.contains(&format!("'localhost:{}'", upstream.port)) && why.contains("httpHosts"),
        "{why}"
    );
    assert_eq!(upstream.requests().len(), hits + 1, "only the first hop was requested");

    // Nothing listens on the port.
    let dead = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let last = runtime.fetch(json!({ "url": format!("http://127.0.0.1:{dead}/") }));
    assert_eq!(last["error"], "network", "{last}");
    assert!(last["message"].as_str().unwrap().contains(&format!("127.0.0.1:{dead}")), "{last}");

    // Each failure was one completion; the module is still serving.
    assert_eq!(
        runtime.state()["log"],
        json!(["\"slow\":\"timeout\"", "null:\"too-large\"", "\"leave\":\"denied\"", "null:\"network\""])
    );
    let last = runtime.fetch(json!({ "url": upstream.url("/ok") }));
    assert_eq!(last["status"], 200);
}

#[test]
fn a_host_outside_the_allowlist_is_refused_when_the_request_is_queued() {
    let upstream = Upstream::start();
    let runtime = Runtime::with_module();
    let (status, body) =
        runtime.dispatch("get", json!({ "url": format!("http://localhost:{}/ok", upstream.port) }));
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["state"]["sendError"],
        format!(
            "permission-denied: host 'localhost:{}' is not in the manifest's `httpHosts` allowlist",
            upstream.port
        )
    );
    std::thread::sleep(Duration::from_millis(200));
    assert!(upstream.requests().is_empty());
    assert_eq!(runtime.state()["completions"], 0);
}

#[test]
fn a_completion_handler_chains_the_next_request_and_requests_run_concurrently() {
    let upstream = Upstream::start();
    let runtime = Runtime::with_module();

    // `fetched` queues `next` from inside the completion.
    let (status, body) = runtime.dispatch(
        "get",
        json!({ "url": upstream.url("/ok"), "tag": "first", "next": upstream.url("/second") }),
    );
    assert_eq!(status, 200, "{body}");
    let state = runtime.await_completions(2);
    assert_eq!(state["log"], json!(["\"first\":200", "\"chained\":200"]));
    assert_eq!(state["last"]["body"], "second");

    // Sixteen requests from one reducer call — the per-call bound; the
    // seventeenth `send` is refused — go through the worker pool and each
    // completes exactly once.
    let started = Instant::now();
    let (_, body) = runtime.dispatch("flood", json!({ "url": upstream.url("/ok"), "count": 17 }));
    assert_eq!(body["state"]["accepted"], 16, "{body}");
    assert_eq!(
        body["state"]["sendError"],
        "limit-exceeded: too many requests in one call (limit 16)"
    );
    let state = runtime.await_completions(18);
    assert_eq!(state["completions"], 18);
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn the_completion_render_is_pushed_to_event_stream_subscribers() {
    let upstream = Upstream::start();
    let runtime = Runtime::serve(&[
        MODULE, "--scope", "net", "--ui", UI, "--grant-http", "--grant-http-host",
        &format!("127.0.0.1:{}", upstream.port),
    ]);

    // Subscribe first; `: connected` is written once the subscriber is
    // registered, so a later broadcast is guaranteed to reach this socket.
    let mut sse = TcpStream::connect(("127.0.0.1", runtime.port)).unwrap();
    sse.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
    write!(sse, "GET /events HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n", runtime.port).unwrap();
    let mut stream = String::new();
    let read_until = |sse: &mut TcpStream, stream: &mut String, needle: &str| {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut chunk = [0u8; 4096];
        while !stream.contains(needle) {
            assert!(Instant::now() < deadline, "never saw {needle:?} in: {stream}");
            if let Ok(n) = sse.read(&mut chunk) {
                assert!(n > 0, "the event stream closed: {stream}");
                stream.push_str(&String::from_utf8_lossy(&chunk[..n]));
            }
        }
    };
    read_until(&mut sse, &mut stream, ": connected");

    // The dispatch's own response carries no body text: nothing has been
    // fetched when the reducer returns.
    let (status, body) = runtime.dispatch("get", json!({ "url": upstream.url("/ok") }));
    assert_eq!(status, 200, "{body}");
    assert!(!body["patches"].to_string().contains("Body: hello"), "{body}");

    // The completion's re-render arrives out of band, as patches.
    read_until(&mut sse, &mut stream, "Body: hello");
    assert!(stream.contains("Completions: 1"), "{stream}");
    let state = runtime.state();
    assert_eq!(state["last"]["body"], "hello");
    assert_eq!(state["completions"], 1);
}

#[test]
fn app_json_grants_http_hosts_per_module() {
    let upstream = Upstream::start();
    let dir = tempfile::tempdir().unwrap();
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    std::fs::copy(fixtures.join("deferred_http_module.wasm"), dir.path().join("net.wasm")).unwrap();
    std::fs::write(
        dir.path().join("net.hypen"),
        "module Net {\n Text(\"Completions: @{state.completions}\")\n}\n",
    )
    .unwrap();
    let manifest = dir.path().join("app.json");
    let write_manifest = |module: Value| {
        let app = json!({ "entry": "Net", "modules": [module] });
        std::fs::write(&manifest, app.to_string()).unwrap();
    };
    let manifest_arg = manifest.to_str().unwrap().to_string();

    write_manifest(json!({
        "name": "Net", "wasm": "net.wasm", "ui": "net.hypen",
        "http": true, "httpHosts": [format!("127.0.0.1:{}", upstream.port)],
    }));
    let runtime = Runtime::serve(&["--app", &manifest_arg]);
    let last = runtime.fetch(json!({ "url": upstream.url("/ok") }));
    assert_eq!(last["body"], "hello");
    // Same address, another port: outside the allowlist.
    let (_, body) = runtime.dispatch("get", json!({ "url": "http://127.0.0.1:1/" }));
    assert!(
        body["state"]["sendError"].as_str().unwrap().contains("host '127.0.0.1:1' is not in"),
        "{body}"
    );
    drop(runtime);

    // A malformed pattern stops the boot, naming the field.
    write_manifest(json!({
        "name": "Net", "wasm": "net.wasm", "ui": "net.hypen",
        "http": true, "httpHosts": ["https://api.example.com/v1"],
    }));
    let output = Command::new(runtime_path())
        .args(["--app", &manifest_arg])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("modules[0].httpHosts[0]") && stderr.contains("drop the scheme"),
        "{stderr}"
    );

    // Without `http`, the module's import is refused at boot with the grant
    // to add.
    write_manifest(json!({ "name": "Net", "wasm": "net.wasm", "ui": "net.hypen" }));
    let output = Command::new(runtime_path())
        .args(["--app", &manifest_arg])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("hypen:http/deferred@0.1.0"), "{stderr}");
    assert!(stderr.contains("http"), "{stderr}");
}

#[test]
fn the_repl_performs_requests_inline_and_follows_the_chain() {
    let upstream = Upstream::start();
    let mut child = Command::new(runtime_path())
        .args([MODULE, "--scope", "net", "--grant-http", "--grant-http-host", "127.0.0.1"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let line = json!({ "url": upstream.url("/ok"), "tag": "a", "next": upstream.url("/second") });
    writeln!(child.stdin.as_mut().unwrap(), "get {line}").unwrap();
    drop(child.stdin.take());
    let mut stdout = String::new();
    child.stdout.as_mut().unwrap().read_to_string(&mut stdout).unwrap();
    assert!(child.wait().unwrap().success());

    let ok = format!("http: GET {} -> net:fetched", upstream.url("/ok"));
    let second = format!("http: GET {} -> net:fetched", upstream.url("/second"));
    let (first_at, second_at) = (stdout.find(&ok), stdout.find(&second));
    assert!(first_at.is_some() && second_at > first_at, "{stdout}");
    let final_state: Value = stdout
        .lines()
        .rev()
        .find_map(|l| l.strip_prefix("state: "))
        .map(|s| serde_json::from_str(s).unwrap())
        .unwrap();
    assert_eq!(final_state["log"], json!(["\"a\":200", "\"chained\":200"]));
    assert_eq!(final_state["last"]["body"], "second");
}
