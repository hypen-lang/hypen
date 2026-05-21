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
use tokio::sync::mpsc;

type PatchCallback = Arc<dyn Fn(&[Patch]) + Send + Sync>;

#[derive(Default)]
pub(crate) struct Inner {
    /// Callback set by `on_patches`. The window's `PatchQueue` lives
    /// behind this.
    callback: Option<PatchCallback>,
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

async fn run_worker(
    url: String,
    module_name: String,
    mut outbound: mpsc::UnboundedReceiver<RemoteMessage>,
    inner: Arc<Mutex<Inner>>,
) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{
        connect_async,
        tungstenite::protocol::Message as WsMsg,
    };

    log::info!("remote: connecting to {url}");
    let (ws_stream, _resp) = match connect_async(&url).await {
        Ok(s) => s,
        Err(e) => {
            log::error!("remote: WebSocket connect failed: {e}");
            return;
        }
    };
    let (mut sink, mut stream) = ws_stream.split();
    log::info!("remote: connected (module={module_name})");

    // Hello — fresh session for now; resume comes later.
    let hello = RemoteMessage::Hello {
        session_id: None,
        props: None,
    };
    if let Ok(s) = hello.to_json() {
        if let Err(e) = sink.send(WsMsg::Text(s)).await {
            log::error!("remote: failed sending Hello: {e}");
            return;
        }
    }

    loop {
        tokio::select! {
            biased;

            incoming = stream.next() => match incoming {
                Some(Ok(WsMsg::Text(text))) => {
                    handle_incoming(text.as_ref(), &inner);
                }
                Some(Ok(WsMsg::Binary(_))) => {
                    // Hypen's wire format is JSON text; ignore binary frames.
                }
                Some(Ok(WsMsg::Close(_))) | None => {
                    log::info!("remote: server closed connection");
                    break;
                }
                Some(Ok(_)) => {} // Ping/Pong/Frame — handled by tungstenite.
                Some(Err(e)) => {
                    log::warn!("remote: stream error: {e}");
                    break;
                }
            },

            outgoing = outbound.recv() => match outgoing {
                Some(msg) => {
                    if let Ok(s) = msg.to_json() {
                        if let Err(e) = sink.send(WsMsg::Text(s)).await {
                            log::warn!("remote: failed sending action: {e}");
                            break;
                        }
                    }
                }
                None => {
                    // Sender dropped — clean shutdown.
                    log::info!("remote: outbound channel closed; shutting down");
                    break;
                }
            }
        }
    }
}

fn handle_incoming(text: &str, inner: &Arc<Mutex<Inner>>) {
    let msg: RemoteMessage = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(e) => {
            log::warn!("remote: ignoring malformed message: {e}");
            return;
        }
    };
    match msg {
        RemoteMessage::SessionAck { session_id, is_new, .. } => {
            log::info!("remote: session ack id={session_id} new={is_new}");
        }
        RemoteMessage::InitialTree { patches, .. }
        | RemoteMessage::Patch { patches, .. } => {
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
        }
        // These are client→server messages; if the server sends one
        // back to us, ignore.
        RemoteMessage::Hello { .. }
        | RemoteMessage::DispatchAction { .. }
        | RemoteMessage::SubscribeState { .. } => {}
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
        module.dispatch_action(
            "set_value",
            Some(json!({"value": 42})),
        );

        // Pop both messages and assert their shape.
        let m1 = rx.try_recv().expect("first action queued");
        match m1 {
            RemoteMessage::DispatchAction { module, action, payload } => {
                assert_eq!(module, "Counter");
                assert_eq!(action, "increment");
                assert!(payload.is_none());
            }
            other => panic!("expected DispatchAction, got {other:?}"),
        }
        let m2 = rx.try_recv().expect("second action queued");
        match m2 {
            RemoteMessage::DispatchAction { module, action, payload } => {
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

        // Construct a wire-format InitialTree the way the TS server
        // would emit it: type discriminator + camelCase fields.
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

        handle_incoming(&initial_tree, &inner);
        let got = received.lock().unwrap();
        assert_eq!(got.len(), 1);
        assert!(matches!(got[0], Patch::Create { ref id, .. } if id == "1"));
    }

    #[test]
    fn handle_incoming_ignores_malformed_messages_without_panicking() {
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        handle_incoming("{not json}", &inner);
        handle_incoming(r#"{"type":"unknownVariant"}"#, &inner);
        // No callback set, no pending patches: nothing happened.
        assert!(inner.lock().unwrap().pending.is_empty());
    }

    #[test]
    fn handle_incoming_ignores_session_ack() {
        let inner: Arc<Mutex<Inner>> = Arc::new(Mutex::new(Inner::default()));
        let session_ack = json!({
            "type": "sessionAck",
            "sessionId": "abc",
            "isNew": true,
            "isRestored": false,
        })
        .to_string();
        handle_incoming(&session_ack, &inner);
        assert!(inner.lock().unwrap().pending.is_empty());
    }
}
