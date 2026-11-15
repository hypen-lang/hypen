//! Deferred HTTP (`hypen:http/deferred`): performing the requests the engine
//! admitted, off the engine lock.
//!
//! Two layers:
//!
//! - [`perform`] is one exchange, start to finish: connect to the host the
//!   *engine* parsed out of the URL (never a second parse of the string),
//!   send, follow up to [`MAX_HTTP_REDIRECTS`] redirects — re-checking the
//!   module's allowlist on every hop — and read the response under the
//!   request's time budget and the response-size cap. It always returns an
//!   [`HttpOutcome`]; every failure is one of the contract's five kinds.
//! - [`HttpPool`] runs exchanges on up to [`MAX_CONCURRENT_REQUESTS`] worker
//!   threads (started on demand), each with its own current-thread tokio
//!   runtime, and hands every outcome to a callback — which completes the
//!   request through `Engine::complete_http_request`. A job that cannot be
//!   run is still completed (as a failure): the engine holds a slot for it.
//!
//! The client is built from what `wasmtime-wasi-http` already links for
//! blocking `wasi:http` — hyper's HTTP/1 connection, tokio, rustls with the
//! bundled Mozilla roots (`webpki-roots`) — so the TLS trust store is the
//! same for both kinds of request and no HTTP stack is added to the build.
//! HTTP/1.1 only, one connection per hop, no proxy support, no response
//! decompression (no `Accept-Encoding` is sent unless the module sets one).

use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::header::{HeaderName, HeaderValue};
use hypen_engine::module_host::{
    HttpEffect, HttpFailure, HttpFailureKind, HttpOutcome, HttpRequestId, HttpResponse,
    HttpScheme, HttpUrl, MAX_HTTP_REDIRECTS, MAX_HTTP_RESPONSE_BODY_BYTES,
};
use tokio::net::TcpStream;
use wasmtime_wasi_http::io::TokioIo;

use crate::sync::lock;

/// Most exchanges in progress at once; further jobs wait in the queue (which
/// the engine's per-module in-flight cap bounds).
pub const MAX_CONCURRENT_REQUESTS: usize = 8;

/// Sent when the module names no `User-Agent`; some servers refuse requests
/// without one.
const USER_AGENT: &str = concat!("hypen-runtime/", env!("CARGO_PKG_VERSION"));

type Failed = HttpFailure;

fn failed(kind: HttpFailureKind, message: impl Into<String>) -> Failed {
    HttpFailure::new(kind, message)
}

// ── one exchange ────────────────────────────────────────────────────────────

/// A request body that can be sent again on a 307/308 redirect without being
/// copied.
#[derive(Clone)]
struct SharedBody(Arc<Vec<u8>>);

impl AsRef<[u8]> for SharedBody {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

type RequestBody = Full<Cursor<SharedBody>>;

/// Perform `effect`'s request and say how it ended. Never panics and never
/// takes longer than the request's time budget.
pub async fn perform(effect: HttpEffect) -> HttpOutcome {
    let budget = Duration::from_millis(u64::from(effect.request.effective_timeout_ms()));
    match tokio::time::timeout(budget, exchange(effect)).await {
        Ok(Ok(response)) => HttpOutcome::Response(response),
        Ok(Err(failure)) => HttpOutcome::Failure(failure),
        Err(_) => HttpOutcome::Failure(failed(
            HttpFailureKind::Timeout,
            format!("no complete response within {} ms", budget.as_millis()),
        )),
    }
}

async fn exchange(effect: HttpEffect) -> Result<HttpResponse, Failed> {
    let HttpEffect { request, url, grant, .. } = effect;
    let mut url = url;
    let mut method = request.method;
    let mut headers = request.headers;
    let mut body = request.body.map(|bytes| SharedBody(Arc::new(bytes)));

    for hop in 0..=MAX_HTTP_REDIRECTS {
        let response = send(&url, &method, &headers, body.clone()).await?;
        let Some(location) = redirect_location(&response) else {
            return Ok(response);
        };
        if hop == MAX_HTTP_REDIRECTS {
            return Err(failed(
                HttpFailureKind::InvalidResponse,
                format!("more than {MAX_HTTP_REDIRECTS} redirects (last: {url})"),
            ));
        }
        let next = url.join(&location).map_err(|e| {
            failed(
                HttpFailureKind::InvalidResponse,
                format!("{url} redirected to a location that cannot be requested: {e}"),
            )
        })?;
        // The allowlist holds for wherever the request ends up, not only for
        // where it started.
        grant.check(&next).map_err(|denial| {
            failed(
                HttpFailureKind::Denied,
                format!("redirect from {url} to {next} refused: {denial}"),
            )
        })?;

        let same_origin = next.scheme() == url.scheme()
            && next.host() == url.host()
            && next.port() == url.port();
        if !same_origin {
            // Credentials meant for the first origin do not follow the
            // request to another one.
            headers.retain(|(name, _)| {
                !name.eq_ignore_ascii_case("authorization") && !name.eq_ignore_ascii_case("cookie")
            });
        }
        // 303 always, and 301/302 for POST (what every client does), turn
        // the request into a body-less GET; 307/308 repeat it as it was.
        let to_get = match response.status {
            303 => !method.eq_ignore_ascii_case("HEAD"),
            301 | 302 => method.eq_ignore_ascii_case("POST"),
            _ => false,
        };
        if to_get {
            method = "GET".to_string();
            body = None;
            headers.retain(|(name, _)| {
                !name
                    .get(..8)
                    .is_some_and(|p| p.eq_ignore_ascii_case("content-"))
            });
        }
        url = next;
    }
    // The loop returns on every path; this keeps the function total.
    Err(failed(HttpFailureKind::InvalidResponse, "redirect loop"))
}

/// The `Location` of a response that is a redirect to follow.
fn redirect_location(response: &HttpResponse) -> Option<String> {
    if !matches!(response.status, 301 | 302 | 303 | 307 | 308) {
        return None;
    }
    response
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("location"))
        .map(|(_, value)| value.clone())
}

/// One request/response on a fresh connection to `url`'s host.
async fn send(
    url: &HttpUrl,
    method: &str,
    headers: &[(String, String)],
    body: Option<SharedBody>,
) -> Result<HttpResponse, Failed> {
    let request = build_request(url, method, headers, body)?;

    let network = |what: &str, e: &dyn std::fmt::Display| {
        failed(
            HttpFailureKind::Network,
            format!("{what} {}:{} failed: {e}", url.host(), url.port()),
        )
    };
    let tcp = TcpStream::connect((url.connect_host(), url.port()))
        .await
        .map_err(|e| network("connecting to", &e))?;

    let response = match url.scheme() {
        HttpScheme::Http => roundtrip(TokioIo::new(tcp), request).await?,
        HttpScheme::Https => {
            let name = rustls::pki_types::ServerName::try_from(url.connect_host().to_string())
                .map_err(|e| network("TLS to", &e))?;
            let tls = tls_connector()
                .connect(name, tcp)
                .await
                .map_err(|e| network("TLS handshake with", &e))?;
            roundtrip(TokioIo::new(tls), request).await?
        }
    };
    Ok(response)
}

fn build_request(
    url: &HttpUrl,
    method: &str,
    headers: &[(String, String)],
    body: Option<SharedBody>,
) -> Result<hyper::Request<RequestBody>, Failed> {
    // The engine validated all of this at admission; a refusal here would be
    // a disagreement between its grammar and hyper's, reported, not assumed
    // away.
    let invalid = |what: &str, e: &dyn std::fmt::Display| {
        failed(
            HttpFailureKind::Network,
            format!("the request could not be built ({what}: {e})"),
        )
    };
    let mut builder = hyper::Request::builder()
        .method(method)
        .uri(url.path_and_query())
        .header(hyper::header::HOST, url.authority())
        // One exchange per connection.
        .header(hyper::header::CONNECTION, "close");
    let mut has_user_agent = false;
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|e| invalid("header", &e))?;
        let value = HeaderValue::from_str(value).map_err(|e| invalid("header", &e))?;
        has_user_agent |= name == hyper::header::USER_AGENT;
        builder = builder.header(name, value);
    }
    if !has_user_agent {
        builder = builder.header(hyper::header::USER_AGENT, USER_AGENT);
    }
    let body = body.unwrap_or_else(|| SharedBody(Arc::new(Vec::new())));
    builder
        .body(Full::new(Cursor::new(body)))
        .map_err(|e| invalid("request", &e))
}

/// Send `request` over `io` and read the whole response, within the size cap.
async fn roundtrip<S>(io: S, request: hyper::Request<RequestBody>) -> Result<HttpResponse, Failed>
where
    S: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let hyper_failure = |e: hyper::Error| {
        let kind = if e.is_parse() || e.is_incomplete_message() {
            HttpFailureKind::InvalidResponse
        } else {
            HttpFailureKind::Network
        };
        failed(kind, format!("the HTTP exchange failed: {e}"))
    };

    let (mut sender, connection) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(hyper_failure)?;
    // The connection task does the I/O; it ends with the exchange.
    let driver = tokio::spawn(connection);
    let result = async {
        let response = sender.send_request(request).await.map_err(hyper_failure)?;
        let status = response.status().as_u16();
        let headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect();

        let too_large = || {
            failed(
                HttpFailureKind::TooLarge,
                format!("the response body exceeds {MAX_HTTP_RESPONSE_BODY_BYTES} bytes"),
            )
        };
        let mut incoming = response.into_body();
        // A declared length over the cap is refused before reading any of it.
        if hyper::body::Body::size_hint(&incoming).lower() > MAX_HTTP_RESPONSE_BODY_BYTES as u64 {
            return Err(too_large());
        }
        let mut body: Vec<u8> = Vec::new();
        while let Some(frame) = incoming.frame().await {
            let frame = frame.map_err(hyper_failure)?;
            if let Some(chunk) = frame.data_ref() {
                if body.len() + chunk.len() > MAX_HTTP_RESPONSE_BODY_BYTES {
                    return Err(too_large());
                }
                body.extend_from_slice(chunk);
            }
        }
        Ok(HttpResponse { status, headers, body })
    }
    .await;
    driver.abort();
    result
}

/// The TLS client configuration: the Mozilla root program as bundled by
/// `webpki-roots` — the trust store `wasmtime-wasi-http` uses for blocking
/// `wasi:http`. Built once.
fn tls_connector() -> tokio_rustls::TlsConnector {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    let config = CONFIG.get_or_init(|| {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.into() };
        Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        )
    });
    tokio_rustls::TlsConnector::from(Arc::clone(config))
}

// ── the worker pool ─────────────────────────────────────────────────────────

/// A request to perform, for the module scope that queued it.
pub struct HttpJob {
    pub scope: String,
    pub effect: HttpEffect,
}

/// What the pool reports for each job: which request, whose, how it ended.
pub struct HttpDone {
    pub scope: String,
    pub id: HttpRequestId,
    pub outcome: HttpOutcome,
}

type OnDone = dyn Fn(HttpDone, &HttpPoolHandle) + Send + Sync;

struct Queue {
    jobs: VecDeque<HttpJob>,
    workers: usize,
    idle: usize,
    stop: bool,
}

struct Shared {
    queue: Mutex<Queue>,
    wake: Condvar,
    on_done: Box<OnDone>,
}

/// The worker pool. Dropping it stops idle workers and discards queued jobs;
/// an exchange in progress finishes (within its time budget) and is still
/// reported.
pub struct HttpPool {
    shared: Arc<Shared>,
}

/// A cheap handle for submitting jobs from other threads.
#[derive(Clone)]
pub struct HttpPoolHandle {
    shared: Arc<Shared>,
}

impl HttpPool {
    /// Create a pool. No thread is started until the first job. `on_done`
    /// runs on a worker thread for every submitted job, with a handle so it
    /// can submit the requests a completion queued in turn.
    pub fn new<F>(on_done: F) -> Self
    where
        F: Fn(HttpDone, &HttpPoolHandle) + Send + Sync + 'static,
    {
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue { jobs: VecDeque::new(), workers: 0, idle: 0, stop: false }),
            wake: Condvar::new(),
            on_done: Box::new(on_done),
        });
        HttpPool { shared }
    }

    pub fn handle(&self) -> HttpPoolHandle {
        HttpPoolHandle { shared: Arc::clone(&self.shared) }
    }
}

impl Drop for HttpPool {
    fn drop(&mut self) {
        let mut queue = lock(&self.shared.queue, "http pool");
        queue.stop = true;
        queue.jobs.clear();
        drop(queue);
        self.shared.wake.notify_all();
    }
}

impl HttpPoolHandle {
    /// Queue `job`. It is always reported through the pool's callback: with
    /// the exchange's outcome, or as a failure if no worker can run it.
    pub fn submit(&self, job: HttpJob) {
        let mut queue = lock(&self.shared.queue, "http pool");
        if queue.stop {
            drop(queue);
            return self.report_unrun(job, "the runtime is shutting down");
        }
        queue.jobs.push_back(job);
        // More waiting jobs than idle workers: add a worker, up to the cap.
        let spawn = queue.jobs.len() > queue.idle && queue.workers < MAX_CONCURRENT_REQUESTS;
        if spawn {
            queue.workers += 1;
        }
        drop(queue);
        self.shared.wake.notify_one();
        if !spawn {
            return;
        }

        let handle = self.clone();
        let spawned = std::thread::Builder::new()
            .name("hypen-http".into())
            .spawn(move || work(&handle));
        if let Err(e) = spawned {
            let mut queue = lock(&self.shared.queue, "http pool");
            queue.workers -= 1;
            // With no worker at all nothing would ever take the queue.
            let stranded: Vec<HttpJob> =
                if queue.workers == 0 { queue.jobs.drain(..).collect() } else { Vec::new() };
            drop(queue);
            for job in stranded {
                self.report_unrun(job, &format!("could not start an HTTP worker thread: {e}"));
            }
        }
    }

    fn report_unrun(&self, job: HttpJob, why: &str) {
        let outcome = HttpOutcome::Failure(failed(HttpFailureKind::Network, why));
        (self.shared.on_done)(HttpDone { scope: job.scope, id: job.effect.id, outcome }, self);
    }
}

/// A worker: take jobs until the pool stops.
fn work(handle: &HttpPoolHandle) {
    let shared = &*handle.shared;
    // `rt` + `time` + `net`: what an exchange needs (connect, I/O, the
    // deadline). No runtime means no exchange can run on this thread; the
    // jobs it takes are reported as failures rather than left in the queue.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build();

    loop {
        let job = {
            let mut queue = lock(&shared.queue, "http pool");
            loop {
                if queue.stop {
                    queue.workers -= 1;
                    return;
                }
                if let Some(job) = queue.jobs.pop_front() {
                    break job;
                }
                queue.idle += 1;
                queue = match shared.wake.wait(queue) {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                queue.idle -= 1;
            }
        };
        let HttpJob { scope, effect } = job;
        let id = effect.id;
        let outcome = match &runtime {
            Ok(runtime) => runtime.block_on(perform(effect)),
            Err(e) => HttpOutcome::Failure(failed(
                HttpFailureKind::Network,
                format!("could not start an I/O runtime for the request: {e}"),
            )),
        };
        (shared.on_done)(HttpDone { scope, id, outcome }, handle);
    }
}

/// Perform one request on the calling thread (the REPL has no pool).
pub fn perform_blocking(effect: HttpEffect) -> HttpOutcome {
    match tokio::runtime::Builder::new_current_thread().enable_io().enable_time().build() {
        Ok(runtime) => runtime.block_on(perform(effect)),
        Err(e) => HttpOutcome::Failure(failed(
            HttpFailureKind::Network,
            format!("could not start an I/O runtime for the request: {e}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hypen_engine::module_host::{HttpGrant, HttpRequest};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream as StdTcpStream};
    use std::sync::mpsc;

    /// A one-thread HTTP/1.1 server: answers each connection with what
    /// `respond` returns for the request head it read (raw bytes; `None`
    /// holds the connection open without answering).
    fn serve<F>(respond: F) -> u16
    where
        F: Fn(&str) -> Option<Vec<u8>> + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let head = read_head(&mut stream);
                match respond(&head) {
                    Some(bytes) => {
                        let _ = stream.write_all(&bytes);
                    }
                    None => std::thread::sleep(Duration::from_secs(5)),
                }
            }
        });
        port
    }

    /// Read a request up to the end of its body (by `content-length`).
    fn read_head(stream: &mut StdTcpStream) -> String {
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let text = String::from_utf8_lossy(&bytes).to_string();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    return text;
                }
            }
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => return String::from_utf8_lossy(&bytes).to_string(),
                Ok(n) => bytes.extend_from_slice(&chunk[..n]),
            }
        }
    }

    fn ok(body: &str) -> Vec<u8> {
        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nX-A: 1\r\nx-a: 2\r\n\r\n{body}", body.len())
            .into_bytes()
    }

    fn redirect(status: u16, location: &str) -> Vec<u8> {
        format!("HTTP/1.1 {status} Moved\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n")
            .into_bytes()
    }

    fn effect(method: &str, url: &str, grant: HttpGrant) -> HttpEffect {
        HttpEffect {
            id: HttpRequestId(1),
            request: HttpRequest {
                method: method.into(),
                url: url.into(),
                headers: Vec::new(),
                body: None,
                timeout_ms: Some(3_000),
            },
            url: HttpUrl::parse(url).unwrap(),
            grant: Arc::new(grant),
            then: "done".into(),
            tag: None,
        }
    }

    fn response(outcome: HttpOutcome) -> HttpResponse {
        match outcome {
            HttpOutcome::Response(response) => response,
            HttpOutcome::Failure(failure) => panic!("failed: {failure:?}"),
        }
    }

    fn failure(outcome: HttpOutcome) -> HttpFailure {
        match outcome {
            HttpOutcome::Failure(failure) => failure,
            HttpOutcome::Response(response) => panic!("answered {}", response.status),
        }
    }

    #[test]
    fn a_request_is_sent_with_the_host_owned_headers_and_the_response_is_read() {
        let (seen_tx, seen_rx) = mpsc::channel();
        let port = serve(move |head| {
            seen_tx.send(head.to_string()).unwrap();
            Some(ok("hello"))
        });
        let mut effect = effect("POST", &format!("http://127.0.0.1:{port}/items?x=1"), HttpGrant::AnyHost);
        effect.request.headers = vec![("X-Token".into(), "abc".into())];
        effect.request.body = Some(b"payload".to_vec());

        let response = response(perform_blocking(effect));
        assert_eq!((response.status, response.body.as_slice()), (200, b"hello".as_slice()));
        assert!(response.headers.contains(&("x-a".into(), "1".into())));
        assert!(response.headers.contains(&("x-a".into(), "2".into())), "repeats are kept");

        let head = seen_rx.recv().unwrap().to_ascii_lowercase();
        assert!(head.starts_with("post /items?x=1 http/1.1\r\n"), "{head}");
        assert!(head.contains(&format!("\r\nhost: 127.0.0.1:{port}\r\n")), "{head}");
        assert!(head.contains("\r\nx-token: abc\r\n") && head.contains("\r\ncontent-length: 7\r\n"));
        assert!(head.contains("\r\nuser-agent: hypen-runtime/"), "{head}");
        assert!(head.ends_with("\r\n\r\npayload"), "{head}");
    }

    #[test]
    fn every_url_the_engine_accepts_builds_a_request() {
        let url = HttpUrl::parse("http://h/a-._~!$&'()*+,;=:@/b%20c?q=[1]&r=?/").unwrap();
        let request = build_request(&url, "QUERY", &[("Accept".into(), "a/b; q=1\t".into())], None);
        assert_eq!(request.unwrap().uri().to_string(), url.path_and_query());
    }

    #[test]
    fn redirects_are_followed_and_the_allowlist_holds_on_every_hop() {
        let final_port = serve(|_| Some(ok("landed")));
        let hop_port = serve(move |head| {
            if head.starts_with("GET /loop") {
                return Some(redirect(302, "/loop"));
            }
            Some(redirect(302, &format!("http://127.0.0.1:{final_port}/end")))
        });
        let start = format!("http://127.0.0.1:{hop_port}/start");

        let landed = response(perform_blocking(effect("GET", &start, HttpGrant::AnyHost)));
        assert_eq!(landed.body, b"landed");

        // Only the first host is allow-listed: the hop to the second is refused.
        let only_first = HttpGrant::Hosts(vec![format!("127.0.0.1:{hop_port}").parse().unwrap()]);
        let refused = failure(perform_blocking(effect("GET", &start, only_first)));
        assert_eq!(refused.kind, HttpFailureKind::Denied);
        assert!(
            refused.message.contains(&format!("'127.0.0.1:{final_port}'"))
                && refused.message.contains("httpHosts"),
            "{}",
            refused.message
        );

        let looped = failure(perform_blocking(effect(
            "GET",
            &format!("http://127.0.0.1:{hop_port}/loop"),
            HttpGrant::AnyHost,
        )));
        assert_eq!(looped.kind, HttpFailureKind::InvalidResponse);
        assert!(looped.message.contains("more than 5 redirects"), "{}", looped.message);
    }

    #[test]
    fn a_redirected_post_becomes_a_get_and_drops_credentials_across_origins() {
        let (seen_tx, seen_rx) = mpsc::channel();
        let final_port = serve(move |head| {
            seen_tx.send(head.to_string()).unwrap();
            Some(ok("ok"))
        });
        let hop_port =
            serve(move |_| Some(redirect(303, &format!("http://127.0.0.1:{final_port}/done"))));
        let mut effect = effect("POST", &format!("http://127.0.0.1:{hop_port}/"), HttpGrant::AnyHost);
        effect.request.headers = vec![
            ("Authorization".into(), "Bearer secret".into()),
            ("Content-Type".into(), "application/json".into()),
            ("X-Keep".into(), "1".into()),
        ];
        effect.request.body = Some(b"{}".to_vec());

        assert_eq!(response(perform_blocking(effect)).status, 200);
        let head = seen_rx.recv().unwrap().to_ascii_lowercase();
        assert!(head.starts_with("get /done "), "{head}");
        assert!(!head.contains("authorization") && !head.contains("content-type"), "{head}");
        assert!(head.contains("x-keep: 1"), "{head}");
    }

    #[test]
    fn failures_map_to_the_contract_kinds() {
        // Nothing listens: bind a port, then free it.
        let dead = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let refused = failure(perform_blocking(effect(
            "GET",
            &format!("http://127.0.0.1:{dead}/"),
            HttpGrant::AnyHost,
        )));
        assert_eq!(refused.kind, HttpFailureKind::Network);
        assert!(refused.message.contains(&format!("127.0.0.1:{dead}")), "{}", refused.message);

        let silent = serve(|_| None);
        let mut slow = effect("GET", &format!("http://127.0.0.1:{silent}/"), HttpGrant::AnyHost);
        slow.request.timeout_ms = Some(150);
        let started = std::time::Instant::now();
        let timed_out = failure(perform_blocking(slow));
        assert_eq!(timed_out.kind, HttpFailureKind::Timeout);
        assert!(timed_out.message.contains("150 ms"), "{}", timed_out.message);
        assert!(started.elapsed() < Duration::from_secs(3));

        let garbage = serve(|_| Some(b"SSH-2.0-OpenSSH\r\n".to_vec()));
        let not_http = failure(perform_blocking(effect(
            "GET",
            &format!("http://127.0.0.1:{garbage}/"),
            HttpGrant::AnyHost,
        )));
        assert_eq!(not_http.kind, HttpFailureKind::InvalidResponse, "{}", not_http.message);

        // Declared too large: refused from the header alone.
        let declared = serve(|_| {
            Some(
                format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", MAX_HTTP_RESPONSE_BODY_BYTES + 1)
                    .into_bytes(),
            )
        });
        let too_large = failure(perform_blocking(effect(
            "GET",
            &format!("http://127.0.0.1:{declared}/"),
            HttpGrant::AnyHost,
        )));
        assert_eq!(too_large.kind, HttpFailureKind::TooLarge);

        // Undeclared (read to close) and too large: refused while reading.
        let streamed = serve(|_| {
            let mut bytes = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
            bytes.resize(bytes.len() + MAX_HTTP_RESPONSE_BODY_BYTES + 1, b'x');
            Some(bytes)
        });
        let too_large = failure(perform_blocking(effect(
            "GET",
            &format!("http://127.0.0.1:{streamed}/"),
            HttpGrant::AnyHost,
        )));
        assert_eq!(too_large.kind, HttpFailureKind::TooLarge);
    }

    #[test]
    fn the_pool_runs_jobs_concurrently_and_reports_each_once() {
        // Each connection is answered after a pause, on its own thread, so
        // sequential execution would take jobs × pause.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                std::thread::spawn(move || {
                    let _ = read_head(&mut stream);
                    std::thread::sleep(Duration::from_millis(300));
                    let _ = stream.write_all(&ok("x"));
                });
            }
        });

        let (done_tx, done_rx) = mpsc::channel();
        let done_tx = Mutex::new(done_tx);
        let pool = HttpPool::new(move |done: HttpDone, _: &HttpPoolHandle| {
            lock(&done_tx, "test").send((done.scope, done.id, done.outcome)).unwrap();
        });
        let handle = pool.handle();
        let started = std::time::Instant::now();
        const JOBS: u64 = 6;
        for n in 0..JOBS {
            let mut effect = effect("GET", &format!("http://127.0.0.1:{port}/"), HttpGrant::AnyHost);
            effect.id = HttpRequestId(n);
            handle.submit(HttpJob { scope: "m".into(), effect });
        }
        let mut ids: Vec<u64> = (0..JOBS)
            .map(|_| {
                let (scope, id, outcome) = done_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                assert_eq!(scope, "m");
                assert_eq!(response(outcome).status, 200);
                id.0
            })
            .collect();
        ids.sort_unstable();
        assert_eq!(ids, (0..JOBS).collect::<Vec<_>>());
        assert!(started.elapsed() < Duration::from_millis(1500), "ran sequentially");
        assert!(done_rx.recv_timeout(Duration::from_millis(100)).is_err(), "reported once each");

        // After shutdown a job is still reported — as a failure.
        drop(pool);
        handle.submit(HttpJob { scope: "m".into(), effect: effect("GET", "http://127.0.0.1:1/", HttpGrant::AnyHost) });
        let (_, _, outcome) = done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(failure(outcome).kind, HttpFailureKind::Network);
    }
}
