use hypen_engine::Patch;
use serde::{Deserialize, Serialize};

/// All messages in the remote UI protocol.
///
/// Serializes with `"type"` discriminator in camelCase, matching the
/// TypeScript/Go/Kotlin SDKs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RemoteMessage {
    /// Client → Server: initiate session handshake.
    Hello {
        /// Resume an existing session (optional).
        #[serde(skip_serializing_if = "Option::is_none", rename = "sessionId")]
        session_id: Option<String>,
        /// Client metadata (platform, version, etc.).
        #[serde(skip_serializing_if = "Option::is_none")]
        props: Option<serde_json::Value>,
        /// Device Capability Protocol advertisement (RFC 001 §2.2,
        /// `hello.device`). Absent = the client has no device host. A server
        /// negotiates from the exact JSON **text** of this member (see
        /// [`hypen_engine::device::top_level_member_text`]), never from this
        /// already-parsed value, which has collapsed duplicate keys.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        device: Option<serde_json::Value>,
        /// The latest `sessionAck.resumeToken` for `session_id` (RFC 001
        /// §5). A device-enabled server resumes only with a matching token.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "resumeToken"
        )]
        resume_token: Option<String>,
    },

    /// Server → Client: confirm session creation/resumption.
    SessionAck {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "isNew")]
        is_new: bool,
        #[serde(rename = "isRestored")]
        is_restored: bool,
        /// The server's device selection (RFC 001 §2.2, `sessionAck.device`).
        /// Absent = device access not selected (yet).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        device: Option<serde_json::Value>,
        /// Rotating resume credential of a device-enabled server (RFC 001
        /// §5): present it as `hello.resumeToken` to resume this session.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "resumeToken"
        )]
        resume_token: Option<String>,
    },

    /// Server → Client: full tree snapshot on connect.
    InitialTree {
        module: String,
        state: serde_json::Value,
        patches: Vec<Patch>,
        revision: u64,
    },

    /// Server → Client: incremental UI patches after state change.
    Patch {
        module: String,
        patches: Vec<Patch>,
        revision: u64,
    },

    /// Server → Client: full state snapshot (for tooling/Studio).
    StateUpdate {
        module: String,
        state: serde_json::Value,
        revision: u64,
    },

    /// Client → Server: dispatch an action.
    DispatchAction {
        #[serde(default)]
        module: String,
        action: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        payload: Option<serde_json::Value>,
    },

    /// Client → Server: request state subscription.
    SubscribeState { module: String },

    /// Server → Client: session expired.
    SessionExpired {
        #[serde(rename = "sessionId")]
        session_id: String,
        reason: String,
    },
}

impl RemoteMessage {
    /// Serialize to JSON string.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Deserialize from JSON string.
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }
}
