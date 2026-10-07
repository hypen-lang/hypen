//! Server-wide settings shared by every connection: connection admission
//! (RFC 001 §5, optional), the device plane's options and opt-out (on by
//! default), the shared retained-bytes budget and rotating resume tokens.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use hypen_engine::device::{RetainedBytesPool, DEFAULT_PROCESS_RETAINED_BYTES};

/// The HTTP upgrade request of a WebSocket connection, as the host's
/// framework saw it (headers are compared case-insensitively).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpgradeRequest {
    pub headers: Vec<(String, String)>,
    pub path: String,
    pub remote_addr: Option<String>,
}

impl UpgradeRequest {
    pub fn new(path: impl Into<String>) -> Self {
        UpgradeRequest {
            path: path.into(),
            ..Default::default()
        }
    }

    /// Builder: add a header.
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// The first value of header `name` (case-insensitive).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The `Origin` header, when present (browsers always send one).
    pub fn origin(&self) -> Option<&str> {
        self.header("origin").filter(|o| !o.is_empty())
    }
}

/// The app's authenticator: `true` admits the upgrade.
pub type Authenticator = Arc<dyn Fn(&UpgradeRequest) -> bool + Send + Sync>;

/// The device plane's options (RFC 001). Every field `None` keeps the
/// default, so `DeviceOptions::default()` is the plane as it ships.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeviceOptions {
    /// Upload bytes one connection may retain (`None` = 128 MiB).
    pub max_retained_bytes: Option<u64>,
    /// Upload bytes retained across every connection of this server
    /// (`None` = 1 GiB, the engine's `DEFAULT_PROCESS_RETAINED_BYTES`).
    pub aggregate_retained_bytes: Option<u64>,
    /// A lower cap on a single uploaded item (`None` = registry limits).
    pub max_item_bytes: Option<u64>,
}

/// Server-wide settings shared by every connection: connection admission
/// (optional) and the device plane's options.
#[derive(Clone, Default)]
pub struct DeviceServerConfig {
    /// Exact `Origin` values a browser upgrade may carry
    /// (`https://app.example.com`). Compared as `scheme://host[:port]`,
    /// case-insensitively, with default ports removed. When the list is
    /// configured (non-empty), a request **with** an `Origin` not on it is
    /// refused 403 (cross-site WebSocket hijacking defence); requests
    /// without an `Origin` (native clients) are not affected by it.
    pub allowed_origins: Vec<String>,
    /// When set, it must return true for **every** upgrade, with or without
    /// an `Origin`, or the upgrade is refused 403. Native clients present
    /// app credentials (e.g. an `Authorization` upgrade header).
    pub authenticate: Option<Authenticator>,
    /// The device plane's options (see [`DeviceServer::configure_device`]).
    pub device: DeviceOptions,
}

impl std::fmt::Debug for DeviceServerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceServerConfig")
            .field("allowed_origins", &self.allowed_origins)
            .field("authenticate", &self.authenticate.is_some())
            .field("device", &self.device)
            .finish()
    }
}

impl DeviceServerConfig {
    /// Builder: allow a browser origin.
    pub fn allow_origin(mut self, origin: impl Into<String>) -> Self {
        self.allowed_origins.push(origin.into());
        self
    }

    /// Builder: set the authenticator.
    pub fn authenticate(
        mut self,
        f: impl Fn(&UpgradeRequest) -> bool + Send + Sync + 'static,
    ) -> Self {
        self.authenticate = Some(Arc::new(f));
        self
    }

    /// Builder: the device plane's options.
    pub fn device(mut self, options: DeviceOptions) -> Self {
        self.device = options;
        self
    }
}

/// The outcome of [`DeviceServer::admit`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    /// Accept the upgrade.
    Admitted,
    /// Refuse the upgrade with this HTTP status (403).
    Rejected { status: u16, reason: &'static str },
}

impl Admission {
    pub fn is_admitted(&self) -> bool {
        matches!(self, Admission::Admitted)
    }
}

/// The startup warning logged once per server when no admission is
/// configured.
pub const NO_ADMISSION_WARNING: &str =
    "no allowedOrigins/authenticate configured — any client can connect; set them in production";

/// Server-wide state shared by every connection (`Arc`): connection
/// admission (RFC 001 §5), the device plane's options and opt-out, the
/// aggregate upload budget, and the rotating resume tokens.
///
/// The device plane is **on by default**: a session built for a connection
/// ([`RemoteSession::connect`](crate::remote::RemoteSession::connect))
/// negotiates it for any client whose hello offers `device`, with no call.
/// Sessions use [`DeviceServer::shared`] unless given a server of their own.
pub struct DeviceServer {
    origins: Vec<String>,
    authenticate: Option<Authenticator>,
    options: Mutex<DeviceOptions>,
    pool: Mutex<RetainedBytesPool>,
    disabled: AtomicBool,
    tokens: Mutex<HashMap<String, String>>,
    /// Sessions that negotiated a device plane: only those need their
    /// resume token to resume (UI-only sessions keep id-only resume).
    device_sessions: Mutex<HashSet<String>>,
}

impl std::fmt::Debug for DeviceServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceServer")
            .field("origins", &self.origins)
            .field("authenticate", &self.authenticate.is_some())
            .field("options", &*self.options.lock().unwrap())
            .field("device_enabled", &self.device_enabled())
            .finish_non_exhaustive()
    }
}

/// Upper bound on remembered resume tokens (oldest dropped first).
const MAX_TOKENS: usize = 100_000;

fn pool_for(options: &DeviceOptions) -> RetainedBytesPool {
    RetainedBytesPool::new(
        options
            .aggregate_retained_bytes
            .unwrap_or(DEFAULT_PROCESS_RETAINED_BYTES),
    )
}

impl DeviceServer {
    /// A server's shared settings. Never fails: with neither
    /// `allowed_origins` nor an authenticator every upgrade is admitted
    /// (the UI-server behaviour) and one startup warning
    /// ([`NO_ADMISSION_WARNING`]) is logged.
    pub fn new(config: DeviceServerConfig) -> Arc<Self> {
        let origins: Vec<String> = config
            .allowed_origins
            .iter()
            .map(|o| normalize_origin(o))
            .collect();
        if origins.is_empty() && config.authenticate.is_none() {
            log::warn!("hypen: {NO_ADMISSION_WARNING}");
        }
        Arc::new(DeviceServer {
            origins,
            authenticate: config.authenticate,
            pool: Mutex::new(pool_for(&config.device)),
            options: Mutex::new(config.device),
            disabled: AtomicBool::new(false),
            tokens: Mutex::new(HashMap::new()),
            device_sessions: Mutex::new(HashSet::new()),
        })
    }

    /// The process-wide default server every session uses unless it was
    /// given one ([`RemoteSession::with_device_server`](crate::remote::RemoteSession::with_device_server)):
    /// no admission configured, default device options. Configure it like
    /// any other (`DeviceServer::shared().configure_device(...)`).
    pub fn shared() -> Arc<Self> {
        static SHARED: OnceLock<Arc<DeviceServer>> = OnceLock::new();
        Arc::clone(SHARED.get_or_init(|| DeviceServer::new(DeviceServerConfig::default())))
    }

    /// Set the device plane's options (the ones `enable_device` used to
    /// take). Connections negotiated from now on use them; `None` fields
    /// keep the defaults. A new aggregate budget starts a new pool (live
    /// connections keep the one they started with).
    pub fn configure_device(&self, options: DeviceOptions) {
        let mut current = self.options.lock().unwrap();
        if current.aggregate_retained_bytes != options.aggregate_retained_bytes {
            *self.pool.lock().unwrap() = pool_for(&options);
        }
        *current = options;
    }

    /// The device plane's current options.
    pub fn device_options(&self) -> DeviceOptions {
        self.options.lock().unwrap().clone()
    }

    /// Turn the device plane off for every session on this server — the
    /// single opt-out. Those sessions then behave exactly like the UI-only
    /// server did: no device negotiation, no resume tokens, id-only resume.
    /// (Per connection: [`RemoteSession::disable_device`](crate::remote::RemoteSession::disable_device).)
    pub fn disable_device(&self) {
        self.disabled.store(true, Ordering::SeqCst);
    }

    /// Whether sessions on this server negotiate the device plane (the
    /// default; false after [`Self::disable_device`]).
    pub fn device_enabled(&self) -> bool {
        !self.disabled.load(Ordering::SeqCst)
    }

    /// Whether any connection admission is configured.
    pub fn admission_configured(&self) -> bool {
        !self.origins.is_empty() || self.authenticate.is_some()
    }

    /// Device endpoints never negotiate `permessage-deflate` (RFC 001
    /// §2.3). Always `false`; the Rust WebSocket stacks cannot negotiate it
    /// anyway (see [`crate::remote`]).
    pub fn compression(&self) -> bool {
        false
    }

    /// Connection admission (RFC 001 §5) — the app's ordinary connection
    /// policy for UI and device traffic alike, each check applied exactly
    /// when configured:
    ///
    /// | Configured | Upgrade request | Result |
    /// |---|---|---|
    /// | allowlist | `Origin` not on it | 403 |
    /// | allowlist | `Origin` on it, or no `Origin` | next check |
    /// | authenticator | returns false (or panics) | 403 |
    /// | neither | anything | admitted (startup warning) |
    pub fn admit(&self, request: &UpgradeRequest) -> Admission {
        if !self.origins.is_empty() {
            match request.origin() {
                Some(origin) => {
                    if !self.origins.contains(&normalize_origin(origin)) {
                        return Admission::Rejected {
                            status: 403,
                            reason: "origin not allowed",
                        };
                    }
                }
                // An allowlist admits browsers only: a request without
                // Origin (a native client) needs the authenticator.
                None if self.authenticate.is_none() => {
                    return Admission::Rejected {
                        status: 403,
                        reason: "no Origin and no authenticator configured",
                    };
                }
                None => {}
            }
        }
        if let Some(auth) = &self.authenticate {
            let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| auth(request)))
                .unwrap_or(false);
            if !ok {
                return Admission::Rejected {
                    status: 403,
                    reason: "authenticator refused",
                };
            }
        }
        Admission::Admitted
    }

    pub(crate) fn pool(&self) -> RetainedBytesPool {
        self.pool.lock().unwrap().clone()
    }

    /// Whether `token` is the latest resume token issued for `session_id`
    /// (constant-time comparison).
    pub fn verify_resume(&self, session_id: &str, token: Option<&str>) -> bool {
        let Some(token) = token else { return false };
        let tokens = self.tokens.lock().unwrap();
        tokens
            .get(session_id)
            .is_some_and(|t| constant_time_eq(t.as_bytes(), token.as_bytes()))
    }

    /// Whether resuming `session_id` needs its resume token: exactly when
    /// that session negotiated a device plane. A UI-only session keeps the
    /// legacy id-only resume.
    pub fn requires_resume_token(&self, session_id: &str) -> bool {
        self.device_sessions.lock().unwrap().contains(session_id)
    }

    /// Whether a hello may resume `session_id` with `token`: always for a
    /// UI-only session, only with its latest token for a session that
    /// negotiated a device plane (otherwise the hello starts a **new**
    /// session — never an error, never a takeover).
    pub fn resume_allowed(&self, session_id: &str, token: Option<&str>) -> bool {
        !self.requires_resume_token(session_id) || self.verify_resume(session_id, token)
    }

    /// The session id a raw `hello` text may resume (see
    /// [`Self::resume_allowed`]), else `None` (a new session). Call before
    /// restoring suspended state with a
    /// [`SessionManager`](crate::remote::SessionManager).
    pub fn resume_target(&self, hello_text: &str) -> Option<String> {
        let v: serde_json::Value = serde_json::from_str(hello_text).ok()?;
        let id = v.get("sessionId")?.as_str()?;
        let token = v.get("resumeToken").and_then(|t| t.as_str());
        self.resume_allowed(id, token).then(|| id.to_string())
    }

    /// Record that `session_id` negotiated a device plane: resuming it
    /// requires its token from now on.
    pub(crate) fn mark_device_session(&self, session_id: &str) {
        let mut sessions = self.device_sessions.lock().unwrap();
        if sessions.len() >= MAX_TOKENS && !sessions.contains(session_id) {
            if let Some(k) = sessions.iter().next().cloned() {
                sessions.remove(&k);
            }
        }
        sessions.insert(session_id.to_string());
    }

    /// Issue (rotate) the resume token for `session_id`: 256 random bits,
    /// base64url.
    pub(crate) fn issue_token(&self, session_id: &str) -> Option<String> {
        let mut bytes = [0u8; 32];
        if let Err(e) = getrandom::getrandom(&mut bytes) {
            log::error!("hypen device: no randomness for a resume token: {e}");
            return None;
        }
        let token = base64url(&bytes);
        let mut tokens = self.tokens.lock().unwrap();
        if tokens.len() >= MAX_TOKENS && !tokens.contains_key(session_id) {
            if let Some(k) = tokens.keys().next().cloned() {
                tokens.remove(&k);
            }
        }
        tokens.insert(session_id.to_string(), token.clone());
        Some(token)
    }

    /// Forget a session's resume token and device mark (it expired or was
    /// destroyed).
    pub fn forget_session(&self, session_id: &str) {
        self.tokens.lock().unwrap().remove(session_id);
        self.device_sessions.lock().unwrap().remove(session_id);
    }
}

/// `scheme://host[:port]`, lowercase, default port removed, no path.
fn normalize_origin(origin: &str) -> String {
    let o = origin.trim().trim_end_matches('/').to_ascii_lowercase();
    let Some((scheme, rest)) = o.split_once("://") else {
        return o;
    };
    let host = rest.split('/').next().unwrap_or(rest);
    let host = match (scheme, host.rsplit_once(':')) {
        ("http" | "ws", Some((h, "80"))) | ("https" | "wss", Some((h, "443"))) => h,
        _ => host,
    };
    format!("{scheme}://{host}")
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn base64url(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let chars = chunk.len() + 1;
        for i in 0..chars {
            out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(origins: &[&str], auth: Option<&'static str>) -> Arc<DeviceServer> {
        let mut cfg = DeviceServerConfig::default();
        for o in origins {
            cfg = cfg.allow_origin(*o);
        }
        if let Some(token) = auth {
            cfg = cfg.authenticate(move |r| r.header("authorization") == Some(token));
        }
        DeviceServer::new(cfg)
    }

    fn req(origin: Option<&str>, auth: Option<&str>) -> UpgradeRequest {
        let mut r = UpgradeRequest::new("/ws");
        if let Some(o) = origin {
            r = r.with_header("Origin", o);
        }
        if let Some(a) = auth {
            r = r.with_header("Authorization", a);
        }
        r
    }

    #[test]
    fn no_admission_configured_admits_everyone_and_never_fails() {
        // Never refuses to start; the device plane is on by default.
        let open = DeviceServer::new(DeviceServerConfig::default());
        assert!(!open.admission_configured());
        assert!(open.device_enabled());
        assert!(open.admit(&req(None, None)).is_admitted());
        assert!(open
            .admit(&req(Some("https://evil.example"), None))
            .is_admitted());
        assert!(DeviceServer::shared().device_enabled());
    }

    #[test]
    fn admission_checks_apply_exactly_when_configured() {
        let browser_only = server(&["https://app.example.com"], None);
        assert!(browser_only.admission_configured());
        assert!(browser_only
            .admit(&req(Some("https://app.example.com"), None))
            .is_admitted());
        assert!(browser_only
            .admit(&req(Some("HTTPS://App.Example.com:443/"), None))
            .is_admitted());
        match browser_only.admit(&req(Some("https://evil.example"), None)) {
            Admission::Rejected { status, .. } => assert_eq!(status, 403),
            other => panic!("{other:?}"),
        }
        // An allowlist admits browsers only: without an authenticator a
        // request with no Origin (a native client) is refused, as in every
        // other SDK.
        assert!(!browser_only.admit(&req(None, None)).is_admitted());

        let native_only = server(&[], Some("Bearer ok"));
        assert!(native_only
            .admit(&req(None, Some("Bearer ok")))
            .is_admitted());
        assert!(!native_only.admit(&req(None, None)).is_admitted());
        assert!(native_only
            .admit(&req(Some("https://any.example"), Some("Bearer ok")))
            .is_admitted());

        let both = server(&["https://app.example.com"], Some("Bearer ok"));
        assert!(both.admit(&req(None, Some("Bearer ok"))).is_admitted());
        assert!(!both.admit(&req(None, Some("Bearer no"))).is_admitted());
        assert!(!both.admit(&req(None, None)).is_admitted());
        // The authenticator also runs for allowed origins.
        assert!(!both
            .admit(&req(Some("https://app.example.com"), None))
            .is_admitted());
        assert!(both
            .admit(&req(Some("https://app.example.com"), Some("Bearer ok")))
            .is_admitted());
        assert!(!both
            .admit(&req(Some("https://evil.example"), Some("Bearer ok")))
            .is_admitted());
        // A panicking authenticator refuses.
        let panicky =
            DeviceServer::new(DeviceServerConfig::default().authenticate(|_| panic!("boom")));
        assert!(!panicky.admit(&req(None, None)).is_admitted());
    }

    #[test]
    fn configure_and_disable_device() {
        let s = DeviceServer::new(DeviceServerConfig::default());
        assert_eq!(s.device_options(), DeviceOptions::default());
        let opts = DeviceOptions {
            max_retained_bytes: Some(1024),
            aggregate_retained_bytes: Some(4096),
            max_item_bytes: None,
        };
        s.configure_device(opts.clone());
        assert_eq!(s.device_options(), opts);
        assert!(s.device_enabled());
        s.disable_device();
        assert!(!s.device_enabled());
    }

    #[test]
    fn resume_tokens_rotate_and_compare_exactly() {
        let s = server(&[], Some("t"));
        let t1 = s.issue_token("s1").unwrap();
        assert_eq!(t1.len(), 43, "256 bits, base64url without padding");
        assert!(s.verify_resume("s1", Some(&t1)));
        assert!(!s.verify_resume("s1", None));
        assert!(!s.verify_resume("s2", Some(&t1)));
        let t2 = s.issue_token("s1").unwrap();
        assert_ne!(t1, t2);
        assert!(!s.verify_resume("s1", Some(&t1)), "rotated");
        s.mark_device_session("s1");
        let hello = format!(r#"{{"type":"hello","sessionId":"s1","resumeToken":"{t2}"}}"#);
        assert_eq!(s.resume_target(&hello).as_deref(), Some("s1"));
        assert_eq!(
            s.resume_target(r#"{"type":"hello","sessionId":"s1"}"#),
            None
        );
        s.forget_session("s1");
        assert!(!s.verify_resume("s1", Some(&t2)));
        assert!(!s.requires_resume_token("s1"));
    }

    #[test]
    fn only_device_sessions_require_their_token() {
        let s = DeviceServer::new(DeviceServerConfig::default());
        s.issue_token("ui");
        s.issue_token("dev");
        s.mark_device_session("dev");
        assert!(!s.requires_resume_token("ui"));
        assert!(
            s.resume_allowed("ui", None),
            "UI-only: legacy id-only resume"
        );
        assert!(s.requires_resume_token("dev"));
        assert!(!s.resume_allowed("dev", None));
        assert!(!s.resume_allowed("dev", Some("wrong")));
        assert_eq!(
            s.resume_target(r#"{"type":"hello","sessionId":"ui"}"#)
                .as_deref(),
            Some("ui")
        );
    }

    #[test]
    fn base64url_matches_the_reference_alphabet() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }
}
