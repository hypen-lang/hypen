//! Attach mode: bind an agent to a **live** user session.
//!
//! The external capability surface on [`RemoteSession`] —
//! [`list_actions`](RemoteSession::list_actions),
//! [`dispatch_external`](RemoteSession::dispatch_external),
//! [`get_state_at`](RemoteSession::get_state_at) — is only useful to an
//! agent if the agent can reach the session the human is looking at, and if
//! the effects of its dispatch reach that human's screen. This module is
//! the plumbing for exactly that:
//!
//! - The host keeps its `RemoteSession` in an `Arc` and, once the hello
//!   handshake has completed, [`register`](SessionRegistry::register)s it
//!   together with an [`OutboundSink`] — a closure that forwards one wire
//!   message to the client's transport (typically an `mpsc` sender feeding
//!   the WebSocket writer).
//! - Whoever the developer authorises calls
//!   [`attach`](SessionRegistry::attach) with the session id and gets an
//!   [`AgentHandle`]. Authorisation is the developer's: this crate has no
//!   HTTP surface, so the caller of `attach` is by construction the code
//!   that decided the request was allowed.
//! - [`AgentHandle::dispatch`] runs the engine's *guarded* dispatch on the
//!   user's engine and pushes every resulting wire message through the sink.
//!   A guard refusal returns `Err` before anything is queued: no traffic on
//!   the user's transport, no revision bump. A permitted dispatch emits on
//!   the transport exactly what a click on that session would — same
//!   message types, same revision bookkeeping — because both paths share
//!   `RemoteSession::run_action`.
//!
//! A handle **never owns the session**. The registry and every handle hold
//! only a [`Weak`] reference; once the host drops its `Arc` (the WebSocket
//! closed, the session was suspended or expired) every call on the handle
//! returns [`SdkError::SessionGone`], and the registry prunes the entry on
//! its next lookup. A handle cannot destroy, suspend or close a session —
//! there is simply no method for it.
//!
//! # Who may hold an id
//!
//! The registry key is the id the session acked to its client, and
//! [`RemoteSession::handle_hello`] acks whatever id the client presented —
//! that is how resume works. So the key is client-chosen, and the registry
//! has to make sure a peer presenting someone else's id cannot take over
//! that someone's record: [`register`](SessionRegistry::register) refuses
//! (with [`SdkError::SessionIdTaken`]) to replace a record whose session is
//! still alive and is not the one being registered, and
//! [`unregister`](SessionRegistry::unregister) removes only the caller's
//! own record. A genuine reconnect — the previous session object is gone,
//! or it is the same object registering a new sink — still succeeds.
//!
//! # Locking and ordering
//!
//! `dispatch` takes the session's own `inner` mutex — the same one
//! [`RemoteSession::handle_message`] takes — so an agent's dispatch and a
//! click serialise with no extra lock. The sink is invoked **while that
//! lock is held**, in the same call that assigned the revision, so
//! whatever order messages reach the host's outbound queue is the order
//! their revisions were assigned in. That is what keeps an agent's
//! revision N from being queued after the socket task's revision N+1 (the
//! client would drop N as out of order). It also means a sink must be cheap,
//! must not block, and must never call back into the session. The
//! registry's map lock is released before any session lock is taken, and
//! vice versa, so the two never nest.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, Weak};

use serde_json::Value;

use crate::error::{Result, SdkError};

use super::session::RemoteSession;

/// Forwards one outbound wire message (a JSON string) to a client transport.
///
/// The host builds one per connection; the usual shape is a closure over an
/// unbounded `mpsc` sender whose receiving end is the single writer on the
/// socket, so agent-originated messages and reply messages never interleave
/// mid-frame.
///
/// The sink is called with the session's lock held (see the module docs on
/// ordering): it must return promptly, must not block on the transport, and
/// must not call any method on the session it belongs to.
pub type OutboundSink = Arc<dyn Fn(String) + Send + Sync>;

/// What the registry remembers per session: how to find it, and how to
/// reach its client.
struct Entry {
    session: Weak<RemoteSession>,
    sink: OutboundSink,
}

impl Entry {
    fn is(&self, session: &Weak<RemoteSession>) -> bool {
        Weak::ptr_eq(&self.session, session)
    }
}

/// Live sessions an agent may attach to, keyed by acked session id.
///
/// Holds `Weak<RemoteSession>` only — registering a session does not extend
/// its lifetime, and a session whose host `Arc` has been dropped is pruned
/// on the next [`attach`](Self::attach).
///
/// Share one per server (`Arc<SessionRegistry>`) across connection tasks.
#[derive(Default)]
pub struct SessionRegistry {
    inner: Mutex<HashMap<String, Entry>>,
}

impl SessionRegistry {
    /// An empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a hello-completed session under its acked id.
    ///
    /// Returns `Ok(Some(id))` with the id it was registered under, or
    /// `Ok(None)` if the session has not completed its hello handshake yet
    /// — there is no acked id to key on and no declaration surface to attach
    /// to. Call again after the next inbound message; it is cheap and
    /// idempotent, and if the session's acked id has changed in the
    /// meantime the record moves to the new key.
    ///
    /// Registering the *same* session again (a new sink for a reconnect on
    /// the same session object) replaces the previous sink. A record whose
    /// session has since been dropped is replaced too.
    ///
    /// # Errors
    ///
    /// [`SdkError::SessionIdTaken`] when a **different, still-live** session
    /// already holds the id. Nothing changes: the existing record stays
    /// attachable and the caller's session is not registered. This is the
    /// case for a peer presenting an id that is not theirs, and also for a
    /// browser reconnecting before the server has noticed the old socket is
    /// dead — in the latter case retrying on a later message succeeds once
    /// the old connection's task has gone.
    pub fn register(&self, session: &Arc<RemoteSession>, sink: OutboundSink) -> Result<Option<String>> {
        // Session lock is taken and released here, before the registry lock.
        let Some(id) = session.acked_session_id() else {
            return Ok(None);
        };
        if !session.hello_completed() {
            return Ok(None);
        }
        let weak = Arc::downgrade(session);

        let mut map = self.inner.lock().unwrap();
        if let Some(existing) = map.get(&id) {
            if !existing.is(&weak) && existing.session.strong_count() > 0 {
                return Err(SdkError::SessionIdTaken(id));
            }
        }
        // One record per session: if it was registered under an earlier
        // acked id, that key goes away.
        map.retain(|key, entry| key == &id || !entry.is(&weak));
        map.insert(
            id.clone(),
            Entry {
                session: weak,
                sink,
            },
        );
        Ok(Some(id))
    }

    /// Forget a session. Returns whether a record for it was present.
    ///
    /// Removes only records that point at *this* session, whatever key they
    /// are under — a record another live session holds under the same id
    /// is untouched, so one connection's teardown can never make a peer
    /// unattachable. The session itself is untouched either way. The host
    /// calls this when the connection ends, though a missed call is
    /// harmless — a dead `Weak` is pruned on the next lookup.
    pub fn unregister(&self, session: &Arc<RemoteSession>) -> bool {
        let weak = Arc::downgrade(session);
        let mut map = self.inner.lock().unwrap();
        let before = map.len();
        map.retain(|_, entry| !entry.is(&weak));
        map.len() != before
    }

    /// Bind a handle to the live session with this id.
    ///
    /// `None` when no registered session has the id, when the session has
    /// since been dropped by its host, when it has not completed its hello
    /// handshake, or when it has since been acked under a different id and
    /// not re-registered. Dead entries are pruned as a side effect.
    pub fn attach(&self, session_id: &str) -> Option<AgentHandle> {
        // Snapshot under the registry lock, then release it before touching
        // the session's own lock in `hello_completed`.
        let (weak, sink) = {
            let mut map = self.inner.lock().unwrap();
            map.retain(|_, entry| entry.session.strong_count() > 0);
            let entry = map.get(session_id)?;
            (Weak::clone(&entry.session), Arc::clone(&entry.sink))
        };
        let session = weak.upgrade()?;
        if !session.hello_completed() {
            return None;
        }
        if session.acked_session_id().as_deref() != Some(session_id) {
            return None;
        }
        Some(AgentHandle {
            session_id: session_id.to_string(),
            session: weak,
            sink,
        })
    }

    /// Number of registered sessions still alive. Prunes dead entries.
    pub fn len(&self) -> usize {
        let mut map = self.inner.lock().unwrap();
        map.retain(|_, entry| entry.session.strong_count() > 0);
        map.len()
    }

    /// Whether no live session is registered.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl fmt::Debug for SessionRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let ids: Vec<String> = self.inner.lock().unwrap().keys().cloned().collect();
        f.debug_struct("SessionRegistry")
            .field("sessions", &ids)
            .finish()
    }
}

/// An agent's handle on one live, hello-completed user session.
///
/// Obtained from [`SessionRegistry::attach`]. Every method upgrades the
/// handle's `Weak` reference first and returns [`SdkError::SessionGone`]
/// if the host has dropped the session — that is the liveness signal; there
/// is no separate flag to poll and race against.
///
/// Cloning a handle is cheap and yields another handle on the same session.
#[derive(Clone)]
pub struct AgentHandle {
    session_id: String,
    session: Weak<RemoteSession>,
    sink: OutboundSink,
}

impl AgentHandle {
    /// The acked id of the session this handle is bound to.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    fn session(&self) -> Result<Arc<RemoteSession>> {
        self.session
            .upgrade()
            .ok_or_else(|| SdkError::SessionGone(self.session_id.clone()))
    }

    /// Every action an external caller may dispatch on this session right
    /// now. See [`RemoteSession::list_actions`].
    pub fn list_actions(&self) -> Result<Vec<hypen_engine::AgentAction>> {
        Ok(self.session()?.list_actions())
    }

    /// Dispatch an action through the engine's guard on the user's session
    /// and forward the resulting wire messages to the user's transport.
    ///
    /// Returns the messages that were forwarded — the same `patch` /
    /// `stateUpdate` strings a `dispatchAction` from the renderer would
    /// have produced — so a caller can also relay them elsewhere.
    ///
    /// # Errors
    ///
    /// - [`SdkError::SessionGone`] if the host dropped the session. Nothing
    ///   is emitted.
    /// - [`SdkError::Engine`] when the guard refuses the name or payload.
    ///   Nothing is emitted on the transport and the revision is unchanged
    ///   — the session is exactly as the caller found it.
    pub fn dispatch(&self, action: &str, payload: Option<&Value>) -> Result<Vec<String>> {
        let session = self.session()?;
        // Guarded entry point. A refusal returns here, before the sink sees
        // anything. A permitted dispatch hands each message to the sink
        // while the session lock is still held — the same lock that just
        // assigned the revision — so the user's outbound queue receives it
        // in revision order relative to the socket task's own replies.
        session.dispatch_external_with(action, payload, |message| {
            (self.sink)(message.to_string());
        })
    }

    /// Read module state, whole or at a dotted path, gated to the declared
    /// read surface. See [`RemoteSession::get_state_at`].
    pub fn get_state(&self, module: Option<&str>, path: Option<&str>) -> Result<Option<Value>> {
        Ok(self.session()?.get_state_at(module, path))
    }

    /// The session's current revision.
    pub fn revision(&self) -> Result<u64> {
        Ok(self.session()?.revision())
    }

    /// The MCP manifest for the session's app. See
    /// [`RemoteSession::mcp_manifest`].
    pub fn manifest(&self) -> Result<hypen_engine::agent::McpManifest> {
        Ok(self.session()?.mcp_manifest())
    }
}

impl fmt::Debug for AgentHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AgentHandle")
            .field("session_id", &self.session_id)
            .field("alive", &(self.session.strong_count() > 0))
            .finish()
    }
}
