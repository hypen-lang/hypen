use hypen_engine::Patch;
use serde::{Deserialize, Serialize};

use crate::theme::SystemScheme;

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

    /// Client → Server: a windowed list's visible range plus overscan
    /// (list virtualization, `hypen-web/docs/virtualization.md` §4).
    ///
    /// `list_id` is the patch-wire id of the element carrying
    /// `__virt.window`; `[start, end)` is the item range the client wants
    /// materialized. Decoding accepts any non-negative integer for
    /// `start`/`end` and clamps it to `u32`; anything else (negative,
    /// fractional, missing, not a number) makes the message malformed, and
    /// a server ignores it.
    Viewport {
        #[serde(rename = "listId")]
        list_id: String,
        #[serde(deserialize_with = "clamped_u32")]
        start: u32,
        #[serde(deserialize_with = "clamped_u32")]
        end: u32,
    },

    /// Server → Client: session expired.
    SessionExpired {
        #[serde(rename = "sessionId")]
        session_id: String,
        reason: String,
    },
}

/// Decode a non-negative JSON integer, clamped to `u32::MAX`. Integral
/// floats (`40.0`, `1e20`) count as integers; negatives, fractions and
/// non-numbers are errors.
fn clamped_u32<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    use serde::de::Error;
    let n = serde_json::Number::deserialize(d)?;
    if let Some(u) = n.as_u64() {
        return Ok(u.min(u32::MAX as u64) as u32);
    }
    match n.as_f64() {
        Some(f) if f.is_finite() && f >= 0.0 && f.fract() == 0.0 => {
            Ok(f.min(u32::MAX as f64) as u32)
        }
        _ => Err(D::Error::custom("expected a non-negative integer")),
    }
}

/// Client → Server: the client's system color scheme changed (the user
/// flipped the OS between light and dark):
/// `{"type":"colorScheme","scheme":"light"|"dark"}`. The initial value
/// travels in the hello, as the optional member `"colorScheme"`
/// ([`HELLO_COLOR_SCHEME`]).
///
/// Per client: a [`RemoteSession`](super::RemoteSession) feeds it to its
/// theme ([`Theme::set_system_scheme`](crate::theme::Theme::set_system_scheme)),
/// which re-renders only while the session's preference is `"system"`.
/// Ignored when the session has no theme, before `hello`, or when `scheme`
/// is not `"light"` / `"dark"`. Servers that predate it ignore the unknown
/// message type.
///
/// This is its own type rather than a [`RemoteMessage`] variant (and
/// `hello.colorScheme` is not a field of [`RemoteMessage::Hello`]) so that
/// code matching or building `RemoteMessage` exhaustively keeps compiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColorSchemeMessage {
    pub scheme: SystemScheme,
}

/// The optional `hello` member carrying the client's system color scheme
/// (`"light"` / `"dark"`). It seeds the session theme's system scheme
/// before the first render, so a `"system"` preference paints the right
/// scheme from the first frame.
pub const HELLO_COLOR_SCHEME: &str = "colorScheme";

/// A client-reported system color scheme, or `None` for anything else.
fn parse_color_scheme(value: Option<&serde_json::Value>) -> Option<SystemScheme> {
    match value?.as_str()? {
        "light" => Some(SystemScheme::Light),
        "dark" => Some(SystemScheme::Dark),
        _ => None,
    }
}

impl ColorSchemeMessage {
    pub fn new(scheme: SystemScheme) -> Self {
        Self { scheme }
    }

    /// The wire text, for a client to send.
    pub fn to_json(&self) -> String {
        serde_json::json!({ "type": "colorScheme", "scheme": self.scheme.as_str() }).to_string()
    }

    /// Decode a `colorScheme` message. `None` for any other message and for
    /// a malformed one (a `scheme` that is not `"light"` / `"dark"`).
    pub fn from_json(json: &str) -> Option<Self> {
        let value: serde_json::Value = serde_json::from_str(json).ok()?;
        if value.get("type")?.as_str()? != "colorScheme" {
            return None;
        }
        parse_color_scheme(value.get("scheme")).map(Self::new)
    }

    /// The `colorScheme` member of a `hello` message's text, when it is
    /// `"light"` or `"dark"`; `None` when absent or anything else.
    pub fn from_hello(json: &str) -> Option<SystemScheme> {
        let value: serde_json::Value = serde_json::from_str(json).ok()?;
        parse_color_scheme(value.get(HELLO_COLOR_SCHEME))
    }
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
