//! The pure half of the HTTP server: who may call what, and what a request
//! body means. Nothing here touches a socket — a [`RequestHead`] is plain
//! data — so the whole admission policy is unit-testable.
//!
//! ## Admission policy
//!
//! The server only ever binds `127.0.0.1`, but "local" is not "trusted": any
//! web page open in the developer's browser can send requests to it, and DNS
//! rebinding lets a hostile site make them look same-origin. So, in order:
//!
//! 1. **Host** must be a loopback name with the server's port
//!    (`127.0.0.1:P`, `localhost:P`, `[::1]:P`). A rebound hostname fails
//!    here.
//! 2. The path/method must be a known **route**.
//! 3. **Origin**, when present, must be the server's own origin or one given
//!    with `--allow-origin`. Browsers attach `Origin` to every cross-origin
//!    request and to same-origin POSTs; curl and other CLI clients send none
//!    and are admitted.
//! 4. A `POST` body must be declared `Content-Type: application/json` (a
//!    cross-origin page cannot set that without a preflight) and be at most
//!    [`MAX_BODY_BYTES`].

use std::io::Read;

use crate::app::DispatchRequest;

/// Largest accepted request body.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];

/// A browser origin (`scheme://host[:port]`), normalised to lowercase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin(String);

impl Origin {
    /// Parse an origin as a browser would send it in an `Origin` header.
    pub fn parse(raw: &str) -> Result<Self, String> {
        let lowered = raw.trim().to_lowercase();
        let value = lowered.strip_suffix('/').unwrap_or(&lowered);
        let rest = value
            .strip_prefix("http://")
            .or_else(|| value.strip_prefix("https://"))
            .ok_or_else(|| format!("`{raw}` is not an origin (expected http://host[:port])"))?;
        let well_formed = !rest.is_empty()
            && !rest.starts_with(':')
            && !rest.contains(|c: char| c == '/' || c == '?' || c == '#' || c == '@' || c.is_whitespace());
        if !well_formed {
            return Err(format!(
                "`{raw}` is not an origin (expected http://host[:port], no path)"
            ));
        }
        Ok(Origin(value.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Options,
    Other(String),
}

/// The parts of a request the admission policy looks at.
#[derive(Debug, Clone)]
pub struct RequestHead {
    pub method: Method,
    /// Request target as sent (path + optional query).
    pub url: String,
    pub host: Option<String>,
    pub origin: Option<String>,
    pub content_type: Option<String>,
    pub content_length: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// `GET /` — the reference client.
    Index,
    /// `GET /state`
    State,
    /// `GET /patches`
    Patches,
    /// `GET /events` — SSE.
    Events,
    /// `POST /dispatch`
    Dispatch,
}

impl Route {
    fn lookup(path: &str) -> Option<(Route, Method)> {
        Some(match path {
            "/" => (Route::Index, Method::Get),
            "/state" => (Route::State, Method::Get),
            "/patches" => (Route::Patches, Method::Get),
            "/events" => (Route::Events, Method::Get),
            "/dispatch" => (Route::Dispatch, Method::Post),
            _ => return None,
        })
    }
}

/// A request the policy let through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    Route {
        route: Route,
        /// The allow-listed foreign origin to echo in CORS headers, if the
        /// request came from one.
        cors: Option<Origin>,
    },
    /// A CORS preflight from an allow-listed origin.
    Preflight { cors: Origin },
}

/// Why a request was refused before reaching the engine.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RequestError {
    #[error("request has no Host header")]
    MissingHost,
    #[error("Host `{host}` is not this server (expected 127.0.0.1:{port} or localhost:{port})")]
    ForbiddenHost { host: String, port: u16 },
    #[error("origin `{origin}` is not allowed to call this server")]
    ForbiddenOrigin { origin: String },
    #[error("no such route: {path}")]
    NotFound { path: String },
    #[error("{path} does not accept this method (use {allow})")]
    MethodNotAllowed { path: String, allow: &'static str },
    #[error("request body must be Content-Type: application/json (got {})", got.as_deref().unwrap_or("none"))]
    UnsupportedMediaType { got: Option<String> },
    #[error("request body is larger than {limit} bytes")]
    PayloadTooLarge { limit: usize },
    #[error("request body could not be read: {message}")]
    BodyRead { message: String },
    #[error("request body was not received within {} ms", limit.as_millis())]
    BodyTimeout { limit: std::time::Duration },
    #[error("request body is not valid JSON for this endpoint: {message}")]
    InvalidJson { message: String },
    #[error("{message}")]
    InvalidRequest { message: String },
    #[error("too many concurrent {what}")]
    Busy { what: &'static str },
    #[error("the request handler panicked")]
    HandlerPanicked,
}

impl RequestError {
    pub fn status(&self) -> u16 {
        match self {
            RequestError::MissingHost
            | RequestError::BodyRead { .. }
            | RequestError::InvalidJson { .. }
            | RequestError::InvalidRequest { .. } => 400,
            RequestError::ForbiddenHost { .. } | RequestError::ForbiddenOrigin { .. } => 403,
            RequestError::NotFound { .. } => 404,
            RequestError::BodyTimeout { .. } => 408,
            RequestError::MethodNotAllowed { .. } => 405,
            RequestError::PayloadTooLarge { .. } => 413,
            RequestError::UnsupportedMediaType { .. } => 415,
            RequestError::HandlerPanicked => 500,
            RequestError::Busy { .. } => 503,
        }
    }

    /// Stable machine-readable code for the JSON error body.
    pub fn code(&self) -> &'static str {
        match self {
            RequestError::MissingHost => "missing_host",
            RequestError::ForbiddenHost { .. } => "forbidden_host",
            RequestError::ForbiddenOrigin { .. } => "forbidden_origin",
            RequestError::NotFound { .. } => "not_found",
            RequestError::MethodNotAllowed { .. } => "method_not_allowed",
            RequestError::UnsupportedMediaType { .. } => "unsupported_media_type",
            RequestError::PayloadTooLarge { .. } => "payload_too_large",
            RequestError::BodyRead { .. } => "invalid_body",
            RequestError::BodyTimeout { .. } => "request_timeout",
            RequestError::InvalidJson { .. } => "invalid_json",
            RequestError::InvalidRequest { .. } => "invalid_request",
            RequestError::Busy { .. } => "server_busy",
            RequestError::HandlerPanicked => "internal_error",
        }
    }

    pub fn hint(&self) -> Option<String> {
        match self {
            RequestError::ForbiddenOrigin { origin } => Some(format!(
                "to call this server from that page, restart it with --allow-origin {origin}"
            )),
            RequestError::UnsupportedMediaType { .. } => {
                Some("send the header `Content-Type: application/json`".to_string())
            }
            RequestError::BodyTimeout { .. } => Some(
                "send the whole body promptly, or start the server with a larger \
                 --request-timeout-ms"
                    .to_string(),
            ),
            _ => None,
        }
    }
}

/// The server's admission policy (see the module docs).
#[derive(Debug, Clone)]
pub struct Policy {
    port: u16,
    allowed: Vec<Origin>,
}

impl Policy {
    pub fn new(port: u16, allowed: Vec<Origin>) -> Self {
        Policy { port, allowed }
    }

    /// Decide whether a request may proceed, and as what.
    pub fn admit(&self, head: &RequestHead) -> Result<Admission, RequestError> {
        self.check_host(head.host.as_deref())?;

        let path = head.url.split(['?', '#']).next().unwrap_or_default();
        let (route, method) = Route::lookup(path)
            .ok_or_else(|| RequestError::NotFound { path: path.to_string() })?;

        let cors = self.check_origin(head.origin.as_deref())?;

        if head.method == Method::Options {
            // Only cross-origin callers preflight; without an allow-listed
            // origin there is nothing to grant.
            return match cors {
                Some(cors) => Ok(Admission::Preflight { cors }),
                None => Err(RequestError::MethodNotAllowed {
                    path: path.to_string(),
                    allow: method_name(&method),
                }),
            };
        }
        if head.method != method {
            return Err(RequestError::MethodNotAllowed {
                path: path.to_string(),
                allow: method_name(&method),
            });
        }

        if method == Method::Post {
            if !is_json(head.content_type.as_deref()) {
                return Err(RequestError::UnsupportedMediaType { got: head.content_type.clone() });
            }
            if head.content_length.is_some_and(|n| n > MAX_BODY_BYTES) {
                return Err(RequestError::PayloadTooLarge { limit: MAX_BODY_BYTES });
            }
        }
        Ok(Admission::Route { route, cors })
    }

    fn check_host(&self, host: Option<&str>) -> Result<(), RequestError> {
        let host = host.ok_or(RequestError::MissingHost)?;
        let lowered = host.trim().to_lowercase();
        let ours = LOOPBACK_HOSTS
            .iter()
            .any(|name| lowered.strip_prefix(name).and_then(|rest| rest.strip_prefix(':'))
                == Some(self.port.to_string().as_str()));
        if ours {
            Ok(())
        } else {
            Err(RequestError::ForbiddenHost { host: host.to_string(), port: self.port })
        }
    }

    /// `Ok(None)` for no Origin or the server's own; `Ok(Some(_))` for an
    /// allow-listed foreign origin; an error for anything else.
    fn check_origin(&self, origin: Option<&str>) -> Result<Option<Origin>, RequestError> {
        let Some(raw) = origin else {
            return Ok(None);
        };
        let forbidden = || RequestError::ForbiddenOrigin { origin: raw.to_string() };
        // `null` (sandboxed frames, file://) and anything unparseable is foreign.
        let origin = Origin::parse(raw).map_err(|_| forbidden())?;
        let own = LOOPBACK_HOSTS
            .iter()
            .any(|name| origin.as_str() == format!("http://{name}:{}", self.port));
        if own {
            Ok(None)
        } else if self.allowed.contains(&origin) {
            Ok(Some(origin))
        } else {
            Err(forbidden())
        }
    }
}

fn method_name(method: &Method) -> &'static str {
    match method {
        Method::Get => "GET",
        Method::Post => "POST",
        Method::Options => "OPTIONS",
        Method::Other(_) => "GET",
    }
}

fn is_json(content_type: Option<&str>) -> bool {
    content_type
        .and_then(|ct| ct.split(';').next())
        .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"))
}

/// Read a request body, refusing more than `limit` bytes however the client
/// framed it (a lying or absent Content-Length, chunked encoding).
pub fn read_body(reader: &mut dyn Read, limit: usize) -> Result<Vec<u8>, RequestError> {
    let mut body = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|e| RequestError::BodyRead { message: e.to_string() })?;
    if body.len() > limit {
        return Err(RequestError::PayloadTooLarge { limit });
    }
    Ok(body)
}

/// Parse a `POST /dispatch` body: `{ "action": string, "payload"?: any,
/// "sender"?: string | null }`.
pub fn parse_dispatch(body: &[u8]) -> Result<DispatchRequest, RequestError> {
    #[derive(serde::Deserialize)]
    struct Body {
        action: String,
        #[serde(default)]
        payload: serde_json::Value,
        /// Patch-wire node id of the element that fired the action.
        #[serde(default)]
        sender: Option<String>,
    }
    let body: Body = serde_json::from_slice(body)
        .map_err(|e| RequestError::InvalidJson { message: e.to_string() })?;
    if body.action.is_empty() {
        return Err(RequestError::InvalidRequest {
            message: "`action` must be a non-empty string".to_string(),
        });
    }
    Ok(DispatchRequest::new(&body.action, body.payload, body.sender))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::ActionTarget;
    use serde_json::json;

    const PORT: u16 = 4000;

    fn policy() -> Policy {
        Policy::new(PORT, vec![Origin::parse("http://localhost:5173").unwrap()])
    }

    fn get(url: &str) -> RequestHead {
        RequestHead {
            method: Method::Get,
            url: url.into(),
            host: Some(format!("127.0.0.1:{PORT}")),
            origin: None,
            content_type: None,
            content_length: None,
        }
    }

    fn post_dispatch() -> RequestHead {
        RequestHead {
            method: Method::Post,
            url: "/dispatch".into(),
            content_type: Some("application/json".into()),
            content_length: Some(20),
            ..get("/dispatch")
        }
    }

    fn route(route: Route) -> Admission {
        Admission::Route { route, cors: None }
    }

    #[test]
    fn known_routes_are_admitted_for_cli_clients() {
        let p = policy();
        assert_eq!(p.admit(&get("/")), Ok(route(Route::Index)));
        assert_eq!(p.admit(&get("/state")), Ok(route(Route::State)));
        assert_eq!(p.admit(&get("/patches?x=1")), Ok(route(Route::Patches)));
        assert_eq!(p.admit(&get("/events")), Ok(route(Route::Events)));
        assert_eq!(p.admit(&post_dispatch()), Ok(route(Route::Dispatch)));
    }

    #[test]
    fn unknown_routes_and_wrong_methods_are_distinguished() {
        let p = policy();
        assert_eq!(
            p.admit(&get("/missing")),
            Err(RequestError::NotFound { path: "/missing".into() })
        );
        let err = p.admit(&get("/dispatch")).unwrap_err();
        assert_eq!(err, RequestError::MethodNotAllowed { path: "/dispatch".into(), allow: "POST" });
        assert_eq!(err.status(), 405);
        let mut head = post_dispatch();
        head.url = "/state".into();
        assert_eq!(p.admit(&head).unwrap_err().status(), 405);
        let mut head = get("/state");
        head.method = Method::Other("DELETE".into());
        assert_eq!(p.admit(&head).unwrap_err().code(), "method_not_allowed");
    }

    #[test]
    fn host_must_be_a_loopback_name_with_our_port() {
        let p = policy();
        for good in ["127.0.0.1:4000", "localhost:4000", "LOCALHOST:4000", "[::1]:4000"] {
            let mut head = get("/state");
            head.host = Some(good.into());
            assert!(p.admit(&head).is_ok(), "{good}");
        }
        // DNS rebinding: the attacker's name resolves to 127.0.0.1, but the
        // browser still sends the attacker's name.
        for bad in [
            "evil.example:4000",
            "127.0.0.1",
            "127.0.0.1:4001",
            "localhost.evil.example:4000",
            "127.0.0.1:4000.evil.example",
            "",
        ] {
            let mut head = get("/state");
            head.host = Some(bad.into());
            let err = p.admit(&head).unwrap_err();
            assert_eq!(err.code(), "forbidden_host", "{bad}");
            assert_eq!(err.status(), 403);
        }
        let mut head = get("/");
        head.host = None;
        assert_eq!(p.admit(&head), Err(RequestError::MissingHost));
    }

    #[test]
    fn foreign_origins_are_refused_on_every_route() {
        let p = policy();
        for url in ["/state", "/patches", "/events", "/"] {
            let mut head = get(url);
            head.origin = Some("https://evil.example".into());
            let err = p.admit(&head).unwrap_err();
            assert_eq!(err.code(), "forbidden_origin", "{url}");
            assert!(err.hint().unwrap().contains("--allow-origin https://evil.example"));
        }
        // The CSRF shape: a cross-origin "simple" POST.
        let mut head = post_dispatch();
        head.origin = Some("https://evil.example".into());
        head.content_type = Some("text/plain".into());
        assert_eq!(p.admit(&head).unwrap_err().status(), 403);
        // Opaque origins are foreign too.
        let mut head = post_dispatch();
        head.origin = Some("null".into());
        assert_eq!(p.admit(&head).unwrap_err().code(), "forbidden_origin");
        // Same host, different port is a different origin.
        let mut head = post_dispatch();
        head.origin = Some("http://localhost:4001".into());
        assert_eq!(p.admit(&head).unwrap_err().code(), "forbidden_origin");
    }

    #[test]
    fn own_and_allow_listed_origins_are_admitted() {
        let p = policy();
        for own in ["http://127.0.0.1:4000", "http://localhost:4000", "http://[::1]:4000"] {
            let mut head = post_dispatch();
            head.origin = Some(own.into());
            assert_eq!(p.admit(&head), Ok(route(Route::Dispatch)), "{own}");
        }
        let mut head = post_dispatch();
        head.origin = Some("http://localhost:5173".into());
        let cors = Origin::parse("http://localhost:5173").unwrap();
        assert_eq!(
            p.admit(&head),
            Ok(Admission::Route { route: Route::Dispatch, cors: Some(cors.clone()) })
        );

        // Its preflight is answered; a preflight from anyone else is not.
        let mut preflight = get("/dispatch");
        preflight.method = Method::Options;
        preflight.origin = Some("http://localhost:5173".into());
        assert_eq!(p.admit(&preflight), Ok(Admission::Preflight { cors }));
        preflight.origin = Some("https://evil.example".into());
        assert_eq!(p.admit(&preflight).unwrap_err().code(), "forbidden_origin");
        preflight.origin = None;
        assert_eq!(p.admit(&preflight).unwrap_err().code(), "method_not_allowed");
    }

    #[test]
    fn post_bodies_must_be_declared_json_and_small() {
        let p = policy();
        for ok in ["application/json", "Application/JSON; charset=utf-8"] {
            let mut head = post_dispatch();
            head.content_type = Some(ok.into());
            assert!(p.admit(&head).is_ok(), "{ok}");
        }
        for bad in [None, Some("text/plain"), Some("application/x-www-form-urlencoded"), Some("application/jsonx")] {
            let mut head = post_dispatch();
            head.content_type = bad.map(str::to_string);
            let err = p.admit(&head).unwrap_err();
            assert_eq!((err.status(), err.code()), (415, "unsupported_media_type"), "{bad:?}");
        }
        let mut head = post_dispatch();
        head.content_length = Some(MAX_BODY_BYTES + 1);
        let err = p.admit(&head).unwrap_err();
        assert_eq!((err.status(), err.code()), (413, "payload_too_large"));
        head.content_length = Some(MAX_BODY_BYTES);
        assert!(p.admit(&head).is_ok());
    }

    #[test]
    fn read_body_enforces_the_cap_without_trusting_content_length() {
        let small = b"{\"action\":\"x\"}".to_vec();
        assert_eq!(read_body(&mut small.as_slice(), 64).unwrap(), small);
        let exact = vec![b'a'; 64];
        assert_eq!(read_body(&mut exact.as_slice(), 64).unwrap().len(), 64);
        let huge = std::io::repeat(b'a'); // an endless (chunked) body
        let mut reader = huge;
        assert_eq!(
            read_body(&mut reader, 64),
            Err(RequestError::PayloadTooLarge { limit: 64 })
        );
    }

    #[test]
    fn dispatch_bodies_parse_into_typed_requests() {
        let req = parse_dispatch(br#"{"action":"increment"}"#).unwrap();
        assert_eq!(req.target, ActionTarget::Named);
        assert_eq!(req.name, "increment");
        assert_eq!(req.payload, serde_json::Value::Null);
        assert_eq!(req.sender, None);

        let req = parse_dispatch(br#"{"action":"Counter:increment","payload":{"by":2},"sender":"n7"}"#)
            .unwrap();
        assert_eq!(
            req.target,
            ActionTarget::Scoped { scope: "counter".into(), action: "increment".into() }
        );
        assert_eq!(req.payload, json!({ "by": 2 }));
        assert_eq!(req.sender.as_deref(), Some("n7"));

        let req = parse_dispatch(br#"{"action":"x","sender":null}"#).unwrap();
        assert_eq!(req.sender, None);
    }

    #[test]
    fn malformed_dispatch_bodies_are_400s() {
        for bad in [&b"{not json"[..], b"", b"[]", br#"{"payload":{}}"#, br#"{"action":7}"#] {
            let err = parse_dispatch(bad).unwrap_err();
            assert_eq!((err.status(), err.code()), (400, "invalid_json"), "{:?}", String::from_utf8_lossy(bad));
        }
        let err = parse_dispatch(br#"{"action":""}"#).unwrap_err();
        assert_eq!((err.status(), err.code()), (400, "invalid_request"));
    }

    #[test]
    fn origins_are_normalised_and_validated() {
        assert_eq!(Origin::parse("HTTP://LocalHost:5173/").unwrap().as_str(), "http://localhost:5173");
        assert_eq!(Origin::parse("https://app.example").unwrap().as_str(), "https://app.example");
        for bad in ["localhost:5173", "http://", "http://a/b", "ftp://a", "null", "http://a b", "http://u@h"] {
            assert!(Origin::parse(bad).is_err(), "{bad}");
        }
    }
}
