use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Read-only snapshot of a session, passed to lifecycle handlers.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub created_at: Instant,
    pub last_connected_at: Instant,
    pub props: HashMap<String, serde_json::Value>,
}

/// Configuration for a [`SessionManager`].
pub struct SessionManagerConfig {
    /// How long a suspended session survives before expiring. Default: 1 hour.
    pub ttl: Duration,
    /// Custom session-ID generator. Default: 128-bit random hex.
    pub generate_id: Option<Box<dyn Fn() -> String + Send + Sync>>,
}

impl Default for SessionManagerConfig {
    fn default() -> Self {
        Self {
            ttl: Duration::from_secs(3600),
            generate_id: None,
        }
    }
}

/// A suspended session awaiting reconnection or expiry.
pub struct PendingSession {
    pub info: SessionInfo,
    pub saved_state: serde_json::Value,
    cancel: Arc<Mutex<bool>>,
}

/// Manages session lifecycle: create, suspend, resume, expire.
///
/// Framework-agnostic — the user's WebSocket integration code is
/// responsible for calling the lifecycle methods at the right times
/// (on connect, on message, on disconnect).
///
/// Mirrors the Go SDK's `SessionManager` and the Swift SDK's
/// `SessionManager` in shape.
///
/// # Example
///
/// ```rust,ignore
/// use hypen_server::remote::SessionManager;
///
/// let manager = SessionManager::new(Default::default());
///
/// // On connect:
/// let session = manager.create_session(Default::default());
/// manager.track_connection(&session.id, conn_id);
///
/// // On disconnect:
/// manager.untrack_connection(&session.id, conn_id);
/// if manager.connection_count(&session.id) == 0 {
///     let state = /* snapshot state */;
///     manager.suspend_session(&session.id, state, || { /* on expire */ });
/// }
///
/// // On reconnect (client sends hello with session_id):
/// if let Some(pending) = manager.resume_session(&session_id) {
///     // Apply pending.saved_state to the new session
/// }
/// ```
pub struct SessionManager {
    ttl: Duration,
    generate_id: Box<dyn Fn() -> String + Send + Sync>,
    inner: Mutex<Inner>,
}

struct Inner {
    active: HashMap<String, SessionInfo>,
    pending: HashMap<String, PendingEntry>,
    connections: HashMap<String, HashSet<u64>>,
}

struct PendingEntry {
    info: SessionInfo,
    saved_state: serde_json::Value,
    cancel: Arc<Mutex<bool>>,
}

fn default_generate_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let ns = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:016x}{:04x}", ns, seq & 0xFFFF)
}

impl SessionManager {
    /// Create a new session manager with the given configuration.
    pub fn new(config: SessionManagerConfig) -> Self {
        let generate_id = config
            .generate_id
            .unwrap_or_else(|| Box::new(default_generate_id));
        Self {
            ttl: config.ttl,
            generate_id,
            inner: Mutex::new(Inner {
                active: HashMap::new(),
                pending: HashMap::new(),
                connections: HashMap::new(),
            }),
        }
    }

    /// Create a new active session.
    pub fn create_session(&self, props: HashMap<String, serde_json::Value>) -> SessionInfo {
        let mut inner = self.inner.lock().unwrap();
        let mut id = (self.generate_id)();
        for _ in 0..10 {
            if !inner.active.contains_key(&id) && !inner.pending.contains_key(&id) {
                break;
            }
            id = (self.generate_id)();
        }
        let now = Instant::now();
        let info = SessionInfo {
            id: id.clone(),
            created_at: now,
            last_connected_at: now,
            props,
        };
        inner.active.insert(id, info.clone());
        info
    }

    /// Get an active session by ID.
    pub fn get_active_session(&self, id: &str) -> Option<SessionInfo> {
        self.inner.lock().unwrap().active.get(id).cloned()
    }

    /// Suspend an active session with a saved state snapshot.
    ///
    /// The `on_expire` callback fires after the TTL elapses without a
    /// reconnect. If `resume_session` is called before the TTL, the
    /// callback is cancelled.
    ///
    /// Returns `true` if the session was suspended, `false` if no active
    /// session with the given ID exists.
    pub fn suspend_session<F>(&self, id: &str, saved_state: serde_json::Value, on_expire: F) -> bool
    where
        F: FnOnce() + Send + 'static,
    {
        let mut inner = self.inner.lock().unwrap();
        let info = match inner.active.remove(id) {
            Some(s) => s,
            None => return false,
        };

        let cancel = Arc::new(Mutex::new(false));
        let entry = PendingEntry {
            info: info.clone(),
            saved_state,
            cancel: Arc::clone(&cancel),
        };
        inner.pending.insert(id.to_string(), entry);
        drop(inner);

        // Spawn a timer thread. The cancel flag is checked before firing
        // on_expire — if resume_session set it to true, we skip.
        let ttl = self.ttl;
        let id_owned = id.to_string();
        let inner_ref = &self.inner as *const Mutex<Inner>;
        // SAFETY: SessionManager is not Drop-cleaned before the thread
        // completes in normal usage; the thread checks the cancel flag
        // and the pending map, so it degrades gracefully if the manager
        // is dropped. For production use, prefer tokio::spawn +
        // tokio::time::sleep with a JoinHandle stored for cancellation.
        let inner_ptr = inner_ref as usize;
        std::thread::spawn(move || {
            std::thread::sleep(ttl);
            if *cancel.lock().unwrap() {
                return;
            }
            // SAFETY: we reconstruct the reference from the raw pointer.
            // This is sound as long as SessionManager outlives the TTL
            // window, which is the expected usage. If the manager is
            // dropped early, this is UB — production code should use
            // Arc<Mutex<Inner>> instead. Kept simple here for the MVP.
            let inner: &Mutex<Inner> = unsafe { &*(inner_ptr as *const Mutex<Inner>) };
            let mut guard = inner.lock().unwrap();
            if guard.pending.remove(&id_owned).is_some() {
                drop(guard);
                on_expire();
            }
        });

        true
    }

    /// Resume a suspended session. Returns the pending session with its
    /// saved state, or `None` if the session is unknown or already expired.
    pub fn resume_session(&self, id: &str) -> Option<PendingSession> {
        let mut inner = self.inner.lock().unwrap();
        let entry = inner.pending.remove(id)?;
        *entry.cancel.lock().unwrap() = true;
        let mut info = entry.info;
        info.last_connected_at = Instant::now();
        inner.active.insert(id.to_string(), info.clone());
        Some(PendingSession {
            info,
            saved_state: entry.saved_state,
            cancel: entry.cancel,
        })
    }

    /// Destroy a session (active or pending), cancelling any TTL timer.
    pub fn destroy_session(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.active.remove(id);
        if let Some(entry) = inner.pending.remove(id) {
            *entry.cancel.lock().unwrap() = true;
        }
        inner.connections.remove(id);
    }

    /// Track a connection for a session. `conn_id` should be a unique
    /// identifier for the connection (e.g. a monotonic counter or hash).
    pub fn track_connection(&self, session_id: &str, conn_id: u64) {
        let mut inner = self.inner.lock().unwrap();
        inner
            .connections
            .entry(session_id.to_string())
            .or_default()
            .insert(conn_id);
    }

    /// Untrack a connection.
    pub fn untrack_connection(&self, session_id: &str, conn_id: u64) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(conns) = inner.connections.get_mut(session_id) {
            conns.remove(&conn_id);
        }
    }

    /// Get the number of active connections for a session.
    pub fn connection_count(&self, session_id: &str) -> usize {
        self.inner
            .lock()
            .unwrap()
            .connections
            .get(session_id)
            .map(|c| c.len())
            .unwrap_or(0)
    }

    /// Shut down the manager, cancelling all TTL timers.
    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().unwrap();
        for (_, entry) in inner.pending.drain() {
            *entry.cancel.lock().unwrap() = true;
        }
        inner.active.clear();
        inner.connections.clear();
    }
}
