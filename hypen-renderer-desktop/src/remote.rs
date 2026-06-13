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
//! Phase 11 v1 ships the happy path: connect, hello, stream patches,
//! dispatch actions. Reconnect-with-backoff and session resume land in
//! a follow-up.

use crate::module::HypenModule;
use hypen_engine::Patch;
use hypen_server::remote::RemoteMessage;
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

async fn run_worker(
    url: String,
    module_name: String,
    mut outbound: mpsc::UnboundedReceiver<RemoteMessage>,
    inner: Arc<Mutex<Inner>>,
) {
    let mut session_id: Option<String> = None;
    let mut attempt: u32 = 0;
    // First connect attempt — surface the Connecting state before
    // the TCP handshake even starts so the UI has time to render
    // a spinner.
    deliver_status(&inner, ConnectionStatus::Connecting);
    loop {
        let result = run_session(&url, &module_name, &mut session_id, &mut outbound, &inner).await;
        match result {
            Ok(SessionEnd::Shutdown) => {
                log::info!("remote: shutdown requested; exiting worker");
                deliver_status(&inner, ConnectionStatus::Closed);
                break;
            }
            Ok(SessionEnd::Disconnected) | Err(_) => {
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
}

/// Run a single connect → handshake → pump cycle. Captures
/// `session_id` from `SessionAck` so reconnects can resume. Returns
/// `Shutdown` only when the outbound channel hangs up.
async fn run_session(
    url: &str,
    module_name: &str,
    session_id: &mut Option<String>,
    outbound: &mut mpsc::UnboundedReceiver<RemoteMessage>,
    inner: &Arc<Mutex<Inner>>,
) -> Result<SessionEnd, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMsg};

    log::info!(
        "remote: connecting to {url} (resume session={:?})",
        session_id.as_deref(),
    );
    let (ws_stream, _resp) = connect_async(url)
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    let (mut sink, mut stream) = ws_stream.split();
    log::info!("remote: connected (module={module_name})");

    // Hello — replay our session_id if we have one so the server can
    // resume; otherwise it'll mint a new one.
    let hello = build_hello(session_id.clone());
    let hello_text = hello.to_json().map_err(|e| format!("encode Hello: {e}"))?;
    sink.send(WsMsg::Text(hello_text))
        .await
        .map_err(|e| format!("send Hello: {e}"))?;

    loop {
        tokio::select! {
            biased;

            incoming = stream.next() => match incoming {
                Some(Ok(WsMsg::Text(text))) => {
                    handle_incoming(text.as_ref(), inner, session_id);
                }
                Some(Ok(WsMsg::Binary(_))) => {
                    // Hypen's wire format is JSON text; ignore binary.
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
            }
        }
    }
}

/// Build the Hello payload. Pulled out as a free function so tests
/// can assert the shape without spinning up a worker.
pub(crate) fn build_hello(session_id: Option<String>) -> RemoteMessage {
    RemoteMessage::Hello {
        session_id,
        props: None,
    }
}

fn handle_incoming(text: &str, inner: &Arc<Mutex<Inner>>, session_id: &mut Option<String>) {
    let msg: RemoteMessage = match serde_json::from_str(text) {
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
        } => {
            log::info!("remote: session ack id={id} new={is_new} restored={is_restored}",);
            *session_id = Some(id);
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
            *session_id = None;
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
        assert!(matches!(got[0], Patch::Create { ref id, .. } if id == "root_a"));
        assert!(matches!(got[1], Patch::Create { ref id, .. } if id == "a_text"));
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
        let mut session_id: Option<String> = None;

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

        handle_incoming(&initial_tree, &inner, &mut session_id);
        let got = received.lock().unwrap();
        assert_eq!(got.len(), 1);
        assert!(matches!(got[0], Patch::Create { ref id, .. } if id == "1"));
    }

    #[test]
    fn handle_incoming_ignores_malformed_messages_without_panicking() {
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        let mut session_id: Option<String> = None;
        handle_incoming("{not json}", &inner, &mut session_id);
        handle_incoming(r#"{"type":"unknownVariant"}"#, &inner, &mut session_id);
        assert!(inner.lock().unwrap().pending.is_empty());
        assert!(session_id.is_none());
    }

    #[test]
    fn handle_incoming_session_ack_captures_session_id_for_resume() {
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        let mut session_id: Option<String> = None;
        let session_ack = json!({
            "type": "sessionAck",
            "sessionId": "session-abc-123",
            "isNew": true,
            "isRestored": false,
        })
        .to_string();
        handle_incoming(&session_ack, &inner, &mut session_id);
        assert_eq!(session_id.as_deref(), Some("session-abc-123"));
        assert!(inner.lock().unwrap().pending.is_empty());
    }

    #[test]
    fn handle_incoming_session_expired_drops_resume_id() {
        // After SessionAck we hold an id; SessionExpired must clear
        // it so the next reconnect mints a fresh session instead of
        // failing the resume handshake repeatedly.
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        let mut session_id: Option<String> = Some("expired-id".into());
        let expired = json!({
            "type": "sessionExpired",
            "sessionId": "expired-id",
            "reason": "idle timeout"
        })
        .to_string();
        handle_incoming(&expired, &inner, &mut session_id);
        assert!(session_id.is_none());
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
        let hello = build_hello(Some("resume-me".into()));
        let json = serde_json::to_value(&hello).expect("encode");
        assert_eq!(json["type"], "hello");
        assert_eq!(json["sessionId"], "resume-me");
    }

    #[test]
    fn build_hello_omits_session_id_for_fresh_connect() {
        let hello = build_hello(None);
        let json = serde_json::to_value(&hello).expect("encode");
        assert_eq!(json["type"], "hello");
        assert!(
            json.get("sessionId").is_none(),
            "fresh Hello must not carry a sessionId field, got {json:?}",
        );
    }
}
