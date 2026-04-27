use crate::reconcile::Patch;
use serde::{Deserialize, Serialize};

/// Wire protocol messages for Remote UI (server-driven rendering).
///
/// Remote UI allows the Hypen engine to run on a server while a thin client
/// (browser, mobile app, embedded device) renders the UI. Communication is
/// bidirectional over WebSocket, SSE, or any ordered transport.
///
/// # Message Flow
///
/// ```text
/// Server                           Client
///   │                                │
///   │──── InitialTree ──────────────>│  (full tree + state on connect)
///   │                                │
///   │──── Patch ─────────────────────>│  (incremental updates)
///   │                                │
///   │<─── DispatchAction ────────────│  (user interaction)
///   │                                │
///   │──── StateUpdate ──────────────>│  (state sync after action)
///   │──── Patch ─────────────────────>│  (resulting UI changes)
/// ```
///
/// # Revision Tracking
///
/// Each `InitialTree` and `PatchStream` carries a monotonically increasing
/// `revision` number. Clients should:
/// - Apply patches in revision order
/// - Detect gaps (missed patches) and request a full `InitialTree`
/// - Ignore patches with a revision ≤ the last applied revision
///
/// # Integrity Hashing
///
/// The optional `hash` field on `InitialTree` and `PatchStream` enables
/// end-to-end integrity verification. When present, clients can hash their
/// tree state and compare to detect corruption or missed patches.
///
/// # Serialization
///
/// Messages serialize with a `"type"` discriminator in camelCase:
///
/// ```json
/// {"type": "initialTree", "module": "App", "state": {...}, "patches": [...], "revision": 0}
/// {"type": "patch", "module": "App", "patches": [...], "revision": 1}
/// {"type": "dispatchAction", "module": "App", "action": "click", "payload": null}
/// {"type": "stateUpdate", "module": "App", "state": {...}}
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RemoteMessage {
    /// Full tree snapshot sent when a client first connects.
    ///
    /// Contains the complete state and the full patch sequence needed to
    /// construct the tree from scratch.
    InitialTree(InitialTree),

    /// Incremental patch stream for state-driven updates.
    Patch(PatchStream),

    /// Action dispatched from the client (user interaction).
    ///
    /// The server should route this to the module's action handler and
    /// respond with a `StateUpdate` + `Patch` if state changed.
    DispatchAction {
        /// Target module name
        module: String,
        /// Action name (e.g. `"increment"`, `"submit"`)
        action: String,
        /// Optional action payload
        payload: Option<serde_json::Value>,
    },

    /// State update pushed from the server to the client.
    ///
    /// Sent after an action handler modifies state, so the client can
    /// keep its local state cache in sync.
    StateUpdate {
        module: String,
        state: serde_json::Value,
    },
}

/// Full tree snapshot sent to newly-connected clients.
///
/// Contains everything a client needs to render the initial UI: the module
/// state, the complete patch sequence, and a revision baseline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitialTree {
    /// Module name
    pub module: String,

    /// Initial state snapshot
    pub state: serde_json::Value,

    /// Initial patches to construct the tree
    pub patches: Vec<Patch>,

    /// Revision number (starts at 0)
    pub revision: u64,

    /// Optional integrity hash
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

impl InitialTree {
    pub fn new(module: String, state: serde_json::Value, patches: Vec<Patch>) -> Self {
        Self {
            module,
            state,
            patches,
            revision: 0,
            hash: None,
        }
    }

    pub fn with_hash(mut self, hash: String) -> Self {
        self.hash = Some(hash);
        self
    }
}

/// Incremental patch stream for state-driven UI updates.
///
/// Sent from server to client after each state change. The `revision`
/// field enables ordering and gap detection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchStream {
    /// Module name
    pub module: String,

    /// Patches to apply
    pub patches: Vec<Patch>,

    /// Revision number (monotonically increasing)
    pub revision: u64,

    /// Optional integrity hash
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

impl PatchStream {
    pub fn new(module: String, patches: Vec<Patch>, revision: u64) -> Self {
        Self {
            module,
            patches,
            revision,
            hash: None,
        }
    }

    pub fn with_hash(mut self, hash: String) -> Self {
        self.hash = Some(hash);
        self
    }
}

/// Helper to serialize messages to JSON
pub fn serialize_message(message: &RemoteMessage) -> Result<String, serde_json::Error> {
    serde_json::to_string(message)
}

/// Helper to deserialize messages from JSON
pub fn deserialize_message(json: &str) -> Result<RemoteMessage, serde_json::Error> {
    serde_json::from_str(json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_serialize_initial_tree() {
        let initial = InitialTree::new(
            "TestModule".to_string(),
            serde_json::json!({"count": 0}),
            vec![],
        );

        let message = RemoteMessage::InitialTree(initial);
        let json = serialize_message(&message).unwrap();

        assert!(json.contains("initialTree"));
        assert!(json.contains("TestModule"));
    }

    #[test]
    fn test_roundtrip() {
        let message = RemoteMessage::DispatchAction {
            module: "Test".to_string(),
            action: "increment".to_string(),
            payload: Some(serde_json::json!({"amount": 1})),
        };

        let json = serialize_message(&message).unwrap();
        let deserialized = deserialize_message(&json).unwrap();

        match deserialized {
            RemoteMessage::DispatchAction { module, action, .. } => {
                assert_eq!(module, "Test");
                assert_eq!(action, "increment");
            }
            _ => panic!("Wrong message type"),
        }
    }
}
