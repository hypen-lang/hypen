//! Integration test driving the `hypen-runtime` binary as a subprocess.
//!
//! Run with: `cargo test --features runtime-bin --test test_hypen_runtime`
//! (cargo builds the binary for the test). Verifies the stdin→action /
//! stdout→state REPL works end-to-end, including a `wasi:http` round-trip
//! through a real TCP server.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

const COUNTER: &str = "tests/fixtures/counter_module.wasm";
const FETCHER: &str = "tests/fixtures/fetcher_module.wasm";
const EFFECTS: &str = "tests/fixtures/effects_module.wasm";

/// The `hypen-runtime` binary under test. Cargo builds it for this test
/// target (both declare `required-features = ["runtime-bin"]`) and hands us
/// its path, so by default the suite drives the binary built from this
/// checkout. Set `HYPEN_RUNTIME_BIN` to run the suite against another build
/// (a release binary, or a private copy when several checkouts share one
/// target dir and would otherwise overwrite each other's `hypen-runtime`).
fn runtime_path() -> PathBuf {
    match std::env::var_os("HYPEN_RUNTIME_BIN") {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(env!("CARGO_BIN_EXE_hypen-runtime")),
    }
}

/// The capability flags a fixture needs in single-module mode, where the
/// runtime grants nothing by default (module-private `local` storage only).
/// Each fixture gets exactly what its component imports — the same grants
/// the `app*/app.json` manifests spell out for `--app`.
fn grants_for(wasm: &str) -> &'static [&'static str] {
    if wasm.contains("ts_counter") {
        // componentize-js links every interface of the world it targets.
        &["--grant-all"]
    } else if wasm.contains("async_counter") {
        &["--grant-storage", "app,cloud", "--grant-http"]
    } else if wasm.contains("go_counter") {
        &[]
    } else if wasm.contains("counter_module") {
        // `sync` pushes state to `hypen:storage/cloud`.
        &["--grant-storage", "cloud"]
    } else if wasm.contains("fetcher") {
        &["--grant-http"]
    } else if wasm.contains("limits") {
        &["--grant-storage", "app"]
    } else {
        &[]
    }
}

// NB: no `--actions` — the runtime discovers actions from the module's
// `actions` export. Every test here therefore exercises that discovery path.
fn run_runtime(wasm: &str, stdin: &str) -> (String, String, i32) {
    let mut child = Command::new(runtime_path())
        .arg(wasm)
        .args(grants_for(wasm))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hypen-runtime");

    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    drop(child.stdin.take());

    let mut stdout = String::new();
    child
        .stdout
        .as_mut()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    let mut stderr = String::new();
    child
        .stderr
        .as_mut()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    let code = child.wait().unwrap().code().unwrap_or(-1);
    (stdout, stderr, code)
}

#[test]
fn runtime_drives_counter_module_via_repl() {
    let (stdout, _stderr, code) = run_runtime(
        COUNTER,
        "increment\nincrement\nincrement\nsync\n",
    );
    assert_eq!(code, 0, "runtime should exit cleanly");
    assert!(stdout.contains(r#"ready: {"count":0}"#));
    assert!(stdout.contains(r#"state: {"count":1}"#));
    assert!(stdout.contains(r#"state: {"count":2}"#));
    assert!(stdout.contains(r#"state: {"count":3}"#));
    // `sync` doesn't change local state.
    assert!(stdout.contains("state: <unchanged>"));
}

#[test]
fn runtime_reports_unknown_action_without_exiting() {
    let (stdout, _stderr, code) = run_runtime(COUNTER, "frobnicate\nincrement\n");
    assert_eq!(code, 0);
    assert!(stdout.contains("error: No handler registered for action: frobnicate"));
    // The runtime kept going and dispatched the next action.
    assert!(stdout.contains(r#"state: {"count":1}"#));
}

#[test]
fn runtime_rejects_invalid_json_payload() {
    let (stdout, _stderr, code) = run_runtime(COUNTER, "increment {not-json}\n");
    assert_eq!(code, 0);
    assert!(
        stdout.contains("error: invalid JSON payload"),
        "stdout was: {stdout}"
    );
}

// ── runtime hosts a module that calls wasi:http via waki ────────────────────

static SERVER_HITS: AtomicUsize = AtomicUsize::new(0);

fn one_shot_http(body: &'static str) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            SERVER_HITS.fetch_add(1, Ordering::SeqCst);
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body,
            );
            let _ = stream.write_all(resp.as_bytes());
        }
    });
    port
}

#[test]
fn runtime_hosts_a_module_that_does_real_http_via_wasi_http() {
    SERVER_HITS.store(0, Ordering::SeqCst);
    let port = one_shot_http(r#"{"greeting":"hello-from-runtime"}"#);
    let stdin = format!(
        "fetch {{\"url\":\"http://127.0.0.1:{port}/\"}}\n",
        port = port,
    );
    let (stdout, _stderr, code) = run_runtime(FETCHER, &stdin);
    assert_eq!(code, 0);
    assert_eq!(SERVER_HITS.load(Ordering::SeqCst), 1, "server saw the request");
    assert!(
        stdout.contains("hello-from-runtime"),
        "expected fetched body in state. stdout was:\n{stdout}"
    );
}

// ── --serve mode: drive the runtime over HTTP ───────────────────────────────

/// Pick a port the kernel says is free. Closing the listener releases it
/// before we hand the number to the child; small race window but adequate
/// for tests on a quiet machine. Failures retry once.
fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

struct Server {
    child: std::process::Child,
    port: u16,
}

impl Server {
    fn start(wasm: &str) -> Self {
        let port = free_port();
        let child = Command::new(runtime_path())
            .arg(wasm)
            .args(grants_for(wasm))
            .arg("--serve")
            .arg(port.to_string())
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn hypen-runtime --serve");

        // Wait up to ~3s for the port to start accepting connections.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if std::net::TcpStream::connect_timeout(
                &format!("127.0.0.1:{port}").parse().unwrap(),
                std::time::Duration::from_millis(100),
            )
            .is_ok()
            {
                break;
            }
            if std::time::Instant::now() > deadline {
                panic!("server didn't accept connections within 3s on port {port}");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        Self { child, port }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Tiny blocking HTTP client built on the stdlib so the test stays dep-free.
/// Adequate for hitting our own runtime over loopback.
fn http_request(
    method: &str,
    url: &str,
    body: Option<&str>,
) -> Result<(u16, String), String> {
    let parsed: url_lite::Parsed = url_lite::parse(url)?;
    let mut stream = std::net::TcpStream::connect((parsed.host.as_str(), parsed.port))
        .map_err(|e| format!("connect: {e}"))?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(3)))
        .ok();

    let body = body.unwrap_or("");
    let req = format!(
        "{method} {} HTTP/1.1\r\n\
         Host: {}:{}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n{body}",
        parsed.path,
        parsed.host,
        parsed.port,
        body.len(),
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("write: {e}"))?;

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("read: {e}"))?;
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = text.split_once("\r\n\r\n").ok_or("no body")?;
    let status_line = head.lines().next().ok_or("no status line")?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .ok_or("status missing")?
        .parse()
        .map_err(|e| format!("status: {e}"))?;
    Ok((status, body.to_string()))
}

/// Hand-rolled tiny URL parser — saves pulling in a `url` crate just for tests.
mod url_lite {
    pub struct Parsed {
        pub host: String,
        pub port: u16,
        pub path: String,
    }
    pub fn parse(s: &str) -> Result<Parsed, String> {
        let s = s.strip_prefix("http://").ok_or("only http:// supported")?;
        let (auth, path) = match s.find('/') {
            Some(i) => (&s[..i], &s[i..]),
            None => (s, "/"),
        };
        let (host, port_str) = auth.split_once(':').ok_or("expected host:port")?;
        Ok(Parsed {
            host: host.to_string(),
            port: port_str.parse().map_err(|e| format!("port: {e}"))?,
            path: path.to_string(),
        })
    }
}

#[test]
fn server_state_endpoint_returns_initial_state() {
    let s = Server::start(COUNTER);
    let (status, body) = http_request("GET", &s.url("/state"), None).unwrap();
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["state"]["count"], 0);
    assert_eq!(v["scope"], "counter_module");
    assert_eq!(v["actions"], serde_json::json!(["increment", "sync"]));
}

#[test]
fn server_dispatch_drives_state_across_requests() {
    let s = Server::start(COUNTER);
    for expected in 1..=3 {
        let (status, body) = http_request(
            "POST",
            &s.url("/dispatch"),
            Some(r#"{"action":"increment"}"#),
        )
        .unwrap();
        assert_eq!(status, 200);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["state"]["count"], expected);
        assert!(v.get("error").map(|e| e.is_null()).unwrap_or(true));
    }
    // GET /state should now show count=3.
    let (_, body) = http_request("GET", &s.url("/state"), None).unwrap();
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["state"]["count"], 3);
}

#[test]
fn server_unknown_action_returns_error_in_envelope() {
    let s = Server::start(COUNTER);
    let (status, body) = http_request(
        "POST",
        &s.url("/dispatch"),
        Some(r#"{"action":"nonexistent"}"#),
    )
    .unwrap();
    // An unknown action is a 404 with a structured error; the envelope still
    // carries the (unchanged) state.
    assert_eq!(status, 404);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["error"]["code"], "action_not_found");
    assert!(v["error"]["message"].as_str().unwrap().contains("nonexistent"));
    assert_eq!(v["state"]["count"], 0);
}

#[test]
fn server_index_returns_html_client() {
    let s = Server::start(COUNTER);
    let (status, body) = http_request("GET", &s.url("/"), None).unwrap();
    assert_eq!(status, 200);
    assert!(body.contains("<!doctype html>"), "expected html. got: {body}");
    assert!(body.contains("dispatch"), "client should reference dispatch action");
}

#[test]
fn server_unknown_route_returns_404() {
    let s = Server::start(COUNTER);
    let (status, _) = http_request("GET", &s.url("/missing"), None).unwrap();
    assert_eq!(status, 404);
}

// ── proof that the WIT contract is language-agnostic ───────────────────────

const TS_COUNTER: &str = "tests/fixtures/ts_counter_module.wasm";

/// The TS-authored counter module — written in plain JS using a
/// `defineModule({initialState, actions: {...}})` API, bundled by esbuild,
/// componentized by jco — runs through the *exact same* hypen-runtime that
/// drives the Rust modules. Same WIT, same engine, no language-specific
/// glue.
#[test]
fn runtime_drives_a_ts_authored_module_end_to_end() {
    let (stdout, _stderr, code) = run_runtime(
        TS_COUNTER,
        "increment\nincrement\nset {\"value\":42}\ndecrement\nreset\n",
    );
    assert_eq!(code, 0, "runtime should exit cleanly");

    // Initial state contains both `count` and `history` — the TS module's
    // own shape; the engine has no idea what's in there.
    assert!(
        stdout.contains(r#"ready: {"count":0,"history":[]}"#),
        "initial state. stdout: {stdout}"
    );

    // After 2 increments, count=2 and history=["inc","inc"].
    assert!(
        stdout.contains(r#"state: {"count":2,"history":["inc","inc"]}"#),
        "after 2 incs. stdout: {stdout}"
    );

    // `set` with a JSON payload {value: 42} reaches the TS handler and
    // updates count to 42.
    assert!(
        stdout.contains(r#""count":42"#),
        "after `set {{value:42}}`. stdout: {stdout}"
    );

    // `decrement` after set: count=41.
    assert!(
        stdout.contains(r#""count":41"#),
        "after decrement. stdout: {stdout}"
    );

    // `reset` clears both fields.
    assert!(
        stdout.contains(r#"state: {"count":0,"history":[]}"#),
        "after reset. stdout: {stdout}"
    );
}

// ── hot reload preserves engine state across module swap ────────────────────

/// Variant of `Server::start` that copies the fixture into a tempdir so we
/// can rewrite the file without disturbing the committed fixture.
fn start_with_writable_wasm() -> (Server, tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dest = tmp.path().join("app.wasm");
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(COUNTER);
    std::fs::copy(&src, &dest).expect("copy fixture");

    let port = free_port();
    let child = Command::new(runtime_path())
        .arg(&dest)
        .args(grants_for(COUNTER))
        .arg("--serve")
        .arg(port.to_string())
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hypen-runtime --serve");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            std::time::Duration::from_millis(100),
        )
        .is_ok()
        {
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!("server didn't accept on port {port}");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    (Server { child, port }, tmp, dest)
}

#[test]
fn hot_reload_preserves_state_across_module_swap() {
    let (server, _tmp, wasm_path) = start_with_writable_wasm();

    // Drive the module up to count=3.
    for expected in 1..=3 {
        let (status, body) = http_request(
            "POST",
            &server.url("/dispatch"),
            Some(r#"{"action":"increment"}"#),
        )
        .unwrap();
        assert_eq!(status, 200);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["state"]["count"], expected);
    }

    // Trigger the watcher by rewriting the file with the same bytes —
    // the host doesn't actually need a *different* module for this test;
    // we just need the OS-level mtime change so the debouncer fires.
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(COUNTER);
    let bytes = std::fs::read(&src).unwrap();
    std::fs::write(&wasm_path, &bytes).unwrap();

    // Debouncer is 200ms; give the reload time to happen end-to-end.
    std::thread::sleep(std::time::Duration::from_millis(800));

    // The engine's state slot must still report count=3 — the new instance
    // didn't reset it via init().
    let (_, body) = http_request("GET", &server.url("/state"), None).unwrap();
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        v["state"]["count"], 3,
        "state should survive hot reload. got: {body}"
    );

    // And dispatching another action through the *new* instance continues
    // from there — proves we're actually talking to the reloaded instance,
    // not a stale closure over the old one.
    let (status, body) = http_request(
        "POST",
        &server.url("/dispatch"),
        Some(r#"{"action":"increment"}"#),
    )
    .unwrap();
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        v["state"]["count"], 4,
        "post-reload dispatch should continue from preserved state. got: {body}"
    );
}

// ── language-agnostic proof: Go counter runs the same way ───────────────────

const GO_COUNTER: &str = "tests/fixtures/go_counter_module.wasm";

/// The Go-authored counter — written in plain Go, compiled by TinyGo
/// against our WIT — produces the same state shape and runs through the
/// same hypen-runtime as the Rust and TS modules. Same WIT contract;
/// engine has no idea what compiled this.
#[test]
fn runtime_drives_a_go_authored_module_end_to_end() {
    let (stdout, _stderr, code) = run_runtime(
        GO_COUNTER,
        "increment\nincrement\nincrement\ndecrement\nreset\n",
    );
    assert_eq!(code, 0, "runtime should exit cleanly");

    // Same `{count, history}` shape as the TS counter — proves the
    // state shape is portable across languages, not just the WIT.
    assert!(
        stdout.contains(r#"ready: {"count":0,"history":[]}"#),
        "initial state. stdout: {stdout}"
    );
    assert!(
        stdout.contains(r#"state: {"count":2,"history":["inc","inc","inc","dec"]}"#),
        "after 3 incs + 1 dec. stdout: {stdout}"
    );
    assert!(
        stdout.contains(r#"state: {"count":0,"history":[]}"#),
        "after reset. stdout: {stdout}"
    );
}

// ── self-describing actions: no --actions flag needed ───────────────────────

/// The runtime discovers the action list from the module's `actions` export.
/// None of the other tests pass `--actions`, so they all already exercise
/// this; here we assert it explicitly via the discovery log + a dispatch.
#[test]
fn runtime_discovers_actions_from_module() {
    let (stdout, stderr, code) = run_runtime(COUNTER, "increment\n");
    assert_eq!(code, 0);
    assert!(
        stderr.contains("discovered from module"),
        "expected discovery log on stderr. stderr was:\n{stderr}"
    );
    assert!(
        stderr.contains("increment") && stderr.contains("sync"),
        "discovery log should name the module's actions. stderr:\n{stderr}"
    );
    // And a discovered action actually routes.
    assert!(stdout.contains(r#"state: {"count":1}"#), "stdout: {stdout}");
}

/// `--actions` still works as an explicit override: passing a subset routes
/// only those, so an unlisted-but-real action is reported as unhandled.
#[test]
fn actions_flag_overrides_discovery() {
    // Force only `increment`; the module also handles `sync`, but the
    // override should keep `sync` unrouted.
    let mut child = Command::new(runtime_path())
        .arg(COUNTER)
        .args(grants_for(COUNTER))
        .arg("--actions")
        .arg("increment")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"increment\nsync\n")
        .unwrap();
    drop(child.stdin.take());
    let mut stdout = String::new();
    child.stdout.as_mut().unwrap().read_to_string(&mut stdout).unwrap();
    let _ = child.wait();

    assert!(stdout.contains(r#"state: {"count":1}"#), "increment should route. stdout: {stdout}");
    assert!(
        stdout.contains("No handler registered for action: sync"),
        "overridden-out `sync` should be unrouted. stdout: {stdout}"
    );
}

// ── declarative UI rendered against a wasm module (--ui) ────────────────────

const COUNTER_UI: &str = "tests/fixtures/counter_ui.hypen";

/// The authoring-model proof (see wit/AUTHORING_MODEL.md): a logic-only wasm
/// module supplies state, a declarative `.hypen` template supplies the UI,
/// and the engine renders + reactively re-renders. `@{state.count}` binds to
/// the wasm module's state; dispatching `increment` produces a minimal
/// SetProp patch on the bound Text node.
#[test]
fn ui_renders_declarative_template_against_wasm_module() {
    let mut child = Command::new(runtime_path())
        .arg(COUNTER)
        .args(grants_for(COUNTER))
        .arg("--scope")
        .arg("counter")
        .arg("--ui")
        .arg(COUNTER_UI)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hypen-runtime --ui");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"increment\nincrement\n")
        .unwrap();
    drop(child.stdin.take());
    let mut stdout = String::new();
    child.stdout.as_mut().unwrap().read_to_string(&mut stdout).unwrap();
    let _ = child.wait();

    // Initial render: the declarative Text bound to @{state.count} shows the
    // wasm module's initial count, and a Button + Column are created.
    assert!(stdout.contains("ui: "), "should print the initial UI tree. stdout:\n{stdout}");
    assert!(
        stdout.contains("Count: 0"),
        "initial render binds @{{state.count}} to wasm state. stdout:\n{stdout}"
    );
    assert!(
        stdout.contains("\"elementType\": \"Button\"") || stdout.contains("\"elementType\":\"Button\""),
        "declarative Button should render. stdout:\n{stdout}"
    );

    // Each increment drives the wasm reducer; the reactive re-render emits a
    // minimal SetProp updating only the bound Text node.
    assert!(
        stdout.contains(r#""value":"Count: 1""#),
        "first increment → SetProp Count: 1. stdout:\n{stdout}"
    );
    assert!(
        stdout.contains(r#""value":"Count: 2""#),
        "second increment → SetProp Count: 2. stdout:\n{stdout}"
    );
    // And it's a SetProp (minimal patch), not a full re-create.
    assert!(
        stdout.contains(r#""type":"setProp""#),
        "re-render should be a minimal SetProp. stdout:\n{stdout}"
    );
}

// ── --serve + --ui: rendered patches over HTTP (the DOM client's contract) ──

const COUNTER_UI_2: &str = "tests/fixtures/counter_ui.hypen";

/// Spawn the runtime in --serve --ui mode under scope "counter". Returns the
/// Server guard. (Server::start doesn't take --ui/--scope, so we spawn here.)
fn start_serve_ui() -> Server {
    let port = free_port();
    let child = Command::new(runtime_path())
        .arg(COUNTER)
        .args(grants_for(COUNTER))
        .arg("--scope")
        .arg("counter")
        .arg("--ui")
        .arg(COUNTER_UI_2)
        .arg("--serve")
        .arg(port.to_string())
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hypen-runtime --serve --ui");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            std::time::Duration::from_millis(100),
        )
        .is_ok()
        {
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!("serve+ui didn't accept on port {port}");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Server { child, port }
}

#[test]
fn serve_ui_exposes_initial_tree_and_dispatch_delta() {
    let s = start_serve_ui();

    // GET /patches returns the initial render tree (Column/Text/Button…).
    let (status, body) = http_request("GET", &s.url("/patches"), None).unwrap();
    assert_eq!(status, 200);
    let tree: serde_json::Value = serde_json::from_str(&body).unwrap();
    let arr = tree.as_array().expect("patches array");
    assert!(!arr.is_empty(), "initial tree should be non-empty");
    assert!(
        body.contains("\"Count: 0\"") || body.contains("Count: 0"),
        "initial tree binds @{{state.count}} = 0. body: {body}"
    );
    assert!(body.contains("Button"), "tree includes the declarative Button");

    // POST /dispatch returns the *delta* (a minimal SetProp), not the whole
    // tree — that's what the DOM client applies incrementally.
    let (status, body) =
        http_request("POST", &s.url("/dispatch"), Some(r#"{"action":"increment"}"#)).unwrap();
    assert_eq!(status, 200);
    let resp: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(resp["state"]["count"], 1);
    let delta = resp["patches"].as_array().expect("patches delta");
    assert_eq!(delta.len(), 1, "one SetProp, not a re-create. delta: {delta:?}");
    assert_eq!(delta[0]["type"], "setProp");
    assert_eq!(delta[0]["value"], "Count: 1");
}

// ── multi-module app: entry template references a nested module (--app) ──────

const APP_MANIFEST: &str = "tests/fixtures/app/app.json";

/// Spawn the runtime in `--serve --app` mode. Returns the Server guard.
fn start_serve_app() -> Server {
    let port = free_port();
    let child = Command::new(runtime_path())
        .arg("--app")
        .arg(APP_MANIFEST)
        .arg("--serve")
        .arg(port.to_string())
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hypen-runtime --serve --app");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            std::time::Duration::from_millis(100),
        )
        .is_ok()
        {
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!("serve+app didn't accept on port {port}");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Server { child, port }
}

/// The renderer path for per-scope routing: a UI dispatch carries the
/// `sender` node id of the clicked element, and the engine maps it back to
/// that node's module scope. The composed App tree has exactly one Button —
/// the nested Counter's — so dispatching `increment` from it must advance the
/// **Counter** scope, never the entry App, even though both export `increment`.
#[test]
fn serve_app_routes_dispatch_by_sender_node_scope() {
    let s = start_serve_app();

    // The initial composed tree includes the Counter's Button. Find its node id.
    let (status, body) = http_request("GET", &s.url("/patches"), None).unwrap();
    assert_eq!(status, 200);
    let tree: serde_json::Value = serde_json::from_str(&body).unwrap();
    let button_id = tree
        .as_array()
        .expect("patches array")
        .iter()
        .find(|p| p["type"] == "create" && p["elementType"] == "Button")
        .and_then(|p| p["id"].as_str())
        .expect("composed tree has a Button (the Counter's)")
        .to_string();

    // Dispatch carrying the Button's node id as `sender`. No `scope:` qualifier
    // — the engine resolves the scope from the node itself.
    let req = serde_json::json!({ "action": "increment", "sender": button_id }).to_string();
    let (status, body) = http_request("POST", &s.url("/dispatch"), Some(&req)).unwrap();
    assert_eq!(status, 200);
    let resp: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(
        resp.get("error").map(|e| e.is_null()).unwrap_or(true),
        "sender-routed dispatch should not error. resp: {resp}"
    );

    // The /dispatch envelope reports the entry (App) scope — which is UNTOUCHED
    // because the sender resolved to the Counter scope.
    assert_eq!(
        resp["state"]["count"], 0,
        "entry App scope unchanged; the Button belongs to Counter. resp: {resp}"
    );
    // The re-render delta is the Counter-scoped Text advancing to 1.
    let delta = resp["patches"].as_array().expect("patches delta");
    assert!(
        delta
            .iter()
            .any(|p| p["type"] == "setProp" && p["value"] == "Counter scope count: 1"),
        "sender routed to the Counter instance; its bound Text advanced. delta: {delta:?}"
    );
}

/// A root `App` module whose template references `Counter()` — a separate
/// module (separate .wasm + .hypen) — renders both, each bound to its OWN
/// state scope. This is the `App { FirstModule() … }` composition pattern.
#[test]
fn app_composes_a_nested_module_with_its_own_scope() {
    let mut child = Command::new(runtime_path())
        .arg("--app")
        .arg(APP_MANIFEST)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hypen-runtime --app");
    child.stdin.as_mut().unwrap().write_all(b"increment\n").unwrap();
    drop(child.stdin.take());
    let mut stdout = String::new();
    child.stdout.as_mut().unwrap().read_to_string(&mut stdout).unwrap();
    let mut stderr = String::new();
    child.stderr.as_mut().unwrap().read_to_string(&mut stderr).unwrap();
    let _ = child.wait();

    assert!(stderr.contains("loaded 2 instance(s)"), "stderr: {stderr}");

    // Initial render composes BOTH scopes: the entry App and the nested
    // Counter it references, each with its own count.
    assert!(
        stdout.contains("App scope count: 0"),
        "entry module renders its own scope. stdout:\n{stdout}"
    );
    assert!(
        stdout.contains("Counter scope count: 0"),
        "nested module (referenced via Counter()) renders, scoped to ITS state. stdout:\n{stdout}"
    );

    // Both `App` and `Counter` reuse the same counter.wasm, so BOTH export an
    // `increment` action. A bare `increment` is therefore ambiguous and the
    // engine refuses it rather than guessing — the operator must say which
    // scope they mean.
    assert!(
        stdout.contains("handled by more than one module")
            && stdout.contains("`app:increment`, `counter:increment`"),
        "bare ambiguous action is rejected with guidance. stdout:\n{stdout}"
    );
}

/// Per-scope action routing: two modules sharing an action name (`increment`)
/// each advance INDEPENDENTLY when the action is qualified with its scope.
/// This is the fix for the cross-module action-name collision — routing is
/// keyed by (scope, action), not by bare action name.
#[test]
fn qualified_actions_route_to_their_own_module_scope() {
    let mut child = Command::new(runtime_path())
        .arg("--app")
        .arg(APP_MANIFEST)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hypen-runtime --app");
    // Counter twice, App once. If routing collided, the two scopes would move
    // together; instead each tracks its own count.
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"Counter:increment\nCounter:increment\nApp:increment\n")
        .unwrap();
    drop(child.stdin.take());
    let mut stdout = String::new();
    child.stdout.as_mut().unwrap().read_to_string(&mut stdout).unwrap();
    let _ = child.wait();

    // The nested Counter's bound Text advanced through 1 → 2 (two dispatches),
    // each a minimal SetProp on the Counter-scoped node.
    assert!(
        stdout.contains(r#""value":"Counter scope count: 1""#),
        "Counter:increment #1 advances the counter scope. stdout:\n{stdout}"
    );
    assert!(
        stdout.contains(r#""value":"Counter scope count: 2""#),
        "Counter:increment #2 advances the counter scope again. stdout:\n{stdout}"
    );
    // The entry App advanced exactly once — to 1, never to 2 — proving its
    // `increment` is a different instance from Counter's.
    assert!(
        stdout.contains(r#""value":"App scope count: 1""#),
        "App:increment advances the app scope. stdout:\n{stdout}"
    );
    assert!(
        !stdout.contains(r#""value":"App scope count: 2""#),
        "App was incremented once, not twice — scopes are independent. stdout:\n{stdout}"
    );
}

const APP_STATELESS_MANIFEST: &str = "tests/fixtures/app_stateless/app.json";

/// A stateful `Shell` entry references a **stateless** `Banner()` — a
/// template-only component (no wasm, no state, no actions). The manifest
/// entry for it omits `wasm`; the runtime registers its `.hypen` with the
/// component resolver so the entry can compose it by name, but creates no
/// module instance. The Shell's own logic still drives reactively.
#[test]
fn app_renders_a_stateless_component_with_no_wasm() {
    let mut child = Command::new(runtime_path())
        .arg("--app")
        .arg(APP_STATELESS_MANIFEST)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hypen-runtime --app");
    child.stdin.as_mut().unwrap().write_all(b"increment\n").unwrap();
    drop(child.stdin.take());
    let mut stdout = String::new();
    child.stdout.as_mut().unwrap().read_to_string(&mut stdout).unwrap();
    let mut stderr = String::new();
    child.stderr.as_mut().unwrap().read_to_string(&mut stderr).unwrap();
    let _ = child.wait();

    // One stateful module (Shell) → one instance + one stateless component (Banner).
    assert!(
        stderr.contains("1 instance(s)") && stderr.contains("1 stateless component(s)"),
        "loader distinguishes stateful from stateless. stderr: {stderr}"
    );

    // The stateless Banner's static text renders inline in the Shell tree.
    assert!(
        stdout.contains("Static Banner"),
        "stateless component renders by reference. stdout:\n{stdout}"
    );
    // The Shell's own reactive binding renders and advances on dispatch.
    assert!(
        stdout.contains("Count: 0"),
        "entry module renders its bound state. stdout:\n{stdout}"
    );
    assert!(
        stdout.contains(r#""value":"Count: 1""#),
        "dispatching the stateful entry's action re-renders it. stdout:\n{stdout}"
    );
}

// ── --app gap closers: full /state envelope + multi-module hot reload ────────

/// `GET /state` in `--app` mode exposes **every** module scope under `states`,
/// not just the entry — so a client can inspect sibling-module state.
#[test]
fn serve_app_state_reports_all_scopes() {
    let s = start_serve_app();
    let (status, body) = http_request("GET", &s.url("/state"), None).unwrap();
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();

    // The app fixture composes an `App` entry + a nested `Counter`.
    let states = v["states"].as_object().expect("states map");
    assert!(states.contains_key("app"), "entry scope present. body: {body}");
    assert!(states.contains_key("counter"), "sibling scope present. body: {body}");
    assert_eq!(states["counter"]["count"], 0);
    // Back-compat: `state` still carries the entry scope.
    assert_eq!(v["scope"], "app");
}

/// Spawn `--serve --app` over a *writable* self-contained app in a tempdir
/// (so we can rewrite a module `.wasm` to trigger hot reload). Both `App` and
/// `Counter` are backed by the same counter wasm — reloading it must refresh
/// both scopes.
fn start_serve_app_writable() -> (Server, tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let wasm = tmp.path().join("counter.wasm");
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(COUNTER);
    std::fs::copy(&src, &wasm).expect("copy wasm");
    std::fs::write(
        tmp.path().join("app.hypen"),
        "module App {\n Column {\n  Text(\"App scope count: @{state.count}\")\n  Counter()\n }\n}\n",
    )
    .unwrap();
    std::fs::write(
        tmp.path().join("counter.hypen"),
        "module Counter {\n Column {\n  Text(\"Counter scope count: @{state.count}\")\n  Button(\"@actions.increment\") { Text(\"+1\") }\n }\n}\n",
    )
    .unwrap();
    std::fs::write(
        tmp.path().join("app.json"),
        r#"{ "entry": "App", "modules": [
            { "name": "App", "wasm": "counter.wasm", "ui": "app.hypen", "storage": ["cloud"] },
            { "name": "Counter", "wasm": "counter.wasm", "ui": "counter.hypen", "storage": ["cloud"] }
        ] }"#,
    )
    .unwrap();

    let port = free_port();
    let child = Command::new(runtime_path())
        .arg("--app")
        .arg(tmp.path().join("app.json"))
        .arg("--serve")
        .arg(port.to_string())
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hypen-runtime --serve --app");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            std::time::Duration::from_millis(100),
        )
        .is_ok()
        {
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!("serve+app didn't accept on port {port}");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    (Server { child, port }, tmp, wasm)
}

/// Hot reload works in `--app` mode: rewriting a module's `.wasm` swaps the
/// instance while preserving engine state. Because both scopes share the file,
/// both reload — and both keep their state.
#[test]
fn app_hot_reload_preserves_state() {
    let (server, _tmp, wasm) = start_serve_app_writable();

    // Advance the Counter scope to 2 (sender-less qualified dispatch).
    for expected in 1..=2 {
        let (status, body) = http_request(
            "POST",
            &server.url("/dispatch"),
            Some(r#"{"action":"Counter:increment"}"#),
        )
        .unwrap();
        assert_eq!(status, 200, "dispatch failed: {body}");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["states"]["counter"]["count"], expected, "body: {body}");
    }

    // Rewrite the shared wasm (same bytes) → mtime change fires the watcher,
    // reloading both App and Counter.
    let bytes = std::fs::read(&wasm).unwrap();
    std::fs::write(&wasm, &bytes).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(900));

    // State survived the swap.
    let (_, body) = http_request("GET", &server.url("/state"), None).unwrap();
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        v["states"]["counter"]["count"], 2,
        "counter state must survive --app hot reload. body: {body}"
    );

    // Dispatching through the reloaded instance continues from preserved state.
    let (status, body) = http_request(
        "POST",
        &server.url("/dispatch"),
        Some(r#"{"action":"Counter:increment"}"#),
    )
    .unwrap();
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        v["states"]["counter"]["count"], 3,
        "post-reload dispatch continues from preserved state. body: {body}"
    );
}

// ── engine-native effects: Navigate + Delay ─────────────────────────────────

/// A reducer that emits `Navigate` has the path surfaced in the /dispatch
/// response (the host's effect handler collects it) — no longer warn-dropped.
#[test]
fn navigate_effect_is_surfaced_in_dispatch_response() {
    let s = Server::start(EFFECTS);
    let (status, body) =
        http_request("POST", &s.url("/dispatch"), Some(r#"{"action":"go"}"#)).unwrap();
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        v["navigate"],
        serde_json::json!(["/next"]),
        "Navigate effect should surface the path. body: {body}"
    );
}

/// A reducer that emits `Delay { ms, then }` gets the host to re-dispatch
/// `then` after the delay — the debounce/retry primitive. The immediate
/// response shows no change; the state advances once the timer fires.
#[test]
fn delay_effect_reschedules_the_then_action() {
    let s = Server::start(EFFECTS);

    // `debounce` schedules `tick` in 120ms; the immediate response is unchanged.
    let (status, body) =
        http_request("POST", &s.url("/dispatch"), Some(r#"{"action":"debounce"}"#)).unwrap();
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["state"]["count"], 0, "delay must not fire synchronously. body: {body}");

    // Before the timer fires, state is still 0.
    std::thread::sleep(std::time::Duration::from_millis(40));
    let (_, body) = http_request("GET", &s.url("/state"), None).unwrap();
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["state"]["count"], 0, "should not have fired yet. body: {body}");

    // After the delay elapses, the host re-dispatched `tick` → count == 1.
    std::thread::sleep(std::time::Duration::from_millis(250));
    let (_, body) = http_request("GET", &s.url("/state"), None).unwrap();
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["state"]["count"], 1, "delayed tick should have fired. body: {body}");
}

// ── --app manifest-driven capabilities (real ACLs from app.json) ────────────

const APP_ACL_MANIFEST: &str = "tests/fixtures/app_acl/app.json";
const APP_ACL_DENIED_MANIFEST: &str = "tests/fixtures/app_acl/app_denied.json";

/// Spawn `--serve --app` for an arbitrary manifest path. Returns the Server.
fn start_serve_app_with(manifest: &str) -> Server {
    let port = free_port();
    let child = Command::new(runtime_path())
        .arg("--app")
        .arg(manifest)
        .arg("--serve")
        .arg(port.to_string())
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hypen-runtime --serve --app");
    // 10s (not 3s): under the full suite several `--app` runtimes boot in
    // parallel, each instantiating multiple modules + wasmtime, so a tight
    // deadline flakes on a loaded machine.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            std::time::Duration::from_millis(100),
        )
        .is_ok()
        {
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!("serve+app didn't accept on port {port}");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Server { child, port }
}

/// Manifest-driven capabilities in `--app`: a `Mirror` module granted
/// `reads: ["counter"]` in app.json can cross-module READ the counter's state
/// and SUBSCRIBE to it — proving the runtime wires real ACLs from the manifest,
/// not the old grant-all default (empty reads/dispatches, which silently denied
/// this).
#[test]
fn serve_app_grants_manifest_scoped_read_and_subscribe() {
    let s = start_serve_app_with(APP_ACL_MANIFEST);

    // Advance the counter to 2.
    for expected in 1..=2 {
        let (status, body) = http_request(
            "POST",
            &s.url("/dispatch"),
            Some(r#"{"action":"Counter:increment"}"#),
        )
        .unwrap();
        assert_eq!(status, 200, "counter dispatch failed: {body}");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["states"]["counter"]["count"], expected, "body: {body}");
    }

    // Cross-module READ: Mirror:pull snapshots counter.count into `seen`.
    let (status, body) =
        http_request("POST", &s.url("/dispatch"), Some(r#"{"action":"Mirror:pull"}"#)).unwrap();
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(
        v.get("error").map(|e| e.is_null()).unwrap_or(true),
        "granted cross-module read must not error. body: {body}"
    );
    assert_eq!(
        v["states"]["mirror"]["seen"], 2,
        "Mirror read the counter's count via its manifest `reads` grant. body: {body}"
    );

    // Cross-module SUBSCRIBE: Mirror:watch observes counter.count; a further
    // increment auto-re-dispatches Mirror's `pull`.
    let (status, body) =
        http_request("POST", &s.url("/dispatch"), Some(r#"{"action":"Mirror:watch"}"#)).unwrap();
    assert_eq!(status, 200, "watch dispatch failed: {body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(
        v.get("error").map(|e| e.is_null()).unwrap_or(true),
        "granted subscribe must not error. body: {body}"
    );

    let (status, body) = http_request(
        "POST",
        &s.url("/dispatch"),
        Some(r#"{"action":"Counter:increment"}"#),
    )
    .unwrap();
    assert_eq!(status, 200, "body: {body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["states"]["counter"]["count"], 3, "body: {body}");
    assert_eq!(
        v["states"]["mirror"]["seen"], 3,
        "subscription fired on the sibling change; Mirror tracked the counter. body: {body}"
    );
}

/// Without the `reads` grant (Mirror omits it → the all()-equivalent back-compat
/// default = no cross-module access), the SAME Mirror module's `pull` is denied
/// by the host. The permission error surfaces in the /dispatch envelope.
#[test]
fn serve_app_denies_cross_module_read_without_grant() {
    let s = start_serve_app_with(APP_ACL_DENIED_MANIFEST);

    let (status, body) =
        http_request("POST", &s.url("/dispatch"), Some(r#"{"action":"Mirror:pull"}"#)).unwrap();
    // A module failure is a 500 with a structured error; the envelope still
    // carries every scope's state.
    assert_eq!(status, 500);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["error"]["code"], "module_error");
    let err = v["error"]["message"].as_str().unwrap_or("");
    assert!(
        err.contains("PermissionDenied") || err.to_lowercase().contains("permission"),
        "ungranted cross-module read must be denied. body: {body}"
    );
    assert_eq!(
        v["states"]["mirror"]["seen"], 0,
        "denied read leaves Mirror untouched. body: {body}"
    );
}

// ── config-seeded init: declaration-site `module X(args)` seeds init(config) ─

const SEEDED: &str = "tests/fixtures/seeded_module.wasm";

/// Declaration-site module args seed `init(config)`: a `.hypen` whose root is
/// `module Seeded(start: 7)` makes the runtime call the module's `init` with
/// `{"start":7}`, so the initial state is `{"count":7}` rather than the default
/// `{"count":0}`. Proves config flows parser → runtime → wasm `init`.
#[test]
fn config_seeds_init_from_module_declaration_args() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let ui = tmp.path().join("seeded.hypen");
    std::fs::write(
        &ui,
        "module Seeded(start: 7) {\n Text(\"count is @{state.count}\")\n}\n",
    )
    .unwrap();
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(SEEDED);

    let port = free_port();
    let child = Command::new(runtime_path())
        .arg(&wasm)
        .arg("--scope")
        .arg("seeded")
        .arg("--ui")
        .arg(&ui)
        .arg("--serve")
        .arg(port.to_string())
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hypen-runtime --serve --ui (seeded)");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            std::time::Duration::from_millis(100),
        )
        .is_ok()
        {
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!("serve+ui (seeded) didn't accept on port {port}");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let server = Server { child, port };

    // GET /state: the module's init decoded `{"start":7}` → count seeded to 7.
    let (status, body) = http_request("GET", &server.url("/state"), None).unwrap();
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        v["state"]["count"], 7,
        "declaration-site `module Seeded(start: 7)` should seed init(config) → count 7. body: {body}"
    );

    // `tmp` (and the .hypen inside it) is kept alive by staying in scope until
    // here — the runtime reads the template at boot.
}

/// Usage-site config: a parent's `Counter(start: 5)` reference seeds the counter
/// module's `init`, overriding its declaration-site default. One shared instance
/// per scope, so a single reference is authoritative — this is the tractable
/// single-instance slice (distinct per-usage instances stay deferred).
#[test]
fn usage_site_config_seeds_referenced_module_init() {
    let tmp = tempfile::tempdir().expect("tempdir");
    // Both App and Counter are backed by the seeded module — its `init` reads
    // the single config int into `count`.
    let seeded = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(SEEDED);
    std::fs::copy(&seeded, tmp.path().join("app.wasm")).unwrap();
    std::fs::copy(&seeded, tmp.path().join("counter.wasm")).unwrap();
    // App references Counter with a usage-site arg; Counter's own root has none.
    std::fs::write(
        tmp.path().join("app.hypen"),
        "module App {\n Column {\n  Text(\"App: @{state.count}\")\n  Counter(start: 5)\n }\n}\n",
    )
    .unwrap();
    std::fs::write(
        tmp.path().join("counter.hypen"),
        "module Counter {\n Text(\"Count: @{state.count}\")\n}\n",
    )
    .unwrap();
    std::fs::write(
        tmp.path().join("app.json"),
        r#"{ "entry": "App", "modules": [
            { "name": "App", "wasm": "app.wasm", "ui": "app.hypen" },
            { "name": "Counter", "wasm": "counter.wasm", "ui": "counter.hypen" }
        ] }"#,
    )
    .unwrap();

    let manifest = tmp.path().join("app.json");
    let server = start_serve_app_with(manifest.to_str().unwrap());

    let (status, body) = http_request("GET", &server.url("/state"), None).unwrap();
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    // Counter seeded from the usage-site `start: 5`; App (entry, no usage site,
    // no declaration args) stays at the module's default 0.
    assert_eq!(
        v["states"]["counter"]["count"], 5,
        "usage-site `Counter(start: 5)` should seed the counter. body: {body}"
    );
    assert_eq!(
        v["states"]["app"]["count"], 0,
        "entry App has no usage-site config → default 0. body: {body}"
    );
}

/// Per-usage config: two `Counter(...)` references with *different* args in one
/// template get two independent instances at distinct scopes. The first distinct
/// config keeps the base scope `counter`; the second gets a synthetic
/// `counter__a`. Incrementing one leaves the other untouched.
#[test]
fn per_usage_configs_instantiate_distinct_module_instances() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let seeded = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(SEEDED);
    std::fs::copy(&seeded, tmp.path().join("app.wasm")).unwrap();
    std::fs::copy(&seeded, tmp.path().join("counter.wasm")).unwrap();
    std::fs::write(
        tmp.path().join("app.hypen"),
        "module App {\n Column {\n  Counter(start: 5)\n  Counter(start: 9)\n }\n}\n",
    )
    .unwrap();
    std::fs::write(
        tmp.path().join("counter.hypen"),
        "module Counter {\n Text(\"Count: @{state.count}\")\n}\n",
    )
    .unwrap();
    std::fs::write(
        tmp.path().join("app.json"),
        r#"{ "entry": "App", "modules": [
            { "name": "App", "wasm": "app.wasm", "ui": "app.hypen" },
            { "name": "Counter", "wasm": "counter.wasm", "ui": "counter.hypen" }
        ] }"#,
    )
    .unwrap();

    let manifest = tmp.path().join("app.json");
    let server = start_serve_app_with(manifest.to_str().unwrap());

    let (status, body) = http_request("GET", &server.url("/state"), None).unwrap();
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    // Two distinct configs → two instances: the first at the base scope, the
    // second at a synthetic scope.
    assert_eq!(
        v["states"]["counter"]["count"], 5,
        "first Counter(start: 5) → base scope `counter`. body: {body}"
    );
    assert_eq!(
        v["states"]["counter__a"]["count"], 9,
        "second Counter(start: 9) → synthetic scope `counter__a`. body: {body}"
    );

    // Independence: incrementing the base instance leaves the synthetic one at 9.
    let (status, body) = http_request(
        "POST",
        &server.url("/dispatch"),
        Some(r#"{"action":"Counter:increment"}"#),
    )
    .unwrap();
    assert_eq!(status, 200, "dispatch failed: {body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["states"]["counter"]["count"], 6, "body: {body}");
    assert_eq!(
        v["states"]["counter__a"]["count"], 9,
        "the sibling instance is independent. body: {body}"
    );
}

/// Per-usage `key:` disambiguator: two `Counter(...)` references with an
/// *identical* config but different `key:` args get two independent instances.
/// Without a `key:`, content-addressing would collapse them into one shared
/// instance; the `key:` forces them apart. `key` is a scope disambiguator, not
/// module state, so it is stripped from the config passed to `init` — both
/// instances seed `count` from `start: 5` alone.
#[test]
fn per_usage_key_disambiguates_identical_config_instances() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let seeded = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(SEEDED);
    std::fs::copy(&seeded, tmp.path().join("app.wasm")).unwrap();
    std::fs::copy(&seeded, tmp.path().join("counter.wasm")).unwrap();
    // Same config (start: 5) on both references, distinguished only by key.
    std::fs::write(
        tmp.path().join("app.hypen"),
        "module App {\n Column {\n  Counter(start: 5, key: \"a\")\n  Counter(start: 5, key: \"b\")\n }\n}\n",
    )
    .unwrap();
    std::fs::write(
        tmp.path().join("counter.hypen"),
        "module Counter {\n Text(\"Count: @{state.count}\")\n}\n",
    )
    .unwrap();
    std::fs::write(
        tmp.path().join("app.json"),
        r#"{ "entry": "App", "modules": [
            { "name": "App", "wasm": "app.wasm", "ui": "app.hypen" },
            { "name": "Counter", "wasm": "counter.wasm", "ui": "counter.hypen" }
        ] }"#,
    )
    .unwrap();

    let manifest = tmp.path().join("app.json");
    let server = start_serve_app_with(manifest.to_str().unwrap());

    let (status, body) = http_request("GET", &server.url("/state"), None).unwrap();
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    // Distinct `key:` → two instances despite identical config: the first at the
    // base scope, the second at a synthetic scope. Both seed from `start: 5`
    // (the `key:` arg is stripped from the init config).
    assert_eq!(
        v["states"]["counter"]["count"], 5,
        "first Counter(start: 5, key: \"a\") → base scope `counter`, seeded 5. body: {body}"
    );
    assert_eq!(
        v["states"]["counter__a"]["count"], 5,
        "second Counter(start: 5, key: \"b\") → synthetic scope `counter__a`, seeded 5. body: {body}"
    );

    // Independence: incrementing the base instance leaves the synthetic one at 5.
    let (status, body) = http_request(
        "POST",
        &server.url("/dispatch"),
        Some(r#"{"action":"Counter:increment"}"#),
    )
    .unwrap();
    assert_eq!(status, 200, "dispatch failed: {body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["states"]["counter"]["count"], 6, "body: {body}");
    assert_eq!(
        v["states"]["counter__a"]["count"], 5,
        "the sibling keyed instance is independent. body: {body}"
    );
}

// ── UI (.hypen) hot reload: editing a template re-renders server-side ────────

/// Editing a module's `.hypen` template while `--serve --app` is running
/// re-renders the entry server-side: on the file change the watcher rewrites
/// the shared UI source, the engine clears its resolved-component cache,
/// re-parses the entry, and reconciles — appending the new patches to the log
/// that `GET /patches` returns. There is no push channel, so a browser client
/// must refresh to re-GET `/patches`; but the server tree is correct and
/// observable here.
#[test]
fn ui_hot_reload_rerenders_entry_template_server_side() {
    let (server, tmp, _wasm) = start_serve_app_writable();
    let app_hypen = tmp.path().join("app.hypen");

    // Initial tree: the entry `App` template, without the added Text yet.
    let (status, body) = http_request("GET", &server.url("/patches"), None).unwrap();
    assert_eq!(status, 200);
    let tree: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(
        !tree.as_array().expect("patches array").is_empty(),
        "initial tree should be non-empty. body: {body}"
    );
    assert!(
        !body.contains("Hot reloaded text"),
        "added Text must not be present before the edit. body: {body}"
    );

    // Edit app.hypen: add a static Text node inside the Column. Rewriting in
    // place (same inode) fires the file watcher, same as the wasm reload tests.
    std::fs::write(
        &app_hypen,
        "module App {\n Column {\n  Text(\"App scope count: @{state.count}\")\n  Text(\"Hot reloaded text\")\n  Counter()\n }\n}\n",
    )
    .unwrap();

    // Debounce is 200ms; give the watcher time to re-parse + re-render.
    std::thread::sleep(std::time::Duration::from_millis(900));

    // GET /patches again: the accumulated log now includes the re-render, so
    // the added Text is present in the server tree.
    let (status, body) = http_request("GET", &server.url("/patches"), None).unwrap();
    assert_eq!(status, 200);
    let tree: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(
        !tree.as_array().expect("patches array").is_empty(),
        "tree should remain non-empty after reload. body: {body}"
    );
    assert!(
        body.contains("Hot reloaded text"),
        "server-side re-render must contain the added Text. body: {body}"
    );
}

/// The `.hypen` hot reload also *pushes* the re-render to connected browsers
/// over Server-Sent Events (`GET /events`): after a template edit the server
/// streams the reconcile delta as a `data:` frame, so a live client updates
/// without re-polling. Here we open a raw SSE connection, edit app.hypen, and
/// read the pushed frame containing the added Text.
#[test]
fn ui_hot_reload_pushes_rerender_over_sse() {
    let (server, tmp, _wasm) = start_serve_app_writable();
    let app_hypen = tmp.path().join("app.hypen");

    // Open the SSE stream on a raw socket — `http_request` reads to EOF, which
    // never returns for a long-lived event stream.
    let mut sse = std::net::TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    sse.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
    let handshake = format!(
        "GET /events HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: keep-alive\r\n\r\n",
        server.port
    );
    sse.write_all(handshake.as_bytes()).unwrap();

    // Read the response headers + the `: connected` kickoff, which is written
    // only after the subscriber is registered — so once we see it, a subsequent
    // broadcast is guaranteed to reach this socket.
    let mut buf = [0u8; 4096];
    let mut acc = String::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !acc.contains(": connected") {
        let n = sse.read(&mut buf).expect("read SSE handshake");
        if n == 0 {
            break;
        }
        acc.push_str(&String::from_utf8_lossy(&buf[..n]));
        if std::time::Instant::now() > deadline {
            panic!("no SSE handshake. got: {acc}");
        }
    }
    assert!(acc.contains("text/event-stream"), "SSE content-type. got: {acc}");

    // Edit app.hypen: add a static Text; the watcher (200ms debounce) re-renders
    // and broadcasts the reconcile delta to our SSE socket.
    std::fs::write(
        &app_hypen,
        "module App {\n Column {\n  Text(\"App scope count: @{state.count}\")\n  Text(\"Live pushed text\")\n  Counter()\n }\n}\n",
    )
    .unwrap();

    // Read frames until the pushed delta carrying the new Text arrives.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !acc.contains("Live pushed text") {
        match sse.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => acc.push_str(&String::from_utf8_lossy(&buf[..n])),
            Err(_) => {} // read-timeout tick; the deadline check below drives exit
        }
        if std::time::Instant::now() > deadline {
            panic!("SSE never pushed the hot-reload delta. accumulated: {acc}");
        }
    }
    assert!(
        acc.contains("data:") && acc.contains("Live pushed text"),
        "expected an SSE data frame with the added Text. got: {acc}"
    );
}

// ── CM-async (hypen:module@0.2.0) modules on the same runtime ────────────────
//
// The runtime's DualHost sniffs each component's ABI and routes it to the
// matching native host, so v0.2 async modules boot through the exact same
// binary, REPL, and --app paths as v0.1 — including mixed apps.

const ASYNC_COUNTER: &str = "tests/fixtures/async_counter_module.wasm";

#[test]
fn runtime_drives_async_v02_module_via_repl() {
    let (stdout, stderr, code) = run_runtime(ASYNC_COUNTER, "increment\nincrement\nsync\n");
    assert_eq!(code, 0, "runtime should exit cleanly. stderr: {stderr}");
    // Discovery of the sync `actions` export via the concurrent call path.
    assert!(
        stderr.contains("increment"),
        "actions discovered from the async module: {stderr}"
    );
    // init awaited a storage warm-start; dispatches awaited set + read-back.
    assert!(stdout.contains(r#"ready: {"count":0}"#), "stdout: {stdout}");
    assert!(stdout.contains(r#"state: {"count":1}"#), "stdout: {stdout}");
    assert!(stdout.contains(r#"state: {"count":2}"#), "stdout: {stdout}");
    // `sync` pushes to cloud via awaited compare-and-set; no local delta.
    assert!(stdout.contains("state: <unchanged>"), "stdout: {stdout}");
}

/// One --app boot hosting BOTH ABIs: the v0.1 sync counter as the entry and
/// the v0.2 CM-async counter nested inside it. DualHost routes each to its
/// native host; scope-qualified dispatches advance each independently, and
/// the async module's awaited storage round-trip re-renders its bound Text.
#[test]
fn app_mixes_v01_and_v02_modules_in_one_boot() {
    let mut child = Command::new(runtime_path())
        .arg("--app")
        .arg("tests/fixtures/app_async/app.json")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hypen-runtime --app (mixed ABIs)");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"AsyncCounter:increment\nAsyncCounter:increment\nApp:increment\n")
        .unwrap();
    drop(child.stdin.take());
    let mut stdout = String::new();
    child.stdout.as_mut().unwrap().read_to_string(&mut stdout).unwrap();
    let mut stderr = String::new();
    child.stderr.as_mut().unwrap().read_to_string(&mut stderr).unwrap();
    let code = child.wait().unwrap().code().unwrap_or(-1);
    assert_eq!(code, 0, "mixed-ABI app should boot + exit cleanly. stderr:\n{stderr}");

    // The async module advanced 1 → 2, each dispatch suspending on its
    // awaited storage set + read-back before the delta re-rendered its Text.
    assert!(
        stdout.contains(r#""value":"Async scope count: 1""#),
        "async increment #1 re-rendered. stdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(
        stdout.contains(r#""value":"Async scope count: 2""#),
        "async increment #2 re-rendered. stdout:\n{stdout}"
    );
    // The v0.1 entry advanced exactly once — scopes stay independent across
    // hosts.
    assert!(
        stdout.contains(r#""value":"App scope count: 1""#),
        "v0.1 entry advanced once. stdout:\n{stdout}"
    );
    assert!(
        !stdout.contains(r#""value":"App scope count: 2""#),
        "v0.1 entry did not double-advance. stdout:\n{stdout}"
    );
}

/// The formerly-documented limitation, now closed: a `.hypen` edit that adds
/// a NEW distinct usage config mints its synthetic scope live — the watcher
/// re-runs per-usage planning, registers + inits the new instance with the
/// usage-site config, and the re-render binds the new reference to it. No
/// restart.
#[test]
fn ui_hot_reload_mints_new_usage_scope_live() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let wasm = tmp.path().join("seeded.wasm");
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/seeded_module.wasm");
    std::fs::copy(&src, &wasm).expect("copy wasm");
    std::fs::write(
        tmp.path().join("app.hypen"),
        "module App {\n Column {\n  Text(\"App: @{state.count}\")\n  Seeded()\n }\n}\n",
    )
    .unwrap();
    std::fs::write(
        tmp.path().join("seeded.hypen"),
        "module Seeded {\n Text(\"Seeded: @{state.count}\")\n}\n",
    )
    .unwrap();
    std::fs::write(
        tmp.path().join("app.json"),
        r#"{ "entry": "App", "modules": [
            { "name": "App", "wasm": "seeded.wasm", "ui": "app.hypen" },
            { "name": "Seeded", "wasm": "seeded.wasm", "ui": "seeded.hypen" }
        ] }"#,
    )
    .unwrap();

    let port = free_port();
    let child = Command::new(runtime_path())
        .arg("--app")
        .arg(tmp.path().join("app.json"))
        .arg("--serve")
        .arg(port.to_string())
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hypen-runtime --serve --app");
    let s = Server { child, port };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            std::time::Duration::from_millis(100),
        )
        .is_ok()
        {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "server didn't accept");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    // Booted with the base scope only — no seeded__a yet.
    let (_, body) = http_request("GET", &s.url("/state"), None).unwrap();
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(v["states"].get("seeded").is_some(), "base scope booted: {body}");
    assert!(v["states"].get("seeded__a").is_none(), "no synthetic yet: {body}");

    // Live edit: add a second usage with a DISTINCT config. Pre-fix, this
    // fell back to the base scope until restart.
    std::fs::write(
        tmp.path().join("app.hypen"),
        "module App {\n Column {\n  Text(\"App: @{state.count}\")\n  Seeded()\n  Seeded(start: 5)\n }\n}\n",
    )
    .unwrap();

    // The watcher debounces 200ms, then replans + mints + re-renders.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let minted = loop {
        let (_, body) = http_request("GET", &s.url("/state"), None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        if v["states"].get("seeded__a").is_some() {
            break v;
        }
        if std::time::Instant::now() > deadline {
            panic!("synthetic scope was not minted within 10s. last /state: {body}");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    // The minted instance init'd with the usage-site config.
    assert_eq!(
        minted["states"]["seeded__a"]["count"], 5,
        "usage-site config seeded the live-minted instance: {minted}"
    );
    // And the base scope is untouched.
    assert_eq!(minted["states"]["seeded"]["count"], 0, "{minted}");

    // The re-render bound the new reference to the synthetic scope (the
    // mint lands in /state a beat before the re-render lands in /patches,
    // so poll briefly).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let (_, patches) = http_request("GET", &s.url("/patches"), None).unwrap();
        if patches.contains("Seeded: 5") {
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!("re-render never showed the minted scope. patches: {patches}");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// `"http": false` in app.json denies egress at link time: a module that
/// imports `wasi:http` (the fetcher) fails to instantiate, so the app
/// refuses to boot — "can this app reach the network?" is answerable from
/// app.json alone.
#[test]
fn app_manifest_http_false_denies_egress_at_boot() {
    let mut child = Command::new(runtime_path())
        .arg("--app")
        .arg("tests/fixtures/app_acl/app_http_denied.json")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hypen-runtime --app");
    drop(child.stdin.take());
    let mut stderr = String::new();
    child.stderr.as_mut().unwrap().read_to_string(&mut stderr).unwrap();
    let code = child.wait().unwrap().code().unwrap_or(-1);
    assert_ne!(code, 0, "boot must fail when an http importer is denied egress");
    assert!(
        stderr.contains("instantiate") && stderr.to_lowercase().contains("http"),
        "failure names the module + missing import. stderr:\n{stderr}"
    );
}

// ── --data-dir: module state survives a runtime restart ─────────────────────

/// The desktop persistence story end-to-end: run the runtime with
/// `--data-dir`, mutate module state, KILL the process, start a fresh one on
/// the same dir — the module's awaited storage read in `init` warm-starts
/// from the JSON snapshot a previous *process* wrote.
#[test]
fn data_dir_persists_state_across_runtime_restarts() {
    let data = tempfile::tempdir().expect("tempdir");

    let start = |dir: &std::path::Path| -> Server {
        let port = free_port();
        let child = Command::new(runtime_path())
            .arg(COUNTER)
        .args(grants_for(COUNTER))
            .arg("--serve")
            .arg(port.to_string())
            .arg("--data-dir")
            .arg(dir)
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn hypen-runtime --serve --data-dir");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if std::net::TcpStream::connect_timeout(
                &format!("127.0.0.1:{port}").parse().unwrap(),
                std::time::Duration::from_millis(100),
            )
            .is_ok()
            {
                break;
            }
            assert!(std::time::Instant::now() <= deadline, "no accept on {port}");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        Server { child, port }
    };

    // First process: 0 → 2.
    {
        let s = start(data.path());
        for _ in 0..2 {
            let (status, _) =
                http_request("POST", &s.url("/dispatch"), Some(r#"{"action":"increment"}"#))
                    .unwrap();
            assert_eq!(status, 200);
        }
        let (_, body) = http_request("GET", &s.url("/state"), None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["state"]["count"], 2, "body: {body}");
    } // Server::drop kills the process

    // Second process, same --data-dir: init warm-starts at 2.
    let s = start(data.path());
    let (_, body) = http_request("GET", &s.url("/state"), None).unwrap();
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["state"]["count"], 2, "state survived the restart. body: {body}");
}
