//! Remote `HypenModule` implementation that streams the standard
//! [`RemoteMessage`] protocol over WebSocket.
//!
//! Counterpart to the TypeScript `RemoteServer` in
//! `hypen-web/packages/server`. The renderer doesn't care whether the
//! engine runs in-process or across the network — both paths satisfy
//! the `HypenModule` trait, so `DesktopApp::connect(url)` swaps out the
//! local engine for a `RemoteModule` without touching the rest of the
//! window / paint / layout pipeline.
//!
//! The worker connects, sends `hello`, streams patches, dispatches
//! actions, reconnects with backoff and resumes its session (with the
//! server's rotating `resumeToken` when it sends one).
//!
//! # Device capabilities (RFC 001)
//!
//! Unless disabled with [`RemoteOptions::device`], the module is also a
//! **DeviceHost** ([`crate::device`]): its `hello` advertises what the
//! desktop implements (`file.pick`, `gallery.pick`, `file.save` behind native
//! dialogs; `camera.capture`, `mic.record`, `bluetooth.scan`,
//! `bluetooth.select` and `permission.*` behind the window's host UI and the
//! hardware backends compiled in), it accepts the server's
//! `sessionAck.device`, and device
//! messages and binary frames are routed to the host instead of the patch
//! path. Without that advertisement a device-enabled server disables device
//! access for the connection and every server call answers `unavailable`
//! (`device-disabled`) — which is what this client did before it had a host.
//!
//! Device-enabled servers admit a connection that carries no `Origin` (this
//! client sends none) only through their authenticator: pass the app
//! credential with [`RemoteOptions::header`] (e.g. `Authorization`).
//!
//! # Robustness
//!
//! Nothing a server sends stops the patch stream. Text that is not a known
//! UI message is ignored; a `patch`/`initialTree` batch is decoded patch by
//! patch, so one malformed or unknown patch is skipped instead of dropping
//! the batch; malformed, unknown or invalid device messages and frames are
//! handled by the device host per RFC 001 §2.1 (ignored for unknown ids,
//! the request terminated for a live one, counted as connection-level
//! otherwise, the socket reset only after repeated violations).
//!
//! The socket is **uncompressed**: `tokio-tungstenite` cannot negotiate
//! `permessage-deflate`, so this client offers no WebSocket extensions.
//! That is fully interoperable with compression-enabled Hypen servers —
//! see the note at the `connect_async` call in `run_session` for the
//! ecosystem status and what would change it.

use crate::device::{origin_of, DesktopDevice, DeviceConfig, DriverMsg, WireOut};
use crate::module::HypenModule;
use hypen_engine::device::{device_message_type, is_oversize_device_text, top_level_member_text};
use hypen_engine::Patch;
use hypen_server::remote::RemoteMessage;
use serde::Deserialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

/// Cap on the reconnect backoff. Beyond this we keep retrying every
/// `MAX_BACKOFF_SECS` seconds — `RemoteServer` restarts during dev
/// usually finish well inside this window.
const MAX_BACKOFF_SECS: u64 = 30;
/// Hard cap on consecutive reconnect attempts before giving up. Set
/// generously so transient network drops don't end the session, but
/// not so high that a permanently-down server eats infinite power.
const MAX_RECONNECT_ATTEMPTS: u32 = 60;

/// Compute the reconnect-backoff delay for a given attempt number
/// (1-indexed: attempt 1 is the first retry after a disconnect).
/// Doubles each attempt — 1s, 2s, 4s, 8s, 16s — and caps at
/// `MAX_BACKOFF_SECS`. Pure function so tests can pin the curve.
pub(crate) fn backoff_for(attempt: u32) -> Duration {
    if attempt == 0 {
        return Duration::ZERO;
    }
    // attempt-1 keeps the first retry at 1s.
    let shift = (attempt - 1).min(5);
    let secs = 1u64 << shift;
    Duration::from_secs(secs.min(MAX_BACKOFF_SECS))
}

type PatchCallback = Arc<dyn Fn(&[Patch]) + Send + Sync>;
type StatusCallback = Arc<dyn Fn(&ConnectionStatus) + Send + Sync>;

/// Lifecycle of a [`RemoteModule`]'s WebSocket. Fired through
/// [`RemoteModule::on_status`] so the renderer (and, for our use,
/// the browser shell) can show a connecting spinner / error banner /
/// reconnecting indicator without polling.
///
/// State machine:
///
/// ```text
///  Connecting ──┬──> Connected ──> Reconnecting ──> Connecting ──┐
///               │       │                                          │
///               └──> Failed{kind}  <───── (give-up)  ─────────────┘
///                       │
///                       └──> Closed  (clean shutdown)
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionStatus {
    /// Worker is attempting the WebSocket handshake (first attempt or
    /// a reconnect after a `Reconnecting` state).
    Connecting,
    /// Handshake completed; the server sent `SessionAck`. The first
    /// patches usually arrive immediately after.
    Connected,
    /// Server dropped the connection (or the network did); a retry
    /// is queued and we're back to `Connecting` after the backoff.
    Reconnecting { attempt: u32 },
    /// All reconnect attempts exhausted (`MAX_RECONNECT_ATTEMPTS`).
    /// The worker has exited; no further patches will arrive.
    Failed { reason: String },
    /// Caller dropped the outbound channel — clean shutdown.
    Closed,
}

#[derive(Default)]
pub(crate) struct Inner {
    /// Callback set by `on_patches`. The window's `PatchQueue` lives
    /// behind this.
    callback: Option<PatchCallback>,
    /// Callback set by `on_status`. Fires every time the worker
    /// transitions between states in [`ConnectionStatus`].
    status_callback: Option<StatusCallback>,
    /// Latest status the worker reached. Replayed to a late
    /// `on_status` wiring so the UI doesn't miss the initial
    /// "Connecting" state because of the wire-up race.
    last_status: Option<ConnectionStatus>,
    /// Patches that arrived from the network *before* the renderer
    /// wired its callback. Drained on the first `on_patches` call so
    /// no initial tree is lost to the connect/wire-up race.
    pending: Vec<Patch>,
}

/// How a [`RemoteModule`] connects.
#[derive(Clone, Debug)]
pub struct RemoteOptions {
    /// Extra HTTP headers on every WebSocket upgrade (reconnects included),
    /// e.g. `Authorization`: device-enabled servers admit native clients —
    /// which send no `Origin` — only through their authenticator (RFC 001 §5).
    pub headers: Vec<(String, String)>,
    /// The device host (RFC 001). `Some` by default ([`DeviceConfig::native`]);
    /// `None` connects UI-only (no `hello.device`, device calls on the server
    /// answer `unavailable`).
    pub device: Option<DeviceConfig>,
}

impl Default for RemoteOptions {
    fn default() -> Self {
        RemoteOptions {
            headers: Vec::new(),
            device: Some(DeviceConfig::native()),
        }
    }
}

impl RemoteOptions {
    /// Add an upgrade header (e.g. `("Authorization", "Bearer …")`).
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// Replace (or with `None`, remove) the device host.
    pub fn device(mut self, device: Option<DeviceConfig>) -> Self {
        self.device = device;
        self
    }
}

pub struct RemoteModule {
    /// Module name the server registered. Travels with every
    /// `DispatchAction` so the server routes to the right module.
    module_name: String,
    inner: Arc<Mutex<Inner>>,
    outbound: mpsc::UnboundedSender<RemoteMessage>,
}

impl RemoteModule {
    /// Open a WebSocket to `url`, log in as `module_name`, and start
    /// pumping patches. Spawns a worker OS thread that owns its own
    /// single-threaded tokio runtime so the (sync) winit event loop
    /// stays sync.
    pub fn connect(url: impl Into<String>, module_name: impl Into<String>) -> Self {
        Self::connect_with(url, module_name, RemoteOptions::default())
    }

    /// [`Self::connect`] with explicit [`RemoteOptions`] (upgrade headers,
    /// device host).
    pub fn connect_with(
        url: impl Into<String>,
        module_name: impl Into<String>,
        options: RemoteOptions,
    ) -> Self {
        let url = url.into();
        let module_name = module_name.into();
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        let (outbound_tx, outbound_rx) = mpsc::unbounded_channel::<RemoteMessage>();

        let inner_for_worker = Arc::clone(&inner);
        let module_for_worker = module_name.clone();
        let url_for_worker = url.clone();
        std::thread::Builder::new()
            .name(format!("hypen-remote:{module_name}"))
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("tokio rt");
                rt.block_on(run_worker(
                    url_for_worker,
                    module_for_worker,
                    outbound_rx,
                    inner_for_worker,
                    options,
                ));
            })
            .expect("spawn remote worker");

        Self {
            module_name,
            inner,
            outbound: outbound_tx,
        }
    }
}

/// Deliver a patch batch to the renderer. If `on_patches` has been
/// wired we fire the callback; otherwise we buffer for the first
/// `on_patches` call to drain. Lock is released before firing the
/// callback so the renderer's queue mutex doesn't contend with ours.
pub(crate) fn deliver_patches(inner: &Arc<Mutex<Inner>>, patches: &[Patch]) {
    let cb = {
        let mut guard = inner.lock().expect("remote inner poisoned");
        if let Some(cb) = guard.callback.as_ref() {
            Some(Arc::clone(cb))
        } else {
            guard.pending.extend_from_slice(patches);
            None
        }
    };
    if let Some(cb) = cb {
        cb(patches);
    }
}

/// Stamp `last_status` and fire the status callback if one is wired.
/// Pure side-channel — never blocks on the patch queue / outbound
/// channel — so worker-side callers can call it freely without
/// risking a stall on a busy UI thread.
pub(crate) fn deliver_status(inner: &Arc<Mutex<Inner>>, status: ConnectionStatus) {
    let cb = {
        let mut guard = inner.lock().expect("remote inner poisoned");
        guard.last_status = Some(status.clone());
        guard.status_callback.as_ref().map(Arc::clone)
    };
    if let Some(cb) = cb {
        cb(&status);
    }
}

/// Why a single session ended. Drives whether the outer loop tries
/// again (with backoff) or exits.
enum SessionEnd {
    /// Caller dropped the outbound channel — clean shutdown, don't
    /// reconnect.
    Shutdown,
    /// The server / network ended the session in a way that justifies
    /// a reconnect attempt.
    Disconnected,
}

/// What survives a reconnect: the ids a resume presents.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Resume {
    /// `sessionAck.sessionId` of the last session.
    pub(crate) session_id: Option<String>,
    /// The latest `sessionAck.resumeToken` (device-enabled servers rotate it
    /// on every ack; without it they start a new session, RFC 001 §5).
    pub(crate) resume_token: Option<String>,
}

async fn run_worker(
    url: String,
    module_name: String,
    mut outbound: mpsc::UnboundedReceiver<RemoteMessage>,
    inner: Arc<Mutex<Inner>>,
    options: RemoteOptions,
) {
    let mut resume = Resume::default();
    let mut attempt: u32 = 0;
    // Dialog answers come back on this channel; the worker keeps a sender so
    // `recv` never reports "closed" while the device host is idle.
    let (driver_tx, mut driver_rx) = mpsc::unbounded_channel::<DriverMsg>();
    let mut device = options
        .device
        .as_ref()
        .map(|cfg| DesktopDevice::new(cfg, driver_tx.clone()));
    // First connect attempt — surface the Connecting state before
    // the TCP handshake even starts so the UI has time to render
    // a spinner.
    deliver_status(&inner, ConnectionStatus::Connecting);
    loop {
        let result = run_session(
            &url,
            &options.headers,
            &module_name,
            &mut resume,
            &mut outbound,
            &inner,
            device.as_mut(),
            &mut driver_rx,
        )
        .await;
        if let Some(device) = device.as_mut() {
            // Connection loss: stop every device operation, delete temp
            // files, send nothing (§2.5). The next socket re-advertises.
            device.detach();
        }
        match result {
            Ok(SessionEnd::Shutdown) => {
                log::info!("remote: shutdown requested; exiting worker");
                deliver_status(&inner, ConnectionStatus::Closed);
                break;
            }
            Ok(SessionEnd::Disconnected) | Err(_) => {
                if let Err(e) = &result {
                    log::warn!("remote: {e}");
                }
                attempt = attempt.saturating_add(1);
                if attempt > MAX_RECONNECT_ATTEMPTS {
                    log::error!(
                        "remote: giving up after {MAX_RECONNECT_ATTEMPTS} reconnect attempts",
                    );
                    deliver_status(
                        &inner,
                        ConnectionStatus::Failed {
                            reason: format!(
                                "could not connect to {url} after \
                                {MAX_RECONNECT_ATTEMPTS} attempts"
                            ),
                        },
                    );
                    break;
                }
                let delay = backoff_for(attempt);
                log::warn!(
                    "remote: disconnected (attempt {attempt}); retrying in {:?}",
                    delay,
                );
                deliver_status(&inner, ConnectionStatus::Reconnecting { attempt });
                tokio::time::sleep(delay).await;
                deliver_status(&inner, ConnectionStatus::Connecting);
            }
        }
    }
    drop(driver_tx);
}

/// Build the upgrade request: the URL plus the configured headers.
fn upgrade_request(
    url: &str,
    headers: &[(String, String)],
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};
    let mut req = url
        .into_client_request()
        .map_err(|e| format!("bad url {url}: {e}"))?;
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|e| format!("bad header name {name:?}: {e}"))?;
        let value = HeaderValue::from_str(value)
            .map_err(|e| format!("bad header value for {name}: {e}"))?;
        req.headers_mut().append(name, value);
    }
    Ok(req)
}

/// Run a single connect → handshake → pump cycle. Captures the session
/// id and resume token from `SessionAck` so reconnects can resume. Returns
/// `Shutdown` only when the outbound channel hangs up.
#[allow(clippy::too_many_arguments)]
async fn run_session(
    url: &str,
    headers: &[(String, String)],
    module_name: &str,
    resume: &mut Resume,
    outbound: &mut mpsc::UnboundedReceiver<RemoteMessage>,
    inner: &Arc<Mutex<Inner>>,
    mut device: Option<&mut DesktopDevice>,
    driver_rx: &mut mpsc::UnboundedReceiver<DriverMsg>,
) -> Result<SessionEnd, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{
        connect_async,
        tungstenite::protocol::{frame::coding::CloseCode, CloseFrame, Message as WsMsg},
    };

    log::info!(
        "remote: connecting to {url} (resume session={:?})",
        resume.session_id.as_deref(),
    );
    // NOTE: no `permessage-deflate` — this client always runs uncompressed.
    //
    // Hypen enables WebSocket compression by default in its other SDKs, but
    // `tokio-tungstenite` (pinned at 0.24 here) cannot negotiate it. No
    // published `tungstenite`/`tokio-tungstenite` release up to and including
    // 0.30.0 exposes a `deflate`/compression feature or depends on a
    // compression crate; the README still says "There is no support for
    // permessage-deflate at the moment". Upstream issue
    // https://github.com/snapview/tungstenite-rs/issues/2 has been open since
    // 2017 — an implementation merged as PR #328 and was then reverted, and
    // the re-land (PR #426) remains unmerged. So there is no version bump
    // that would turn compression on; the dep is deliberately left alone.
    //
    // This is interoperable, not broken. `permessage-deflate` is negotiated
    // per connection and optional (RFC 7692): we simply never send a
    // `Sec-WebSocket-Extensions` offer, so a compression-enabled Hypen server
    // has nothing to accept and both peers speak plain frames. Connecting to a
    // server that compresses for browser/OkHttp clients works unchanged — this
    // client just pays full bandwidth for the patch stream. It is also exactly
    // what the device plane requires (RFC 001 §2.3: device traffic never
    // shares a DEFLATE context), so the device host needs no extra check.
    //
    // Re-check on any `tokio-tungstenite` bump: if snapview/tungstenite-rs#426
    // merges, enable the `deflate` feature and offer the extension here — and
    // then keep the device plane off on compressed sockets.
    let request = upgrade_request(url, headers)?;
    let (ws_stream, _resp) = connect_async(request)
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    let (mut sink, mut stream) = ws_stream.split();
    log::info!("remote: connected (module={module_name})");

    // A fresh device connection: new ids, new selection (§2.5).
    if let Some(device) = device.as_deref_mut() {
        device.attach(origin_of(url));
    }

    // Hello — replay our session_id (and the latest resume token) if we
    // have one so the server can resume; otherwise it'll mint a new one.
    let hello = build_hello(
        resume.session_id.clone(),
        resume.resume_token.clone(),
        device.as_deref().map(DesktopDevice::hello_device),
    );
    let hello_text = hello.to_json().map_err(|e| format!("encode Hello: {e}"))?;
    sink.send(WsMsg::Text(hello_text))
        .await
        .map_err(|e| format!("send Hello: {e}"))?;

    loop {
        let deadline = device.as_deref().and_then(DesktopDevice::next_deadline);
        let bulk_ready = device.as_deref().is_some_and(DesktopDevice::has_ready_work);
        tokio::select! {
            biased;

            incoming = stream.next() => match incoming {
                Some(Ok(WsMsg::Text(text))) => {
                    route_text(text.as_ref(), inner, resume, device.as_deref_mut());
                }
                Some(Ok(WsMsg::Binary(frame))) => {
                    // Binary frames are device frames (RFC 001 §2.3); a
                    // client without a device host drops them.
                    if let Some(device) = device.as_deref_mut() {
                        device.on_frame(&frame);
                    }
                }
                Some(Ok(WsMsg::Close(_))) | None => {
                    log::info!("remote: server closed connection");
                    return Ok(SessionEnd::Disconnected);
                }
                Some(Ok(_)) => {} // Ping/Pong — tungstenite handles.
                Some(Err(e)) => {
                    log::warn!("remote: stream error: {e}");
                    return Ok(SessionEnd::Disconnected);
                }
            },

            outgoing = outbound.recv() => match outgoing {
                Some(msg) => {
                    let text = match msg.to_json() {
                        Ok(t) => t,
                        Err(e) => {
                            log::warn!("remote: encode action: {e}");
                            continue;
                        }
                    };
                    if let Err(e) = sink.send(WsMsg::Text(text)).await {
                        log::warn!("remote: send action: {e}");
                        return Ok(SessionEnd::Disconnected);
                    }
                }
                None => return Ok(SessionEnd::Shutdown),
            },

            Some(msg) = driver_rx.recv() => {
                if let Some(device) = device.as_deref_mut() {
                    device.on_driver(msg);
                }
            },

            _ = sleep_until_opt(deadline) => {
                if let Some(device) = device.as_deref_mut() {
                    device.tick();
                }
            },

            // Bulk upload turns run only when nothing above is ready: UI
            // messages and controls are served before the next chunk (§2.3).
            _ = std::future::ready(()), if bulk_ready => {},
        }

        // Put whatever the device host produced on the wire, in order.
        if let Some(device) = device.as_deref_mut() {
            for out in device.drain() {
                let sent = match out {
                    WireOut::Text(t) => sink.send(WsMsg::Text(t)).await,
                    WireOut::Binary(b) => sink.send(WsMsg::Binary(b)).await,
                    WireOut::Close(code, reason) => {
                        log::warn!("remote: device host closing the socket ({code}): {reason}");
                        let frame = CloseFrame {
                            code: CloseCode::from(code),
                            reason: reason.into(),
                        };
                        let _ = sink.send(WsMsg::Close(Some(frame))).await;
                        return Ok(SessionEnd::Disconnected);
                    }
                };
                if let Err(e) = sent {
                    log::warn!("remote: device send failed: {e}");
                    return Ok(SessionEnd::Disconnected);
                }
            }
        }
    }
}

async fn sleep_until_opt(deadline: Option<std::time::Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await,
        None => std::future::pending().await,
    }
}

/// Build the Hello payload. Pulled out as a free function so tests
/// can assert the shape without spinning up a worker.
pub(crate) fn build_hello(
    session_id: Option<String>,
    resume_token: Option<String>,
    device: Option<Value>,
) -> RemoteMessage {
    // A token only means something together with the id it resumes.
    let resume_token = resume_token.filter(|_| session_id.is_some());
    RemoteMessage::Hello {
        session_id,
        props: None,
        device,
        resume_token,
    }
}

/// Route one text message: device messages (and over-limit text claiming a
/// device type) to the device host, everything else to the UI path.
pub(crate) fn route_text(
    text: &str,
    inner: &Arc<Mutex<Inner>>,
    resume: &mut Resume,
    device: Option<&mut DesktopDevice>,
) {
    if is_oversize_device_text(text) || device_message_type(text).is_some() {
        match device {
            Some(device) => device.on_text(text),
            None => log::debug!("remote: dropping a device message (no device host)"),
        }
        return;
    }
    handle_incoming(text, inner, resume, device);
}

/// Decode a `patches` array one patch at a time: a malformed or unknown
/// patch is skipped (and logged) instead of dropping the whole batch.
pub(crate) fn decode_patches_lenient(value: Option<&Value>) -> Vec<Patch> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    let mut patches = Vec::with_capacity(items.len());
    let mut skipped = 0usize;
    for item in items {
        match Patch::deserialize(item) {
            Ok(p) => patches.push(p),
            Err(e) => {
                skipped += 1;
                if skipped <= 3 {
                    log::warn!("remote: skipping a malformed patch: {e}");
                }
            }
        }
    }
    if skipped > 3 {
        log::warn!("remote: skipped {skipped} malformed patches in one batch");
    }
    patches
}

pub(crate) fn handle_incoming(
    text: &str,
    inner: &Arc<Mutex<Inner>>,
    resume: &mut Resume,
    device: Option<&mut DesktopDevice>,
) {
    let value: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("remote: ignoring malformed message: {e}");
            return;
        }
    };
    // Patch batches are decoded patch by patch (see
    // `decode_patches_lenient`); everything else as a whole message.
    match value.get("type").and_then(Value::as_str) {
        Some("patch") | Some("initialTree") => {
            let patches = decode_patches_lenient(value.get("patches"));
            if !patches.is_empty() {
                deliver_patches(inner, &patches);
            }
            return;
        }
        Some(_) => {}
        None => {
            log::warn!("remote: ignoring a message without a type");
            return;
        }
    }
    let msg: RemoteMessage = match serde_json::from_value(value) {
        Ok(m) => m,
        Err(e) => {
            log::warn!("remote: ignoring malformed message: {e}");
            return;
        }
    };
    match msg {
        RemoteMessage::SessionAck {
            session_id: id,
            is_new,
            is_restored,
            resume_token,
            ..
        } => {
            log::info!("remote: session ack id={id} new={is_new} restored={is_restored}",);
            resume.session_id = Some(id);
            // A device-enabled server rotates the token on every ack; a
            // server without the device plane sends none (legacy resume).
            resume.resume_token = resume_token;
            if let Some(device) = device {
                // The exact `sessionAck.device` text goes to the strict
                // decoder; a duplicated member is ambiguous and disables
                // the device plane (it never guesses).
                match top_level_member_text(text, "device") {
                    Ok(raw) => device.on_ack(raw),
                    Err(()) => {
                        // An empty text never decodes: the plane stays
                        // disabled for this socket.
                        log::warn!("remote: ambiguous sessionAck.device — device plane disabled");
                        device.on_ack(Some(""));
                    }
                }
            }
            // Handshake done — UI can drop the spinner now.
            deliver_status(inner, ConnectionStatus::Connected);
        }
        RemoteMessage::InitialTree { patches, .. } | RemoteMessage::Patch { patches, .. } => {
            if !patches.is_empty() {
                deliver_patches(inner, &patches);
            }
        }
        RemoteMessage::StateUpdate { .. } => {
            // Tooling hook — Studio uses these. Renderer doesn't act
            // on raw state updates today.
        }
        RemoteMessage::SessionExpired { reason, .. } => {
            log::warn!("remote: session expired: {reason}");
            // Drop our id so the next reconnect mints a fresh one
            // instead of failing the resume handshake again.
            resume.session_id = None;
            resume.resume_token = None;
        }
        // Client→server variants — ignore if they ever bounce back.
        RemoteMessage::Hello { .. }
        | RemoteMessage::DispatchAction { .. }
        | RemoteMessage::SubscribeState { .. } => {}
    }
}

impl RemoteModule {
    /// Subscribe to lifecycle transitions of the underlying WebSocket
    /// (Connecting → Connected → Reconnecting → … → Failed | Closed).
    /// Fires immediately with the current state if one was already
    /// recorded, so wiring `on_status` after the worker started
    /// doesn't drop the initial `Connecting` event on the floor.
    pub fn on_status<F>(&self, cb: F)
    where
        F: Fn(&ConnectionStatus) + Send + Sync + 'static,
    {
        let cb: StatusCallback = Arc::new(cb);
        let last = {
            let mut g = self.inner.lock().expect("remote inner poisoned");
            g.status_callback = Some(Arc::clone(&cb));
            g.last_status.clone()
        };
        if let Some(s) = last {
            cb(&s);
        }
    }
}

impl HypenModule for RemoteModule {
    fn on_patches(&self, cb: PatchCallback) {
        let pending = {
            let mut guard = self.inner.lock().expect("remote inner poisoned");
            guard.callback = Some(Arc::clone(&cb));
            std::mem::take(&mut guard.pending)
        };
        if !pending.is_empty() {
            cb(&pending);
        }
    }

    fn mount(&self) {
        // Worker is already running and the server pushes the initial
        // tree right after `Hello` / `SessionAck`, so there's nothing
        // for us to do here. The renderer's `redraw` path will drain
        // any patches the callback has already delivered to the
        // `PatchQueue`.
    }

    fn dispatch_action(&self, name: &str, payload: Option<Value>) {
        let msg = RemoteMessage::DispatchAction {
            module: self.module_name.clone(),
            action: name.to_string(),
            payload,
        };
        if let Err(e) = self.outbound.send(msg) {
            log::warn!("remote: action dispatch dropped (worker gone): {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    use serde_json::json;

    fn fake_patch(id: &str, kind: &str) -> Patch {
        Patch::Create {
            id: id.into(),
            element_type: kind.into(),
            props: Arc::new(IndexMap::new()),
            semantics: None,
        }
    }

    // ---------------------------------------------------------------
    // deliver_patches — the buffer/drain race
    // ---------------------------------------------------------------

    #[test]
    fn deliver_buffers_patches_when_no_callback_is_set() {
        let inner = Arc::new(Mutex::new(Inner::default()));
        deliver_patches(&inner, &[fake_patch("a", "Text")]);
        deliver_patches(&inner, &[fake_patch("b", "Text")]);
        let g = inner.lock().unwrap();
        assert_eq!(g.pending.len(), 2);
        assert!(g.callback.is_none());
    }

    #[test]
    fn deliver_fires_callback_when_set() {
        let inner = Arc::new(Mutex::new(Inner::default()));
        let received: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&received);
        let cb: PatchCallback = Arc::new(move |p: &[Patch]| {
            captured.lock().unwrap().extend_from_slice(p);
        });
        inner.lock().unwrap().callback = Some(cb);

        deliver_patches(&inner, &[fake_patch("a", "Text"), fake_patch("b", "Text")]);
        assert_eq!(received.lock().unwrap().len(), 2);
        // Buffer stays empty when the callback is live.
        assert!(inner.lock().unwrap().pending.is_empty());
    }

    #[test]
    fn module_on_patches_drains_pending_on_first_wiring() {
        // Simulate the connect-race: patches arrive before the
        // renderer wires `on_patches`. Verify the wiring drains the
        // backlog so the initial tree isn't lost.
        let (tx, _rx) = mpsc::unbounded_channel::<RemoteMessage>();
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        let module = RemoteModule {
            module_name: "Test".into(),
            inner: Arc::clone(&inner),
            outbound: tx,
        };

        deliver_patches(&inner, &[fake_patch("root_a", "Column")]);
        deliver_patches(&inner, &[fake_patch("a_text", "Text")]);

        let received: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&received);
        module.on_patches(Arc::new(move |p: &[Patch]| {
            captured.lock().unwrap().extend_from_slice(p);
        }));

        let got = received.lock().unwrap();
        assert_eq!(got.len(), 2, "pending patches should drain on wiring");
        assert!(matches!(got[0], Patch::Create { ref id, .. } if id.as_ref() == "root_a"));
        assert!(matches!(got[1], Patch::Create { ref id, .. } if id.as_ref() == "a_text"));
    }

    // ---------------------------------------------------------------
    // dispatch_action wire shape
    // ---------------------------------------------------------------

    #[test]
    fn dispatch_action_sends_correct_remote_message() {
        let (tx, mut rx) = mpsc::unbounded_channel::<RemoteMessage>();
        let module = RemoteModule {
            module_name: "Counter".into(),
            inner: Arc::new(Mutex::new(Inner::default())),
            outbound: tx,
        };

        module.dispatch_action("increment", None);
        module.dispatch_action("set_value", Some(json!({"value": 42})));

        // Pop both messages and assert their shape.
        let m1 = rx.try_recv().expect("first action queued");
        match m1 {
            RemoteMessage::DispatchAction {
                module,
                action,
                payload,
            } => {
                assert_eq!(module, "Counter");
                assert_eq!(action, "increment");
                assert!(payload.is_none());
            }
            other => panic!("expected DispatchAction, got {other:?}"),
        }
        let m2 = rx.try_recv().expect("second action queued");
        match m2 {
            RemoteMessage::DispatchAction {
                module,
                action,
                payload,
            } => {
                assert_eq!(module, "Counter");
                assert_eq!(action, "set_value");
                assert_eq!(payload, Some(json!({"value": 42})));
            }
            other => panic!("expected DispatchAction, got {other:?}"),
        }
    }

    #[test]
    fn handle_incoming_decodes_initial_tree_and_fires_callback() {
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        let received: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&received);
        inner.lock().unwrap().callback = Some(Arc::new(move |p: &[Patch]| {
            captured.lock().unwrap().extend_from_slice(p);
        }));
        let mut resume = Resume::default();

        let initial_tree = json!({
            "type": "initialTree",
            "module": "Counter",
            "state": {"count": 0},
            "patches": [
                {
                    "type": "create",
                    "id": "1",
                    "elementType": "Text",
                    "props": {"0": "Hello"}
                }
            ],
            "revision": 1
        })
        .to_string();

        handle_incoming(&initial_tree, &inner, &mut resume, None);
        let got = received.lock().unwrap();
        assert_eq!(got.len(), 1);
        assert!(matches!(got[0], Patch::Create { ref id, .. } if id.as_ref() == "1"));
    }

    #[test]
    fn handle_incoming_ignores_malformed_messages_without_panicking() {
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        let mut resume = Resume::default();
        handle_incoming("{not json}", &inner, &mut resume, None);
        handle_incoming(r#"{"type":"unknownVariant"}"#, &inner, &mut resume, None);
        assert!(inner.lock().unwrap().pending.is_empty());
        assert!(resume.session_id.is_none());
        assert!(resume.resume_token.is_none());
    }

    #[test]
    fn handle_incoming_session_ack_captures_session_id_for_resume() {
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        let mut resume = Resume::default();
        let session_ack = json!({
            "type": "sessionAck",
            "sessionId": "session-abc-123",
            "isNew": true,
            "isRestored": false,
        })
        .to_string();
        handle_incoming(&session_ack, &inner, &mut resume, None);
        assert_eq!(resume.session_id.as_deref(), Some("session-abc-123"));
        assert!(inner.lock().unwrap().pending.is_empty());
    }

    #[test]
    fn handle_incoming_session_expired_drops_resume_id() {
        // After SessionAck we hold an id; SessionExpired must clear
        // it so the next reconnect mints a fresh session instead of
        // failing the resume handshake repeatedly.
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        let mut resume = Resume {
            session_id: Some("expired-id".into()),
            resume_token: Some("tok".into()),
        };
        let expired = json!({
            "type": "sessionExpired",
            "sessionId": "expired-id",
            "reason": "idle timeout"
        })
        .to_string();
        handle_incoming(&expired, &inner, &mut resume, None);
        assert!(resume.session_id.is_none());
        assert!(resume.resume_token.is_none());
    }

    // ---------------------------------------------------------------
    // Reconnect backoff + Hello shape
    // ---------------------------------------------------------------

    #[test]
    fn backoff_doubles_then_caps_at_thirty_seconds() {
        assert_eq!(backoff_for(0), Duration::from_secs(0));
        assert_eq!(backoff_for(1), Duration::from_secs(1));
        assert_eq!(backoff_for(2), Duration::from_secs(2));
        assert_eq!(backoff_for(3), Duration::from_secs(4));
        assert_eq!(backoff_for(4), Duration::from_secs(8));
        assert_eq!(backoff_for(5), Duration::from_secs(16));
        assert_eq!(backoff_for(6), Duration::from_secs(MAX_BACKOFF_SECS));
        // Past the shift cap — stays clamped.
        assert_eq!(backoff_for(20), Duration::from_secs(MAX_BACKOFF_SECS));
        assert_eq!(backoff_for(u32::MAX), Duration::from_secs(MAX_BACKOFF_SECS));
    }

    #[test]
    fn build_hello_serialises_session_id_when_present() {
        let hello = build_hello(Some("resume-me".into()), None, None);
        let json = serde_json::to_value(&hello).expect("encode");
        assert_eq!(json["type"], "hello");
        assert_eq!(json["sessionId"], "resume-me");
    }

    #[test]
    fn build_hello_omits_session_id_for_fresh_connect() {
        let hello = build_hello(None, None, None);
        let json = serde_json::to_value(&hello).expect("encode");
        assert_eq!(json["type"], "hello");
        assert!(
            json.get("sessionId").is_none(),
            "fresh Hello must not carry a sessionId field, got {json:?}",
        );
    }

    // ---------------------------------------------------------------
    // Device routing + robustness (RFC 001 §2.1; tester report "malformed
    // messages break desktop rendering")
    // ---------------------------------------------------------------

    fn capture(inner: &Arc<Mutex<Inner>>) -> Arc<Mutex<Vec<Patch>>> {
        let received: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&received);
        inner.lock().unwrap().callback = Some(Arc::new(move |p: &[Patch]| {
            captured.lock().unwrap().extend_from_slice(p);
        }));
        received
    }

    fn test_device() -> DesktopDevice {
        struct NoDialogs;
        impl crate::device::FileDialogs for NoDialogs {
            fn pick_files(
                &self,
                _: &crate::device::PickDialog,
            ) -> Result<Option<Vec<std::path::PathBuf>>, crate::device::DialogUnavailable>
            {
                Ok(None)
            }
            fn save_file(
                &self,
                _: &crate::device::SaveDialog,
            ) -> Result<Option<std::path::PathBuf>, crate::device::DialogUnavailable> {
                Ok(None)
            }
        }
        let (tx, _rx) = mpsc::unbounded_channel();
        DesktopDevice::new(&DeviceConfig::with_dialogs(Arc::new(NoDialogs)), tx)
    }

    #[test]
    fn build_hello_carries_the_device_advertisement_and_resume_token() {
        let device = test_device();
        let hello = build_hello(
            Some("s-1".into()),
            Some("tok".into()),
            Some(device.hello_device()),
        );
        let json = serde_json::to_value(&hello).unwrap();
        assert_eq!(json["resumeToken"], "tok");
        assert_eq!(json["device"]["protocolVersions"], json!([1]));
        let names: Vec<&str> = json["device"]["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "core.capabilities",
                "file.pick",
                "gallery.pick",
                "file.save"
            ]
        );
        // A token never travels without the id it resumes.
        let fresh = serde_json::to_value(build_hello(None, Some("tok".into()), None)).unwrap();
        assert!(fresh.get("resumeToken").is_none() && fresh.get("device").is_none());
    }

    #[test]
    fn session_ack_selects_the_device_plane_and_rotates_the_token() {
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        let mut device = test_device();
        device.attach("ws://localhost:1".into());
        let mut resume = Resume::default();
        let ack = json!({"type":"sessionAck","sessionId":"s","isNew":true,"isRestored":false,
            "resumeToken":"t1",
            "device":{"protocolVersion":1,"binary":true,"capabilities":[
                {"name":"core.capabilities","version":1},{"name":"file.save","version":1}]}});
        handle_incoming(&ack.to_string(), &inner, &mut resume, Some(&mut device));
        assert_eq!(resume.resume_token.as_deref(), Some("t1"));
        let live: Vec<String> = device.host().live_selection().keys().cloned().collect();
        assert_eq!(live, ["core.capabilities", "file.save"]);
        // A later ack from a server without the device plane drops the token.
        let legacy = json!({"type":"sessionAck","sessionId":"s","isNew":false,"isRestored":true});
        handle_incoming(&legacy.to_string(), &inner, &mut resume, Some(&mut device));
        assert!(resume.resume_token.is_none());
    }

    #[test]
    fn device_messages_are_routed_to_the_host_never_to_the_patch_path() {
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        let received = capture(&inner);
        let mut resume = Resume::default();
        let request = json!({"type":"deviceRequest","id":1,"capability":"core.capabilities",
            "version":1,"owner":{"connection":true},"lifetime":"connection",
            "timeoutMs":1000,"initialCredit":8,"params":{}})
        .to_string();
        // Without a device host: dropped quietly.
        route_text(&request, &inner, &mut resume, None);
        // With a host that has no selection yet: ignored (no traffic before
        // the ack), still never a patch.
        let mut device = test_device();
        device.attach("ws://localhost:1".into());
        route_text(&request, &inner, &mut resume, Some(&mut device));
        assert!(device.drain().is_empty());
        assert!(received.lock().unwrap().is_empty());
    }

    #[test]
    fn a_malformed_patch_is_skipped_not_the_whole_batch() {
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        let received = capture(&inner);
        let mut resume = Resume::default();
        let batch = json!({"type":"patch","module":"App","revision":4,"patches":[
            {"type":"create","id":"a","elementType":"Text","props":{"0":"x"}},
            {"type":"create","id":7},
            {"type":"teleport","id":"a"},
            "not even an object",
            {"type":"setProp","id":"a","name":"0","value":"y"}]});
        handle_incoming(&batch.to_string(), &inner, &mut resume, None);
        let got = received.lock().unwrap();
        assert_eq!(got.len(), 2, "{got:?}");
        assert!(matches!(got[1], Patch::SetProp { ref id, .. } if id.as_ref() == "a"));
    }

    #[test]
    fn junk_ui_messages_are_ignored_and_the_stream_continues() {
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        let received = capture(&inner);
        let mut resume = Resume {
            session_id: Some("keep".into()),
            resume_token: None,
        };
        let mut device = test_device();
        device.attach("ws://localhost:1".into());
        for junk in [
            "",
            "null",
            "[1,2,3]",
            r#"{"hello":"world"}"#,
            r#"{"type":42}"#,
            r#"{"type":"fromTheFuture"}"#,
            r#"{"type":"sessionAck","sessionId":7}"#,
            r#"{"type":"patch","patches":"nope"}"#,
            r#"{"type":"deviceEvent","id":"one"}"#,
            "\u{0}\u{1}garbage",
        ] {
            route_text(junk, &inner, &mut resume, Some(&mut device));
        }
        assert_eq!(resume.session_id.as_deref(), Some("keep"));
        route_text(
            &json!({"type":"patch","module":"App","revision":1,"patches":[
                {"type":"create","id":"ok","elementType":"Text","props":{}}]})
            .to_string(),
            &inner,
            &mut resume,
            Some(&mut device),
        );
        assert_eq!(received.lock().unwrap().len(), 1);
    }

    #[test]
    fn patch_batches_missing_their_other_members_still_render() {
        // The Kotlin server shipped `patch` without `module` and
        // `initialTree` without `state` (tester report "malformed messages
        // break … desktop rendering"): a whole-message serde decode dropped
        // both, so nothing rendered. Only `patches` matters to the renderer.
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        let received = capture(&inner);
        let mut resume = Resume::default();
        for msg in [
            json!({"type":"initialTree","module":"App","patches":[
                {"type":"create","id":"a","elementType":"Text","props":{"0":"x"}}],"revision":0}),
            json!({"type":"patch","patches":[
                {"type":"setProp","id":"a","name":"0","value":"y"}],"revision":1}),
            json!({"type":"patch","module":"App","patches":[
                {"type":"setProp","id":"a","name":"0","value":"z"}]}),
            // A type the client does not know (the Kotlin server's old
            // `render`): ignored, the stream goes on.
            json!({"type":"render","patches":[{"type":"remove","id":"a"}]}),
        ] {
            route_text(&msg.to_string(), &inner, &mut resume, None);
        }
        let got = received.lock().unwrap();
        assert_eq!(got.len(), 3, "{got:?}");
    }
}
