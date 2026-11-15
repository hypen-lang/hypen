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
//! the server answers 503). Bodies are read through a hard
//! [`MAX_BODY_BYTES`](request::MAX_BODY_BYTES) cap. A panic in a handler is
//! caught and answered with a 500.
//!
//! ## Request bodies the client controls
//!
//! `tiny_http` 0.12 exposes neither the socket nor a read timeout (there is
//! no server-level setting either), and it has two behaviours this server
//! has to work around rather than configure:
//!
//! 1. Reading a body blocks until the client sends it.
//! 2. **Dropping a request whose body was not read to the end blocks too**,
//!    and worse: `tiny_http` first allocates a buffer the size of the
//!    *declared* remainder (its `EqualReader`), then reads until that many
//!    bytes arrive or the client goes away. Answering a request counts as
//!    dropping it. A `Content-Length` beyond what the machine can allocate
//!    aborts the process; one in the gigabytes blocks whoever answers.
//!
//! (A body of at most [`PRE_READ_BODY_BYTES`] without `Expect` is read by
//! `tiny_http` itself, on its connection thread, before the request is handed
//! over — such a request is never seen until its body is complete.)
//!
//! So nothing that can block on the client runs on the accept loop or while
//! holding an in-flight slot:
//!
//! - **Reading** the `/dispatch` body happens on a helper thread
//!   ([`read_body_within`]) while the handler waits for at most the body
//!   timeout (`--request-timeout-ms`, default [`DEFAULT_BODY_TIMEOUT`] — a
//!   deadline for the **whole** body, so a slow drip does not reset it).
//!   When it passes, the handler gives up and **releases its slot**; the
//!   helper keeps the connection and answers `408` when its read returns.
//! - **Answering** a request with body bytes still outstanding
//!   ([`finish`]) — a refusal, a 503, a route that takes no body — happens
//!   on a detached thread when the outstanding part is at most
//!   [`MAX_DRAIN_BYTES`], so the wait for the client is nobody else's.
//!   Beyond that the request is never dropped at all ([`abandon`]): the
//!   reply is written and the connection is deliberately leaked, because
//!   letting `tiny_http` free it would make the oversized allocation.
//!
//! What this bounds: a stalled or oversized upload cannot hold one of the
//! [`MAX_IN_FLIGHT`] slots past the body timeout, cannot stall the accept
//! loop, and cannot crash the process with a declared length.
//!
//! What remains, precisely:
//! - each stalled connection still parks **one thread** (plus a buffer of at
//!   most [`MAX_DRAIN_BYTES`]) until the client finishes or disconnects — as
//!   does any client that stalls while sending its request *head* or a small
//!   pre-read body, which `tiny_http` reads on its own per-connection thread
//!   before this server sees anything. Neither count is bounded here; the
//!   listener is loopback-only, so the peer is a local process;
//! - each [`abandon`]ed request leaks its connection (one socket, one parked
//!   `tiny_http` thread) until the process exits, and is logged;
//! - the `408` cannot be sent *at* the deadline, only once the blocked read
//!   returns, because a request owns both halves of its connection;
//! - writing a response to a client that does not read is not timed
//!   (responses other than `/patches` snapshots fit the socket buffer).

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

/// How long a client may take to send a request body, unless
/// `--request-timeout-ms` says otherwise.
pub const DEFAULT_BODY_TIMEOUT: Duration = Duration::from_secs(10);

/// `tiny_http` reads a declared body up to this size itself before handing
/// the request over (unless the client sent `Expect`). Its constant, not
/// ours: `content_length <= 1024` in `tiny_http::request::new_request`.
const PRE_READ_BODY_BYTES: usize = 1024;

/// The most outstanding body bytes a request may have and still be dropped
/// normally: `tiny_http` allocates that much to drain it. Past this, see
/// [`abandon`].
const MAX_DRAIN_BYTES: usize = 16 * 1024 * 1024;

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
        RuntimeError::Dispatch(EngineError::ActionNotFound(_))
        | RuntimeError::UnknownAction { .. } => (404, "action_not_found"),
        // The request is well-formed and names real modules; it just does
        // not pick one. 409: the caller resolves it by addressing a scope.
        RuntimeError::AmbiguousAction { .. } => (409, "ambiguous_action"),
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
    match error {
        RuntimeError::ModuleCrashed { scopes, reasons, .. } => {
            object["scopes"] = json!(scopes);
            object["reasons"] = json!(reasons);
        }
        RuntimeError::AmbiguousAction { candidates, .. }
        | RuntimeError::UnknownAction { candidates, .. } => {
            object["candidates"] = json!(candidates);
        }
        _ => {}
    }
    object
}

struct Context {
    runtime: Arc<Runtime>,
    policy: Policy,
    timers: TimerHandle,
    body_timeout: Duration,
}

/// Run the server until the process is killed.
pub fn serve(
    runtime: Arc<Runtime>,
    port: u16,
    allow_origins: Vec<Origin>,
    body_timeout: Option<Duration>,
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
        body_timeout: body_timeout.unwrap_or(DEFAULT_BODY_TIMEOUT),
    });
    let limiter = Limiter::new(MAX_IN_FLIGHT);

    for request in server.incoming_requests() {
        let Some(permit) = limiter.acquire() else {
            // `finish`, not `send`: the accept loop must not wait for the
            // body of a request it is turning away.
            let unread = unread_body(&request);
            finish(request, Reply::error(&RequestError::Busy { what: "requests" }.into()), unread);
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

/// How many declared body bytes `tiny_http` has not yet read for `request`
/// — what dropping it would wait for (see the module docs).
fn unread_body(request: &tiny_http::Request) -> usize {
    let declared = request.body_length().unwrap_or(0);
    let expects_continue = request.headers().iter().any(|h| h.field.equiv("Expect"));
    if declared <= PRE_READ_BODY_BYTES && !expects_continue {
        0
    } else {
        declared
    }
}

/// Answer `request`, which still has `unread` body bytes outstanding,
/// without letting the wait for those bytes land on the caller (see the
/// module docs, "Request bodies the client controls").
fn finish(request: tiny_http::Request, reply: Reply, unread: usize) {
    if unread == 0 {
        return send(request, reply);
    }
    if unread > MAX_DRAIN_BYTES {
        return abandon(request, reply, unread);
    }
    let detached = std::thread::Builder::new()
        .name("hypen-drain".into())
        .spawn(move || send(request, reply));
    if let Err(e) = detached {
        // The request went down with the closure, on this thread: answered
        // with tiny_http's own 500, after waiting for its body.
        eprintln!("[serve] cannot start a drain thread: {e}");
    }
}

/// Answer a request that declared more body than is safe to let `tiny_http`
/// drain, and then leak it rather than drop it.
///
/// The only way to get at the connection without dropping the body reader
/// is [`tiny_http::Request::upgrade`], which insists on printing a response
/// of its own first; that is given an interim `100`, and the real reply is
/// written after it by hand. Clients skip interim responses.
fn abandon(request: tiny_http::Request, reply: Reply, unread: usize) {
    eprintln!(
        "[serve] a request declared a {unread}-byte body; answered {} and abandoned its \
         connection (it stays open until this process exits)",
        reply.status
    );
    let mut stream = request.upgrade("hypen-refused", tiny_http::Response::empty(100));
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\
         X-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\n",
        reply.status,
        reason_phrase(reply.status),
        reply.content_type,
        reply.body.len(),
    );
    for (name, value) in &reply.headers {
        // Values are constants or a validated origin; one that could break
        // the header block is dropped rather than written.
        if !value.contains(['\r', '\n']) {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    head.push_str("\r\n");
    let written = stream
        .write_all(head.as_bytes())
        .and_then(|()| stream.write_all(&reply.body))
        .and_then(|()| stream.flush());
    if let Err(e) = written {
        eprintln!("[serve] respond error: {e}");
    }
    // Dropping the stream drops tiny_http's body reader, which is exactly
    // the allocation this function exists to avoid.
    std::mem::forget(stream);
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

/// What became of a request whose body was read under a deadline.
enum BodyRead {
    /// The body (or the reason it could not be read) arrived in time; the
    /// request is back with the caller to be answered.
    Done(tiny_http::Request, Result<Vec<u8>, RequestError>),
    /// The deadline passed. The request stays with the helper thread, which
    /// answers `408` when its read returns; the caller has nothing to answer.
    Abandoned,
}

/// Read `request`'s body, waiting at most `timeout` for all of it (see the
/// module docs, "Request bodies the client controls").
fn read_body_within(mut request: tiny_http::Request, timeout: Duration) -> BodyRead {
    // Rendezvous channel: the helper's `send` succeeds only if the handler
    // is still waiting, so the request is always owned by exactly one side —
    // it can neither be answered twice nor dropped unanswered.
    let (done, wait) = std::sync::mpsc::sync_channel::<BodyResult>(0);
    let helper = std::thread::Builder::new().name("hypen-body".into()).spawn(move || {
        let body = request::read_body(request.as_reader(), request::MAX_BODY_BYTES);
        if let Err(std::sync::mpsc::SendError((request, body))) = done.send((request, body)) {
            // The handler gave up on us. Tell the client, if it still
            // listens; this thread is already the one that waits.
            let timeout = RuntimeError::from(RequestError::BodyTimeout { limit: timeout });
            let unread = if body.is_ok() { 0 } else { unread_body(&request) };
            finish(request, Reply::error(&timeout), unread);
        }
    });
    if let Err(e) = helper {
        // The request went down with the closure; tiny_http answers a
        // dropped request with a 500 itself.
        eprintln!("[serve] cannot start a body-reader thread: {e}");
        return BodyRead::Abandoned;
    }
    match wait.recv_timeout(timeout) {
        Ok((request, body)) => BodyRead::Done(request, body),
        // Timed out (dropping `wait` makes the helper's send fail), or the
        // helper died without sending.
        Err(_) => BodyRead::Abandoned,
    }
}

type BodyResult = (tiny_http::Request, Result<Vec<u8>, RequestError>);

/// Handle one request on its own thread.
fn handle(context: &Context, request: tiny_http::Request, permit: Permit) {
    let head = head_of(&request);
    let unread = unread_body(&request);
    let (route, cors) = match context.policy.admit(&head) {
        Err(e) => return finish(request, Reply::error(&e.into()), unread),
        Ok(Admission::Preflight { cors }) => {
            return finish(request, Reply::preflight().with_cors(Some(&cors)), unread);
        }
        Ok(Admission::Route { route, cors }) => (route, cors),
    };

    if route == Route::Events {
        // A long-lived stream is bounded by the subscriber cap, not the
        // request limiter.
        drop(permit);
        if unread > 0 {
            // Taking over the connection would wait for (and allocate) the
            // body first.
            let refused = RequestError::InvalidRequest {
                message: "GET /events takes no request body".to_string(),
            };
            return finish(request, Reply::error(&refused.into()).with_cors(cors.as_ref()), unread);
        }
        return stream_events(context, request, cors.as_ref());
    }

    // The only route with a body. Reading it is a step whose duration the
    // client controls, so it runs under a deadline.
    let (request, body, unread) = if route == Route::Dispatch {
        match read_body_within(request, context.body_timeout) {
            // Read to its end: nothing is outstanding.
            BodyRead::Done(request, Ok(body)) => (request, body, 0),
            BodyRead::Done(request, Err(e)) => {
                let unread = unread_body(&request);
                return finish(request, Reply::error(&e.into()).with_cors(cors.as_ref()), unread);
            }
            // Returning drops `permit`: the stalled client stops counting
            // against the in-flight limit.
            BodyRead::Abandoned => return,
        }
    } else {
        (request, Vec::new(), unread)
    };

    let reply = catch_unwind(AssertUnwindSafe(|| respond(context, route, &body)))
        .unwrap_or_else(|_| {
            eprintln!("[serve] a request handler panicked; answering 500 and carrying on");
            Err(RequestError::HandlerPanicked.into())
        })
        .unwrap_or_else(|e| Reply::error(&e));
    finish(request, reply.with_cors(cors.as_ref()), unread);
}

/// Answer an admitted one-shot request. `body` is the request body (empty
/// for the routes that have none).
fn respond(context: &Context, route: Route, body: &[u8]) -> Result<Reply, RuntimeError> {
    match route {
        Route::Index => Ok(Reply::html(CLIENT_HTML)),
        Route::State => Ok(Reply::json(200, &context.runtime.state_envelope())),
        Route::Patches => Ok(Reply::json(200, &patches_json(&context.runtime.tree_snapshot())?)),
        Route::Dispatch => {
            let dispatch = request::parse_dispatch(body)?;
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
                    reasons: Vec::new(),
                    source: EngineError::ModuleError("module trapped".into()),
                },
                500,
                "module_crashed",
            ),
            (RuntimeError::Internal("x"), 500, "internal_error"),
            (
                RuntimeError::AmbiguousAction {
                    action: "increment".into(),
                    candidates: vec!["app:increment".into(), "counter:increment".into()],
                },
                409,
                "ambiguous_action",
            ),
            (
                RuntimeError::UnknownAction {
                    name: "ghost:increment".into(),
                    candidates: vec!["app:increment".into()],
                    engine: EngineError::ActionNotFound("ghost:increment".into()),
                },
                404,
                "action_not_found",
            ),
            (
                RequestError::BodyTimeout { limit: Duration::from_millis(250) }.into(),
                408,
                "request_timeout",
            ),
        ];
        for (error, status, code) in cases {
            assert_eq!(status_and_code(&error), (status, code), "{error}");
        }
        let crashed = RuntimeError::ModuleCrashed {
            scopes: vec!["limits".into()],
            reasons: vec!["module 'limits' export `dispatch` trapped: unreachable".into()],
            source: EngineError::ModuleError("module trapped".into()),
        };
        let object = error_object(&crashed);
        assert_eq!(object["scopes"], json!(["limits"]));
        assert_eq!(
            object["reasons"],
            json!(["module 'limits' export `dispatch` trapped: unreachable"])
        );
        assert!(object["message"].as_str().unwrap().contains("export `dispatch` trapped"));
        assert!(object["message"].as_str().unwrap().contains("module trapped"));
        assert!(object["hint"].as_str().unwrap().contains("next action"));
    }

    /// An ambiguous or unknown action is the caller's mistake, answered with
    /// a 4xx whose body lists the `scope:action` forms that would work.
    #[test]
    fn ambiguous_and_unknown_actions_are_client_errors_listing_candidates() {
        let ambiguous = RuntimeError::AmbiguousAction {
            action: "increment".into(),
            candidates: vec!["app:increment".into(), "counter:increment".into()],
        };
        let reply = Reply::error(&ambiguous);
        assert_eq!(reply.status, 409);
        let body = body_of(&reply);
        assert_eq!(body["error"]["code"], "ambiguous_action");
        assert_eq!(body["error"]["candidates"], json!(["app:increment", "counter:increment"]));
        let message = body["error"]["message"].as_str().unwrap();
        assert!(message.contains("`app:increment`, `counter:increment`"), "{message}");
        assert!(body["error"]["hint"].as_str().unwrap().contains("sender"));

        let unknown = RuntimeError::UnknownAction {
            name: "counter:frob".into(),
            candidates: vec!["counter:increment".into()],
            engine: EngineError::ActionNotFound("frob".into()),
        };
        let body = body_of(&Reply::error(&unknown));
        assert_eq!(body["error"]["candidates"], json!(["counter:increment"]));
        assert!(body["error"]["message"].as_str().unwrap().contains("did you mean `counter:increment`?"));

        let timeout: RuntimeError = RequestError::BodyTimeout { limit: Duration::from_millis(250) }.into();
        let body = body_of(&Reply::error(&timeout));
        assert!(body["error"]["message"].as_str().unwrap().contains("within 250 ms"));
        assert!(body["error"]["hint"].as_str().unwrap().contains("--request-timeout-ms"));
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
