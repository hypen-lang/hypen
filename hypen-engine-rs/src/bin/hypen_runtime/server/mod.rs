//! `--serve`: the HTTP API, the SSE patch stream and the reference client.
//!
//! - `GET  /`         — the reference HTML client
//! - `GET  /state`    — `{ scope, actions, state, states }`
//! - `GET  /patches`  — the patches that rebuild the *current* rendered tree
//!   (a snapshot: `Create`s then `Insert`s), `[]` without a UI
//! - `POST /dispatch` — `{ action, payload?, sender? }` →
//!   `{ state, states, patches, navigate }`, plus `error: { code, message }`
//!   and a non-2xx status when the dispatch failed
//! - `GET  /events`   — SSE stream of out-of-band render deltas (hot reload,
//!   delayed effects); dispatch deltas ride the `/dispatch` response instead
//!
//! Every request passes the admission [`Policy`](request::Policy) first (Host,
//! route, Origin, Content-Type, size). Errors are JSON:
//! `{ "error": { "code", "message", "hint"? } }`.
//!
//! ## Concurrency
//!
//! `tiny_http` parses request heads on its own threads and hands requests to
//! the accept loop below, which does no I/O of its own: each request is
//! handled on a short-lived thread (bounded by [`MAX_IN_FLIGHT`]; beyond it
//! the server answers 503). A client that stalls mid-body therefore ties up
//! one handler thread, never the accept loop or other requests, and bodies
//! are read through a hard [`MAX_BODY_BYTES`](request::MAX_BODY_BYTES) cap.
//! A panic in a handler is caught and answered with a 500.

pub mod request;

use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::Duration;

use hypen_engine::EngineError;
use serde_json::{json, Value};

use crate::app::Runtime;
use crate::error::{one_line, RuntimeError};
use crate::reload;
use crate::timers::{TimerHandle, Timers};
use request::{Admission, Method, Origin, Policy, RequestError, RequestHead, Route};

const CLIENT_HTML: &str = include_str!("../client.html");

/// Most requests being handled at once.
const MAX_IN_FLIGHT: usize = 64;

/// How often an idle SSE stream sends a comment, so dead connections are
/// noticed and their subscriber slot freed.
const SSE_KEEP_ALIVE: Duration = Duration::from_secs(15);

/// Counts in-flight request handlers.
struct Limiter {
    in_flight: AtomicUsize,
    max: usize,
}

/// One in-flight slot; released on drop (including on unwind).
struct Permit(Arc<Limiter>);

impl Limiter {
    fn new(max: usize) -> Arc<Self> {
        Arc::new(Limiter { in_flight: AtomicUsize::new(0), max })
    }

    fn acquire(self: &Arc<Self>) -> Option<Permit> {
        self.in_flight
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < self.max).then_some(n + 1))
            .ok()
            .map(|_| Permit(Arc::clone(self)))
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

/// What a handler answers with.
struct Reply {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
    /// Extra `(name, value)` headers.
    headers: Vec<(&'static str, String)>,
}

impl Reply {
    fn json(status: u16, body: &Value) -> Self {
        Reply {
            status,
            content_type: "application/json",
            // Serialising a `Value` cannot fail; fall back to an empty
            // object rather than panic if it somehow does.
            body: serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec()),
            headers: Vec::new(),
        }
    }

    fn html(body: &str) -> Self {
        Reply {
            status: 200,
            content_type: "text/html; charset=utf-8",
            body: body.as_bytes().to_vec(),
            headers: Vec::new(),
        }
    }

    fn error(error: &RuntimeError) -> Self {
        let (status, _) = status_and_code(error);
        let mut reply = Reply::json(status, &json!({ "error": error_object(error) }));
        if let RuntimeError::Request(RequestError::MethodNotAllowed { allow, .. }) = error {
            reply.headers.push(("Allow", (*allow).to_string()));
        }
        reply
    }

    fn preflight() -> Self {
        Reply {
            status: 204,
            content_type: "text/plain",
            body: Vec::new(),
            headers: vec![
                ("Access-Control-Allow-Methods", "GET, POST, OPTIONS".to_string()),
                ("Access-Control-Allow-Headers", "Content-Type".to_string()),
                ("Access-Control-Max-Age", "600".to_string()),
            ],
        }
    }

    /// Echo an allow-listed foreign origin. (No wildcard, ever.)
    fn with_cors(mut self, cors: Option<&Origin>) -> Self {
        if let Some(origin) = cors {
            self.headers.push(("Access-Control-Allow-Origin", origin.as_str().to_string()));
            self.headers.push(("Vary", "Origin".to_string()));
        }
        self
    }
}

/// HTTP status and stable error code for any runtime error.
fn status_and_code(error: &RuntimeError) -> (u16, &'static str) {
    match error {
        RuntimeError::Request(e) => (e.status(), e.code()),
        RuntimeError::Dispatch(EngineError::ActionNotFound(_)) => (404, "action_not_found"),
        RuntimeError::Dispatch(EngineError::NotDeclared(_)) => (403, "not_declared"),
        RuntimeError::Dispatch(EngineError::ModuleError(_)) => (500, "module_error"),
        RuntimeError::Dispatch(_) => (500, "engine_error"),
        RuntimeError::ModuleCrashed { .. } => (500, "module_crashed"),
        _ => (500, "internal_error"),
    }
}

/// The `error` member of a JSON error body.
fn error_object(error: &RuntimeError) -> Value {
    let (_, code) = status_and_code(error);
    let mut object = json!({ "code": code, "message": one_line(error) });
    if let Some(hint) = error.hint() {
        object["hint"] = Value::String(hint);
    }
    if let RuntimeError::ModuleCrashed { scopes, .. } = error {
        object["scopes"] = json!(scopes);
    }
    object
}

struct Context {
    runtime: Arc<Runtime>,
    policy: Policy,
    timers: TimerHandle,
}

/// Run the server until the process is killed.
pub fn serve(
    runtime: Arc<Runtime>,
    port: u16,
    allow_origins: Vec<Origin>,
) -> Result<(), RuntimeError> {
    let addr = format!("127.0.0.1:{port}");
    let server = tiny_http::Server::http(&addr)
        .map_err(|source| RuntimeError::Bind { addr: addr.clone(), source })?;
    // `--serve 0` binds an ephemeral port; the policy needs the real one.
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(port);

    // One timer thread for every `Delay` effect. A fired timer dispatches
    // through the runtime and schedules whatever delays that dispatch emits.
    let timer_runtime = Arc::clone(&runtime);
    let timers = Timers::start(move |fire, timers| {
        let effects = timer_runtime.fire_timer(&fire.scope, &fire.action);
        effects.schedule_delays(timers);
        for path in &effects.navigations {
            eprintln!("[timers] {}:{} asked to navigate to {path}", fire.scope, fire.action);
        }
    })?;

    // Dropping the handle stops watching; keep it for the server's lifetime.
    let _watcher = reload::spawn_watcher(Arc::clone(&runtime))?;

    eprintln!(
        "hypen-runtime: http://127.0.0.1:{port}/   (module `{}`)",
        runtime.entry_scope()
    );
    let context = Arc::new(Context {
        runtime,
        policy: Policy::new(port, allow_origins),
        timers: timers.handle(),
    });
    let limiter = Limiter::new(MAX_IN_FLIGHT);

    for request in server.incoming_requests() {
        let Some(permit) = limiter.acquire() else {
            send(request, Reply::error(&RequestError::Busy { what: "requests" }.into()));
            continue;
        };
        let context = Arc::clone(&context);
        let spawned = std::thread::Builder::new()
            .name("hypen-request".into())
            .spawn(move || handle(&context, request, permit));
        if let Err(e) = spawned {
            // The request went down with the closure; tiny_http answers a
            // dropped request with a 500 itself.
            eprintln!("[serve] cannot start a request thread: {e}");
        }
    }
    Ok(())
}

fn head_of(request: &tiny_http::Request) -> RequestHead {
    let header = |name: &'static str| {
        request
            .headers()
            .iter()
            .find(|h| h.field.equiv(name))
            .map(|h| h.value.as_str().to_string())
    };
    RequestHead {
        method: match request.method() {
            tiny_http::Method::Get => Method::Get,
            tiny_http::Method::Post => Method::Post,
            tiny_http::Method::Options => Method::Options,
            other => Method::Other(other.to_string()),
        },
        url: request.url().to_string(),
        host: header("Host"),
        origin: header("Origin"),
        content_type: header("Content-Type"),
        content_length: request.body_length(),
    }
}

/// Handle one request on its own thread.
fn handle(context: &Context, mut request: tiny_http::Request, permit: Permit) {
    let head = head_of(&request);
    let (route, cors) = match context.policy.admit(&head) {
        Err(e) => return send(request, Reply::error(&e.into())),
        Ok(Admission::Preflight { cors }) => {
            return send(request, Reply::preflight().with_cors(Some(&cors)));
        }
        Ok(Admission::Route { route, cors }) => (route, cors),
    };

    if route == Route::Events {
        // A long-lived stream is bounded by the subscriber cap, not the
        // request limiter.
        drop(permit);
        return stream_events(context, request, cors.as_ref());
    }

    let reply = catch_unwind(AssertUnwindSafe(|| respond(context, route, &mut request)))
        .unwrap_or_else(|_| {
            eprintln!("[serve] a request handler panicked; answering 500 and carrying on");
            Err(RequestError::HandlerPanicked.into())
        })
        .unwrap_or_else(|e| Reply::error(&e));
    send(request, reply.with_cors(cors.as_ref()));
}

fn respond(
    context: &Context,
    route: Route,
    request: &mut tiny_http::Request,
) -> Result<Reply, RuntimeError> {
    match route {
        Route::Index => Ok(Reply::html(CLIENT_HTML)),
        Route::State => Ok(Reply::json(200, &context.runtime.state_envelope())),
        Route::Patches => Ok(Reply::json(200, &patches_json(&context.runtime.tree_snapshot())?)),
        Route::Dispatch => {
            let body = request::read_body(request.as_reader(), request::MAX_BODY_BYTES)?;
            let dispatch = request::parse_dispatch(&body)?;
            let outcome = context.runtime.dispatch(&dispatch);
            // Delays go on the timer thread; navigations ride the response.
            outcome.effects.schedule_delays(&context.timers);

            // State and patches are returned even when the dispatch failed:
            // a cascade can apply some steps before one fails.
            let mut body = json!({
                "state": outcome.state.entry,
                "states": outcome.state.scopes,
                "patches": patches_json(&outcome.patches)?,
                "navigate": outcome.effects.navigations,
            });
            match outcome.result {
                Ok(()) => Ok(Reply::json(200, &body)),
                Err(e) => {
                    let (status, _) = status_and_code(&e);
                    body["error"] = error_object(&e);
                    Ok(Reply::json(status, &body))
                }
            }
        }
        // Handled by `stream_events` before we get here.
        Route::Events => Err(RuntimeError::Internal("SSE route reached the one-shot handler")),
    }
}

fn patches_json(patches: &[hypen_engine::Patch]) -> Result<Value, RuntimeError> {
    serde_json::to_value(patches)
        .map_err(|_| RuntimeError::Internal("a patch batch could not be serialised"))
}

fn send(request: tiny_http::Request, reply: Reply) {
    let mut response =
        tiny_http::Response::from_data(reply.body).with_status_code(reply.status);
    let fixed = [
        ("Content-Type", reply.content_type.to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("Cache-Control", "no-store".to_string()),
    ];
    for (name, value) in fixed.iter().map(|(n, v)| (*n, v)).chain(reply.headers.iter().map(|(n, v)| (*n, v))) {
        // Header names are constants and values are either constants or a
        // validated origin; a value tiny_http rejects is skipped, not fatal.
        if let Ok(header) = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            response.add_header(header);
        }
    }
    if let Err(e) = request.respond(response) {
        eprintln!("[serve] respond error: {e}");
    }
}

/// Drive one SSE connection: write the event-stream head, then relay each
/// out-of-band patch batch as a `data:` frame until the client goes away.
/// Owns the socket for the stream's lifetime.
fn stream_events(context: &Context, request: tiny_http::Request, cors: Option<&Origin>) {
    // Subscribe before writing anything: once the client sees `: connected`
    // it will not miss a broadcast.
    let subscription = match context.runtime.subscribe() {
        Ok(subscription) => subscription,
        Err(_) => {
            return send(request, Reply::error(&RequestError::Busy { what: "event streams" }.into()));
        }
    };
    let mut head = String::from(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: text/event-stream\r\n\
         Cache-Control: no-cache\r\n\
         Connection: keep-alive\r\n",
    );
    if let Some(origin) = cors {
        head.push_str(&format!(
            "Access-Control-Allow-Origin: {}\r\nVary: Origin\r\n",
            origin.as_str()
        ));
    }
    // The leading comment makes EventSource fire `onopen` immediately.
    head.push_str("\r\n: connected\n\n");

    let mut socket = request.into_writer();
    let mut write = |bytes: &[u8]| socket.write_all(bytes).and_then(|()| socket.flush()).is_ok();
    if !write(head.as_bytes()) {
        return;
    }
    loop {
        let alive = match subscription.frames.recv_timeout(SSE_KEEP_ALIVE) {
            Ok(frame) => write(format!("data: {frame}\n\n").as_bytes()),
            Err(RecvTimeoutError::Timeout) => write(b": keep-alive\n\n"),
            // The hub dropped us (we fell too far behind); closing makes the
            // client reconnect and resync.
            Err(RecvTimeoutError::Disconnected) => false,
        };
        if !alive {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_limiter_caps_in_flight_requests_and_releases_on_drop() {
        let limiter = Limiter::new(2);
        let a = limiter.acquire().expect("first slot");
        let _b = limiter.acquire().expect("second slot");
        assert!(limiter.acquire().is_none(), "full");
        drop(a);
        assert!(limiter.acquire().is_some(), "a dropped permit frees its slot");

        // A handler that panics still releases its slot.
        let limiter = Limiter::new(1);
        let permit = limiter.acquire().expect("slot");
        let _ = catch_unwind(AssertUnwindSafe(move || {
            let _held = permit;
            panic!("handler bug");
        }));
        assert!(limiter.acquire().is_some());
    }

    fn body_of(reply: &Reply) -> Value {
        serde_json::from_slice(&reply.body).expect("json body")
    }

    #[test]
    fn request_errors_render_as_json_with_status_code_and_hint() {
        let e: RuntimeError = RequestError::ForbiddenOrigin { origin: "https://evil.example".into() }.into();
        let reply = Reply::error(&e);
        assert_eq!(reply.status, 403);
        assert_eq!(reply.content_type, "application/json");
        let body = body_of(&reply);
        assert_eq!(body["error"]["code"], "forbidden_origin");
        assert!(body["error"]["message"].as_str().unwrap().contains("https://evil.example"));
        assert!(body["error"]["hint"].as_str().unwrap().contains("--allow-origin"));

        let e: RuntimeError =
            RequestError::MethodNotAllowed { path: "/dispatch".into(), allow: "POST" }.into();
        let reply = Reply::error(&e);
        assert_eq!(reply.status, 405);
        assert!(reply.headers.contains(&("Allow", "POST".to_string())));
        assert!(body_of(&reply)["error"].get("hint").is_none());
    }

    #[test]
    fn dispatch_errors_map_to_statuses() {
        let cases = [
            (RuntimeError::Dispatch(EngineError::ActionNotFound("x".into())), 404, "action_not_found"),
            (RuntimeError::Dispatch(EngineError::NotDeclared("x".into())), 403, "not_declared"),
            (RuntimeError::Dispatch(EngineError::ModuleError("x".into())), 500, "module_error"),
            (RuntimeError::Dispatch(EngineError::StateError("x".into())), 500, "engine_error"),
            (
                RuntimeError::ModuleCrashed {
                    scopes: vec!["limits".into()],
                    source: EngineError::ModuleError("module trapped".into()),
                },
                500,
                "module_crashed",
            ),
            (RuntimeError::Internal("x"), 500, "internal_error"),
        ];
        for (error, status, code) in cases {
            assert_eq!(status_and_code(&error), (status, code), "{error}");
        }
        let crashed = RuntimeError::ModuleCrashed {
            scopes: vec!["limits".into()],
            source: EngineError::ModuleError("module trapped".into()),
        };
        let object = error_object(&crashed);
        assert_eq!(object["scopes"], json!(["limits"]));
        assert!(object["message"].as_str().unwrap().contains("module trapped"));
        assert!(object["hint"].as_str().unwrap().contains("next action"));
    }

    #[test]
    fn cors_headers_echo_only_the_allow_listed_origin() {
        let origin = Origin::parse("http://localhost:5173").unwrap();
        let reply = Reply::json(200, &json!({})).with_cors(Some(&origin));
        assert!(reply
            .headers
            .contains(&("Access-Control-Allow-Origin", "http://localhost:5173".to_string())));
        assert!(reply.headers.contains(&("Vary", "Origin".to_string())));
        let reply = Reply::json(200, &json!({})).with_cors(None);
        assert!(reply.headers.is_empty(), "no CORS header for same-origin / CLI callers");
        assert!(Reply::preflight()
            .headers
            .iter()
            .any(|(name, _)| *name == "Access-Control-Allow-Headers"));
    }
}
