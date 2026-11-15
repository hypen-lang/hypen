//! Deferred HTTP (`hypen:http/deferred`): the value types, the request
//! bounds, the host allowlist and the completion payload.
//!
//! A reducer cannot wait for a response, so it *queues* a request and names
//! one of its own actions; the engine hands the request to the embedder as
//! [`Effect::Http`](super::Effect::Http) and, when the embedder reports the
//! outcome, dispatches that action with the payload built here. The contract
//! (payload shape, bounds) is stated in `wit/deps/hypen-http/http.wit`.
//!
//! Everything in this file is plain data and pure functions — no I/O, no
//! runtime — so it is compiled on every target and shared by the native host
//! (which validates at `send`), the engine (which re-validates whatever a
//! host handed it) and the embedders (which re-check the allowlist on every
//! redirect hop).
//!
//! # One parser
//!
//! A request's URL is parsed exactly once, by [`HttpUrl::parse`], and the
//! allowlist is matched against *that* parse. The grammar is deliberately a
//! strict subset of what any HTTP stack accepts (ASCII only, no userinfo, no
//! backslashes, no numeric-host spellings other than a canonical dotted
//! quad), so a second parser downstream — hyper's, a browser's `URL` — cannot
//! read a different host out of the same string.

use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

// ── bounds ──────────────────────────────────────────────────────────────────

/// Most requests one guest call may queue.
pub const MAX_HTTP_REQUESTS_PER_CALL: usize = 16;
/// Longest request URL, in bytes.
pub const MAX_HTTP_URL_BYTES: usize = 8 * 1024;
/// Most request headers.
pub const MAX_HTTP_HEADERS: usize = 64;
/// Most bytes of request header names + values together.
pub const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
/// Largest request body, in bytes.
pub const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;
/// Longest method, in bytes (the registered ones are all far shorter).
pub const MAX_HTTP_METHOD_BYTES: usize = 32;
/// Longest completion action name and longest tag, in bytes.
pub const MAX_HTTP_NAME_BYTES: usize = 256;
/// Time budget of a request that names none, in milliseconds.
pub const DEFAULT_HTTP_TIMEOUT_MS: u32 = 30_000;
/// Longest time budget a request may ask for; larger values are clamped.
pub const MAX_HTTP_TIMEOUT_MS: u32 = 120_000;
/// Largest response body delivered to a module; a larger one completes the
/// request with [`HttpFailureKind::TooLarge`].
pub const MAX_HTTP_RESPONSE_BODY_BYTES: usize = 4 * 1024 * 1024;
/// Most redirects an embedder follows for one request.
pub const MAX_HTTP_REDIRECTS: usize = 5;
/// Default cap on requests one module may have in flight.
pub const DEFAULT_HTTP_IN_FLIGHT_PER_MODULE: usize = 32;

// ── requests ────────────────────────────────────────────────────────────────

/// An HTTP request a module asked the host to perform (the WIT `request`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// Time budget in milliseconds; `None` = [`DEFAULT_HTTP_TIMEOUT_MS`].
    pub timeout_ms: Option<u32>,
}

impl HttpRequest {
    /// The time budget an embedder applies: the requested one, defaulted and
    /// clamped to [`MAX_HTTP_TIMEOUT_MS`].
    pub fn effective_timeout_ms(&self) -> u32 {
        self.timeout_ms
            .unwrap_or(DEFAULT_HTTP_TIMEOUT_MS)
            .min(MAX_HTTP_TIMEOUT_MS)
    }
}

/// One `hypen:http/deferred.send` call: the request, the action to dispatch
/// to the calling module when it completes, and the tag echoed back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedHttpRequest {
    pub request: HttpRequest,
    pub then: String,
    pub tag: Option<String>,
}

/// Why a request was not accepted (the WIT `error`). Each message names the
/// part at fault and the rule it broke.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpRequestError {
    PermissionDenied(String),
    InvalidRequest(String),
    LimitExceeded(String),
}

impl HttpRequestError {
    pub fn message(&self) -> &str {
        match self {
            Self::PermissionDenied(m) | Self::InvalidRequest(m) | Self::LimitExceeded(m) => m,
        }
    }
}

impl fmt::Display for HttpRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl QueuedHttpRequest {
    /// Check everything about the request that does not depend on a grant —
    /// method, URL, headers, body, timeout, completion action, tag — and
    /// return the parsed URL. Never panics, whatever the guest supplied.
    pub fn validate(&self) -> Result<HttpUrl, HttpRequestError> {
        use HttpRequestError::{InvalidRequest as Invalid, LimitExceeded as Limit};
        let Self { request, then, tag } = self;

        check_method(&request.method).map_err(Invalid)?;

        if request.url.len() > MAX_HTTP_URL_BYTES {
            return Err(Limit(format!(
                "url of {} bytes exceeds the {MAX_HTTP_URL_BYTES}-byte limit",
                request.url.len()
            )));
        }
        let url = HttpUrl::parse(&request.url).map_err(|e| Invalid(e.to_string()))?;

        if request.headers.len() > MAX_HTTP_HEADERS {
            return Err(Limit(format!(
                "{} headers exceed the limit of {MAX_HTTP_HEADERS}",
                request.headers.len()
            )));
        }
        let header_bytes = request
            .headers
            .iter()
            .fold(0usize, |sum, (n, v)| sum.saturating_add(n.len()).saturating_add(v.len()));
        if header_bytes > MAX_HTTP_HEADER_BYTES {
            return Err(Limit(format!(
                "headers of {header_bytes} bytes exceed the {MAX_HTTP_HEADER_BYTES}-byte limit"
            )));
        }
        for (name, value) in &request.headers {
            check_header(name, value).map_err(Invalid)?;
        }

        if let Some(body) = &request.body {
            if body.len() > MAX_HTTP_BODY_BYTES {
                return Err(Limit(format!(
                    "body of {} bytes exceeds the {MAX_HTTP_BODY_BYTES}-byte limit",
                    body.len()
                )));
            }
        }
        if request.timeout_ms == Some(0) {
            return Err(Invalid(
                "timeout-ms is 0; omit it for the default or give a positive budget".into(),
            ));
        }

        if then.is_empty() {
            return Err(Invalid(
                "`then` is empty; name the action that receives the completion".into(),
            ));
        }
        if then.len() > MAX_HTTP_NAME_BYTES {
            return Err(Limit(format!(
                "`then` of {} bytes exceeds the {MAX_HTTP_NAME_BYTES}-byte limit",
                then.len()
            )));
        }
        if let Some(tag) = tag {
            if tag.len() > MAX_HTTP_NAME_BYTES {
                return Err(Limit(format!(
                    "tag of {} bytes exceeds the {MAX_HTTP_NAME_BYTES}-byte limit",
                    tag.len()
                )));
            }
        }
        Ok(url)
    }
}

/// RFC 9110 `tchar`: what a method and a header name are made of.
fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

fn is_token(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(is_token_byte)
}

/// A short, printable rendering of guest text for an error message.
fn shown(s: &str) -> String {
    const MAX: usize = 64;
    let mut out: String = s.chars().take(MAX).flat_map(char::escape_default).collect();
    if s.chars().count() > MAX {
        out.push('…');
    }
    out
}

fn check_method(method: &str) -> Result<(), String> {
    if method.len() > MAX_HTTP_METHOD_BYTES || !is_token(method) {
        return Err(format!(
            "method '{}' is not an HTTP token of at most {MAX_HTTP_METHOD_BYTES} bytes",
            shown(method)
        ));
    }
    // Methods that are not request/response exchanges with the origin.
    if ["CONNECT", "TRACE", "TRACK"]
        .iter()
        .any(|m| method.eq_ignore_ascii_case(m))
    {
        return Err(format!("method '{method}' is not allowed"));
    }
    Ok(())
}

/// Headers the host sets itself (framing, connection management, the target
/// host) and a module therefore may not: letting a guest set them would let
/// it desynchronize the connection or address another origin.
const HOST_OWNED_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "keep-alive",
    "upgrade",
    "te",
    "trailer",
    "expect",
];

/// Whether `name` (any case) is a header only the host may set.
pub fn is_host_owned_header(name: &str) -> bool {
    HOST_OWNED_HEADERS
        .iter()
        .any(|owned| name.eq_ignore_ascii_case(owned))
        || name
            .get(..6)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("proxy-"))
}

fn check_header(name: &str, value: &str) -> Result<(), String> {
    if !is_token(name) {
        return Err(format!(
            "header name '{}' is not an HTTP token",
            shown(name)
        ));
    }
    if is_host_owned_header(name) {
        return Err(format!(
            "header '{name}' is set by the host and cannot be sent by a module"
        ));
    }
    // Visible ASCII, space and tab: no CR/LF/NUL (header injection), and
    // nothing a JS `Headers` object or hyper would reject or re-encode.
    if !value
        .bytes()
        .all(|b| b == b'\t' || (0x20..=0x7e).contains(&b))
    {
        return Err(format!(
            "value of header '{name}' contains a control or non-ASCII character"
        ));
    }
    Ok(())
}

// ── URLs ────────────────────────────────────────────────────────────────────

/// The scheme of an [`HttpUrl`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HttpScheme {
    Http,
    Https,
}

impl HttpScheme {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Https => "https",
        }
    }

    pub fn default_port(self) -> u16 {
        match self {
            Self::Http => 80,
            Self::Https => 443,
        }
    }
}

/// Why a string is not a URL a module may request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidUrl(String);

impl fmt::Display for InvalidUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid url: {}", self.0)
    }
}

impl std::error::Error for InvalidUrl {}

/// A parsed absolute `http`/`https` URL: where to connect and what to ask
/// for. See the module docs for why the grammar is strict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpUrl {
    scheme: HttpScheme,
    host: HostName,
    port: u16,
    /// Path and query: starts with `/`, never contains a fragment.
    target: String,
}

impl HttpUrl {
    pub fn parse(url: &str) -> Result<Self, InvalidUrl> {
        let invalid = |why: String| InvalidUrl(why);
        if let Some(bad) = url.bytes().find(|b| !(0x21..=0x7e).contains(b)) {
            return Err(invalid(format!(
                "contains a space, control or non-ASCII character (byte 0x{bad:02x}); \
                 percent-encode it (internationalized hosts in punycode)"
            )));
        }
        let (scheme, rest) = if let Some(rest) = strip_prefix_ignore_case(url, "https://") {
            (HttpScheme::Https, rest)
        } else if let Some(rest) = strip_prefix_ignore_case(url, "http://") {
            (HttpScheme::Http, rest)
        } else {
            return Err(invalid(
                "must be absolute and start with http:// or https://".into(),
            ));
        };

        let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let (authority, after) = rest.split_at(authority_end);
        if authority.contains('@') {
            return Err(invalid(
                "credentials in the URL (user:pass@host) are not allowed; send an \
                 Authorization header"
                    .into(),
            ));
        }
        let (host, port) = split_host_port(authority).map_err(invalid)?;
        let host = HostName::parse(host).map_err(invalid)?;
        let port = match port {
            Some(port) => parse_port(port).map_err(invalid)?,
            None => scheme.default_port(),
        };

        // The fragment never leaves the client.
        let target = after.split('#').next().unwrap_or("");
        if let Some(bad) = target.bytes().find(|b| !is_target_byte(*b)) {
            return Err(invalid(format!(
                "path or query contains '{}'; percent-encode it",
                char::from(bad).escape_default()
            )));
        }
        let target = match target.as_bytes().first() {
            Some(b'/') => target.to_string(),
            // `http://host?query` and `http://host`.
            _ => format!("/{target}"),
        };
        Ok(Self {
            scheme,
            host,
            port,
            target,
        })
    }

    pub fn scheme(&self) -> HttpScheme {
        self.scheme
    }

    /// The host, canonical: a lowercase DNS name, a dotted-quad IPv4 address
    /// or a bracketed IPv6 address (`[::1]`).
    pub fn host(&self) -> &str {
        self.host.as_str()
    }

    /// The host as a resolver / TLS stack wants it: IPv6 without brackets.
    pub fn connect_host(&self) -> &str {
        let host = self.host.as_str();
        host.strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(host)
    }

    /// The port to connect to (the scheme's default when the URL names none).
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The request target: path and query, starting with `/`.
    pub fn path_and_query(&self) -> &str {
        &self.target
    }

    /// `host` or `host:port` — the `Host` header value: the port is left out
    /// when it is the scheme's default.
    pub fn authority(&self) -> String {
        if self.port == self.scheme.default_port() {
            self.host.as_str().to_string()
        } else {
            format!("{}:{}", self.host.as_str(), self.port)
        }
    }

    /// Resolve a `Location` header value against this URL: an absolute
    /// `http(s)` URL, a scheme-relative one (`//host/path`), an absolute path
    /// (`/path`) or a path relative to this URL's.
    pub fn join(&self, location: &str) -> Result<Self, InvalidUrl> {
        let location = location.trim_matches([' ', '\t']);
        if location.is_empty() {
            return Err(InvalidUrl("empty redirect location".into()));
        }
        if let Some(rest) = location.strip_prefix("//") {
            return Self::parse(&format!("{}://{rest}", self.scheme.as_str()));
        }
        // `scheme:` before any `/`, `?` or `#` makes it absolute.
        let scheme_end = location.find([':', '/', '?', '#']);
        if scheme_end.is_some_and(|i| location.as_bytes()[i] == b':') {
            return Self::parse(location);
        }
        let origin = format!("{}://{}", self.scheme.as_str(), self.authority());
        if location.starts_with('/') {
            return Self::parse(&format!("{origin}{location}"));
        }
        if location.starts_with('?') {
            let path = self.target.split('?').next().unwrap_or("/");
            return Self::parse(&format!("{origin}{path}{location}"));
        }
        if location.starts_with('#') {
            return Ok(self.clone());
        }
        // Relative path: replace everything after the last `/` of our path.
        // Dot segments are sent as written; the server resolves them.
        let path = self.target.split('?').next().unwrap_or("/");
        let dir = &path[..path.rfind('/').map_or(0, |i| i + 1)];
        Self::parse(&format!("{origin}{dir}{location}"))
    }
}

/// `scheme://authority/path?query`, with the port only when it is not the
/// scheme's default. No fragment.
impl fmt::Display for HttpUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}://{}{}",
            self.scheme.as_str(),
            self.authority(),
            self.target
        )
    }
}

fn strip_prefix_ignore_case<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &s[prefix.len()..])
}

/// RFC 3986 path / query characters (unreserved, sub-delims, `:@/?`, `%`)
/// plus the square brackets query strings commonly carry.
fn is_target_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@/?%[]".contains(&b)
}

/// Split `host`, `host:port`, `[v6]` or `[v6]:port`.
fn split_host_port(authority: &str) -> Result<(&str, Option<&str>), String> {
    if authority.starts_with('[') {
        let Some(end) = authority.find(']') else {
            return Err("unterminated '[' in the host".into());
        };
        let (host, rest) = authority.split_at(end + 1);
        return match rest.strip_prefix(':') {
            Some(port) => Ok((host, Some(port))),
            None if rest.is_empty() => Ok((host, None)),
            None => Err(format!("unexpected '{}' after the IPv6 address", shown(rest))),
        };
    }
    match authority.split_once(':') {
        Some((host, port)) => Ok((host, Some(port))),
        None => Ok((authority, None)),
    }
}

fn parse_port(port: &str) -> Result<u16, String> {
    let valid = !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit());
    match valid.then(|| port.parse::<u16>().ok()).flatten() {
        Some(port) if port != 0 => Ok(port),
        _ => Err(format!("'{}' is not a port (1-65535)", shown(port))),
    }
}

/// A canonical host: what [`HttpUrl::host`] returns and what a
/// [`HostPattern`] is compared with.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct HostName(String);

impl HostName {
    fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether this is an IP literal rather than a DNS name.
    fn is_ip(&self) -> bool {
        self.0.starts_with('[') || Ipv4Addr::from_str(&self.0).is_ok()
    }

    fn parse(host: &str) -> Result<Self, String> {
        if host.is_empty() {
            return Err("the host is empty".into());
        }
        if let Some(inner) = host.strip_prefix('[') {
            let inner = inner
                .strip_suffix(']')
                .ok_or("unterminated '[' in the host")?;
            let address = Ipv6Addr::from_str(inner)
                .map_err(|_| format!("'{}' is not an IPv6 address", shown(inner)))?;
            return Ok(Self(format!("[{address}]")));
        }
        if host.len() > 253 {
            return Err("the host is longer than 253 bytes".into());
        }
        let host = host.to_ascii_lowercase();
        for label in host.split('.') {
            let ok = !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
            if !ok {
                return Err(format!(
                    "'{}' is not a host name (labels of letters, digits, '-' and '_' \
                     separated by single dots)",
                    shown(&host)
                ));
            }
        }
        // A host whose last label is numeric is an IPv4 address to every URL
        // parser — but they disagree on the spellings (`127.1`, `0x7f.0.0.1`,
        // `2130706433`). Only the canonical dotted quad is accepted, so there
        // is one reading.
        let last = host.rsplit('.').next().unwrap_or("");
        let numeric = last.bytes().all(|b| b.is_ascii_digit())
            || last.starts_with("0x")
                && last.len() > 2
                && last[2..].bytes().all(|b| b.is_ascii_hexdigit());
        if numeric {
            let address = Ipv4Addr::from_str(&host).map_err(|_| {
                format!(
                    "'{}' looks like an IPv4 address but is not a dotted quad (a.b.c.d)",
                    shown(&host)
                )
            })?;
            return Ok(Self(address.to_string()));
        }
        Ok(Self(host))
    }
}

// ── the allowlist ───────────────────────────────────────────────────────────

/// One entry of a manifest's `httpHosts` allowlist:
///
/// | pattern | matches |
/// |---|---|
/// | `api.example.com` | that host, any port |
/// | `api.example.com:8443` | that host on that port |
/// | `*.example.com` | every subdomain of `example.com` at any depth — **not** `example.com` itself |
/// | `127.0.0.1:8080`, `[::1]` | an IP literal |
///
/// Hosts compare case-insensitively. A pattern never carries a scheme or a
/// path; the scheme is always `http` or `https`.
///
/// Parsed once (from the manifest, see the `Deserialize` impl) so a malformed
/// pattern is a load-time error and request-time matching is two string
/// comparisons.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct HostPattern {
    host: HostMatch,
    /// `None` = any port.
    port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum HostMatch {
    Exact(HostName),
    /// The suffix a subdomain ends with, leading dot included
    /// (`.example.com`).
    Subdomains(String),
}

/// Why a string is not a host pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidHostPattern {
    pattern: String,
    why: String,
}

impl fmt::Display for InvalidHostPattern {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "invalid host pattern '{}': {} (expected `host`, `*.domain`, or either with \
             `:port`)",
            shown(&self.pattern),
            self.why
        )
    }
}

impl std::error::Error for InvalidHostPattern {}

impl FromStr for HostPattern {
    type Err = InvalidHostPattern;

    fn from_str(pattern: &str) -> Result<Self, Self::Err> {
        let invalid = |why: &str| InvalidHostPattern {
            pattern: pattern.to_string(),
            why: why.to_string(),
        };
        if pattern.is_empty() {
            return Err(invalid("it is empty"));
        }
        if pattern.contains("://") {
            return Err(invalid(
                "a pattern names a host, not a URL — drop the scheme",
            ));
        }
        if pattern.contains(['/', '?', '#', '@']) {
            return Err(invalid(
                "a pattern names a host, not a URL — drop the path, query and credentials",
            ));
        }
        let (host, port) = split_host_port(pattern).map_err(|why| invalid(&why))?;
        let port = port
            .map(|port| parse_port(port).map_err(|why| invalid(&why)))
            .transpose()?;

        let host = match host.strip_prefix("*.") {
            Some(domain) => {
                let domain = HostName::parse(domain).map_err(|why| invalid(&why))?;
                if domain.is_ip() {
                    return Err(invalid("a wildcard needs a domain name, not an address"));
                }
                HostMatch::Subdomains(format!(".{}", domain.as_str()))
            }
            None if host == "*" => {
                return Err(invalid(
                    "a bare `*` is not a pattern — leave the allowlist empty to allow any host",
                ))
            }
            None if host.contains('*') => {
                return Err(invalid(
                    "`*` is only allowed as the whole first label (`*.example.com`)",
                ))
            }
            None => HostMatch::Exact(HostName::parse(host).map_err(|why| invalid(&why))?),
        };
        Ok(Self { host, port })
    }
}

impl TryFrom<String> for HostPattern {
    type Error = InvalidHostPattern;

    fn try_from(pattern: String) -> Result<Self, Self::Error> {
        pattern.parse()
    }
}

impl fmt::Display for HostPattern {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.host {
            HostMatch::Exact(host) => f.write_str(host.as_str())?,
            HostMatch::Subdomains(suffix) => write!(f, "*{suffix}")?,
        }
        match self.port {
            Some(port) => write!(f, ":{port}"),
            None => Ok(()),
        }
    }
}

impl From<HostPattern> for String {
    fn from(pattern: HostPattern) -> Self {
        pattern.to_string()
    }
}

impl HostPattern {
    /// Whether a canonical host (as [`HttpUrl::host`] returns it) on `port`
    /// matches.
    fn matches(&self, host: &str, port: u16) -> bool {
        if self.port.is_some_and(|wanted| wanted != port) {
            return false;
        }
        match &self.host {
            HostMatch::Exact(exact) => exact.as_str() == host,
            HostMatch::Subdomains(suffix) => host.len() > suffix.len() && host.ends_with(suffix),
        }
    }
}

/// What a module's manifest lets it reach over HTTP (`http` + `httpHosts`).
/// Covers deferred requests everywhere and, on the native host, blocking
/// `wasi:http` requests too.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum HttpGrant {
    /// `http` is not granted: no request may be made.
    #[default]
    Denied,
    /// `http: true` with no `httpHosts`: any host.
    AnyHost,
    /// `http: true` with `httpHosts`: only hosts matching one of these.
    Hosts(Vec<HostPattern>),
}

/// Why a grant refuses a host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpDenial {
    /// The manifest does not grant `http` at all.
    NotGranted,
    /// `http` is granted but `host` (as `host:port`) matches no `httpHosts`
    /// entry.
    HostNotAllowed { host: String },
}

impl fmt::Display for HttpDenial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotGranted => f.write_str("the manifest does not grant `http`"),
            Self::HostNotAllowed { host } => write!(
                f,
                "host '{host}' is not in the manifest's `httpHosts` allowlist"
            ),
        }
    }
}

impl HttpGrant {
    /// Whether any request may be made at all (the link-time grant).
    pub fn is_granted(&self) -> bool {
        !matches!(self, Self::Denied)
    }

    /// Whether a request to `url` is allowed.
    pub fn check(&self, url: &HttpUrl) -> Result<(), HttpDenial> {
        self.check_host(url.host(), url.port())
    }

    /// [`check`](Self::check) for a host that did not come out of
    /// [`HttpUrl::parse`] (the authority of a blocking `wasi:http` request).
    /// With an allowlist, `host` is canonicalized first and one that is not
    /// a host in [`HttpUrl`]'s grammar matches nothing; without one, any
    /// host passes as it always did.
    pub fn check_authority(&self, host: &str, port: u16) -> Result<(), HttpDenial> {
        match self {
            Self::Denied => Err(HttpDenial::NotGranted),
            Self::AnyHost => Ok(()),
            Self::Hosts(_) => match HostName::parse(host) {
                Ok(host) => self.check_host(host.as_str(), port),
                Err(_) => Err(HttpDenial::HostNotAllowed {
                    host: format!("{}:{port}", shown(host)),
                }),
            },
        }
    }

    fn check_host(&self, host: &str, port: u16) -> Result<(), HttpDenial> {
        match self {
            Self::Denied => Err(HttpDenial::NotGranted),
            Self::AnyHost => Ok(()),
            Self::Hosts(patterns) if patterns.iter().any(|p| p.matches(host, port)) => Ok(()),
            Self::Hosts(_) => Err(HttpDenial::HostNotAllowed {
                host: format!("{host}:{port}"),
            }),
        }
    }

    /// The allowlist as pattern strings; `None` when any host is allowed (or
    /// none is: check [`is_granted`](Self::is_granted)).
    pub fn patterns(&self) -> Option<&[HostPattern]> {
        match self {
            Self::Hosts(patterns) => Some(patterns),
            Self::Denied | Self::AnyHost => None,
        }
    }
}

// ── completion ──────────────────────────────────────────────────────────────

/// The engine's handle for one request in flight: what
/// [`Effect::Http`](super::Effect::Http) carries and what the embedder gives
/// back to complete it. Opaque; unique for the lifetime of the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct HttpRequestId(pub u64);

impl fmt::Display for HttpRequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// A deferred request the engine admitted, for the embedder to perform and
/// then complete (`Engine::complete_http_request`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpEffect {
    pub id: HttpRequestId,
    pub request: HttpRequest,
    /// `request.url`, parsed. Connect to *this* (see the module docs).
    pub url: HttpUrl,
    /// The module's grant, to re-check on every redirect hop: a hop to a host
    /// it refuses must end the request with [`HttpFailureKind::Denied`].
    pub grant: std::sync::Arc<HttpGrant>,
    /// The action the completion is dispatched as (informational: the engine
    /// keeps its own record under `id`).
    pub then: String,
    pub tag: Option<String>,
}

/// A response the embedder read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    /// As received, in order; names in any case, repeats allowed.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// The `error.kind` of a failed completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HttpFailureKind {
    /// DNS, connect, TLS or I/O failure.
    Network,
    /// The request's time budget ran out.
    Timeout,
    /// Refused by policy after it was queued (a redirect outside the
    /// allowlist, the in-flight limit, …).
    Denied,
    /// The response body exceeds [`MAX_HTTP_RESPONSE_BODY_BYTES`].
    TooLarge,
    /// The peer did not answer with a well-formed HTTP response.
    InvalidResponse,
}

impl HttpFailureKind {
    /// The stable wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Timeout => "timeout",
            Self::Denied => "denied",
            Self::TooLarge => "too-large",
            Self::InvalidResponse => "invalid-response",
        }
    }

    /// The kind a wire string names.
    pub fn from_wire(kind: &str) -> Option<Self> {
        [
            Self::Network,
            Self::Timeout,
            Self::Denied,
            Self::TooLarge,
            Self::InvalidResponse,
        ]
        .into_iter()
        .find(|k| k.as_str() == kind)
    }
}

/// Why a request produced no response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpFailure {
    pub kind: HttpFailureKind,
    pub message: String,
}

impl HttpFailure {
    pub fn new(kind: HttpFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// How a request ended, as the embedder reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpOutcome {
    /// An HTTP response was read — whatever its status.
    Response(HttpResponse),
    /// No response.
    Failure(HttpFailure),
}

impl HttpOutcome {
    /// The completion action's payload — the JSON documented in
    /// `wit/deps/hypen-http/http.wit` — as bytes.
    ///
    /// A response the contract cannot carry becomes the matching failure: a
    /// body over [`MAX_HTTP_RESPONSE_BODY_BYTES`] is `too-large`, a status
    /// outside 100–999 is `invalid-response`.
    pub fn into_payload(self, tag: Option<&str>) -> Vec<u8> {
        use serde_json::{json, Map, Value};
        let payload = match self.checked() {
            Ok(HttpResponse {
                status,
                headers,
                body,
            }) => {
                let mut merged = Map::new();
                for (name, value) in headers {
                    match merged.entry(name.to_ascii_lowercase()) {
                        serde_json::map::Entry::Vacant(slot) => {
                            slot.insert(Value::String(value));
                        }
                        serde_json::map::Entry::Occupied(mut slot) => {
                            if let Value::String(joined) = slot.get_mut() {
                                joined.push_str(", ");
                                joined.push_str(&value);
                            }
                        }
                    }
                }
                // The body moves into the JSON value: no copy for text.
                let (body, encoding) = match String::from_utf8(body) {
                    Ok(text) => (text, "utf8"),
                    Err(not_text) => (base64_encode(not_text.as_bytes()), "base64"),
                };
                json!({
                    "ok": true,
                    "status": status,
                    "headers": merged,
                    "body": body,
                    "bodyEncoding": encoding,
                    "tag": tag,
                })
            }
            Err(HttpFailure { kind, message }) => json!({
                "ok": false,
                "error": { "kind": kind.as_str(), "message": message },
                "tag": tag,
            }),
        };
        // A `Value` with string keys always serializes; `null` stands in
        // rather than panicking if that ever changed.
        serde_json::to_vec(&payload).unwrap_or_else(|_| b"null".to_vec())
    }

    fn checked(self) -> Result<HttpResponse, HttpFailure> {
        match self {
            Self::Failure(failure) => Err(failure),
            Self::Response(response) if response.body.len() > MAX_HTTP_RESPONSE_BODY_BYTES => {
                Err(HttpFailure::new(
                    HttpFailureKind::TooLarge,
                    format!(
                        "response body of {} bytes exceeds the \
                         {MAX_HTTP_RESPONSE_BODY_BYTES}-byte limit",
                        response.body.len()
                    ),
                ))
            }
            Self::Response(response) if !(100..=999).contains(&response.status) => {
                Err(HttpFailure::new(
                    HttpFailureKind::InvalidResponse,
                    format!("status {} is not an HTTP status code", response.status),
                ))
            }
            Self::Response(response) => Ok(response),
        }
    }
}

/// Standard base64 (RFC 4648 §4, padded). Local so the always-compiled part
/// of the crate needs no dependency for it.
pub fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        let sextet = |shift: u32| char::from(ALPHABET[(n >> shift & 0x3f) as usize]);
        out.push(sextet(18));
        out.push(sextet(12));
        out.push(if chunk.len() > 1 { sextet(6) } else { '=' });
        out.push(if chunk.len() > 2 { sextet(0) } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn url(s: &str) -> HttpUrl {
        HttpUrl::parse(s).unwrap_or_else(|e| panic!("{s}: {e}"))
    }

    fn pattern(s: &str) -> HostPattern {
        s.parse().unwrap_or_else(|e| panic!("{e}"))
    }

    fn queued(method: &str, url: &str) -> QueuedHttpRequest {
        QueuedHttpRequest {
            request: HttpRequest {
                method: method.into(),
                url: url.into(),
                headers: Vec::new(),
                body: None,
                timeout_ms: None,
            },
            then: "done".into(),
            tag: None,
        }
    }

    #[test]
    fn urls_parse_into_scheme_host_port_and_target() {
        let u = url("HTTPS://API.Example.com/v1/items?q=a%20b&x[]=1#frag");
        assert_eq!(u.scheme(), HttpScheme::Https);
        assert_eq!((u.host(), u.port()), ("api.example.com", 443));
        assert_eq!(u.path_and_query(), "/v1/items?q=a%20b&x[]=1");
        assert_eq!(u.authority(), "api.example.com");
        assert_eq!(u.to_string(), "https://api.example.com/v1/items?q=a%20b&x[]=1");

        let u = url("http://localhost:8080");
        assert_eq!((u.host(), u.port(), u.path_and_query()), ("localhost", 8080, "/"));
        assert_eq!(u.authority(), "localhost:8080");
        assert_eq!(url("http://h?x=1").path_and_query(), "/?x=1");
        assert_eq!(url("http://h:80/").authority(), "h");

        let u = url("http://[0:0:0:0:0:0:0:1]:9/x");
        assert_eq!((u.host(), u.connect_host(), u.port()), ("[::1]", "::1", 9));
        assert_eq!(url("http://127.0.0.1/").host(), "127.0.0.1");
    }

    #[test]
    fn urls_another_parser_could_read_differently_are_refused() {
        for bad in [
            "",
            "example.com/path",
            "ftp://example.com/",
            "file:///etc/passwd",
            "http://",
            "http:///path",
            "http://user:pw@example.com/",
            "http://example.com\\@evil.com/",
            "http://exa mple.com/",
            "http://example.com/a b",
            "http://example.com/\u{e9}",
            "http://ex\u{e4}mple.com/",
            "http://example.com:0/",
            "http://example.com:/",
            "http://example.com:99999/",
            "http://example.com:8a/",
            "http://.example.com/",
            "http://example..com/",
            "http://example.com./",
            "http://exa%6dple.com/",
            "http://[::1/",
            "http://[::1]x/",
            "http://[fe80::1%25eth0]/",
            // Numeric hosts other than a canonical dotted quad.
            "http://2130706433/",
            "http://127.1/",
            "http://0x7f.0.0.1/",
            "http://0177.0.0.1/",
            "http://example.com/a\"b",
            "http://example.com/<x>",
            "http://example.com/\r\nHost: evil",
        ] {
            assert!(HttpUrl::parse(bad).is_err(), "accepted {bad:?}");
        }
        let e = HttpUrl::parse("http://user@example.com/").unwrap_err();
        assert!(e.to_string().contains("Authorization header"), "{e}");
    }

    #[test]
    fn redirect_locations_resolve_against_the_current_url() {
        let base = url("https://a.example.com:8443/dir/page?q=1");
        let to = |location: &str| base.join(location).unwrap().to_string();
        assert_eq!(to("http://b.example.com/x"), "http://b.example.com/x");
        assert_eq!(to("//c.example.com/y"), "https://c.example.com/y");
        assert_eq!(to("/root?z=2"), "https://a.example.com:8443/root?z=2");
        assert_eq!(to("other"), "https://a.example.com:8443/dir/other");
        assert_eq!(to("?p=3"), "https://a.example.com:8443/dir/page?p=3");
        assert_eq!(to("#top"), "https://a.example.com:8443/dir/page?q=1");
        assert!(base.join("").is_err());
        assert!(base.join("javascript:alert(1)").is_err());
        assert!(base.join("//user@evil.com/").is_err());
    }

    #[test]
    fn host_patterns_match_exact_hosts_subdomains_and_ports() {
        let exact = pattern("API.example.com");
        assert!(exact.matches("api.example.com", 443) && exact.matches("api.example.com", 8080));
        assert!(!exact.matches("example.com", 443) && !exact.matches("x.api.example.com", 443));

        let wild = pattern("*.example.com");
        assert!(wild.matches("a.example.com", 80) && wild.matches("a.b.example.com", 80));
        assert!(!wild.matches("example.com", 80), "the apex is not a subdomain");
        assert!(!wild.matches("badexample.com", 80), "matches whole labels only");
        assert!(!wild.matches("example.com.evil.net", 80));

        let ported = pattern("*.example.com:8443");
        assert!(ported.matches("a.example.com", 8443) && !ported.matches("a.example.com", 443));

        assert!(pattern("127.0.0.1:8080").matches("127.0.0.1", 8080));
        assert!(pattern("[0:0:0:0:0:0:0:1]:9").matches("[::1]", 9));
        assert!(pattern("[::1]").matches("[::1]", 1234));

        for round_trip in ["api.example.com", "*.example.com:8443", "[::1]:9", "10.0.0.1"] {
            assert_eq!(pattern(round_trip).to_string(), round_trip);
        }
    }

    #[test]
    fn malformed_host_patterns_say_what_is_wrong() {
        for (bad, hint) in [
            ("", "empty"),
            ("https://example.com", "drop the scheme"),
            ("example.com/api", "drop the path"),
            ("user@example.com", "drop the path"),
            ("*", "leave the allowlist empty"),
            ("ex*mple.com", "whole first label"),
            ("*.*.example.com", "not a host name"),
            ("*.127.0.0.1", "not an address"),
            ("example.com:http", "not a port"),
            ("example.com:0", "not a port"),
            ("exa mple.com", "not a host name"),
            ("[::1", "unterminated"),
        ] {
            let e = bad.parse::<HostPattern>().unwrap_err().to_string();
            assert!(e.contains(hint), "{bad:?}: {e}");
        }
        // Through serde the same error surfaces at manifest load.
        let e = serde_json::from_value::<Vec<HostPattern>>(json!(["ok.example", "http://x"]))
            .unwrap_err();
        assert!(e.to_string().contains("drop the scheme"), "{e}");
        assert_eq!(
            serde_json::to_value(pattern("*.Example.com:1")).unwrap(),
            json!("*.example.com:1")
        );
    }

    #[test]
    fn grants_check_the_parsed_url() {
        let target = url("https://api.example.com/x");
        assert_eq!(HttpGrant::Denied.check(&target), Err(HttpDenial::NotGranted));
        assert_eq!(HttpGrant::AnyHost.check(&target), Ok(()));

        let hosts = HttpGrant::Hosts(vec![pattern("*.example.com"), pattern("localhost:3000")]);
        assert_eq!(hosts.check(&target), Ok(()));
        assert_eq!(hosts.check(&url("http://localhost:3000/")), Ok(()));
        assert_eq!(
            hosts.check(&url("http://localhost/")),
            Err(HttpDenial::HostNotAllowed {
                host: "localhost:80".into()
            })
        );
        let denial = hosts.check(&url("https://evil.test/")).unwrap_err();
        assert!(denial.to_string().contains("'evil.test:443'"), "{denial}");

        // The wasi:http path canonicalizes before matching and, under an
        // allowlist, fails closed; without one nothing is second-guessed.
        assert_eq!(hosts.check_authority("API.Example.com", 443), Ok(()));
        assert!(hosts.check_authority("not a host", 443).is_err());
        assert!(hosts.check_authority("", 443).is_err());
        assert_eq!(HttpGrant::AnyHost.check_authority("example.com.", 80), Ok(()));
        assert_eq!(HttpGrant::AnyHost.check_authority("", 80), Ok(()));
        assert_eq!(
            HttpGrant::Denied.check_authority("x", 1),
            Err(HttpDenial::NotGranted)
        );
    }

    #[test]
    fn requests_are_validated_part_by_part() {
        assert!(queued("GET", "https://example.com/").validate().is_ok());
        assert!(queued("x-custom", "http://example.com").validate().is_ok());

        let invalid = |q: QueuedHttpRequest, hint: &str| match q.validate() {
            Err(HttpRequestError::InvalidRequest(why)) => assert!(why.contains(hint), "{why}"),
            other => panic!("expected invalid-request ({hint}), got {other:?}"),
        };
        let limit = |q: QueuedHttpRequest, hint: &str| match q.validate() {
            Err(HttpRequestError::LimitExceeded(why)) => assert!(why.contains(hint), "{why}"),
            other => panic!("expected limit-exceeded ({hint}), got {other:?}"),
        };

        invalid(queued("", "http://h/"), "method");
        invalid(queued("GE T", "http://h/"), "method");
        invalid(queued("G\r\nET", "http://h/"), "method");
        invalid(queued("connect", "http://h/"), "not allowed");
        invalid(queued("GET", "h/"), "http:// or https://");

        let with_header = |name: &str, value: &str| {
            let mut q = queued("GET", "http://h/");
            q.request.headers.push((name.into(), value.into()));
            q
        };
        assert!(with_header("Accept", "text/plain; q=0.5").validate().is_ok());
        for owned in ["Host", "content-length", "Connection", "Transfer-Encoding", "Proxy-Authorization", "te"] {
            invalid(with_header(owned, "x"), "set by the host");
        }
        invalid(with_header("bad name", "x"), "not an HTTP token");
        invalid(with_header("", "x"), "not an HTTP token");
        invalid(with_header("x", "a\r\nInjected: 1"), "control or non-ASCII");
        invalid(with_header("x", "caf\u{e9}"), "control or non-ASCII");

        let mut q = queued("GET", "http://h/");
        q.request.timeout_ms = Some(0);
        invalid(q, "timeout-ms");
        let mut q = queued("GET", "http://h/");
        q.then = String::new();
        invalid(q, "`then`");

        limit(
            queued("GET", &format!("http://h/{}", "a".repeat(MAX_HTTP_URL_BYTES))),
            "url",
        );
        let mut q = queued("GET", "http://h/");
        q.request.headers = vec![("x".into(), "y".into()); MAX_HTTP_HEADERS + 1];
        limit(q, "headers exceed");
        let mut q = queued("GET", "http://h/");
        q.request.headers = vec![("x".into(), "y".repeat(MAX_HTTP_HEADER_BYTES))];
        limit(q, "headers of");
        let mut q = queued("POST", "http://h/");
        q.request.body = Some(vec![0; MAX_HTTP_BODY_BYTES + 1]);
        limit(q, "body");
        let mut q = queued("POST", "http://h/");
        q.request.body = Some(vec![0; MAX_HTTP_BODY_BYTES]);
        assert!(q.validate().is_ok(), "the limit itself is allowed");
        let mut q = queued("GET", "http://h/");
        q.then = "t".repeat(MAX_HTTP_NAME_BYTES + 1);
        limit(q, "`then`");
        let mut q = queued("GET", "http://h/");
        q.tag = Some("t".repeat(MAX_HTTP_NAME_BYTES + 1));
        limit(q, "tag");
    }

    #[test]
    fn timeouts_default_and_clamp() {
        let mut q = queued("GET", "http://h/").request;
        assert_eq!(q.effective_timeout_ms(), DEFAULT_HTTP_TIMEOUT_MS);
        q.timeout_ms = Some(250);
        assert_eq!(q.effective_timeout_ms(), 250);
        q.timeout_ms = Some(u32::MAX);
        assert_eq!(q.effective_timeout_ms(), MAX_HTTP_TIMEOUT_MS);
    }

    fn payload(outcome: HttpOutcome, tag: Option<&str>) -> serde_json::Value {
        serde_json::from_slice(&outcome.into_payload(tag)).unwrap()
    }

    #[test]
    fn a_text_response_is_delivered_as_utf8_with_merged_lowercase_headers() {
        let outcome = HttpOutcome::Response(HttpResponse {
            status: 200,
            headers: vec![
                ("Content-Type".into(), "text/plain".into()),
                ("Set-Cookie".into(), "a=1".into()),
                ("set-cookie".into(), "b=2".into()),
            ],
            body: "h\u{e9}llo".as_bytes().to_vec(),
        });
        assert_eq!(
            payload(outcome, Some("t1")),
            json!({
                "ok": true,
                "status": 200,
                "headers": { "content-type": "text/plain", "set-cookie": "a=1, b=2" },
                "body": "h\u{e9}llo",
                "bodyEncoding": "utf8",
                "tag": "t1",
            })
        );
    }

    #[test]
    fn a_binary_response_is_base64_and_any_status_is_ok() {
        let outcome = HttpOutcome::Response(HttpResponse {
            status: 404,
            headers: Vec::new(),
            body: vec![0xff, 0xfe, 0x00, 0x01],
        });
        assert_eq!(
            payload(outcome, None),
            json!({
                "ok": true,
                "status": 404,
                "headers": {},
                "body": "//4AAQ==",
                "bodyEncoding": "base64",
                "tag": null,
            })
        );
    }

    #[test]
    fn failures_carry_kind_and_message() {
        for kind in [
            HttpFailureKind::Network,
            HttpFailureKind::Timeout,
            HttpFailureKind::Denied,
            HttpFailureKind::TooLarge,
            HttpFailureKind::InvalidResponse,
        ] {
            assert_eq!(HttpFailureKind::from_wire(kind.as_str()), Some(kind));
            assert_eq!(
                payload(HttpOutcome::Failure(HttpFailure::new(kind, "why")), Some("t")),
                json!({
                    "ok": false,
                    "error": { "kind": kind.as_str(), "message": "why" },
                    "tag": "t",
                })
            );
        }
        assert_eq!(HttpFailureKind::from_wire("nope"), None);
    }

    #[test]
    fn responses_the_contract_cannot_carry_become_failures() {
        let big = HttpOutcome::Response(HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: vec![b'a'; MAX_HTTP_RESPONSE_BODY_BYTES + 1],
        });
        assert_eq!(payload(big, None)["error"]["kind"], "too-large");
        let odd = HttpOutcome::Response(HttpResponse {
            status: 42,
            headers: Vec::new(),
            body: Vec::new(),
        });
        assert_eq!(payload(odd, None)["error"]["kind"], "invalid-response");
    }

    #[test]
    fn base64_matches_rfc_4648() {
        for (plain, encoded) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64_encode(plain.as_bytes()), encoded);
        }
        assert_eq!(base64_encode(&[0xfb, 0xff, 0xbf]), "+/+/");
    }
}
